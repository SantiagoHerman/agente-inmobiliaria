-- ============================================================================
-- migracion-fichas-fases-245.sql
-- FICHAS DEL CLIENTE — lo que necesitan las fases 2, 4 y 5 + las coincidencias.
-- Diego 2026-08-05. Continua migracion-fichas-v1 (tabla `fichas`, ya creada).
--
-- NO CORRER TODAVIA. Se escribe, no se corre (restriccion dura del pedido). Cuando Diego de el
-- "dale": correr esto en el editor de Supabase -> verificar -> recien ahi prender los flags por cuenta.
--
-- POR QUE HACE FALTA: hoy hay 0 fichas cargadas y 0 coincidencias generadas en TODO el sistema.
-- Las fases 1 y 3 estan desplegadas y no se notan porque nadie carga fichas a mano y el matcheo
-- solo se dispara al guardar una propiedad A MANO desde Inventario (las 271 de Anton entraron por
-- el scraper, asi que nunca corrio). Esta migracion habilita: crear la ficha desde el chat con lo
-- que la IA ya extrajo, generar las coincidencias contra el inventario que YA esta cargado, que la
-- IA proponga fichas, y avisar por vencimiento.
--
-- TODO ARRANCA APAGADO. Los flags nuevos son `default false`: correr esta migracion NO cambia el
-- comportamiento de ninguna cuenta. Recien al prender un flag pasa algo.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1) FLAGS POR CUENTA (business_settings). Todos fail-closed / default OFF.
-- ----------------------------------------------------------------------------

-- coincidencias_v1: prende el barrido inventario<->fichas y la pantalla de coincidencias.
-- Es lo unico que permite VER el matcheo funcionando hoy contra las propiedades ya cargadas.
alter table public.business_settings
  add column if not exists coincidencias_v1 boolean default false;

-- fichas_ia_v1: la IA PROPONE la ficha reusando lo que `extraerDatosLead` ya extrae en cada
-- mensaje (interes, presupuesto y, en hotel, las fechas de estadia). NO agrega ninguna llamada de
-- IA nueva: el costo incremental es ~0. La ficha nace `confirmada=false` y con `creado_por='ia'`.
alter table public.business_settings
  add column if not exists fichas_ia_v1 boolean default false;

-- fichas_ia_matchea: DECISION PENDIENTE DE DIEGO. ¿Una ficha propuesta por la IA y todavia SIN
-- CONFIRMAR entra al matcheo?
--   * Si  -> el sistema funciona desde el dia uno sin que nadie cargue nada, pero con datos que
--            nadie miro todavia.
--   * No  -> sigue vacio igual, solo que ahora con una lista de tareas.
-- Se deja en OFF (no entra) hasta que Diego decida. Cuando decida, es prender ESTA columna, no
-- tocar codigo. La coincidencia ya muestra "ficha propuesta por la IA, sin confirmar".
alter table public.business_settings
  add column if not exists fichas_ia_matchea boolean default false;

-- fichas_avisos_v1: el cron de vencimientos de fichas (alquiler que vence, cuota, check-out).
-- Avisa al canal interno "Todos" del tenant, que es el mismo canal que ya usan los otros avisos.
-- NO le llega nada al cliente final. CERO IA.
alter table public.business_settings
  add column if not exists fichas_avisos_v1 boolean default false;


-- ----------------------------------------------------------------------------
-- 2) COLUMNAS NUEVAS EN `fichas`
-- ----------------------------------------------------------------------------

-- confirmada: DEFAULT TRUE a proposito. Todas las fichas que ya existen fueron cargadas por una
-- persona, o sea que estan confirmadas. La IA es la unica que inserta con `confirmada=false`
-- explicito. Si el default fuera false, prender el flag convertiria retroactivamente en "sin
-- confirmar" a todo lo cargado a mano.
alter table public.fichas
  add column if not exists confirmada boolean not null default true;

-- origen: de donde salio la ficha. 'manual' | 'chat' (el boton de la conversacion) |
-- 'ia_extraccion' (la propuso la IA). `creado_por` ya guarda humano|ia; esto guarda POR QUE CAMINO,
-- que es lo que hay que mostrar en la coincidencia para poder auditar el dato.
alter table public.fichas
  add column if not exists origen text;

-- ficha_origen_id: DECISION DE MODELO DE DIEGO. Cuando una busqueda se CONCRETA, nace una SEGUNDA
-- ficha enlazada y la de busqueda se cierra con resultado 'concreto'. Son cosas distintas: lo que
-- el cliente buscaba vs lo que finalmente paso. Si se mutara la misma ficha se pierde lo que pedia
-- originalmente, y con eso las dos preguntas que importan: cuantas busquedas terminan en operacion
-- y por que se caen las que se caen.
alter table public.fichas
  add column if not exists ficha_origen_id uuid;

-- resultado: como termino la ficha cuando se cierra. 'concreto' | 'perdido' | 'desistio' | null.
alter table public.fichas
  add column if not exists resultado text;

-- Claim de idempotencia del cron de vencimientos. Guarda 'YYYY-MM-DD-uN' (N = dias de anticipacion:
-- 30, 7 o 0) del ultimo aviso mandado por ESTA ficha. El separador es '-' y NO '|' a proposito: el
-- claim se hace con un filtro .or() de PostgREST, que usa la coma como separador y las comillas para
-- escapar, y una key con caracteres raros lo rompe EN SILENCIO (no avisa nunca y nadie se entera).
-- Es una sola columna a proposito: el update condicional que la escribe es
-- el candado anti-doble-envio (mismo patron que tareas_evento.aviso_enviado y
-- recordatorios_lead.disparado). Si el vencimiento se corre a otra fecha, la key cambia y se
-- vuelve a avisar, que es justo lo que hay que hacer.
alter table public.fichas
  add column if not exists aviso_venc_key text;

-- Indice para el cron: buscar lo que vence sin recorrer la tabla entera. `fichas_vencimiento_idx`
-- ya cubre proximo_vencimiento; este cubre `hasta`, que es el campo que usan los contratos y las
-- estadias de hotel (y del que tambien tiene que avisar).
create index if not exists fichas_hasta_idx
  on public.fichas (user_id, hasta) where hasta is not null;

-- Indice para el anti-duplicado: "mismo contacto + mismo tipo + activa" es la regla que decide si
-- se ofrece EDITAR la ficha que ya hay en vez de crear otra (riesgo #3 del plan), y es tambien el
-- upsert que usa la IA para respetar "una intencion = UNA ficha".
create index if not exists fichas_contacto_tipo_estado_idx
  on public.fichas (user_id, contact_id, tipo, estado);


-- ----------------------------------------------------------------------------
-- 3) TABLA `fichas_historial` — el registro de cambios de la ficha
-- ----------------------------------------------------------------------------
-- POR QUE EXISTE: `conversations.cal_fecha_ingreso` / `cal_fecha_salida` se PISAN en cada mensaje.
-- El caso real: "del 15 al 25 de enero... no, mejor del 10 al 15... pasame precio de febrero" hoy
-- termina con FEBRERO guardado y enero borrado sin rastro. Nadie puede saber que ese lead viene
-- moviendo la fecha hace tres semanas, que es justo la senal de que algo no le cierra.
-- Esta tabla es append-only: cada cambio de criterio queda con su fecha y quien lo hizo.
create table if not exists public.fichas_historial (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,                  -- tenant (dueño de la cuenta)
  ficha_id uuid not null,
  campo text not null,                    -- 'desde', 'hasta', 'presupuesto', 'datos.garante', ...
  valor_anterior text,                    -- texto a proposito: sirve para CUALQUIER campo sin migrar
  valor_nuevo text,
  origen text,                            -- 'humano' | 'ia' | 'sistema'
  quien text,                             -- nombre/uid de quien lo cambio (informativo)
  created_at timestamptz not null default now()
);

create index if not exists fichas_historial_ficha_idx
  on public.fichas_historial (user_id, ficha_id, created_at desc);

-- RLS OBLIGATORIO desde el dia uno (regla dura del proyecto: toda tabla nueva multi-tenant).
alter table public.fichas_historial enable row level security;
drop policy if exists fichas_historial_propias on public.fichas_historial;
create policy fichas_historial_propias on public.fichas_historial
  for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());


-- ----------------------------------------------------------------------------
-- 4) TABLA `coincidencias` — el resultado del matcheo, guardado
-- ----------------------------------------------------------------------------
-- POR QUE UNA TABLA Y NO UNA OPORTUNIDAD POR PROPIEDAD: `_ejecutarMatchingPropiedad` crea una
-- Oportunidad BORRADOR + un aviso por cada propiedad que matchea. Barrer las 271 propiedades de
-- Anton por ese camino dejaria 271 borradores y 271 avisos: seria inusable. La coincidencia es un
-- dato (esta propiedad le sirve a esta ficha, con este puntaje y por estos motivos); la Oportunidad
-- sigue siendo la campaña de envio, y se arma cuando alguien decide mandar algo.
create table if not exists public.coincidencias (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,                  -- tenant
  ficha_id uuid not null,
  contact_id uuid not null,               -- redundante a proposito: evita un join para listar
  property_id bigint,                     -- inmobiliaria (properties.id)
  development_id uuid,                    -- desarrolladora (developments.id)
  unit_id uuid,                           -- desarrolladora (development_units.id)
  etiqueta text,                          -- como mostrar la propiedad sin volver a leerla
  score integer not null default 0,
  motivos text,                           -- 'zona+tipo+presupuesto'
  ficha_confirmada boolean not null default true,  -- copia al momento de generar: la coincidencia
                                                   -- avisa "ficha propuesta por la IA, sin confirmar"
  origen text,                            -- 'recalculo' | 'alta_ficha' | 'alta_propiedad'
  estado text not null default 'nueva',   -- 'nueva' | 'vista' | 'descartada'
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- UNA coincidencia por ficha+propiedad. Sin esto, cada corrida del boton "Recalcular" duplicaria
-- todo. Los indices unicos son PARCIALES porque una coincidencia apunta O a una propiedad O a una
-- unidad de desarrollo, nunca a las dos (y en Postgres un UNIQUE con NULLs no deduplica).
create unique index if not exists coincidencias_ficha_prop_uq
  on public.coincidencias (user_id, ficha_id, property_id) where property_id is not null;
create unique index if not exists coincidencias_ficha_unidad_uq
  on public.coincidencias (user_id, ficha_id, unit_id) where unit_id is not null;

create index if not exists coincidencias_user_estado_idx
  on public.coincidencias (user_id, estado, score desc);
create index if not exists coincidencias_contacto_idx
  on public.coincidencias (user_id, contact_id);

alter table public.coincidencias enable row level security;
drop policy if exists coincidencias_propias on public.coincidencias;
create policy coincidencias_propias on public.coincidencias
  for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());


-- ----------------------------------------------------------------------------
-- 5) Refrescar el cache de PostgREST.
-- ----------------------------------------------------------------------------
-- Gotcha conocido del proyecto: ADD COLUMN / CREATE TABLE NO refrescan el schema cache de
-- PostgREST. Sin esto, aunque la columna exista en la base, los reads/writes fallan con PGRST204.
notify pgrst, 'reload schema';
