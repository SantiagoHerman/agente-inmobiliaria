-- ============================================================================
-- migracion-historial-estados.sql   (Diego 2026-07-28)
--
-- HISTORIAL DE CAMBIOS DE ESTADO DEL LEAD — quien movio el lead, cuando y por que.
--
-- POR QUE: hoy un lead pasa de 'en_conversacion' -> 'interesado' -> 'listo_humano' -> 'recontacto'
-- -> 'cerrado' y en la base SOLO queda el estado FINAL (conversations.status). No hay forma de
-- responder "quien lo movio a listo_humano y por que" ni de reconstruir el recorrido. El unico
-- rastro parcial era un mensaje de sistema (📋) gateado por historial_estados, que ademas mezcla
-- el historial con el chat y no es consultable/filtrable. Esta tabla deja el rastro ESTRUCTURADO.
--
-- CARACTERISTICAS:
--   * ADITIVA: no toca NINGUNA tabla existente. Solo crea una tabla nueva.
--   * IDEMPOTENTE: se puede correr varias veces (todo es "if not exists").
--   * 0 TOKENS DE IA: esto solo REGISTRA lo que ya paso. No llama a ningun modelo. $0.
--   * FAIL-SAFE: el backend ya esta escrito para que, si esta tabla NO existe, el registro se
--     APAGUE SOLO (circuit breaker en memoria, registrarCambioEstado en server.js) y el cambio de
--     estado del lead siga EXACTAMENTE igual. Se puede correr esta migracion antes o despues de
--     desplegar el codigo, en cualquier orden.
--   * APLICA A LOS 3 MUNDOS (inmobiliaria / hotel_cabanas / desarrolladora): la tabla es del CRM,
--     no del rubro.
--
-- Correr en el SQL Editor de Supabase (owner). El NOTIFY del final es OBLIGATORIO: sin el,
-- PostgREST no ve la tabla nueva y TODOS los inserts fallan en silencio (gotcha conocido).
-- ============================================================================

-- ===== TABLA NUEVA: lead_estados_historial =====
create table if not exists public.lead_estados_historial (
  id               uuid primary key default gen_random_uuid(),

  user_id          uuid not null,                                           -- tenant (dueno de la cuenta)
  conversation_id  uuid references public.conversations(id) on delete cascade,

  estado_anterior  text,                                                    -- null cuando el sitio no lo conocia
  estado_nuevo     text not null,                                           -- en_conversacion / interesado / listo_humano / recontacto / cerrado

  -- QUIEN lo movio:
  --   'ia'      -> el clasificador / las tools del agente
  --   'humano'  -> una persona (panel, celular del dueno, asesor que respondio)
  --   'sistema' -> el backend reaccionando a un evento del lead (volvio a escribir, revivio un cerrado)
  --   'cron'    -> los barridos automaticos (inactividad 72hs, agoto recontactos, rescate)
  origen           text not null default 'sistema'
                     check (origen in ('ia','humano','sistema','cron')),
  actor_asesor_id  uuid,                                                    -- fila en `asesores` del que lo movio (nullable: la IA/crons no tienen)
  motivo           text,                                                    -- texto corto del backend ("clasificacion automatica", "cerro el caso", ...)

  created_at       timestamptz not null default now()
);

-- ===== INDICES =====
-- Vista "un lead": todo el recorrido de una conversacion en orden cronologico (lo que lee el timeline).
create index if not exists idx_lead_estados_hist_conv
  on public.lead_estados_historial (conversation_id, created_at);
-- Vista "la cuenta": ultimos movimientos del tenant (reportes / auditoria).
create index if not exists idx_lead_estados_hist_user_fecha
  on public.lead_estados_historial (user_id, created_at desc);

-- ===== RLS (owner-only, MISMO patron que ia_decisiones / dev_reservas / hotel_reservas) =====
-- El backend escribe con la service key (bypassea RLS). Esta politica es para lecturas directas del
-- front: cada dueno ve SOLO el historial de SU cuenta. GOTCHA del proyecto: toda tabla nueva
-- necesita ENABLE RLS o queda abierta.
alter table public.lead_estados_historial enable row level security;
drop policy if exists lead_estados_historial_owner on public.lead_estados_historial;
create policy lead_estados_historial_owner on public.lead_estados_historial
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- ============================================================================
-- MANTENIMIENTO (OPCIONAL, correr a mano cuando la tabla crezca).
-- Cada cambio de estado deja 1 fila (~0,2 KB). No hay purga automatica a proposito:
-- el dueno decide cuanto historial quiere conservar.
--   delete from public.lead_estados_historial where created_at < now() - interval '365 days';
-- ============================================================================

-- OBLIGATORIO Y AL FINAL: sin esto PostgREST no ve la tabla nueva y los inserts fallan en silencio.
notify pgrst, 'reload schema';
