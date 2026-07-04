-- ============================================================================
-- Migracion: tabla avisos_maestro (aviso global del Panel Maestro a TODOS los
-- dashboards de los clientes).
-- Correr UNA vez en el SQL Editor de Supabase (con service key / como owner).
-- El Maestro publica un aviso (banner arriba de todos los dashboards; si es
-- 'critico' ademas un modal). Solo puede haber UN aviso activo a la vez: al
-- publicar uno nuevo el backend desactiva (activo=false) los anteriores.
-- Patron de seguridad: igual que maestro_notificaciones -> RLS ENABLED sin
-- policies, de modo que SOLO la service key (que bypassa RLS) puede leer/
-- escribir. El frontend NUNCA toca esta tabla directo: lee via el endpoint
-- GET /api/aviso-activo (backend, service key). CERO IA / CERO tokens.
-- ADITIVO: crea una tabla nueva, no toca datos ni tablas existentes.
-- Idempotente: CREATE TABLE IF NOT EXISTS + create index if not exists.
-- Al final: NOTIFY pgrst 'reload schema' para refrescar el schema cache de
-- PostgREST (gotcha: tras un CREATE TABLE, sin el reload los reads/writes por
-- PostgREST fallan en silencio con PGRST204).
-- ============================================================================

create table if not exists public.avisos_maestro (
  id          uuid primary key default gen_random_uuid(),
  mensaje     text,
  nivel       text default 'normal',                 -- normal | critico
  activo      boolean default true,
  created_at  timestamptz default now()
);

-- Indice para leer rapido el aviso activo mas reciente (GET /api/aviso-activo).
create index if not exists idx_avisos_maestro_activo
  on public.avisos_maestro (created_at desc) where activo = true;

-- RLS habilitado y SIN policies: nadie (ni anon ni usuarios logueados) puede
-- tocar la tabla; solo la service key del backend, que ignora RLS. Mismo
-- esquema que maestro_notificaciones / maestro_config.
alter table public.avisos_maestro enable row level security;

NOTIFY pgrst, 'reload schema';
