-- ============================================================================
-- MIGRACION: umbral de inactividad + horario propio de recontacto (ADITIVA)
-- ----------------------------------------------------------------------------
-- 2 columnas nuevas en business_settings, ambas OPCIONALES y con fallback al
-- comportamiento actual desde el backend (fail-safe si la columna esta ausente):
--
--   (A) recontacto_umbral_dias  -> dias de silencio del lead ANTES de pasar a
--       recontacto. Reemplaza el 72hs (3 dias) hardcodeado. Rango util 1-60;
--       DEFAULT 3 = identico al comportamiento actual. El backend clampea 1-60.
--
--   (B) recontacto_horario      -> franja propia del recontacto en texto 'HH-HH'
--       (ej '9-19'). Si esta seteado, el motor de recontacto (legacy y v2) usa
--       ESA franja para decidir horario y minutos restantes; si es NULL usa el
--       horario de oficina general (comportamiento ACTUAL EXACTO). DEFAULT NULL.
--
-- IDEMPOTENTE (IF NOT EXISTS): correr de nuevo no rompe nada.
-- Tras aplicar, refrescar el schema cache de PostgREST (NOTIFY) para que los
-- writes/reads via API vean las columnas nuevas de inmediato (gotcha conocido:
-- ADD COLUMN via Management API no refresca PostgREST -> PGRST204 silencioso).
-- ============================================================================

ALTER TABLE business_settings
  ADD COLUMN IF NOT EXISTS recontacto_umbral_dias integer DEFAULT 3;

ALTER TABLE business_settings
  ADD COLUMN IF NOT EXISTS recontacto_horario text;

-- Refrescar el cache de esquema de PostgREST (Supabase) para que la API vea las columnas nuevas.
NOTIFY pgrst, 'reload schema';
