-- ============================================================================
-- MIGRACION INVENTARIO MULTI-RUBRO  (ADITIVA — no toca datos de inmobiliaria)
-- ----------------------------------------------------------------------------
-- Objetivo: habilitar los rubros HOTEL/CABAÑAS y DESARROLLADORA con SEPARACION
-- TOTAL: cada rubro vive en SUS PROPIAS tablas, sin compartir con inmobiliaria.
--
-- `properties` queda 100% INMOBILIARIA e INTACTA (esta migracion NO la toca:
--  no agrega columnas, no la lee, no la modifica).
--
-- El rubro del cliente vive en business_settings.rubro:
--   'inmobiliaria' | 'hotel_cabanas' | 'desarrolladora'
--
-- HOTEL:        hotel_complejos / hotel_unidades / hotel_tarifa / hotel_disponibilidad
-- DESARROLLO:   developments / development_sectors / development_units  (sin cambios)
--
-- Todo es IF NOT EXISTS / DROP POLICY IF EXISTS: re-ejecutable e idempotente.
-- Mismo patron de seguridad que `properties`: RLS ON + policy auth.uid() = user_id.
-- ============================================================================

-- ============================================================================
-- 1) HOTEL / CABAÑAS  (tablas autocontenidas — NO usan properties)
-- ============================================================================

-- Complejo / agrupador de unidades (un hotel, un complejo de cabañas, etc.)
CREATE TABLE IF NOT EXISTS hotel_complejos (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid,
  nombre      text,
  tipo        text,
  ubicacion   jsonb DEFAULT '{}'::jsonb,
  atributos   jsonb DEFAULT '{}'::jsonb,
  activo      boolean DEFAULT true,
  created_at  timestamptz DEFAULT now()
);

-- Unidad de hotel/cabaña (pertenece a un complejo). Tabla propia de hotel.
CREATE TABLE IF NOT EXISTS hotel_unidades (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  complejo_id  uuid,
  user_id      uuid,
  numero       text,
  title        text,
  type         text,
  capacidad    int,
  descripcion  text,
  precio_base  numeric,
  moneda       text,
  atributos    jsonb DEFAULT '{}'::jsonb,
  images       jsonb DEFAULT '[]'::jsonb,
  activa       boolean DEFAULT true,
  created_at   timestamptz DEFAULT now()
);

-- Tarifas por temporada de una unidad de hotel
CREATE TABLE IF NOT EXISTS hotel_tarifa (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  unidad_id            uuid,
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

-- Disponibilidad diaria por unidad de hotel
CREATE TABLE IF NOT EXISTS hotel_disponibilidad (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  unidad_id         uuid,
  user_id           uuid,
  fecha             date,
  unidades_totales  int,
  unidades_ocupadas int,
  cerrado           boolean DEFAULT false,
  precio_override   numeric
);

-- ============================================================================
-- 2) DESARROLLADORA  (SIN CAMBIOS — se mantiene igual)
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
-- 3) RLS + POLICIES (mismo patron que properties: cada usuario ve solo lo suyo)
-- ============================================================================

ALTER TABLE hotel_complejos       ENABLE ROW LEVEL SECURITY;
ALTER TABLE hotel_unidades        ENABLE ROW LEVEL SECURITY;
ALTER TABLE hotel_tarifa          ENABLE ROW LEVEL SECURITY;
ALTER TABLE hotel_disponibilidad  ENABLE ROW LEVEL SECURITY;
ALTER TABLE developments          ENABLE ROW LEVEL SECURITY;
ALTER TABLE development_sectors   ENABLE ROW LEVEL SECURITY;
ALTER TABLE development_units     ENABLE ROW LEVEL SECURITY;

-- Una policy "ALL" por tabla (SELECT/INSERT/UPDATE/DELETE) restringida a auth.uid() = user_id.
-- DROP previo para que la migracion sea re-ejecutable sin error de "policy ya existe".

DROP POLICY IF EXISTS hotel_complejos_owner ON hotel_complejos;
CREATE POLICY hotel_complejos_owner ON hotel_complejos
  FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS hotel_unidades_owner ON hotel_unidades;
CREATE POLICY hotel_unidades_owner ON hotel_unidades
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
-- 4) INDICES
-- ============================================================================

CREATE INDEX IF NOT EXISTS idx_hotel_unidades_complejo
  ON hotel_unidades (complejo_id);

CREATE INDEX IF NOT EXISTS idx_hotel_tarifa_unidad
  ON hotel_tarifa (unidad_id);

CREATE INDEX IF NOT EXISTS idx_hotel_disponibilidad_unidad_fecha
  ON hotel_disponibilidad (unidad_id, fecha);

CREATE INDEX IF NOT EXISTS idx_development_units_dev_estado_tipologia
  ON development_units (development_id, estado, tipologia);

-- Indices de apoyo por user_id / FK (consultas tipicas del front, filtran por dueño)
CREATE INDEX IF NOT EXISTS idx_hotel_complejos_user        ON hotel_complejos (user_id);
CREATE INDEX IF NOT EXISTS idx_developments_user           ON developments (user_id);
CREATE INDEX IF NOT EXISTS idx_development_sectors_dev      ON development_sectors (development_id);

-- ============================================================================
-- 5) Refrescar el cache de esquema de PostgREST
--    (gotcha conocido: CREATE TABLE via API no refresca el cache y los writes
--     fallan en silencio con PGRST205/PGRST204 hasta este NOTIFY)
-- ============================================================================
NOTIFY pgrst, 'reload schema';
