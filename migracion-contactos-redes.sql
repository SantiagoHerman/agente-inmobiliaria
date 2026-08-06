-- ============================================================================================
-- migracion-contactos-redes.sql
-- Agrega a `contacts` los campos que faltaban para el perfil del cliente.
--
-- SE PUEDE CORRER MAS DE UNA VEZ SIN PROBLEMA: todo es `IF NOT EXISTS`. Si ya corriste una
-- version anterior de este archivo, correlo igual: agrega lo que falte y no toca lo que ya esta.
--
-- COMO CORRERLA: pegar TODO este archivo en el editor SQL de Supabase y apretar Run.
-- ============================================================================================

-- --------------------------------------------------------------------------------------------
-- 1) INSTAGRAM y FACEBOOK
-- Diego, 2026-08-06: "Tambien instagram o facebook el nombre. uno nunca sabe (...) la idea es
-- alojar dentro de un mismo perfil todo."
--
-- POR QUE HACEN FALTA: hoy un contacto tiene UN solo `phone` y UN solo `channel`. Cuando el lead
-- entra por Instagram o Messenger, `phone` NO guarda un telefono: guarda el id de la plataforma
-- (verificado en la base: un contacto de Instagram tiene phone='1534973438357299'). O sea que hoy
-- NO hay donde anotar "el Instagram de esta persona es @tal Y su WhatsApp es +54...".
-- --------------------------------------------------------------------------------------------
ALTER TABLE public.contacts ADD COLUMN IF NOT EXISTS instagram text;
ALTER TABLE public.contacts ADD COLUMN IF NOT EXISTS facebook  text;

-- --------------------------------------------------------------------------------------------
-- 2) MONEDA DEL PRESUPUESTO
-- Diego, 2026-08-06: "en el presupuesto no especifica pesos dolares moneda... de aca en adelante
-- cuando se hable de dinero tiene que tener la moneda para elegir."
--
-- POR QUE VA EN SU PROPIA COLUMNA Y NO PEGADA AL TEXTO: `contacts.budget` es texto libre, y hoy
-- "185000" puede ser un alquiler en pesos o una propiedad en dolares. Si la moneda se guardara
-- adentro del mismo texto ("USD 185000") seguiria sin poder compararse ni ordenarse. Separada, el
-- monto queda comparable. Es el MISMO criterio que ya usan las fichas del cliente (`fichas.moneda`).
--
-- Valores: 'ARS' o 'USD'. Se deja SIN default a proposito: NULL = "nadie eligio todavia", que es
-- distinto de "es en pesos". Los 48 contactos que hoy tienen presupuesto cargado quedan en NULL y
-- la pantalla los muestra como "sin moneda" hasta que alguien la elija -- no se les inventa una.
-- --------------------------------------------------------------------------------------------
ALTER TABLE public.contacts ADD COLUMN IF NOT EXISTS budget_moneda text;

-- --------------------------------------------------------------------------------------------
-- 3) PostgREST cachea el esquema: sin este NOTIFY la API sigue respondiendo 42703 / PGRST204
--    ("column does not exist") aunque las columnas ya esten creadas. Es el gotcha de siempre.
-- --------------------------------------------------------------------------------------------
NOTIFY pgrst, 'reload schema';

-- --------------------------------------------------------------------------------------------
-- 4) VERIFICACION. Tiene que devolver exactamente 3 filas:
--    budget_moneda | facebook | instagram
-- --------------------------------------------------------------------------------------------
SELECT column_name, data_type
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name = 'contacts'
  AND column_name IN ('instagram', 'facebook', 'budget_moneda')
ORDER BY column_name;

-- ============================================================================================
-- ES 100% ADITIVA: no toca ni una fila existente, no borra nada, no cambia ningun comportamiento.
-- Los 1.354 contactos actuales quedan con las tres columnas en NULL.
--
-- EL CODIGO YA ESTA DESPLEGADO Y ANDA SIN ESTO: lee y escribe por capas, y si las columnas no
-- existen las omite. Al correr esto, los campos aparecen solos en la ficha y en los dos
-- formularios de alta, SIN necesidad de desplegar nada.
--
-- PARA VOLVER ATRAS (no deberia hacer falta: nada del sistema depende de estas columnas)
--   ALTER TABLE public.contacts DROP COLUMN IF EXISTS instagram;
--   ALTER TABLE public.contacts DROP COLUMN IF EXISTS facebook;
--   ALTER TABLE public.contacts DROP COLUMN IF EXISTS budget_moneda;
--   NOTIFY pgrst, 'reload schema';
-- OJO: eso BORRA los datos que se hayan cargado en esos campos.
-- ============================================================================================
