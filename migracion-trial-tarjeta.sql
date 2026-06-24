-- ============================================================================
-- Migracion (B1): trial con tarjeta upfront (4 dias / 100 mensajes)
-- Correr UNA vez en el SQL Editor de Supabase (con service key / como owner).
-- Es ADITIVO: solo agrega una columna boolean con default false; no toca datos
-- existentes. Marca las suscripciones cuyo periodo de prueba arranca con tarjeta
-- ya cargada (preapproval con start_date = ahora + 4 dias). Distingue ese trial
-- "real" del trial automatico del registro (sin tarjeta) y de un preapproval
-- pending/abandonado: SOLO trial_con_tarjeta = true habilita que la IA responda
-- durante el trial (capeada a 100 mensajes). Los otros dos siguen BLOQUEADOS.
-- ============================================================================

alter table public.subscriptions
  add column if not exists trial_con_tarjeta boolean not null default false;

-- Defensivo: el webhook (transicion trial->active) escribe period_start. Si ya existe (por billing previo) es no-op.
alter table public.subscriptions
  add column if not exists period_start timestamptz;

-- Indice opcional (consultas por estado de trial). No critico.
create index if not exists idx_subs_trial_tarjeta
  on public.subscriptions (trial_con_tarjeta) where trial_con_tarjeta = true;
