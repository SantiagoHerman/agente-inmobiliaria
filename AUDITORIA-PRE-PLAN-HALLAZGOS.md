# Auditoría previa al plan Cloud API — hallazgos consolidados

Revisión de solo lectura pedida por Diego el 2026-08-11 ("busca en todos los rincones bugs o fallas
que puedas tener al implementar el plan"). 4 auditores. Este archivo acumula los informes a medida
que llegan, para que la implementación los aplique TODOS.

---

## AUDITOR 3 — Front Conversaciones + perfil automático (COMPLETO)

### Bloqueantes (cambian cómo se implementa el plan)

1. **`canal_origen` NO viaja por `/api/leads`** (`server.js` `LEADS_COLS_CONV`): con
   `visibilidad_server_v1` ON la pestaña Cloud daría 0 siempre y las convs de Cloud se colarían en
   la pestaña WhatsApp (`undefined` pasa como null). Sumarla CON SONDA (patrón
   `_presupuestoMonedaExiste`, server.js:30195), nunca directo — hay precedente de 500 en prod por
   columna en select. `/api/leads` tampoco acepta filtro `canal_origen`.
2. **Las pestañas van como filtro de PRESENTACIÓN (en `listaFiltrada`, page.tsx:~2877), JAMÁS como
   filtro de query.** La detección de sonidos/avisos corre en 6 puntos sobre el dataset completo
   (page.tsx 1244/1253/1267/1277/1301/1330/2033) y `convsAnterioresRef` se REEMPLAZA con cada set:
   filtrar la query = alarmas falsas de "lead nuevo" al cambiar de pestaña + mensajes que no suenan.
   Los seeds `asignacionSeedRef`/`respaldoSeedRef` siembran una sola vez → mismo requisito.
3. **La extracción HOY PISA datos manuales** (server.js:12429-12430): `ext.interes`→`interest` y
   `ext.presupuesto`→`budget` SIN guarda de vacío, sobre las MISMAS columnas que edita la ficha
   manual. 73 contactos con budget cargado expuestos. Además `ext.presupuesto` es texto libre sin
   moneda y NO toca `budget_moneda` → puede quedar "200 mil pesos" + moneda 'USD' (hoy 0 filas con
   moneda: el daño aún no se materializó). ARREGLAR ANTES O DURANTE Fase 9.
4. **"Integraciones" YA EXISTE: es `/whatsapp`** (lib/paneles.ts:34, key 'whatsapp', label
   'Integraciones'; CloudApiCard ya montada; tabs whatsapp|page|instagram ya cableados).
   **Fase 4 = extender `/whatsapp`, NO crear `/integraciones`.**
5. **Dos gates hardcodeados bloquean las tarjetas IG/Messenger** (app/whatsapp/page.tsx:59-64):
   `EN_PREPARACION = true` (todos ven "Próximamente" salvo Meta Test) **y además**
   `userId !== 'f771e75e…'` (excluye a Anton explícitamente). Para liberar hay que tocar LOS DOS —
   el comentario del código solo documenta el primero.
6. **i18n para el video de Meta**: conversaciones ~35-40% en inglés (pills de estado, secciones,
   barra de filtros, fechas es-AR hardcodeadas — todo en español); CloudApiCard ~0% (1 t() en 692
   líneas); whatsapp/page ~65-70%. El video exige interfaz en inglés → cerrar brecha en las
   pantallas que salgan en cámara.

### Riesgos y decisiones de diseño

7. **Agujero de la regla "solo completa vacíos"**: vacío = NULL a propósito (borrar a mano deja
   NULL, server.js:31287). La extracción no distingue "nunca cargado" de "borrado a mano" → volvería
   a llenar lo que el asesor borró. Resolver con el patrón `fichas.confirmada` (server.js:41398-41486,
   la IA nunca pisa lo confirmado + rastro sin pisar) o columnas `_manual`. Precedente bueno:
   `nombre_manual` (coalesce en 13 lugares). Contraejemplo a NO copiar: `cal_*` (12402) — dice "los
   vacíos no pisan" pero un valor nuevo SÍ pisa lo manual.
8. **Dos almacenes de presupuesto**: `contacts.budget(+moneda)` (ficha) vs
   `conversations.presupuesto(+moneda)` (panel del chat). Fase 9 debe definir el canónico.
9. **Sin badge por pestaña no hay aviso visible**: `vistos` aguanta filtros (mapa por id), pero una
   tarjeta prendida en otra pestaña queda invisible. Agregar contador de no-atendidos por pestaña.
10. **El contador "X de Y"** (listaFiltrada.length vs totalLeadsDB global) va a parecer roto con
    pestaña activa ("2 de 1390"). Ajustar el denominador por pestaña.
11. **1.132 de las 1.386 convs WhatsApp de Anton son recontacto** — definir si el contador de
    pestaña los incluye. `convsExtra` (buscador) mezcla filas con y sin `canal_origen` cuando el
    pool es server-scoped.
12. Columnas que NECESITAN migración (verificado 42703): `contacts.telefono_capturado` (F8b),
    `contacts.contacto_principal_id` (F8c). `perfil_comprador` NO existe y su escritura en 12448
    está muerta (ya conocido). `instagram/facebook/budget_moneda` SÍ existen.
13. Sección nueva de panel = 2 líneas (lib/paneles.ts PANELES + ModernShell NAV); el form de
    asesores la toma solo; sin whitelist en backend. Para la escalera con datos sensibles: gate de
    dueño propio dentro de la página (el permiso de panel no alcanza).

### Limpio (no volver a mirar)
- Detección de avisos corre pre-filtro en TODOS los puntos; `vistos` por-usuario con LRU aguanta;
  seeds persistidos; `fusionarConvs` idempotente; `canal_origen` existe en la base y el camino
  directo (`select('*')`) ya lo trae; el nombre nunca se pisa (nombre_manual); el PATCH manual de
  contactos valida moneda y degrada limpio; paneles deny-by-default centralizado; t() degrada al
  original; fichas ya trae el modelo manual-sobre-automático completo.

---

## AUDITOR 2 — Motores recontacto/oportunidades (COMPLETO)

Mapa real de líneas (las del plan estaban corridas): revisarInactividad 16809-16954 ·
enviarRecontactosPendientes (legacy) 17745-17917 · _enviarRecontactosV2 18169-18513 ·
procesarOportunidades 17936-18091 · _resolverUniversoOportunidad 14085-14110 ·
enviarWhatsapp 10556-10611 · respaldo 17299-17440 · crons 18745/18956.

Estado vivo: recontacto_v2=true en TODAS las cuentas productivas (legacy solo Meta Test).
oportunidades_v1=false en las 9. Anton: tope_max=20 YA con warm-up, 20/día efectivos medidos
(6,7,8,10 de agosto; 0 el domingo), 1082 en recontacto. Hay 4 oportunidades (no 3), todas de
GALDAMES, todas borrador, max_dia=null.

### Bloqueantes

14. **El filtro de canal va en LOS TRES SENDERS, no solo en revisarInactividad.** Hay CUATRO
    puertas de entrada al recontacto: cron de inactividad (16830), manual desde el panel
    (/api/leads/actualizar permite status=recontacto, 30416/30450), importador, y oportunidades
    (universo 14093/14105 y custom_ids sin filtro de canal; buscar-leads 14180 tampoco).
    Solo excluir en el cron deja 3 puertas abiertas. Puntos de corte: legacy 17754/17900,
    v2 18269+/18495, oportunidades 14085-14110/18062.
15. **enviarWhatsapp NO valida el destinatario** (10556-10611): un IGSID viaja crudo a Evolution.
    Si Evolution devuelve 5xx/timeout → 'indeterminado' y return TRUE. Si Baileys arma el JID
    igual → key.id presente → el CRM lo marca 'enviado'. Existe `verificarNumeroWA` (6020,
    /chat/whatsappNumbers, devuelve {existe,jid}) y NO se usa en el camino de envío — es el guard
    listo para usar.
16. **Los motores de recontacto DESCARTAN el resultado del envío** (legacy 17900-17907, v2
    18495-18506): fallo ⇒ igual suben recontacto_count, escriben last_message (miente en bandeja),
    insertan en recontactos y suman al contador diario — el tope de 20 contaría envíos que no
    salieron. `reintentarFallidos` EXCLUYE a la IA por diseño (18528 .eq('role','human')) ⇒
    fallido para siempre. **Oportunidades SÍ lo hace bien** (18061-18065: ok = !!(r && r.ok),
    continue sin contar) — ese es el patrón a copiar.
17. **El tope 10/día de oportunidades NO puede montarse sobre enviados_hoy**: es POR OPORTUNIDAD
    (18003-18016). Al completarse una, la siguiente arranca con su contador en 0 y la cuenta se
    pasa el mismo día. Y max_dia=null ⇒ **default 200/día** (20× lo pedido). El tope por CUENTA
    necesita contador propio (patrón recontacto_enviados_hoy/_fecha de business_settings).
18. **v2 YA tiene contador diario por cuenta** (recontacto_enviados_hoy/_fecha, 18224-18231,
    incremento 18503): el tope duro es UNA línea en 18244-18245 (topeDiario=Math.min(topeDiario,20))
    — mismo mecanismo que Anton ya usa. **El legacy NO tiene nada**: RECONTACTO_CAP=20 es por
    tanda, GLOBAL entre tenants y en memoria (una cuenta grande consume la tanda de todos;
    cada deploy relanza a los 60s ⇒ N deploys = N tandas). Legacy solo corre en Meta Test hoy.

### Riesgos

19. Locks solo en memoria (_recontactoEnCurso etc.): correctos en 1 proceso, inútiles con
    réplicas/deploy solapado. Verificar réplicas de Railway antes de confiar en el tope.
    Dedupe de oportunidades NO atómico: insert DESPUÉS del envío y el índice
    oportunidad_envios_dedup_idx NO es UNIQUE ⇒ crash o doble proceso duplica envíos.
20. **Una oportunidad con un contacto no enviable (ej. IGSID) nunca completa** (18055/18065/18083):
    pendientes nunca llega a 0, queda 'enviando' para siempre, y como se procesa UNA por cuenta
    por prioridad, LA SIGUIENTE NUNCA ARRANCA. Y en el camino !ok no hay sleep: universo roto se
    recorre a máxima velocidad contra Evolution.
21. **Los motores no pasan por canalSalienteDe** (único enganche: 13554, /api/whatsapp/send):
    una conv nacida por Cloud entra a los 3 motores y saldría por Evolution. Hoy inerte
    (cloud_api_v1 OFF) — es exactamente lo que Fase 6 prende. Confirmado Fase 3a: enviarPlantillaCloud
    /enviarTextoCloud no escriben messages; y _cloudApiNumeroEnvio (41850) deja pasar un IGSID.
22. Con 1082 leads y tope 20/día, `recontacto_frecuencia` deja de ser calendario y pasa a piso:
    vuelta completa ~54 días; max=5 ⇒ ~270 días de cola. El front debería mostrar la cola
    pendiente junto al "X de 20", o "semanal" va a parecer roto.
23. v2 lee TODA la tabla recontactos sin .limit (18302): cuando pase el max-rows de PostgREST
    (1000), los últimos envíos quedan fuera ⇒ se saltea el chequeo de frecuencia. Anton hoy: 521.
24. Columnas muertas: conversations.proximo_recontacto y recontacto_modo (0 referencias) — NO
    apoyarse en ellas. oportunidades.ritmo se guarda y nunca se lee (perilla muerta).
25. El reset del contador diario es lazy con fecha ARG (fórmula en 17945/18176): el front tiene
    que calcular "hoy" con LA MISMA fórmula o muestra el contador de ayer.

### Limpio
Guards con finally correctos; fecha ARG bien; gates/pausas en los 3 motores; guard anti-baneo por
instancia caída fail-closed; respaldo no manda nada al lead (solo deriva — comportamiento deseado
para IG/MSN); contadores diarios v2/oportunidades persistidos; anti-stale en los WHERE críticos;
aislamiento por tenant en oportunidades.

---

## AUDITOR 1 — Backend Cloud API (COMPLETO)

Estado vivo: 1 fila en cloud_api_numbers (Meta Test, numero de prueba +1 555 148 2759), cloud_api_v1
true SOLO ahi. 9 plantillas con actualizado_at CONGELADO en 2026-08-05 (4 PENDING desde hace 6 dias).
1 conv canal_origen='cloud'.

### Bloqueantes

26. **enviarPlantillaCloud (41878) y enviarTextoCloud (41927) no escriben NADA en base.** Toda la
    persistencia es del llamador y solo 1 de 4 la hace (el envio manual, 13559-13565 — esa es la
    implementacion de referencia a factorizar). Mapa exacto de enviarWhatsapp (10556-10611) para el
    adaptador: NO inserta — recibe messages.id ya insertado por el llamador y hace UPDATE de
    estado_envio (+wa_message_id si hay); estados: enviando→enviado|fallido|indeterminado
    ('indeterminado' = pudo salir, NO reintentar; las funciones Cloud no distinguen timeout de
    rechazo). **Oportunidades NO crea fila en messages** (18062, messageId null): para plantillas hay
    que crearla de cero Y renderizar el texto local desde cloud_api_templates.cuerpo+parametros
    (Meta no devuelve el texto renderizado).
27. **messages.estado_envio tiene DEFAULT 'enviado' en la base** (verificado por OpenAPI). La fila
    role='ai' se inserta SIN estado_envio (9950) y el path Cloud entrante (42272-42282) solo escribe
    el wamid SI salio bien — sin rama else. O sea: **la premisa del plan ("queda en enviando") es
    incorrecta; el bug real es PEOR: un fallo queda como ✓ enviado MENTIROSO** y ningun cron lo
    recupera (reintentarFallidos filtra 'fallido').
28. /api/cloud-api/estado (42469) NO alcanza para la escalera: devuelve solo lo de la base;
    verified_name se pide a Meta (42515) y SE DESCARTA; 0 hits de
    name_status/code_verification_status/quality_rating/messaging_limit. `verificado` significa
    "el par numero+token respondio un GET", NO "numero verificado por Meta".
29. **cloud_api_v1 no se puede prender desde el producto**: 0 escrituras en todo el repo. Sin un
    switch (dueno) en Integraciones, la escalera exige un UPDATE a mano por cliente.
30. Token: sin refresh, sin aviso, sin columna de vencimiento, ningun cron mira cloud_api_numbers.
    Codigo 190 es solo un string (41866). **Con token vencido el entrante sigue gastando IA** (guarda
    mensaje, genera con Sonnet, registra consumo) y el envio falla con un console.error que nadie ve.
31. **message_template_status_update: 0 manejo** — el webhook lo descarta (42329 `field!=='messages'`).
    El estado de plantillas solo se refresca cuando alguien hace GET/POST (datos congelados lo
    prueban). Y ojo al implementarlo: ese webhook NO trae metadata.phone_number_id — hay que resolver
    tenant por entry.id (=WABA), falta un _resolverTenantPorWaba.
32. enviarPlantillaCloud solo soporta parametros de BODY (41896): sin header media, sin botones con
    variable, sin carousel. El catalogo de F5 queda body-only (las 4 jaspers_* con carousel del cache
    NO son enviables con este codigo).
33. Idioma desalineado: crear default 'es_AR' (42804) vs enviar default 'es' (42896/42909) → cache
    miss del pre-chequeo de variables y 132000 con causa falsa.
34. cloud_api_numbers SIN UNIQUE(user_id) y 4 resoluciones divergentes de "la fila del tenant" (2 sin
    ORDER BY: 42585, 42999): con 2 filas, re-pegar el token puede caer en la fila que los envios NO
    usan. DELETE /conectar actualiza TODAS las filas.
35. **_resolverTenantCloud (42111) sin unicidad por phone_number_id**: 2 cuentas sobre el mismo
    numero (caso demo con el numero de prueba) se pisan SIN warning — los leads de B entran a la
    bandeja de A y el consumo se factura a A. El indice de la migracion NO es unique. /conectar no
    chequea si otro tenant ya tiene el numero (falta 409). Cf. hallazgo 51: IG/MSN SI tienen
    exclusividad; Cloud no.
36. **procesarMensajeCloud NO tiene maquina de estados** (42133-42305): clasificarEstado se llama
    SOLO en 12954 (Evolution) y extraerDatosLead SOLO en 12400. Una conv Cloud jamas pasa a
    interesado/listo_humano, no deriva (el canal Meta SI deriva: 38651; Cloud ni eso), no revive de
    cerrado, no extrae datos. **Rompe la premisa de F2/F7/F9 para Cloud e IG/MSN** (en IG/MSN hay
    derivacion pero NO clasificacion de etapas). Trabajo nuevo: factorizar el post-proceso
    (clasificar+extraer+revive) y compartirlo entre Evolution, Cloud y Meta.
37. /enviar-prueba (42874): sin rastro en messages, sin tope, sin validar destinatario. Es plata real
    del cliente y es el boton que F6 reusa.
38. **Punto unico para el tope de plantillas: enviarPlantillaCloud:41883** (unico llamador en todo el
    repo). Tope ahi = imposible de esquivar. Contador nuevo (cloud_api_numbers.enviadas_hoy/fecha),
    reset con la formula de fecha ARG de 18226.

### Limpio
Auth de los 9 endpoints (verificarUsuario + _cloudApiEsDueno fail-closed, tenant nunca del body);
token nunca expuesto (mask); HMAC fail-closed; canalSalienteDe fail-closed con 1 solo acople;
gates de gasto del entrante completos y en orden; reintentarFallidos ya excluye Cloud;
multi-entry/multi-change bien resuelto por cambio; statuses→tildes idempotente; RLS en ambas tablas;
deploy-safety sin migracion; /api/cloud-api fuera del gate de suscripcion (MENOR, anotar).

---

## AUDITOR 4 — OAuth IG/Messenger + escalera (COMPLETO)

### Bloqueantes

39. **No existe estado por canal.** Los /estado (39247, 39346) solo dicen si la PLATAFORMA esta
    configurada. El estado real sale de GET /api/meta/credenciales (39076): SELECT sin order +
    .find() → con 2 filas puede devolver la INACTIVA. No valida token contra Meta; no hay "probar
    conexion". El token largo de IG dura 60 dias y NO hay refresh (0 hits) ni updated_at →
    **la tarjeta va a decir "conectado" con el token muerto**.
40. **BUG ACTIVO, verificado en vivo**: Meta Test tiene 2 filas canal='instagram' (una activa, una
    no). Los upserts de credenciales usan .maybeSingle() SIN filtrar activo E IGNORAN el error
    (39377 callback IG, 39050 POST manual): con 2 filas → PGRST116 → data:null → INSERT → TERCERA
    fila. **El boton "Conectar Instagram" de F4 multiplica filas.** Sanear las 2 filas + arreglar
    los upserts ANTES de construir la pantalla.
41. **Ventana de 24 h IG/MSN: SIN guarda y fallo 100% silencioso para la IA** (38413-38438 no mira
    last_message_at, tira el detalle a console; 38638 la fila role='ai' queda sin marcar — con el
    DEFAULT 'enviado' del hallazgo 27, queda como entregada). El humano SI ve un 400 pero con causa
    adivinada ("ventana o token"). F7/F8 necesitan: marcar el fallo en la fila, guarda de ventana
    (last_message_at del CONTACTO), y accion (derivar/avisar).
42. **Fuga cross-canal en reintentarFallidos (18516)**: los mensajes HUMANOS rechazados por IG/MSN
    quedan 'fallido' (13537) y ese cron NO filtra channel → los reintenta POR EVOLUTION contra el
    IGSID → si Evolution devuelve key.id queda 'enviado' MENTIROSO. Necesita el mismo escape que
    Cloud (18568).
43. Escalera honesta, escalon por escalon: conectar SI (ya) · numero verificado SI pero falta pedir
    code_verification_status · display name SI pero falta pedir name_status (y persistir
    verified_name) · **tarjeta/medio de pago NO DETECTABLE por Graph** — se infiere del error 131042
    en un envio (no mapeado en _cloudApiErrorLegible) o tilde manual · portafolio PARCIAL
    (owner_business_info exige business_management, RECHAZADO en la app → tratar error como "no
    verificable") · plantillas SI (ya funciona) · envio de prueba SI pero no queda registrado
    (falta persistir).
44. **"Esperando aprobacion de Meta": NO hay API estable de permisos de la app.** Deteccion reactiva
    post-login via /debug_token granular_scopes (patron ya usado en 42978) o /me/permissions.
    Conclusion: flag manual que Diego prende + verificacion reactiva en el callback.
45. **META_IG_OAUTH_SCOPES (39204) ya pide instagram_business_manage_comments — permiso NO aprobado.**
    Puede hacer fallar el login de IG de un cliente real o devolver el token sin ese permiso.
    Revisar el string antes de liberar el boton.
46. UX del Conectar: el start navega full-page pero el callback asume POPUP (window.opener +
    window.close) → el cliente queda varado en el dominio del backend sin refresh de estado. El
    front ademas NUNCA llama a /api/meta/ig/oauth/estado (un solo oauthEstado gatea los 2 botones)
    → si falta META_IG_APP_SECRET, el boton IG muestra 503 JSON crudo. F4: popup real o
    res.redirect al front.
47. Incoherencia de permisos en la MISMA pantalla: /api/meta/credenciales lo ve cualquier asesor;
    la card Cloud es dueno-only (403). Definir: Integraciones = solo dueno (recomendado, hay tokens
    y tarjeta).
48. page.name no se persiste (39301) y la tabla no tiene columna de nombre → la tarjeta solo puede
    mostrar IDs numericos. MENOR pero visible.
49. listo_humano+ai_enabled=false se escribe ANTES del envio manual (13477): un rechazo por ventana
    deja la conv tomada y la IA apagada sin que el mensaje saliera (footgun ya documentado en 41975).
50. _reasignarRaicescrmUnaVez / _metaSanearCredenciales corren en cada boot con IDs hardcodeados y
    pueden DESACTIVAR filas → una tarjeta "activo" puede cambiar sola entre dos cargas. Documentar
    en el detector.

### Limpio
Exclusividad IG/MSN completa (indices unicos parciales + 409 + fail-closed); _resolverCredMeta
defensivo (order + log de ambiguedad); firma con timingSafeEqual y trim; el envio manual a IG/MSN
NO cae a Evolution (fail-closed 400); enviarMensajeMeta usa el host correcto por canal; gates de
gasto completos en el canal Meta; el mensaje entrante SIEMPRE se guarda antes de cualquier corte;
OAuth no auto-enciende canales; state CSRF firmado con exp; tokens enmascarados; suscripcion a
webhooks en el connect en los 3 canales.
