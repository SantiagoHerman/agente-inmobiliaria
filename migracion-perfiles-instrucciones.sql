-- ============================================================================
-- Migracion: PERFILES DE INSTRUCCIONES DEL AGENTE (Fase 1 - storage)
-- Correr UNA vez en el SQL Editor de Supabase (como owner / service key).
-- ADITIVO e IDEMPOTENTE. NO crea tablas nuevas ni toca datos existentes.
-- ----------------------------------------------------------------------------
-- Un "perfil" = un SET de instrucciones del agente CON NOMBRE, guardable y
-- seleccionable, que vive como una capa EXTRA sobre lo que el cliente ya tiene.
--
-- Se agregan DOS columnas a business_settings:
--
--   instruccion_perfiles : jsonb  (DEFAULT NULL)
--       Array de perfiles: [ { id, nombre, items:[...], updated_at } ].
--       Cada 'items' tiene la MISMA forma que business_settings.instrucciones_agente.items
--       ({ id, categoria, texto, activo, es_sistema, orden }). NULL/ausente => sin
--       perfiles extra => el cliente sigue usando SOLO instrucciones_agente ("Agente
--       principal") => comportamiento ACTUAL EXACTO.
--
--   perfil_activo_id : text  (DEFAULT NULL)
--       Id del perfil ACTIVO de la cuenta (la IA principal usa ESE set).
--       NULL (o id inexistente) => se usa instrucciones_agente ("Agente principal")
--       => comportamiento ACTUAL EXACTO. NO es FK: los ids viven dentro del jsonb.
--
-- Es A PRUEBA DE FALLOS: con ambas columnas en NULL, instruccionesAgenteItems()
-- resuelve el set "Agente principal" de siempre (byte-identico). Un perfil solo
-- MANDA cuando el dueno lo activa (perfil_activo_id) o cuando un usuario IA lo
-- elige (asesores.agente_config.perfil_id -> agenteConfig.perfilId).
--
-- El perfil por-usuario-IA NO necesita migracion de esquema: perfil_id vive dentro
-- del jsonb libre asesores.agente_config (ya existente). Se documenta aca por claridad.
-- ============================================================================

alter table public.business_settings
  add column if not exists instruccion_perfiles jsonb;

alter table public.business_settings
  add column if not exists perfil_activo_id text;

-- Refrescar el cache de esquema de PostgREST (gotcha conocido: ADD COLUMN via API
-- no refresca el cache y los reads/writes de la columna nueva fallan en silencio
-- con PGRST204 hasta este NOTIFY).
notify pgrst, 'reload schema';
