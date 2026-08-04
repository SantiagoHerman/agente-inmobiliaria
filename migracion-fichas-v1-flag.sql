-- ============================================================================
-- migracion-fichas-v1-flag.sql  (Diego 2026-08-04)
-- FEATURE: el PANEL de "Fichas del cliente" dentro de la ficha del contacto.
--
-- La tabla `fichas` y sus 4 endpoints ya se crearon con migracion-fichas-y-provincia.sql
-- (ya corrida). Esto agrega SOLO el interruptor por-cuenta que prende/apaga la pantalla,
-- para poder apagarla en segundos SIN un deploy si algo molesta (regla de Diego: si algo
-- sale mal, revertir limpio -- un flag ES la reversion limpia).
--
-- ALCANCE = TODO (regla 9): queda PRENDIDO en todas las cuentas actuales y en las nuevas.
-- CANDADO: "Raices Meta Test" esta congelada (business_settings.congelada = true) y NO se
-- prende. Por eso el orden es el de siempre:
--   1) ADD COLUMN ... DEFAULT false  -> todas las filas existentes (incluida la congelada)
--      nacen en false.
--   2) UPDATE ... = true WHERE congelada IS DISTINCT FROM true -> prende solo las NO
--      congeladas (cubre tambien NULL). La congelada queda OFF.
--   3) ALTER COLUMN ... SET DEFAULT true -> recien ahora las cuentas NUEVAS nacen ON.
-- (Poner DEFAULT true en el ADD backfillearia la congelada y el UPDATE ya no la apagaria.)
--
-- FAIL-CLOSED: mientras esta columna no exista, el helper del backend devuelve OFF, los
-- endpoints /api/fichas responden 409 y el panel no se dibuja. O sea: sin correr esto, el
-- sistema queda BYTE-IDENTICO a hoy.
--
-- Idempotente: se puede re-correr sin efecto.
-- ============================================================================

ALTER TABLE public.business_settings ADD COLUMN IF NOT EXISTS fichas_v1 boolean DEFAULT false;
UPDATE public.business_settings SET fichas_v1 = true WHERE congelada IS DISTINCT FROM true;
ALTER TABLE public.business_settings ALTER COLUMN fichas_v1 SET DEFAULT true;

-- Refrescar el schema cache de PostgREST. Sin esto la columna existe en la base pero la API
-- sigue sin verla y las lecturas fallan con PGRST204 (gotcha conocido del proyecto).
NOTIFY pgrst, 'reload schema';

-- ---------------------------------------------------------------------------
-- VERIFICACION — deberia dar: prendidas = todas menos la congelada, apagadas = 1
-- ---------------------------------------------------------------------------
SELECT
  count(*) FILTER (WHERE fichas_v1 IS TRUE)  AS cuentas_con_fichas,
  count(*) FILTER (WHERE fichas_v1 IS NOT TRUE) AS cuentas_sin_fichas,
  count(*)                                    AS total_cuentas
FROM public.business_settings;
