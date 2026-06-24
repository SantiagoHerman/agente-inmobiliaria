-- ============================================================================
-- MIGRACION: AVISOS INTERNOS DE LA IA (config a nivel cuenta)  [DEFAULT OFF]
-- ----------------------------------------------------------------------------
-- Agrega una columna jsonb a business_settings para guardar la config de los 3
-- avisos internos (texto fijo + SQL, SIN llamadas de IA, costo 0 tokens). TODO
-- opt-in: el default es OFF; nada se prende ni gasta hasta que el dueno lo active.
--
-- NO EJECUTAR automaticamente: la corre el supervisor a mano.
-- Es IDEMPOTENTE (IF NOT EXISTS) y NO toca ninguna fila existente: el backend
-- lee SIEMPRE defensivo (si la columna o la key no existe => off).
--
-- Forma del jsonb (avisos_internos):
--   {
--     "no_resuelve": false,
--     "lead_caliente": { "on": false, "minutos": 20 },
--     "resumen":       { "on": false, "hora": "20:00" }
--   }
-- ============================================================================

ALTER TABLE business_settings
  ADD COLUMN IF NOT EXISTS avisos_internos jsonb;

-- (OPCIONAL) Columnas de soporte para los avisos #2 y #3, todas DEFENSIVAS:
--   - conversations.derivado_at: momento de la derivacion a humano (lead caliente).
--   - conversations.aviso_caliente_enviado: dedupe persistente del aviso #2.
--   - business_settings.aviso_resumen_fecha: ultima fecha (YYYY-MM-DD) en que se
--     posteo el resumen diario (dedupe del aviso #3, uno por dia por cuenta).
-- El backend funciona aunque estas columnas NO existan (cae a updated_at / Set en
-- memoria). Se incluyen para un dedupe persistente mas robusto.

ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS derivado_at timestamptz;

ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS aviso_caliente_enviado boolean DEFAULT false;

ALTER TABLE business_settings
  ADD COLUMN IF NOT EXISTS aviso_resumen_fecha text;
