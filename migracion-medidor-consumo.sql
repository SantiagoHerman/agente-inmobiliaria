-- ============================================================================
-- MEDIDOR DE CONSUMO DE IA - atribucion por LEAD y por MENSAJE (2026-07-23)
-- ============================================================================
-- PROBLEMA QUE RESUELVE
-- Hoy la tabla `ia_uso` guarda el costo real de CADA LLAMADA a la IA (tokens de
-- entrada/salida, cache y USD), pero NO guarda a que conversacion ni a que
-- mensaje del lead pertenece esa llamada. Un solo mensaje de un lead dispara
-- entre 2 y 9 llamadas (detectar idioma, traducir, extraer datos, responder,
-- clasificar estado, memoria viva, resumen...), y todas quedan como filas
-- sueltas: no se puede responder "cuanto costo ESTE lead" ni "cuanto costo
-- ESTE mensaje".
--
-- QUE AGREGA
--   1) ia_uso.conversation_id -> a que CONVERSACION (lead) pertenece la llamada.
--   2) ia_uso.turno_id        -> a que TURNO pertenece. Un TURNO = un mensaje
--      del lead = el uuid que el webhook genera al entrar el mensaje y propaga
--      por todo el ciclo. Sumando el costo de todas las filas con el mismo
--      turno_id se obtiene el costo REAL de ese mensaje.
--   3) Dos indices para que los paneles del Maestro no hagan seq scan.
--
-- SEGURIDAD / DESPLIEGUE
--   - Es ADITIVA: no toca ni una fila existente, no borra, no cambia tipos.
--     Las filas viejas quedan con conversation_id/turno_id en NULL.
--   - El codigo del backend YA esta desplegado y funciona con estas columnas
--     AUSENTES (intenta el insert con los campos nuevos y, si falla, reintenta
--     el insert exactamente como hoy). Se puede correr esta migracion en
--     cualquier momento, sin ventana de mantenimiento y sin redeploy.
--   - Correr en el SQL Editor de Supabase, todo junto.
-- ============================================================================

-- 1) Columna conversation_id: el lead (conversations.id) al que se le atribuye
--    la llamada. Se deja SIN foreign key a proposito: es un dato de MEDICION,
--    no debe poder bloquear el borrado de una conversacion ni fallar un insert
--    de costo por una carrera. uuid porque conversations.id es uuid.
ALTER TABLE ia_uso ADD COLUMN IF NOT EXISTS conversation_id uuid;

-- 2) Columna turno_id: agrupador de todas las llamadas disparadas por UN mensaje
--    del lead. Es text (no uuid) a proposito: lo genera el backend y asi acepta
--    cualquier formato de id si en el futuro cambia el generador, sin migrar.
ALTER TABLE ia_uso ADD COLUMN IF NOT EXISTS turno_id text;

-- 3) Indice para "cuanto costo ESTE lead" y para el detalle por turno de una
--    conversacion (siempre se consulta por conversacion y ordenado por fecha).
CREATE INDEX IF NOT EXISTS ia_uso_conversation_created_idx
  ON ia_uso (conversation_id, created_at DESC);

-- 4) Indice para el panel por CLIENTE (consumo de una cuenta en un rango de
--    fechas: por dia, por operacion, top leads, percentiles por turno).
CREATE INDEX IF NOT EXISTS ia_uso_user_created_idx
  ON ia_uso (user_id, created_at DESC);

-- 5) GOTCHA CONOCIDO DEL PROYECTO: PostgREST cachea el schema. Sin este NOTIFY,
--    los inserts que traen columnas recien agregadas fallan en silencio con
--    PGRST204 ("Could not find the column ... in the schema cache").
NOTIFY pgrst, 'reload schema';

-- ============================================================================
-- VERIFICACION (opcional, read-only). Despues de correr lo de arriba:
--
--   SELECT column_name, data_type
--     FROM information_schema.columns
--    WHERE table_name = 'ia_uso'
--      AND column_name IN ('conversation_id', 'turno_id');
--
-- Y a los pocos minutos de trafico real, deberian aparecer filas atribuidas:
--
--   SELECT count(*) AS con_lead FROM ia_uso WHERE conversation_id IS NOT NULL;
--   SELECT count(*) AS con_turno FROM ia_uso WHERE turno_id IS NOT NULL;
-- ============================================================================
