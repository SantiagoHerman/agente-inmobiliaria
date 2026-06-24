-- ============================================================================
-- Migracion: CHAT INTERNO DEL EQUIPO — MEDIA (documentos, videos, imagenes, audios)
-- ----------------------------------------------------------------------------
-- Agrega columnas para adjuntar media a los mensajes del chat interno del equipo.
-- ADITIVA e IDEMPOTENTE (ADD COLUMN IF NOT EXISTS): no toca datos existentes ni
-- otras tablas. El envio de TEXTO sigue funcionando aunque estas columnas no
-- existan (el backend hace lectura/escritura DEFENSIVA y reintenta el insert sin
-- estas keys si el error es por columna inexistente).
--
-- COSTO DE IA = CERO: el flujo de media del chat interno SOLO guarda y reproduce
-- el archivo (Storage + reproductor). NUNCA transcribe ni traduce: no llama a
-- transcribirAudioGroq ni a Claude ni a traduccion. El audio del equipo se guarda
-- y se reproduce tal cual.
--
-- Correr UNA vez en el SQL Editor de Supabase (con service key / como owner).
-- NO se ejecuta automaticamente.
--
-- media_tipo: 'image' | 'video' | 'audio' | 'document'
-- media_url:  URL publica del bucket 'media' (carpeta equipo/<user_id>/...)
-- media_nombre: nombre original del archivo (para mostrar/descargar documentos)
-- ============================================================================

alter table public.team_messages add column if not exists media_tipo   text;
alter table public.team_messages add column if not exists media_nombre text;

-- media_url ya fue creada por la migracion del chat interno (migracion-chat-interno.sql).
-- Se incluye aca tambien por IDEMPOTENCIA: si esta migracion se corre en una base
-- donde el chat interno se creo sin esa columna, igual queda consistente.
alter table public.team_messages add column if not exists media_url    text;
