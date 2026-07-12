-- ============================================================================
-- ETAPA 3 — REPORTES COMPLETOS (sirve a los 3 mundos).
-- ADITIVA + IDEMPOTENTE. NO borra ni reescribe datos. NO cambia comportamiento
-- de ninguna cuenta: el backend YA funciona sin estas columnas/tabla (todos los
-- writes que las tocan reintentan / se saltean si aun no existen -> defensivo).
-- Por eso esta migracion NO es urgente y se puede correr DESPUES del deploy.
-- Correr en el SQL Editor de Supabase (owner) con Diego mirando. CERO IA.
-- ============================================================================

-- ===== 1) TIEMPO DE 1a RESPUESTA (tarjeta "Tiempo de 1a respuesta") ==========
-- Se setea UNA sola vez, en el PRIMER mensaje SALIENTE (IA o humano) de cada
-- conversacion. primera_respuesta_ms = latencia desde que se creo la conversacion
-- (primer contacto entrante) hasta esa 1a respuesta. NULL = todavia sin respuesta.
alter table public.conversations add column if not exists primera_respuesta_at timestamptz;
alter table public.conversations add column if not exists primera_respuesta_ms bigint;

-- ===== 2) MOTIVO DE PERDIDA (tarjeta "Motivos de perdida") ===================
-- Select OPCIONAL al CERRAR una conversacion. Valores esperados (validados en el
-- backend): precio | zona | dejo_de_responder | comprado_otro | otro. Se guarda
-- como texto libre defensivo (sin CHECK duro para no romper cierres si en el
-- futuro se agregan motivos). NULL = no se indico motivo.
alter table public.conversations add column if not exists motivo_perdida text;

-- ===== 3) PROPIEDADES MAS CONSULTADAS (contador best-effort, 0 IA) ===========
-- Lo alimenta el backend (service key) cuando la IA resuelve un pedido de foto/info
-- sobre una propiedad/unidad concreta (tool enviar_foto_propiedad). prop_key =
-- numero (o titulo) de la propiedad; consultas = contador acumulado por cuenta.
create table if not exists public.property_consultas (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null,
  prop_key     text not null,            -- numero de propiedad/unidad (o titulo si no hay numero)
  prop_label   text,                     -- etiqueta legible (titulo) para mostrar en el reporte
  consultas    integer not null default 0,
  created_at   timestamptz default now(),
  updated_at   timestamptz default now(),
  unique (user_id, prop_key)
);

create index if not exists idx_property_consultas_user
  on public.property_consultas (user_id, consultas desc);

-- RLS owner-only (mismo patron que dev_reservas / hotel_reservas). El backend usa
-- service key (bypassa RLS); la politica es defensa en profundidad para lecturas
-- directas desde el front (que NO se usan: el reporte va por endpoint backend).
alter table public.property_consultas enable row level security;
drop policy if exists property_consultas_owner on public.property_consultas;
create policy property_consultas_owner on public.property_consultas
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- ============================================================================
-- Refrescar el cache de esquema de PostgREST (gotcha: ADD COLUMN via API no lo
-- refresca y los writes a columnas nuevas fallan en silencio con PGRST204).
-- ============================================================================
notify pgrst, 'reload schema';
