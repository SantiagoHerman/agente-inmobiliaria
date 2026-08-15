-- ============================================================================================
-- migracion-importacion-error.sql
-- ============================================================================================
-- QUE AGREGA: una sola columna, `import_lotes.error`, para guardar POR QUE fallo una importacion.
--
-- POR QUE: el motor de lectura (Fase 10) puede fallar por motivos que el cliente puede arreglar
-- solo — "el archivo pesa mas de 20 MB", "el .xlsx no tiene hojas legibles", "no se pudo bajar el
-- archivo". Sin esta columna el motivo queda unicamente en el log del servidor, o sea: invisible
-- para el unico que puede hacer algo al respecto. Con la columna, la pantalla se lo dice.
--
-- NO ES OBLIGATORIA. El motor ya convive con la columna ausente: si no existe, detecta el 42703 y
-- reintenta el update sin ella (server.js -> _impMarcarError). Sin correr esto todo funciona
-- igual; lo unico que se pierde es el mensaje en pantalla cuando algo falla.
--
-- 100% ADITIVA. No toca ninguna fila, no borra nada, no cambia comportamiento.
-- SE PUEDE CORRER MAS DE UNA VEZ.
--
-- COMO CORRERLA: pegar todo esto en el editor SQL de Supabase y apretar Run.
-- ============================================================================================

ALTER TABLE public.import_lotes ADD COLUMN IF NOT EXISTS error text;

-- PostgREST cachea el esquema: sin este NOTIFY la API sigue sin ver la columna (PGRST204).
NOTIFY pgrst, 'reload schema';


-- ============================================================================================
-- VERIFICACION: tiene que devolver 1 fila.
-- ============================================================================================
SELECT table_name || '.' || column_name AS columna, data_type
  FROM information_schema.columns
 WHERE table_schema = 'public' AND table_name = 'import_lotes' AND column_name = 'error';


-- ============================================================================================
-- PARA VOLVER ATRAS (nada depende de esto):
--   ALTER TABLE public.import_lotes DROP COLUMN IF EXISTS error;
--   NOTIFY pgrst, 'reload schema';
-- ============================================================================================
