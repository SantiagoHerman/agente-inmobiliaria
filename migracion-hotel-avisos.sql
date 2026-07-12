-- ============================================================================
-- MIGRACION F5.2 — Mensajes automaticos de estadia (vertical HOTEL)
-- ----------------------------------------------------------------------------
-- Correr en el SQL Editor de Supabase (proyecto euvgrvtnjzuqnuvuskee).
-- GOTCHA DDL: si aparece el modal "Potential issue detected", clickear "Run query".
-- Verificar despues con un SELECT y cerrar con el NOTIFY (ya incluido abajo).
--
-- 1) hotel_reservas.avisos: marca por reserva de que avisos de estadia ya se
--    enviaron (idempotencia del cron; ej. {"confirmacion":"2026-07-11T..."}).
-- 2) business_settings.estadia_config: config editable por cuenta de las
--    plantillas de estadia (textos + on/off + dias del pre-check-in + link resena).
--
-- Ambas columnas son ADITIVAS y con DEFAULT: no tocan datos existentes ni el
-- comportamiento de ninguna cuenta (el codigo es defensivo si aun no existen).
-- ============================================================================

ALTER TABLE hotel_reservas    ADD COLUMN IF NOT EXISTS avisos         jsonb DEFAULT '{}'::jsonb;
ALTER TABLE business_settings ADD COLUMN IF NOT EXISTS estadia_config jsonb DEFAULT '{}'::jsonb;

-- Refrescar el cache de PostgREST para que las escrituras a las columnas nuevas
-- no fallen en silencio (PGRST204).
NOTIFY pgrst, 'reload schema';

-- Verificacion sugerida (correr aparte tras el ALTER):
-- SELECT column_name FROM information_schema.columns
--   WHERE table_name = 'hotel_reservas'    AND column_name = 'avisos';
-- SELECT column_name FROM information_schema.columns
--   WHERE table_name = 'business_settings' AND column_name = 'estadia_config';
