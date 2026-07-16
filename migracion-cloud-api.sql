-- ============================================================================
-- Migracion: WHATSAPP CLOUD API (oficial de Meta) — modulo NUEVO, 100% ADITIVO
-- Correr UNA vez en el SQL Editor de Supabase (como owner/postgres).
--
-- NO toca NADA del camino actual de WhatsApp (Evolution / Baileys): no altera
-- whatsapp_instancias, contacts, conversations ni messages. Solo agrega 2 tablas
-- nuevas + 1 columna-flag en business_settings (default FALSE => modulo APAGADO
-- para todos los clientes existentes; Anton/Tequendama no cambian en nada).
--
-- Modelo TECH PROVIDER: cada cliente es dueño de SU WABA y SU numero, y le paga
-- los mensajes DIRECTO a Meta. Raices solo orquesta => el token se guarda POR
-- TENANT (nunca hardcodeado, nunca global).
--
-- Todo IF NOT EXISTS => idempotente (se puede correr dos veces sin efecto).
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1) Flag por cuenta (fail-closed, default OFF). Con OFF, el modulo entero es
--    inerte: la card no se muestra en el front y canalSalienteDe() da 'evolution'.
-- ---------------------------------------------------------------------------
alter table public.business_settings
  add column if not exists cloud_api_v1 boolean default false;

-- ---------------------------------------------------------------------------
-- 2) Numeros de WhatsApp Cloud API conectados, POR TENANT.
--    - token: el access token del cliente. El de la consola de Meta VENCE en 24h;
--      para la demo se pega a mano desde el panel, en produccion llega por
--      Embedded Signup (token de System User, de larga duracion).
--    - activo: default FALSE a proposito. Conectar un numero NO lo enciende solo.
-- ---------------------------------------------------------------------------
create table if not exists public.cloud_api_numbers (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null,              -- dueño/tenant (auth.users.id del DUEÑO, no del asesor)
  waba_id         text,                       -- WhatsApp Business Account ID
  phone_number_id text,                       -- Phone Number ID (con el que Meta identifica el numero en el webhook)
  display_number  text,                       -- numero visible, solo para mostrar en el panel (ej. +1 555 148 2759)
  token           text,                       -- access token del tenant (NUNCA se devuelve entero por la API)
  verificado      boolean default false,      -- true = el GET a /<phone_number_id> contra Meta respondio OK
  activo          boolean default false,      -- default OFF: conectar != encender
  creado_at       timestamptz default now()
);

-- Lookup del webhook: Meta manda el phone_number_id y con eso resolvemos el tenant.
create index if not exists cloud_api_numbers_phone_number_id_idx
  on public.cloud_api_numbers (phone_number_id);
create index if not exists cloud_api_numbers_user_id_idx
  on public.cloud_api_numbers (user_id);

-- ---------------------------------------------------------------------------
-- 3) Cache de plantillas (las aprueba Meta, nosotros solo las listamos/mostramos).
--    Fuente de verdad = Meta; esto es cache para que el panel abra rapido.
-- ---------------------------------------------------------------------------
create table if not exists public.cloud_api_templates (
  id                uuid primary key default gen_random_uuid(),
  user_id           uuid not null,
  nombre            text,
  categoria         text,                     -- MARKETING | UTILITY | AUTHENTICATION
  idioma            text,                     -- ej. es_AR, en_US
  estado_aprobacion text,                     -- APPROVED | PENDING | REJECTED | ...
  cuerpo            text,                     -- texto del componente BODY (para previsualizar)
  meta_template_id  text,
  actualizado_at    timestamptz default now()
);

create index if not exists cloud_api_templates_user_id_idx
  on public.cloud_api_templates (user_id);
-- Una plantilla es unica por (tenant, nombre, idioma) => el refresco hace upsert sobre esto.
create unique index if not exists cloud_api_templates_uniq
  on public.cloud_api_templates (user_id, nombre, idioma);

-- ---------------------------------------------------------------------------
-- 3.bis) ORIGEN de la conversacion (B1c). Columna NUEVA, ADITIVA y OPCIONAL.
--
-- PARA QUE: decidir por QUE canal se RESPONDE, POR CONVERSACION y no por cuenta.
--   - null (DEFAULT, y el valor de TODAS las conversaciones que existen hoy) => Evolution,
--     el camino de SIEMPRE. Anton/Tequendama no cambian en NADA.
--   - 'cloud' => la conversacion NACIO por WhatsApp Cloud API (la creo procesarMensajeCloud).
--     Es la UNICA que puede responderse por Cloud.
--
-- POR QUE HACE FALTA: sin esto, prender cloud_api_v1 desviaba TODO el WhatsApp saliente de la
-- cuenta al numero Cloud nuevo, incluidas las respuestas a los leads VIEJOS que solo conocen el
-- numero de Evolution. Esos mensajes MUEREN (Meta los rechaza por la ventana de 24h: el lead
-- nunca le escribio a ese numero) y encima la conversacion ya habia quedado marcada como
-- atendida por humano y con la IA apagada. Prender un flag no puede romper la bandeja historica.
--
-- POR QUE UNA COLUMNA NUEVA Y NO conversations.channel (que ya existe): channel es VISIBLE en la
-- UI y agrupa los reportes por canal, y ademas es parte del dedupe unico (user_id, phone,
-- channel) de contacts -> meterle un valor nuevo ensuciaria pantallas/metricas y podria duplicar
-- contactos. Para el CRM esto ES WhatsApp (channel='whatsapp' es correcto); canal_origen responde
-- otra pregunta distinta (por que caño se contesta) y por eso va en su propia columna.
--
-- Sin default a proposito: null = Evolution. Nada la lee salvo el modulo Cloud API.
-- ---------------------------------------------------------------------------
alter table public.conversations
  add column if not exists canal_origen text;

-- ---------------------------------------------------------------------------
-- 4) RLS ON en ambas tablas.
--    GOTCHA CONOCIDO DEL PROYECTO (memoria "RLS tablas sin proteger"): toda tabla
--    nueva en public necesita ENABLE ROW LEVEL SECURITY o queda EXPUESTA a anon.
--    Sin policies = cerrado para anon/authenticated. El backend usa la SERVICE KEY
--    (que ignora RLS) => el modulo funciona igual. El front NUNCA lee estas tablas
--    directo: va por /api/cloud-api/* (ver memoria "RLS business_settings owner").
--    Ojo: aca viven TOKENS. Que quede sin policies es DELIBERADO.
-- ---------------------------------------------------------------------------
alter table public.cloud_api_numbers   enable row level security;
alter table public.cloud_api_templates enable row level security;

-- ---------------------------------------------------------------------------
-- 5) OBLIGATORIO: refrescar el cache de schema de PostgREST.
--    Sin esto, PostgREST sigue con el schema viejo y TODA escritura a las tablas
--    nuevas falla MUDA con PGRST204 (gotcha conocido: memoria "Supabase migraciones/cache").
-- ---------------------------------------------------------------------------
notify pgrst, 'reload schema';
