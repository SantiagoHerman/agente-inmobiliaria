-- ============================================================================
-- MIGRACION: DERIVACION v3 (Sonnet decide + rotacion + "el que escribe = señal")
--                                                                   [DEFAULT OFF]
-- ----------------------------------------------------------------------------
-- NO EJECUTAR automaticamente: la corre el supervisor a mano.
-- Es IDEMPOTENTE (IF NOT EXISTS) y NO toca ninguna fila existente. El backend lee
-- /escribe SIEMPRE defensivo (try/catch + reintento sin la columna + Set/guard en
-- memoria): funciona aunque estas columnas todavia no existan (cae al comportamiento
-- ACTUAL EXACTO). TODO opt-in por cuenta via el flag derivacion_v3 (default false).
--
-- QUE HABILITA (solo con derivacion_v3=true por cuenta):
--   1) La tool derivar_a_humano se le OFRECE al agente (Sonnet). Cuando decide pasar
--      el lead a un asesor, la llama (no solo lo promete por texto).
--   2) El sistema ROTA: asigna un asesor disponible del depto, avisa al equipo, y la
--      IA SIGUE atendiendo (ai_enabled=true, status='interesado') hasta que un humano
--      ESCRIBA en la conversacion (ahi -> listo_humano + IA off, deja de rotar).
--   3) Si el asesor asignado no escribe en derivacion_espera_min (default 10) minutos,
--      el cron ROTA al siguiente disponible. Sin tope (el lead nunca queda solo).
-- Con el flag OFF (o estas columnas ausentes) NADA de esto corre: el camino actual
-- (clasificador Haiku -> derivarAHumano) queda BYTE-IDENTICO.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- FLAG POR-CUENTA que GATEA TODO el comportamiento nuevo. DEFAULT false (OFF).
-- Fail-safe: si esta columna no existe, derivacionV3Activo() devuelve false -> OFF.
-- ---------------------------------------------------------------------------
ALTER TABLE business_settings
  ADD COLUMN IF NOT EXISTS derivacion_v3 boolean DEFAULT false;

-- Minutos de espera antes de ROTAR al siguiente usuario disponible del depto.
-- DEFAULT 10. El backend valida 1..240 (fuera de rango / ausente -> 10).
ALTER TABLE business_settings
  ADD COLUMN IF NOT EXISTS derivacion_espera_min integer DEFAULT 10;

-- ---------------------------------------------------------------------------
-- Columnas de la conversacion que trackean la ROTACION (todas DEFENSIVAS). Si no
-- existen, el backend reintenta los SELECT sin ellas y los guards quedan en no-op
-- (comportamiento ACTUAL). No dependen unas de otras.
-- ---------------------------------------------------------------------------

-- Marca que la conv esta EN ROTACION (la IA sigue atendiendo; el cron la reevalua).
-- Los crons de inactividad / respaldo / escalado la EXCLUYEN mientras este true.
ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS derivacion_rotando boolean DEFAULT false;

-- Departamento objetivo de la rotacion (para reevaluar disponibilidad sin re-clasificar,
-- 0 IA). Puede ser null si no se pudo deducir (ahi la rotacion usa el pool general).
ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS derivacion_depto_id uuid;

-- Timestamp del ULTIMO intento (asignacion/rotacion). El cron mide contra este valor:
--   - si un humano escribio DESPUES -> finaliza (tomo el lead);
--   - si venció el timer (derivacion_espera_min) sin que escribiera -> rota al siguiente.
ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS derivacion_ultimo_intento timestamptz;

-- ---------------------------------------------------------------------------
-- GOTCHA Supabase: ADD COLUMN via Management API NO refresca el schema cache de
-- PostgREST -> los writes a la columna nueva fallan en silencio (PGRST204) hasta
-- recargar. Forzar el reload del esquema (si se corre por SQL editor, igual no molesta).
-- ---------------------------------------------------------------------------
NOTIFY pgrst, 'reload schema';
