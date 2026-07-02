-- ============================================================================
-- MIGRACION: derivacion-v3-refinements
-- ----------------------------------------------------------------------------
-- Columnas nuevas para los refinamientos de la feature GATED "derivacion-v3"
-- (flag business_settings.derivacion_v3, default OFF). TODO es idempotente
-- (IF NOT EXISTS) y NO destruye datos. NO corre sola: hay que ejecutarla a mano.
--
-- Tarea 1 (toggle "avisar al equipo al rotar"):
--   business_settings.derivacion_avisar_equipo  bool default true
-- Tarea 3 (avisar al dueno a los N min sin nadie disponible, en horario de oficina):
--   business_settings.derivacion_aviso_dueno_min int  default 30
--   conversations.derivacion_aviso_dueno         bool default false  (dedupe: 1 aviso)
-- Tarea F (atribucion de autor en los mensajes humanos; NO gated, aditiva):
--   messages.autor_asesor_id  uuid   (id de la fila en asesores; null si no aplica)
--   messages.autor_nombre     text   (nombre visible del que escribio)
--
-- Al final: NOTIFY pgrst para refrescar el schema cache de PostgREST (gotcha
-- conocido: sin esto los writes a columnas recien agregadas fallan con PGRST204).
-- ============================================================================

-- ===== Tarea 1: toggle "avisar al equipo al rotar" (default true = comportamiento actual) =====
ALTER TABLE business_settings
  ADD COLUMN IF NOT EXISTS derivacion_avisar_equipo boolean DEFAULT true;

-- ===== Tarea 3: minutos en horario de oficina sin nadie antes de avisar al dueno (default 30) =====
ALTER TABLE business_settings
  ADD COLUMN IF NOT EXISTS derivacion_aviso_dueno_min integer DEFAULT 30;

-- ===== Tarea 3: dedupe del aviso al dueno (una sola vez por rotacion) =====
ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS derivacion_aviso_dueno boolean DEFAULT false;

-- ===== Tarea F: atribucion de autor en los mensajes humanos (NO gated, aditiva/defensiva) =====
ALTER TABLE messages
  ADD COLUMN IF NOT EXISTS autor_asesor_id uuid;
ALTER TABLE messages
  ADD COLUMN IF NOT EXISTS autor_nombre text;

-- ===== Refrescar el schema cache de PostgREST (sin esto, los writes fallan con PGRST204) =====
NOTIFY pgrst, 'reload schema';
