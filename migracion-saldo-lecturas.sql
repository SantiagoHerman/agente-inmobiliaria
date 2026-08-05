-- ============================================================================
-- migracion-saldo-lecturas.sql  (Diego 2026-08-05)
-- Historial de LECTURAS REALES del saldo de Anthropic, para que el panel deje de
-- mostrar solo una estimacion y se pueda medir cuanto se desvia el calculo.
--
-- POR QUE: hasta hoy el Maestro guardaba UN solo numero (superadmin_config.saldo_cargado)
-- y estimaba el resto restando el consumo. Dos problemas medidos el 2026-08-05:
--   1) Estaban cargados 100 dolares que en realidad eran el LIMITE DE GASTO MENSUAL de la
--      consola, no un saldo comprado -> el panel mostraba US$ 99,16 restantes cuando
--      quedaban US$ 7,46. Inflado en US$ 91,70 y nadie podia notarlo.
--   2) No habia forma de saber si el calculo se desviaba de lo que Anthropic cobra.
--      (Medido contra la facturacion real: el desvio es 0,9%, o sea el calculo esta bien.
--       Pero eso recien se supo cuando se comparo.)
--
-- Cada fila guarda LO QUE ESTABAMOS ESTIMANDO en el momento de la lectura, asi la
-- diferencia contra el valor real queda registrada sola, lectura a lectura.
--
-- Idempotente. ADITIVO: nada de lo que hoy funciona consulta esta tabla.
-- ============================================================================

CREATE TABLE IF NOT EXISTS saldo_lecturas (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  leido_at             timestamptz NOT NULL DEFAULT now(),
  saldo_real_usd       numeric NOT NULL,        -- lo que dice la consola de Anthropic
  estimado_previo_usd  numeric,                 -- lo que el panel estimaba justo antes (null en la 1a lectura)
  desvio_usd           numeric,                 -- estimado_previo - real. Positivo = estabamos optimistas
  gasto_mes_usd        numeric,                 -- "gastado" del mes que muestra la consola (opcional)
  gasto_mes_calculado  numeric,                 -- lo que calculabamos para el mismo periodo (opcional)
  nota                 text,
  created_at           timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS saldo_lecturas_fecha_idx ON saldo_lecturas (leido_at DESC);

-- Sin RLS a proposito: es una tabla del MAESTRO (no multi-tenant, no la toca ningun cliente).
-- El backend la lee y escribe con la service key, detras de maestroAuth + requiereSeccion('consumo').

NOTIFY pgrst, 'reload schema';

-- ---------------------------------------------------------------------------
-- Semilla: la lectura que ya se hizo a mano el 2026-08-05 (saldo real US$ 7,46 cuando
-- el panel estimaba US$ 99,16 por tener cargado el limite de gasto en vez del saldo).
-- ---------------------------------------------------------------------------
INSERT INTO saldo_lecturas (leido_at, saldo_real_usd, estimado_previo_usd, desvio_usd, gasto_mes_usd, gasto_mes_calculado, nota)
SELECT now(), 7.46, 99.16, 91.70, 10.71, 10.62,
       'Primera lectura. El panel tenia cargado 100 (era el LIMITE de gasto mensual, no un saldo). Gasto del mes: real 10,71 vs calculado 10,62 = 0,9% de desvio.'
WHERE NOT EXISTS (SELECT 1 FROM saldo_lecturas);

SELECT count(*) AS lecturas_cargadas FROM saldo_lecturas;
