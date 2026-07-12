-- ============================================================================
-- F6.2 (vertical HOTEL) — token PUBLICO dedicado para el iCal EXPORT por unidad.
-- Se agrega una columna a business_settings. NO se reusa inventario_api_key
-- (esa key da acceso de ESCRITURA al inventario y el link .ics se pega en OTAs
-- publicas). El token se genera lazy desde GET /api/hotel/ical-links.
--
-- ADITIVO + DEFENSIVO: la columna es nullable, sin default. Nada la usa hasta que
-- el dueño pide sus links. El backend YA tolera que la columna no exista (503 con
-- mensaje claro), asi que correr esto es lo unico pendiente para habilitar el export.
--
-- Correr en Supabase SQL Editor (proyecto euvgrvtnjzuqnuvuskee). Recordar el modal
-- "Potential issue detected" -> "Run query". Verificar con el SELECT del final.
-- ============================================================================

ALTER TABLE business_settings ADD COLUMN IF NOT EXISTS ical_token text;

-- Indice para resolver rapido el token en el endpoint publico /api/public/ical/:token/:unitid
CREATE UNIQUE INDEX IF NOT EXISTS business_settings_ical_token_uidx
  ON business_settings (ical_token)
  WHERE ical_token IS NOT NULL;

-- Refrescar el cache de PostgREST (sino los reads/writes a la columna nueva fallan en silencio)
NOTIFY pgrst, 'reload schema';

-- Verificacion:
-- SELECT column_name FROM information_schema.columns
--   WHERE table_name='business_settings' AND column_name='ical_token';
