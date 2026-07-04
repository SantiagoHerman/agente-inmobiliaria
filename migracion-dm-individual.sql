-- ============================================================================
-- MIGRACION: NOTIFICACION INDIVIDUAL POR WHATSAPP (espejo del PUSH por-usuario)  [DEFAULT OFF]
-- Correr UNA vez en el SQL Editor de Supabase (como owner). ADITIVA, cero riesgo.
-- Es IDEMPOTENTE (IF NOT EXISTS) y NO toca ninguna fila existente.
-- ----------------------------------------------------------------------------
-- Objetivo (Fase 2): cuando el backend manda un PUSH a UN usuario puntual
-- (enviarPushAsesor(authUserId,...)), ademas se le manda el MISMO texto por
-- WhatsApp a SU numero personal (si esta cargado + el flag del dueno esta ON).
-- Es un ESPEJO: NO agrega mensajes nuevos, solo duplica al canal WhatsApp los
-- avisos que YA se emiten. CERO IA (0 tokens).
--
--   asesores.whatsapp_notif        : text.    Numero personal del usuario para
--                                    recibir sus notificaciones por WhatsApp
--                                    (formato E.164 sin '+', ej. 5493700000000).
--                                    Vacio / null -> el usuario NO recibe DM (solo push).
--
--   business_settings.notif_dm_wa_on : boolean, DEFAULT false. Gate por-tenant.
--     true  -> los push por-usuario tambien se espejan por WhatsApp al numero
--              del usuario destino (si lo tiene cargado).
--     false / ausente / null -> comportamiento ACTUAL EXACTO (solo push, nada de WhatsApp).
--
-- 🔴 ANTI-BAN: manda mensajes salientes desde el numero del negocio. Por eso el
-- flag arranca OFF y es la Fase 2 riesgosa. Se espejan SOLO los push existentes
-- (best-effort): el envio nunca rompe el push (todo en try/catch en el backend).
--
-- El backend lee/escribe SIEMPRE defensivo (try/catch): funciona aunque estas
-- columnas todavia no existan (cae al comportamiento ACTUAL, flag OFF). Aislamiento
-- por tenant intacto. No toca ninguna otra tabla ni columna.
-- ============================================================================

alter table public.asesores
  add column if not exists whatsapp_notif text;

alter table public.business_settings
  add column if not exists notif_dm_wa_on boolean default false;

-- Refrescar el cache de esquema de PostgREST (gotcha conocido: ADD COLUMN via
-- Management API no refresca el cache y los reads/writes de la columna nueva
-- fallan en silencio con PGRST204 hasta este NOTIFY).
notify pgrst, 'reload schema';
