-- ============================================================================
-- E1 — PRIORIDAD DE COLA DE RECONTACTO: primero los leads que CHARLARON de verdad.
-- Plan: PLAN-RECONTACTO-CON-MEMORIA.md
--
-- NO CAMBIA NADA POR SI SOLA: la columna nace en FALSE (fail-closed). Con FALSE el
-- orden de la cola v2 es BYTE-IDENTICO al de hoy y ni siquiera se hace la query extra.
-- Recien al poner TRUE en una cuenta, el motor v2 pone adelante a las conversaciones
-- donde el lead escribio de verdad (messages.role='contact' con origen <> 'historial_importado'),
-- que son las UNICAS donde mensajeRecontactoIA puede armar un mensaje personalizado.
--
-- Contexto medido en Anton el 2026-08-05 (solo SELECT):
--   1.092 conversaciones en 'recontacto' con recontacto_categoria='viejo'
--     -> solo 148 tienen un mensaje real del lead; 944 nunca escribieron
--     -> 'viejo' lo pone el CHECKBOX del importador de CSV, no el hecho de haber escrito
-- ============================================================================

ALTER TABLE business_settings
  ADD COLUMN IF NOT EXISTS recontacto_prio_charla boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN business_settings.recontacto_prio_charla IS
  'E1: en la cola de recontacto v2, priorizar las conversaciones donde el lead escribio de verdad (no importados). Default false = orden historico.';

-- PostgREST no refresca el schema cache al agregar una columna (PGRST204).
NOTIFY pgrst, 'reload schema';

-- Verificacion (solo lectura):
-- SELECT user_id, recontacto_v2, recontacto_textos_v2, recontacto_prio_charla
--   FROM business_settings WHERE recontacto_v2 = true;
