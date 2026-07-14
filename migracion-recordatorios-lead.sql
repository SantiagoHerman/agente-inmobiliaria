-- ============================================================================
-- migracion-recordatorios-lead.sql
-- Tabla para el RECORDATORIO/ALARMA por lead (creado desde el menu de 3 puntos en
-- /conversaciones). El usuario setea dia+hora+texto; a la hora exacta, un cron dispara
-- push + WhatsApp al USUARIO que lo creo y la app muestra un modal con sonido.
-- ADITIVO: no toca ninguna tabla existente. Modelada sobre tareas_evento (mismo patron
-- de claim optimista con un boolean 'disparado').
-- Correr en el SQL editor de Supabase y DESPUES: NOTIFY pgrst, 'reload schema';
-- (sin el NOTIFY, PostgREST no ve las columnas nuevas y los writes fallan en silencio).
-- ============================================================================

CREATE TABLE IF NOT EXISTS recordatorios_lead (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          uuid NOT NULL,                 -- tenant (dueno de la cuenta)
  creado_por       uuid NOT NULL,                 -- auth_user_id del usuario a notificar (dueno o asesor)
  conversation_id  uuid,                          -- lead (opcional)
  contact_id       uuid,                          -- contacto (opcional)
  lead_nombre      text,                          -- para el titulo "Recordatorio {nombre}"
  fecha_hora       timestamptz NOT NULL,          -- cuando disparar (hora exacta)
  texto            text NOT NULL,                 -- que recordar
  estado           text NOT NULL DEFAULT 'pendiente', -- pendiente | visto | cancelado
  disparado        boolean NOT NULL DEFAULT false,    -- claim optimista del cron (evita doble envio)
  disparado_at     timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now()
);

-- Indices para el cron (buscar los que vencen) y para el front (pendientes por usuario).
CREATE INDEX IF NOT EXISTS idx_recordatorios_lead_cron
  ON recordatorios_lead (disparado, fecha_hora) WHERE estado = 'pendiente';
CREATE INDEX IF NOT EXISTS idx_recordatorios_lead_usuario
  ON recordatorios_lead (creado_por, estado);

-- RLS: cada usuario ve/gestiona SOLO sus propios recordatorios (los que creo). El backend
-- usa la service key (bypassea RLS) para el cron; esto es para lecturas directas del front.
ALTER TABLE recordatorios_lead ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'recordatorios_lead' AND policyname = 'recordatorios_lead_propios') THEN
    CREATE POLICY recordatorios_lead_propios ON recordatorios_lead
      FOR ALL USING (auth.uid() = creado_por) WITH CHECK (auth.uid() = creado_por);
  END IF;
END $$;

-- IMPORTANTE: correr esto DESPUES del CREATE TABLE para que PostgREST vea la tabla nueva.
NOTIFY pgrst, 'reload schema';
