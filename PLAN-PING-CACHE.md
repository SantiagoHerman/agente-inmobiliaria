# PLAN — El ping que mantiene vivo el caché

**Diego, 2026-08-06:** *"el ping va con el cache de 1 hora. Este deberia prenderse de forma automatica en
todas las cuentas, ya que en definitiva deberia disminuir el costo de los mensajes durante el dia, ya que
el primer mensaje es caro el resto no."*

---

## 1. La cuenta, medida en Anton hoy

178 llamadas a la IA, de 08:30 a 19:54. Costo del día: **USD 0,8870**.

**Dos escrituras de caché en todo el día**, las dos justo después de un silencio largo:

| Silencio | Duración | Consecuencia |
|---|---|---|
| 08:31 → 10:30 | 119 min | caché vencido → reescritura |
| 14:10 → 15:13 | 63 min | caché vencido → reescritura |

| Con el ping | Cantidad | Costo |
|---|---|---|
| Pings para tapar esos huecos | 3 | USD 0,0150 |
| Escrituras evitadas | 2 | USD 0,1598 |
| **Ahorro del día** | | **USD 0,1448** (~USD 4,30/mes) |

**Punto de equilibrio: 16 pings = 1 escritura.** Todo hueco de menos de 16 horas conviene taparlo.

---

## 2. EL HALLAZGO QUE CAMBIA LA IMPLEMENTACIÓN

**El ping tiene que mandar un prefijo BYTE-IDÉNTICO al de una respuesta real.** Si difiere aunque sea en un
carácter, Anthropic lo trata como otro caché: se paga una escritura nueva (USD 0,08) **y el caché real
se vence igual**. O sea, el ping saldría más caro que no hacerlo.

**Por eso NO se puede usar `modoPrueba`,** que era el camino obvio. En `generarRespuestaAgente`, el modo
prueba apaga una docena de flags con la condición `if (conversation_id && !modoPrueba)`:
`derivacion_v3`, `ia_ubicacion`, `ia_disponibilidad`, `ciclo_tools`, las 5 fuentes externas, y más.

Varios de esos **cambian la lista de herramientas** — y las herramientas son parte del prefijo cacheado
(el propio código lo mide con `_toolsHash`, aparte de `_staticPromptHash`). Con `derivacion_v3` ON en una
cuenta, una llamada real ofrece `derivar_a_humano` y el modo prueba no: **dos prefijos distintos, dos
cachés distintos.**

### Lo que hay que hacer en su lugar

Un modo nuevo, `modoPing`, que arma el prompt **exactamente igual que una llamada real** (mismos flags,
mismas tools, mismo bloque estático) y solo se diferencia en el final:

- `max_tokens: 1` — la respuesta se descarta, no se lee
- no guarda ningún mensaje, no toca la conversación, no envía nada a WhatsApp
- no cuenta como mensaje del plan del cliente (no llama a `registrarUsoIA`)
- sí registra en `ia_uso` con etiqueta `ping_cache`, para poder medir si funciona

Necesita un `conversation_id` real de la cuenta (cualquiera reciente), porque los flags se resuelven con
`if (conversation_id && ...)`. El bloque estático **no depende de la conversación** — los datos del lead
viajan en un bloque aparte que no se cachea — así que cualquier conversación sirve.

### Cómo se verifica ANTES de prenderlo

`ia_uso` ya guarda `static_prompt_hash` y `tools_hash` de cada llamada. La prueba es directa:

1. Prender el ping en Anton solamente.
2. Comparar el `static_prompt_hash` + `tools_hash` de las filas `ping_cache` contra las de
   `respuesta_agente` de la misma cuenta.
3. **Si los dos hashes coinciden, el ping sirve. Si no coinciden, el ping está pagando un caché paralelo**
   y hay que corregirlo antes de prenderlo en el resto.

Ese chequeo cuesta un ping (USD 0,005) y evita pagar escrituras dobles en 7 cuentas.

---

## 3. Cuándo pinguea

El caché largo **ya tiene ventana horaria** (`_horarioCacheLarga`, ~server.js:3006): 07:00 a 23:59 hora
Argentina. Fuera de esa ventana el bloque se cachea a 5 minutos, no a 1 hora, con la cuenta ya hecha en el
código: *"el TTL largo solo paga si elimina más del 37,5% de las escrituras"*.

**El ping usa LA MISMA ventana.** No hay que inventar un horario nuevo ni configurarlo por cuenta:

1. Cron cada **10 minutos**.
2. Solo entre las **07:00 y las 23:59** (la misma ventana del caché largo; fuera de ahí no hay caché de 1h
   que mantener).
3. Solo cuentas con `ai_cache_ttl_1h` activo (hoy: todas menos Raíces CRM y la congelada).
4. Solo si **hubo actividad hoy** en esa cuenta. Mantener vivo un caché que nadie usó es tirar plata.
5. Solo si pasaron **50 o más minutos** desde la última llamada a la IA (el caché vence a los 60).
6. **Corte por pings secos:** si se pinguearon 3 seguidos y no entró ningún mensaje, se para hasta que
   alguien escriba. Sin esto, una cuenta que se apaga a las 15:00 seguiría pagando pings hasta medianoche.

Con estas reglas, en un día como el de hoy en Anton son **3 pings**, no 16.

### Por qué esto responde a lo que pediste

Es automático en todas las cuentas y no hay nada que recordar: la ventana ya existe, el flag ya está
prendido por defecto para las cuentas nuevas, y la regla 6 hace que una cuenta sin movimiento deje de
pinguear sola.

---

## 4. Costo y riesgo

🔴 **Gasto nuevo:** los pings. Acotado por diseño: máximo 1 cada 10 minutos por cuenta dentro de la
ventana, con corte por pings secos. En Anton, medido contra el día de hoy: **USD 0,015/día de pings contra
USD 0,16/día de escrituras evitadas**.

**Riesgo: medio.** Toca `generarRespuestaAgente`, la función más delicada del sistema. Mitigación: el modo
ping se agrega como una rama que solo se activa con el parámetro, y el cron arranca apagado hasta que los
hashes confirmen que el prefijo coincide.

**Lo que no toca:** el envío a WhatsApp, el reparto, la derivación, los estados, el cobro por mensaje.

---

## 5. Y después, la Fase A

Diego pidió el ping primero. Queda anotado que la Fase A (estabilizar el bloque) sigue pendiente y es
**gratis**: hoy el bloque cambia solo porque tres consultas al inventario no tienen `ORDER BY` y Postgres
devuelve las filas en otro orden. Cada cambio fuerza una reescritura de USD 0,082.

Con el ping puesto y el bloque todavía inestable, el ping va a renovar un caché que igual se rompe por el
otro lado: se paga el ping **y** la reescritura. La Fase A es lo que hace que el ping rinda de verdad.
