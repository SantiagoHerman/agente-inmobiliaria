-- ============================================================================================
-- migracion-contactos-redes.sql
-- Diego, 2026-08-06: "Tambien instagram o facebook el nombre. uno nunca sabe. La idea es que si
-- entra por msn o instagram se genere la ficha y la charla siga por whats app siempre."
--
-- QUE HACE: agrega dos columnas de texto a `contacts` para guardar el nombre/usuario de Instagram
-- y de Facebook del contacto. Es 100% ADITIVA: no toca ni una fila existente, no borra nada, no
-- cambia ningun comportamiento. Los 1.354 contactos actuales quedan con las dos columnas en NULL.
--
-- POR QUE HACEN FALTA: hoy un contacto tiene UN solo `phone` y UN solo `channel`. Cuando el lead
-- entra por Instagram o Messenger, `phone` NO guarda un telefono: guarda el id de la plataforma
-- (verificado en la base: un contacto de Instagram tiene phone='1534973438357299'). O sea que hoy
-- NO hay donde anotar "el Instagram de esta persona es @tal Y su WhatsApp es +54...".
--
-- EL CODIGO YA ESTA DESPLEGADO Y ANDA SIN ESTO: lee y escribe por capas, y si las columnas no
-- existen las omite en silencio. Al correr esta migracion los campos aparecen solos en la ficha y
-- en los dos formularios de alta, SIN necesidad de desplegar nada.
--
-- COMO CORRERLA: pegar TODO este archivo en el editor SQL de Supabase y apretar Run.
-- ============================================================================================

-- 1) Las dos columnas. IF NOT EXISTS => se puede correr dos veces sin romper nada.
ALTER TABLE public.contacts ADD COLUMN IF NOT EXISTS instagram text;
ALTER TABLE public.contacts ADD COLUMN IF NOT EXISTS facebook  text;

-- 2) PostgREST cachea el esquema: sin este NOTIFY, la API sigue respondiendo PGRST204 / 42703
--    ("column does not exist") aunque la columna ya este creada. Es el gotcha de siempre.
NOTIFY pgrst, 'reload schema';

-- 3) VERIFICACION (deberia devolver exactamente 2 filas: facebook e instagram).
SELECT column_name, data_type
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name = 'contacts'
  AND column_name IN ('instagram', 'facebook')
ORDER BY column_name;

-- ============================================================================================
-- PARA VOLVER ATRAS (no deberia hacer falta: nada del sistema depende de estas columnas)
--   ALTER TABLE public.contacts DROP COLUMN IF EXISTS instagram;
--   ALTER TABLE public.contacts DROP COLUMN IF EXISTS facebook;
--   NOTIFY pgrst, 'reload schema';
-- OJO: eso BORRA los datos que se hayan cargado en esos campos.
-- ============================================================================================
