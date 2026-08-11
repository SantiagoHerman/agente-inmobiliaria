# PLAN — WhatsApp Cloud API funcional dentro de Raíces + el camino a Instagram/Messenger

**Diego, 2026-08-11.** Consolidado de todo lo definido el 10 y 11 de agosto. Regla madre, textual:
*"todo debe seguir igual como funciona ahora"* — **Evolution no se toca en ninguna fase.**

## El diseño en una línea

Cloud API es un **megáfono** para Recontacto y Oportunidades (no publicidad, no número principal).
La plantilla paga golpea la puerta; la conversación se vuelca al **WhatsApp Business** (Evolution),
donde no hay ventana de 24 h ni costo. Instagram y Messenger suman leads que también terminan ahí.

## Hechos verificados que sostienen el plan (no suposiciones)

| Hecho | Dónde se verificó |
|---|---|
| Cloud API y Evolution comparten llave (teléfono) → mismo contacto/conversación solos | server.js:12172 y :42158, ambos `obtenerOcrearConvDeCanal(user_id, telefono, 'whatsapp', …)` |
| Si la conv NO nació por Cloud, la IA contesta por Evolution | `canal_origen` (~server.js:41979): `'cloud'` o null; el router ya lo hace |
| Mensajes no-plantilla dentro de ventana abierta: **gratis**. Recibir: gratis. Servicio: gratis | docs de precios de Meta (per-message desde 1/7/2025) |
| Plantilla MARKETING: **siempre paga**. La paga el cliente directo a Meta (Tech Provider) | docs Meta + modelo ya construido (cloud_api_numbers.token por tenant) |
| Links wa.me en plantillas: **rechazo automático** | política de Meta, múltiples fuentes |
| Coexistencia: **descartada** — rompe Evolution (desvincula dispositivos, webhooks a medias) | docs Meta + experiencias de usuarios |
| Plantillas se aprueban **por WABA** (por cliente), no por app; el Tech Provider puede crearlas por API | docs Message Templates |
| Backend Cloud API ya construido: 9 endpoints + registro insertado (config 1562398828709758) | server.js:42469-42940; probado en Meta Test (1 número, 9 plantillas, 5 aprobadas) |
| IG/Messenger: ventana de 24 h SIN plantillas para reabrir → **recontacto imposible** | política de mensajería de Meta |
| El cron de inactividad NO filtra por canal → **bug latente** (mandaría recontacto a un IGSID) | revisarInactividad (server.js:16809): 0 menciones de `channel` |
| Revive de cerrado ya existe (REGLA 22): cerrado que escribe → en_conversacion | server.js:12555, verificado en vivo el 8/8 |
| App Meta "Raices": WhatsApp aprobado; IG (2) + pages (3) + business_management (1) rechazados SOLO por el video | consola App Review, leída el 10/8 |

## Decisiones de Diego (textuales)

- Recontacto: **tope 20/día** — *"pasados los 20 riesgo de baneo y queda en rojo el numero porque no puedo asegurar nada"*
- Oportunidades: **tope 10/día** — *"no mas el resto queda en rojo"*
- Oportunidades y Recontacto: **2 botones arriba** — WhatsApp Business predeterminado con el número vinculado visible / Cloud API con las plantillas aprobadas apareciendo a medida que se aprueban
- Catálogo de **20-30 plantillas** para que el cliente elija y mande a aprobación sin salir de Raíces
- El pase: pedir por TEXTO que escriba al otro número (ej. *"escribinos al +54… para comunicarte con ventas"*); si no escribe en X tiempo, mensaje **breve, humano, distinto cada vez, sin plantilla** desde la línea comercial (*"Hola Pablo, te escribo desde la línea comercial de Anton para derivarte con un asesor"*)
- Conversaciones: **4 listados** — WhatsApp Business (default) / Cloud API / Instagram / Messenger, cada conversación con su etapa y estado
- IG/Messenger: mismas etapas (en_conversacion / interesado / listo_humano); **sin recontacto**; inactividad → **cerrado**, con revive si vuelve a escribir

## Supuestos asumidos (Diego puede cambiarlos)

1. **X tiempo** del mensaje de línea comercial: 2 h dentro del horario de oficina; fuera de horario → mañana siguiente
2. Catálogo de plantillas vive en **Integraciones**; Oportunidades/Recontacto solo muestran el selector de aprobadas + atajo
3. Los 4 listados = **pestañas sobre la bandeja única** (nada queda escondido; los avisos siguen viendo todo)
4. El pase es **un solo hilo** (mismo contacto), sin recapitular la charla anterior
5. Tope del pase a línea comercial: **10/día**

---

# LAS FASES

## FASE 0 — Verificaciones previas (solo lectura; necesita el Chrome de Diego)
- Leer el **rate card de Argentina** en la consola de Meta (precio real de la plantilla MARKETING). Es el número que falta para el presupuesto; el ~USD 0,06 anotado es de julio, SIN verificar.
- Confirmar el webhook de estado de plantillas (`message_template_status_update`) llegando al backend.

## FASE 1 — Topes duros con el rojo (protege Evolution HOY; no depende de Cloud API)
- Backend: tope diario POR CUENTA en los motores: recontacto **20/día**, oportunidades **10/día**. Corte en el cron (no solo visual). `oportunidades` ya tiene `enviados_hoy`; recontacto necesita su contador diario.
- Front: contador "X de 20 hoy" + estado ROJO con el texto de Diego cuando se alcanza; lo excedente queda en cola para mañana, marcado.
- Gate patrón correcto (sin default + `IS NOT FALSE`), Meta Test afuera.

## FASE 2 — Conversaciones: pestañas por canal
- 4 pestañas: WhatsApp Business (default) / Cloud API / Instagram / Messenger.
- Filtros: `channel=whatsapp & canal_origen is null` / `canal_origen='cloud'` / `channel=instagram` / `channel=messenger`. Hoy: 1383 / 1 / 2 / 1.
- Etiqueta del canal en cada tarjeta. Todo sobre la bandeja única existente (misma detección de sonidos/avisos).

## FASE 3 — Arreglos obligatorios pre-envío
- **3a.** `enviarPlantillaCloud` y `enviarTextoCloud` actualizan `messages.estado_envio` + guardan `wa_message_id` (tildes ✓✓). Sin esto, todo envío masivo queda en "enviando" para siempre.
- **3b. El bug latente del cron:** `revisarInactividad` y los motores de envío EXCLUYEN `channel in (instagram, messenger)`. En su lugar: inactividad en IG/MSN → **cerrado** (motivo `inactividad_canal_sin_recontacto`), con el revive ya existente. Registrar en el historial de estados.

## FASE 4 — Integraciones: la pantalla del trámite
- Sección nueva "Integraciones" con tarjeta **WhatsApp Cloud API**: escalera de 7 pasos con estado (portafolio → conectar [botón registro insertado, ya existe] → número verificado → nombre aprobado → tarjeta cargada → plantilla aprobada → envío de prueba). Detector de "dónde estás trabado" leyendo `/api/cloud-api/estado` + Graph.
- **El camino a IG/Messenger:** tarjetas de Instagram y Messenger en la misma pantalla, con su botón Conectar (los flujos OAuth YA existen: `/api/meta/oauth/start` y `/api/meta/ig/oauth/start`) y estado "esperando aprobación de Meta" mientras los 6 permisos sigan rechazados. Cuando Meta apruebe, se prenden solas.

## FASE 5 — Catálogo de plantillas (20-30)
- Redacción de 20-30 plantillas es_AR (recontacto, oportunidades, seguimiento; variables `{{1}}`; categoría MARKETING/UTILITY bien elegida; SIN links wa.me).
- Catálogo central (tabla nueva) + UI en Integraciones: el cliente tilda cuáles quiere → push por API a SU WABA → estado por cliente (pendiente/aprobada/rechazada + la categoría QUE META DEVUELVE, que puede diferir de la pedida).
- Migración: tabla `plantillas_catalogo` (por el Chrome de Diego).

## FASE 6 — Botones de origen en Oportunidades y Recontacto
- **BÚSQUEDA POR ETIQUETA EN OPORTUNIDADES (Diego 2026-08-11: "agregar la busqueda de etiquetas
  dentro de oportunidades").** Segmento nuevo "por etiqueta" junto a fríos/tibios/calientes/etc.,
  con el catálogo del tenant (`/api/etiquetas`). Lee de LAS DOS fuentes:
  - `conversations.etiquetas` (existe HOY, operador `ov` ya probado en `/api/leads`) → sirve ya
    mismo para leads con conversación etiquetados a mano.
  - `contacts.etiquetas` (llega con F10) → los importados sin conversación.
  También en `buscar-leads` (14180) para armar `custom_ids` filtrando por etiqueta. Tocar
  `_resolverUniversoOportunidad` (14085) con el mismo cuidado del hallazgo #20 (un universo con
  contactos sin conversación no debe trabar la cola de oportunidades).
- Oportunidades: botones [WhatsApp Business ●] / [Cloud API] arriba, número visible en cada uno. Con Cloud: selector SOLO de plantillas aprobadas de esa cuenta + variables; el motor manda `enviarPlantillaCloud` en vez de texto libre. Topes de Fase 1 aplican por canal.
- Recontacto: mismo par de botones (aunque el uso esperado es WhatsApp Business).
- Las 3 oportunidades existentes siguen en texto libre por WhatsApp Business (sin cambios).

## FASE 7 — El pase a la línea comercial
- Marca `pase_pedido_at` cuando la IA (por Cloud/IG/MSN) pide que escriba al WhatsApp Business.
- Trigger: si no escribió en X (supuesto 1), mensaje breve/humano/variado por Evolution desde la línea comercial. Tope 10/día + rojo. Prompt: modo "primer mensaje de línea comercial" — usa la info del lead SIN recapitular.
- En IG/MSN la IA pide el WhatsApp TEMPRANO (el reloj de 24 h corre y no hay recuperación): pide el
  número del lead O le sugiere seguir con el sector correspondiente por esa línea (le da el número).

## FASE 8 — Unificación del contacto: IG/Messenger → WhatsApp (Diego 2026-08-11)
*"hay que lograr una unificacion de datos dentro del contacto. Si escribe a cloud api, al ser un
numero de telefono ya tiene el dato para seguir. Pero instagram y messenger no, ahi los tiene que
pedir."* — En Cloud API la unificación es automática (misma llave = teléfono). En IG/MSN el contacto
vive bajo un IGSID/PSID que no se parece a un teléfono: hay que capturarlo y enlazar.
- **8a. Capturar el teléfono:** sumar `telefono` a la extracción que YA corre por turno (hoy saca
  interés/presupuesto/nombre/fechas; 0 llamadas extra de IA). Normalizado a formato internacional.
- **8b. Guardarlo:** columna nueva `contacts.telefono_capturado` (migración; `contacts.phone` en IG
  guarda el IGSID, no se toca).
- **8c. Enlazar:** cuando aparece (o ya existe) una conversación de WhatsApp con ese teléfono en la
  misma cuenta → vincular ambos contactos (`contacts.contacto_principal_id`, enlace NO destructivo:
  nada se borra ni se pisa). La ficha, el resumen y el historial se muestran UNIFICADOS bajo el
  contacto principal (el de WhatsApp); la conversación de IG/MSN sigue visible en su pestaña.
- **8d. El disparo del pase:** con el teléfono capturado, el trigger de Fase 7 puede salir por la
  línea comercial hacia ese número ("Hola Pablo, te escribo desde la línea comercial de Anton…"),
  dentro del tope de 10/día. Al primer mensaje, el enlace 8c ya une todo.
- Si el lead nunca da el teléfono ni escribe: la conversación IG/MSN sigue su ciclo normal y a la
  inactividad va a **cerrado** (Fase 3b), con revive si vuelve a escribir.

## FASE 9 — Perfil automático del contacto (Diego 2026-08-11)
*"tenemos que lograr que se vaya armando automaticamente el perfil del contacto asi no depende de una
carga manual, no quita que se modifique manualmente."*
- La extracción que YA corre por turno (interés, presupuesto, nombre, fechas — 0 llamadas extra de IA)
  se extiende para completar el perfil: teléfono (8a), email, ciudad/zona, presupuesto CON moneda,
  y los campos generales de la ficha ("Más datos del cliente").
- **REGLA DURA: lo automático SOLO completa campos VACÍOS. Lo manual nunca se pisa.** Un dato cargado
  a mano (o corregido a mano) gana siempre; la extracción no lo toca. Editar a mano sigue igual que hoy.
- Aplica a TODOS los canales (WhatsApp/Cloud/IG/Messenger). Misma filosofía que fichas_ia_v1
  (la IA propone, la persona confirma) y que el resumen automático.

## FASE 10 — Importación inteligente de contactos (Diego 2026-08-11)
*"dejar la importacion por CSV pero agregar una mas: un excel, varios pdf o imagenes de fotos de un
libro para que la IA interprete, y rellene, arme fichas y todo lo necesario para crear contactos
nuevos o actualizar los que hay… ver el uso de IA, Haiku o Sonnet, evaluar el gasto y SIEMPRE pedir
permiso para ese gasto… y aprobar cada contacto nuevo o cada informacion o ficha."*
- El CSV actual queda intacto. Lo nuevo es un segundo camino: subir Excel / PDFs / fotos.
- **🔴 PERMISO SIEMPRE, POR LOTE:** antes de llamar a la IA se cuenta el material (filas, páginas,
  imágenes), se estima el costo CON NÚMERO y el modelo elegido, y se muestra el botón "Aprobar
  gasto". Sin ese click no se gasta un token. Cada importación pide permiso de nuevo.
- **Modelo por material:** Excel/tabla limpia → Haiku; PDFs escaneados, manuscritos, fotos de libro →
  Sonnet (visión). El presupuesto dice cuál y por qué; se puede forzar el otro.
- **NADA escribe directo en contacts:** todo va a STAGING (tablas nuevas `import_lotes` +
  `import_items`, migración). Cola de aprobación ítem por ítem: contacto nuevo / actualización de
  uno existente (con diff contra lo que hay) / ficha propuesta. Dedupe por teléfono y email contra
  los contactos existentes.
- Al aprobar, se aplica con la regla de Fase 9: **lo manual nunca se pisa** — una actualización que
  reemplaza un dato cargado a mano se marca distinto y exige aprobación explícita de ese reemplazo.
- Reusa lo construido: fichas con `confirmada=false` (patrón existente), el alta del importador CSV,
  la normalización de teléfonos.
- **ETIQUETAS EN LA IMPORTACIÓN (Diego 2026-08-11):** *"si importo contactos de un telefono de
  alquileres, a todos les pongo 'alquileres viejos' y en oportunidades los busco con esa etiqueta…
  una etiqueta para cada contacto, o una para todos, o crear una nueva y que queden todos marcados.
  En esa solapa no se pueden eliminar etiquetas."*
  - En el paso de revisión: selector de etiqueta POR LOTE (una para todos) + override POR CONTACTO +
    "crear nueva" inline (va al catálogo del tenant, `/api/etiquetas`). **Sin botón de borrar
    etiquetas en esa solapa** — el catálogo solo se administra donde siempre.
  - **Lo que faltaba y se agrega:** columna `contacts.etiquetas` (hoy las etiquetas viven SOLO en
    `conversations.etiquetas` — verificado — y un importado no tiene conversación). Migración.
  - **Propagación:** cuando a ese contacto se le crea una conversación (escribe o le escriben), las
    etiquetas del contacto se copian a la conversación — así los filtros existentes las ven.
  - **Oportunidades aprende a buscar por etiqueta de CONTACTO** (hoy su universo exige conversación,
    `_resolverUniversoOportunidad` 14085 y buscar-leads 14180): segmento nuevo "etiqueta X" que trae
    contactos con teléfono aunque no tengan conversación. Es LA pieza que hace posible el caso de uso.
  - Aplica también al importador CSV existente (misma solapa, mismo selector).

## CORRECCIONES DE LA AUDITORÍA (2026-08-11 — 4 auditores, informes completos en
## AUDITORIA-PRE-PLAN-HALLAZGOS.md; los números # refieren a ese archivo)
- **F4 = EXTENDER `/whatsapp`** — la sección "Integraciones" YA existe (key 'whatsapp'), con
  CloudApiCard montada y tabs por canal (#4). No se crea `/integraciones`.
- **Saneos ANTES de la pantalla F4:** las 2 filas IG duplicadas de Meta Test + arreglar los upserts
  de credenciales que multiplican filas (#40) · popup o redirect en el OAuth (#46) · sacar los DOS
  gates hardcodeados (EN_PREPARACION y la exclusión de Anton, #5) · switch dueño para prender
  `cloud_api_v1` (#29) · Integraciones = solo dueño (#47).
- **La escalera se construye honesta (#43):** extender `/estado` pidiendo a Graph
  `code_verification_status` + `name_status` (y persistir `verified_name`); tarjeta/pago = tilde
  manual o inferencia por error 131042 (mapearlo); portafolio = "no verificable" si Graph falla;
  persistir el envío de prueba. "Esperando aprobación de Meta" = flag manual + detección reactiva
  por granular_scopes en el callback (#44). Revisar el scope manage_comments antes de liberar (#45).
- **F3a se agranda:** factorizar la persistencia del path manual (13559) en un adaptador usado por
  TODOS los envíos Cloud; para Oportunidades además CREAR la fila en messages y renderizar el texto
  local (#26). El default de `estado_envio` es 'enviado' → el bug real es el ✓ mentiroso, no el
  "enviando" (#27). Marcar fallo también en la fila de la IA del canal Meta (#41).
- **F3b se agranda:** la exclusión de canal va en LOS TRES SENDERS (4 puertas de entrada, #14) +
  escape de canal en `reintentarFallidos` (#42) + guarda de destinatario con `verificarNumeroWA`
  (#15) + guarda de ventana de 24 h en IG/MSN (#41).
- **F1 corregida:** v2 YA tiene contador diario — el tope es 1 línea en 18244 (#18); el legacy solo
  corre en Meta Test; **el tope de Oportunidades necesita contador POR CUENTA nuevo** (el existente
  es por-oportunidad y su default es 200/día, #17); los motores de recontacto deben chequear el
  resultado del envío antes de contar (copiar el patrón de Oportunidades, #16).
- **FASE NUEVA (previa a F2/F7/F9): post-proceso compartido.** `clasificarEstado`, `extraerDatosLead`
  y el revive corren SOLO en Evolution (#36): una conv de Cloud no cambia de etapa nunca, y en
  IG/MSN hay derivación pero no clasificación. Factorizar y enchufar a los 3 webhooks.
- **F5:** plantillas body-only por ahora (#32); webhook `message_template_status_update` +
  `_resolverTenantPorWaba` + cron de refresco (#31); unificar idioma crear/enviar (#33).
- **Exclusividad Cloud:** unique por `phone_number_id` + 409 en `/conectar` (#35) + UNIQUE(user_id)
  o resolución única de fila (#34).
- **F9:** el arreglo del pisado de `interest`/`budget` (#3) entra ANTES de extender la extracción.
- **Token Cloud:** columna de vencimiento + aviso; el 190 hoy es silencioso y gasta IA (#30).
- **i18n:** traducir las pantallas que salgan en el video (conversaciones ~35-40%, CloudApiCard 0%).

## ORDEN DE EJECUCIÓN (Diego 2026-08-11: "primero integraciones y despues el resto")
1. Revisión previa profunda (4 auditores de solo lectura sobre todo lo que el plan toca)
2. **FASE 4 — Integraciones** (pantalla + escalera + tarjetas IG/MSN "esperando aprobación")
3. FASE 0 (rate card, cuando el Chrome esté) · FASE 3 (arreglos obligatorios) · FASE 1 (topes+rojo)
4. FASE 2 (pestañas) · FASE 5 (catálogo) · FASE 6 (botones) · FASE 7 (pase) · FASE 8 (unificación) · FASE 9 (perfil automático)
5. Carril videos App Review en paralelo (guiones míos, graba Diego)

## CARRIL APARTE — App Review de Meta (desbloquea IG/Messenger de verdad)
- Escribir los 2 guiones de video (Messenger con login Facebook; Instagram con login Instagram): login completo, usuario con acceso, ida y vuelta de mensajes, interfaz EN INGLÉS (el panel ya tiene i18n con 'en'), subtítulos.
- Incluir `instagram_business_manage_comments` en el próximo envío (está en la app, nunca se pidió).
- Grabar: Diego. Enviar: desde su consola.

## Reglas transversales
- Evolution intacto en TODO el recorrido. Meta Test afuera de todo.
- Secuencial (sin agentes paralelos en el mismo repo). Commit + rama por fase. Backup/rollback antes de tocar datos. Migraciones por el Chrome de Diego. `node --check` + build + salud tras cada deploy.
- Gates nuevos: patrón sin-default + `IS NOT FALSE` para mejoras; `cloud_api_v1` sigue siendo preferencia por cuenta.
- 🔴 Los envíos de plantillas los paga EL CLIENTE a Meta → el tope duro en backend va ANTES que cualquier botón de envío (orden de las fases lo garantiza).

## Qué necesita Diego hacer
1. El **dale** a este plan.
2. Chrome abierto para: rate card (Fase 0) y migraciones (Fases 5/7).
3. Grabar los 2 videos con mis guiones (carril aparte, cuando quiera).
