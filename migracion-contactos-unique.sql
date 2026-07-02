-- ============================================================================
-- migracion-contactos-unique.sql
-- INDICE UNICO para impedir contactos DUPLICADOS por (user_id, phone, channel).
--
-- PROBLEMA QUE RESUELVE:
--   El "buscar-o-crear contacto" del backend era un SELECT-luego-INSERT no atomico
--   y SIN restriccion unica en la base. Dos mensajes del mismo telefono con pocos ms
--   de diferencia (rafaga del lead, o el cron reintentarFallidos) creaban 2..N
--   contactos + 2..N conversaciones para el mismo numero. Caso real: telefono
--   5492255622878 ("Juba Electronics") con 4 contactos / 4 conversaciones.
--
--   El fix de codigo usa UPSERT con onConflict:'user_id,phone,channel'. Ese onConflict
--   NECESITA que exista ESTE indice unico de columnas planas; sin el, el upsert no
--   deduplica (y el codigo cae, defensivo, al camino viejo).
--
-- !!!! ORDEN DE APLICACION - IMPORTANTE !!!!
--   1) PRIMERO correr  migracion-contactos-dedup.sql  (limpia los duplicados EXISTENTES).
--   2) DESPUES correr ESTE archivo (crea el indice unico).
--   3) RECIEN AHI desplegar el codigo nuevo (server.js).
--
--   Si quedan duplicados en la tabla, la CREACION DEL INDICE UNICO FALLA
--   ("could not create unique index ... duplicate key value violates uniqueness").
--   -> Por eso el dedup va PRIMERO. Este script no borra nada; solo crea el indice.
--
-- DECISION SOBRE channel NULL (documentada a proposito):
--   Postgres trata cada NULL como DISTINTO en un indice unico -> dos filas con
--   channel IS NULL NO chocarian y seguirian permitiendo duplicados. Para cerrar ese
--   hueco de forma SEGURA y compatible con el onConflict de columnas planas del codigo,
--   forzamos channel a NO-NULL con default 'whatsapp' ANTES de crear el indice:
--     - Hoy TODOS los INSERT del backend ya mandan channel no-null ('whatsapp' /
--       'messenger' / 'instagram'), asi que el backfill solo toca filas legacy.
--     - Con channel NOT NULL, un indice unico de columnas planas (user_id, phone, channel)
--       alcanza para deduplicar y es usable como onConflict target por PostgREST.
--   (Alternativa descartada: indice de expresion sobre COALESCE(channel,'') deduplica
--    los NULL pero NO es utilizable como onConflict de columnas planas en PostgREST.)
-- ============================================================================

BEGIN;

-- 1) Backfill defensivo: cualquier fila legacy con channel NULL o vacio -> 'whatsapp'
--    (el canal por defecto historico). Necesario para poder poner NOT NULL sin romper.
UPDATE public.contacts
   SET channel = 'whatsapp'
 WHERE channel IS NULL OR btrim(channel) = '';

-- 2) Default + NOT NULL en channel: garantiza que NO vuelvan a aparecer NULLs
--    (que romperian la unicidad al ser tratados como distintos por Postgres).
ALTER TABLE public.contacts ALTER COLUMN channel SET DEFAULT 'whatsapp';
ALTER TABLE public.contacts ALTER COLUMN channel SET NOT NULL;

-- 3) Indice unico de columnas planas. IF NOT EXISTS -> idempotente (re-correrlo no falla).
--    ESTE es el conflict target de los UPSERT del backend (onConflict:'user_id,phone,channel').
--    Si aun quedaran duplicados, esta linea FALLA -> correr primero el dedup.
CREATE UNIQUE INDEX IF NOT EXISTS contacts_user_phone_channel_uidx
    ON public.contacts (user_id, phone, channel);

COMMIT;

-- 4) Refrescar el schema cache de PostgREST (Supabase) para que "vea" el indice/columna
--    y el onConflict funcione sin PGRST204. FUERA de la transaccion.
NOTIFY pgrst, 'reload schema';
