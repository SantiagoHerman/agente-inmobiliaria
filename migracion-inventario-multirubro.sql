-- ============================================================================
-- MIGRACION INVENTARIO MULTI-RUBRO  (ADITIVA — no toca datos de inmobiliaria)
-- ----------------------------------------------------------------------------
-- Objetivo: habilitar los rubros HOTEL/CABAÑAS y DESARROLLADORA SIN romper el
-- inventario inmobiliario existente (tabla `properties`).
--
-- El rubro del cliente vive en business_settings.rubro:
--   'inmobiliaria' | 'hotel_cabanas' | 'desarrolladora'
--
-- Todo es IF NOT EXISTS / ADD COLUMN IF NOT EXISTS: re-ejecutable e idempotente.
-- Mismo patron de seguridad que `properties`: RLS ON + policy auth.uid() = user_id.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1) properties: columnas ADITIVAS (default = comportamiento inmobiliaria actual)
--    tipo_inventario default 'inmobiliaria' => las filas existentes NO cambian.
-- ----------------------------------------------------------------------------
ALTER TABLE properties ADD COLUMN IF NOT EXISTS tipo_inventario text DEFAULT 'inmobiliaria';
ALTER TABLE properties ADD COLUMN IF NOT EXISTS atributos jsonb DEFAULT '{}'::jsonb;
ALTER TABLE properties ADD COLUMN IF NOT EXISTS group_id uuid;
ALTER TABLE properties ADD COLUMN IF NOT EXISTS precio_base numeric;
ALTER TABLE properties ADD COLUMN IF NOT EXISTS moneda text DEFAULT 'ARS';

-- ============================================================================
-- 2) HOTEL / CABAÑAS
-- ============================================================================

-- Complejo / agrupador de unidades (un hotel, un complejo de cabañas, etc.)
CREATE TABLE IF NOT EXISTS inventory_group (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid,
  nombre      text,
  tipo        text,
  ubicacion   jsonb DEFAULT '{}'::jsonb,
  atributos   jsonb DEFAULT '{}'::jsonb,
  activo      boolean DEFAULT true,
  created_at  timestamptz DEFAULT now()
);

-- Tarifas por temporada de una unidad/property
CREATE TABLE IF NOT EXISTS hotel_tarifa (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id          uuid,
  user_id              uuid,
  temporada            text,
  fecha_desde          date,
  fecha_hasta          date,
  precio_noche         numeric,
  moneda               text,
  ocupacion_base       int,
  precio_persona_extra numeric,
  min_noches           int,
  recargo_finde        numeric,
  prioridad            int
);

-- Disponibilidad diaria por unidad/property
CREATE TABLE IF NOT EXISTS hotel_disponibilidad (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id       uuid,
  user_id           uuid,
  fecha             date,
  unidades_totales  int,
  unidades_ocupadas int,
  cerrado           boolean DEFAULT false,
  precio_override   numeric
);

-- ============================================================================
-- 3) DESARROLLADORA
-- ============================================================================

-- Emprendimiento / proyecto
CREATE TABLE IF NOT EXISTS developments (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid,
  nombre        text,
  tipo          text,
  zona          text,
  descripcion   text,
  link          text,
  estado_obra   text,
  avance_pct    int,
  fecha_entrega text,
  dev_data      jsonb DEFAULT '{}'::jsonb,
  activo        boolean DEFAULT true,
  created_at    timestamptz DEFAULT now()
);

-- Sector / Etapa / Edificio dentro de un emprendimiento
CREATE TABLE IF NOT EXISTS development_sectors (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  development_id uuid,
  user_id        uuid,
  nombre         text,
  tipo           text,
  fecha_entrega  text,
  sector_data    jsonb DEFAULT '{}'::jsonb
);

-- Unidades (lote/depto/casa/local/cochera) de un emprendimiento
CREATE TABLE IF NOT EXISTS development_units (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  development_id      uuid,
  sector_id           uuid,
  user_id             uuid,
  tipo_producto       text,
  numero              text,
  tipologia           text,
  m2_cubiertos        numeric,
  m2_totales          numeric,
  superficie_terreno  numeric,
  frente              numeric,
  fondo               numeric,
  orientacion         text,
  piso                text,
  precio              numeric,
  precio_estado       text DEFAULT 'a_consultar',
  moneda              text DEFAULT 'USD',
  estado              text DEFAULT 'disponible',
  unit_data           jsonb DEFAULT '{}'::jsonb,
  images              jsonb DEFAULT '[]'::jsonb
);

-- ============================================================================
-- 4) RLS + POLICIES (mismo patron que properties: cada usuario ve solo lo suyo)
-- ============================================================================

ALTER TABLE inventory_group       ENABLE ROW LEVEL SECURITY;
ALTER TABLE hotel_tarifa          ENABLE ROW LEVEL SECURITY;
ALTER TABLE hotel_disponibilidad  ENABLE ROW LEVEL SECURITY;
ALTER TABLE developments          ENABLE ROW LEVEL SECURITY;
ALTER TABLE development_sectors   ENABLE ROW LEVEL SECURITY;
ALTER TABLE development_units     ENABLE ROW LEVEL SECURITY;

-- Una policy "ALL" por tabla (SELECT/INSERT/UPDATE/DELETE) restringida a auth.uid() = user_id.
-- DROP previo para que la migracion sea re-ejecutable sin error de "policy ya existe".

DROP POLICY IF EXISTS inventory_group_owner ON inventory_group;
CREATE POLICY inventory_group_owner ON inventory_group
  FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS hotel_tarifa_owner ON hotel_tarifa;
CREATE POLICY hotel_tarifa_owner ON hotel_tarifa
  FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS hotel_disponibilidad_owner ON hotel_disponibilidad;
CREATE POLICY hotel_disponibilidad_owner ON hotel_disponibilidad
  FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS developments_owner ON developments;
CREATE POLICY developments_owner ON developments
  FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS development_sectors_owner ON development_sectors;
CREATE POLICY development_sectors_owner ON development_sectors
  FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS development_units_owner ON development_units;
CREATE POLICY development_units_owner ON development_units
  FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

-- ============================================================================
-- 5) INDICES
-- ============================================================================

CREATE INDEX IF NOT EXISTS idx_development_units_dev_estado_tipologia
  ON development_units (development_id, estado, tipologia);

CREATE INDEX IF NOT EXISTS idx_hotel_disponibilidad_prop_fecha
  ON hotel_disponibilidad (property_id, fecha);

-- Indices de apoyo por user_id (consultas tipicas del front, filtran por dueño)
CREATE INDEX IF NOT EXISTS idx_inventory_group_user       ON inventory_group (user_id);
CREATE INDEX IF NOT EXISTS idx_hotel_tarifa_property      ON hotel_tarifa (property_id);
CREATE INDEX IF NOT EXISTS idx_developments_user          ON developments (user_id);
CREATE INDEX IF NOT EXISTS idx_development_sectors_dev     ON development_sectors (development_id);

-- ============================================================================
-- 6) Refrescar el cache de esquema de PostgREST
--    (gotcha conocido: ADD COLUMN / CREATE TABLE via API no refresca el cache
--     y los writes fallan en silencio con PGRST204 hasta este NOTIFY)
-- ============================================================================
NOTIFY pgrst, 'reload schema';
