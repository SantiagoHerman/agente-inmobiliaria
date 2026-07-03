-- ============================================================================
-- MIGRACION: Cola de TRABAJOS DE SCRAPING EN SEGUNDO PLANO (scrape_jobs)
-- ----------------------------------------------------------------------------
-- Feature: el scrape de DESARROLLO corre como TRABAJO EN SEGUNDO PLANO del
-- servidor. El usuario lo dispara (POST /api/scrape/desarrollo/job), sale de la
-- pagina, vuelve, y sigue corriendo (no depende del navegador). El runner del
-- server (cron procesarScrapeJobs) toma los jobs 'pendiente', los procesa de a
-- uno y va actualizando estado/progreso/mensaje.
--
-- Como los jobs viven en la DB, sobreviven a que el usuario cierre el navegador
-- Y a reinicios del server (los 'pendiente' se retoman en el proximo tick).
--
-- 🔴 COSTO: cada job de scrape corre Sonnet + vision (~10-40s). Por eso el runner
--    procesa DE A UNO (no en paralelo) para no disparar el gasto/carga.
--
-- IDEMPOTENTE (CREATE TABLE/INDEX IF NOT EXISTS): se puede correr mas de una vez.
-- ADITIVO: NO toca otras tablas ni RLS. El backend gatea defensivo: si esta tabla
-- no existe todavia, los endpoints devuelven un error claro y el cron sale en
-- silencio (no rompe el server).
-- ============================================================================

CREATE TABLE IF NOT EXISTS scrape_jobs (
  id             uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        uuid        NOT NULL,
  tipo           text,                              -- 'desarrollo_nuevo' | 'desarrollo_update'
  input          jsonb,                             -- ej. {url} o {development_id, source_url}
  estado         text        DEFAULT 'pendiente',   -- 'pendiente' | 'corriendo' | 'listo' | 'error'
  progreso       integer     DEFAULT 0,
  mensaje        text,                              -- que esta haciendo: "Bajando la pagina..."
  resultado      jsonb,                             -- la estructura scrapeada o el resumen del update
  development_id uuid,                              -- opcional (lo setea el update)
  error          text,
  created_at     timestamptz DEFAULT now(),
  updated_at     timestamptz DEFAULT now()
);

-- Indice para listar los jobs de un usuario (los mas nuevos primero).
CREATE INDEX IF NOT EXISTS idx_scrape_jobs_user_estado_created
  ON scrape_jobs (user_id, estado, created_at DESC);

-- Indice para el runner (busca el 'pendiente' mas viejo, global).
CREATE INDEX IF NOT EXISTS idx_scrape_jobs_estado_created
  ON scrape_jobs (estado, created_at);

-- ============================================================================
-- Refrescar el cache de esquema de PostgREST
--   (gotcha conocido: crear tabla via API no refresca el cache y los reads/writes
--    fallan en silencio con PGRST205/PGRST204 hasta este NOTIFY)
-- ============================================================================
NOTIFY pgrst, 'reload schema';
