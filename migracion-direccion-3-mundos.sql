-- ============================================================================
-- Migracion: DIRECCION estructurada para los 3 mundos (Fase 1 aditiva)
-- Correr UNA vez en el SQL Editor de Supabase (como owner/postgres).
--
-- Objetivo: que cada propiedad/emprendimiento pueda guardar una direccion
-- buscable (calle+numero, entre-calles, ciudad) + lat/lng para el geocoding
-- OpenStreetMap posterior. HOTEL no aparece aca: guarda todo en el jsonb
-- hotel_complejos.atributos (keys direccion / entre_calles / ciudad / lat / lng),
-- no necesita ALTER TABLE.
--
-- Todas las columnas son NULLABLE => las filas existentes quedan con NULL y el
-- agente/inventario las muestra IGUAL que hoy (el texto solo agrega estos campos
-- cuando tienen valor). ADITIVO, cero regresion, reversible con DROP COLUMN.
--
-- Convencion UNICA para los 3 rubros: direccion, entre_calles, ciudad, lat, lng.
-- ============================================================================

-- === INMOBILIARIA (properties) ===
alter table public.properties
  add column if not exists direccion     text,
  add column if not exists entre_calles  text,
  add column if not exists ciudad        text,
  add column if not exists lat           numeric,
  add column if not exists lng           numeric;

-- === DESARROLLADORA (developments) ===
alter table public.developments
  add column if not exists direccion     text,
  add column if not exists entre_calles  text,
  add column if not exists ciudad        text,
  add column if not exists lat           numeric,
  add column if not exists lng           numeric;

-- IMPRESCINDIBLE (gotcha PGRST204): refrescar el cache de esquema de PostgREST,
-- si no los INSERT/UPDATE sobre las columnas nuevas fallan en silencio.
notify pgrst, 'reload schema';
