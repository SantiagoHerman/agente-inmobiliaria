-- ============================================================================
-- MIGRACION: Scraper de DESARROLLO v2 — actualizacion por emprendimiento
-- ----------------------------------------------------------------------------
-- Agrega a `developments` las columnas para GUARDAR la URL de origen del
-- emprendimiento y configurar su auto-actualizacion por scraping POR
-- EMPRENDIMIENTO (opt-in, default OFF, conservador).
--
--   source_url        text          -- URL de la pagina del emprendimiento a re-scrapear
--   auto_scrape       boolean FALSE -- OPT-IN: si el cron lo actualiza solo (default OFF)
--   scrape_cada_horas int     24    -- cada cuantas horas re-scrapear (default 24hs, conservador)
--   ultimo_scrape     timestamptz   -- ultima vez que se actualizo por scraping (lo setea el backend)
--
-- 🔴 COSTO: con auto_scrape=true el cron corre Sonnet + hasta 5 imagenes (vision)
--    por emprendimiento cada scrape_cada_horas. Por eso el DEFAULT es OFF y 24hs.
--    El cron (revisarScrapingsDesarrollo) esta gateado: si estas columnas no existen
--    todavia, el query falla y NO corre nada (no rompe el server).
--
-- IDEMPOTENTE (ADD COLUMN IF NOT EXISTS): se puede correr mas de una vez sin romper.
-- NO borra ni reescribe datos existentes. NO toca RLS ni otras tablas.
-- ============================================================================

ALTER TABLE developments
  ADD COLUMN IF NOT EXISTS source_url        text,
  ADD COLUMN IF NOT EXISTS auto_scrape       boolean     DEFAULT false,
  ADD COLUMN IF NOT EXISTS scrape_cada_horas integer     DEFAULT 24,
  ADD COLUMN IF NOT EXISTS ultimo_scrape     timestamptz;

-- Indice de apoyo para el cron (busca los que tienen auto_scrape=true).
CREATE INDEX IF NOT EXISTS idx_developments_auto_scrape
  ON developments (auto_scrape)
  WHERE auto_scrape = true;

-- ============================================================================
-- Refrescar el cache de esquema de PostgREST
--   (gotcha conocido: ADD COLUMN via API no refresca el cache y los writes
--    fallan en silencio con PGRST204 hasta este NOTIFY)
-- ============================================================================
NOTIFY pgrst, 'reload schema';
