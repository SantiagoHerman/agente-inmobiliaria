-- ============================================================================
-- ETAPA 4 — INMOBILIARIA: MATCHING propiedad<->lead (gate matching_v1).
-- ADITIVA + IDEMPOTENTE. NO borra ni reescribe datos. NO cambia el comportamiento
-- de ninguna cuenta: el backend YA funciona sin esta columna (el gate _matchingV1Activo
-- y GET /api/ui-flags leen la columna DEFENSIVAMENTE -> ausente = false = matching OFF).
-- Por eso NO es urgente y se puede correr DESPUES del deploy. Correr en el SQL Editor
-- de Supabase (owner) con Diego mirando. CERO IA.
-- ============================================================================

-- Gate del matcher propiedad<->lead. DEFAULT false: ninguna cuenta cambia de
-- comportamiento hasta que Diego lo prenda por cuenta. Cuando esta ON, el ALTA/edicion
-- de una propiedad (o pasar una unidad de desarrollo a 'disponible') genera un BORRADOR
-- de Oportunidad con los leads candidatos + aviso interno al dueno (NO auto-envia nada).
alter table public.business_settings add column if not exists matching_v1 boolean default false;

-- NOTA: la tabla "propiedades mas consultadas" (property_consultas) ya la crea
-- migracion-reportes-e3.sql (Etapa 3). El matching NO necesita tabla nueva: reusa
-- properties / development_units / contacts / conversations / oportunidades existentes.

-- ============================================================================
-- Refrescar el cache de esquema de PostgREST (gotcha: ADD COLUMN via API no lo
-- refresca y los reads/writes a la columna nueva fallan en silencio con PGRST204).
-- ============================================================================
notify pgrst, 'reload schema';
