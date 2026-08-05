# PLAN — RECONTACTO CON MEMORIA (que el primer mensaje retome lo hablado)

**Pedido de Diego:** *"Cuando un lead entra en recontacto con antigüedad de conversación, la IA tiene que
mandar un mensaje acorde a lo hablado. No suelto. Que analice la conversación y pueda responder sobre
eso el primer mensaje."*

Fecha: 2026-08-05 · Cuenta medida: **Anton** (`f771e75e-c12a-4010-b301-d59796da5168`) · Todo lo de la base
es **SELECT** (cero escrituras). Rama de trabajo: `feature/recontacto-memoria` (main NO se tocó).

---

## 🔴 LO PRIMERO: EL COSTO NO ES EL PROBLEMA

| Opción | Qué es | Llamadas IA | **USD** |
|---|---|---|---|
| **A — la "cara"** | Generar memoria para los 1.092 leads de Anton | 1.092 | **USD 1,60** |
| **A real** | Generar memoria solo donde SE PUEDE (los 106 que charlaron y no la tienen) | 106 | **USD 0,15** |
| **B — la barata** | Lo que el código YA hace: últimos 8 mensajes + interés, **sin memoria previa** | 148 | **USD 0,14** |
| **B por lead** | Una sola llamada | 1 | **USD 0,00093** |
| **C** | A real + B | 254 | **USD 0,29** |

Base del cálculo (Haiku 4.5, `PRECIO_HAIKU` en `server.js:1583` = in **$1** / out **$5** por 1M tokens):
- **MEDIDO** sobre las 148 conversaciones reales: promedio **1.053 chars** en los últimos 14 mensajes y
  **778 chars** en los últimos 8.
- **PROYECTADO**: tokens = chars / 3,5 + system prompt (~160 memoria / ~260 recontacto); salida ~200 y ~90 tokens.

**Conclusión del costo:** la diferencia entre la opción cara y la barata es de **15 centavos de dólar**.
El costo NO es lo que frena esto. Lo que sí pesa es el **medidor de plan**: cada recontacto con IA descuenta
1 `ai_message` del cupo del cliente (`server.js:17427`), o sea ~USD 0,03 all-in por lead × 148 ≈ **USD 4,4**
de consumo de plan. Sigue siendo chico.

Además: la opción A "de 1.092" **es imposible tal cual**. `actualizarMemoriaViva` corta y no llama a la IA si
la conversación no tiene mensajes (`server.js:10653`), y **944 de los 1.092 no tienen ni un mensaje del lead**.

---

## 1. La hipótesis era FALSA

> Hipótesis que traía el pedido: *"1.092 leads ya hablaron pero no tienen memoria, por eso el mensaje sale genérico."*

**No es así.** Medido hoy en la base:

| Dato | Número |
|---|---|
| Conversaciones en estado `recontacto` (Anton) | 1.100 |
| Con `recontacto_categoria = 'viejo'` | 1.092 |
| **De esos, los que el lead escribió DE VERDAD** | **148** |
| Los que **nunca escribieron nada** | **944** |
| Con `memoria_viva` | 42 (todos dentro de los 148) |
| Con `summary` | 2 |
| De los 148, con `contacts.interest` cargado | 125 |

Reparto de mensajes en los 1.092 `viejo`:

| Mensajes en la conversación | Convs |
|---|---|
| 0 | 606 |
| 1 (y ese 1 es el propio recontacto saliente de la IA) | 338 |
| 2–3 | 43 |
| 4–8 | 44 |
| 9+ | 61 |

### Por qué `'viejo'` no significa "ya habló"
`recontacto_categoria='viejo'` lo pone el **checkbox del importador de CSV** ("ya le escribieron"):
`server.js:23326` (`catBody`) y `server.js:23397`. Es una etiqueta que carga el dueño al importar, **no** un
hecho verificado contra `messages`. Por eso 944 leads figuran como "viejo" sin haber escrito jamás en el CRM.

El gate real que decide si se usa IA es otro: **`_leadCharloReal`** (`server.js:15655`), que exige un
`messages.role='contact'` con `origen <> 'historial_importado'`. Los 944 no lo pasan → `esPrimerContacto = true`
→ y las 4 llamadas a `mensajeRecontactoIA` exigen `!esPrimerContacto` → **nunca se llama a la IA**.

### La prueba dura
`ia_uso` con `etiqueta = 'recontacto_ia'` en Anton: **0 filas**. En toda la historia de la cuenta.
`mensajeRecontactoIA` **no corrió ni una sola vez**. (Control: `etiqueta='memoria_viva'` sí tiene 161 filas,
o sea la tabla y la etiqueta funcionan.)

Los **434 recontactos** enviados entre 2026-06-22 y 2026-08-05 fueron **todos plantilla**. De los últimos 60:
57 fueron a leads que nunca escribieron; los 3 restantes fueron a leads cuyo primer mensaje es **posterior** al
recontacto (le contestaron al recontacto) — verificado comparando `messages.created_at` contra `recontactos.enviado_at`.

**Qué NO verifiqué:** solo medí la cuenta Anton. No revisé las otras 5 cuentas.

---

## 2. Qué recibe HOY `mensajeRecontactoIA` para un lead viejo real

Reconstruí el input exacto (`server.js:15408-15414`) para 5 leads concretos de Anton, todos `viejo`,
todos **sin** `memoria_viva`:

| conv | nombre | msgs | memoria | `interest` | ¿devuelve null? |
|---|---|---|---|---|---|
| `fee08312…` | Ricardo | 6 | vacía | `propiedad id29854 · dice llamarse: Ricardo` | **NO — personaliza** |
| `e146b481…` | Pablo Martin Ruiz | 2 | vacía | `propiedad id37311` | **NO — personaliza** |
| `5aaf39dd…` | Miriam Tarabini | 8 | vacía | `duplex en alguna playa · dice llamarse: Miriam Tarabini` | **NO — personaliza** |
| `8030d307…` | Cris | 2 | vacía | `propiedad id29854 · dice llamarse: Cris` | **NO — personaliza** |
| `37b3cb53…` | Larsen | 4 | vacía | `propiedad id36423` | **NO — personaliza** |

Ejemplo del chat que le llega (Ricardo): *Lead: "Estoy interesado en la propiedad id29854 donde queda" → Asesor:
"Es un duplex/triplex en Paseo 117 y Avenida 3, Villa Gesell…" → Lead: "Para vivir" → Lead: "2 personas"*.
Con eso la IA tiene de sobra para retomar.

**Los 5 devuelven texto personalizado, no null.** La línea `if (!memoria && !interes && !chat) return null`
(`server.js:15414`) **no** es el cuello de botella: alcanza con que haya chat, y hay.

**Traducción:** la personalización **ya funciona y no necesita memoria**. El motivo de que Diego vea siempre
un mensaje suelto es que **el 86% de la cola de recontacto de Anton son importados de CSV que nunca escribieron**,
y a esos no hay nada que retomar — la plantilla es la respuesta correcta.

### El verdadero problema de producto
El orden de la cola v2 (`server.js:17276-17285`) es: (1) `'viejo'` antes que `'frio'`, (2) oldest-due-first.
Como **los 1.092 son `'viejo'`**, el criterio (1) no desempata nada y los **148 que sí tienen algo para retomar
compiten de igual a igual con los 944 que no**. Con tope de 20/día y agresividad `lenta`, en la práctica
**nunca les toca el turno** → la IA de recontacto jamás se enciende (los 0 registros lo confirman).

---

## 3. Por qué la memoria no está cargada

- **Quién la escribe:** `actualizarMemoriaViva` (`server.js:10649`) → `conversations.memoria_viva`.
- **Único caller:** `server.js:12495`, dentro del webhook de WhatsApp, con throttle:
  `_nMsgs >= 9 && (_nMsgs % 3 === 0)`. Solo conversaciones de **9+ mensajes** y solo en el turno en que el total
  es múltiplo de 3.
- **No está gateada por ningún flag** y **nunca se dejó de escribir**: sigue corriendo (161 registros en `ia_uso`).
  Simplemente el umbral casi no se alcanza: de los 1.092 `viejo` solo **61** llegan a 9+ mensajes, y **42** tienen
  memoria. Los números cierran.
- **No corre para conversaciones que ya cayeron a recontacto**: el caller vive en el webhook de mensajes
  entrantes; si el lead dejó de escribir, nunca más se recalcula.
- **`summary`:** se escribe solo al derivar a humano pidiendo resumen (`server.js:4971-4975`) o desde el endpoint
  manual (`server.js:36363`). Por eso hay 2 de 1.092.

---

## 4. Qué hay que cambiar — etapas de menor a mayor riesgo

### E1 — Priorizar en la cola a los que SÍ charlaron ✅ CONSTRUIDO en la rama
**Riesgo: cero con el flag OFF (byte-idéntico). Costo IA: $0.**
Nueva prioridad en el orden de la cola v2: **primero las conversaciones donde el lead escribió de verdad**,
después los importados que nunca escribieron. Es el cambio que hace que la IA de recontacto **por fin se encienda**
sobre los 148 leads que tienen algo para retomar.

- Flag nuevo `business_settings.recontacto_prio_charla` (default `false`, fail-closed).
- Helpers `_recontactoPrioCharlaOn` y `_convsCharlaRealBulk` (mismo criterio que `_leadCharloReal` pero en lotes
  de 100 ids: 1 query cada 100 convs, no 1 por conv).
- Con el flag OFF: `_setCharla = null`, no se hace ni la query, el comparador ordena exactamente igual que hoy.
- Migración: `migracion-recontacto-prio-charla.sql` (incluye `NOTIFY pgrst` por el gotcha PGRST204). **No corrida.**
- `node --check server.js` pasa.

**Falta para activarlo:** correr la migración y poner el flag en `true` en Anton. Ninguna de las dos cosas se hizo
(hace falta el "dale" de Diego).

### E2 — Que el dueño vea la diferencia en el panel
**Riesgo bajo, solo lectura, $0.** Mostrar en la vista de recontacto cuántos de la cola tienen charla real vs.
cuántos son importados sin nada. Hoy no hay forma de distinguirlos y por eso el problema se leyó como "la IA no
personaliza" cuando en realidad "no había a quién personalizarle".

### E3 — Backfill de memoria a los 106
**Riesgo medio (escribe en la base), USD 0,15.** Correr `actualizarMemoriaViva` sobre las 106 conversaciones que
charlaron y no tienen memoria. **Recomendación: NO hacerlo todavía.** Los 5 casos que reconstruí ya personalizan
sin memoria; la memoria solo aportaría en las 61 conversaciones largas (9+ mensajes), donde los últimos 8 mensajes
se quedan cortos. Hacerlo después de E1, y solo si el texto resultante no convence.

### E4 — Bajar el umbral de la memoria viva
**Riesgo medio (sube el gasto de forma recurrente).** Bajar `_nMsgs >= 9` a, digamos, `>= 5`. 🔴 Esto sí sube el
gasto de manera permanente en TODAS las cuentas y hay que estimarlo aparte antes de tocarlo. No lo recomiendo
mientras E1 no esté probado.

### E5 — Arreglar la semántica de `recontacto_categoria` en el importador
**Riesgo medio-alto (toca datos históricos).** Hoy `'viejo'` mezcla dos cosas distintas: "el dueño dice que ya le
escribieron por fuera del CRM" y "escribió en el CRM". Convendría separarlas en dos campos. Es refactor, no urgencia:
E1 ya resuelve el efecto práctico sin tocar los datos.

---

## 5. Lo que NO hay que hacer

- **No** generar memoria para los 1.092: 944 no tienen mensajes, la función corta sola y sería gasto tirado.
- **No** tocar `mensajeRecontactoIA`: está bien y ya personaliza. El bug no está ahí.
- **No** sacar el gate `!esPrimerContacto`: es lo único que evita que la IA queme plata inventando mensajes
  "personalizados" para 944 leads de los que no se sabe absolutamente nada (era exactamente el problema que F6 vino
  a arreglar, ver comentario en `server.js:15649-15654`).

---

## Estado de la rama `feature/recontacto-memoria`

| Archivo | Cambio |
|---|---|
| `server.js` | +54 líneas: flag helper, lector bulk, prioridad en el sort. Todo gateado, default OFF. |
| `migracion-recontacto-prio-charla.sql` | Nueva columna `recontacto_prio_charla` (default false) + `NOTIFY pgrst`. **NO corrida.** |

Sin push, sin deploy, sin flags encendidos, sin escrituras en la base.
