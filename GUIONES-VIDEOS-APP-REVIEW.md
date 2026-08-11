# Guiones de video para el App Review de Meta — Raíces CRM

App de Meta: **Raices** — App ID `2022932525766291` (publicada). Negocio: Raíces CRM.

**Estado:** aprobados `whatsapp_business_messaging`, `whatsapp_business_management`, `public_profile`.
Rechazados 6: `instagram_business_basic`, `instagram_business_manage_messages`, `pages_show_list`, `pages_manage_metadata`, `pages_messaging`, `business_management`.

**Motivo único del rechazo (textual de Meta, Política 1.6):** *"La captura de video no coincide con los detalles del caso de uso"*. Y aclaran: *"Determinamos que el caso de uso de tu app está permitido"*.
Traducido: **el producto está bien, el video no mostró la experiencia completa.** No hay que cambiar el producto, hay que grabar bien.

Lo que Meta exige, textual:
1. El flujo de **inicio de sesión de Meta completo** (sin cortes).
2. Un **usuario con acceso a la app** para ese permiso (rol cargado en la app).
3. La **experiencia completa** del caso de uso.
4. Interfaz **en inglés**, con **subtítulos** e info sobre las herramientas que explique **qué significa cada botón**.
5. Si la app es **server-to-server** o usa **token de usuario del sistema**, indicarlo en la solicitud.

Son **dos videos**:
- **Video 1 — Messenger**: cubre 4 permisos (`pages_show_list`, `pages_manage_metadata`, `pages_messaging`, `business_management`).
- **Video 2 — Instagram**: cubre 2 permisos (`instagram_business_basic`, `instagram_business_manage_messages`).

---

## 0. BLOQUEADORES — arreglar o esquivar ANTES de grabar

Esto lo verifiqué leyendo el código, no es teoría. Si se graba sin resolverlo, Meta rechaza de nuevo por lo mismo (interfaz no está en inglés / el flujo no coincide).

### B1 🔴 La pantalla de Integraciones está en español AUNQUE el panel esté en inglés
La parte de Meta de `whatsapp/page.tsx` NO usa `t()`: son literales en español hardcodeados. Es exactamente la pantalla que el revisor va a mirar.

`D:\Claude Proyectos\raices-crm-fresh\frontend\app\whatsapp\page.tsx`:
- L353-355: `'Conectado'` / `'Configurado (inactivo)'` / `'Sin conectar'`
- L363-364: `'Facebook Pages'` / `'Mensajes directos'`
- L378: `'Conectá tus canales y herramientas'`
- L466: `'Esperando aprobación de Meta'`
- L474: `'Administrar'` / `'Conectar'`
- L654: `'ID de la Página de Facebook'` / `'ID de la cuenta de Instagram (IG user id)'`
- L672-673: `'Canal activo'` / `'Configurado pero inactivo'` / `'No conectado'`
- L678: `'Conectar {Messenger|Instagram}'`
- L683-685: el párrafo del verify token
- L703: **`'Conectar con Facebook / Messenger'` / `'Conectar con Instagram'`** ← el botón principal del video
- L706: `'Iniciás sesión con Facebook, elegís tu Página y autorizás…'`
- L716-721: `'Verificando disponibilidad…'` / `'Conexión con Facebook: no disponible'`
- L730: `'o cargá el token manualmente'`
- L783: el aviso del App Secret

**Opción A (la correcta):** pasar esos literales a `t()` con su clave en `lib/i18n.ts`. Es la única forma de cumplir el punto (4) de Meta en la pantalla clave.
**Opción B (parche de grabación, sin tocar producto):** no hay. Esa pantalla es el corazón del video, no se puede esquivar.

> Esto es un cambio de código en el front → **necesita el "dale" de Diego** antes de tocarlo.

### B2 🔴 La pantalla de cierre del OAuth (la del backend) está en español
`D:\Claude Proyectos\agente-inmobiliaria\server.js`:
- L39427 `_oauthCierreHtml(...)` → `<html lang="es">` + *"Ya podes cerrar esta ventana y volver a Raices CRM."*
- L39723 → `'Messenger conectado'` / `'Activala desde Integraciones para empezar a responder.'`
- L39808 → `'Instagram conectado'` / `'Activalo desde Integraciones para empezar a responder los DMs.'`

Esa pantalla aparece **sí o sí** en los dos videos, justo después del consentimiento. Hay que traducirla (o hacerla bilingüe según `business_settings.idioma`).

### B3 🟠 Los estados del lead en Conversaciones están hardcodeados en español
`app\conversaciones\page.tsx` L126-130: `'En conversación'`, `'Interesado'`, `'Listo para humano'`, `'Cerrado'`, y `'Sin asignar'` (L3010, L3049, L4382…), `'Todos'` (L3375, L3594).
La bandeja se ve en los dos videos. Cobertura estimada de inglés en esa pantalla: **35-40%**.

**Opción B (sin tocar código):** grabar la bandeja **con el chat abierto y en primer plano**, no la lista de estados. Encuadrar el hilo de mensajes + el botón de enviar. No abrir la barra de filtros ni el desplegable de estados. Es peor que traducir, pero es grabable hoy.

### B4 🔴 VERIFICAR: ¿el App ID de Instagram pertenece a la app 2022932525766291?
`server.js` L39473-39477, comentario textual del código:
> *"IG usa una APP DE INSTAGRAM SEPARADA (Raices-IG, id 1003865422423472) con su PROPIA clave secreta."*

Si en la consola de Meta ese `1003865422423472` es una **app distinta** y no el "Identificador de app de Instagram" **dentro** de Raices, el video de Instagram va a mostrar el login de **otra app** → rechazo automático por "no coincide".

**Chequeo (2 minutos, en el navegador de Diego):** developers.facebook.com → app **Raices** (2022932525766291) → **Instagram → Configuración de inicio de sesión de la API** → ahí figura el "Identificador de app de Instagram". Tiene que decir `1003865422423472`. Si dice otro número, **no se graba hasta resolverlo**.

### B5 🟠 El scope de Instagram pide un permiso que NO está en la solicitud
`server.js` L39479:
```
META_IG_OAUTH_SCOPES = 'instagram_business_basic,instagram_business_manage_messages,instagram_business_manage_comments'
```
`instagram_business_manage_comments` **no** está entre los 6 permisos pedidos. En la pantalla de consentimiento el revisor va a ver un permiso de más → "no coincide con el caso de uso".

**Dos salidas:** (a) sacar `instagram_business_manage_comments` del scope antes de grabar, o (b) agregarlo a la solicitud de App Review con su propia justificación. **Recomiendo (a)**: menos superficie, menos preguntas.

### B6 🟠 La lista de permisos de Messenger la define el `config_id`, no el código
Messenger usa **Facebook Login for Business** con `config_id 1814526292646301` ("Raices - Conectar") — `server.js` L39469. El `scope=` clásico (L39466) es solo fallback.
→ La pantalla de permisos que sale en el video es **la que tiene cargada esa configuración en la consola de Meta**.
**Chequeo antes de grabar:** developers.facebook.com → Raices → **Inicio de sesión de Facebook para empresas → Configuraciones** → "Raices - Conectar" → que tenga **exactamente** `pages_show_list`, `pages_messaging`, `pages_manage_metadata`, `business_management`. Ni uno más.

### B7 🟠 El QR de WhatsApp (Evolution) se ve en la misma pantalla
Con el flag `cloud_api_v1` en OFF, la tarjeta "Connect WhatsApp" (QR / método no oficial) está visible en Integraciones. El propio código lo dice (L104): con el flag ON se oculta *"así el revisor de Meta no ve el método no oficial"*.
**Sin tocar nada:** encuadrar/scrollear de modo que la tarjeta de WhatsApp **no entre en cuadro**. Entrar a Integraciones y bajar directo a Messenger/Instagram.

### B8 🟡 Meta Test ya tiene los dos canales conectados
`whatsapp/page.tsx` L80-90: la cuenta ve los canales por `userId === META_TEST_UID`, y como ya tiene credencial (`YA_CONECTADO_META`) el botón de la tarjeta dice **"Administrar"**, no "Conectar".
**No es problema:** el botón azul de OAuth (L698-707) aparece igual dentro del formulario, esté conectado o no. Se puede volver a correr el flujo completo y el backend hace `update` de la credencial.
**Si se quiere ver "Conectar" (más limpio para el revisor):** desconectar el canal antes de grabar. Es la cuenta congelada de laboratorio, no afecta clientes — pero **backup de la fila de `messenger_credentials` primero** y **requiere el "dale" de Diego**.

### B9 🟡 El OAuth va por redirección de página completa, no por popup
`whatsapp/page.tsx` L206-210: `window.location.href = ...`. La pantalla de cierre intenta `window.close()` (server.js L39434) pero **no hay `window.opener`** → la ventana no se cierra sola y el revisor queda ahí.
**En el video:** después de la pantalla de cierre, **escribir la URL a mano** en la barra (`www.raicescrm.com/whatsapp`). No usar "Atrás": vuelve al callback con un `code` ya consumido y muestra un error.

---

## 1. Preparativos comunes a los dos videos (checklist)

Marcar uno por uno. Los dos videos comparten todo esto.

- [ ] **Cuenta de Raíces:** "Raíces Meta Test" (`user_id 190b9a5c-9a3e-4053-80a2-21fb47cac10d`). Es la única con Instagram y Messenger conectados y la única a la que el panel le muestra los canales de Meta.
- [ ] **Rol en la app (Meta lo exige textual — punto 2):** developers.facebook.com/apps/**2022932525766291**/roles → agregar como **Administrador** o **Probador** a:
  - la cuenta de Facebook con la que se va a hacer el login en el video;
  - la cuenta de Instagram con la que se va a hacer el login del video 2 (pestaña "Probadores de Instagram");
  - **aceptar la invitación** desde esa cuenta (developers.facebook.com/settings/developer/requests) antes de grabar. Sin aceptar, no cuenta.
- [ ] **Panel en inglés:** entrar al panel con Meta Test → **Configuración → Empresa → "Idioma base del agente"** → elegir **Inglés** → Guardar. La pantalla se recarga sola en inglés (`lib/i18n.ts` L262-279 lee `business_settings.idioma` del usuario logueado).
  - Bonus: ese mismo campo es el idioma base del agente IA, así que **la IA también responde en inglés**. Igual, el agente detecta el idioma del lead: **escribir el mensaje de prueba en inglés** garantiza respuesta en inglés.
  - Después de grabar, volver a **Español**.
- [ ] **Segundo teléfono** (o segunda computadora) con **otra cuenta** de Facebook/Instagram, la que hace de cliente. No puede ser la misma cuenta que administra la Página: Meta no entrega el mensaje al webhook si el que escribe es admin de la Página.
- [ ] **Los bloqueadores B1-B9 resueltos o encuadrados.**
- [ ] **Navegador limpio:** ventana nueva, **sesión de Facebook/Instagram CERRADA** (así el video muestra el login completo — punto 1 de Meta). Sin extensiones, sin barra de favoritos con cosas personales, zoom al 100%.
- [ ] **Barra de direcciones visible** en todo el video: el revisor tiene que ver `facebook.com` / `instagram.com` reales. No grabar en pantalla completa sin URL.
- [ ] **Formato:** MP4 (H.264), **1920×1080**, 30 fps, **subtítulos quemados en el video** (Meta sube un solo archivo, no acepta .srt aparte). Peso: dejarlo por debajo de 100 MB.
- [ ] **Duración:** Messenger 3:00-3:30 · Instagram 2:30-3:00. Ni más corto (falta la experiencia completa) ni más largo (se pierde).
- [ ] **Sin cortes dentro del login ni del consentimiento.** Una sola toma continua desde el botón azul hasta la pantalla de cierre.
- [ ] **Puntero del mouse visible**, movimientos lentos, 2 segundos de pausa antes de cada clic importante.
- [ ] **Sin música, sin acelerado, sin zoom brusco.** Voz en off: opcional, los subtítulos alcanzan.
- [ ] **El teléfono se filma en cámara o se espeja en pantalla** (scrcpy / "Continuidad"). Si se filma con otra cámara, que se lea el texto.
- [ ] Prueba de humo antes de la toma buena: hacer el recorrido entero una vez **sin grabar** para ver que el webhook entrega y la IA contesta.

---

## 2. GUION 1 — MESSENGER

**Cubre 4 permisos:** `pages_show_list`, `pages_manage_metadata`, `pages_messaging`, `business_management`.
**Duración objetivo:** 3:10. **Subtítulos: EN INGLÉS, tal cual están escritos abajo.**

| # | Tiempo | Qué se ve / qué se clickea | Subtítulo (inglés, palabra por palabra) |
|---|---|---|---|
| 1 | 0:00-0:07 (7s) | Consola de Meta, panel de la app **Raices**, con el **App ID 2022932525766291** legible en pantalla. | `Raíces CRM — Meta App ID 2022932525766291.` <br> `This is the app requesting these permissions.` |
| 2 | 0:07-0:15 (8s) | `www.raicescrm.com` — pantalla de login del panel. Se escribe el mail y se entra con la cuenta del negocio. | `Raíces CRM is a messaging CRM for real estate agencies and hotels.` <br> `A business owner signs in to their own account.` |
| 3 | 0:15-0:25 (10s) | Bandeja **Conversations**, en inglés. Se ve un hilo abierto con mensajes. **No abrir filtros ni estados** (ver B3). | `All customer messages land in one shared inbox.` <br> `WhatsApp, Instagram and Facebook Messenger in a single place.` |
| 4 | 0:25-0:32 (7s) | Menú lateral → clic en **Integrations**. La pantalla de Integraciones carga. Scrollear directo hasta las tarjetas de Meta (**la tarjeta de WhatsApp no debe quedar en cuadro** — ver B7). | `The business connects its own channels in the Integrations screen.` |
| 5 | 0:32-0:42 (10s) | Zoom suave sobre la tarjeta **Messenger**. Se lee el estado ("Not connected") y el botón. Clic en **Connect**. | `The Messenger card shows the connection status of the business Facebook Page.` <br> `"Connect" starts the official Facebook Login for Business flow.` |
| 6 | 0:42-0:52 (10s) | Se abre el formulario del canal. Pausa 3s sobre el botón azul, después clic en **"Connect with Facebook / Messenger"**. | `This blue button opens Meta's own login dialog.` <br> `The business never copies or pastes an access token by hand.` |
| 7 | 0:52-1:08 (16s) | **facebook.com** — pantalla de login. Se escribe el mail y la clave (Facebook la enmascara sola) y se envía. **URL visible. Sin cortes.** | `This is Meta's login screen on facebook.com.` <br> `The user signs in with their own Facebook account,` <br> `which has a role assigned in this app.` |
| 8 | 1:08-1:18 (10s) | Pantalla **"Continuar como …"** de Facebook Login for Business. Clic en Continuar. | `Facebook Login for Business confirms which person is connecting.` |
| 9 | 1:18-1:32 (14s) | Pantalla de **selección de portafolio comercial**. Se elige el negocio. Pausa 3s antes de clickear. | `The user chooses the business portfolio that owns the Page.` <br> `The "business_management" permission is what enables this step.` |
| 10 | 1:32-1:45 (13s) | Pantalla de **selección de Página**. Se ve la lista de Páginas. Se elige la Página de la inmobiliaria. | `Meta lists the Facebook Pages this user manages.` <br> `"pages_show_list" is what lets our backend read that list` <br> `so the business can pick its own Page.` |
| 11 | 1:45-2:02 (17s) | **Pantalla de permisos** de Meta. **Pausa 6 segundos sin tocar nada**, con zoom para que se lea la lista completa. Después clic en **Guardar / Continuar**. | `These are the permissions being requested:` <br> `"pages_messaging" to receive and reply to Page messages.` <br> `"pages_manage_metadata" to subscribe the Page to our webhook.` <br> `"pages_show_list" and "business_management" to select the Page.` |
| 12 | 2:02-2:12 (10s) | Redirección al backend → **pantalla de cierre "Messenger connected"** (ver B2: hay que traducirla). Pausa 4s. | `Meta redirects back to our server, which exchanges the code` <br> `for a long-lived Page access token and subscribes the Page` <br> `to the messages webhook using "pages_manage_metadata".` |
| 13 | 2:12-2:20 (8s) | Se escribe **`www.raicescrm.com/whatsapp`** en la barra de direcciones (no usar Atrás — ver B9). Vuelve Integrations: la tarjeta ahora dice **"Configured (inactive)"**. | `The connection is saved as inactive by default.` <br> `A new channel is never switched on automatically.` |
| 14 | 2:20-2:28 (8s) | Clic en **Manage / Activate** → el badge pasa a **"Channel active"**. | `The business activates the channel itself. Messenger is now live.` |
| 15 | 2:28-2:40 (12s) | **SEGUNDO TELÉFONO en cámara.** Messenger abierto en la Página de la inmobiliaria, con otra cuenta. Se escribe y se envía: *"Hi! Do you have a two-bedroom apartment available?"* | `Now a customer writes to the Page from a different account,` <br> `on a different phone. This is a real inbound message.` |
| 16 | 2:40-2:50 (10s) | Vuelta al panel. **Sin recargar**, la conversación nueva aparece en Conversations con el ícono/etiqueta de Messenger. Se abre el hilo y se lee el mensaje entrante. | `The message reaches Raíces CRM through the Page webhook.` <br> `"pages_messaging" is what delivers it. The icon shows the channel.` |
| 17 | 2:50-3:00 (10s) | La respuesta automática de la IA aparece en el hilo (en inglés). | `Our AI assistant replies first, using the agency's own property data.` |
| 18 | 3:00-3:08 (8s) | Clic en el toggle **AI Agent** para apagarlo en ese hilo, y **Assign to** → un asesor humano. | `When the lead is ready, the business turns the AI off` <br> `and assigns the conversation to a human sales agent.` |
| 19 | 3:08-3:20 (12s) | Se **escribe a mano** en el cuadro de texto del panel: *"Hi! Yes, we have two available. I'm Ana, I'll help you."* y se envía. Se ve salir el mensaje en el hilo. | `The human agent types the reply here and sends it.` <br> `The message goes out from the Page using "pages_messaging".` |
| 20 | 3:20-3:32 (12s) | **SEGUNDO TELÉFONO en cámara.** El mensaje **llega** al Messenger del cliente, en el mismo hilo. | `The reply arrives in Messenger on the customer's phone,` <br> `in the same conversation. The round trip is complete.` |
| 21 | 3:32-3:40 (8s) | Placa final estática sobre el panel. | `Permissions shown in this video:` <br> `pages_show_list · pages_messaging · pages_manage_metadata · business_management` |

**Los 4 permisos quedan demostrados así:**
- `pages_show_list` → toma 10 (lista de Páginas del usuario).
- `business_management` → toma 9 (selección del portafolio comercial).
- `pages_manage_metadata` → toma 12 (suscripción de la Página al webhook) + toma 16 (llega el mensaje: sin la suscripción no llegaría).
- `pages_messaging` → tomas 16 y 19-20 (recibir y responder).

---

## 3. GUION 2 — INSTAGRAM

**Cubre 2 permisos:** `instagram_business_basic`, `instagram_business_manage_messages`.
**Ojo:** este flujo es **"Instagram API con inicio de sesión de Instagram"** — el cliente entra con **su usuario y clave de Instagram**, NO con Facebook. El authorize va contra `www.instagram.com/oauth/authorize` con el Identificador de app de Instagram `1003865422423472` (verificar B4 antes de grabar).
**Duración objetivo:** 2:50.

| # | Tiempo | Qué se ve / qué se clickea | Subtítulo (inglés, palabra por palabra) |
|---|---|---|---|
| 1 | 0:00-0:07 (7s) | Consola de Meta, app **Raices**, App ID **2022932525766291** legible, y la sección **Instagram → API setup with Instagram login** con el **Instagram App ID** a la vista. | `Raíces CRM — Meta App ID 2022932525766291,` <br> `using Instagram API with Instagram Login.` |
| 2 | 0:07-0:15 (8s) | `www.raicescrm.com` — login del panel, se entra con la cuenta del negocio. | `Raíces CRM is a messaging CRM for real estate agencies and hotels.` <br> `A business owner signs in to their own account.` |
| 3 | 0:15-0:24 (9s) | Bandeja **Conversations** en inglés, con un hilo abierto. No abrir filtros ni estados. | `Every customer message lands in one shared inbox,` <br> `no matter which channel it came from.` |
| 4 | 0:24-0:31 (7s) | Menú → **Integrations**. Scroll directo a las tarjetas de Meta (la de WhatsApp fuera de cuadro). | `The business connects its own channels in the Integrations screen.` |
| 5 | 0:31-0:41 (10s) | Zoom sobre la tarjeta **Instagram**. Se lee el estado y el botón. Clic en **Connect**. | `The Instagram card shows the status of the business Instagram account.` <br> `"Connect" starts the official Instagram login flow.` |
| 6 | 0:41-0:51 (10s) | Formulario del canal. Pausa 3s sobre el botón, clic en **"Connect with Instagram"**. | `This button opens Instagram's own login dialog.` <br> `The business never copies or pastes an access token by hand.` |
| 7 | 0:51-1:08 (17s) | **instagram.com** — login de Instagram. Se escribe el usuario y la clave (Instagram la enmascara) y se envía. **URL visible. Sin cortes.** | `This is Instagram's login screen on instagram.com.` <br> `The business signs in with its own Instagram professional account,` <br> `which has a tester role in this app.` |
| 8 | 1:08-1:26 (18s) | **Pantalla de permisos de Instagram.** **Pausa 6 segundos sin tocar**, con zoom para que se lea todo. Después clic en **Allow / Continuar**. | `These are the permissions being requested:` <br> `"instagram_business_basic" to read the account's ID and username,` <br> `so the CRM knows which account it is connecting.` <br> `"instagram_business_manage_messages" to receive and reply to direct messages.` |
| 9 | 1:26-1:37 (11s) | Redirección al backend → **pantalla de cierre "Instagram connected"** (traducida, ver B2). Pausa 4s. | `Instagram redirects back to our server, which exchanges the code` <br> `for a long-lived token and subscribes the account` <br> `to the direct-messages webhook.` |
| 10 | 1:37-1:45 (8s) | Se escribe **`www.raicescrm.com/whatsapp`** en la barra (no usar Atrás). Vuelve Integrations: **"Configured (inactive)"**. | `The connection is saved as inactive by default.` <br> `A new channel is never switched on automatically.` |
| 11 | 1:45-1:53 (8s) | Clic en **Manage / Activate** → badge **"Channel active"**. | `The business activates the channel itself. Instagram DMs are now live.` |
| 12 | 1:53-2:06 (13s) | **SEGUNDO TELÉFONO en cámara.** App de Instagram con otra cuenta, entra al perfil del negocio y manda un DM: *"Hi! Is the apartment on the listing still available?"* | `Now a customer sends a direct message to the business account` <br> `from a different Instagram account, on a different phone.` |
| 13 | 2:06-2:16 (10s) | Panel, sin recargar: aparece la conversación nueva con la etiqueta de Instagram. Se abre y se lee el DM entrante. | `The direct message reaches Raíces CRM through the Instagram webhook.` <br> `"instagram_business_manage_messages" is what delivers it.` |
| 14 | 2:16-2:25 (9s) | La respuesta de la IA aparece en el hilo, en inglés. | `Our AI assistant replies first, using the agency's own property data.` |
| 15 | 2:25-2:33 (8s) | Clic en el toggle **AI Agent** para apagarlo y **Assign to** → asesor humano. | `When the lead is ready, the business turns the AI off` <br> `and assigns the conversation to a human sales agent.` |
| 16 | 2:33-2:45 (12s) | Se escribe a mano en el panel: *"Hi! Yes, it's available. I'm Ana, I can show it to you this week."* y se envía. Se ve salir el mensaje. | `The human agent types the reply here and sends it.` <br> `The message goes out as an Instagram direct message.` |
| 17 | 2:45-2:57 (12s) | **SEGUNDO TELÉFONO en cámara.** El DM **llega** al Instagram del cliente, mismo hilo. | `The reply arrives as a direct message on the customer's phone,` <br> `in the same conversation. The round trip is complete.` |
| 18 | 2:57-3:04 (7s) | Placa final. | `Permissions shown in this video:` <br> `instagram_business_basic · instagram_business_manage_messages` |

**Los 2 permisos quedan demostrados así:**
- `instagram_business_basic` → tomas 8 y 9: es el permiso base del Instagram Login; sin él no hay token, y de ahí sale el `ig_user_id` con el que el sistema identifica la cuenta y enruta los DMs entrantes al negocio correcto.
- `instagram_business_manage_messages` → tomas 12-13 (recibir) y 16-17 (responder).

---

## 4. Errores que hacen que Meta rechace (checklist de "no hacer")

- ❌ **Cortar o acelerar el login.** El punto 1 de Meta es literal: *flujo de inicio de sesión completo*. Si la sesión de Facebook ya estaba abierta y solo se ve "Continuar como Diego", **no cuenta**. Cerrar sesión antes.
- ❌ **Grabar con una cuenta sin rol en la app.** Punto 2. Hay que agregarla en Roles **y aceptar la invitación**.
- ❌ **Mostrar la pantalla de permisos menos de 5 segundos**, o taparla con el cursor, o blurearla.
- ❌ **Que aparezca un permiso que no está en la solicitud** (ver B5: `instagram_business_manage_comments`).
- ❌ **Mostrar texto en español.** Es el punto 4 y es la mitad del rechazo anterior. Ver B1, B2, B3.
- ❌ **Cortar el video después de conectar.** Conectar no es el caso de uso: el caso de uso es **mensaje entra → IA responde → humano responde → llega al cliente**. Sin las dos puntas (los dos teléfonos) es "no coincide con los detalles del caso de uso" otra vez.
- ❌ **Escribir desde la misma cuenta que administra la Página.** Meta no dispara el webhook y el video queda sin el mensaje entrante.
- ❌ **Mostrar el bloque "or load the token manually"** con los campos de token/app secret. Da la impresión de que el permiso no se usa. Cortar el scroll antes de ese separador (`whatsapp/page.tsx` L730).
- ❌ **Mostrar la tarjeta de WhatsApp con el QR** (método no oficial). Ver B7.
- ❌ **Subir el mismo video para los dos grupos de permisos.** Van dos videos distintos, uno por flujo de login.
- ❌ **Subtítulos que narran clics** (*"now I click here"*). Meta pide que expliquen **qué significa cada botón y qué permiso lo hace posible**. Los subtítulos de arriba ya están escritos así.
- ❌ **Usar Atrás después del OAuth.** Reenvía un `code` consumido y se ve un error en el video. Ver B9.
- ❌ **Datos personales reales en cuadro** (mails de clientes, teléfonos, nombres de leads reales). Usar la cuenta de laboratorio y contactos de prueba.

---

## 5. NOTAS DE LA SOLICITUD (texto para el formulario de App Review)

Va **en inglés**, tal cual. Cada permiso tiene su bloque. El primer párrafo (contexto) se repite en los seis: los revisores leen cada permiso por separado.

### 5.0 — Declaración de arquitectura (punto 5 de Meta)

**Pegar este párrafo al final de CADA uno de los seis bloques**, o en el campo general de la solicitud:

> **Architecture note (server-to-server):** Raíces CRM is a server-to-server application. All Graph API calls are made from our own backend (Node.js, hosted at `https://agente-inmobiliaria-production-7e1c.up.railway.app`), never from the browser or from a mobile client. **We do NOT use a system user token.** Each business completes the login flow with its own credentials, and our backend stores that business's own long-lived token (a Page access token for Messenger, an Instagram user access token for Instagram) encrypted at rest and scoped to that single tenant. Tokens are never exposed to the front end: the panel only ever sees a masked placeholder. Incoming messages are delivered to our webhook endpoint and validated with the app secret signature (`X-Hub-Signature-256`) before processing.

### 5.1 — `pages_show_list`

> Raíces CRM (https://www.raicescrm.com) is a messaging CRM used by real estate agencies, property developers and hotels. Each business connects its own channels — WhatsApp, Instagram and Facebook Messenger — and every incoming customer message lands in one shared inbox. An AI assistant answers the first questions using the business's own inventory (properties, rooms, prices, availability) and hands the conversation over to a human sales agent as soon as the customer shows real intent. We only receive messages from, and send messages to, people who contacted the business first.
>
> **Why we need `pages_show_list`:** during onboarding, the business owner clicks "Connect with Facebook / Messenger" in our Integrations screen, which launches Facebook Login for Business. After consent, our backend calls `GET /me/accounts?fields=id,name,access_token` to list the Facebook Pages that this person manages, so the owner can connect the Page that belongs to their business and so we can obtain that Page's access token. Without this permission we cannot identify the Page or retrieve its token, and the business would be forced to copy and paste a token by hand — which most of our customers (small agencies and family-run hotels) cannot do.
>
> **Data handling:** we read only `id`, `name` and `access_token`, and we persist only the single Page the user chooses. We do not store the list of the user's other Pages.
>
> **Where to see it in the video:** 1:32–1:45, when Meta shows the list of Pages and the business selects its own.

### 5.2 — `pages_messaging`

> Raíces CRM (https://www.raicescrm.com) is a messaging CRM used by real estate agencies, property developers and hotels. Each business connects its own channels — WhatsApp, Instagram and Facebook Messenger — and every incoming customer message lands in one shared inbox. An AI assistant answers the first questions using the business's own inventory (properties, rooms, prices, availability) and hands the conversation over to a human sales agent as soon as the customer shows real intent.
>
> **Why we need `pages_messaging`:** this is the core of our product. When a customer sends a message to the business's Facebook Page, our webhook receives it and creates or updates a conversation in the CRM. The AI assistant answers within seconds with information the business itself loaded (available properties, prices, location, opening hours). When the customer is ready to schedule a visit or make a booking, the conversation is assigned to a human sales agent, who replies from the same inbox; that reply is sent back to the customer through the Page. Without `pages_messaging` the product simply does not work: we can neither receive nor answer the customer.
>
> **Data handling:** we store the message text, timestamp and the sender's Page-Scoped ID, plus the name the customer chose to share, in order to keep the conversation history the business needs to follow up. We never message people who did not write to the business first, and we honour the standard messaging window.
>
> **Where to see it in the video:** 2:28–2:50 (a customer sends a message from another phone and it appears in the CRM) and 3:08–3:32 (the human agent replies from the CRM and the reply arrives on the customer's phone).

### 5.3 — `pages_manage_metadata`

> Raíces CRM (https://www.raicescrm.com) is a messaging CRM used by real estate agencies, property developers and hotels. Each business connects its own channels — WhatsApp, Instagram and Facebook Messenger — and every incoming customer message lands in one shared inbox, where an AI assistant answers first and a human sales agent takes over when the lead is ready.
>
> **Why we need `pages_manage_metadata`:** immediately after the business connects its Page, our backend calls `POST /{page-id}/subscribed_apps` with `subscribed_fields=messages,messaging_postbacks` so that Meta delivers that Page's messages to our webhook. This is the only way an incoming message can reach the CRM. We use this permission exclusively to create that webhook subscription during onboarding (and to re-create it if the business reconnects). We do not edit the Page, its settings, its posts or any other metadata.
>
> **Where to see it in the video:** 2:02–2:12, when the callback screen confirms the connection — the subscription is created at that moment — and 2:40–2:50, when the customer's message is delivered to the CRM, which is only possible because the subscription exists.

### 5.4 — `business_management`

> Raíces CRM (https://www.raicescrm.com) is a messaging CRM used by real estate agencies, property developers and hotels. Each business connects its own channels — WhatsApp, Instagram and Facebook Messenger — and every incoming customer message lands in one shared inbox, where an AI assistant answers first and a human sales agent takes over when the lead is ready.
>
> **Why we need `business_management`:** our app uses **Facebook Login for Business** (login configuration "Raices - Conectar", `config_id 1814526292646301`). In that flow, the person connecting must first select the business portfolio that owns the Facebook Page they want to connect; `business_management` is the permission that makes that selection step possible and lets us resolve the Page under the correct business. Many of our customers manage their Page through a Business Manager rather than a personal profile, so without this step the Page is not reachable and onboarding fails. We use it only to complete the connection; we do not create, modify or delete business assets, ad accounts or users.
>
> **Where to see it in the video:** 1:18–1:32, the business portfolio selection step inside the Facebook Login for Business dialog.

### 5.5 — `instagram_business_basic`

> Raíces CRM (https://www.raicescrm.com) is a messaging CRM used by real estate agencies, property developers and hotels. Each business connects its own channels — WhatsApp, Instagram and Facebook Messenger — and every incoming customer message lands in one shared inbox. An AI assistant answers the first questions using the business's own inventory and hands the conversation over to a human sales agent when the customer shows real intent.
>
> **Why we need `instagram_business_basic`:** we use *Instagram API with Instagram Login*. The business owner clicks "Connect with Instagram" in our Integrations screen and signs in with their own Instagram professional account. `instagram_business_basic` is the base permission of that login: it is required to complete the authorization and to obtain the account's Instagram user ID and username. We store that Instagram user ID because our webhook routes every incoming direct message by it — it is how we know which of our customers a message belongs to, and it is what prevents one business from ever seeing another business's messages. We also show the connected username in the panel so the owner can confirm the right account is connected. We do not read the account's media, followers or insights.
>
> **Where to see it in the video:** 1:08–1:26 (the Instagram permission screen) and 1:26–1:37 (the connection is completed and the account is identified in our system).

### 5.6 — `instagram_business_manage_messages`

> Raíces CRM (https://www.raicescrm.com) is a messaging CRM used by real estate agencies, property developers and hotels. Each business connects its own channels — WhatsApp, Instagram and Facebook Messenger — and every incoming customer message lands in one shared inbox. An AI assistant answers the first questions using the business's own inventory and hands the conversation over to a human sales agent when the customer shows real intent.
>
> **Why we need `instagram_business_manage_messages`:** a very large share of the enquiries our customers receive arrive as Instagram direct messages after the person sees a property or a room on the business's Instagram profile. With this permission our backend subscribes the connected Instagram account to the `messages` webhook field, receives those direct messages, shows them in the same inbox as WhatsApp and Messenger, lets the AI assistant answer with the business's own information, and lets the human sales agent reply from the CRM. Without it, Instagram enquiries cannot be received or answered and the channel is unusable. We only reply to people who sent a direct message to the business first.
>
> **Data handling:** we store the message text, timestamp and the sender's Instagram-scoped ID so the business keeps the conversation history it needs to follow up on the enquiry.
>
> **Where to see it in the video:** 1:53–2:16 (a customer sends a DM from another phone and it appears in the CRM) and 2:33–2:57 (the human agent replies from the CRM and the reply arrives as a DM on the customer's phone).

---

## 6. Checklist final antes de apretar "Enviar"

- [ ] B1, B2, B3 resueltos (o el encuadre esquiva lo que quedó en español) — **no queda un solo texto en español en cuadro**.
- [ ] B4 verificado: el App ID de Instagram está bajo la app 2022932525766291.
- [ ] B5 resuelto: el scope de IG no pide `instagram_business_manage_comments`.
- [ ] B6 verificado: la config "Raices - Conectar" tiene exactamente los 4 permisos de Messenger.
- [ ] La cuenta usada en cada video tiene rol en la app y **aceptó** la invitación.
- [ ] Los dos videos muestran el login **completo**, con la URL de Meta visible.
- [ ] Los dos videos muestran mensaje entrante **desde otro teléfono** y respuesta saliente que **llega** a ese teléfono.
- [ ] Subtítulos quemados, en inglés, explicando qué hace cada botón y qué permiso lo habilita.
- [ ] Video 1 subido en los 4 permisos de Messenger; Video 2 subido en los 2 de Instagram.
- [ ] La nota de arquitectura server-to-server pegada en los 6 permisos.
- [ ] El idioma del panel devuelto a **Español** después de grabar.
