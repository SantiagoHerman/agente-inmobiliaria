-- ============================================================================
-- MIGRACION: DEPARTAMENTO DE MARKETING IA — FASE 0 (generacion de contenido
--            por TEXTO)                                              [DEFAULT OFF]
-- ----------------------------------------------------------------------------
-- NO EJECUTAR automaticamente: la corre el supervisor a mano en el SQL Editor
-- de Supabase (como owner). Es IDEMPOTENTE (IF NOT EXISTS) y NO toca ninguna
-- fila existente. El backend lee/escribe SIEMPRE defensivo (gate fail-safe):
-- funciona aunque esta columna todavia no exista (marketingIaActivo devuelve
-- false -> el endpoint /api/marketing/generar responde 403 y NO llama a Claude,
-- cero gasto). TODO opt-in por cuenta via el flag marketing_ia (default false).
--
-- QUE HABILITA (solo con marketing_ia=true por cuenta):
--   El endpoint POST /api/marketing/generar deja generar, con Claude (Haiku =
--   MODELO_INTERNO), contenido de marketing por TEXTO: copy/captions de redes,
--   descripcion de una propiedad del inventario, calendario de contenido, guion
--   de video corto y texto libre a partir de un prompt. Cada generacion cobra
--   1 mensaje IA del cupo del cliente (registrarUsoIA) y registra el costo real
--   (registrarUsoTokens). Con el flag OFF (o esta columna ausente) el endpoint
--   devuelve 403 y NO llama a Claude -> comportamiento byte-identico y CERO gasto.
--
-- Aislamiento multi-tenant: no requiere tablas nuevas; el flag vive en
-- business_settings (una fila por cuenta) y el backend accede con la service key
-- filtrando por user_id. Por eso no se crean policies.
--
-- GOTCHA OBLIGATORIO (MEMORY: supabase-migraciones-cache): tras cada ADD COLUMN
-- hay que hacer NOTIFY pgrst 'reload schema' o los reads de lo nuevo fallan EN
-- SILENCIO con PGRST204. El NOTIFY va al final.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- FLAG POR-CUENTA que GATEA TODO el comportamiento nuevo. DEFAULT false (OFF).
-- Fail-safe: si esta columna no existe, marketingIaActivo() devuelve false -> OFF.
-- ---------------------------------------------------------------------------
ALTER TABLE business_settings
  ADD COLUMN IF NOT EXISTS marketing_ia boolean DEFAULT false;

-- ---------------------------------------------------------------------------
-- GOTCHA Supabase: ADD COLUMN via Management API NO refresca el schema cache de
-- PostgREST -> los reads de la columna nueva fallan en silencio (PGRST204) hasta
-- recargar. Forzar el reload del esquema (si se corre por SQL editor, igual no molesta).
-- ---------------------------------------------------------------------------
NOTIFY pgrst, 'reload schema';
