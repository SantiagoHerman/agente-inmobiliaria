# PLAN — Que la IA conozca al cliente, usando las fichas que ya existen

**Diego, 2026-08-06:** *"lo quiero hacer con fichas y que tenga fecha. Una ficha historial verano 2027 por
ejemplo. Ya la estructura esta, solo creamos un campo mas de fichas. Ahora que esta la estructura podemos
crear 10 fichas distintas por cliente."*

Tenías razón: la estructura está. Lo verifiqué campo por campo y **no hace falta agregar la fecha**.

---

## 1. Lo que la ficha YA tiene

```
contact_id · tipo · estado · property_id · conversation_id
desde · hasta · proximo_vencimiento          <- LAS FECHAS YA ESTAN
zonas · presupuesto · moneda · tipo_propiedad · ambientes · dormitorios
asesor_id · notas · origen · resultado · datos (jsonb libre)
```

- **Varias fichas por contacto:** ya es así por diseño. *"Un contacto puede tener VARIAS activas a la vez"*.
  Los 10 por cliente que decís entran sin tocar nada.
- **Estados:** `activa` / `pausada` / `cerrada`, y `resultado='concreto'` muestra **"Se concretó"**.
- **Hotel ya tiene los tipos que hacen falta:** Consulta · Reserva · **Estadía** · **Huésped recurrente** ·
  Convenio corporativo.

**Una "ficha historial verano 2027" ya se puede cargar hoy:** tipo `estadia`, `desde`/`hasta` con las
fechas, `property_id` o `datos.unidad` con la cabaña, `estado='cerrada'`, `resultado='concreto'`.

---

## 2. Lo que falta de verdad (dos cosas, y la segunda es la importante)

### A) El campo que sí falta: `titulo`

No hay dónde escribir **"Verano 2027"**. Hoy una ficha se identifica por tipo + fechas, que en una lista se
lee como `estadia 2027-01-12 → 2027-01-19`. Con un título es *"Verano 2027 — Cabaña 3"*.

Una columna de texto, aditiva, con tope de 80 caracteres. **Ese es el único campo nuevo.**

### B) LA IA NO LEE LAS FICHAS. Nada. Verificado.

El único lugar de todo el sistema que lee la tabla `fichas` fuera de los endpoints de alta/edición es el
motor de coincidencias — y va **al revés**: cuando cargás una propiedad, busca a qué leads les sirve.

Cuando un cliente escribe, la IA recibe **nombre, interés, presupuesto y notas** del contacto, más la
memoria de esa conversación. **De las fichas no ve una sola.**

Por eso hoy, aunque cargues la ficha "Verano 2026 — Cabaña 3", cuando Andrés vuelva a escribir la IA no va
a saber que ya se hospedó.

**Este es el trabajo real del plan.** El campo `titulo` son 5 minutos; esto es la función.

---

## 3. Cómo se lo damos a la IA

Al armar la respuesta se leen las fichas de ese contacto y se arma **una línea por ficha**, en el bloque de
datos del lead:

```
HISTORIAL DE ESTE CLIENTE (fichas cargadas por el equipo):
- Verano 2026 · Estadía · Cabaña 3 · 12/01 al 19/01/2026 · se concretó
- Verano 2025 · Estadía · Cabaña 3 · 08/01 al 18/01/2025 · se concretó
- Huésped recurrente · viaja con perro, prefiere planta baja
```

**Reglas duras que van en el prompt:**
- Sirve para **saludar y conectar**, no para dar por hecho. *"¿Vuelven a la Cabaña 3?"* es una pregunta;
  *"les reservé la Cabaña 3"* sería inventar.
- Las fichas **cerradas** son historia (*"como el verano pasado"*); las **activas** son lo que está en
  juego ahora.
- Si no hay fichas, el bloque no se agrega y el prompt queda idéntico a hoy.

### El tope, para que no se desmadre

Con 10 fichas por cliente hay que acotar: **las 6 más recientes**, una línea cada una, **tope 60 caracteres
por línea**. Máximo ~250 tokens por cliente.

---

## 4. La plata

Esta es la parte que preguntaste antes y la respuesta sigue siendo la buena: **no toca el caché.**

| Zona del prompt | Qué lleva | Precio | Cambia por cliente |
|---|---|---|---|
| Bloque 1, **cacheado** | Instrucciones, conocimiento, inventario | escribir USD 6/M · leer USD 0,30/M | No |
| Bloques 2+, **sin caché** | Datos del lead, memoria, **← acá van las fichas** | USD 3/M | Sí |

- **No invalida el caché** ni lo hace vencer antes.
- **Solo se paga en los mensajes de clientes que tienen fichas.**

🔴 **Costo: ~250 tokens × USD 3/M = USD 0,00075 por mensaje de un cliente con historial.** Contra los USD
0,0066 que hoy cuesta un mensaje en Anton, es un **11%** sobre ese cliente, y **cero** sobre los demás.

**Y va en la dirección que planteaste:** baja el bloque genérico y caro, sube lo específico y barato. El
RAG ya llevó el bloque de Anton de 152.000 a 12.000 tokens; esto suma 250 solo cuando escribe alguien que
ya es cliente.

**Costo de construir la ficha: CERO.** Las carga el equipo a mano, o la IA las propone con
`fichas_ia_v1` — que ya está prendido y ya verifiqué que **no llama a ningún modelo** (reusa la extracción
que ya se hizo).

---

## 5. El límite honesto

**Hoy la tabla `fichas` tiene 0 filas en todo el sistema.** La función va a funcionar perfecto y no va a
mostrar nada hasta que se carguen fichas.

Dos caminos para arrancar, no excluyentes:
1. **El equipo carga las de los clientes que importan.** Un hotel con 40 huéspedes recurrentes son 40
   fichas. Es trabajo humano, cero costo de IA.
2. **Reconstruirlas del historial.** Los mensajes viejos están en la base. Una pasada de Haiku por las
   conversaciones puede proponer las fichas de estadía pasadas, para que alguien las apruebe.
   🔴 Estimado: **~USD 0,0014 por contacto** → los 1.222 de Anton, **~USD 1,70 una sola vez.** Antes de
   correrlo se mide el largo real del historial y se confirma el número.

---

## 6. Riesgo y alcance

**Bajo.** Es una lectura nueva en un bloque que no se cachea:
- Sin fichas → prompt idéntico a hoy.
- Si la columna `titulo` no existe → se usa tipo + fechas y listo.
- No toca el envío, ni el reparto, ni la derivación, ni el caché, ni el motor de coincidencias.

**Alcance:** los 3 mundos. En inmobiliaria la misma línea sirve para *"¿les gustaría alquilar la casa
GARMES nuevamente?"* — es la ficha `es_inquilino` cerrada, con `property_id` y las fechas.

---

## 7. Qué hace falta de Diego

1. El **dale**.
2. Correr la migración: **1 columna** (`fichas.titulo`), aditiva.
3. Decidir si se hace el punto 5.2 (reconstruir historial viejo) y en qué cuentas.
