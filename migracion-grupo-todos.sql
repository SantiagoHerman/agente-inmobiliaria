-- ============================================================================
-- MIGRACION: GRUPO DE WHATSAPP "TODOS" (espejo del canal interno "Todos")  [DEFAULT OFF]
-- Correr UNA vez en el SQL Editor de Supabase (como owner). ADITIVA, cero riesgo.
-- Es IDEMPOTENTE (IF NOT EXISTS) y NO toca ninguna fila existente.
-- ----------------------------------------------------------------------------
-- Objetivo (Opcion A): el CLIENTE crea un grupo de WhatsApp con el numero del CRM
-- y lo elige aca; nosotros capturamos su JID (...@g.us). Con el flag ON, cada
-- aviso que se postea al canal interno "Todos" (rama 'general' de
-- _postearAvisoInterno) se ESPEJA como texto a ese grupo de WhatsApp. CERO IA.
--
--   business_settings.grupo_todos_jid   : text.    JID del grupo elegido (...@g.us).
--   business_settings.grupo_todos_wa_on : boolean, DEFAULT false. Gate por-tenant.
--     true  + hay JID -> el aviso del canal "Todos" tambien va al grupo de WhatsApp.
--     false / ausente / null / sin JID -> comportamiento ACTUAL EXACTO (no manda nada al grupo).
--
-- El backend lee/escribe SIEMPRE defensivo (try/catch): funciona aunque estas
-- columnas todavia no existan (cae al comportamiento ACTUAL, flag OFF). Aislamiento
-- por tenant intacto. No toca ninguna otra tabla ni columna.
-- ============================================================================

alter table public.business_settings
  add column if not exists grupo_todos_jid text;

alter table public.business_settings
  add column if not exists grupo_todos_wa_on boolean default false;

-- Refrescar el cache de esquema de PostgREST (gotcha conocido: ADD COLUMN via
-- Management API no refresca el cache y los reads/writes de la columna nueva
-- fallan en silencio con PGRST204 hasta este NOTIFY).
notify pgrst, 'reload schema';
