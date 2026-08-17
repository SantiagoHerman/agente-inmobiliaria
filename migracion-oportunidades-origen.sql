-- ============================================================================================
-- migracion-oportunidades-origen.sql
-- ============================================================================================
-- QUE AGREGA: una columna, `oportunidades.origen`, con dos valores posibles:
--   'manual'    -> la armo una persona. Es una CAMPAÑA: va a la cola y se envia.
--   'automatch' -> la encontro el sistema cruzando una propiedad contra los leads. Es una
--                  SUGERENCIA: nace sin mensaje y NUNCA se envia sola.
--
-- POR QUE (Diego 2026-08-17): "no es mejor armar un espacio de sugerencias sin crear la
-- oportunidad? una que nunca se va a enviar porque no tiene texto".
-- Tenia razon. El auto-match dejaba borradores en la MISMA lista que los envios reales, asi que
-- el cliente veia 6 "envios" que nunca programo y no sabia si algo estaba por salir. Sin esta
-- columna no hay forma de separarlos: hoy solo se distinguen por como empieza el nombre
-- ("Auto-match: ..."), que es fragil -- alcanza con que alguien renombre una para romperlo.
--
-- 100% ADITIVA. Default 'manual', asi que TODO lo que ya existe sigue comportandose igual.
-- SE PUEDE CORRER MAS DE UNA VEZ.
--
-- COMO CORRERLA: pegar todo en el editor SQL de Supabase y apretar Run.
-- ============================================================================================

ALTER TABLE public.oportunidades ADD COLUMN IF NOT EXISTS origen text NOT NULL DEFAULT 'manual';

-- Backfill: las que ya existen y son del auto-match se marcan como tales. Se reconocen por el
-- prefijo del nombre, que es como las viene creando el codigo (server.js ~15297). Es un one-shot:
-- de aca en adelante la columna la escribe el propio insert, no el nombre.
UPDATE public.oportunidades
   SET origen = 'automatch'
 WHERE origen <> 'automatch'
   AND nombre LIKE 'Auto-match:%';

-- Una sugerencia no se envia: cualquier auto-match que haya quedado en la cola vuelve a borrador.
-- (Caso real: "Auto-match: #3 ... Barrio Raffo" estaba en 'en_cola' sin mensaje, y el worker la
-- habria pausado sola con un motivo que el cliente no pidio ver.)
UPDATE public.oportunidades
   SET estado = 'borrador'
 WHERE origen = 'automatch'
   AND estado IN ('en_cola', 'enviando');

CREATE INDEX IF NOT EXISTS oportunidades_origen_idx ON public.oportunidades (user_id, origen);

-- PostgREST cachea el esquema: sin este NOTIFY la API sigue sin ver la columna (PGRST204).
NOTIFY pgrst, 'reload schema';


-- ============================================================================================
-- VERIFICACION: cuantas quedaron de cada tipo, y ninguna sugerencia en la cola.
-- ============================================================================================
SELECT origen, estado, count(*) AS cuantas
  FROM public.oportunidades
 GROUP BY origen, estado
 ORDER BY origen, estado;


-- ============================================================================================
-- ROLLBACK:
--   ALTER TABLE public.oportunidades DROP COLUMN IF EXISTS origen;
--   DROP INDEX IF EXISTS oportunidades_origen_idx;
--   NOTIFY pgrst, 'reload schema';
-- (El estado de las que volvieron a 'borrador' NO se revierte solo: eran sugerencias sin mensaje,
--  no habrian enviado nada de todos modos.)
-- ============================================================================================
