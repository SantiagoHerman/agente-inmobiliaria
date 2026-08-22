-- ============================================================================
-- Migracion: PUENTE MERCADOLIBRE -> WHATSAPP (F4, gated ml_puente_whatsapp)
-- Correr UNA vez en el SQL Editor de Supabase (con service key / como owner).
-- NO la corras en automatico: revisar antes.
--
-- QUE HABILITA: cuando entra un lead de MercadoLibre con el telefono del interesado,
-- el sistema le escribe el primer mensaje desde el WhatsApp Business del negocio
-- ("Hola Martin, como estas? Nos escribiste recien por Mercado Libre por ...") y, si
-- el lead era una PREGUNTA de ML, ademas contesta ahi que se le escribio por WhatsApp.
-- Si el numero NO tiene WhatsApp, en vez de escribir se le pide un numero (en la
-- pregunta de ML) o se avisa al asesor en la conversacion.
--
-- ES ADITIVA Y FAIL-CLOSED: una tabla NUEVA (vacia) + columnas con default. Mientras
-- ml_puente_whatsapp siga en false, el codigo del puente NO CORRE y el comportamiento
-- de MercadoLibre queda byte-identico al de hoy (F2 + F3). Encender = un UPDATE de una
-- linea por cuenta, sin desplegar:
--   update business_settings set ml_puente_whatsapp = true where user_id = '<uuid>';
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1) FLAG POR CUENTA (default false: nada se enciende solo).
-- ----------------------------------------------------------------------------
alter table business_settings add column if not exists ml_puente_whatsapp boolean default false;

-- ----------------------------------------------------------------------------
-- 2) FUSIBLE: contador diario de mensajes de puente por cuenta (tope 50/dia, en el
--    codigo: _ML_PUENTE_TOPE_DIA). NO es un freno operativo -- el volumen real de
--    leads de ML es de unidades por dia -- es la red para que un bug (una tormenta
--    de reintentos de ML, un cron trabado) no dispare cientos de WhatsApp a leads
--    reales. Mismo patron que recontacto_enviados_hoy / recontacto_enviados_fecha.
--    La fecha se compara contra el dia ARGENTINO (UTC-3), no contra UTC.
-- ----------------------------------------------------------------------------
alter table business_settings add column if not exists ml_puente_enviados_hoy integer default 0;
alter table business_settings add column if not exists ml_puente_enviados_fecha date;

-- ----------------------------------------------------------------------------
-- 3) COLA DE PENDIENTES. Guarda los envios que NO pueden salir en el momento:
--
--    motivo = 'fuera_horario' -> el lead entro con la oficina cerrada. La conversacion
--             de WhatsApp YA queda creada (con una nota de sistema para el asesor) y el
--             mensaje sale en la proxima ventana de horario_oficina.
--
--    motivo = 'espera_wa'     -> lead de tipo 'whatsapp'/'call': el interesado apreto el
--             boton de WhatsApp de la publicacion, ML le abrio el chat con un texto
--             pre-armado y ese mensaje PUEDE entrar solo por Evolution. Si le escribimos
--             al toque, le escribimos dos veces. Se espera 15 minutos y ahi se decide:
--             si ya escribio -> solo se anota el origen; si nunca escribio -> se le manda
--             la presentacion (ese es el lead que hoy se pierde).
--
--    POR QUE UNA TABLA Y NO UN setTimeout EN MEMORIA: Railway reinicia el proceso en
--    cada deploy y "fuera de horario" puede ser 12 horas. Un setTimeout se perderia sin
--    dejar rastro y el lead nunca recibiria nada. La tabla es el mecanismo mas simple
--    que sobrevive un reinicio. La despacha el cron _mlPuenteCronPendientes (cada 5 min,
--    registrado SOLO si estan las env ML_APP_ID / ML_CLIENT_SECRET).
-- ----------------------------------------------------------------------------
create table if not exists public.ml_puente_pendientes (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null,          -- tenant dueno del lead
  lead_id         text not null,          -- id del lead de ML (dedupe de los reintentos del webhook)
  tipo            text,                   -- subtipo del lead (whatsapp / call / contact_request / ...)
  telefono        text not null,          -- telefono YA normalizado (solo digitos, con codigo de pais)
  nombre          text,                   -- nombre del comprador tal cual lo manda ML (viene en MAYUSCULAS)
  titulo          text,                   -- titulo de la publicacion (para el texto del mensaje y la nota)
  item_id         text,                   -- publicacion de ML (trazabilidad)
  conversation_id uuid,                   -- conversacion ya creada (solo en 'fuera_horario'); null en 'espera_wa'
  motivo          text not null,          -- 'fuera_horario' | 'espera_wa'
  ejecutar_at     timestamptz not null,   -- desde cuando el cron puede tomarlo
  estado          text not null default 'pendiente', -- pendiente | hecho | fallido | descartado
  resultado       text,                   -- que paso al cerrarlo (para mirar sin adivinar)
  created_at      timestamptz default now(),
  updated_at      timestamptz default now(),
  unique(user_id, lead_id)                -- DEDUPE: ML reintenta las notificaciones del mismo lead
);

-- El cron pide siempre lo mismo: pendientes vencidos, mas viejo primero.
create index if not exists idx_ml_puente_pendientes_cron
  on public.ml_puente_pendientes (ejecutar_at)
  where estado = 'pendiente';

-- RLS habilitado y SIN policies: solo la service key del backend (que ignora RLS) toca
-- esta tabla. Ni anon ni un usuario logueado pueden leerla ni escribirla. Mismo esquema
-- que ml_credentials / messenger_credentials (toda tabla nueva necesita ENABLE RLS).
alter table public.ml_puente_pendientes enable row level security;

-- PostgREST no refresca el schema solo (gotcha PGRST204): avisarle, si no las columnas
-- nuevas de business_settings devuelven error hasta el proximo reinicio.
notify pgrst, 'reload schema';
