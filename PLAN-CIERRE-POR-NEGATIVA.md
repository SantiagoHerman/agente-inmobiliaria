# PLAN — El "no" del lead cierra el caso solo

**Pedido de Diego (2026-08-06), textual:** *"si el lead dice no me interesa o muestra que no tiene interes
o no me escriban o equivocado va a cerrado de forma automatica"*.

---

## 1. El problema, medido

En `Consulta 22/12 Jonh` (Anton), la conversación real:

```
[contact] Pero no estoy interesada
[contact] Gracias
[ai]      Perfecto, sin problema. Si en algún momento se despierta el interés, acá estamos.
[ai]      Hola John, quedó en mi mente tu consulta del 22...     <-- LA VOLVIÓ A RECONTACTAR
```

La IA **entendió** el "no me interesa" y contestó bien. Pero eso murió en el texto de la respuesta: la
conversación sigue `status='recontacto'`, `recontacto_excluido=false`, `motivo_perdida=null`. Nada la saca
de la cola, así que el cron la volvió a agarrar.

**Verificado en el código:** no existe ninguna detección de respuesta negativa. El ÚNICO cierre automático
que hay hoy es "agotó `recontacto_max`" (~server.js:17960). O sea: al lead que dice "no" se lo sigue
molestando hasta gastarle los 5 intentos.

Y con el bug que se arregló hoy (un recontacto fallido contaba como enviado), algunos de esos 5 intentos
ni siquiera llegaron.

---

## 2. Quién decide que es un "no"

**Se usa el clasificador que YA corre** (`clasificarEstado`, ~server.js:9886). Corre con Haiku en **cada**
mensaje del lead y hoy puede devolver solo tres cosas: `listo_humano`, `interesado`, `sin_cambio`.
Se le agrega un cuarto: `sin_interes`.

**No se usa una lista de frases.** "No me interesa ese, mostrame otro" y "no me interesa, gracias" tienen
las mismas cinco palabras y significan lo contrario. Una lista de palabras cierra leads buenos.

### El costo

🔴 **USD 0,000025 por mensaje** (~25 tokens más de prompt, Haiku a USD 1/millón). Con el volumen de Anton
son **menos de 5 centavos de dólar por mes**. No hay llamada nueva a la IA: es la misma que ya se paga.

---

## 3. La regla, y el riesgo que hay que cuidar

El clasificador devuelve `sin_interes` SOLO en estos tres casos:

| Caso | Ejemplos | `motivo_perdida` |
|---|---|---|
| No le interesa (nada, no una propiedad) | "no me interesa", "ya compré", "dejé de buscar" | `no_interesado` |
| Pide que no lo contacten | "no me escriban", "borrame", "basta" | `pidio_no_contacto` |
| Número equivocado | "equivocado", "no soy quien buscan" | `numero_equivocado` |

**EL RIESGO PRINCIPAL — y la regla que lo tapa:** hay que distinguir *"no me interesa **esa** propiedad"*
de *"no me interesa"*. El primero es un lead CALIENTE que está descartando opciones; cerrarlo sería el peor
error posible de esta función.

Por eso el prompt lleva la regla dura: **si el "no" apunta a una propiedad, una zona, un precio o una
opción puntual → NO es `sin_interes`.** Y ante cualquier duda → `sin_cambio` (o sea, no pasa nada). Es el
mismo criterio de "errar al caso seguro" que ya usa la whitelist de salida del clasificador.

---

## 4. Qué pasa cuando se detecta

1. `status = 'cerrado'`
2. `recontacto_excluido = true` — doble candado: el cron no lo agarra ni si alguien lo devuelve a
   `recontacto` a mano por error
3. `motivo_perdida` = el de la tabla de arriba → así en Cerrados se ve **por qué** se cerró, no solo que
   está cerrado
4. Se registra en el historial de estados (los dos mecanismos que ya existen), con origen `ia` y el motivo
5. **La IA igual contesta su línea amable.** Eso ya lo hace bien hoy y no se toca
6. **No se avisa a nadie.** Un lead que dijo "no" no es una notificación para el equipo

**No es un camino sin retorno:** si el lead vuelve a escribir, el webhook ya revive las conversaciones
cerradas con la IA encendida (~server.js:6069). Y el asesor puede sacarlo de Cerrado a mano cuando quiera.

---

## 5. Cómo se prende (y cómo se apaga)

Flag `cierre_negativo_v1` en `business_settings`, **default OFF**. Con el flag apagado el clasificador ni
menciona el cuarto estado: el prompt y el comportamiento quedan **byte-idénticos** a hoy.

- Se prende primero **solo en Anton** (es la cuenta de prueba acordada con el cliente).
- Se apaga con un `UPDATE` de una línea, sin desplegar.

---

## 6. Lo que NO entra en este plan

- **Los leads que YA dijeron "no" y siguen en recontacto.** Para encontrarlos hay que leer mensajes
  viejos: con IA cuesta plata (unos 1.900 mensajes salientes en la base) y con lista de palabras es
  impreciso. Es una decisión aparte, con su número.
- **Los 40 de Andrés Galdames** en el limbo del recontacto: es otro problema (la X que no cerraba) y ya
  tiene su propia migración escrita sin correr.
- Messenger e Instagram: el clasificador corre igual en esos canales, así que aplica; no requiere trabajo
  extra, solo probarlo.

---

## 7. Riesgo del cambio

**Medio.** Toca el clasificador, que corre en todos los mensajes de todas las cuentas — pero detrás de un
flag apagado por defecto, y el único efecto nuevo posible es cerrar una conversación (reversible a mano,
y auto-reversible si el lead escribe).

Lo que **no** se toca: el motor de envío, el reparto, la derivación, ni el cron de recontacto (solo se le
agrega el candado que ya sabe respetar: `recontacto_excluido`).
