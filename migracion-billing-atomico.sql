-- ============================================================================
-- migracion-billing-atomico.sql
-- ----------------------------------------------------------------------------
-- Objetivo: dejar PLENAMENTE atomicos M9/M10 y completar las columnas que el
-- codigo ya usa de forma DEFENSIVA (con fallback si no existen todavia).
--
-- Es 100% IDEMPOTENTE y backward-compatible:
--   * CREATE OR REPLACE FUNCTION  -> se puede correr varias veces.
--   * ADD COLUMN IF NOT EXISTS    -> no falla si la columna ya existe.
--   * NOTIFY pgrst 'reload schema'-> refresca el cache de PostgREST (Supabase)
--     para que las columnas/funcion nuevas sean visibles SIN reiniciar nada
--     (gotcha conocido: agregar columnas via API no refresca PostgREST y los
--      writes/RPC fallan en silencio con PGRST204 / "function not found").
--
-- Correr UNA vez en el SQL editor de Supabase (o via Management API). Mientras
-- NO se corra, el server ya funciona igual: usa los fallbacks read-modify-write
-- y los reintentos sin las columnas nuevas. Tras correrla, M9/M10 pasan a la via
-- ATOMICA (RPC) y M12/M14 persisten sus columnas sin reintentos.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- (1) RPC registrar_uso_ia  (M10: incremento ATOMICO del consumo de IA)
--     Hace el split PLAN primero / SALDO EXTRA despues y el RETURNING en UNA
--     sola operacion bajo "for update", asi no se pierden incrementos bajo
--     concurrencia (dos webhooks simultaneos no se pisan). Los avisos 80%/100%
--     se derivan del valor RETORNADO. Si esta funcion no existe, el server cae
--     al fallback read-modify-write de a 1 (comportamiento identico al historico).
--
--     p_tope = NULL  -> ilimitado (cortesia): cabe = p_n completo.
--     Extraida del comentario que el build anterior dejo en server.js.
-- ----------------------------------------------------------------------------
create or replace function registrar_uso_ia(p_user_id uuid, p_n int, p_tope numeric)
returns table(usado_antes int, usado_despues int, extra_antes int, extra_despues int)
language plpgsql as $$
declare ua int; ea int; cabe int; del_extra int;
begin
  select coalesce(ai_messages_this_period,0), coalesce(mensajes_extra,0) into ua, ea
    from subscriptions where user_id = p_user_id for update;
  if not found then return; end if;
  if p_tope is null then cabe := p_n;  -- NULL = ilimitado (cortesia)
  else cabe := greatest(0, least(p_n, floor(p_tope)::int - ua)); end if;
  del_extra := least(greatest(0, p_n - cabe), ea);
  update subscriptions
     set ai_messages_this_period = ua + cabe,
         mensajes_extra = ea - del_extra
   where user_id = p_user_id;
  usado_antes := ua; usado_despues := ua + cabe; extra_antes := ea; extra_despues := ea - del_extra;
  return next;
end $$;

-- ----------------------------------------------------------------------------
-- (2) Columnas de billing/subscriptions que el codigo ya usa con fallback.
--     trial_reauth_at (M12): timestamp de re-autorizacion del trial con tarjeta;
--       el cron reconcilia trials que nunca autorizan (corta el "gratis infinito").
--     mp_preapproval_id: id del preapproval de MercadoPago (ya usado en todo el
--       flujo). ADD ... IF NOT EXISTS es no-op si ya existe (normalmente existe).
-- ----------------------------------------------------------------------------
alter table subscriptions add column if not exists trial_reauth_at timestamptz;
alter table subscriptions add column if not exists mp_preapproval_id text;

-- ----------------------------------------------------------------------------
-- (3) Columna messages.intento_count (M14: idempotencia de reintentarFallidos).
--     Lleva la cuenta de reintentos de un mensaje 'human' marcado 'fallido' para
--     no loopear indefinidamente. El server ya la usa con fallback (si no existe,
--     reintenta el select sin ella y solo aplica el guard por wa_message_id).
-- ----------------------------------------------------------------------------
alter table messages add column if not exists intento_count int not null default 0;

-- ----------------------------------------------------------------------------
-- (4) Refrescar el cache de esquema de PostgREST (Supabase) para que la funcion
--     y las columnas nuevas sean visibles de inmediato (evita PGRST204 y
--     "Could not find the function ... in the schema cache").
-- ----------------------------------------------------------------------------
notify pgrst, 'reload schema';
