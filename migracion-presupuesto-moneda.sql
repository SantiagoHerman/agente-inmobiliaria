-- ============================================================================================
-- migracion-presupuesto-moneda.sql
-- Diego, 2026-08-08: "ponele moneda".
--
-- REGLA PERMANENTE DE DIEGO (2026-08-06): "de aca en adelante cuando se hable de dinero tiene
-- que tener la moneda para elegir". Faltaban DOS lugares:
--
--   1) conversations.presupuesto  -> el presupuesto del panel del chat. Es un texto libre sin
--      moneda: hoy dice "650" y nadie sabe si son pesos o dolares.
--   2) fichas.moneda              -> la columna YA EXISTE, pero la ficha que la IA creo sola en
--      Anton el 7/8 (cliente Uri, presupuesto 650) la dejo en NULL. No hace falta DDL para eso,
--      se arregla en el codigo; queda anotado aca para que se entienda el alcance completo.
--
-- Esta migracion agrega UNA sola columna.
--
-- 100% ADITIVA: no toca ninguna fila, no borra nada, no cambia ningun comportamiento existente.
-- SE PUEDE CORRER MAS DE UNA VEZ (IF NOT EXISTS).
--
-- ORDEN IMPORTANTE: correr ESTO ANTES de que salga el deploy del front. El front va a pedir la
-- columna en el SELECT de la lista de conversaciones, y PostgREST devuelve 400 (no una columna
-- vacia) cuando una columna del select no existe -> la lista quedaria VACIA. Es exactamente el
-- bug de `perfil_comprador` que se arreglo el 6/8: la consulta fallaba entera y "Fecha de alta"
-- venia vacia desde el dia uno.
--
-- COMO CORRERLA: pegar TODO este archivo en el editor SQL de Supabase y apretar Run.
-- ============================================================================================

ALTER TABLE public.conversations ADD COLUMN IF NOT EXISTS presupuesto_moneda text;

-- PostgREST cachea el esquema: sin este NOTIFY la API sigue sin ver la columna nueva (42703/PGRST204).
NOTIFY pgrst, 'reload schema';

-- VERIFICACION: tiene que devolver 1 fila -> presupuesto_moneda | text
SELECT column_name, data_type
FROM information_schema.columns
WHERE table_schema = 'public' AND table_name = 'conversations' AND column_name = 'presupuesto_moneda';

-- CUANTOS PRESUPUESTOS HAY HOY SIN MONEDA (los viejos quedan sin moneda; no se inventa ninguna):
SELECT count(*) AS presupuestos_cargados_sin_moneda
FROM public.conversations
WHERE presupuesto IS NOT NULL AND btrim(presupuesto) <> '';

-- ============================================================================================
-- PARA VOLVER ATRAS (nada del sistema depende de esta columna; el codigo la lee best-effort):
--   ALTER TABLE public.conversations DROP COLUMN IF EXISTS presupuesto_moneda;
--   NOTIFY pgrst, 'reload schema';
-- ============================================================================================
