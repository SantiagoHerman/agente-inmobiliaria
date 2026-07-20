-- ============================================================================
-- #7 COLA DURABLE de mensajes entrantes.
-- Correr en el SQL Editor de Supabase CUANDO apliquemos la feature (al mergear la rama feature/cola-durable).
-- Guarda el payload CRUDO de cada WhatsApp entrante apenas llega, para que ningun mensaje se pierda si el
-- procesamiento crashea o Supabase/Evolution parpadea. RLS ON (solo el backend con service key la usa).
-- ============================================================================
create table if not exists public.cola_entrantes (
  id            uuid primary key default gen_random_uuid(),
  wa_message_id text,
  instancia     text,
  telefono      text,
  payload       jsonb,
  estado        text default 'recibido',   -- recibido | procesado | perdido
  intentos      int  default 0,
  error         text,
  created_at    timestamptz default now(),
  updated_at    timestamptz
);
alter table public.cola_entrantes enable row level security;
create index if not exists idx_cola_estado on public.cola_entrantes(estado);
create index if not exists idx_cola_wamid  on public.cola_entrantes(wa_message_id);
notify pgrst, 'reload schema';
