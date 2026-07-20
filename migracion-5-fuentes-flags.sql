-- ============================================================================
-- MIGRACION: flags de las 5 fuentes externas de la IA (dolar / clima / feriados
-- / georef / distancia). La corre el HUMANO en Supabase (el agente NO tiene acceso).
--
-- Contexto: cada tool nueva se gatea por SU flag propio en business_settings. El
-- codigo es FAIL-CLOSED: mientras la columna no exista, el helper devuelve OFF y la
-- tool NO se ofrece (prompt+flujo BYTE-IDENTICOS al actual). Recien despues de correr
-- este SQL las columnas existen y quedan prendidas en las cuentas NO congeladas.
--
-- CANDADO (regla de Diego): la cuenta "Raices Meta Test" esta congelada
-- (business_settings.congelada = true) y NO se toca. Por eso, para CADA flag, el orden es:
--   1) ADD COLUMN ... DEFAULT false  -> TODAS las filas existentes (incluida la congelada)
--      arrancan en false (OFF). Asi NO se prende la congelada.
--   2) UPDATE ... = true WHERE congelada IS DISTINCT FROM true  -> prende SOLO las NO
--      congeladas (cubre tambien NULL). La congelada queda en false (OFF).
--   3) ALTER COLUMN ... SET DEFAULT true  -> recien AHORA las cuentas NUEVAS nacen ON.
-- (El bug de la version anterior era usar DEFAULT true en el ADD: eso backfilleaba la
--  fila congelada en true y el UPDATE ya no la apagaba.)
--
-- Idempotente: ADD COLUMN IF NOT EXISTS + UPDATE + ALTER DEFAULT. Se puede re-correr.
-- ============================================================================

-- 1) FUENTE #1 — cotizacion del dolar (tool cotizacion_dolar)
ALTER TABLE public.business_settings ADD COLUMN IF NOT EXISTS ia_dolar_lead boolean DEFAULT false;
UPDATE public.business_settings SET ia_dolar_lead = true WHERE congelada IS DISTINCT FROM true;
ALTER TABLE public.business_settings ALTER COLUMN ia_dolar_lead SET DEFAULT true;

-- 2) FUENTE #2 — pronostico del clima (tool pronostico_clima)
ALTER TABLE public.business_settings ADD COLUMN IF NOT EXISTS ia_clima boolean DEFAULT false;
UPDATE public.business_settings SET ia_clima = true WHERE congelada IS DISTINCT FROM true;
ALTER TABLE public.business_settings ALTER COLUMN ia_clima SET DEFAULT true;

-- 3) FUENTE #3 — feriados nacionales AR (tool feriados_ar)
ALTER TABLE public.business_settings ADD COLUMN IF NOT EXISTS ia_feriados boolean DEFAULT false;
UPDATE public.business_settings SET ia_feriados = true WHERE congelada IS DISTINCT FROM true;
ALTER TABLE public.business_settings ALTER COLUMN ia_feriados SET DEFAULT true;

-- 4) FUENTE #4 — normalizar direccion AR / Georef (tool normalizar_direccion_ar)
ALTER TABLE public.business_settings ADD COLUMN IF NOT EXISTS ia_georef boolean DEFAULT false;
UPDATE public.business_settings SET ia_georef = true WHERE congelada IS DISTINCT FROM true;
ALTER TABLE public.business_settings ALTER COLUMN ia_georef SET DEFAULT true;

-- 5) FUENTE #5 — distancia/tiempo en auto / OSRM (tool distancia_viaje)
ALTER TABLE public.business_settings ADD COLUMN IF NOT EXISTS ia_osrm boolean DEFAULT false;
UPDATE public.business_settings SET ia_osrm = true WHERE congelada IS DISTINCT FROM true;
ALTER TABLE public.business_settings ALTER COLUMN ia_osrm SET DEFAULT true;

-- Refrescar el cache de esquema de PostgREST (si no, los reads a las columnas nuevas
-- pueden fallar en silencio con PGRST204 hasta el proximo reload).
NOTIFY pgrst, 'reload schema';
