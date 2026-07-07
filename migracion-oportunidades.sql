-- ============================================================================
-- MIGRACION: MOTOR "OPORTUNIDADES" (envios segmentados / broadcast)
-- ----------------------------------------------------------------------------
-- Feature ADITIVA y GATEADA OFF (business_settings.oportunidades_v1, default false).
-- Con el flag OFF, el cron procesarOportunidades() hace continue por cuenta y NO
-- manda NADA; los endpoints existen pero no disparan envios.
--
-- Es un broadcast SEPARADO del recontacto: su PROPIA cola (tabla oportunidades) y
-- su PROPIO cupo (max_dia / enviados_hoy), independiente del cupo de recontacto.
-- Un envio se manda UNA sola vez (dedupe via oportunidad_envios). La cola se procesa
-- por PRIORIDAD: una oportunidad a la vez (la de menor `prioridad`); hasta que no
-- llega a estado='completada' no arranca la siguiente.
--
-- SEGURO de correr: usa IF NOT EXISTS / ADD COLUMN IF NOT EXISTS. No toca datos.
-- NOTA (schema cache PostgREST): al final se hace NOTIFY pgrst 'reload schema' para
-- que los ADD COLUMN se reflejen sin reiniciar (gotcha conocido: ADD COLUMN via
-- Management API no refresca PostgREST -> writes fallan en silencio con PGRST204).
-- ============================================================================

-- ---------------------------------------------------------------------------
-- Tabla principal: una fila por "oportunidad" (envio segmentado).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS oportunidades (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           uuid,                                  -- dueno (admin) de la cuenta
  nombre            text,
  estado            text DEFAULT 'en_cola',                -- en_cola | enviando | pausada | completada | borrador
  prioridad         int,                                   -- orden en la cola (menor = antes)
  segmentos         jsonb,                                 -- ["frios","tibios","calientes","en_conversacion","en_recontacto"]
  custom_ids        jsonb,                                 -- ids de conversations elegidas a mano (union con los segmentos)
  mensaje           text,
  media             jsonb,                                 -- { url, tipo }  (tipo: imagen|video|documento)
  link              text,
  max_dia           int,                                   -- tope de envios por dia de ESTA oportunidad
  horario           text,                                  -- ('oficina' | null) -> respeta horario_oficina de la cuenta
  ritmo             text,                                  -- suave | normal | agresivo (referencia; el cron mantiene caps duros)
  programado_para   timestamptz,                           -- no arranca antes de esta fecha (null = ya)
  total             int DEFAULT 0,                         -- tamano del universo al crear (objetivo)
  enviados          int DEFAULT 0,                         -- enviados acumulados
  enviados_hoy      int DEFAULT 0,                         -- enviados en el dia (enviados_fecha)
  enviados_fecha    date,                                  -- fecha del contador enviados_hoy
  created_at        timestamptz DEFAULT now(),
  updated_at        timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS oportunidades_user_estado_idx ON oportunidades (user_id, estado, prioridad);

-- ---------------------------------------------------------------------------
-- Dedupe: un registro por envio efectivo (una oportunidad no manda 2 veces al
-- mismo contacto). Se consulta antes de cada envio.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS oportunidad_envios (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  oportunidad_id    uuid,
  contact_id        uuid,
  conversation_id   uuid,
  enviado_at        timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS oportunidad_envios_op_idx   ON oportunidad_envios (oportunidad_id);
CREATE INDEX IF NOT EXISTS oportunidad_envios_dedup_idx ON oportunidad_envios (oportunidad_id, conversation_id);

-- RLS: habilitada SIN policies -> solo la service key del backend accede (mismo
-- criterio que otras tablas server-side como recontactos/avisos_maestro). El front
-- llega SIEMPRE via endpoints /api/oportunidades (backend + service key).
ALTER TABLE oportunidades      ENABLE ROW LEVEL SECURITY;
ALTER TABLE oportunidad_envios ENABLE ROW LEVEL SECURITY;

-- ---------------------------------------------------------------------------
-- Flag por-cuenta (default OFF). Con esta columna en false/ausente, TODO el motor
-- queda inerte (gate oportunidadesV1Activo -> false).
-- ---------------------------------------------------------------------------
ALTER TABLE business_settings ADD COLUMN IF NOT EXISTS oportunidades_v1 boolean DEFAULT false;

-- Refrescar el schema cache de PostgREST (si no, los writes a las columnas nuevas
-- pueden fallar en silencio con PGRST204 hasta el proximo reinicio).
NOTIFY pgrst, 'reload schema';
