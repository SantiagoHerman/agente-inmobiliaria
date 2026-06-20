-- ============================================================================
-- Migracion: tabla messenger_credentials (multicanal Meta: Messenger + Instagram)
-- Correr UNA vez en el SQL Editor de Supabase (con service key / como owner).
-- NO la corras en automatico: revisar antes.
--
-- Patron de seguridad: igual que maestro_config / maestro_notificaciones ->
-- RLS ENABLED sin policies, de modo que SOLO la service key (que bypassa RLS)
-- puede leer/escribir. Ni anon ni usuarios logueados pueden tocar estos secretos
-- (page_access_token / app_secret).
--
-- Es ADITIVO: tabla NUEVA. No toca WhatsApp ni ninguna tabla existente.
-- Mientras esta tabla este vacia, el webhook /api/webhook/meta queda INERTE
-- (responde verificacion/200 pero no procesa ningun mensaje).
-- ============================================================================

create table if not exists public.messenger_credentials (
  id                uuid primary key default gen_random_uuid(),
  user_id           uuid not null,                       -- tenant dueno de la pagina/cuenta
  canal             text not null,                       -- 'messenger' | 'instagram'
  page_id           text,                                -- Facebook Page ID (Messenger)
  page_access_token text,                                -- token de pagina para Graph API
  ig_user_id        text,                                -- Instagram Business/Pro user ID
  app_secret        text,                                -- para validar X-Hub-Signature-256 (HMAC)
  verify_token      text,                                -- token de verificacion del webhook (GET hub.verify_token)
  activo            boolean not null default true,
  created_at        timestamptz not null default now()
);

-- Indices para resolver el tenant rapido por page_id (Messenger) o ig_user_id (Instagram)
-- en el POST del webhook, y para buscar verify_token activos en el GET de verificacion.
create index if not exists idx_messenger_cred_page_id    on public.messenger_credentials (page_id)    where activo = true;
create index if not exists idx_messenger_cred_ig_user_id on public.messenger_credentials (ig_user_id) where activo = true;
create index if not exists idx_messenger_cred_user_id    on public.messenger_credentials (user_id);

-- RLS habilitado y SIN policies: nadie (ni anon ni usuarios logueados) puede tocar la tabla;
-- solo la service key del backend, que ignora RLS. Mismo esquema que maestro_config.
alter table public.messenger_credentials enable row level security;
