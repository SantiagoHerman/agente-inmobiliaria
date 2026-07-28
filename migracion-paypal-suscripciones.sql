-- ============================================================================
-- migracion-paypal-suscripciones.sql
-- PROPUESTA — *** NO CORRIDA ***. La ejecuta Diego cuando de el "dale".
--
-- Agrega a public.subscriptions lo minimo para poder cobrar en USD por PayPal EN PARALELO
-- al cobro en ARS por MercadoPago, sin tocar ni una columna de las que ya existen.
--
-- Por que hace falta: hoy la fila de suscripcion identifica al cobro con `mp_preapproval_id`
-- (el preapproval de MercadoPago). Una suscripcion de PayPal tiene un id propio (formato I-XXXXXXXXXXXX)
-- que NO es un preapproval de MP: si lo guardaramos en la misma columna, `mpCancelarSuscripcion`,
-- `revisarSuscripciones` (que re-consulta MP con ese id) y `/api/recarga/checkout` lo tratarian como
-- si fuera de MP y romperian (o cancelarian contra la API equivocada). Por eso va en su propia columna.
--
-- ADITIVO Y REVERSIBLE: 2 columnas nuevas, ambas nullable y sin default destructivo. Una fila
-- existente queda con paypal_subscription_id = NULL y pasarela = NULL => TODO el codigo actual
-- (que solo mira mp_preapproval_id) se comporta EXACTAMENTE igual que hoy.
--
-- Correr en el SQL editor de Supabase y DESPUES el NOTIFY del final: sin el NOTIFY, PostgREST no ve
-- las columnas nuevas y los writes fallan con PGRST204 (gotcha ya conocido de este proyecto).
-- ============================================================================

-- 1) Id de la suscripcion en PayPal (formato "I-BW452GLLEP1G"). NULL = esta cuenta no paga por PayPal.
ALTER TABLE public.subscriptions
  ADD COLUMN IF NOT EXISTS paypal_subscription_id text;

-- 2) Por donde paga esta cuenta: 'mercadopago' | 'paypal' | NULL (sin cobro / historico).
--    Es informativo/desempate para el panel y para el GET de estado. La AUTORIDAD sigue siendo
--    que columna de id esta poblada (mp_preapproval_id vs paypal_subscription_id).
ALTER TABLE public.subscriptions
  ADD COLUMN IF NOT EXISTS pasarela text;

-- 3) Una suscripcion de PayPal no puede estar duplicada en dos cuentas. Indice UNICO PARCIAL
--    (solo sobre las filas que tienen id de PayPal, asi los NULL no colisionan entre si).
CREATE UNIQUE INDEX IF NOT EXISTS idx_subscriptions_paypal_sub_id
  ON public.subscriptions (paypal_subscription_id)
  WHERE paypal_subscription_id IS NOT NULL;

-- 4) IDEMPOTENCIA DEL WEBHOOK DE PAYPAL. PayPal REINTENTA un webhook hasta que le contestes 200
--    (y puede mandar el mismo evento mas de una vez igual). Sin una marca persistida, un
--    BILLING.SUBSCRIPTION.ACTIVATED repetido podria resetear el contador de mensajes del periodo
--    (= regalar cupo) dos veces. Mismo patron "marca-primero" que ya usa la RECARGA de MP con
--    mensajes_extra_mov.nota + indice unico: el segundo insert choca (23505) y se descarta el evento.
--    El id que se guarda es el `id` del evento de PayPal (formato "WH-...").
--    OJO: el backend BORRA la marca si el evento no se llego a aplicar (falla la consulta a PayPal, falla
--    la base). Si no lo hiciera, un fallo transitorio dejaria el evento marcado como "procesado" para
--    siempre y la cuenta de un cliente que YA PAGO nunca se activaria. Por eso la fila que queda aca es
--    "evento efectivamente aplicado", no "evento recibido".
CREATE TABLE IF NOT EXISTS public.paypal_webhook_eventos (
  event_id     text PRIMARY KEY,          -- id del evento de PayPal (unico por evento, NO por reintento)
  event_type   text,                      -- BILLING.SUBSCRIPTION.ACTIVATED, PAYMENT.SALE.COMPLETED, etc.
  resource_id  text,                      -- id del recurso (subscription id / sale id)
  user_id      uuid,                      -- tenant al que se aplico (si se pudo resolver)
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_paypal_webhook_eventos_created
  ON public.paypal_webhook_eventos (created_at DESC);

-- RLS: nadie desde el front. Solo el backend, que usa la service key (bypassea RLS).
-- Sin politicas => con RLS activo el anon/authenticated no lee ni escribe NADA. Es lo que queremos:
-- es una tabla de plomeria del cobro. (Gotcha del proyecto: toda tabla nueva necesita ENABLE RLS.)
ALTER TABLE public.paypal_webhook_eventos ENABLE ROW LEVEL SECURITY;

-- IMPORTANTE: correr esto AL FINAL para que PostgREST vea las columnas y la tabla nuevas.
NOTIFY pgrst, 'reload schema';

-- ============================================================================
-- ROLLBACK (si hiciera falta desarmar):
--   DROP TABLE IF EXISTS public.paypal_webhook_eventos;
--   DROP INDEX IF EXISTS public.idx_subscriptions_paypal_sub_id;
--   ALTER TABLE public.subscriptions DROP COLUMN IF EXISTS pasarela;
--   ALTER TABLE public.subscriptions DROP COLUMN IF EXISTS paypal_subscription_id;
--   NOTIFY pgrst, 'reload schema';
-- ============================================================================
