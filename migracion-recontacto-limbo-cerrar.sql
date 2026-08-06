-- ============================================================================
-- CORRECTIVO: sacar del "limbo" a las conversaciones que quedaron en
--             status='recontacto' + recontacto_excluido=true
-- ----------------------------------------------------------------------------
-- ESTE ARCHIVO NO SE CORRIO. Queda escrito para que Diego decida.
--
-- QUE ES EL LIMBO: una conversacion con status='recontacto' Y recontacto_excluido=true
-- figura EN la cola de recontacto, pero el motor la saltea para siempre
-- (server.js:17556) y el panel la esconde (recontactos/page.tsx, leadsVisibles()).
-- No aparece en ninguna cola: nadie la va a trabajar nunca.
--
-- MEDIDO EN LA BASE el 2026-08-06 (solo SELECT):
--   Andres Galdames  (2893a542-7cc3-40ca-9a78-ab93298734a8) ....... 39 filas
--   Anton Bienes Raices (f771e75e-c12a-4010-b301-d59796da5168) .....  1 fila
--   TOTAL en TODAS las cuentas ...................................  40 filas
--
--   * LAS 40 TIENEN recontacto_count = 0. NUNCA recibieron un solo intento de
--     recontacto. No se las descarto por no responder: salieron marcadas sin
--     que la IA les escribiera nunca. Cerrarlas es decidir no contactarlas mas.
--   * Las 39 de Galdames nacieron todas en la MISMA importacion
--     (created_at = 2026-08-02 02:27:11.223141+00, 44 conversaciones de una).
--     Por los nombres es una agenda de celular exportada a CSV, no una lista de
--     leads: "Sport Club Pilar", "Escribania Mujica", "Libreria La Estacion",
--     "esposa Julio Quiroga", familiares, y telefonos sueltos sin nombre.
--
-- ALTERNATIVA (si Diego prefiere NO cerrarlos): correr en su lugar el UPDATE
-- del bloque C, que los devuelve a la cola limpiando la marca. Los 40 volverian
-- a entrar en el reparto de recontacto y la IA les escribiria. NO se puede hacer
-- las dos cosas: son excluyentes.
--
-- BACKUP ANTES DE CORRER: guardar el SELECT del bloque A.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- BLOQUE A — BACKUP / VERIFICACION PREVIA (correr SIEMPRE primero y guardar).
-- Tiene que devolver 40 filas: 39 de Galdames + 1 de Anton.
-- ----------------------------------------------------------------------------
SELECT id, user_id, contact_id, status, recontacto_excluido, recontacto_count,
       recontacto_categoria, created_at, updated_at
  FROM conversations
 WHERE status = 'recontacto'
   AND recontacto_excluido IS TRUE
 ORDER BY user_id, created_at;

-- ----------------------------------------------------------------------------
-- BLOQUE B — LO QUE PIDIO DIEGO: pasarlos a 'cerrado'.
--
-- Se conserva recontacto_excluido = true a proposito: si alguien devuelve el
-- lead a 'recontacto' a mano mas adelante, la marca evita que el motor lo agarre.
-- Se toca updated_at porque en esta tabla nada lo mantiene solo (no hay trigger:
-- lo escribe el codigo a mano en cada lugar), y sin eso el cierre no deja huella
-- de cuando paso. NO se toca temperatura: son contactos de agenda, marcarlos
-- 'tibio' (que es lo que hace /api/conversations/cerrar) ensucia las metricas.
-- ----------------------------------------------------------------------------

-- B.1 — Solo Andres Galdames. AFECTA EXACTAMENTE 39 FILAS.
UPDATE conversations
   SET status = 'cerrado',
       updated_at = now()
 WHERE user_id = '2893a542-7cc3-40ca-9a78-ab93298734a8'
   AND status = 'recontacto'
   AND recontacto_excluido IS TRUE;

-- B.2 — La unica de Anton ("Agua Y Soda V G", recontacto_count = 0).
--       AFECTA EXACTAMENTE 1 FILA. Va COMENTADA: es de otra cuenta y no estaba
--       en el pedido. Descomentar solo si Diego lo decide.
-- UPDATE conversations
--    SET status = 'cerrado',
--        updated_at = now()
--  WHERE user_id = 'f771e75e-c12a-4010-b301-d59796da5168'
--    AND status = 'recontacto'
--    AND recontacto_excluido IS TRUE;

-- ----------------------------------------------------------------------------
-- BLOQUE C — ALTERNATIVA, EXCLUYENTE CON EL BLOQUE B. NO CORRER LOS DOS.
-- Devuelve los 40 a la cola en vez de cerrarlos. Toda esa gente pasa a recibir
-- mensajes de la IA: 39 numeros de una agenda personal en la cuenta de Galdames.
-- Queda COMENTADO. Descomentar solo si Diego elige esta opcion en vez de cerrar.
-- ----------------------------------------------------------------------------
-- UPDATE conversations
--    SET recontacto_excluido = false,
--        updated_at = now()
--  WHERE status = 'recontacto'
--    AND recontacto_excluido IS TRUE;

-- ----------------------------------------------------------------------------
-- BLOQUE D — VERIFICACION POSTERIOR. Despues del bloque B tiene que dar 0 filas
-- para Galdames (y 1 si no se corrio B.2).
-- ----------------------------------------------------------------------------
SELECT user_id, count(*) AS en_limbo
  FROM conversations
 WHERE status = 'recontacto'
   AND recontacto_excluido IS TRUE
 GROUP BY user_id;
