-- ============================================================================
-- Migracion: UBICACION OSM (Fase 2/3) — geocoding + referencias de zona
-- Correr UNA vez en el SQL Editor de Supabase (como owner/postgres).
--
-- Depende de migracion-direccion-3-mundos.sql (que ya agrego lat/lng + direccion).
-- Agrega:
--   - referencias_zona text : resumen de "que hay cerca" (Overpass), armado 1 vez al geocodificar.
--   - geo_ref text          : la direccion+ciudad que se geocodifico (para re-geocodificar solo si cambia).
--   - tabla geocode_cache   : cache de geocodificaciones de texto libre (ej referencias que pasa un lead)
--                             para NO pegarle a Nominatim dos veces por lo mismo.
--
-- HOTEL no aparece: guarda referencias_zona / geo_ref en el jsonb hotel_complejos.atributos.
-- Todo NULLABLE / IF NOT EXISTS => aditivo, idempotente, cero regresion.
-- ============================================================================

-- Flag por cuenta (fail-closed, default OFF): activa la tool buscar_propiedades_cerca,
-- el cron de geocoding para esa cuenta y las referencias de zona en el prompt.
alter table public.business_settings
  add column if not exists ia_ubicacion boolean default false;

alter table public.properties
  add column if not exists referencias_zona text,
  add column if not exists geo_ref          text;

alter table public.developments
  add column if not exists referencias_zona text,
  add column if not exists geo_ref          text;

-- Cache de geocodificacion de texto libre (clave = texto normalizado). Sin user_id: las coordenadas
-- de una direccion son un dato publico/geografico, no PII, y se comparte el cache entre cuentas.
create table if not exists public.geocode_cache (
  q          text primary key,
  lat        numeric,
  lng        numeric,
  encontrado boolean default true,
  created_at timestamptz default now()
);

-- RLS ON (regla del proyecto: toda tabla nueva en public lleva RLS). Solo la toca el backend con
-- service key (que ignora RLS) => sin politicas = cerrado para anon/authenticated. Ver memoria rls.
alter table public.geocode_cache enable row level security;

notify pgrst, 'reload schema';
