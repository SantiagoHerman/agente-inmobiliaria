-- ============================================================================
-- migracion-contactos-dedup.sql
-- LIMPIEZA de contactos DUPLICADOS ya existentes por (user_id, phone, channel).
--
-- CONTEXTO:
--   El "buscar-o-crear contacto" no atomico + sin restriccion unica creo contactos
--   duplicados (mismo user_id + phone + channel -> varias filas en contacts, cada una
--   con su conversacion). Caso real: 5492255622878 con 4 contactos / 4 conversaciones.
--   Este script CONSOLIDA cada grupo en UN solo contacto (el mas viejo) y REAPUNTA todo
--   lo que referencia contact_id, para poder luego crear el indice unico.
--
-- !!!! ESTE SCRIPT BORRA FILAS de contacts !!!!  Por eso es SEGURO por diseno:
--   - Corre TODO dentro de UNA transaccion (BEGIN/COMMIT): si algo falla, ROLLBACK total.
--   - Elige un SOBREVIVIENTE deterministico por grupo: el contacto MAS VIEJO
--     (created_at ASC; desempate por id ASC). Nunca se pierde el historico original.
--   - REAPUNTA primero TODAS las referencias (conversations, citas, recontactos) al
--     sobreviviente, y RECIEN DESPUES borra los duplicados -> nunca deja FKs colgando.
--   - Es IDEMPOTENTE: si ya no hay duplicados, no toca ni borra nada (0 filas afectadas).
--   - No toca contactos que NO estan duplicados.
--
-- ORDEN DE APLICACION (recordatorio):
--   1) PRIMERO este archivo (dedup).
--   2) DESPUES migracion-contactos-unique.sql (crea el indice unico; falla si quedan dup).
--   3) RECIEN AHI desplegar server.js.
--
-- RECOMENDADO ANTES DE CORRER: sacar un snapshot / backup de la tabla contacts
--   (regla del proyecto: backup antes de UPDATE/DELETE). Ej:
--     CREATE TABLE contacts_backup_20260702 AS SELECT * FROM public.contacts;
--   (Dejar comentado; correr manualmente si se desea el respaldo fisico en la base.)
--
-- NOTA sobre channel NULL: agrupamos por COALESCE(channel,'') para que los duplicados
--   con channel NULL/'' TAMBIEN se consoliden. La migracion de indice luego pone
--   channel = 'whatsapp' + NOT NULL, dejando la tabla consistente.
-- ============================================================================

BEGIN;

-- Paso 0: mapa de duplicados -> sobreviviente.
--   Para cada grupo (user_id, phone, canal_norm) con >1 contacto, "keeper_id" = el mas viejo.
--   dup_id = cada uno de los OTROS contactos del grupo (los que se van a consolidar/borrar).
--   Se materializa en una tabla temporal (existe solo durante esta transaccion).
CREATE TEMP TABLE _dedup_map ON COMMIT DROP AS
WITH ranked AS (
  SELECT
    c.id,
    c.user_id,
    c.phone,
    COALESCE(c.channel, '') AS canal_norm,
    first_value(c.id) OVER (
      PARTITION BY c.user_id, c.phone, COALESCE(c.channel, '')
      ORDER BY c.created_at ASC NULLS FIRST, c.id ASC
    ) AS keeper_id
  FROM public.contacts c
)
SELECT id AS dup_id, keeper_id
FROM ranked
WHERE id <> keeper_id;   -- solo los duplicados (excluye al sobreviviente de cada grupo)

-- Si no hay duplicados, _dedup_map queda vacia y todos los UPDATE/DELETE afectan 0 filas.

-- Paso 1: REAPUNTAR conversations de cada duplicado al contacto sobreviviente.
--   (messages cuelga de conversation_id, asi que sigue a la conversacion automaticamente;
--    no tiene contact_id propio -> no requiere reapuntado.)
UPDATE public.conversations cv
   SET contact_id = m.keeper_id
  FROM _dedup_map m
 WHERE cv.contact_id = m.dup_id;

-- Paso 2: REAPUNTAR citas (tienen contact_id). Defensivo: solo si la tabla existe.
DO $$
BEGIN
  IF to_regclass('public.citas') IS NOT NULL THEN
    UPDATE public.citas t
       SET contact_id = m.keeper_id
      FROM _dedup_map m
     WHERE t.contact_id = m.dup_id;
  END IF;
END $$;

-- Paso 3: REAPUNTAR recontactos (tienen contact_id). Defensivo: solo si la tabla existe.
DO $$
BEGIN
  IF to_regclass('public.recontactos') IS NOT NULL THEN
    UPDATE public.recontactos t
       SET contact_id = m.keeper_id
      FROM _dedup_map m
     WHERE t.contact_id = m.dup_id;
  END IF;
END $$;

-- Paso 4: BORRAR los contactos duplicados. Ya no quedan referencias apuntando a ellos
--   (todas fueron reapuntadas arriba), asi que el DELETE es seguro y no deja FKs colgando.
DELETE FROM public.contacts c
 USING _dedup_map m
 WHERE c.id = m.dup_id;

-- Paso 5 (verificacion opcional dentro de la misma tx): cuantos grupos duplicados
--   quedan (deberia ser 0). Descomentar para ver el conteo antes de COMMIT.
-- SELECT user_id, phone, COALESCE(channel,'') AS canal, COUNT(*)
--   FROM public.contacts
--  GROUP BY user_id, phone, COALESCE(channel,'')
-- HAVING COUNT(*) > 1;

COMMIT;
