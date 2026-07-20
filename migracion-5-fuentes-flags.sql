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
-- (business_settings.congelada = true) y NO se toca. Por eso el UPDATE excluye
-- explicitamente las cuentas congeladas (WHERE congelada IS DISTINCT FROM true),
-- que ademas cubre el caso NULL. Las cuentas congeladas quedan con el DEFAULT de la
-- columna hasta que Diego decida activarlas a mano.
--
-- Idempotente: ADD COLUMN IF NOT EXISTS + UPDATE por columna. Se puede re-correr.
-- ============================================================================

-- 1) FUENTE #1 — cotizacion del dolar (tool cotizacion_dolar)
ALTER TABLE public.business_settings ADD COLUMN IF NOT EXISTS ia_dolar_lead boolean DEFAULT true;
UPDATE public.business_settings SET ia_dolar_lead = true WHERE congelada IS DISTINCT FROM true;

-- 2) FUENTE #2 — pronostico del clima (tool pronostico_clima)
ALTER TABLE public.business_settings ADD COLUMN IF NOT EXISTS ia_clima boolean DEFAULT true;
UPDATE public.business_settings SET ia_clima = true WHERE congelada IS DISTINCT FROM true;

-- 3) FUENTE #3 — feriados nacionales AR (tool feriados_ar)
ALTER TABLE public.business_settings ADD COLUMN IF NOT EXISTS ia_feriados boolean DEFAULT true;
UPDATE public.business_settings SET ia_feriados = true WHERE congelada IS DISTINCT FROM true;

-- 4) FUENTE #4 — normalizar direccion AR / Georef (tool normalizar_direccion_ar)
ALTER TABLE public.business_settings ADD COLUMN IF NOT EXISTS ia_georef boolean DEFAULT true;
UPDATE public.business_settings SET ia_georef = true WHERE congelada IS DISTINCT FROM true;

-- 5) FUENTE #5 — distancia/tiempo en auto / OSRM (tool distancia_viaje)
ALTER TABLE public.business_settings ADD COLUMN IF NOT EXISTS ia_osrm boolean DEFAULT true;
UPDATE public.business_settings SET ia_osrm = true WHERE congelada IS DISTINCT FROM true;

-- Refrescar el cache de esquema de PostgREST (si no, los writes/reads a las columnas
-- nuevas pueden fallar en silencio con PGRST204 hasta el proximo reload).
NOTIFY pgrst, 'reload schema';
