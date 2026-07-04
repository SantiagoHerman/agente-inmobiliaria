-- ============================================================================
-- Migracion: AVISO DE SISTEMA — team_messages.es_sistema (autor "Sistema/IA")
-- ----------------------------------------------------------------------------
-- Agrega un flag booleano para MARCAR los avisos automaticos que la IA/el motor
-- de derivacion postea al canal interno "Todos" (via _postearAvisoInterno y las
-- inserciones inline de avisos SLA). Con el flag en TRUE, el backend
-- (GET /api/equipo/mensajes) muestra esos mensajes firmados como "🤖 Sistema"
-- en vez del nombre del dueno ("Administrador"). Los mensajes normales del chat
-- (los que escriben los usuarios) NO llevan este flag => siguen con su nombre.
--
-- ADITIVA e IDEMPOTENTE (ADD COLUMN IF NOT EXISTS, DEFAULT false): no toca datos
-- existentes ni otras tablas. Las filas viejas quedan en el default (false) =>
-- comportamiento previo intacto. El backend hace escritura DEFENSIVA: si esta
-- columna NO existe todavia, reintenta el insert del aviso SIN esta key para que
-- el aviso interno se postee igual (nunca se pierde por falta de la columna).
--
-- COSTO DE IA = CERO: es un flag de presentacion; no dispara ninguna llamada de IA.
--
-- NOTA schema cache (PGRST204): tras un ADD COLUMN por Management API, PostgREST
-- puede no ver la columna nueva hasta refrescar el cache. El NOTIFY de abajo fuerza
-- el reload para que los writes con `es_sistema` no fallen en silencio.
--
-- Correr UNA vez en el SQL Editor de Supabase (con service key / como owner).
-- NO se ejecuta automaticamente.
-- ============================================================================

alter table public.team_messages add column if not exists es_sistema boolean not null default false;

-- Refrescar el schema cache de PostgREST (evita PGRST204 en el primer write).
notify pgrst, 'reload schema';
