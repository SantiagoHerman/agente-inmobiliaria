-- ============================================================================
-- MIGRACION: SOPORTE CON TICKETS (numero legible + adjunto + hilo de respuestas)
-- ----------------------------------------------------------------------------
-- Mejora el modulo de soporte:
--   1) support_messages: numero de ticket legible (autoincremental por secuencia)
--      + imagen_url (adjunto que sube el cliente al crear la consulta).
--   2) support_respuestas: tabla NUEVA con el hilo de respuestas del Maestro a
--      cada ticket (texto + imagen opcional), editable. Aislada por user_id del
--      tenant para mantener el aislamiento multi-tenant.
--
-- NO EJECUTAR automaticamente: la corre el supervisor a mano.
-- Es IDEMPOTENTE (IF NOT EXISTS) y NO toca filas existentes. El backend lee y
-- escribe SIEMPRE defensivo: si una columna/tabla aun no existe, degrada sin
-- romper el soporte (incluido el agente IA /api/soporte/agente, que NO se toca).
--
-- MODELO ELEGIDO: tabla separada `support_respuestas` (NO un campo `tipo` sobre
-- support_messages). Razon: cada fila de support_messages YA representa una
-- consulta del cliente (1 ticket); las respuestas del Maestro pueden ser varias
-- por ticket y editables. Una tabla aparte mantiene support_messages limpio (el
-- agente IA y "Mis consultas" siguen leyendo solo consultas) y el hilo crece sin
-- mezclar consultas con respuestas.
-- ============================================================================

-- ---------- 1) support_messages: numero legible + adjunto del cliente ----------

-- Numero de ticket legible (entero, autoincremental). Usamos una SECUENCIA propia
-- (no serial) para poder agregarla a una tabla ya existente de forma idempotente y
-- backfillear las filas viejas en orden de creacion.
CREATE SEQUENCE IF NOT EXISTS support_ticket_seq;

ALTER TABLE support_messages
  ADD COLUMN IF NOT EXISTS numero integer;

ALTER TABLE support_messages
  ADD COLUMN IF NOT EXISTS imagen_url text;

-- Backfill: asignar numero a los tickets viejos que aun no lo tienen, respetando
-- el orden de creacion (los mas antiguos => numeros mas chicos). Idempotente:
-- solo toca filas con numero NULL.
DO $$
DECLARE r RECORD;
BEGIN
  FOR r IN SELECT id FROM support_messages WHERE numero IS NULL ORDER BY created_at ASC, id ASC LOOP
    UPDATE support_messages SET numero = nextval('support_ticket_seq') WHERE id = r.id;
  END LOOP;
END $$;

-- Default para filas nuevas (por si algun insert no setea el numero en el backend).
ALTER TABLE support_messages
  ALTER COLUMN numero SET DEFAULT nextval('support_ticket_seq');

-- Indice para buscar/ordenar por numero rapido.
CREATE INDEX IF NOT EXISTS idx_support_messages_numero ON support_messages (numero);
CREATE INDEX IF NOT EXISTS idx_support_messages_user_id ON support_messages (user_id);

-- ---------- 2) support_respuestas: hilo de respuestas del Maestro ----------

CREATE TABLE IF NOT EXISTS support_respuestas (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  support_id  uuid NOT NULL REFERENCES support_messages(id) ON DELETE CASCADE,
  user_id     uuid,                 -- tenant dueno del ticket (aislamiento multi-tenant)
  numero      integer,              -- numero del ticket (denormalizado para mostrar rapido)
  cuerpo      text NOT NULL,
  imagen_url  text,
  autor       text NOT NULL DEFAULT 'maestro',
  editado_at  timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_support_respuestas_support_id ON support_respuestas (support_id);
CREATE INDEX IF NOT EXISTS idx_support_respuestas_user_id ON support_respuestas (user_id);

-- NOTA: el bucket de Storage 'media' YA existe (se usa para fotos de propiedades y
-- multimedia de WhatsApp). Los adjuntos de soporte se guardan bajo la carpeta
-- 'soporte/' del mismo bucket. No hace falta crear bucket nuevo.
--
-- BACKUP: todas las columnas/tablas nuevas viven en la DB => entran al backup
-- general. Los adjuntos viven en Storage 'media' (mismo bucket ya respaldado).
-- No queda dato de soporte fuera de la DB/Storage.
