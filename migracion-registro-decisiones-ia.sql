-- ============================================================================
-- migracion-registro-decisiones-ia.sql   (Diego 2026-07-28)
--
-- REGISTRO DE DECISIONES DE LA IA — "caja negra" del clasificador/derivador.
--
-- POR QUE: hoy cada decision de la IA se escribe SOLO con console.log('[CLASIFICADOR] ...')
-- (server.js ~8349) y ese log vive en Railway y se BORRA. No queda NADA consultable, asi que
-- es imposible auditar lead por lead que decidio la IA y por que. Esta tabla deja el rastro
-- permanente para poder responder, sobre CUALQUIER lead:
--     que le llego -> que decidio la IA -> si derivo, a donde y por que camino ->
--     si el estado se aplico o lo freno un guard -> y si despues lo atendio un humano.
--
-- Casos reales que motivaron esto (los 4 que hay que poder explicar despues):
--   Marcela  -> marcada 'interesado', sin inventario en su zona, NO derivo, quedo sin atencion.
--   Omar     -> respondio un alquiler anual con el precio de VENTA.
--   Veronica -> pregunto UNA vez, nunca mas contesto, quedo marcada 'interesado'.
--   Mabel    -> pidio foto del FRENTE, recibio una de INTERIOR.
--
-- CARACTERISTICAS:
--   * ADITIVA: no toca ninguna tabla existente (solo AGREGA una columna-flag a business_settings).
--   * IDEMPOTENTE: se puede correr varias veces sin romper nada.
--   * 0 TOKENS DE IA: esto solo REGISTRA lo que ya paso. No llama a ningun modelo. $0.
--   * FAIL-SAFE: el backend ya esta escrito para que, si esta tabla NO existe, el registro se
--     APAGUE SOLO (circuit breaker en memoria) y la atencion al lead siga EXACTAMENTE igual.
--     Se puede correr esta migracion antes o despues de desplegar el codigo, en cualquier orden.
--   * GATEADO por business_settings.registro_decisiones_ia, DEFAULT TRUE (default ON: no cambia
--     ningun comportamiento, solo registra). Se apaga por cuenta poniendolo en false.
--
-- Correr en el SQL Editor de Supabase (owner). El NOTIFY del final es OBLIGATORIO: sin el,
-- PostgREST no ve la tabla nueva y TODOS los inserts fallan en silencio (gotcha conocido).
-- ============================================================================

-- ===== TABLA NUEVA: ia_decisiones =====
create table if not exists public.ia_decisiones (
  id                 uuid primary key default gen_random_uuid(),

  -- QUIEN / DONDE / CUANDO -------------------------------------------------
  user_id            uuid not null,                                     -- tenant (dueno de la cuenta)
  conversation_id    uuid references public.conversations(id) on delete cascade,
  turno_id           uuid,                                              -- id del turno/mensaje (mismo que ia_uso.turno_id)
  created_at         timestamptz not null default now(),
  origen             text default 'webhook_whatsapp',                    -- de que camino vino la decision

  -- QUE LE LLEGO AL SISTEMA ------------------------------------------------
  -- Texto del mensaje del lead RECORTADO a 300 caracteres. NO se guarda telefono ni nombre:
  -- esos datos ya viven en `contacts` y se llegan por conversation_id (menos datos personales duplicados).
  mensaje_lead       text,
  mensaje_truncado   boolean not null default false,                     -- true si el original era mas largo que 300

  -- QUE DECIDIO EL CLASIFICADOR --------------------------------------------
  clasificador_corrio boolean not null default true,                     -- false = se salteo (rotacion / estado terminal / trivial)
  estado_previo      text,                                               -- estado de la conversacion ANTES
  estado_propuesto   text,                                               -- lo que propuso el clasificador (interesado / listo_humano / sin_cambio / null)
  estado_despues     text,                                               -- estado de la conversacion DESPUES (leido de la conv, no deducido)
  estado_aplicado    boolean not null default false,                     -- se escribio el estado propuesto?
  -- POR QUE NO se aplico. Valores que escribe el backend:
  --   'sin_cambio' | 'ya_derivo_en_este_mensaje' | 'bloqueo_interesado' | 'no_sube_de_nivel'
  --   'pidio_confirmacion' | 'en_rotacion' | 'estado_terminal' | 'derivo_por_tool'
  motivo_no_aplicado text,
  -- GUARD 'interesado' (ARREGLO 5, server.js ~11050): true = el clasificador dijo 'interesado' pero
  -- se FRENO porque el lead todavia no habia escrito despues de la primera respuesta del negocio.
  -- ESTE es el campo del caso Veronica.
  bloqueo_interesado boolean not null default false,

  -- QUE HERRAMIENTAS USO LA IA EN ESE TURNO --------------------------------
  -- SOLO los NOMBRES (enviar_foto_propiedad, buscar_inventario, derivar_a_humano, ...).
  -- NUNCA los argumentos completos: no infla la base ni duplica datos del lead.
  tools              text[] not null default '{}',

  -- SENALES DEL CLASIFICADOR ------------------------------------------------
  pidio_area         boolean not null default false,                     -- el lead nombro/pidio un area
  deducido           boolean not null default false,                     -- la IA DEDUJO el depto (no se lo pidieron)
  fuera_alcance      boolean not null default false,                     -- pedido fuera de alcance de la IA

  -- DERIVACION --------------------------------------------------------------
  derivo             boolean not null default false,
  -- POR QUE CAMINO derivo. Valores que escribe el backend:
  --   'tool_derivar_v3' | 'agenda_cita' | 'confirmacion_fallback' | 'cambio_tema'
  --   'fuera_alcance' | 'clasificacion_listo_humano' | 'clasificacion_rotacion_v4' | 'red_seguridad'
  derivo_camino      text,
  derivo_motivo      text,                                               -- motivo que escribio la IA en la tool (recortado)
  departamento_id    uuid,                                               -- depto REAL de la conv despues del turno
  departamento_texto text,                                               -- nombre de depto que pidio la IA en la tool (texto libre)

  -- Contexto util para leer el registro sin cruzar tablas
  ia_respondio       boolean not null default true                       -- la IA genero respuesta en este turno
);

-- ===== INDICES =====
-- Vista "un lead": todas las decisiones de una conversacion, mas nueva primero.
create index if not exists idx_ia_decisiones_conv
  on public.ia_decisiones (conversation_id, created_at desc);
-- Vista "ultimas N de la cuenta" + resumen semanal por rango de fechas.
create index if not exists idx_ia_decisiones_user_fecha
  on public.ia_decisiones (user_id, created_at desc);
-- Filtro "las que derivaron" (para ver a donde fueron a parar los leads calientes).
create index if not exists idx_ia_decisiones_derivo
  on public.ia_decisiones (user_id, created_at desc) where derivo = true;
-- Filtro "las que freno el guard" (caso Veronica).
create index if not exists idx_ia_decisiones_bloqueo
  on public.ia_decisiones (user_id, created_at desc) where bloqueo_interesado = true;
-- Filtro "interesado sin derivar" (caso Marcela: quedo interesado y NADIE lo atendio).
create index if not exists idx_ia_decisiones_interesado_sin_derivar
  on public.ia_decisiones (user_id, created_at desc) where estado_despues = 'interesado' and derivo = false;

-- ===== RLS (owner-only, MISMO patron que dev_reservas / hotel_reservas) =====
-- El backend escribe con la service key (bypassea RLS). Esta politica es para lecturas directas
-- del front: cada dueno ve SOLO las decisiones de SU cuenta. GOTCHA del proyecto: toda tabla
-- nueva necesita ENABLE RLS o queda abierta.
alter table public.ia_decisiones enable row level security;
drop policy if exists ia_decisiones_owner on public.ia_decisiones;
create policy ia_decisiones_owner on public.ia_decisiones
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- ===== FLAG GATE (DEFAULT TRUE = ON) =====
-- Default ON a proposito: el registro NO cambia ningun comportamiento, solo deja rastro.
-- Para apagarlo en una cuenta:
--   update public.business_settings set registro_decisiones_ia = false where user_id = '<uuid>';
-- El backend cachea este flag 5 minutos en memoria, asi que el apagado tarda hasta 5 min en tomar efecto.
alter table public.business_settings
  add column if not exists registro_decisiones_ia boolean default true;

-- ============================================================================
-- MANTENIMIENTO (OPCIONAL, correr a mano cuando la tabla crezca).
-- Cada mensaje entrante deja 1 fila (~0,5 KB). No hay purga automatica a proposito:
-- el dueno decide cuanto historial quiere conservar.
--   delete from public.ia_decisiones where created_at < now() - interval '180 days';
-- ============================================================================

-- OBLIGATORIO Y AL FINAL: sin esto PostgREST no ve la tabla nueva y los inserts fallan en silencio.
notify pgrst, 'reload schema';
