# Plan de trabajo — Tres capas de instrucciones

**Diego, 2026-07-31.** Actualizado después de tus cambios en las instrucciones (pasaron de 48 a 37 ítems).
Cuadro completo de las reglas: artefacto "Las reglas de la IA, en orden".

**Costo de IA: $0.** Ningún cambio agrega llamadas al modelo. Tres de ellos **achican** el prompt.

---

## Lo que cambió desde el plan anterior

Borraste 11 instrucciones tuyas: de **31 a 20**. Y lo que sacaste es exactamente lo que estaba roto:

| Antes | Ahora |
|---|---|
| *"nosotros ser sus ojos"* | **eliminada** |
| *"podamos coordinar con otra inmobiliaria"* | **eliminada** |
| *"guardá los contactos y los recontactás cuando publiquemos preventa verano 2027"* | reescrita: *"si te preguntan por alquileres de verano después de vacaciones de invierno 2026 salimos con los precios"* — **sin la promesa imposible** |

Con eso, **dos de las cuatro contradicciones originales quedaron sin munición del lado del dueño**: la de
Margarita (servicio inexistente) y la de la preventa 2027 (acción sin herramienta).

### Pero aparecieron dos nuevas, y son de flujo

De tus 20 actuales, **dos mandan sobre la derivación** — justo lo que definiste que el dueño no debería poder hacer:

- **Tu #1**: *"Si el cliente busca algo que nosotros no tenemos **deriva** para que un asesor **del área que corresponda** pueda buscar"*
- **Tu #3**: *"…siempre consultando con el propietario o una oferta seria. **En ese caso deriva al departamento que corresponda** a un usuario"*

Las dos vuelven a pedirle que **elija área**, que es lo que acabamos de sacar del código en la Fase 2.
No son un error tuyo: son la prueba de que **mientras el campo esté abierto, el flujo se va a colar ahí**.
Por eso la Fase 6 (avisar al guardar) pasa a ser más importante de lo que era.

**No las toco.** Con la validación de la Fase 1 puesta, esas dos frases ya no pueden hacer daño: si la IA
elige un área sin respaldo, el código la descarta igual, venga la orden de donde venga.

---

## FASE 0 — Backup

### Código — HECHO
| Qué | Dónde |
|---|---|
| Rama | `backup/pre-capas-20260731` → `3d6ce4c0` |
| Tag | `punto-retorno-capas-20260731` |
| Copia física | `backups/server.js.bak-20260731-pre-capas-instrucciones` |

### Datos — PENDIENTE (bloqueado)
El panel de Supabase no carga (94 scripts cargados, pantalla en blanco: es de su lado).
**No hace falta para las Fases 1 a 4**, que no tocan ni una instrucción. Sí es obligatorio antes de la Fase 5.

```sql
create table if not exists instrucciones_backup (
  id bigserial primary key,
  user_id uuid not null,
  motivo text not null,
  tomado_en timestamptz not null default now(),
  instrucciones jsonb,
  perfiles jsonb
);
alter table instrucciones_backup enable row level security;

insert into instrucciones_backup (user_id, motivo, instrucciones, perfiles)
select user_id, 'pre-capas-20260731', instrucciones_agente, instruccion_perfiles
from business_settings;
```

---

## FASE 1 — Validación del área al derivar ✅ APLICADA

**Qué hace:** antes de aplicar el área que la IA eligió, el código chequea que lo que dijo el lead la respalde,
cruzándolo contra el **criterio de derivación** que cargaste para ese departamento. Si no hay respaldo,
**el lead se deriva igual** (nunca se frena una derivación) pero **sin área** → cae al reparto general.

**Es genérico:** no menciona compra ni alquiler. Usa la lista de departamentos de cada cuenta, así que funciona
igual con Limpieza, Mantenimiento, Capacitación o Alquiler de verano.

**Dónde:** `server.js` — flag `derivacionValidadaActiva()`, función `_areaTieneRespaldo()`,
y el punto de uso dentro de `iniciarRotacionDerivacionV3`.

**Detalle importante:** si el área se descarta, **tampoco cae al departamento por defecto**. En Anton el default
es "Venta", así que un lead sin intención clara terminaría igual en un área que no pidió. Sin respaldo y sin
departamento propio → sin área.

**Gate:** `derivacion_validada_v1`, default false, fail-closed. Con la columna ausente el comportamiento es
byte-idéntico al de hoy, así que se puede desplegar antes de correr la migración.

```sql
alter table business_settings add column if not exists derivacion_validada_v1 boolean default false;
notify pgrst, 'reload schema';
```

## FASE 2 — Dos frases del prompt ✅ APLICADA

**2a.** Se eliminó `al departamento que corresponda` de la regla que se dispara cuando el lead pregunta por una
propiedad que no figura. Era la que rompió el caso Max, y la había escrito yo el 28/07.

**2b.** La "regla de oro" se reescribió: antes nombraba COMPRAR / ALQUILAR / ADMINISTRACIÓN fijos; ahora apunta
a **las áreas configuradas de cada cuenta**. Se conservó el principio que resolvía el misruteo de Fabiana
(una palabra suelta no define el área), pero como ejemplo y no como regla de un solo rubro.

## FASE 3 — Eliminada la orden de prometer ✅ APLICADA

Se eliminó el cierre *"y decile al lead que lo consultás y le confirmás enseguida"*. Era la frase que la
REGLA CLAVE prohíbe nueve líneas más abajo. **La herramienta `consultar_al_dueno` no se tocó**: sigue igual,
solo se sacó la orden de prometer.

---

## FASE 4 — Reordenar el prompt (pendiente)

Las instrucciones del dueño y sus correcciones se mueven **del medio al final**, y las reglas duras del sistema
pasan a cerrar el texto. No cambia ninguna palabra: solo el orden.

**Por qué:** el principio y el final pesan más que el medio. Hoy las del dueño están en el medio con el mismo
peso que las del sistema.

**Riesgo:** medio — cambia el prompt cacheado, así que la primera respuesta de cada cuenta después del deploy
no aprovecha el caché. Costo puntual, una sola vez.

## FASE 5 — Partir las 16 de fábrica (pendiente, requiere backup de datos)

De las 16 de "Comportamiento", **4 mandan sobre el flujo** y hoy son editables y desactivables:

| Instrucción | Qué ordena | Caso que rompió |
|---|---|---|
| `cmp-cierre` | derivá **solo** cuando el lead acepta o coordina | Guille, Juan Ferruccio |
| `cmp-no-inventar` | *"si no tenés la info, decís que la consultás"* | Nes |
| `cmp-no-prometer-disponibilidad` | *"decile que la confirmás con un asesor"* | Nes |
| `cmp-progresa` | *"evitá respuestas que cierren la conversación"* | Margarita |

Se **mueven** al código (no se eliminan). Las otras 12 quedan en el panel bajo el título **"Cómo atender"**.
Tus 20 quedan bajo **"Lo que tiene que saber"**, sin tocar ninguna.

**Riesgo:** el más alto del plan, porque cambia lo que se ve en el panel de 4 cuentas vivas.
A favor: ninguna cuenta tiene instrucciones de fábrica desactivadas (verificado hoy).

## FASE 6 — Avisar al guardar (pendiente, ahora más importante)

Cuando el dueño guarda una instrucción, el sistema le avisa si:

1. **Manda sobre la derivación** — es el caso de tus #1 y #3 de hoy.
2. **Pide una acción que el sistema no puede hacer** — como era la de preventa 2027 antes de que la corrigieras.

**No la bloquea: la avisa.** El dueño decide, pero se entera en el momento.

---

## Estado ahora

| Fase | Estado |
|---|---|
| 0 · Backup de código | ✅ hecho |
| 0 · Backup de datos | ⏳ bloqueado (Supabase caído) |
| 1 · Validación del área | ✅ aplicada, sintaxis verificada |
| 2 · Dos frases | ✅ aplicada |
| 3 · Orden de prometer | ✅ aplicada |
| 4 · Reordenar | pendiente |
| 5 · Partir las de fábrica | pendiente — necesita backup de datos |
| 6 · Avisar al guardar | pendiente |

**Sin desplegar.** El código está en local, con `node --check` OK. Nada llegó a producción.

---

## Pendiente de decisión tuya

1. **¿Despliego las fases 1 a 3?** Son las que arreglan Max y Nes. Van gateadas: la validación arranca apagada
   y se prende primero en Anton.
2. **La regla 25** (`ia_no_sabe_modo`) está en "preguntar y derivar" en Anton. Hay tres modos y cambian bastante
   el comportamiento. ¿Lo revisamos aparte?
3. **Tus #1 y #3** mandan derivar a "el área que corresponda". Con la Fase 1 ya no hacen daño, pero si querés
   que la IA no las lea siquiera, las reescribo con vos (no las toco por mi cuenta).
