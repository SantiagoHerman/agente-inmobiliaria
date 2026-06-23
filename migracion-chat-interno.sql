-- ============================================================================
-- Migracion: CHAT INTERNO DEL EQUIPO (humano-a-humano)
-- Chat interno entre los integrantes de una misma cuenta (dueno + asesores).
-- NO toca el flujo de leads: NO reusa messages/conversations y NUNCA dispara
-- Evolution/WhatsApp. Costo de IA = CERO (solo Postgres + push FCM ya existente).
-- Correr UNA vez en el SQL Editor de Supabase (con service key / como owner).
-- Es ADITIVO: solo crea dos tablas nuevas; no toca datos ni tablas existentes.
--
-- IDENTIDAD: participantes[] y leido_por[] guardan AUTH_USER_ID (el id de
-- auth.users que devuelve el token JWT), NO el asesores.id. El dueno de la
-- cuenta no tiene fila en `asesores`, asi que su identidad canonica es su
-- auth_user_id. El push (enviarPushAsesor) tambien usa auth_user_id.
--
-- tipo:
--   'departamento' => canal grupal de un departamento (departamento_id NOT NULL).
--                     Los participantes = miembros del depto (usuario_departamento)
--                     + el dueno de la cuenta. Se resuelven en runtime; participantes[]
--                     puede quedar null para los canales de depto (se recalculan).
--   'dm'           => mensaje directo 1-a-1 (participantes = exactamente 2 auth_user_id,
--                     ordenados para deduplicar el par; departamento_id = null).
-- ============================================================================

create table if not exists public.team_threads (
  id uuid primary key default gen_random_uuid(),
  admin_id uuid not null,                       -- TENANT dueno (aislamiento por cuenta)
  tipo text not null,                           -- 'departamento' | 'dm'
  departamento_id uuid,                         -- NOT NULL si tipo='departamento'; null en dm
  participantes uuid[],                         -- para 'dm': los 2 auth_user_id (ordenados). null en canales de depto.
  created_at timestamptz not null default now()
);

create table if not exists public.team_messages (
  id uuid primary key default gen_random_uuid(),
  thread_id uuid not null references public.team_threads(id) on delete cascade,
  admin_id uuid not null,                       -- TENANT dueno (denormalizado para scope/indices)
  sender_auth_user_id uuid not null,            -- quien lo envia (auth_user_id)
  content text not null,
  media_url text,                               -- opcional (adjunto); null por defecto
  leido_por uuid[] not null default '{}',       -- auth_user_id que ya lo leyeron
  created_at timestamptz not null default now()
);

-- Indices para los lookups del backend.
create index if not exists team_threads_admin_idx       on public.team_threads (admin_id, tipo);
create index if not exists team_threads_depto_idx        on public.team_threads (departamento_id);
create index if not exists team_threads_participantes_idx on public.team_threads using gin (participantes);
create index if not exists team_messages_thread_idx      on public.team_messages (thread_id, created_at);
create index if not exists team_messages_admin_idx       on public.team_messages (admin_id, created_at desc);
