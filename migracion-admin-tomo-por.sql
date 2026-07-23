-- ============================================================================
-- MIGRACION: admin-tomo-por
-- ----------------------------------------------------------------------------
-- FIX #3 (Diego 2026-07-23): conversations.admin_tomo es un boolean que dice
-- "un admin tomo este lead" pero NO dice QUIEN. Resultado: la seccion "Mis
-- leads" de Conversaciones le mostraba los leads tomados por CUALQUIER admin
-- a TODOS los admins de la cuenta (se mezclaban entre administradores).
--
-- Columna nueva:
--   conversations.admin_tomo_por  uuid  (auth uid del que tomo el lead)
--
-- Deploy-safe / idempotente (IF NOT EXISTS), NO destruye datos y NO corre
-- sola: hay que ejecutarla a mano. Hasta que corra, el backend escribe
-- admin_tomo_por en un update APARTE best-effort (falla solo ese write, el
-- flujo actual sigue intacto) y el front trata admin_tomo_por ausente/null
-- como "lead viejo" -> se muestra como hoy (compat). Los leads NUEVOS quedan
-- filtrados por quien los tomo.
--
-- Al final: NOTIFY pgrst para refrescar el schema cache de PostgREST (gotcha
-- conocido: sin esto los writes a columnas recien agregadas fallan con PGRST204).
-- ============================================================================

-- ===== QUIEN tomo el lead (auth uid). NULL = lead viejo / tomado antes de la migracion =====
ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS admin_tomo_por uuid;

-- ===== Refrescar el schema cache de PostgREST (sin esto, los writes fallan con PGRST204) =====
NOTIFY pgrst, 'reload schema';
