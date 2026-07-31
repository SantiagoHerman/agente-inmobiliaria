# Plan de trabajo — Bajar el costo por mensaje a $0.03–0.04

**Diego, 2026-07-31.** Objetivo: que **ningún mensaje pase de $0.03–0.04**. Hoy el promedio es $0.023,
pero el primer mensaje de cada conversación cuesta **$0.064** y el p95 llega a $0.070.

Todo lo que sigue está **medido**, no estimado. Fuente: `ia_uso` de Anton, 28 al 31 de julio (770 llamadas).

---

## 1. De dónde sale el costo (medido)

### 1a. El costo NO está donde parecía

| Operación | Llamadas | Gasto | % |
|---|---|---|---|
| **respuesta_agente** | 188 | **$4.79** | **88%** |
| prueba_agente | 1 | $0.22 | 4% |
| clasificar_estado | 145 | $0.12 | 2% |
| extraer_datos | 208 | $0.12 | 2% |
| detectar_idioma | 207 | $0.09 | 2% |
| resto (memoria, resumen, traducir, citas) | 21 | $0.07 | 1% |

**Los auxiliares no son el problema:** 594 llamadas (77% del total) cuestan el 7% del gasto. Haiku sin caché,
400–800 tokens cada una. **No tocar.**

### 1b. Adentro de `respuesta_agente`, el 61% es caché

| Concepto | Gasto | % |
|---|---|---|
| **Escribir el caché** (38 veces) | **$1.95** | **41%** |
| Leer el caché (150 veces) | $0.96 | 20% |
| Tokens de entrada del turno | $1.45 | 30% |
| Respuesta del modelo | $0.42 | 9% |

**El bloque cacheado pesa 17.026 tokens** (promedio real de `cache_read`). Escribirlo cuesta
17.026 × $3.75/millón = **$0.064**. Ese es exactamente el precio del primer mensaje.

Escribe **38 veces de 188 llamadas (20%)**: una por conversación nueva, más las que vuelven después
de que el caché de 5 minutos venció.

### 1c. Qué hay adentro de esos 17.026 tokens (medido pieza por pieza)

| Pieza | Tokens | % |
|---|---|---|
| **Herramientas que recibe Anton** (13 de 18) | **~4.700** | 28% |
| **VOZ_AGENTE_V2** (la personalidad) | **2.380** | 14% |
| Instrucciones del panel (16 + 1 + 20) | 2.466 | 14% |
| Reglas fijas escritas en el código | 2.351 | 14% |
| Índice del inventario (RAG) | ~500 | 3% |
| Sin identificar (identidad, base de conocimiento, formato) | ~4.600 | 27% |

**Verificado y descartado:** las herramientas de hotel (`buscar_unidades`, `ficha_unidad`,
`consultar_disponibilidad`) y de desarrolladora (`buscar_desarrollos`, `ficha_desarrollo`) **sí están
filtradas por rubro** — a Anton no le llegan. Esa palanca no existe.

---

## FASE 1 — Sacar del caché lo que casi no se usa

**Las 5 herramientas de datos en vivo pesan 1.303 tokens y no se usaron NI UNA VEZ en 4 días:**

| Herramienta | Tokens |
|---|---|
| distancia_viaje | 302 |
| pronostico_clima | 291 |
| feriados_ar | 256 |
| cotizacion_dolar | 242 |
| normalizar_direccion_ar | 212 |

Viajan en el prompt de **cada** conversación, se pagan en **cada** escritura de caché, y en 4 días no
apareció ni una llamada a ninguna en el desglose por operación.

**Qué se hace:** cargarlas solo cuando el mensaje del lead las amerita (si menciona dólar, clima, feriado,
distancia o una dirección). Es un chequeo de palabras sobre el texto entrante, sin IA.

**Ahorro medido: −1.303 tokens (−$0.0049 por escritura).**
**Riesgo: bajo.** Si el chequeo falla, la herramienta no está y la IA responde sin ella —igual que hoy
cuando el flag está apagado.

## FASE 2 — Achicar la voz

`VOZ_AGENTE_V2` son **2.380 tokens** de personalidad, y adentro hay ejemplos de diálogo (few-shot).
Uno de ellos es el que enseña *"dejame que lo confirme y te lo paso"* —la frase que veníamos persiguiendo—.

**Qué se hace:** recortar los ejemplos dejando las reglas de tono. Un ejemplo bien elegido rinde igual que
seis, y de paso se va el que enseña la promesa vacía.

**Ahorro estimado: −1.000 a −1.200 tokens (−$0.0041).**
**Riesgo: medio.** Cambia cómo habla la IA. Se prueba en la cuenta de prueba antes de tocar Anton.

## FASE 3 — Revisar herramientas duplicadas

`buscar_inventario` (968) y `buscar_y_detallar` (804) suman **1.772 tokens**. Hay que verificar si la segunda
no hace lo que ya hacen `buscar_inventario` + `ficha_inventario` juntas.

**Ahorro potencial: −804 tokens (−$0.0030), si se confirma que está duplicada.**
**Riesgo: medio.** Hay que mirar cuál usa la IA en la práctica antes de sacar ninguna.

## FASE 4 — Limpiar las contradicciones (ya empezada)

Las 4 contradicciones que encontramos también son tokens repetidos: tres reglas dicen "prometé consultar"
y una lo prohíbe; dos dicen cuándo derivar y se contradicen.

**Ya aplicado:** se sacó *"al departamento que corresponda"*, se reescribió la regla de oro, y se eliminó
la orden de *"decile que le confirmás enseguida"*.

**Falta:** mover las 4 instrucciones de fábrica que mandan sobre el flujo, y unificar las repetidas.

**Ahorro estimado: −800 tokens (−$0.0030).**
**Riesgo: el de la Fase 5 del otro plan** (toca el panel de 4 cuentas). Requiere el backup de datos.

## FASE 5 — Partir el caché en dos bloques

**La palanca más grande, y la más técnica.** Hoy los 17.026 tokens se cachean como **un solo bloque**:
si cambia una instrucción del dueño, o entra una propiedad nueva al inventario, **se reescribe todo**.

**Qué se hace:** dos bloques con su propio `cache_control`:
- **Bloque A (fijo de verdad):** identidad, reglas del sistema, herramientas. Cambia cuando desplegamos.
- **Bloque B (del cliente):** instrucciones, base de conocimiento, índice del inventario. Cambia cuando el
  dueño edita algo.

Así, editar una instrucción reescribe solo el bloque B (~3.000 tokens) en vez de los 17.000.

**Ahorro: no baja el costo del primer mensaje, pero elimina las reescrituras por edición.**
**Riesgo: medio-alto.** Toca el mecanismo de caché. Va con flag y se mide antes/después.

## FASE 6 — El panel de prueba

**Cada click en "probar" cuesta $0.22** — 8,6 veces una conversación real. Medido: escribe **58.171 tokens**
de caché contra los 17.026 de producción, y los tira (no hay conversación después).

**La causa:** en modo prueba el RAG se apaga ([server.js:6815](server.js)), así que manda el inventario
completo en vez del índice. Y con él se apagan también la derivación v3, la ubicación y la disponibilidad.

**Qué se hace:** que el modo prueba use la misma configuración que producción.

**Ahorro: de $0.22 a ~$0.065 por prueba (−70%).**
**Y lo más importante, que no es plata:** hoy estás probando un agente **distinto** del que atiende a tus
clientes. Con esto, lo que probás es lo que corre.
**Riesgo: bajo.**

## FASE 7 — El TTL de 1 hora (medido: conviene, pero apenas)

El flag `ai_cache_ttl_1h` existe y está apagado. Medí sobre 12 leads y 112 huecos entre mensajes:

| | Escrituras |
|---|---|
| Hoy (caché de 5 min) | 42 |
| Con caché de 1 hora | 24 |
| **Reducción** | **43%** |

El punto de equilibrio calculado en el código es 37,5%. **Conviene por 5,5 puntos**, lo que da un ahorro
neto de aproximadamente **$1,35 al mes**.

**Recomendación: no hacerlo por ahora.** El margen es demasiado chico para justificar tocar el caché, y si
el patrón de conversación cambia, pasa a perder. Queda anotado por si el volumen crece.

## FASE 8 — Arreglar el medidor (no ahorra, pero sin esto volás a ciegas)

El panel del Maestro **muestra la quinta parte del gasto**: dice $16.06 en julio cuando el real es **$59.65**.
La consulta pide 100.000 filas pero Supabase corta en 1.000.

**Qué se hace:** paginar de a 1.000 hasta terminar, igual que ya se hace en Conversaciones y Recontactos.
Afecta al ranking por cliente, la alerta de "uso alto", el saldo restante y el costo por mensaje.

**Y de paso:** el panel divide el costo por **llamadas** (770) en vez de por **mensajes** (230), así que
muestra $0.0069 cuando el costo real por conversación atendida es $0.023.

**Riesgo: bajo.** Solo cambia lo que muestra, no el comportamiento.

---

## Adónde llegamos

| Fase | Ahorro por escritura | Bloque resultante |
|---|---|---|
| Hoy | — | 17.026 tok → **$0.064** |
| 1 · Herramientas bajo demanda | −1.303 | 15.723 → $0.059 |
| 2 · Voz recortada | −1.100 | 14.623 → $0.055 |
| 3 · Herramienta duplicada | −804 | 13.819 → $0.052 |
| 4 · Contradicciones y repetidos | −800 | 13.019 → **$0.049** |

**Con las cuatro fases el primer mensaje baja de $0.064 a $0.049 (−23%), y el promedio por mensaje de
$0.023 a ~$0.019.**

**No alcanza para $0.03–0.04 en el primer mensaje.** Para llegar ahí hay que recortar el bloque a ~10.000
tokens, y faltan 3.000 más que sacar de las **~4.600 sin identificar**. El primer paso del trabajo es
volcar el prompt completo tal como sale y medir esas 4.600 línea por línea — recién ahí sabremos si se
pueden recortar sin perder calidad.

**Lo que sí se cumple ya:** ningún mensaje que no sea el primero pasa de $0.03. La mediana está en $0.013.

---

## Orden propuesto

1. **Fase 8** (el medidor) — primero, porque sin él no podemos comprobar si el resto funciona.
2. **Fase 6** (panel de prueba) — riesgo bajo, arregla plata y además lo que probás.
3. **Fase 1** (herramientas bajo demanda) — el ahorro más grande con riesgo bajo.
4. **Medir las 4.600 sin identificar** — decide si el objetivo es alcanzable.
5. **Fases 2, 3 y 4** — tocan calidad; se prueban en la cuenta de prueba primero.
6. **Fase 5** (partir el caché) — la más técnica, al final.
7. **Fase 7** — no hacer.

## Qué NO se toca

- Los auxiliares de Haiku (7% del gasto, funcionan).
- El RAG: ya bajó el costo por mensaje de $0.11 a $0.0064. Es lo que más ahorró hasta ahora.
- El motor de reparto, los estados y la derivación.
