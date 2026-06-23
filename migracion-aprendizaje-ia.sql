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
