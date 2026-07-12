-- ============================================================================
-- ETAPA 2 — DESARROLLADORA: reserva/seña de unidad (SIN pagos linkeados).
-- ADITIVA + IDEMPOTENTE + GATEADA por business_settings.dev_reservas_v1 (default false).
-- Calcada del patron hotel_reservas, SIN campos de pasarela de pago: la seña se registra
-- SOLO por COMPROBANTE subido (comprobante_url, patron hotel_pagos.proof_url). PROHIBIDO
-- MercadoPago/checkout (restriccion maestra de Diego 2026-07-12).
-- Depende de ETAPA 1 (developments/development_units con IDs estables).
-- No toca de forma destructiva ninguna tabla existente. Nada se activa hasta prender el
-- flag por cuenta. Correr en el SQL Editor de Supabase (owner) con Diego mirando.
-- ============================================================================

-- ===== TABLA NUEVA: dev_reservas =====
create table if not exists public.dev_reservas (
  id                uuid primary key default gen_random_uuid(),
  user_id           uuid not null,
  development_id    uuid references public.developments(id)      on delete cascade,
  unit_id           uuid references public.development_units(id) on delete set null,
  contact_id        uuid references public.contacts(id)          on delete set null,
  conversation_id   uuid references public.conversations(id)     on delete set null,
  estado            text not null default 'tentativa'
                      check (estado in ('tentativa','senada','confirmada','caida')),
  monto_sena        numeric(14,2),
  moneda            text default 'USD',
  comprobante_url   text,          -- URL del comprobante subido (foto/PDF). NUNCA pasarela.
  motivo_caida      text,          -- motivo obligatorio al pasar a 'caida'
  notas             text,
  created_by        uuid,
  created_at        timestamptz default now(),
  updated_at        timestamptz default now()
);

-- ===== INDICES =====
create index if not exists idx_dev_reservas_dev          on public.dev_reservas (development_id);
create index if not exists idx_dev_reservas_unit_estado  on public.dev_reservas (unit_id, estado);
create index if not exists idx_dev_reservas_activa       on public.dev_reservas (unit_id) where estado in ('senada','confirmada');
create index if not exists idx_dev_reservas_user_estado  on public.dev_reservas (user_id, estado);
create index if not exists idx_dev_reservas_conv         on public.dev_reservas (conversation_id);
create index if not exists idx_dev_reservas_contact      on public.dev_reservas (contact_id);

-- ===== RLS (owner, mismo patron que hotel_reservas) =====
alter table public.dev_reservas enable row level security;
drop policy if exists dev_reservas_owner on public.dev_reservas;
create policy dev_reservas_owner on public.dev_reservas for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- ===== FLAG GATE (default false => nada cambia hasta prenderlo por cuenta) =====
alter table public.business_settings add column if not exists dev_reservas_v1 boolean default false;

-- ===== PERFIL DEL COMPRADOR (perfil inversor persistido, capturado por la IA sin costo extra) =====
-- 'vivienda' | 'inversion' (o vacio). Aditiva, nullable.
alter table public.contacts add column if not exists perfil_comprador text;

notify pgrst, 'reload schema';
