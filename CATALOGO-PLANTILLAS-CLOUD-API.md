# CATÁLOGO DE PLANTILLAS — WhatsApp Cloud API (Raíces CRM)

Fecha: 2026-08-11. Estado: **BORRADOR PARA DECIDIR. No se creó ninguna plantilla en Meta, no se tocó código, no se mandó nada.**

26 plantillas listas para copiar y pegar. Diego elige cuáles se mandan a aprobar. Nada de esto se ejecuta solo.

Complemento de `PLAN-RECONTACTO-CLOUD-API.md` (ahí está el costo y las etapas). Acá está el **texto**.

---

## 0. Antes de elegir: las 6 cosas que hay que saber

**1. Esto cuesta plata.** 🔴 Cada plantilla MARKETING entregada en Argentina cuesta **≈ USD 0,06** (dato de julio 2026, **sin reverificar** — reverificar contra la tabla de Meta antes de mandar la primera). 100 leads = 🔴 **USD 6**. 1.000 leads = 🔴 **USD 60**. Se paga conteste el lead o no.

**2. Cuando el lead contesta, se abre la ventana de 24 h y el texto libre es GRATIS.** La plantilla es el golpe en la puerta. La conversación de verdad no cuesta. Por eso todas las plantillas de acá abajo terminan pidiendo una respuesta: la respuesta es lo que abre la puerta gratis.

**3. Meta reasigna la categoría sola.** Vos pedís UTILITY y te la devuelve como MARKETING si le suena promocional. El código ya lo contempla: guarda **la categoría que dice Meta**, no la que pediste (`server.js:43356-43360`). Abajo marqué categoría honesta: donde puse UTILITY es porque tiene chance real, y aviso el riesgo de reclasificación.

**4. El código de hoy solo soporta variables en el CUERPO.** Nada de header con imagen, nada de botones, nada de carousel (`enviarPlantillaCloud`, `server.js:42286-42311`: solo arma `components: [{ type: 'body' }]`). Todo lo de abajo está diseñado dentro de esa limitación. Al final marqué cuáles ganarían mucho con header/botón cuando se construya.

**5. Prohibido en el cuerpo:** links `wa.me`, acortadores (bit.ly y similares). Si hay que poner un link, **dominio propio completo** (ej: `raicescrm.com/propiedad/1234`). **Un número de teléfono escrito SÍ está permitido** — de eso vive la plantilla de derivación (A4/A5).

**6. Reglas de variables (si se rompen, Meta rechaza):** no pueden ir al principio ni al final del cuerpo, ni dos seguidas. Todas las de abajo cumplen. Cada plantilla es **nombre + idioma**: la misma plantilla en otro idioma es otra plantilla.

---

## 1. Cómo leer cada ficha

- **Nombre**: va tal cual. Minúsculas y guiones bajos. Si escribís otra cosa el código lo normaliza igual (`_cloudApiNombrePlantilla`, `server.js:42858`), pero mejor escribirlo bien.
- **Categoría**: la que hay que pedir. Con el motivo.
- **Cuerpo**: copiar y pegar textual. No editar sin releer la sección 6.
- **Riesgo de rechazo**: probabilidad de que Meta **no la apruebe**. Es distinto del riesgo de que te **reclasifique la categoría** (eso lo aviso aparte).

Convención de variables usada en todo el catálogo:

| Variable | Qué es | De dónde sale hoy |
|---|---|---|
| `{{1}}` | Nombre del lead | `contacts.nombre_manual` / `contacts.name` |
| `{{2}}` | Nombre del asesor / agente | `business_settings.agent_name` |
| `{{3}}` | Nombre del negocio | `business_settings.company_name` |
| `{{4}}`, `{{5}}` | Dato variable del caso | Lo carga el dueño al armar la campaña |

Las tres primeras el motor **ya las tiene en la mano** en el sender de recontacto. Cero queries nuevas.

---

# BLOQUE A — Sirven para los 3 rubros (12)

---

## A1 · `recontacto_suave_01`

**Categoría:** MARKETING — es un "¿seguís interesado?" sin transacción abierta. Pedir UTILITY acá es perder el tiempo: Meta la reclasifica.
**Idioma:** `es_AR`

**Cuerpo:**
```
Hola {{1}}, te escribe {{2}} de {{3}}. Hace un tiempo nos consultaste y quedamos por la mitad. Si seguís con la idea, contame y retomamos por acá. Si ya no te sirve, avisame y no te escribo más.
```

**Variables:** `{{1}}` nombre del lead · `{{2}}` asesor · `{{3}}` negocio

**Renderizado:**
> Hola Marcelo, te escribe Nadia de Anton Bienes Raíces. Hace un tiempo nos consultaste y quedamos por la mitad. Si seguís con la idea, contame y retomamos por acá. Si ya no te sirve, avisame y no te escribo más.

**Rubro:** los tres · **Caso:** recontacto (primer toque)
**Riesgo de rechazo: BAJO.** Identifica al negocio en la primera línea, referencia una consulta previa real y ofrece salida explícita. El "avisame y no te escribo más" es lo que más baja los reportes, que es el riesgo que de verdad importa.

**Esta es la plantilla por defecto del primer toque.** Si hay que aprobar una sola, es esta.

---

## A2 · `recontacto_charla_cortada_01`

**Categoría:** MARKETING — retomar una charla comercial cortada. No hay transacción concreta que justifique UTILITY.
**Idioma:** `es_AR`

**Cuerpo:**
```
Hola {{1}}, soy {{2}} de {{3}}. Quedamos a mitad de camino la última vez y no quiero dejarte colgado. ¿Querés que sigamos donde lo dejamos o preferís que te escriba más adelante?
```

**Variables:** `{{1}}` nombre del lead · `{{2}}` asesor · `{{3}}` negocio

**Renderizado:**
> Hola Sofía, soy Franco de Raíces Inmobiliaria. Quedamos a mitad de camino la última vez y no quiero dejarte colgado. ¿Querés que sigamos donde lo dejamos o preferís que te escriba más adelante?

**Rubro:** los tres · **Caso:** recontacto del que dejó de responder a mitad de charla
**Riesgo de rechazo: BAJO.** Contexto claro, pregunta cerrada, sin oferta ni promesa. Dar la opción "escribime más adelante" evita el bloqueo.

⚠️ **Solo mandarla a leads que efectivamente hablaron.** A un lead frío importado le suena a mentira ("¿qué charla?") y ahí es donde te reportan.

---

## A3 · `recontacto_sigue_buscando_02`

**Categoría:** MARKETING — mismo caso que A1.
**Idioma:** `es_AR`

**Cuerpo:**
```
Hola {{1}}, ¿cómo va? Soy {{2}}, de {{3}}. Te escribo por la consulta que nos hiciste hace unas semanas. ¿Seguís en la búsqueda o ya lo resolviste?
```

**Variables:** `{{1}}` nombre del lead · `{{2}}` asesor · `{{3}}` negocio

**Renderizado:**
> Hola Damián, ¿cómo va? Soy Nadia, de Anton Bienes Raíces. Te escribo por la consulta que nos hiciste hace unas semanas. ¿Seguís en la búsqueda o ya lo resolviste?

**Rubro:** los tres · **Caso:** recontacto (segundo toque)
**Riesgo de rechazo: BAJO.**

**Para qué existe si ya está A1:** por la **rotación**. El motor no le manda dos veces el mismo texto al mismo lead (`_recontactoYaEnviados`). Con Cloud API la variedad se degrada a "elegir entre N plantillas aprobadas", así que hacen falta al menos 2-3 del mismo tipo. A1 + A3 + A2 es el juego mínimo.

---

## A4 · `derivar_a_whatsapp_comercial_01` ⭐

**Categoría:** MARKETING — es reapertura de contacto comercial. No hay forma honesta de pedir UTILITY.
**Idioma:** `es_AR`

**Cuerpo:**
```
Hola {{1}}, te escribe {{2}} de {{3}}. Este es nuestro número de avisos. Para seguir la charla escribinos al {{4}}, que es el WhatsApp donde te atiende el equipo todos los días.
```

**Variables:** `{{1}}` nombre del lead · `{{2}}` asesor · `{{3}}` negocio · `{{4}}` número del WhatsApp comercial, escrito completo

**Renderizado:**
> Hola Marcelo, te escribe Nadia de Anton Bienes Raíces. Este es nuestro número de avisos. Para seguir la charla escribinos al +54 9 3541 55-1234, que es el WhatsApp donde te atiende el equipo todos los días.

**Rubro:** los tres · **Caso:** el caso de Diego — mandar desde el número Cloud y llevar la conversación al número comercial de siempre

**Riesgo de rechazo: MEDIO.**
- ✅ A favor: **el número escrito en el texto está permitido**. Esto no es un link, es un dato de contacto. Meta lo acepta.
- ⚠️ En contra: los revisores de Meta miran con lupa las plantillas cuyo único objetivo es sacar al usuario del canal. Si el cuerpo no dice **quién sos** y **para qué**, cae. Por eso la primera línea identifica negocio y asesor antes de pedir nada.
- 🔴 **Nunca escribir el número como `wa.me/549...`**. Eso es rechazo automático. Va como número, con espacios o guiones, como lo escribiría una persona.

**Por qué esta plantilla resuelve un problema real:** el número Cloud tiene el límite de 24 h y cobra por plantilla; el número de Evolution no tiene ninguno de los dos problemas. Esta plantilla usa el caño caro **una sola vez** para mudar al lead al caño gratis. Un solo mensaje de USD 0,06 por lead, y de ahí en adelante la conversación vive donde siempre.

**Efecto lateral a tener en cuenta:** el lead termina con dos hilos del mismo negocio en el teléfono. Es el split-brain de la sección 3.2 del plan, pero acá es **deliberado y explicado** ("este es nuestro número de avisos"), que es distinto de que le pase sin aviso.

---

## A5 · `derivar_a_whatsapp_comercial_02`

**Categoría:** MARKETING
**Idioma:** `es_AR`

**Cuerpo:**
```
Hola {{1}}, soy {{2}} de {{3}}. Tengo novedades de lo que estabas buscando. Escribime al {{4}} y te paso todo por ahí, que es el WhatsApp donde atiende el equipo.
```

**Variables:** `{{1}}` nombre del lead · `{{2}}` asesor · `{{3}}` negocio · `{{4}}` número comercial

**Renderizado:**
> Hola Verónica, soy Franco de Raíces Inmobiliaria. Tengo novedades de lo que estabas buscando. Escribime al +54 9 351 234-5678 y te paso todo por ahí, que es el WhatsApp donde atiende el equipo.

**Rubro:** los tres · **Caso:** derivación al número comercial, versión con anzuelo
**Riesgo de rechazo: MEDIO.** Igual que A4, más un punto: "tengo novedades" sin decir de qué es lo que a Meta le suena genérico. **Usarla solo cuando las novedades existen de verdad** — si el lead contesta "¿qué novedades?" y no hay nada, ahí sí te reporta.

Es la variante para rotar con A4. Si hay que elegir una sola, **A4**.

---

## A6 · `reactivacion_cliente_viejo_01`

**Categoría:** MARKETING — reactivación comercial.
**Idioma:** `es_AR`

**Cuerpo:**
```
Hola {{1}}, tanto tiempo. Soy {{2}} de {{3}}. Pasó bastante desde la última vez que hablamos y quería saber cómo venís. Si necesitás una mano con algo, contá conmigo por acá.
```

**Variables:** `{{1}}` nombre del lead · `{{2}}` asesor · `{{3}}` negocio

**Renderizado:**
> Hola Roberto, tanto tiempo. Soy Nadia de Anton Bienes Raíces. Pasó bastante desde la última vez que hablamos y quería saber cómo venís. Si necesitás una mano con algo, contá conmigo por acá.

**Rubro:** los tres · **Caso:** reactivación de cliente viejo (ya operó, no es un lead nuevo)
**Riesgo de rechazo: BAJO.** No vende nada, no promete nada, no tiene oferta. Es la más inofensiva del catálogo.

⚠️ **Esta va solo a quien YA fue cliente.** Mandársela a un lead frío es raro y suena a fingir una relación que no existe.

---

## A7 · `novedad_encaja_con_busqueda_01`

**Categoría:** MARKETING — aviso de producto nuevo. 100% marketing, sin discusión.
**Idioma:** `es_AR`

**Cuerpo:**
```
Hola {{1}}, soy {{2}} de {{3}}. Entró algo que encaja bastante con lo que buscabas: {{4}}. Si querés te paso fotos y todos los detalles por acá.
```

**Variables:** `{{1}}` nombre del lead · `{{2}}` asesor · `{{3}}` negocio · `{{4}}` descripción corta de lo que entró

**Renderizado:**
> Hola Carolina, soy Franco de Raíces Inmobiliaria. Entró algo que encaja bastante con lo que buscabas: 2 ambientes con balcón en Nueva Córdoba, USD 68.000. Si querés te paso fotos y todos los detalles por acá.

**Rubro:** los tres · **Caso:** oportunidad
**Riesgo de rechazo: BAJO-MEDIO.** El cuerpo está bien; el riesgo entra por `{{4}}`. Si el dueño escribe ahí "OFERTA IMPERDIBLE ÚLTIMO DÍA", la plantilla ya aprobada se puede reportar y bajarte el quality rating.

🔴 **Regla dura para `{{4}}`: descripción, no publicidad.** Qué es, dónde, cuánto. Sin mayúsculas sostenidas, sin signos de exclamación, sin urgencia inventada.
🔴 **`{{4}}` no puede llevar saltos de línea ni tabs** — Meta rechaza el envío. Ver sección 6.

---

## A8 · `baja_de_precio_01`

**Categoría:** MARKETING — aviso de precio. Es la definición de marketing.
**Idioma:** `es_AR`

**Cuerpo:**
```
Hola {{1}}, soy {{2}} de {{3}}. Bajó el precio de {{4}} y ahora queda en {{5}}. Te aviso por si todavía te interesa. Escribime y te paso los detalles.
```

**Variables:** `{{1}}` nombre del lead · `{{2}}` asesor · `{{3}}` negocio · `{{4}}` qué bajó · `{{5}}` precio nuevo **con moneda**

**Renderizado:**
> Hola Damián, soy Nadia de Anton Bienes Raíces. Bajó el precio de la casa de Villa Belgrano que habías visitado y ahora queda en USD 145.000. Te aviso por si todavía te interesa. Escribime y te paso los detalles.

**Rubro:** los tres · **Caso:** oportunidad — baja de precio
**Riesgo de rechazo: BAJO.** Es un aviso concreto y verificable, que es exactamente lo que Meta quiere ver.

🔴 **`{{5}}` va SIEMPRE con moneda** (`USD 145.000` o `$ 145.000`, nunca `145.000` pelado). Regla del proyecto, y acá además evita que el lead entienda otra cosa.

**Es la plantilla con mejor tasa de respuesta esperable del catálogo**, porque avisa algo que al lead le sirve de verdad. Si Diego va a probar Cloud con 5 leads, probaría con esta.

---

## A9 · `respuesta_pendiente_01`

**Categoría:** **UTILITY** (pedir UTILITY) — es el seguimiento de un pedido concreto que hizo el lead: pidió una información y no se la dieron. Es la que más chance tiene de quedar UTILITY de todo el catálogo.
🔴 **Aviso de reclasificación: MEDIO.** Si Meta la ve como excusa para vender, vuelve como MARKETING y pasa a costar. El código guarda la categoría que devuelve Meta, así que se ve enseguida en el panel.
**Idioma:** `es_AR`

**Cuerpo:**
```
Hola {{1}}, soy {{2}} de {{3}}. Te quedé debiendo la información que me habías pedido sobre {{4}}. Ya la tengo: decime y te la mando por acá.
```

**Variables:** `{{1}}` nombre del lead · `{{2}}` asesor · `{{3}}` negocio · `{{4}}` qué había pedido

**Renderizado:**
> Hola Lucía, soy Franco de Raíces Inmobiliaria. Te quedé debiendo la información que me habías pedido sobre las expensas del departamento de Alberdi. Ya la tengo: decime y te la mando por acá.

**Rubro:** los tres · **Caso:** recontacto con deuda real de nuestro lado
**Riesgo de rechazo: BAJO.**

🔴 **Solo se usa cuando es CIERTO.** Si se manda a los 1.096 leads de Anton diciendo que se les debe información, es mentira, y una mentira a escala es lo que dispara reportes y le baja el quality rating al número oficial. Esta plantilla es de uso quirúrgico, no de campaña masiva.

---

## A10 · `confirmar_si_sigue_interesado_cierre_01`

**Categoría:** MARKETING — sigue siendo un "¿seguís interesado?".
**Idioma:** `es_AR`

**Cuerpo:**
```
Hola {{1}}, soy {{2}} de {{3}}. No quiero llenarte de mensajes, así que esta es la última por ahora. ¿Seguís interesado o te cierro la consulta? Con un sí o un no me alcanza.
```

**Variables:** `{{1}}` nombre del lead · `{{2}}` asesor · `{{3}}` negocio

**Renderizado:**
> Hola Marcelo, soy Nadia de Anton Bienes Raíces. No quiero llenarte de mensajes, así que esta es la última por ahora. ¿Seguís interesado o te cierro la consulta? Con un sí o un no me alcanza.

**Rubro:** los tres · **Caso:** último toque, antes de cerrar la conversación
**Riesgo de rechazo: BAJO.** Anunciar que es la última y pedir una respuesta binaria es la plantilla que **menos** reportes genera de todo el catálogo. Baja el riesgo de quality rating de toda la campaña.

**Encaja con el motor tal como está:** al llegar a `recontacto_max` la conversación pasa a `cerrado`. Esta es la que corresponde al último intento.

---

## A11 · `retomar_con_dato_concreto_01`

**Categoría:** MARKETING
**Idioma:** `es_AR`

**Cuerpo:**
```
Hola {{1}}, soy {{2}} de {{3}}. Me quedó anotado que buscabas {{4}}. ¿Sigue en pie o ya lo resolviste? Si sigue, te muestro lo que tenemos hoy.
```

**Variables:** `{{1}}` nombre del lead · `{{2}}` asesor · `{{3}}` negocio · `{{4}}` lo que buscaba, en las palabras del lead

**Renderizado:**
> Hola Sofía, soy Franco de Raíces Inmobiliaria. Me quedó anotado que buscabas un 3 ambientes con cochera en Cerro de las Rosas. ¿Sigue en pie o ya lo resolviste? Si sigue, te muestro lo que tenemos hoy.

**Rubro:** los tres · **Caso:** recontacto con memoria del lead
**Riesgo de rechazo: BAJO.** Es lo contrario del texto genérico: demuestra que hay un historial real. Es la que mejor responde a la objeción de Meta de "texto genérico sin contexto".

**Es el reemplazo estructural de `mensajeRecontactoIA()`.** La IA no puede escribir texto nuevo fuera de la ventana porque nada estaría aprobado — pero **sí puede llenar `{{4}}`** desde la memoria del lead, que es donde estaba el 80% del valor. La plantilla queda fija, el dato se personaliza.

---

## A12 · `novedades_semana_01`

**Categoría:** MARKETING
**Idioma:** `es_AR`

**Cuerpo:**
```
Hola {{1}}, soy {{2}} de {{3}}. Esta semana entraron opciones nuevas parecidas a lo que estabas mirando. Si querés que te pase el listado, respondeme por acá y te lo mando.
```

**Variables:** `{{1}}` nombre del lead · `{{2}}` asesor · `{{3}}` negocio

**Renderizado:**
> Hola Carolina, soy Nadia de Anton Bienes Raíces. Esta semana entraron opciones nuevas parecidas a lo que estabas mirando. Si querés que te pase el listado, respondeme por acá y te lo mando.

**Rubro:** los tres · **Caso:** oportunidad (broadcast)
**Riesgo de rechazo: MEDIO.** Es la más genérica del catálogo y ahí está el riesgo: "opciones nuevas" sin decir cuáles roza lo que Meta rechaza por falta de contexto. Se salva por "parecidas a lo que estabas mirando", que implica historial.

**Preferir A7 siempre que se pueda decir qué entró.** Esta es para cuando la campaña va a un grupo grande y no hay un dato único que sirva para todos.

---

# BLOQUE B — INMOBILIARIA (5)

---

## B1 · `inmo_propiedad_nueva_zona_01`

**Categoría:** MARKETING
**Idioma:** `es_AR`

**Cuerpo:**
```
Hola {{1}}, soy {{2}} de {{3}}. Entró una propiedad en {{4}} que se parece bastante a lo que estabas buscando. Te la paso si querés verla.
```

**Variables:** `{{1}}` nombre del lead · `{{2}}` asesor · `{{3}}` negocio · `{{4}}` barrio o zona

**Renderizado:**
> Hola Damián, soy Nadia de Anton Bienes Raíces. Entró una propiedad en Villa Allende que se parece bastante a lo que estabas buscando. Te la paso si querés verla.

**Rubro:** inmobiliaria · **Caso:** oportunidad
**Riesgo de rechazo: BAJO.** Corta, con contexto de zona, sin oferta.

---

## B2 · `inmo_seguis_buscando_alquiler_01`

**Categoría:** MARKETING
**Idioma:** `es_AR`

**Cuerpo:**
```
Hola {{1}}, soy {{2}} de {{3}}. Nos consultaste por un alquiler en {{4}} y no llegamos a cerrar nada. ¿Seguís buscando? Ahora tenemos unidades disponibles.
```

**Variables:** `{{1}}` nombre del lead · `{{2}}` asesor · `{{3}}` negocio · `{{4}}` zona consultada

**Renderizado:**
> Hola Lucía, soy Franco de Raíces Inmobiliaria. Nos consultaste por un alquiler en Güemes y no llegamos a cerrar nada. ¿Seguís buscando? Ahora tenemos unidades disponibles.

**Rubro:** inmobiliaria · **Caso:** recontacto
**Riesgo de rechazo: BAJO.** El mercado de alquiler rota rápido, así que "ahora tenemos disponibles" es creíble y verificable.

---

## B3 · `inmo_visita_no_concretada_01`

**Categoría:** **UTILITY** (pedir UTILITY) — hay una gestión concreta ya acordada con el lead: una visita que se iba a coordinar. Tiene chance.
🔴 **Aviso de reclasificación: MEDIO-ALTO.** Meta tiende a leer "propiedad" y "visita" como venta. Si vuelve MARKETING, no pasa nada grave — solo que cuesta.
**Idioma:** `es_AR`

**Cuerpo:**
```
Hola {{1}}, soy {{2}} de {{3}}. Habíamos quedado en coordinar una visita a {{4}} y no llegamos a fijar el día. ¿Te sigue interesando verla? Decime qué día te queda cómodo.
```

**Variables:** `{{1}}` nombre del lead · `{{2}}` asesor · `{{3}}` negocio · `{{4}}` la propiedad

**Renderizado:**
> Hola Verónica, soy Franco de Raíces Inmobiliaria. Habíamos quedado en coordinar una visita a la casa de Argüello y no llegamos a fijar el día. ¿Te sigue interesando verla? Decime qué día te queda cómodo.

**Rubro:** inmobiliaria · **Caso:** recontacto de una gestión concreta abierta
**Riesgo de rechazo: BAJO.**
🔴 **Solo si la visita se habló de verdad.** Igual que A9: la mentira a escala es lo que rompe el número.

---

## B4 · `inmo_tasacion_pendiente_01`

**Categoría:** MARKETING — ofrece un servicio (tasación).
**Idioma:** `es_AR`

**Cuerpo:**
```
Hola {{1}}, soy {{2}} de {{3}}. Nos habías escrito para tasar tu propiedad en {{4}}. Si todavía la querés vender o alquilar, te paso una tasación actualizada sin cargo.
```

**Variables:** `{{1}}` nombre del lead · `{{2}}` asesor · `{{3}}` negocio · `{{4}}` zona de la propiedad

**Renderizado:**
> Hola Roberto, soy Nadia de Anton Bienes Raíces. Nos habías escrito para tasar tu propiedad en Alta Gracia. Si todavía la querés vender o alquilar, te paso una tasación actualizada sin cargo.

**Rubro:** inmobiliaria · **Caso:** recontacto de leads propietarios (los que quieren vender, no comprar)
**Riesgo de rechazo: BAJO-MEDIO.** "Sin cargo" es una oferta, y Meta mira las ofertas. Se sostiene porque es cierto y no exagera. Si preocupa, sacar "sin cargo" y queda en riesgo bajo.

**Es el único del catálogo apuntado al lado de la oferta.** Vale la pena tenerla: un propietario reactivado vale mucho más que un comprador.

---

## B5 · `inmo_financiacion_disponible_01`

**Categoría:** MARKETING
**Idioma:** `es_AR`

**Cuerpo:**
```
Hola {{1}}, soy {{2}} de {{3}}. Sumamos opciones de financiación para comprar en {{4}}. Si en su momento el tema pasaba por ahí, capaz ahora te cierre. ¿Querés que te cuente cómo funciona?
```

**Variables:** `{{1}}` nombre del lead · `{{2}}` asesor · `{{3}}` negocio · `{{4}}` zona o tipo de propiedad

**Renderizado:**
> Hola Carolina, soy Franco de Raíces Inmobiliaria. Sumamos opciones de financiación para comprar en Nueva Córdoba. Si en su momento el tema pasaba por ahí, capaz ahora te cierre. ¿Querés que te cuente cómo funciona?

**Rubro:** inmobiliaria · **Caso:** oportunidad — reactivar al que se cayó por plata
**Riesgo de rechazo: MEDIO.** Todo lo que huele a crédito recibe más escrutinio de Meta. Se sostiene porque **no promete aprobación, ni tasa, ni monto** — solo dice que existen opciones. 🔴 **No agregar tasas ni cuotas al cuerpo.** Eso sí es rechazo.

---

# BLOQUE C — HOTEL / CABAÑAS (5)

---

## C1 · `hotel_disponibilidad_fechas_01`

**Categoría:** MARKETING — aviso de disponibilidad = aviso comercial. Aunque el lead haya pedido "avisame si se libera", sin reserva abierta Meta lo lee como marketing.
**Idioma:** `es_AR`

**Cuerpo:**
```
Hola {{1}}, te escribe {{2}} de {{3}}. Se liberaron lugares para {{4}}, que eran las fechas que habías consultado. Si te sirve, avisame y te lo dejo reservado.
```

**Variables:** `{{1}}` nombre del lead · `{{2}}` asesor · `{{3}}` negocio · `{{4}}` las fechas

**Renderizado:**
> Hola Sofía, te escribe Andrea de Hostería Tequendama. Se liberaron lugares para el 12 al 15 de octubre, que eran las fechas que habías consultado. Si te sirve, avisame y te lo dejo reservado.

**Rubro:** hotel · **Caso:** oportunidad — disponibilidad de fechas
**Riesgo de rechazo: BAJO.** Referencia una consulta concreta y da un dato útil.

**Es la mejor plantilla de hotel del catálogo.** Responde a algo que el lead pidió; la tasa de respuesta debería ser alta y el riesgo de reporte, mínimo.

---

## C2 · `hotel_seguis_pensando_escapada_01`

**Categoría:** MARKETING
**Idioma:** `es_AR`

**Cuerpo:**
```
Hola {{1}}, soy {{2}} de {{3}}. Consultaste por una estadía y quedó ahí. ¿Seguís con la idea de venir? Contame las fechas y cuántos son y te veo disponibilidad.
```

**Variables:** `{{1}}` nombre del lead · `{{2}}` asesor · `{{3}}` negocio

**Renderizado:**
> Hola Damián, soy Andrea de Hostería Tequendama. Consultaste por una estadía y quedó ahí. ¿Seguís con la idea de venir? Contame las fechas y cuántos son y te veo disponibilidad.

**Rubro:** hotel · **Caso:** recontacto suave
**Riesgo de rechazo: BAJO.**

⚠️ **Usar solo con leads SIN fecha de ingreso cargada.** Al que ya tiene fecha no se le pregunta la fecha — queda como que no le prestaste atención. Para ese caso va C3. El motor ya distingue los dos casos (`seguimiento_sin_fecha` / `seguimiento_con_fecha`); el mapa de plantillas Cloud tiene que respetar la misma distinción.

---

## C3 · `hotel_reserva_sin_confirmar_01`

**Categoría:** **UTILITY** (pedir UTILITY) — hay una reserva concreta iniciada y sin confirmar. **Es la que más chance tiene de quedar UTILITY de todo el catálogo:** es gestión de una transacción existente, no captación.
🔴 **Aviso de reclasificación: BAJO.**
**Idioma:** `es_AR`

**Cuerpo:**
```
Hola {{1}}, soy {{2}} de {{3}}. Te tengo anotado para {{4}} pero la reserva quedó sin confirmar. ¿La dejo tomada o la libero? Avisame así no perdés el lugar.
```

**Variables:** `{{1}}` nombre del lead · `{{2}}` asesor · `{{3}}` negocio · `{{4}}` las fechas anotadas

**Renderizado:**
> Hola Lucía, soy Andrea de Hostería Tequendama. Te tengo anotado para el 3 al 6 de noviembre pero la reserva quedó sin confirmar. ¿La dejo tomada o la libero? Avisame así no perdés el lugar.

**Rubro:** hotel · **Caso:** recontacto de reserva abierta
**Riesgo de rechazo: BAJO.**
🔴 **Solo si la reserva existe.** Es literalmente un dato operativo; inventarlo es peor que en cualquier otra plantilla del catálogo.

---

## C4 · `hotel_tarifa_actualizada_01`

**Categoría:** MARKETING
**Idioma:** `es_AR`

**Cuerpo:**
```
Hola {{1}}, soy {{2}} de {{3}}. Ajustamos la tarifa para {{4}} y quedó mejor que cuando consultaste. Te aviso por si querés aprovechar esas fechas.
```

**Variables:** `{{1}}` nombre del lead · `{{2}}` asesor · `{{3}}` negocio · `{{4}}` período o temporada

**Renderizado:**
> Hola Roberto, soy Andrea de Hostería Tequendama. Ajustamos la tarifa para la segunda quincena de marzo y quedó mejor que cuando consultaste. Te aviso por si querés aprovechar esas fechas.

**Rubro:** hotel · **Caso:** oportunidad — baja de precio
**Riesgo de rechazo: BAJO-MEDIO.** "Quedó mejor que cuando consultaste" es un comparativo. Es verificable y no exagera, pero es lo que un revisor mira. Si Meta la rechaza, la salida es poner el número: "quedó en $ X la noche".

---

## C5 · `hotel_fin_de_semana_largo_01`

**Categoría:** MARKETING
**Idioma:** `es_AR`

**Cuerpo:**
```
Hola {{1}}, soy {{2}} de {{3}}. Nos quedan lugares para el fin de semana largo de {{4}}. Te aviso porque en esas fechas se ocupa rápido. Si te interesa, avisame y lo vemos.
```

**Variables:** `{{1}}` nombre del lead · `{{2}}` asesor · `{{3}}` negocio · `{{4}}` cuál feriado

**Renderizado:**
> Hola Carolina, soy Andrea de Hostería Tequendama. Nos quedan lugares para el fin de semana largo de octubre. Te aviso porque en esas fechas se ocupa rápido. Si te interesa, avisame y lo vemos.

**Rubro:** hotel · **Caso:** oportunidad estacional
**Riesgo de rechazo: MEDIO.** "Se ocupa rápido" es urgencia, y la urgencia es una de las cosas que Meta marca como spam. Está redactada lo más contenida posible ("te aviso porque", no "¡últimos lugares!"). Si la rechazan, sacar esa frase y queda en riesgo bajo.

---

# BLOQUE D — DESARROLLADORA (4)

---

## D1 · `desarrolladora_avance_obra_01`

**Categoría:** MARKETING — es una novedad comercial del proyecto.
**Idioma:** `es_AR`

**Cuerpo:**
```
Hola {{1}}, soy {{2}} de {{3}}. Te cuento cómo viene {{4}}: la obra avanzó y ya está en {{5}}. Si querés te paso fotos actualizadas y cómo quedaron los valores.
```

**Variables:** `{{1}}` nombre del lead · `{{2}}` asesor · `{{3}}` negocio · `{{4}}` nombre del emprendimiento · `{{5}}` etapa de obra

**Renderizado:**
> Hola Marcelo, soy Julián de Lozano Desarrollos. Te cuento cómo viene Altos del Sur: la obra avanzó y ya está en etapa de terminaciones. Si querés te paso fotos actualizadas y cómo quedaron los valores.

**Rubro:** desarrolladora · **Caso:** oportunidad — avance de obra
**Riesgo de rechazo: BAJO.** Informa un hecho concreto y verificable. Es exactamente el tipo de plantilla que Meta aprueba sin discutir.

⭐ **La candidata número uno a header con imagen** cuando se construya. Una foto de la obra hace el 90% del trabajo de esta plantilla. Hoy no se puede: el código solo arma `components: [{ type: 'body' }]`.

---

## D2 · `desarrolladora_unidades_disponibles_01`

**Categoría:** MARKETING
**Idioma:** `es_AR`

**Cuerpo:**
```
Hola {{1}}, soy {{2}} de {{3}}. Habías consultado por {{4}} y quedan pocas unidades en esa tipología. Si seguís interesado, te paso el listado y los valores de hoy.
```

**Variables:** `{{1}}` nombre del lead · `{{2}}` asesor · `{{3}}` negocio · `{{4}}` emprendimiento o tipología

**Renderizado:**
> Hola Verónica, soy Julián de Lozano Desarrollos. Habías consultado por los lotes de 600 m² y quedan pocas unidades en esa tipología. Si seguís interesado, te paso el listado y los valores de hoy.

**Rubro:** desarrolladora · **Caso:** recontacto / oportunidad
**Riesgo de rechazo: BAJO-MEDIO.** "Quedan pocas" es escasez, primo hermano de la urgencia. 🔴 **Solo mandarla si es verdad** — si el lead consulta y hay 40 unidades, la que pierde es la marca, y con ella el número.

---

## D3 · `desarrolladora_nueva_etapa_01`

**Categoría:** MARKETING
**Idioma:** `es_AR`

**Cuerpo:**
```
Hola {{1}}, soy {{2}} de {{3}}. Abrimos una etapa nueva en {{4}}, con lotes que antes no estaban disponibles. Si te interesa, te mando el plano y la lista de precios.
```

**Variables:** `{{1}}` nombre del lead · `{{2}}` asesor · `{{3}}` negocio · `{{4}}` emprendimiento

**Renderizado:**
> Hola Damián, soy Julián de Lozano Desarrollos. Abrimos una etapa nueva en Altos del Sur, con lotes que antes no estaban disponibles. Si te interesa, te mando el plano y la lista de precios.

**Rubro:** desarrolladora · **Caso:** oportunidad — lanzamiento
**Riesgo de rechazo: BAJO.** Hecho concreto, sin promesas.

⭐ **También gana mucho con header (documento/imagen del plano)** cuando se pueda.

---

## D4 · `desarrolladora_lista_precios_nueva_01`

**Categoría:** MARKETING
**Idioma:** `es_AR`

**Cuerpo:**
```
Hola {{1}}, soy {{2}} de {{3}}. Actualizamos la lista de precios de {{4}}. Te la paso por si querés comparar con lo que habías visto. Escribime y te la mando.
```

**Variables:** `{{1}}` nombre del lead · `{{2}}` asesor · `{{3}}` negocio · `{{4}}` emprendimiento

**Renderizado:**
> Hola Roberto, soy Julián de Lozano Desarrollos. Actualizamos la lista de precios de Altos del Sur. Te la paso por si querés comparar con lo que habías visto. Escribime y te la mando.

**Rubro:** desarrolladora · **Caso:** recontacto / oportunidad
**Riesgo de rechazo: BAJO.** No dice si subió o bajó, así que no promete nada. En Argentina la lista se actualiza seguido, así que sirve todo el año y es cierta siempre.

---

# 2. Tabla resumen

| # | Nombre | Cat. | Vars | Rubro | Caso | Riesgo |
|---|---|---|---|---|---|---|
| A1 | `recontacto_suave_01` | MKT | 3 | los 3 | recontacto | bajo |
| A2 | `recontacto_charla_cortada_01` | MKT | 3 | los 3 | recontacto | bajo |
| A3 | `recontacto_sigue_buscando_02` | MKT | 3 | los 3 | recontacto | bajo |
| A4 | `derivar_a_whatsapp_comercial_01` ⭐ | MKT | 4 | los 3 | derivación | **medio** |
| A5 | `derivar_a_whatsapp_comercial_02` | MKT | 4 | los 3 | derivación | **medio** |
| A6 | `reactivacion_cliente_viejo_01` | MKT | 3 | los 3 | reactivación | bajo |
| A7 | `novedad_encaja_con_busqueda_01` | MKT | 4 | los 3 | oportunidad | bajo-medio |
| A8 | `baja_de_precio_01` | MKT | 5 | los 3 | oportunidad | bajo |
| A9 | `respuesta_pendiente_01` | **UTIL** | 4 | los 3 | recontacto | bajo |
| A10 | `confirmar_si_sigue_interesado_cierre_01` | MKT | 3 | los 3 | cierre | bajo |
| A11 | `retomar_con_dato_concreto_01` | MKT | 4 | los 3 | recontacto | bajo |
| A12 | `novedades_semana_01` | MKT | 3 | los 3 | oportunidad | **medio** |
| B1 | `inmo_propiedad_nueva_zona_01` | MKT | 4 | inmo | oportunidad | bajo |
| B2 | `inmo_seguis_buscando_alquiler_01` | MKT | 4 | inmo | recontacto | bajo |
| B3 | `inmo_visita_no_concretada_01` | **UTIL** | 4 | inmo | recontacto | bajo |
| B4 | `inmo_tasacion_pendiente_01` | MKT | 4 | inmo | recontacto | bajo-medio |
| B5 | `inmo_financiacion_disponible_01` | MKT | 4 | inmo | oportunidad | **medio** |
| C1 | `hotel_disponibilidad_fechas_01` ⭐ | MKT | 4 | hotel | oportunidad | bajo |
| C2 | `hotel_seguis_pensando_escapada_01` | MKT | 3 | hotel | recontacto | bajo |
| C3 | `hotel_reserva_sin_confirmar_01` | **UTIL** | 4 | hotel | recontacto | bajo |
| C4 | `hotel_tarifa_actualizada_01` | MKT | 4 | hotel | oportunidad | bajo-medio |
| C5 | `hotel_fin_de_semana_largo_01` | MKT | 4 | hotel | oportunidad | **medio** |
| D1 | `desarrolladora_avance_obra_01` ⭐ | MKT | 5 | desarr. | oportunidad | bajo |
| D2 | `desarrolladora_unidades_disponibles_01` | MKT | 4 | desarr. | oportunidad | bajo-medio |
| D3 | `desarrolladora_nueva_etapa_01` | MKT | 4 | desarr. | oportunidad | bajo |
| D4 | `desarrolladora_lista_precios_nueva_01` | MKT | 4 | desarr. | oportunidad | bajo |

**26 plantillas. 23 MARKETING, 3 pedidas como UTILITY** (A9, B3, C3 — y de esas tres, la que más chance real tiene es **C3**).

---

# 3. Si Diego quiere aprobar pocas: el orden

**Las 4 mínimas para arrancar** (cubren primer toque + rotación + cierre):
1. `recontacto_suave_01` (A1)
2. `recontacto_sigue_buscando_02` (A3)
3. `retomar_con_dato_concreto_01` (A11)
4. `confirmar_si_sigue_interesado_cierre_01` (A10)

**+1 si se va a probar el caso de Diego:** `derivar_a_whatsapp_comercial_01` (A4).

**+1 por rubro, la que mejor rinde:** inmobiliaria `baja_de_precio_01` (A8) · hotel `hotel_disponibilidad_fechas_01` (C1) · desarrolladora `desarrolladora_avance_obra_01` (D1).

Cada plantilla nace en `PENDING` y la aprueba Meta (de minutos a horas). Mandar las 4 primeras juntas y esperar.

---

# 4. Cuáles convendrían con header o botón (para cuando el código lo soporte)

Hoy **no se puede**: `enviarPlantillaCloud` (`server.js:42296-42311`) arma solo `components: [{ type: 'body' }]`. Nada de HEADER, nada de BUTTONS. Todas las de arriba están diseñadas para funcionar sin eso. Pero estas ganarían mucho:

| Plantilla | Qué le falta | Por qué importa |
|---|---|---|
| `desarrolladora_avance_obra_01` (D1) | **Header imagen** | Una foto de obra vale más que el texto entero |
| `desarrolladora_nueva_etapa_01` (D3) | **Header documento** | El plano es el producto |
| `novedad_encaja_con_busqueda_01` (A7) | **Header imagen** | La foto de la propiedad es lo que dispara la respuesta |
| `baja_de_precio_01` (A8) | **Header imagen** | Idem |
| `hotel_disponibilidad_fechas_01` (C1) | **Botón de respuesta rápida** ("Me interesa" / "Ahora no") | Sube la tasa de respuesta y **abre la ventana de 24 h de un toque**, que es donde todo pasa a ser gratis |
| `confirmar_si_sigue_interesado_cierre_01` (A10) | **Dos botones** ("Sigo" / "Cerrala") | Convierte una decisión en un tap |
| `derivar_a_whatsapp_comercial_01` (A4) | **Botón de llamada** con el número comercial | Es el caso de uso exacto del botón CALL_PHONE_NUMBER de Meta |

🔴 El de mayor retorno es el **botón de respuesta rápida**: cada tap abre la ventana de 24 h y ahí la conversación deja de costar. Es la mejora que más plata ahorra, no la de la imagen.

---

# 5. Lo que NO se puede escribir en ninguna (chequeo antes de mandar a aprobar)

- ❌ `wa.me/...` en cualquier forma. Rechazo.
- ❌ Acortadores: `bit.ly`, `t.co`, `cutt.ly`, etc. Rechazo.
- ✅ Link con **dominio propio completo**: `raicescrm.com/propiedad/1234`. Permitido.
- ✅ **Número de teléfono escrito**: `+54 9 351 234-5678`. Permitido.
- ❌ MAYÚSCULAS SOSTENIDAS, `!!!`, `🔥🔥`.
- ❌ Promesas: "el mejor precio del mercado", "garantizado", "no lo vas a encontrar más barato".
- ❌ Urgencia inventada: "últimas horas", "solo por hoy".
- ❌ Texto genérico sin contexto: "Hola, ¿cómo estás? Tenemos novedades." — sin referencia a por qué le escribís, Meta rechaza.
- ❌ Variables al principio o al final del cuerpo, o dos pegadas.
- ❌ Cuerpo de más de **1024 caracteres** (el propio backend lo corta antes, `server.js:43313`).

---

# 6. Gotchas de implementación — verificados hoy en el código

Esto es para quien construya E1/E2/E3, no para Diego. Todo leído en `server.js`, no inferido.

**1. 🔴 Los parámetros vacíos se FILTRAN y corren las posiciones.**
`server.js:42303`:
```js
const params = Array.isArray(parametros) ? parametros.filter(function(p){ return p != null && String(p) !== ''; }) : [];
```
Si `{{2}}` viene vacío, **`{{3}}` se renderiza en el lugar de `{{2}}`**. El lead recibe un mensaje con los datos corridos y no hay ningún error: Meta acepta y cobra. Consecuencia de diseño: **ninguna plantilla del catálogo puede tener una variable opcional.** Si un dato puede faltar, no va como variable. Por eso `{{1}}` `{{2}}` `{{3}}` son siempre nombre/asesor/negocio, que siempre existen — y si `contacts.name` está vacío hay que resolverlo **antes** (fallback al teléfono o saltear el lead), nunca mandar `''`.

**2. El idioma por defecto NO es `es_AR`.**
`server.js:42300`: `language: { code: String(idioma || 'es') }`. Si el resolver no pasa idioma, sale `'es'` y Meta responde 132001 (la plantilla existe en `es_AR`, no en `es`). **Pasar `es_AR` siempre, explícito.**

**3. Meta pide un ejemplo por cada variable, o rechaza con un código que miente.**
`server.js:43318-43326`: el backend cuenta las variables antes de llamar a Meta justamente porque el error real (132000, "la plantilla no existe o no está aprobada") manda a buscar el problema al lugar equivocado. Al crear cada plantilla hay que cargar los ejemplos — sirven los renderizados de este documento.

**4. La categoría que se guarda es la de Meta, no la que pediste.**
`server.js:43356-43360`. Después de crear una UTILITY hay que **mirar el panel**: si volvió MARKETING, esa plantilla ahora cuesta plata y el cálculo de costo de la campaña cambia.

**5. Los parámetros no pueden llevar saltos de línea ni tabs.** Meta los rechaza. Sanitizar `contacto.name` y todo lo que cargue el dueño en `{{4}}`/`{{5}}` antes de enviar.

**6. `enviarPlantillaCloud` no actualiza `messages.estado_envio`.** Devuelve `{ok, id}` y nada más — a diferencia de `enviarWhatsapp`, que actualiza desde adentro. Sin adaptador, **todo recontacto por Cloud queda en `'enviando'` para siempre**. Es el riesgo #3 del plan y sigue sin resolverse.

**7. Una plantilla es UN mensaje indivisible.** `enviarWhatsapp` parte los mensajes largos; Cloud no. El texto renderizado que se guarde en `messages`/`recontactos` tiene que ser el cuerpo completo, o el dedupe anti-repetición (`_recontactoYaEnviados`, que compara contra `recontactos.mensaje`) deja de funcionar.

**8. El nombre se normaliza solo.** `_cloudApiNombrePlantilla` (`server.js:42858`) baja a minúsculas, saca tildes y reemplaza todo lo que no sea `[a-z0-9_]`. Los nombres de este catálogo ya están normalizados: pasan sin cambios.

---

# 7. Lo que NO verifiqué

- **El precio de Meta.** Los USD 0,06/mensaje MARKETING para Argentina vienen de research de julio 2026 y **no los reverifiqué**. Todo el cálculo de costo cuelga de ese número.
- **Si Meta aprueba cada una de estas 26.** Los riesgos que puse son criterio, no respuesta de Meta. La única forma de saberlo es mandarlas y ver. Crear una plantilla no cuesta plata — solo enviarla.
- **Si las 3 UTILITY quedan UTILITY.** Meta reclasifica y no avisa por qué.
- **No creé ninguna plantilla, no toqué `server.js`, no toqué ningún otro archivo, no hice commit.** Este documento es lo único que se escribió.
