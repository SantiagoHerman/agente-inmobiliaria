# Pendientes que NO entran en el plan de Cloud API

Diego, 2026-08-11: *"no quiero que te olvides de nada."* El plan
`PLAN-CLOUD-API-INTEGRACIONES.md` cubre Cloud API, Integraciones, Conversaciones, Recontacto,
Oportunidades, importación, perfil automático y etiquetas. **Esto es todo lo demás que quedó abierto
del 10 y 11 de agosto**, con lo que está verificado de cada uno.

---

## 1. Uri y las 7 conversaciones colgadas con promesas sin cumplir
**Solo 1 de las 7 está diagnosticada.** Diego (11/8): *"seguimos emparchando cuando no vemos la
causa"* — tenía razón, y por eso las otras 6 NO se tocan hasta saber qué les pasó.

- **Uri** (Anton, conv `2622fecd`): última actividad **7/8 05:31 AR**, la IA dijo *"Te las voy
  mandando"* (6 fotos) y después *"Dejame buscar en el inventario y te paso opciones"*. Nunca mandó
  nada. Caja negra: llamó `buscar_inventario`, **nunca** `enviar_foto_propiedad`.
- **Causa verificada:** `enviar_foto_propiedad` manda **UNA foto por llamada** (numero + una
  categoria). El lead pidió 6 → la promesa era imposible de cumplir desde el arranque.
- Las otras 6 (D 170 h, 👩‍🚀 154 h, Luis 112 h, Aylen 61 h, Dario 55 h, axelf1 9 h): mezcla de
  promesas de la IA y derivaciones donde el humano nunca escribió. **Sin diagnosticar.**

## 2. El turno final del ciclo de tools puede prometer igual
`_CICLO_MAX_VUELTAS = 3` y en la última vuelta se fuerza `tool_choice:'none'` con el comentario
*"obligado a cerrar con texto, nunca con una promesa"*. **Forzar texto no impide que el texto SEA una
promesa** — el caso Uri lo prueba. Falta instrucción explícita en ese turno: cerrar con lo que hay o
pasar a un humano, nunca prometer una acción futura.

## 3. La red que falta: cuando el último mensaje es de la IA, nadie mira
`revisarRespaldoTimeout` y el SLA **exigen `last_role='contact'`** (el SLA además `ai_enabled=false` +
asesor asignado). Desde el momento en que el último mensaje es de la IA, ninguna red de seguridad ve
la conversación. Es la causa raíz común de las 7. Cualquier arreglo acá es un diseño nuevo, no un
parche — decidir con Diego.

## 4. Fase A del caché de IA
Medido en Anton, 4 días: **3 huellas distintas** del bloque cacheado y **8 cambios** = 8 reescrituras
que el ping no puede evitar. **No deriva: ROTA** entre las mismas 3 (`464a → 783f → 7ccb → 464a…`),
lo que descarta "el inventario cambió". ~USD 5/mes solo en Anton. El `ORDER BY` que el plan viejo
culpaba **ya está** (`.order('id')` en las 3 consultas al inventario). Falta encontrar qué tiene 3
estados: volcar el bloque en 3 llamadas reales y diferenciarlas.

## 5. La ficha sugerida por la IA, como tarjeta dentro del chat
En **Contactos ya funciona**: la IA creó una sola en Anton (7/8, cliente **Uri**, `busca_alquilar`,
presupuesto 650 sin moneda, `confirmada:false`) y se ve en Contactos → Uri → Fichas como *"propuesta
por la IA, sin confirmar"*, con botón de confirmar. **Falta la tarjeta dentro del chat** en
Conversaciones, con aceptar/editar/cancelar. Disparador ya decidido: `listo_humano` + interés
concreto.

## 6. El badge de "Equipo" clavado en 6
Medido: 6 mensajes sin leer, el **más nuevo del 3/8**, el más viejo del 29/6. No baja nunca porque
solo se marca leído el hilo que se abre. **No miente** (están sin leer de verdad), pero un aviso
apuntando a algo de 5 semanas es ruido. Arreglo propuesto: botón "marcar todo leído".
(Descartado: marcarlos leídos solo, mataría el aviso de un DM real.)

## 7. `visibilidad_server_v1` está en `false` en las 9 cuentas
Todo el camino server-scoped (`/api/leads` con scope, filtros y paginado en el servidor) está
construido y **no se usa en ninguna cuenta**. Dos consecuencias:
- **Perf:** hoy Anton se baja ~1.000 filas de 1.386 en cada carga.
- **Exposición:** la RLS de `conversations` es `asesor_ve_sus_conversaciones` con
  `user_id = mi_admin_id()` — **solo la cuenta, no el asesor**. O sea el navegador de un asesor se
  baja TODOS los leads de la inmobiliaria y la pantalla le esconde los que no son suyos. Cross-cuenta
  sí está bloqueado. Prenderlo es aparte, con su medición.

## 8. El mapa del camino del mensaje (lo que le debo a Diego)
`MAPA-CAMINO-DEL-MENSAJE.md`: cada etapa desde que entra el webhook hasta que sale la respuesta, con
`archivo:línea` y **la condición textual** al lado, para que verificar cueste un grep y no media hora.
Diego aprobó arrancar por **las redes de seguridad** (la zona de las 7 conversaciones colgadas) y ver
si el formato sirve antes de seguir. Los 4 informes de auditoría del 11/8 son la mitad del material.

---

## Chicos, que entran donde toque

- **`perfil_comprador`**: la extracción escribe en `contacts.perfil_comprador` y **esa columna no
  existe** → el update falla siempre dentro de un `try/catch`. Escritura muerta desde el día uno.
- **Segundo tilde ✓✓ en Messenger/Instagram y en los ~8 avisos de sistema**: siguen sin guardar
  `wa_message_id`. (Fotos y mensajes de la IA por WhatsApp ya se arreglaron el 7/8.)
- **Dos almacenes de presupuesto**: `contacts.budget` + `budget_moneda` (ficha de Contactos) vs
  `conversations.presupuesto` + `presupuesto_moneda` (panel del chat). Hay que definir cuál es el
  canónico o van a mostrar números distintos en la misma pantalla.
- **`/api/cloud-api/*` está fuera del gate de suscripción**: una cuenta suspendida puede seguir
  configurando el canal y disparando `/enviar-prueba`.
