-- ============================================================================
-- HORA REAL DEL ULTIMO MENSAJE  ->  conversations.last_message_at
-- Diego 2026-07-28.  NO CORRIDA TODAVIA (escrita, pendiente del "dale").
-- ----------------------------------------------------------------------------
-- PROBLEMA (medido sobre 30 conversaciones de una cuenta real):
--   La lista de conversaciones mostraba y ordenaba por conversations.updated_at, que se mueve con CUALQUIER
--   cambio de la fila, no solo cuando entra o sale un mensaje. Los 3 leads que tenian asesor asignado marcaban
--   todos la misma hora (01:36) porque a esa hora el reparto les escribio asesor_id + updated_at
--   (server.js, update de asignacion de asesor). Uno de ellos (Andy) habia escrito 35 h antes y aparecia
--   PRIMERO en "Requieren atencion", arriba de gente que habia escrito anoche. Las otras 27 conversaciones,
--   sin asesor asignado, tenian 0 de desfase.
--
-- SOLUCION: columna propia que el backend escribe SOLO cuando hay un mensaje real (entrante o saliente),
--   con el MISMO timestamp que updated_at. Se cumple siempre updated_at >= last_message_at.
--
-- ORDEN DE APLICACION (importante):
--   1) Correr este archivo (los 3 pasos de abajo, en una sola transaccion).
--   2) Recien despues sirve el deploy del backend/front; igual son deploy-safe en cualquier orden:
--      - Backend: _updConvMensaje() reintenta el update SIN la columna si no existe -> se comporta como hoy.
--      - Front:   fechaMsg() cae a updated_at si el campo llega undefined -> se ve como hoy.
--
-- COSTO DE IA: CERO. No toca prompts ni tokens.
-- ============================================================================

BEGIN;

-- 1) La columna. Idempotente: se puede correr dos veces sin romper nada.
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS last_message_at timestamptz;

-- 2) Backfill: la hora del ultimo mensaje REAL de cada conversacion.
--    Se usa la forma AGRUPADA (un solo barrido de `messages` + hash aggregate) en vez de la subconsulta
--    correlacionada `(SELECT max(...) ... WHERE m.conversation_id = c.id)`, que obliga a una consulta por
--    CADA conversacion sobre la tabla mas grande del sistema y sin indice que la sostenga
--    (no existe messages(conversation_id, created_at); el unico indice sobre messages es parcial y para otra cosa).
--    El resultado es EXACTAMENTE el mismo; cambia el plan y el tiempo.
UPDATE conversations c
   SET last_message_at = m.ultimo
  FROM (SELECT conversation_id, max(created_at) AS ultimo
          FROM messages
         GROUP BY conversation_id) m
 WHERE m.conversation_id = c.id;

-- Las conversaciones SIN ningun mensaje quedan con last_message_at = NULL a proposito.
-- El front hace `last_message_at || updated_at`, asi que esas siguen mostrandose y ordenandose como hoy.

-- 3) PostgREST cachea el esquema: sin esto, los writes con la columna nueva fallan con PGRST204
--    (ver memoria "Supabase migraciones/cache"). Va SIEMPRE despues de un ADD COLUMN.
NOTIFY pgrst, 'reload schema';

COMMIT;


-- ============================================================================
-- ¿HACE FALTA UN INDICE?  Analisis (Diego pidio fundamento, no un "por las dudas").
-- ----------------------------------------------------------------------------
-- (A) PARA EL ORDEN DE LA LISTA: NO, y a proposito.
--     El .order() de las queries de la pantalla SIGUE siendo `updated_at desc` (no se cambio). Razones:
--       - Si la migracion no corrio, ordenar por una columna inexistente hace que PostgREST devuelva 400 y la
--         lista quede VACIA. El .order() corre en la base: no admite fallback defensivo.
--       - `order by ... desc` en Postgres es NULLS FIRST: las conversaciones sin mensajes treparian al tope.
--       - No hace falta: ese .order() solo elige QUE 1000 filas se traen. El orden que se VE lo fija el .sort()
--         del cliente, que ya usa (last_message_at || updated_at). Y como updated_at >= last_message_at siempre,
--         la ventana traida por updated_at desc no deja afuera ninguna conversacion con mensaje reciente.
--     => Un indice sobre last_message_at no lo usaria NADIE hoy. Indice que nadie usa = escritura mas cara en
--        la tabla mas caliente del sistema, a cambio de nada.
--
-- (B) PARA EL BACKFILL (paso 2): con la forma agrupada tampoco hace falta. Es un unico seq scan de `messages`
--     con hash aggregate; un indice messages(conversation_id, created_at) no lo acelera de forma decisiva y
--     construirlo cuesta mas que el propio backfill. (Con la subconsulta correlacionada SI seria practicamente
--     obligatorio: por eso se descarto esa forma.)
--
-- (C) SI EN EL FUTURO se decide ordenar EN LA BASE por last_message_at (por ejemplo para paginar de verdad),
--     ahi si conviene, y con estas dos precauciones:
--         CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_conversations_user_lastmsg
--             ON conversations (user_id, last_message_at DESC NULLS LAST);
--     - CONCURRENTLY: es un producto EN VIVO, no se bloquea la tabla.
--     - NULLS LAST en el indice Y en el order by, si no las conversaciones sin mensajes quedan primeras.
--     - CONCURRENTLY no puede correr dentro de una transaccion: va SUELTO, fuera del BEGIN/COMMIT de arriba.
-- ============================================================================


-- ============================================================================
-- VERIFICACION DESPUES DE CORRERLA (solo lecturas, no cambian nada):
-- ----------------------------------------------------------------------------
-- -- 1) Cuantas quedaron con hora real y cuantas sin mensajes:
-- SELECT count(*) FILTER (WHERE last_message_at IS NOT NULL) AS con_hora,
--        count(*) FILTER (WHERE last_message_at IS NULL)     AS sin_mensajes,
--        count(*) AS total
--   FROM conversations;
--
-- -- 2) El desfase que se estaba viendo en la lista (los que mentian mas):
-- SELECT c.id, c.updated_at, c.last_message_at,
--        round(EXTRACT(EPOCH FROM (c.updated_at - c.last_message_at)) / 3600, 1) AS horas_de_desfase
--   FROM conversations c
--  WHERE c.last_message_at IS NOT NULL
--  ORDER BY (c.updated_at - c.last_message_at) DESC
--  LIMIT 20;
--
-- -- 3) INVARIANTE: nunca puede haber una hora de mensaje POSTERIOR al updated_at. Tiene que dar 0.
-- SELECT count(*) AS violaciones FROM conversations WHERE last_message_at > updated_at;
--
-- -- 4) Control cruzado contra messages: tiene que dar 0 filas descuadradas.
-- SELECT count(*) AS descuadradas
--   FROM conversations c
--   JOIN (SELECT conversation_id, max(created_at) AS ultimo FROM messages GROUP BY conversation_id) m
--     ON m.conversation_id = c.id
--  WHERE c.last_message_at IS DISTINCT FROM m.ultimo;
-- ============================================================================


-- ============================================================================
-- ROLLBACK (si hubiera que volver atras):
--   El front y el backend son tolerantes a que la columna NO exista, asi que alcanza con:
--     ALTER TABLE conversations DROP COLUMN IF EXISTS last_message_at;
--     NOTIFY pgrst, 'reload schema';
--   No se pierde nada: la columna es 100% derivada de messages.created_at y se puede recalcular
--   volviendo a correr el paso 2.
-- ============================================================================
