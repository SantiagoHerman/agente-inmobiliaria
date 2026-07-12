-- ============================================================================
-- MIGRACION: development_units.estado_updated_at (Etapa 1 — IDs estables)
-- ----------------------------------------------------------------------------
-- Agrega a `development_units` una columna que marca CUANDO cambio el estado de la
-- unidad (disponible/reservado/vendido/bloqueado). La setea el backend cuando el
-- form manual cambia el estado o cuando entra por el endpoint
-- POST /api/inventario/desarrollo/unidad-estado. Sirve para la tarjeta futura de
-- "absorcion / velocidad de venta" (Etapa 3) — unidades vendidas por mes.
--
--   estado_updated_at  timestamptz   -- ultima vez que cambio el estado (NULL = nunca cambiado)
--
-- DEFENSIVO: el backend YA funciona sin esta columna. Todos los writes que la
-- incluyen (merge de guardado + endpoint de estado) reintentan SIN ella si aun no
-- existe (detectan PGRST204 / schema cache). Por eso esta migracion NO es urgente y
-- NO rompe nada si se corre despues del deploy del codigo.
--
-- IDEMPOTENTE (ADD COLUMN IF NOT EXISTS): se puede correr mas de una vez sin romper.
-- NO borra ni reescribe datos existentes. NO toca RLS ni otras tablas.
-- ============================================================================

ALTER TABLE development_units
  ADD COLUMN IF NOT EXISTS estado_updated_at timestamptz;

-- Indice de apoyo para reportes de absorcion (unidades vendidas por periodo).
CREATE INDEX IF NOT EXISTS idx_development_units_estado_ts
  ON development_units (estado, estado_updated_at);

-- ============================================================================
-- Refrescar el cache de esquema de PostgREST
--   (gotcha conocido: ADD COLUMN via API no refresca el cache y los writes
--    a la columna nueva fallan en silencio con PGRST204 hasta este NOTIFY)
-- ============================================================================
NOTIFY pgrst, 'reload schema';
