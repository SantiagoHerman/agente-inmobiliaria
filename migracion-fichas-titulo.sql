-- ============================================================================================
-- migracion-fichas-titulo.sql
-- Diego, 2026-08-06: "una ficha historial verano 2027 por ejemplo. Ya la estructura esta, solo
-- creamos un campo mas de fichas."
--
-- Tenia razon: la estructura estaba. Verificado campo por campo, `fichas` YA tiene contact_id, tipo,
-- estado, property_id, desde, hasta, proximo_vencimiento, zonas, presupuesto, moneda, tipo_propiedad,
-- ambientes, dormitorios, asesor_id, notas, origen, resultado y un jsonb libre. Y varias fichas por
-- contacto ya es el diseño.
--
-- LO UNICO QUE FALTABA es donde escribir "Verano 2027". Hoy una ficha se identifica por tipo + fechas,
-- que en una lista se lee "estadia 2027-01-12 → 2027-01-19". Con titulo se lee "Verano 2027 - Cabaña 3".
--
-- 100% ADITIVA: no toca ninguna fila, no borra nada, no cambia ningun comportamiento.
-- SE PUEDE CORRER MAS DE UNA VEZ (IF NOT EXISTS).
--
-- EL CODIGO YA ESTA DESPLEGADO Y ANDA SIN ESTO: si la columna no existe, el historial que lee la IA se
-- arma igual con tipo + fechas. Al correr esto, el titulo aparece solo.
--
-- COMO CORRERLA: pegar TODO este archivo en el editor SQL de Supabase y apretar Run.
-- ============================================================================================

ALTER TABLE public.fichas ADD COLUMN IF NOT EXISTS titulo text;

-- PostgREST cachea el esquema: sin este NOTIFY la API sigue sin ver la columna nueva (42703/PGRST204).
NOTIFY pgrst, 'reload schema';

-- VERIFICACION: tiene que devolver 1 fila -> titulo | text
SELECT column_name, data_type
FROM information_schema.columns
WHERE table_schema = 'public' AND table_name = 'fichas' AND column_name = 'titulo';

-- ============================================================================================
-- PARA VOLVER ATRAS (nada del sistema depende de esta columna):
--   ALTER TABLE public.fichas DROP COLUMN IF EXISTS titulo;
--   NOTIFY pgrst, 'reload schema';
-- ============================================================================================
