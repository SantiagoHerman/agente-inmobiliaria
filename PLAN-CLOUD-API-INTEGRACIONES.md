# PLAN — WhatsApp Cloud API funcional dentro de Raíces + el camino a Instagram/Messenger

**Diego, 2026-08-11.** Consolidado de todo lo definido el 10 y 11 de agosto. Regla madre, textual:
*"todo debe seguir igual como funciona ahora"* — **Evolution no se toca en ninguna fase.**

## El diseño en una línea

Cloud API es un **megáfono** para Recontacto y Oportunidades (no publicidad, no número principal).
La plantilla paga golpea la puerta; la conversación se vuelca al **WhatsApp Business** (Evolution),
donde no hay ventana de 24 h ni costo. Instagram y Messenger suman leads que también terminan ahí.

## Hechos verificados que sostienen el plan (no suposiciones)

| Hecho | Dónde se verificó |
|---|---|
| Cloud API y Evolution comparten llave (teléfono) → mismo contacto/conversación solos | server.js:12172 y :42158, ambos `obtenerOcrearConvDeCanal(user_id, telefono, 'whatsapp', …)` |
| Si la conv NO nació por Cloud, la IA contesta por Evolution | `canal_origen` (~server.js:41979): `'cloud'` o null; el router ya lo hace |
| Mensajes no-plantilla dentro de ventana abierta: **gratis**. Recibir: gratis. Servicio: gratis | docs de precios de Meta (per-message desde 1/7/2025) |
| Plantilla MARKETING: **siempre paga**. La paga el cliente directo a Meta (Tech Provider) | docs Meta + modelo ya construido (cloud_api_numbers.token por tenant) |
| Links wa.me en plantillas: **rechazo automático** | política de Meta, múltiples fuentes |
| Coexistencia: **descartada** — rompe Evolution (desvincula dispositivos, webhooks a medias) | docs Meta + experiencias de usuarios |
| Plantillas se aprueban **por WABA** (por cliente), no por app; el Tech Provider puede crearlas por API | docs Message Templates |
| Backend Cloud API ya construido: 9 endpoints + registro insertado (config 1562398828709758) | server.js:42469-42940; probado en Meta Test (1 número, 9 plantillas, 5 aprobadas) |
| IG/Messenger: ventana de 24 h SIN plantillas para reabrir → **recontacto imposible** | política de mensajería de Meta |
| El cron de inactividad NO filtra por canal → **bug latente** (mandaría recontacto a un IGSID) | revisarInactividad (server.js:16809): 0 menciones de `channel` |
| Revive de cerrado ya existe (REGLA 22): cerrado que escribe → en_conversacion | server.js:12555, verificado en vivo el 8/8 |
| App Meta "Raices": WhatsApp aprobado; IG (2) + pages (3) + business_management (1) rechazados SOLO por el video | consola App Review, leída el 10/8 |

## Decisiones de Diego (textuales)

- Recontacto: **tope 20/día** — *"pasados los 20 riesgo de baneo y queda en rojo el numero porque no puedo asegurar nada"*
- Oportunidades: **tope 10/día** — *"no mas el resto queda en rojo"*
- Oportunidades y Recontacto: **2 botones arriba** — WhatsApp Business predeterminado con el número vinculado visible / Cloud API con las plantillas aprobadas apareciendo a medida que se aprueban
- Catálogo de **20-30 plantillas** para que el cliente elija y mande a aprobación sin salir de Raíces
- El pase: pedir por TEXTO que escriba al otro número (ej. *"escribinos al +54… para comunicarte con ventas"*); si no escribe en X tiempo, mensaje **breve, humano, distinto cada vez, sin plantilla** desde la línea comercial (*"Hola Pablo, te escribo desde la línea comercial de Anton para derivarte con un asesor"*)
- Conversaciones: **4 listados** — WhatsApp Business (default) / Cloud API / Instagram / Messenger, cada conversación con su etapa y estado
- IG/Messenger: mismas etapas (en_conversacion / interesado / listo_humano); **sin recontacto**; inactividad → **cerrado**, con revive si vuelve a escribir

## Supuestos asumidos (Diego puede cambiarlos)

1. **X tiempo** del mensaje de línea comercial: 2 h dentro del horario de oficina; fuera de horario → mañana siguiente
2. Catálogo de plantillas vive en **Integraciones**; Oportunidades/Recontacto solo muestran el selector de aprobadas + atajo
3. Los 4 listados = **pestañas sobre la bandeja única** (nada queda escondido; los avisos siguen viendo todo)
4. El pase es **un solo hilo** (mismo contacto), sin recapitular la charla anterior
5. Tope del pase a línea comercial: **10/día**

---

# LAS FASES

## FASE 0 — Verificaciones previas (solo lectura; necesita el Chrome de Diego)
- Leer el **rate card de Argentina** en la consola de Meta (precio real de la plantilla MARKETING). Es el número que falta para el presupuesto; el ~USD 0,06 anotado es de julio, SIN verificar.
- Confirmar el webhook de estado de plantillas (`message_template_status_update`) llegando al backend.

## FASE 1 — Topes duros con el rojo (protege Evolution HOY; no depende de Cloud API)
- Backend: tope diario POR CUENTA en los motores: recontacto **20/día**, oportunidades **10/día**. Corte en el cron (no solo visual). `oportunidades` ya tiene `enviados_hoy`; recontacto necesita su contador diario.
- Front: contador "X de 20 hoy" + estado ROJO con el texto de Diego cuando se alcanza; lo excedente queda en cola para mañana, marcado.
- Gate patrón correcto (sin default + `IS NOT FALSE`), Meta Test afuera.

## FASE 2 — Conversaciones: pestañas por canal
- 4 pestañas: WhatsApp Business (default) / Cloud API / Instagram / Messenger.
- Filtros: `channel=whatsapp & canal_origen is null` / `canal_origen='cloud'` / `channel=instagram` / `channel=messenger`. Hoy: 1383 / 1 / 2 / 1.
- Etiqueta del canal en cada tarjeta. Todo sobre la bandeja única existente (misma detección de sonidos/avisos).

## FASE 3 — Arreglos obligatorios pre-envío
- **3a.** `enviarPlantillaCloud` y `enviarTextoCloud` actualizan `messages.estado_envio` + guardan `wa_message_id` (tildes ✓✓). Sin esto, todo envío masivo queda en "enviando" para siempre.
- **3b. El bug latente del cron:** `revisarInactividad` y los motores de envío EXCLUYEN `channel in (instagram, messenger)`. En su lugar: inactividad en IG/MSN → **cerrado** (motivo `inactividad_canal_sin_recontacto`), con el revive ya existente. Registrar en el historial de estados.

## FASE 4 — Integraciones: la pantalla del trámite
- Sección nueva "Integraciones" con tarjeta **WhatsApp Cloud API**: escalera de 7 pasos con estado (portafolio → conectar [botón registro insertado, ya existe] → número verificado → nombre aprobado → tarjeta cargada → plantilla aprobada → envío de prueba). Detector de "dónde estás trabado" leyendo `/api/cloud-api/estado` + Graph.
- **El camino a IG/Messenger:** tarjetas de Instagram y Messenger en la misma pantalla, con su botón Conectar (los flujos OAuth YA existen: `/api/meta/oauth/start` y `/api/meta/ig/oauth/start`) y estado "esperando aprobación de Meta" mientras los 6 permisos sigan rechazados. Cuando Meta apruebe, se prenden solas.

## FASE 5 — Catálogo de plantillas (20-30)
- Redacción de 20-30 plantillas es_AR (recontacto, oportunidades, seguimiento; variables `{{1}}`; categoría MARKETING/UTILITY bien elegida; SIN links wa.me).
- Catálogo central (tabla nueva) + UI en Integraciones: el cliente tilda cuáles quiere → push por API a SU WABA → estado por cliente (pendiente/aprobada/rechazada + la categoría QUE META DEVUELVE, que puede diferir de la pedida).
- Migración: tabla `plantillas_catalogo` (por el Chrome de Diego).

## FASE 6 — Botones de origen en Oportunidades y Recontacto
- Oportunidades: botones [WhatsApp Business ●] / [Cloud API] arriba, número visible en cada uno. Con Cloud: selector SOLO de plantillas aprobadas de esa cuenta + variables; el motor manda `enviarPlantillaCloud` en vez de texto libre. Topes de Fase 1 aplican por canal.
- Recontacto: mismo par de botones (aunque el uso esperado es WhatsApp Business).
- Las 3 oportunidades existentes siguen en texto libre por WhatsApp Business (sin cambios).

## FASE 7 — El pase a la línea comercial
- Marca `pase_pedido_at` cuando la IA (por Cloud/IG/MSN) pide que escriba al WhatsApp Business.
- Trigger: si no escribió en X (supuesto 1), mensaje breve/humano/variado por Evolution desde la línea comercial. Tope 10/día + rojo. Prompt: modo "primer mensaje de línea comercial" — usa la info del lead SIN recapitular.
- En IG/MSN la IA pide el WhatsApp TEMPRANO (el reloj de 24 h corre y no hay recuperación).

## CARRIL APARTE — App Review de Meta (desbloquea IG/Messenger de verdad)
- Escribir los 2 guiones de video (Messenger con login Facebook; Instagram con login Instagram): login completo, usuario con acceso, ida y vuelta de mensajes, interfaz EN INGLÉS (el panel ya tiene i18n con 'en'), subtítulos.
- Incluir `instagram_business_manage_comments` en el próximo envío (está en la app, nunca se pidió).
- Grabar: Diego. Enviar: desde su consola.

## Reglas transversales
- Evolution intacto en TODO el recorrido. Meta Test afuera de todo.
- Secuencial (sin agentes paralelos en el mismo repo). Commit + rama por fase. Backup/rollback antes de tocar datos. Migraciones por el Chrome de Diego. `node --check` + build + salud tras cada deploy.
- Gates nuevos: patrón sin-default + `IS NOT FALSE` para mejoras; `cloud_api_v1` sigue siendo preferencia por cuenta.
- 🔴 Los envíos de plantillas los paga EL CLIENTE a Meta → el tope duro en backend va ANTES que cualquier botón de envío (orden de las fases lo garantiza).

## Qué necesita Diego hacer
1. El **dale** a este plan.
2. Chrome abierto para: rate card (Fase 0) y migraciones (Fases 5/7).
3. Grabar los 2 videos con mis guiones (carril aparte, cuando quiera).
