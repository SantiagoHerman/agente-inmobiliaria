# PLAN — Derivación unificada: que v2 y v3 convivan sin cruzarse

Acordado con Diego el 2026-08-03/04. **Este documento manda.** Si algo de acá hay que
cambiarlo durante la ejecución, se le avisa ANTES de tocarlo.

---

## 1. El problema que resuelve

Hoy hay **dos implementaciones de "derivar"** que se escribieron en momentos distintos y
se fueron separando:

- **v2** (dentro de `derivarAHumano`): decide a qué área y a qué persona. Tiene la
  escalera al departamento de fallback y avisa al instante cuando se queda sin salida.
  Deja el lead en `listo_humano` con la IA apagada.
- **v3** (`iniciarRotacionDerivacionV3`): se dispara cuando la IA usa su herramienta.
  Tiene el reloj que reasigna cada 10 min. Deja el lead en `interesado` con la IA prendida.

**Cuál corre no depende de la cuenta: depende de qué disparó la derivación.** La misma
cuenta, el mismo día, tiene dos comportamientos distintos. Eso es lo que hay que terminar.

Las dos están ENCENDIDAS SIEMPRE hoy: `repartoV2Activo` devuelve `true` fijo (decisión de
Diego, julio 2026) y `derivacionV3Activo` devuelve `true` salvo cuenta congelada.

---

## 2. El reparto de responsabilidades (la regla de oro)

> **La v2 decide A QUIÉN. La v3 decide QUÉ PASA DESPUÉS.**
> Ninguna de las dos hace lo de la otra. No se pisan porque no se superponen.

- **v2 = el criterio.** Área, persona, escalera, horarios, avisos. **Único dueño.**
- **v3 = el reloj.** Ofrecer, esperar, volver a ofrecer, frenar. **No elige a nadie:
  le pregunta a la v2.**

---

## 3. Las reglas que definió Diego

### 3.1. Antes de prometer, derivar
La IA **primero deriva y después habla**, y dice **lo que realmente pasó**. Hoy es al revés
(promete y después intenta) y por eso el lead espera algo que nunca ocurrió — caso Cris.

### 3.2. No se deriva hasta que el lead califique
La herramienta de derivar **no está disponible** hasta que el lead haya escrito lo suficiente.
Si no califica, la IA sigue conversando y **no promete nada, porque no puede**.

Hoy el freno existe (`_MIN_MSGS_LEAD_INTERESADO = 3`) pero **solo bloquea el pase a
'interesado' del clasificador**: la herramienta de derivar se lo saltea entero.

### 3.3. Analizar ANTES de prometer
Antes de decir una palabra, resolver dos cosas:
1. **A qué departamento** va.
2. **Si hay alguien disponible AHORA** en ese departamento.

### 3.4. Si no hay nadie ahora: no se ofrece, se espera
- **NO se le ofrece a nadie.** (Esto solo ya mata el caso Benjamín.)
- Se calcula **cuándo entra el próximo** y se deja el reloj armado para ese momento.
- La IA le dice al lead la verdad, con la hora real:
  *"Te derivo al departamento de Ventas a partir del lunes a las 9."*
- Llegado el momento, **la derivación arranca sola**.

### 3.5. Si no se puede calcular la hora: no se inventa
La IA **no promete una hora**. Dice que lo va a hacer atender, sin comprometer un momento,
y **se avisa al dueño al instante**: significa que ese departamento tiene un problema de
configuración.

### 3.6. Rotar es OFRECER, no asignar
- Mientras rota, el lead está en **`interesado` con la IA cubriendo**. Nadie se lo quedó.
- **Se lo queda quien escribe** → `listo_humano` + IA apagada.
- Vale igual para rotación y para directo: cambia a cuántos se le ofrece, no el estado.

### 3.7. Predomina la v2
En la resolución del área manda el criterio de la v2. El "hint" de la IA (el nombre del área
que dice al derivar) entra como **una fuente más**, no como un camino aparte.

### 3.8. El reparto general deja de ser un pozo
Tiene que **mirar horarios y departamentos**, igual que el reparto por área.

### 3.9. Los usuarios IA: últimos, y solo si tienen departamento
Orden de prioridad, sin excepciones:
1. **Humanos del departamento**, disponibles y en horario, por orden
2. Si no hay → **la escalera**: el departamento que recibe el fallback
3. Si tampoco → **usuario IA, SOLO si pertenece a un departamento**
4. Si tampoco → **nadie**, y aviso al instante

Con esta regla **Nicolás nunca hubiera entrado**: no tenía departamento. Y aunque lo tuviera,
va después de todos los humanos, sin importar que su carga sea cero.

### 3.10. La escalera aplica siempre
Venga la derivación de donde venga.

### 3.11. Los avisos: dos, y ninguno mira el horario
- **Al instante**: no hay a quién derivar (sin salida) o no se pudo calcular la hora.
- **A los 30 minutos**: SÍ hay gente, sigue rotando y nadie lo toma. No es "no hay nadie",
  es "hace media hora que doy vueltas".

### 3.12. El reloj tiene freno
- Cada **10 min** se le ofrece al siguiente del área.
- Al completar **una vuelta entera** (todos los del área, una vez) sin que nadie lo tome →
  **aplica la escalera** y sigue ofreciendo en el departamento de fallback.
- Al completar la vuelta también en el fallback → **se frena**, avisa al instante, y el lead
  **queda con la IA cubriendo** (no dando vueltas).
- **Nunca más vueltas infinitas, y nunca en silencio.**

### 3.13. La asignación fija queda como está
No rota: se queda con esa persona y la IA cubre hasta que escriba. Confirmado por Diego:
*"está bien como pasa a fija, así el lead nunca queda solo."*

### 3.14. La IA tiene que entender a dónde puede derivar
La interpretación del área **lo es todo**: si la IA elige mal, todo lo demás da igual.

**Lo que YA funciona:** la IA recibe en el prompt la lista de áreas de esa cuenta con el
nombre y el criterio que el dueño escribió (`server.js` ~7842-7850: *"son las únicas válidas,
pasá el nombre EXACTO"*). Y se lee **en vivo** en cada derivación: si el dueño crea o edita un
área hoy, la IA la usa en el mensaje siguiente. **La adaptación a los cambios ya existe.**

**Lo que falta — control de calidad de la configuración.** Cuando el dueño crea o edita un
área, la IA revisa TODAS las áreas de la cuenta y avisa si:
- **No entiende para qué sirve**: descripción vacía, muy corta, o que no dice cuándo mandar
  un lead ahí. Pide que la aclare.
- **Se pisa con otra**: y **dice con cuál**, explicando el solapamiento concreto.

**No bloquea.** Avisa y el dueño decide. Si lo deja igual, sigue funcionando como hoy.

**CÓMO SE VE (Diego 2026-08-04): un semáforo por área, no un mensaje que se pierde.**
Cada departamento tiene un indicador al lado de su descripción:
- **Tilde verde** — la descripción alcanza para rutear. Todo OK.
- **Cruz roja** — hay problema, y al lado dice cuál: **se cruza con tal área** (nombrándola)
  o **falta información**.

Detalles de implementación acordados:
- **El resultado SE GUARDA** (columna nueva en `departamentos`). Se recalcula **solo al
  modificar un área**, no en cada carga de la pantalla: si no, cada visita a Configuración
  costaría IA al pedo.
- **Si dos áreas se pisan, las DOS quedan en rojo.** El cruce es entre dos y el dueño tiene
  que poder arreglar cualquiera; marcar solo la última editada escondería la mitad del
  problema.
- Un botón "revisar mis áreas" para recalcular todo junto cuando el dueño quiera.

**Costo IA:** una llamada por guardado de área. Prompt chico, frecuencia muy baja — centavos
por mes. Es gasto NUEVO y por eso queda anotado.

### 3.15. El área la define el TEMA, no la disponibilidad
La IA elige el área **por lo que el lead necesita**, no por quién está de guardia. Si el lead
pregunta por un alquiler, va a Alquileres **aunque esté cerrado** — y ahí entra el reloj de la
regla 3.4 que le dice "a partir del lunes a las 9". Mandarlo a Ventas porque Alquileres está
cerrado sería peor.

La disponibilidad la resuelve el CÓDIGO después, sin la IA.

### 3.16. La asignación tiene que ser pareja
Con departamento y sin departamento. Hoy no lo es: el medidor de carga cuenta solo los
`listo_humano`, así que los leads ofrecidos (que están en `interesado`) son invisibles, y un
usuario IA —que nunca llega a `listo_humano`— tiene carga cero para siempre.

---

## 4. Lo que YA está construido y desplegado

**`proximoTurnoDisponible(ownerId, deptoId)`** — contesta "¿cuándo entra el próximo?".
Barre hasta 7 días, respeta el horario de cada persona, devuelve día y hora completos más
el nombre. **Ante cualquier duda devuelve null (no inventa una hora).** Está arriba y no la
llama nadie: solo falta enchufarla.

**`GET /api/diagnostico/salud-derivacion`** — dice, por cuenta, si puede derivar y qué leads
están trabados. Desplegada, sin enchufar al Maestro.

---

## 5. Las fases

Cada fase se despliega sola, con su flag, y se revierte sola.

### Fase 1 — La v3 deja de elegir a quién
Se le saca a `iniciarRotacionDerivacionV3` toda la lógica de elección y le pregunta a la v2.

**Qué arregla:** desaparece el reparto general con sus agujeros (de ahí salieron Nicolás y el
rebote de Benjamín). Un solo criterio de "a quién".
**Riesgo:** bajo. Toca una función que llama **un solo lugar** (la herramienta de la IA).
**Revertir:** apagar el flag.

### Fase 2 — Analizar antes de prometer
Antes de derivar: resolver área + preguntar si hay alguien ahora (`proximoTurnoDisponible`).
Si no hay: no ofrecer, armar el reloj para la hora real, y que la IA diga esa hora.
Si no se puede calcular: no prometer hora + aviso al instante.

**Qué arregla:** el caso Benjamín y el caso Cris, de raíz.
**Riesgo:** medio. Toca el camino de la herramienta de la IA y el texto que ve el lead.

### Fase 3 — El freno del reloj
Tope de vueltas **configurable por cuenta** (NO fijo en 2: un área con un solo usuario da una
vuelta de un ofrecimiento). Al agotarse → escalera → si tampoco, frenar y avisar.
Más los dos avisos sin filtro de horario.

**Qué arregla:** las vueltas infinitas y el silencio.
**Riesgo:** bajo. Toca solo el cron.

### Fase 4 — El reparto parejo
Que la carga cuente también los ofrecidos. Que los usuarios IA vayan últimos y solo con
departamento.

**Riesgo:** medio. Cambia a quién le toca, en todas las cuentas.

### Fase 4b — Control de calidad de las áreas (regla 3.14)
Al guardar un área, la IA revisa todas las de la cuenta y avisa si no entiende una descripción
o si detecta que dos se pisan (diciendo con cuál). No bloquea.

**Riesgo:** bajo. Es aditivo y no toca la derivación: solo le habla al dueño.
**Costo:** gasto de IA NUEVO (una llamada por guardado). Centavos por mes.

### Fase 5 — Mover el reloj a la v2 y borrar la v3
Con la v3 ya reducida al reloj, se lo pasa a `derivarAHumano` como opción. La herramienta de
la IA llama directo a la v2. **Un solo camino.**

**Riesgo:** el más alto (toca la función que llaman muchos lugares). Va última, cuando todo
lo anterior esté estable.

---

## 6. Lo que NO se toca

- La asignación **fija** (queda como está, decisión de Diego).
- El clasificador y su umbral de 3 mensajes para 'interesado'.
- El prompt del agente, salvo el texto de lo que promete (fase 2).
- La cuenta **Raíces Meta Test** (congelada), fuera de todos los rollouts.
- `derivarAHumano` en las fases 1 a 4. Recién se toca en la 5.

---

## 7. Decisiones de Diego (2026-08-04) — YA TOMADAS

1. **2 mensajes**, no 3. Con el segundo mensaje ya puede pasar a 'interesado' si la IA lo
   detecta. **Dato que lo respalda:** la medición sobre los 28 leads de Anton decía que 8
   tenían UN solo mensaje y que **ninguno tenía exactamente 2** — o sea que entre 2 y 3 no
   había ni un caso de diferencia. Bajar a 2 no pierde nada.

2. **NUNCA se deriva en 'conversación'. REGLA DE ORO.** Si el lead pide un humano en el primer
   mensaje, la IA **pregunta por qué motivo o a qué área**, pide información, el lead pasa a
   'interesado', y **ahí** deriva.
   - **REGLA VIEJA QUE SE SUPERPONE (investigada):** hoy `_pideHumano` hace que el clasificador
     devuelva `listo_humano` **directo y SIN departamento** (`server.js` ~9380) — se saltea
     'interesado' entero y cae al pool general. **Es otra puerta por la que entraba Nicolás.**
   - **Ya existe construido:** es el "punto 2" de la derivación v4 — preguntar el área y recién
     después rotar. 0 tokens (plantillas + SQL). No pregunta si el negocio tiene 1 sola área.
     **Se toma ESA pieza** (ver punto 8).

3. **Los tiempos son configuración por cliente**, no constantes. Los 10 min entre ofertas
   (`derivacion_espera_min`, ya configurable 1..240) y los 30 del aviso.

4. **El freno del reloj es CONFIGURABLE, no "2 vueltas".**
   ⚠️ **CORRECCIÓN:** el "freno en 2 vueltas" lo puso el asistente por su cuenta; Diego NUNCA
   lo pidió. Su objeción: *"puede ser un solo usuario y la vuelta es chica"*. Va configurable.

5. **El fallback ya tiene tiempo configurable:** `business_settings.cola_tope_min`, default
   30 min, válido 1..240. (Falta confirmar si está expuesto en la pantalla de Configuración.)

## 7b. Los cruces entre v2 y v3 — resueltos por Diego (2026-08-04)

**Cruce 1 — el estado.** → **PREVALECE LA V3.** El lead queda en `interesado` con la IA
cubriendo **hasta que el humano responda**. Consecuencia: las derivaciones que hoy van directo
a `listo_humano` (clasificador, fuera de alcance, respaldo) **también pasan a ofrecer con la
IA cubriendo**. El comportamiento único es el de la v3. Esto es, además, lo que hacía v4 con
su redirección: **v4 desaparece sin prenderse nunca.**

**Cruce 2 — el SLA.** No está mezclado con la derivación y no hay que mezclarlo:
> **El SLA es para cuando un lead YA TIENE usuario** (se lo quedó alguien y no contesta).
> **La derivación es para conseguir a ese alguien.** Son dos cosas distintas.

**CORRECCIÓN A APLICAR:** hoy el SLA filtra por `asesor_id NOT NULL AND ai_enabled = false`,
que en la práctica equivale a `listo_humano` pero **no lo chequea literalmente**. Con el modelo
nuevo esa diferencia deja de ser inofensiva (un lead OFRECIDO tiene asesor). Hay que exigir
**`status = 'listo_humano'` explícito**: el SLA solo vigila leads que alguien ya se quedó.

**Cruce 3 — no se deriva en 'conversación'.** Regla de oro (ver 3.2).

**Cruce 4 — el aviso.** A los **30 minutos con el reloj corriendo**, avisa **y pasa al
fallback**. Tiempo **configurable** (un solo campo, el que ya existe). Sin filtro de horario.

**Cruce 5 — la carga.** Dos cosas: que **cuente todos los leads abiertos** de cada persona (no
solo los `listo_humano`), y que dentro del área **todos entren por igual**, por orden, sin que
la carga los saltee.

## 7c. La escalada al fallback — cómo funciona y qué hay que cambiar

**Cómo funciona hoy (revisado en código, `escalarLeadsEnColaVencidos` ~15751):**
1. Reintenta primero el **área propia** (por si alguien volvió de la pausa)
2. Busca el departamento con **"Recibe el fallback"** tildado
3. Elige con el picker normal — **respeta horario, membresía y disponibilidad**, y tiene guard
   contra usuarios IA
4. Asigna con update condicional (no pisa si otro ya lo tomó), registra el pase como
   *"El sistema"* y **avanza el cursor** del área (mantiene el reparto parejo)
5. Si no hay nadie en el fallback → **avisa al dueño** (aviso de cola + última instancia)
6. Marca `escalado_fallback` para no repetir

**LOS TRES CAMBIOS QUE NECESITA:**
1. **Mira el estado equivocado.** Busca `listo_humano` + **sin asesor** (la cola vieja). Con el
   modelo nuevo el lead está en `interesado` **con alguien ofrecido**. No los encuentra —
   no porque falle, sino porque busca otra cosa. **Tiene que mirar la ROTACIÓN.**
2. **No corre fuera del horario de oficina.** Si el tope vence un domingo, saltea y espera al
   lunes. Contradice la regla de que los avisos no miran horario.
3. **Escala una sola vez** (marca `escalado_fallback`). Queda así, pero anotado.

## 7d. Los textos de los avisos (aprobados por Diego)

**Escala al fallback:**
> *Benjamín esperó 30 minutos en **Ventas** y nadie lo tomó. Lo pasé a **Administración**.*

**En el fallback tampoco hay nadie:**
> *Benjamín esperó 30 minutos en **Ventas** y nadie lo tomó. En **Administración** tampoco hay
> nadie disponible. Necesita que alguien lo atienda.*

**Aviso instantáneo — no hay a quién ofrecerle, pero se sabe cuándo:**
> *Benjamín necesita atención en **Ventas** y no hay nadie disponible ahora. El próximo turno
> es el **lunes a las 9**.*

**Aviso instantáneo — no se pudo calcular la hora:**
> *Benjamín necesita atención en **Ventas** y no hay nadie disponible. No pude calcular cuándo
> entra el próximo — revisá los horarios de esa área.*

Criterio: los cuatro dicen **quién, cuánto, dónde y qué hizo el sistema**. Sin tecnicismos y
sin que el dueño tenga que abrir el panel para entender qué pasó.

## 8. Qué se toma de v4 — y por qué v4 NO se prende

**v4 casi todo lo que hace es REDIRIGIR:** agarra cinco disparadores que hoy van por la v2
(derivar directo) y los manda por la v3 (rotar). Es un puente entre dos caminos.

**Cuando haya UN SOLO camino (fase 5), ese puente no tiene sentido: v4 se queda sin trabajo
y desaparece sin haberse prendido nunca.**

**Lo ÚNICO que se le saca:** preguntar a qué área quiere hablar cuando el lead pide un humano
(su "punto 2"). Es el único comportamiento **nuevo** que tiene; entra en la fase 2.

**Lo que v4 hace y NO se toma:** apagar la escalada de cola. Con v4 ON, el cron que escala al
fallback a los 30 min deja de correr. Eso saca una red de seguridad y contradice la regla 3.10
("la escalera aplica siempre").
