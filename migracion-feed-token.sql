-- ============================================================================
-- ETAPA 5 (TRANSVERSAL) — token PUBLICO dedicado para el FEED read-only de
-- inventario + el CATALOGO publico del cliente (pagina /p/<token>).
-- Se agrega una columna a business_settings. NO se reusa inventario_api_key
-- (esa da acceso de ESCRITURA); este token es SOLO LECTURA del inventario activo.
-- El token se genera lazy desde GET /api/inventario/feed-link.
--
-- ADITIVO + DEFENSIVO: la columna es nullable, sin default. Nada la usa hasta que
-- el dueno pide su link. La GATE es la EXISTENCIA del token: sin token -> el endpoint
-- publico devuelve 404. El backend YA tolera que la columna no exista (503 con mensaje
-- claro en el endpoint owner; 404 en el publico), asi que correr esto es lo unico
-- pendiente para habilitar las salidas publicas.
--
-- Correr en Supabase SQL Editor (proyecto euvgrvtnjzuqnuvuskee). Recordar el modal
-- "Potential issue detected" -> "Run query". Verificar con el SELECT del final.
-- ============================================================================

ALTER TABLE business_settings ADD COLUMN IF NOT EXISTS feed_token text;

-- Indice unico parcial para resolver rapido el token en /api/public/feed/:token
-- (y garantizar que dos cuentas no compartan el mismo token).
CREATE UNIQUE INDEX IF NOT EXISTS business_settings_feed_token_uidx
  ON business_settings (feed_token)
  WHERE feed_token IS NOT NULL;

-- Refrescar el cache de PostgREST (sino los reads/writes a la columna nueva fallan en silencio).
NOTIFY pgrst, 'reload schema';

-- Verificacion:
-- SELECT column_name FROM information_schema.columns
--   WHERE table_name='business_settings' AND column_name='feed_token';
