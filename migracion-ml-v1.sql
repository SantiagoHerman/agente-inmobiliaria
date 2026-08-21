-- ============================================================================
-- Migracion: MERCADOLIBRE v1 (F1 OAuth + F2 leads entrantes) — tabla ml_credentials + flags
-- Correr UNA vez en el SQL Editor de Supabase (con service key / como owner).
-- NO la corras en automatico: revisar antes.
--
-- Patron de seguridad: IGUAL que messenger_credentials (migracion-multicanal.sql) ->
-- RLS ENABLED sin policies, de modo que SOLO la service key (que bypassa RLS)
-- puede leer/escribir. Ni anon ni usuarios logueados pueden tocar estos secretos
-- (access_token / refresh_token). VERIFICADO: messenger_credentials usa exactamente
-- este esquema (enable row level security, cero policies).
--
-- Es ADITIVA: tabla NUEVA + columnas boolean default false. Mientras la tabla este
-- vacia y los flags apagados, el webhook /api/webhook/mercadolibre queda INERTE
-- (responde 200 pero descarta todo) y los endpoints OAuth responden 503/estado vacio.
-- ============================================================================

create table if not exists public.ml_credentials (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null,                        -- tenant dueno de la cuenta de MercadoLibre
  ml_user_id    text,                                 -- id numerico del usuario en ML (matchea el user_id de los webhooks)
  ml_nickname   text,                                 -- nickname visible (para la pantalla de Integraciones)
  access_token  text,                                 -- Bearer para la API de ML (~6h de vida)
  refresh_token text,                                 -- DE USO UNICO: cada refresh devuelve uno nuevo (rotacion)
  token_expiry  timestamptz,                          -- cuando vence el access_token (se refresca con margen)
  scopes        text,                                 -- scopes otorgados en el OAuth
  activo        boolean default false,                -- false = desconectado / grant muerto (invalid_grant)
  created_at    timestamptz default now(),
  updated_at    timestamptz default now(),
  unique(user_id)                                     -- UNA cuenta de ML por tenant (el upsert del callback pisa la fila)
);

-- Indice para resolver el tenant rapido en el webhook (payload.user_id -> ml_user_id).
create index if not exists idx_ml_credentials_ml_user_id on public.ml_credentials (ml_user_id) where activo = true;

-- RLS habilitado y SIN policies: nadie (ni anon ni usuarios logueados) puede tocar la tabla;
-- solo la service key del backend, que ignora RLS. Mismo esquema que messenger_credentials.
alter table public.ml_credentials enable row level security;

-- Flags por cuenta (default false = TODO apagado, byte-identico a hoy):
--   ml_v1          -> F1+F2: OAuth + recepcion de leads como conversaciones (sin respuesta de IA).
--   ml_ia_responde -> F3 (futuro): la IA responde leads de ML. Se crea YA para no migrar de nuevo.
--   ml_publicar_v1 -> F5 (futuro): publicar/importar propiedades. Se crea YA para no migrar de nuevo.
alter table business_settings add column if not exists ml_v1 boolean default false;
alter table business_settings add column if not exists ml_ia_responde boolean default false;
alter table business_settings add column if not exists ml_publicar_v1 boolean default false;

-- PostgREST no refresca el schema solo (gotcha PGRST204): avisarle.
notify pgrst, 'reload schema';
