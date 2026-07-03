-- ============================================================================
-- MIGRACION: temperatura-tiempo
-- ----------------------------------------------------------------------------
-- Columnas nuevas para la feature GATED "temperatura por tiempo": desacopla la
-- temperatura del lead de su status y la hace BAJAR sola por inactividad
-- (caliente -> tibio -> frio), con umbrales configurables por cuenta.
--
-- TODO es idempotente (IF NOT EXISTS) y NO destruye datos. Con el flag en su
-- default (temp_decay_v2 = false) el comportamiento es BYTE-IDENTICO al actual:
-- el helper nuevaTemperaturaConDecay devuelve la propuesta por estado tal cual y
-- el cron revisarDecaimientoTemperatura hace early-return por cuenta.
--
-- NO corre sola: hay que ejecutarla a mano.
--
--   business_settings.temp_decay_v2                bool  default false   (flag ON/OFF por cuenta)
--   business_settings.temp_horas_caliente_a_tibio  int   default 48      (horas de inactividad: caliente -> tibio)
--   business_settings.temp_horas_tibio_a_frio      int   default 120     (horas ADICIONALES: tibio -> frio; el
--                                                                          umbral tibio->frio es ACUMULATIVO =
--                                                                          temp_horas_caliente_a_tibio + este valor)
--
-- Al final: NOTIFY pgrst para refrescar el schema cache de PostgREST (gotcha
-- conocido: sin esto los writes a columnas recien agregadas fallan con PGRST204).
-- ============================================================================

-- ===== Flag ON/OFF por cuenta (default false = comportamiento actual EXACTO) =====
ALTER TABLE business_settings
  ADD COLUMN IF NOT EXISTS temp_decay_v2 boolean DEFAULT false;

-- ===== Horas de inactividad para bajar de CALIENTE a TIBIO (default 48) =====
ALTER TABLE business_settings
  ADD COLUMN IF NOT EXISTS temp_horas_caliente_a_tibio integer DEFAULT 48;

-- ===== Horas ADICIONALES (despues de tibio) para bajar de TIBIO a FRIO (default 120) =====
-- El cron mide la inactividad desde la ultima actividad del lead y usa el umbral ACUMULATIVO
-- (temp_horas_caliente_a_tibio + temp_horas_tibio_a_frio) para el paso tibio -> frio.
ALTER TABLE business_settings
  ADD COLUMN IF NOT EXISTS temp_horas_tibio_a_frio integer DEFAULT 120;

-- ===== Refrescar el schema cache de PostgREST (sin esto, los writes fallan con PGRST204) =====
NOTIFY pgrst, 'reload schema';
