-- ============================================================================
-- Migracion: campos faltantes de INMOBILIARIA en properties (Fase 0 aditiva)
-- Correr UNA vez en el SQL Editor de Supabase (como owner). properties es UNA
-- tabla compartida multi-tenant; estas columnas son NULLABLE => las propiedades
-- existentes quedan con NULL y el agente las muestra IGUAL que hoy (el texto del
-- inventario solo agrega estos campos cuando tienen valor). Cero riesgo.
-- ============================================================================

alter table public.properties
  add column if not exists dormitorios          integer,
  add column if not exists banos                integer,
  add column if not exists cocheras             integer,
  add column if not exists superficie_cubierta  numeric,
  add column if not exists superficie_total     numeric,
  add column if not exists expensas             numeric,
  add column if not exists apto_credito         boolean,
  add column if not exists antiguedad           text,
  add column if not exists orientacion          text;
