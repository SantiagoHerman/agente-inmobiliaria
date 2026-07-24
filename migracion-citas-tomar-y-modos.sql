-- ============================================================================
-- MIGRACION: A) "TOMAR" cita tentativa + escalada    B) 3 modos "IA no sabe"
-- ----------------------------------------------------------------------------
-- NO EJECUTAR automaticamente: la corre el dueno a mano en el SQL Editor de
-- Supabase (como owner). Es IDEMPOTENTE (ADD COLUMN IF NOT EXISTS) y NO toca
-- ninguna fila existente de forma que cambie su comportamiento. El backend
-- lee/escribe SIEMPRE defensivo (try/catch + gates fail-safe): funciona aunque
-- estas columnas todavia NO existan (cae al comportamiento ACTUAL EXACTO).
--
-- Aislamiento multi-tenant: igual que `citas` / `business_settings` /
-- `aprendizaje_ia`, el backend accede con la service key y SIEMPRE filtra por
-- user_id (.eq). Por eso NO se crean policies (mismo modelo que el resto de las
-- migraciones de citas).
--
-- GOTCHA OBLIGATORIO (MEMORY: supabase-migraciones-cache): tras cada ADD COLUMN
-- hay que hacer NOTIFY pgrst 'reload schema' o los writes/reads de lo nuevo
-- fallan EN SILENCIO con PGRST204. El NOTIFY va al final.
--
-- NOTA: la columna `citas.departamento_id` (que usa el flujo de tomar) ya la
-- creo migracion-agenda-ia.sql; aca NO se vuelve a crear.
-- ============================================================================

-- ===========================================================================
-- TAREA A) La cita tentativa se puede TOMAR + escalada a Administracion
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- A1) `citas.escalada_avisada`: marca (una sola vez) que YA se aviso a
--     Administracion que esta cita tentativa quedo sin tomar mas de N horas.
--     El cron escalarCitasSinTomar hace un claim optimista sobre esta columna
--     (.eq('escalada_avisada', false) -> solo gana si devuelve filas), igual
--     que enviarRecordatoriosCitas / enviarAvisosTareas. DEFAULT false: las
--     citas existentes arrancan sin escalar. INERTE sin esta columna: el cron
--     filtra por ella; si no existe, el select da error y hace early-return.
-- ---------------------------------------------------------------------------
ALTER TABLE citas
  ADD COLUMN IF NOT EXISTS escalada_avisada boolean DEFAULT false;

-- ---------------------------------------------------------------------------
-- A2) `business_settings.cita_escalada_horas`: cuantas HORAS puede quedar una
--     cita tentativa sin tomar antes de avisar a Administracion. Configurable
--     por cuenta. NULL / fuera de rango (1..168) -> el backend usa DEFAULT 3.
-- ---------------------------------------------------------------------------
ALTER TABLE business_settings
  ADD COLUMN IF NOT EXISTS cita_escalada_horas integer DEFAULT 3;

-- ---------------------------------------------------------------------------
-- A3) `citas.created_at`: el cron escalarCitasSinTomar mide "hace cuanto se
--     creo la cita tentativa" con este timestamp. IF NOT EXISTS: si la columna
--     YA existe (lo normal), esta linea es un NO-OP y NO toca ninguna fila. Si
--     no existiera, se crea con DEFAULT now() (las citas viejas quedan con la
--     fecha de la migracion; a lo sumo escalan 3h despues, comportamiento
--     deseado). El cron ademas tolera su ausencia (si no hay timestamp, NO
--     escala nada = comportamiento actual), asi que esto es solo la garantia.
-- ---------------------------------------------------------------------------
ALTER TABLE citas
  ADD COLUMN IF NOT EXISTS created_at timestamptz DEFAULT now();

-- Indice parcial para que el cron encuentre rapido las tentativas pendientes de
-- escalar (tabla chica, pero mantiene la consulta eficiente al crecer).
CREATE INDEX IF NOT EXISTS idx_citas_tentativas_sin_escalar
  ON citas (user_id)
  WHERE asesor_id IS NULL AND estado = 'agendada' AND escalada_avisada = false;

-- ===========================================================================
-- TAREA B) Que hace la IA cuando NO sabe: 3 modos elegidos por el dueno
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- B1) `business_settings.ia_no_sabe_modo`: 'preguntar' (default, = hoy) |
--     'derivar' | 'preguntar_derivar'. Decide QUE tool se le ofrece al agente
--     y que dice la instruccion del prompt (NO agrega llamadas de IA). NULL /
--     vacio / valor desconocido -> el backend usa 'preguntar' (= comportamiento
--     ACTUAL EXACTO). Se usa text (no enum) para tolerar valores viejos/raros
--     sin romper el insert.
-- ---------------------------------------------------------------------------
ALTER TABLE business_settings
  ADD COLUMN IF NOT EXISTS ia_no_sabe_modo text DEFAULT 'preguntar';

-- ---------------------------------------------------------------------------
-- B2) `business_settings.ia_no_sabe_min`: minutos que espera el modo
--     'preguntar_derivar' antes de derivar sola si el dueno no respondio la
--     consulta. NULL / fuera de rango (1..1440) -> el backend usa DEFAULT 30.
-- ---------------------------------------------------------------------------
ALTER TABLE business_settings
  ADD COLUMN IF NOT EXISTS ia_no_sabe_min integer DEFAULT 30;

-- ---------------------------------------------------------------------------
-- B3) `aprendizaje_ia.derivada_at`: momento en que el cron
--     revisarConsultasDuenoSinResponder derivo esta consulta sin responder (o
--     NULL si todavia no se derivo). Claim optimista (.is('derivada_at', null))
--     para no derivar dos veces la misma consulta. INERTE sin esta columna: el
--     cron filtra por ella; si no existe, el select da error y hace early-return.
-- ---------------------------------------------------------------------------
ALTER TABLE aprendizaje_ia
  ADD COLUMN IF NOT EXISTS derivada_at timestamptz;

-- Indice parcial para el cron (consultas pendientes aun no derivadas).
CREATE INDEX IF NOT EXISTS idx_aprendizaje_pendientes_sin_derivar
  ON aprendizaje_ia (user_id)
  WHERE estado = 'pendiente' AND derivada_at IS NULL;

-- ===========================================================================
-- REFINAMIENTOS (5 pedidos de Diego sobre la base A/B)
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- R2/R3) `team_messages.accion`: metadata (texto JSON) para tarjetas accionables
--     en el chat de equipo. Para la tarjeta de cita tomable:
--       {"tipo":"cita_tomar","cita_id":"<uuid>","departamento_id":"<uuid|null>"}
--     NULLABLE: los mensajes normales quedan con accion NULL (el front los pinta
--     como texto). DEFENSIVO: el backend inserta/lee con retry si la columna aun
--     no existe (cae al comportamiento actual). Se usa text (no jsonb) para
--     serializar/parsear en el backend sin depender del tipo de la columna.
-- ---------------------------------------------------------------------------
ALTER TABLE team_messages
  ADD COLUMN IF NOT EXISTS accion text;

-- ---------------------------------------------------------------------------
-- R2) `business_settings.cita_aviso_canales`: por que CANALES avisar al equipo
--     de una cita (tentativa creada / escalada / derivada). Array (jsonb) subset
--     de ['privado','depto','whatsapp']. DEFAULT ['depto'] = comportamiento de
--     hoy. NULL / vacio / invalido / columna ausente -> el backend usa ['depto'].
-- ---------------------------------------------------------------------------
ALTER TABLE business_settings
  ADD COLUMN IF NOT EXISTS cita_aviso_canales jsonb DEFAULT '["depto"]'::jsonb;

-- ---------------------------------------------------------------------------
-- R4) `citas.historial`: historial de DERIVACIONES de la cita (texto JSON de un
--     array), cada entrada { at, por, de_depto, a_depto, motivo }. NULLABLE: las
--     citas sin derivaciones quedan en NULL. El backend hace append defensivo (si
--     la columna no existe, el update no-opea y la derivacion igual queda firme).
--     Ademas, si la cita tiene conversacion, se deja una traza de SISTEMA en el
--     chat del lead (tabla messages, mismo mecanismo que los pases de asesor).
-- ---------------------------------------------------------------------------
ALTER TABLE citas
  ADD COLUMN IF NOT EXISTS historial text;

-- ---------------------------------------------------------------------------
-- Refrescar el schema cache de PostgREST (gotcha PGRST204). OBLIGATORIO tras
-- los ADD COLUMN para que los reads/writes de lo nuevo no fallen en silencio.
-- ---------------------------------------------------------------------------
NOTIFY pgrst, 'reload schema';
