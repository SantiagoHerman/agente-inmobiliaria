-- ============================================================================
-- MIGRACION: switch de IA para la ACTUALIZACION AUTOMATICA (scraper inmobiliaria)
-- Fecha: 2026-07-15
--
-- QUE HACE
--   Agrega scraping_config.ia_habilitada (boolean, default false).
--   Es el permiso EXPLICITO del dueno de la cuenta para que el cron de actualizacion
--   automatica pueda usar IA (y descontar mensajes de su plan) cuando la web NO se
--   puede leer por ninguna via gratis (Tokko / JSON-LD / heuristica / sitemap).
--
-- SEGURIDAD DE DEPLOY
--   - ADD COLUMN IF NOT EXISTS -> se puede correr mas de una vez sin romper.
--   - DEFAULT false -> las cuentas que YA existen quedan con la IA APAGADA (sin gasto
--     nuevo, sin sorpresas). Es opt-in: nadie gasta hasta que lo prenda a mano.
--   - El backend es deploy-safe: si esta migracion todavia NO corrio, cfg.ia_habilitada
--     viene undefined -> se comporta como IA apagada (solo vias gratis) y el guardado de
--     la config reintenta sin la columna. O sea: se puede correr ANTES o DESPUES del deploy.
--
-- IMPORTANTE (GOTCHA CONOCIDO)
--   El NOTIFY del final NO es opcional: sin el, PostgREST sigue con el schema viejo en
--   cache y toda escritura que mencione la columna nueva falla MUDA con PGRST204.
-- ============================================================================

ALTER TABLE scraping_config
  ADD COLUMN IF NOT EXISTS ia_habilitada boolean DEFAULT false;

-- Backfill defensivo: filas viejas creadas antes del default quedan explicitamente en
-- false (no en NULL). El backend trata NULL como false igual, pero asi la DB no miente.
UPDATE scraping_config SET ia_habilitada = false WHERE ia_habilitada IS NULL;

COMMENT ON COLUMN scraping_config.ia_habilitada IS
  'Permiso del dueno para que el cron de actualizacion automatica use IA (y descuente mensajes del plan) cuando la web no se pueda leer por ninguna via gratis. Default false = opt-in.';

-- OBLIGATORIO: refrescar el cache de schema de PostgREST (sin esto -> PGRST204).
notify pgrst, 'reload schema';
