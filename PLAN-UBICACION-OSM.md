# PLAN — UBICACIÓN INTELIGENTE con OpenStreetMap (para Opus 4.8)

**Autor:** Opus 4.8 · **Fecha:** 2026-07-14 · **Para:** Diego (Raíces CRM)

Objetivo de Diego: *"que la IA pueda entender dónde está una propiedad, dar referencias
(cerca de la playa, del centro, hay un súper/café), y buscar propiedades cerca cuando el
lead pasa una dirección. Si no sabe de dónde sacar información, no puede seguir una charla
coherente."*

**Regla dura de Diego:** cero gasto recurrente en APIs pagas. Todo con **OpenStreetMap
(gratis, sin límite de plata, y sin la restricción legal de Google Places de mostrar sobre
un mapa).** Ver [[avisar-gasto-ia-rojo]], [[ia-identificar-propiedad-por-zona]].

---

## ESTADO — FASE 1 (dirección estructurada) ✅ YA CONSTRUIDA (2026-07-14)

Se agregó el **campo de dirección estructurado** a los 3 mundos. Convención única:
`direccion` (calle+número) · `entre_calles` · `ciudad` · `lat` · `lng`.

| Rubro | DB | Form | Scraper | Auto-update | Prompt IA |
|---|---|---|---|---|---|
| Inmobiliaria | columnas nuevas en `properties` (migración) | ✅ inputs en inventario | ✅ Tokko + JSON-LD + Houzez + IA | ✅ 3 filas | ✅ `direccion:` en el ítem |
| Hotel | `hotel_complejos.atributos` (jsonb, sin migración) | ✅ 3 inputs en Editar complejo | ya captura `direccion` | — | ✅ `_headerComp` compone dir |
| Desarrolladora | columnas nuevas en `developments` (migración) | ✅ inputs en `_FormDesarrollo` | ✅ des-enterrado de `dev_data` | — | ✅ `direccion:` en `_cab` |

- Migración: `migracion-direccion-3-mundos.sql` (properties + developments; NULLABLE + `notify pgrst`).
- Helper compartido en `server.js` (`_fmtDireccion({direccion,entre_calles,ciudad})`).
- SELECTs **defensivos** (si la migración no corrió, no rompe).
- Los `lat`/`lng` quedan creados y vacíos → los llena la Fase 2.

**Pendiente Fase 1 (menor):** las altas de complejo hotel (`complejo/crear`, `_FormHotel`,
carga manual) nacen sin dirección → el dueño la carga entrando a "Editar complejo". Se puede
sumar el input al alta en un segundo pase (no bloquea).

---

## FASE 2 — GEOCODIFICACIÓN (dirección → lat/lng) con Nominatim (OSM)

**Qué:** convertir la dirección de cada propiedad/emprendimiento/complejo en coordenadas
(`lat`,`lng`) **una sola vez** al guardarla. Con eso después se calcula cercanía.

**Servicio:** Nominatim (OpenStreetMap). `GET https://nominatim.openstreetmap.org/search?q=<dir>&format=jsonv2&limit=1&countrycodes=ar`
- **Gratis, sin costo.** Sólo reglas de uso: **máx 1 request/segundo**, User-Agent identificable
  (`Raices-CRM/1.0 (contacto)`), nada de bulk masivo. Para volumen alto → **self-host** en un
  VPS chico (misma API). Ver nota de escalado abajo.
- Query recomendada: `"<direccion>, <ciudad>, Argentina"`. Si falla, reintentar con
  `"<ciudad>, Argentina"` (al menos ubica la zona).

**Cuándo geocodificar (cero gasto, cero fricción):**
1. **Al guardar/scrapear** una propiedad con dirección nueva o cambiada → encolar geocodificación.
2. **Cron de relleno** (`geocodificarPendientes`, cada X min): agarra filas con `direccion IS NOT NULL AND lat IS NULL`, geocodifica de a 1 (respeta 1/seg), escribe `lat`/`lng`. Idempotente.
3. **Cache permanente:** una vez con `lat`/`lng`, no se vuelve a pedir salvo que cambie la dirección
   (comparar hash de la dirección; si cambió → `lat=null` para re-geocodificar).

**Módulo compartido** (`server.js`, nuevo):
```
async function geocodificar(direccion, ciudad) -> { lat, lng, precision } | null
```
Un solo módulo que sirve para los 3 rubros (escribe en `properties.lat/lng`,
`developments.lat/lng`, `hotel_complejos.atributos.lat/lng`).

**Costo:** $0. Es one-off por propiedad. Aunque tengas miles, se geocodifican una vez y quedan.

---

## FASE 3 — LA IA USA LA UBICACIÓN

Dos capacidades, diseñadas para **cero gasto por conversación** (la clave del costo):

### 3A. Referencias de zona (qué hay cerca) — **enriquecimiento ONE-OFF**

**Idea central (la más barata):** NO consultar OSM en cada conversación. En su lugar, **al
geocodificar** (Fase 2), traer de una **los lugares cercanos** con Overpass y guardar un
**resumen de texto** en la propiedad. Después la IA lo lee del prompt, gratis, sin llamar a
nada en la charla.

**Servicio POIs:** Overpass API (OSM). `POST https://overpass-api.de/api/interpreter`
- Gratis. Query alrededor de `(lat,lng)` en radio ~800m: `amenity=supermarket|cafe|restaurant|pharmacy|bank|school`, `shop=*`, `natural=beach`, `leisure=park`, `public_transport=*`, `highway=bus_stop`.
- También distancias a referencias grandes: playa, centro, terminal (calculables con la geometría OSM o con el propio conocimiento de Claude sobre la ciudad).

**Guardar** un campo nuevo `referencias_zona` (text) por propiedad, ej:
`"A 200m: supermercado Día. A 400m: playa. A 1.2km: centro. Parada de colectivo a 150m."`
- Inmobiliaria/desarrolladora → columna `referencias_zona text` (misma migración, ADD COLUMN).
- Hotel → `atributos.referencias_zona`.

**Prompt IA:** el helper `_fmtDireccion` ya inyecta la dirección; sumar la línea
`referencias_zona` cuando exista (mismo patrón aditivo, byte-idéntico si está vacío).

- 🟢 **Costo por conversación: CERO.** Se paga (gratis, es OSM) una vez al cargar la propiedad.
- 🔴 **REGLA ANTI-INVENTO (dura):** la IA **solo** nombra lugares que estén en `referencias_zona`.
  Nunca de memoria (aluciona comercios). Ver [[ia-identificar-propiedad-por-zona]].

### 3B. "Buscar propiedades cerca de X" — **tool de la IA**

Cuando el lead pasa una dirección/zona ("algo cerca de Avenida 2 y 20", "por la terminal"):
- **Tool nueva** `buscar_propiedades_cerca(referencia)`:
  1. Geocodifica la referencia del lead → `(lat,lng)` (1 sola llamada Nominatim, cacheable).
  2. **Haversine local** (matemática, sin API) contra el `lat/lng` ya guardado del inventario.
  3. Devuelve las N propiedades más cercanas con su distancia.
- 🟢 Costo: 1 geocodificación gratis por consulta (cacheada por texto) + cálculo local. Nada recurrente.
- Resuelve el caso Casa Triana / Nandarou: el lead nombra la calle y la IA ata la propiedad por
  cercanía, aunque el texto no coincida exacto. Ver [[ia-identificar-propiedad-por-zona]].
- Gatear la tool con un flag (`ia_ubicacion_v1`) como las otras (derivar/agenda), fail-closed.

---

## ESCALADO Y LÍMITES (honesto)

- **Nominatim/Overpass públicos:** 1 req/seg, sin bulk. Alcanza de sobra para geocodificar
  altas + búsquedas de leads. Si algún día el volumen molesta, **self-host** ambos en un VPS
  chico (Docker oficial de Nominatim + Overpass, misma API, sigue gratis salvo el VPS).
- **Cobertura variable por zona:** OSM cubre muy bien ciudades y costa; en zonas rurales puede
  venir flojo. Por eso la **prueba previa** (abajo) sobre direcciones reales de Anton.
- **Cache obligatorio:** guardar `lat/lng` + `referencias_zona` en la fila (ya previsto) y
  cachear las geocodificaciones de referencias de leads (tabla `geocode_cache` texto→coords).

---

## PRUEBA PREVIA (antes de construir Fase 2/3)

Tomar 2-3 direcciones reales de Anton (una en La Plata, una en la costa tipo Villa Gesell) y
correr Nominatim + Overpass para ver:
1. ¿Geocodifica bien la dirección? (¿el pin cae donde debe?)
2. ¿Qué comercios/lugares devuelve alrededor? (¿alcanza para dar referencias?)

Si OSM viene completo en tus zonas → se construye Fase 2/3 tal cual, a costo cero. Si en alguna
zona viene flojo, se decide ahí (self-host con más data, o ajustar el radio).

---

## RESUMEN DE COSTOS

| Ítem | Servicio | Costo |
|---|---|---|
| Dirección estructurada (Fase 1) | — | $0 (ya hecho) |
| Geocodificar propiedades (Fase 2) | Nominatim OSM | **$0** (one-off por propiedad) |
| Referencias de zona (Fase 3A) | Overpass OSM | **$0** (one-off, cero por conversación) |
| Buscar propiedades cerca (Fase 3B) | Nominatim + math local | **$0** (1 geocode cacheable por consulta) |
| (Opcional) self-host si escala | VPS chico | costo del VPS, no de la API |

**Google Places NO se usa** (se cobra por conversación + obliga a mostrar sobre mapa de Google,
inservible en WhatsApp texto).

---

## DECISIONES PARA DIEGO

1. **Referencias de zona: ¿one-off (recomendado) o tool en vivo?** Recomiendo one-off
   (Fase 3A): la IA sabe qué hay cerca sin gastar nada por conversación. La tool en vivo se
   puede sumar después.
2. **¿Arranco por la prueba** sobre direcciones reales de Anton, para confirmar cobertura OSM
   antes de construir Fase 2/3?
3. **Radio de "cerca"** para referencias: propongo 800m (caminable). Ajustable.
