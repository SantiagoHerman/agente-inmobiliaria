-- ============================================================================
-- Migracion (Fase 2 / Parte B - punto 6 / regla 19): APRENDIZAJE DE LA IA
-- Tabla donde la IA guarda las dudas que NO supo resolver, la respuesta del
-- dueno, y el estado de la validacion (si se guardo como regla general o no).
-- Correr UNA vez en el SQL Editor de Supabase (con service key / como owner).
-- Es ADITIVO: solo crea una tabla nueva; no toca datos ni tablas existentes.
--
-- TODO el ciclo de aprendizaje en el backend esta GATED por business_settings.reparto_v2:
-- con el flag OFF nada de esto se escribe. Si esta tabla NO existe, el backend
-- degrada en silencio (la pregunta igual le llega al dueno por WhatsApp, pero no
-- se persiste ni se auto-aplica). Crear esta tabla habilita el ciclo completo.
--
-- estado:
--   'pendiente'    => la IA pregunto al dueno y espera su respuesta.
--   'aplicada'     => la respuesta del dueno se guardo como REGLA GENERAL en knowledge_base (kb_id).
--   'no_aplicable' => la respuesta NO sirve como regla general (cruza datos / no es logica); ver motivo.
-- ============================================================================

create table if not exists public.aprendizaje_ia (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,                       -- TENANT dueno (aislamiento por cuenta)
  conversation_id uuid,                        -- conv donde surgio la duda (puede ser null)
  pregunta text not null,                      -- la duda concreta que la IA no supo resolver
  respuesta_dueno text,                        -- lo que respondio el dueno
  estado text not null default 'pendiente',    -- pendiente | aplicada | no_aplicable
  motivo text,                                 -- si no_aplicable: por que no se guardo como regla
  kb_id uuid,                                  -- si aplicada: id de la fila creada en knowledge_base
  created_at timestamptz not null default now()
);

-- Indices para los lookups del backend (consulta pendiente por tenant, listado por cuenta).
create index if not exists aprendizaje_ia_user_estado_idx on public.aprendizaje_ia (user_id, estado, created_at desc);
create index if not exists aprendizaje_ia_conv_idx on public.aprendizaje_ia (conversation_id);


-- ============================================================================
-- APRENDIZAJE_V2 (LOOP 1 — "CORRECCIONES IA"): FLAG por-cuenta.
-- Agregado 2026-07-03. ADITIVO e IDEMPOTENTE. NO crea tablas nuevas.
-- ----------------------------------------------------------------------------
-- Las CORRECCIONES del dueno a la IA ("no se dice asi, se dice asi") se guardan
-- como items { categoria:'correccion', ... } DENTRO del jsonb existente
-- business_settings.instrucciones_agente (o dentro del perfil indicado en
-- instruccion_perfiles) — NO en una tabla nueva.
--
-- Este flag controla SOLO si esas correcciones se INYECTAN en el system prompt
-- del agente (seccion "CORRECCIONES DEL DUENO", alta prioridad):
--   business_settings.aprendizaje_v2 : boolean, DEFAULT false.
--     true  -> el prompt incluye el bloque de correcciones del set ACTIVO.
--     false / null / ausente -> el prompt NO incluye ese bloque => BYTE-IDENTICO
--                               al actual (comportamiento ACTUAL EXACTO).
--
-- Los endpoints POST /api/agente/correccion y POST /api/agente/conocimiento-desde-consulta
-- funcionan con el flag OFF (agregan el item / la entrada igual, para no perder la
-- correccion); lo unico gateado por este flag es el EFECTO en el prompt.
-- ============================================================================

alter table public.business_settings
  add column if not exists aprendizaje_v2 boolean default false;

-- Refrescar el cache de esquema de PostgREST (gotcha conocido: ADD COLUMN via API
-- no refresca el cache y los reads/writes de la columna nueva fallan en silencio
-- con PGRST204 hasta este NOTIFY).
notify pgrst, 'reload schema';
