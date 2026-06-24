-- ============================================================================
-- Migracion: Etiquetas de leads (configurables por el dueño, asignables por el humano)
-- Correr UNA vez en el SQL Editor de Supabase (como owner). Aditiva, cero riesgo.
-- ----------------------------------------------------------------------------
-- business_settings.etiquetas : catalogo de etiquetas PREDETERMINADAS del tenant
--   = jsonb array de { id, nombre, color }. Lo administra el dueño en Configuracion.
-- conversations.etiquetas : etiquetas ASIGNADAS a ese lead = jsonb array de ids.
--   El humano (dueño o asesor) las agrega/saca desde el detalle del lead.
-- ============================================================================

alter table public.business_settings
  add column if not exists etiquetas jsonb default '[]'::jsonb;

alter table public.conversations
  add column if not exists etiquetas jsonb default '[]'::jsonb;
