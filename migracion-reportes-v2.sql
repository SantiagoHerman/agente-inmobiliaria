-- ============================================================================
-- migracion-reportes-v2.sql   (Diego 2026-08-02)
--
-- MODELO DE DATOS de "Reportes completos" = los TRES objetos que definio Diego:
--     1) LA VISTA    -> public.pipeline_vistas        (filtros CON NOMBRE, viven en el Pipeline)
--     2) EL INFORME  -> public.reportes_informes      (que se muestra, a quien y cuando)
--     3) LA CORRIDA  -> public.reportes_corridas      (los numeros CONGELADOS de una generacion)
--                     + public.reportes_corrida_leads (POR QUIEN ESTABA ASIGNADO CADA LEAD ahi)
--
-- NO CORRER TODAVIA. Este archivo se ESCRIBE ahora y se aplica cuando Diego lo autorice.
-- Cuando se corra: SQL Editor de Supabase, como owner, de una sola vez.
--
-- POR QUE ASI (las 4 decisiones que ordenan el resto):
--
--   a) SE GUARDAN DATOS, NO IMAGENES. Una imagen no se resta contra la semana pasada,
--      no se filtra y no se puede regenerar con otro diseno. Los numeros si. La imagen
--      y el PDF pasan a ser una FORMA DE MOSTRAR (se generan al pedirlos) y no se archivan.
--      Peso medido en el plan: ~400 MB/ano por cuenta guardando imagenes vs ~400 KB guardando
--      numeros. Por eso NO hay ninguna columna bytea/url-de-imagen en todo este archivo.
--
--   b) LA ASIGNACION SE CONGELA POR LEAD (pedido explicito de Diego). Si el reporte solo
--      guardara "Miriam: 12 leads" y manana reasignan esos leads, la comparacion contra la
--      corrida anterior MIENTE. Por eso existe reportes_corrida_leads: una fila por lead con
--      QUIEN LO TENIA en ese instante. Ademas es lo unico que permite calcular "cuantos
--      subieron o bajaron de banda" (se comparan dos corridas, no dos fotos).
--
--   c) TODO NACE APAGADO. La feature entera esta gateada por business_settings.reportes_v2
--      (DEFAULT false) y ademas cada informe nace con activo=false. Con el flag apagado el
--      sistema se comporta EXACTAMENTE como hoy, INCLUIDO el reporte diario que ya se manda
--      por WhatsApp (ese sigue leyendo business_settings.reportes_config, que NO se toca).
--
--   d) CERO IA. Esto es SQL y aritmetica. Ningun medidor llama a un modelo. Costo: $0.
--
-- ES ADITIVA E IDEMPOTENTE:
--   * No borra, no renombra y no reescribe NADA existente.
--   * No toca reportes_config, ni el cron enviarReportesProgramados, ni reportes_snapshots,
--     ni el Maestro, ni el reparto, ni la derivacion, ni el prompt de la IA.
--   * Todo es "if not exists" -> se puede correr mas de una vez sin romper nada.
--
-- EL CODIGO TIENE QUE TOLERAR QUE ESTO NO EXISTA (regla dura del proyecto, ya nos comimos
-- un incidente por lo contrario): todo read/write contra estas tablas y contra la columna
-- reportes_v2 va envuelto en try/catch con VALOR POR DEFECTO -> tabla/columna ausente =
-- feature apagada, nunca error en pantalla. El orden deploy-vs-migracion no importa.
--
-- NOMBRES: el PLAN-PIPELINE-Y-REPORTES-v2.md llamaba "reportes_config_informes" a la tabla
-- de informes. Aca se llama `reportes_informes` a secas: "reportes_config" ya es una COLUMNA
-- jsonb de business_settings (el reporte diario viejo) y un nombre que la contenga se lee
-- como si fuera parte de ella. Son cosas distintas y conviene que no se confundan.
-- ============================================================================


-- ============================================================================
-- 0) EL FLAG. Una sola llave para los 3 objetos.
-- ----------------------------------------------------------------------------
-- DEFAULT false = nace apagado en TODAS las cuentas (viejas y nuevas), incluidas las 6 vivas.
-- Lo lee /api/ui-flags con el MISMO patron defensivo que pipeline_filtros_v1: el front arranca
-- en false y solo prende si el endpoint responde true EXPLICITO. Columna ausente, error de red
-- o endpoint caido -> apagado (fail-closed).
--
-- Una sola llave y no dos (una para vistas y otra para reportes) a proposito: las vistas
-- guardadas del Pipeline solo tienen sentido si existe el informe que las consume, y con dos
-- flags hay 4 combinaciones para probar en vez de 2.
--
-- Para prender por cuenta (cuando Diego lo autorice; "Raices Meta Test" queda SIEMPRE afuera):
--   update public.business_settings set reportes_v2 = true where company_name = 'Anton Bienes Raices';
-- ============================================================================
alter table public.business_settings
  add column if not exists reportes_v2 boolean default false;


-- ============================================================================
-- 1) LA VISTA — public.pipeline_vistas
-- ----------------------------------------------------------------------------
-- Un conjunto de filtros CON NOMBRE: "Urgentes sin asesor", "Todo lo de Miriam".
-- Es de la CUENTA, no del navegador: la ve todo el equipo y sobrevive el cambio de
-- dispositivo (por eso vive en la base y no en localStorage). Se edita y se borra.
--
-- `filtros` es jsonb libre A PROPOSITO: es exactamente el estado del panel de filtros del
-- Pipeline (los 12 grupos de pipeline_filtros_v1). Si manana se agrega un grupo de filtros,
-- NO hace falta migrar la base. Forma esperada (todas las claves OPCIONALES; ausente = sin
-- filtrar por eso), documentada aca porque es el contrato entre el front y el backend:
--   {
--     "estados":        ["en_conversacion","interesado","listo_humano","recontacto","cerrado"],
--     "bandas":         ["frio","tibio","caliente","urgente"],
--     "puntaje_de":     0,      "puntaje_a": 100,
--     "asesores":       ["<uuid asesor>", "sin_asignar"],
--     "interes":        ["venta","alquiler_anual","alquiler_temporal","captacion"],
--     "interes_incluir":"ambos",          -- confirmados | inferidos | ambos  (ver nota INTERES abajo)
--     "temperatura":    ["frio","tibio","caliente"],
--     "etiquetas":      ["<id etiqueta>"],
--     "departamentos":  ["<uuid depto>"],
--     "canales":        ["whatsapp","instagram","messenger","web","manual"],
--     "alta":           { "tipo":"rango", "desde":"2026-07-01", "hasta":"2026-07-31" },
--     "sin_tocar_dias": 3,
--     "ia":             "prendida",       -- prendida | apagada
--     "con_cita":       true,
--     "texto":          "busqueda libre"
--   }
--
-- INTERES: NO es un campo de la base (contacts.interest es texto libre). Se resuelve por
-- departamento (dato limpio) Y por texto (agarra a los que no tienen depto), marcando los
-- inferidos. Por eso el filtro tiene "interes_incluir" y la corrida guarda interes_inferido.
-- ============================================================================
create table if not exists public.pipeline_vistas (
  id                uuid primary key default gen_random_uuid(),

  user_id           uuid not null,                    -- TENANT (dueno de la cuenta). Aislamiento.
  nombre            text not null,                    -- "Urgentes sin asesor"
  descripcion       text,                             -- opcional, para que el equipo sepa que mira

  filtros           jsonb not null default '{}'::jsonb,

  -- Orden en el selector de vistas. Se ordena por (orden, nombre) para que el dueno decida
  -- cual aparece primero sin depender de la fecha de creacion.
  orden             integer not null default 0,

  -- true = la ve todo el equipo (default: la vista es de la CUENTA, como pidio Diego).
  -- false = privada del que la creo. Existe para que un asesor pueda armarse una vista de
  -- trabajo sin ensuciar el selector de los demas.
  compartida        boolean not null default true,

  -- BORRADO SUAVE: un informe puede estar apuntando a esta vista. Borrarla de verdad dejaria
  -- informes rotos y corridas viejas sin poder explicar sobre que datos se calcularon.
  -- "Borrar" desde la pantalla = archivada=true (desaparece del selector, el historial sigue
  -- teniendo sentido). El borrado fisico (delete) queda para el mantenimiento manual.
  archivada         boolean not null default false,

  -- Quien la creo. asesor_id = fila en `asesores`; NULL = la creo el DUENO (el dueno no tiene
  -- fila en asesores). El nombre va DENORMALIZADO a proposito: si manana dan de baja al usuario,
  -- la vista tiene que seguir diciendo quien la armo sin cruzar tablas.
  creada_por        uuid,
  creada_por_nombre text,

  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

-- Reconciliacion por si una version anterior de esta tabla ya existe con menos columnas.
alter table public.pipeline_vistas add column if not exists user_id           uuid;
alter table public.pipeline_vistas add column if not exists nombre            text;
alter table public.pipeline_vistas add column if not exists descripcion       text;
alter table public.pipeline_vistas add column if not exists filtros           jsonb default '{}'::jsonb;
alter table public.pipeline_vistas add column if not exists orden             integer default 0;
alter table public.pipeline_vistas add column if not exists compartida        boolean default true;
alter table public.pipeline_vistas add column if not exists archivada         boolean default false;
alter table public.pipeline_vistas add column if not exists creada_por        uuid;
alter table public.pipeline_vistas add column if not exists creada_por_nombre text;
alter table public.pipeline_vistas add column if not exists created_at        timestamptz default now();
alter table public.pipeline_vistas add column if not exists updated_at        timestamptz default now();

-- Selector de vistas de la cuenta (lo unico que se consulta seguido).
create index if not exists idx_pipeline_vistas_user
  on public.pipeline_vistas (user_id, archivada, orden, nombre);

-- Dos vistas activas con el MISMO nombre en la misma cuenta confunden al equipo y hacen
-- ambiguo cualquier informe que las nombre. lower() para que "Urgentes" y "urgentes" choquen.
-- Parcial (archivada=false) para que archivar y volver a crear con el mismo nombre funcione.
create unique index if not exists uq_pipeline_vistas_nombre
  on public.pipeline_vistas (user_id, lower(nombre))
  where archivada = false;

-- ===== RLS =====
-- Patron del proyecto (ia_decisiones / lead_estados_historial / property_consultas /
-- dev_reservas / hotel_reservas): owner-only, y el backend escribe con service key (bypassa RLS).
-- ACA SE AGREGA UNA SOLA COSA: una policy de SOLO LECTURA para el equipo, porque el requisito de
-- Diego es literal — "es de la CUENTA, la ve TODO EL EQUIPO". Sin ella un asesor no veria ninguna
-- vista si el front leyera directo. Las ESCRITURAS siguen siendo owner-only en la base: si Diego
-- quiere que un asesor cree/edite vistas, eso pasa por el backend (service key) con el permiso
-- chequeado en el endpoint, que es donde vive el resto de los permisos del proyecto.
-- FAIL-CLOSED: si la RLS de `asesores` no dejara resolver la subconsulta, la policy no matchea y
-- el asesor simplemente no ve nada (no hay fuga posible hacia otro tenant).
alter table public.pipeline_vistas enable row level security;

drop policy if exists pipeline_vistas_owner on public.pipeline_vistas;
create policy pipeline_vistas_owner on public.pipeline_vistas
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists pipeline_vistas_equipo_lee on public.pipeline_vistas;
create policy pipeline_vistas_equipo_lee on public.pipeline_vistas
  for select using (
    compartida = true
    and user_id in (select a.admin_id from public.asesores a where a.auth_user_id = auth.uid())
  );


-- ============================================================================
-- 2) EL INFORME — public.reportes_informes
-- ----------------------------------------------------------------------------
-- Toma una vista (o "todo") y define QUE se muestra, A QUIEN y CUANDO. Todo opcional.
-- Es CONFIGURACION, no resultado: cambiarla NO cambia las corridas ya guardadas (cada corrida
-- se lleva su propia copia de la config, ver config_snapshot).
--
-- NACE APAGADO dos veces: la cuenta necesita reportes_v2=true Y el informe necesita activo=true.
-- Un informe con activo=false existe, se puede ver y correr a mano, pero el cron lo IGNORA.
-- ============================================================================
create table if not exists public.reportes_informes (
  id                 uuid primary key default gen_random_uuid(),

  user_id            uuid not null,                   -- TENANT
  nombre             text not null,                   -- "Reunion de los lunes", "Mi equipo"
  descripcion        text,

  -- SEGUNDA LLAVE: el cron SOLO mira informes con activo=true. Default false = nada se manda
  -- solo por haber creado el informe. Prenderlo es un acto deliberado del dueno.
  activo             boolean not null default false,

  -- ===== SOBRE QUE DATOS =====
  -- NULL = "todo" (sin vista). on delete set null y no cascade: si borran fisicamente la vista,
  -- el informe NO se borra, pasa a "todo" y queda el nombre historico en vista_nombre.
  vista_id           uuid references public.pipeline_vistas(id) on delete set null,
  vista_nombre       text,                            -- snapshot legible de la vista elegida
  -- Ajuste fino encima de la vista sin tener que duplicarla ("la vista de Miriam, pero solo
  -- urgentes"). Mismo shape que pipeline_vistas.filtros. {} = sin ajuste.
  filtros_extra      jsonb not null default '{}'::jsonb,

  -- ===== QUE MEDIDORES Y EN QUE ORDEN =====
  -- Array ORDENADO (el orden del array ES el orden en el reporte). Cada medidor lleva SU
  -- parametro propio, como pidio Diego. Forma:
  --   [ { "id":"usr_urgentes",  "params": { "puntaje_min": 85 } },
  --     { "id":"usr_sin_tocar", "params": { "dias": 3 } },
  --     { "id":"vol_por_estado","params": {} } ]
  -- El CATALOGO de ids validos y sus params esta al final de este archivo (seccion 5).
  -- [] = informe sin medidores = no muestra nada (valido: sirve para dejarlo a medio armar).
  medidores          jsonb not null default '[]'::jsonb,

  -- ===== COMO SE AGRUPA =====
  -- ninguno | usuario | estado | departamento | interes
  -- Sin CHECK duro (criterio del proyecto: un valor nuevo no puede romper un guardado).
  -- El backend valida contra la lista y cae a 'ninguno' si no reconoce el valor.
  agrupar_por        text not null default 'ninguno',

  -- ===== PERIODO =====
  -- periodo_tipo: dia | semana | mes | rango_fijo | rango_relativo
  --   dia/semana/mes -> ventana cerrada terminada al momento de correr.
  --   rango_fijo     -> usa periodo_desde / periodo_hasta (fechas literales, no se mueven).
  --   rango_relativo -> usa periodo_dias ("ultimos 7 dias").
  periodo_tipo       text not null default 'dia',
  periodo_desde      date,
  periodo_hasta      date,
  periodo_dias       integer,

  -- ===== COMPARAR CONTRA =====
  -- nada | periodo_anterior | mes_pasado (misma fecha del mes pasado)
  comparar_con       text not null default 'nada',

  -- ===== A QUIEN SE MANDA =====
  -- pantalla | dueno | cada_usuario | dueno_y_cada_usuario
  --   pantalla             -> NO se manda nada a nadie (default deliberado: nadie recibe un
  --                           WhatsApp por haber creado un informe).
  --   dueno                -> uno solo, con los numeros de toda la cuenta.
  --   cada_usuario         -> N reportes, uno por asesor, cada uno CON SUS PROPIOS LEADS.
  --   dueno_y_cada_usuario -> las dos cosas.
  destino            text not null default 'pantalla',

  -- Numero del dueno para ESTE informe. NULL = se usa el canal que YA existe y funciona
  -- (business_settings.reportes_config.whatsapp). No se inventa un canal nuevo: se reusa.
  destino_whatsapp   text,

  -- Con destino cada_usuario: los leads SIN ASIGNAR no son de nadie. true = van en el reporte
  -- del dueno (es la deuda del equipo y hoy no aparece en ninguna pantalla). false = no se muestran.
  incluir_sin_asignar boolean not null default true,

  -- ===== FORMATO =====
  -- texto | imagen | pdf.  Default 'texto' PORQUE ES EL UNICO QUE HOY SE PUEDE GENERAR EN EL
  -- SERVIDOR SIN AGREGAR DEPENDENCIAS. imagen/pdf en un envio PROGRAMADO necesitan render del
  -- lado del servidor (no hay navegador a las 8 de la manana): eso esta PROPUESTO, no resuelto,
  -- y lo decide Diego. Mientras no exista, el backend degrada a 'texto' y lo deja anotado en
  -- la corrida. A mano (con el navegador abierto) imagen/pdf ya funcionan con lo que hay.
  formato            text not null default 'texto',

  -- ===== CUANDO =====
  -- manual | diario | semanal | mensual.  Default 'manual' = solo cuando un humano toca el boton.
  frecuencia         text not null default 'manual',
  -- Hora de envio 0-23. El cron actual compara SOLO la hora (granularidad de 1 hora) y usa un
  -- offset fijo de Argentina; se mantiene el MISMO criterio para no inventar un reloj paralelo.
  hora               smallint not null default 9,
  dia_semana         smallint,                        -- 0=domingo .. 6=sabado (solo frecuencia semanal)
  -- 1-28 unicamente: el backend clampea. Un informe "el 31" se saltearia febrero entero.
  dia_mes            smallint,
  -- Hoy TODOS los tenants son de Argentina y el cron usa -3 fijo. La columna existe para poder
  -- cambiarlo por cuenta sin migrar de nuevo. NULL/ausente -> el backend usa -3 (comportamiento actual).
  tz_offset_horas    smallint default -3,

  -- ===== HISTORIAL =====
  -- false = se genera, se manda y no queda nada guardado.
  guarda_historial   boolean not null default true,
  -- Valvula de escape de volumen: false = se guarda la corrida (los totales) pero NO el detalle
  -- lead por lead. OJO: sin el detalle se pierde la asignacion congelada, y por lo tanto se
  -- pierde "cuantos subieron/bajaron de banda" y la comparacion deja de ser confiable si
  -- alguien reasigna. Default true = como lo pidio Diego.
  guarda_detalle_leads boolean not null default true,
  -- RESERVADO, HOY INERTE: dias de retencion para una purga automatica futura. NULL = sin purga.
  -- El borrado por rango de fechas de hoy es MANUAL (ver seccion 4).
  retencion_dias     integer,

  -- ===== CONTROL DE ENVIO (dedupe del cron) =====
  -- Mismo criterio que reportes_config.ultimo_envio: fecha LOCAL del tenant del ultimo envio
  -- automatico. El cron no vuelve a mandar si ya mando hoy. NULL = nunca se mando.
  ultimo_envio_fecha date,
  ultima_corrida_at  timestamptz,

  creado_por         uuid,                            -- fila en `asesores`; NULL = el dueno
  creado_por_nombre  text,
  archivado          boolean not null default false,  -- borrado suave (las corridas lo referencian)

  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

-- Reconciliacion por si una version anterior ya existe con menos columnas.
alter table public.reportes_informes add column if not exists user_id             uuid;
alter table public.reportes_informes add column if not exists nombre              text;
alter table public.reportes_informes add column if not exists descripcion         text;
alter table public.reportes_informes add column if not exists activo              boolean default false;
alter table public.reportes_informes add column if not exists vista_id            uuid;
alter table public.reportes_informes add column if not exists vista_nombre        text;
alter table public.reportes_informes add column if not exists filtros_extra       jsonb default '{}'::jsonb;
alter table public.reportes_informes add column if not exists medidores           jsonb default '[]'::jsonb;
alter table public.reportes_informes add column if not exists agrupar_por         text default 'ninguno';
alter table public.reportes_informes add column if not exists periodo_tipo        text default 'dia';
alter table public.reportes_informes add column if not exists periodo_desde       date;
alter table public.reportes_informes add column if not exists periodo_hasta       date;
alter table public.reportes_informes add column if not exists periodo_dias        integer;
alter table public.reportes_informes add column if not exists comparar_con        text default 'nada';
alter table public.reportes_informes add column if not exists destino             text default 'pantalla';
alter table public.reportes_informes add column if not exists destino_whatsapp    text;
alter table public.reportes_informes add column if not exists incluir_sin_asignar boolean default true;
alter table public.reportes_informes add column if not exists formato             text default 'texto';
alter table public.reportes_informes add column if not exists frecuencia          text default 'manual';
alter table public.reportes_informes add column if not exists hora                smallint default 9;
alter table public.reportes_informes add column if not exists dia_semana          smallint;
alter table public.reportes_informes add column if not exists dia_mes             smallint;
alter table public.reportes_informes add column if not exists tz_offset_horas     smallint default -3;
alter table public.reportes_informes add column if not exists guarda_historial    boolean default true;
alter table public.reportes_informes add column if not exists guarda_detalle_leads boolean default true;
alter table public.reportes_informes add column if not exists retencion_dias      integer;
alter table public.reportes_informes add column if not exists ultimo_envio_fecha  date;
alter table public.reportes_informes add column if not exists ultima_corrida_at   timestamptz;
alter table public.reportes_informes add column if not exists creado_por          uuid;
alter table public.reportes_informes add column if not exists creado_por_nombre   text;
alter table public.reportes_informes add column if not exists archivado           boolean default false;
alter table public.reportes_informes add column if not exists created_at          timestamptz default now();
alter table public.reportes_informes add column if not exists updated_at          timestamptz default now();

-- Listado de informes de la cuenta.
create index if not exists idx_reportes_informes_user
  on public.reportes_informes (user_id, archivado, nombre);

-- LA QUERY DEL CRON: "que informes activos toca mandar a esta hora". Parcial para que el barrido
-- horario no escanee informes apagados ni archivados (que son la mayoria).
create index if not exists idx_reportes_informes_cron
  on public.reportes_informes (frecuencia, hora)
  where activo = true and archivado = false and frecuencia <> 'manual';

-- Un informe activo por nombre y por cuenta (mismo motivo que en las vistas).
create unique index if not exists uq_reportes_informes_nombre
  on public.reportes_informes (user_id, lower(nombre))
  where archivado = false;

-- RLS owner-only: Reportes es una pantalla del DUENO. Los asesores NO leen informes ajenos
-- desde el front; lo que a un asesor le corresponde ver se lo sirve el backend ya recortado.
alter table public.reportes_informes enable row level security;
drop policy if exists reportes_informes_owner on public.reportes_informes;
create policy reportes_informes_owner on public.reportes_informes
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);


-- ============================================================================
-- 3) LA CORRIDA — public.reportes_corridas
-- ----------------------------------------------------------------------------
-- Los numeros de UNA generacion, CONGELADOS, con su fecha. Se busca por fecha y por usuario;
-- se borra por rango de fechas.
--
-- UNA FILA POR DESTINATARIO: con destino 'cada_usuario' un mismo disparo genera 1 corrida
-- 'cuenta' (la global, la del dueno) + N corridas 'usuario' (una por asesor, con SUS leads).
-- Todas comparten lote_id, asi que "lo que se genero el lunes a las 8" es una sola busqueda,
-- y a la vez cada asesor puede pedir SOLO lo suyo sin recalcular nada.
--
-- NO HAY IMAGENES ACA. A proposito. Ver decision (a) del encabezado.
-- ============================================================================
create table if not exists public.reportes_corridas (
  id                uuid primary key default gen_random_uuid(),

  user_id           uuid not null,                    -- TENANT
  -- on delete set null: borrar el informe NO puede borrar el historial ya generado.
  informe_id        uuid references public.reportes_informes(id) on delete set null,
  informe_nombre    text,                             -- snapshot: el historial se lee aunque el informe ya no exista

  -- Agrupa todas las filas nacidas del MISMO disparo (la global + la de cada usuario).
  lote_id           uuid,

  -- ===== DE QUIEN ES ESTA FILA =====
  -- 'cuenta'  -> los numeros de toda la cuenta (la del dueno).
  -- 'usuario' -> la rebanada de UN asesor (solo sus leads). asesor_id dice de quien.
  alcance           text not null default 'cuenta',
  asesor_id         uuid,                             -- fila en `asesores`. NULL cuando alcance='cuenta'
  asesor_nombre     text,                             -- snapshot legible (sobrevive la baja del usuario)

  -- ===== CUANDO =====
  generada_at       timestamptz not null default now(),
  periodo_desde     timestamptz,                      -- ventana calculada AL CORRER (ya resuelta, no relativa)
  periodo_hasta     timestamptz,
  periodo_tipo      text,                             -- copia del informe, para leer el historial sin cruzar

  -- ===== LOS NUMEROS (esto es el reporte) =====
  -- Un objeto por medidor, con la clave = id del medidor del catalogo (seccion 5):
  --   { "vol_total":       { "valor": 152 },
  --     "vol_por_estado":  { "en_conversacion": 90, "interesado": 41, "cerrado": 21 },
  --     "usr_urgentes":    { "params": { "puntaje_min": 85 },
  --                          "grupos": { "<uuid asesor>": 3, "sin_asignar": 6 } } }
  -- jsonb y no columnas: el catalogo de medidores va a crecer y cada medidor nuevo no puede
  -- costar una migracion ni romper la lectura de las corridas viejas.
  datos             jsonb not null default '{}'::jsonb,

  -- Copia de la config del informe CON LA QUE SE GENERO (medidores, params, agrupacion,
  -- filtros, vista). Sin esto, si manana cambian el informe, no hay forma de saber que
  -- significaba un numero viejo ni de regenerarlo en otro formato.
  config_snapshot   jsonb,

  -- Numeros del periodo comparado (mismo shape que `datos`) + de donde salieron. NULL = el
  -- informe no compara, o no habia con que comparar (primera corrida).
  comparacion       jsonb,

  -- ===== ENVIO =====
  origen            text not null default 'manual',   -- manual | cron  (quien disparo)
  formato           text,                             -- formato REALMENTE usado (puede degradar a 'texto')
  enviado           boolean not null default false,
  enviado_at        timestamptz,
  -- Detalle del envio, para poder auditar sin adivinar:
  --   [ { "destino":"dueno", "telefono":"549...", "formato":"texto", "ok":true, "error":null } ]
  enviado_a         jsonb not null default '[]'::jsonb,
  -- Que salio mal (calculo o envio). NULL = todo bien. La corrida se guarda IGUAL aunque el
  -- envio falle: los numeros ya se calcularon y sirven.
  error             text,

  -- Cuantos leads entraron en el calculo. Redundante con reportes_corrida_leads a proposito:
  -- permite mostrar el historial sin tocar la tabla grande.
  total_leads       integer,

  created_at        timestamptz not null default now()
);

-- Reconciliacion.
alter table public.reportes_corridas add column if not exists user_id         uuid;
alter table public.reportes_corridas add column if not exists informe_id      uuid;
alter table public.reportes_corridas add column if not exists informe_nombre  text;
alter table public.reportes_corridas add column if not exists lote_id         uuid;
alter table public.reportes_corridas add column if not exists alcance         text default 'cuenta';
alter table public.reportes_corridas add column if not exists asesor_id       uuid;
alter table public.reportes_corridas add column if not exists asesor_nombre   text;
alter table public.reportes_corridas add column if not exists generada_at     timestamptz default now();
alter table public.reportes_corridas add column if not exists periodo_desde   timestamptz;
alter table public.reportes_corridas add column if not exists periodo_hasta   timestamptz;
alter table public.reportes_corridas add column if not exists periodo_tipo    text;
alter table public.reportes_corridas add column if not exists datos           jsonb default '{}'::jsonb;
alter table public.reportes_corridas add column if not exists config_snapshot jsonb;
alter table public.reportes_corridas add column if not exists comparacion     jsonb;
alter table public.reportes_corridas add column if not exists origen          text default 'manual';
alter table public.reportes_corridas add column if not exists formato         text;
alter table public.reportes_corridas add column if not exists enviado         boolean default false;
alter table public.reportes_corridas add column if not exists enviado_at      timestamptz;
alter table public.reportes_corridas add column if not exists enviado_a       jsonb default '[]'::jsonb;
alter table public.reportes_corridas add column if not exists error           text;
alter table public.reportes_corridas add column if not exists total_leads     integer;
alter table public.reportes_corridas add column if not exists created_at      timestamptz default now();

-- "El historial de la cuenta, lo mas nuevo primero" + busqueda POR FECHA (rango sobre generada_at).
create index if not exists idx_reportes_corridas_user_fecha
  on public.reportes_corridas (user_id, generada_at desc);
-- Busqueda POR USUARIO ("mostrame las corridas de Miriam").
create index if not exists idx_reportes_corridas_asesor
  on public.reportes_corridas (user_id, asesor_id, generada_at desc);
-- Comparacion contra la corrida anterior DEL MISMO INFORME (es la query de "periodo anterior").
create index if not exists idx_reportes_corridas_informe
  on public.reportes_corridas (informe_id, alcance, generada_at desc);
-- Traer todas las filas de un mismo disparo.
create index if not exists idx_reportes_corridas_lote
  on public.reportes_corridas (lote_id);

alter table public.reportes_corridas enable row level security;
drop policy if exists reportes_corridas_owner on public.reportes_corridas;
create policy reportes_corridas_owner on public.reportes_corridas
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);


-- ============================================================================
-- 3.b) LA ASIGNACION CONGELADA — public.reportes_corrida_leads
-- ----------------------------------------------------------------------------
-- ESTE ES EL PUNTO DE DIEGO. Una fila por lead que entro en la corrida, con QUIEN LO TENIA
-- ASIGNADO EN ESE MOMENTO. Sin esto la comparacion MIENTE apenas alguien reasigna: los 12 leads
-- que la semana pasada eran de Miriam hoy figuran como de Rodrigo y el "vs. semana anterior"
-- da cualquier cosa.
--
-- Ademas es lo unico que habilita "cuantos SUBIERON o BAJARON de banda": se compara la banda
-- de cada lead entre dos corridas. Con totales agregados eso es imposible.
--
-- NO tiene foreign key a conversations A PROPOSITO: es una FOTO. Si manana borran el lead, la
-- foto del mes pasado tiene que seguir contando lo mismo. Un cascade la reescribiria hacia atras.
-- Si tiene cascade contra la corrida: borrar una corrida borra su detalle (es su detalle).
--
-- VOLUMEN: ~1 fila por lead por corrida (~120 bytes). Cuenta de 1.000 leads con un informe
-- semanal = ~52.000 filas/ano (~6 MB). Aceptable, y se puede apagar por informe con
-- guarda_detalle_leads=false, o purgar por rango de fechas (seccion 4).
-- ============================================================================
create table if not exists public.reportes_corrida_leads (
  id                bigint generated always as identity primary key,

  corrida_id        uuid not null references public.reportes_corridas(id) on delete cascade,
  user_id           uuid not null,                    -- TENANT denormalizado (RLS + indices sin join)

  conversation_id   uuid,                             -- SIN FK: la foto no se reescribe (ver arriba)

  -- ===== LO QUE HAY QUE CONGELAR =====
  asesor_id         uuid,                             -- QUIEN LO TENIA. NULL = SIN ASIGNAR (dato clave)
  asesor_nombre     text,                             -- snapshot legible
  departamento_id   uuid,
  departamento_nombre text,

  estado            text,                             -- en_conversacion | interesado | listo_humano | recontacto | cerrado
  puntaje           smallint,                         -- 0-100 del motor de puntaje por reglas (0 IA)
  banda             text,                             -- frio | tibio | caliente | urgente
  temperatura       text,
  canal             text,
  interes           text,                             -- venta | alquiler_anual | alquiler_temporal | captacion
  -- true = el interes NO estaba confirmado (se dedujo del texto libre de contacts.interest, no
  -- del departamento). Se guarda para poder mostrarlo distinto y para no mezclar dato con adivinanza.
  interes_inferido  boolean not null default false,

  dias_sin_tocar    smallint,                         -- dias desde el ultimo mensaje DEL NEGOCIO (asesor o IA)
  creado_en_periodo boolean not null default false,   -- el lead nacio dentro de la ventana del reporte

  created_at        timestamptz not null default now()
);

-- Reconciliacion.
alter table public.reportes_corrida_leads add column if not exists corrida_id          uuid;
alter table public.reportes_corrida_leads add column if not exists user_id             uuid;
alter table public.reportes_corrida_leads add column if not exists conversation_id     uuid;
alter table public.reportes_corrida_leads add column if not exists asesor_id           uuid;
alter table public.reportes_corrida_leads add column if not exists asesor_nombre       text;
alter table public.reportes_corrida_leads add column if not exists departamento_id     uuid;
alter table public.reportes_corrida_leads add column if not exists departamento_nombre text;
alter table public.reportes_corrida_leads add column if not exists estado              text;
alter table public.reportes_corrida_leads add column if not exists puntaje             smallint;
alter table public.reportes_corrida_leads add column if not exists banda               text;
alter table public.reportes_corrida_leads add column if not exists temperatura         text;
alter table public.reportes_corrida_leads add column if not exists canal               text;
alter table public.reportes_corrida_leads add column if not exists interes             text;
alter table public.reportes_corrida_leads add column if not exists interes_inferido    boolean default false;
alter table public.reportes_corrida_leads add column if not exists dias_sin_tocar      smallint;
alter table public.reportes_corrida_leads add column if not exists creado_en_periodo   boolean default false;
alter table public.reportes_corrida_leads add column if not exists created_at          timestamptz default now();

-- Leer el detalle de una corrida (y agrupar por asesor dentro de ella).
create index if not exists idx_rep_corrida_leads_corrida
  on public.reportes_corrida_leads (corrida_id, asesor_id);
-- "Todo lo de Miriam a lo largo del tiempo" (busqueda por usuario, requisito de Diego).
create index if not exists idx_rep_corrida_leads_user_asesor
  on public.reportes_corrida_leads (user_id, asesor_id);
-- Seguir UN lead entre corridas (es como se calculan los cambios de banda).
create index if not exists idx_rep_corrida_leads_conv
  on public.reportes_corrida_leads (conversation_id, corrida_id);

-- Un lead no puede estar dos veces en la MISMA corrida: si un reintento vuelve a insertar,
-- que falle el duplicado y no que se dupliquen los conteos del historial.
create unique index if not exists uq_rep_corrida_leads
  on public.reportes_corrida_leads (corrida_id, conversation_id);

alter table public.reportes_corrida_leads enable row level security;
drop policy if exists reportes_corrida_leads_owner on public.reportes_corrida_leads;
create policy reportes_corrida_leads_owner on public.reportes_corrida_leads
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);


-- ============================================================================
-- 3.c) OPT-OUT POR USUARIO (columna en una tabla que YA existe)
-- ----------------------------------------------------------------------------
-- Con destino 'cada_usuario' el sistema le manda a cada asesor SU reporte al numero que YA
-- esta cargado (asesores.whatsapp_notif). No se agrega un numero nuevo: se reusa el que hay.
-- Esta columna es el unico agregado: permite sacar a una persona del reparto sin apagar el
-- informe entero. DEFAULT true = si el dueno eligio "a cada uno lo suyo", les llega a todos.
-- DEFENSIVO: el backend trata columna ausente / NULL como true (= comportamiento esperado).
-- ============================================================================
alter table public.asesores
  add column if not exists recibe_reportes boolean default true;


-- ============================================================================
-- 4) MANTENIMIENTO — BORRAR HISTORIAL POR RANGO DE FECHAS
-- ----------------------------------------------------------------------------
-- Requisito de Diego: "se borra por rango de fechas". No hay purga automatica (retencion_dias
-- esta reservada pero hoy nadie la usa): el dueno decide cuanto historial conserva.
-- El detalle lead-por-lead se va SOLO por el cascade de corrida_id.
--
--   delete from public.reportes_corridas
--    where user_id = '<uuid del dueno>'
--      and generada_at >= '2026-01-01' and generada_at < '2026-02-01';
--
-- Borrar solo el detalle pesado y conservar los totales (opcion intermedia):
--   delete from public.reportes_corrida_leads
--    where user_id = '<uuid del dueno>'
--      and corrida_id in (select id from public.reportes_corridas
--                          where user_id = '<uuid del dueno>' and generada_at < now() - interval '180 days');
-- ============================================================================


-- ============================================================================
-- 5) CATALOGO DE MEDIDORES — el contrato de ids entre base, backend y front
-- ----------------------------------------------------------------------------
-- Estos ids son los que van en reportes_informes.medidores[].id y son las claves de
-- reportes_corridas.datos. Se documentan ACA para que backend y front no inventen dos nombres
-- distintos para la misma cosa. Cada uno con SU parametro configurable.
--
-- VOLUMEN
--   vol_total                 params: {}                          -- total de leads
--   vol_por_estado            params: { estados: [] }             -- [] = todos los estados
--   vol_nuevos                params: {}                          -- creados dentro del periodo
--   vol_por_canal             params: {}                          -- canal de entrada
--   vol_sin_asignar           params: {}                          -- asesor_id is null
--
-- POR USUARIO  (se agrupan por asesor_id; la clave "sin_asignar" es un grupo mas)
--   usr_leads                 params: {}
--   usr_urgentes              params: { puntaje_min: 85 }         -- "urgente" es CONFIGURABLE
--   usr_sin_tocar             params: { dias: 3 }                 -- "sin tocar" es CONFIGURABLE
--   usr_derivados_recibidos   params: {}                          -- OJO: ver limitacion (b) abajo
--   usr_cerrados              params: {}                          -- OJO: ver limitacion (c) abajo
--
-- CALIDAD
--   cal_primera_respuesta     params: { metrica: 'promedio' }     -- promedio | mediana
--   cal_msgs_por_lead         params: {}
--   cal_ia_derivo_vs_resolvio params: {}                          -- de ia_decisiones.derivo
--
-- RESULTADO
--   res_motivos_perdida       params: {}                          -- conversations.motivo_perdida
--   res_propiedades           params: { top: 5 }                  -- property_consultas
--   res_citas                 params: { estados: ['agendada','cumplida'] }
--   res_absorcion             params: {}                          -- SOLO rubro desarrolladora
--
-- PUNTAJE
--   pts_distribucion_banda    params: { cortes: { tibio: 40, caliente: 65, urgente: 85 } }
--   pts_promedio              params: {}
--   pts_cambios_banda         params: {}                          -- OJO: ver limitacion (d) abajo
--
-- ----------------------------------------------------------------------------
-- LO QUE **NO** ENTRA (y por que). No se inventa un numero que la base no tiene:
--
--   (a) "PROMESAS SIN CUMPLIR" — QUEDA FUERA DEL CATALOGO. No existe ningun campo que marque
--       una promesa incumplida. ia_decisiones guarda que tools uso la IA y si derivo, pero
--       "te confirmo manana" y no lo hizo es TEXTO. Detectarlo de verdad exige leer el mensaje
--       con un modelo = gasto de IA, que esta prohibido en reportes. Hay un proxy posible por
--       REGLAS y sin IA (turno con tools vacio + sin derivar + el lead no volvio a escribir),
--       pero es una aproximacion y hay que decidirla antes de mostrarla como un numero.
--       DECISION DE DIEGO PENDIENTE. Por eso no hay id reservado para esto.
--
--   (b) usr_derivados_recibidos ES PARCIAL HACIA ATRAS. No hay historial estructurado de pases
--       de asesor: conversations.derivado_at guarda SOLO la ultima derivacion y los pases viven
--       como mensajes de sistema (texto con 🔁). Se puede aproximar con lead_estados_historial
--       (cambios a listo_humano), pero eso dice "se derivo", no "a quien le llego". A partir de
--       este modelo el dato queda BIEN: la diferencia de asesor_id de un lead entre dos corridas
--       ES el pase. O sea: hacia adelante es exacto, hacia atras es aproximado.
--
--   (c) usr_cerrados DEPENDE de lead_estados_historial. conversations.status dice que esta
--       cerrado, no CUANDO se cerro. La fecha sale del historial de estados, que es una tabla
--       nueva: los cierres anteriores a que esa migracion corriera NO estan. Si la tabla no
--       existe, el medidor devuelve null (no cero: cero seria mentir).
--
--   (d) pts_cambios_banda NECESITA DOS CORRIDAS con detalle de leads. La primera vez devuelve
--       null. Es esperable y hay que mostrarlo como "sin comparacion", no como 0.
--
--   (e) cal_primera_respuesta / res_motivos_perdida / res_propiedades dependen de
--       migracion-reportes-e3.sql (primera_respuesta_ms, motivo_perdida, property_consultas).
--       Si esa migracion no corrio, esos medidores devuelven null y el resto del reporte sale igual.
--
--   (f) EL PUNTAJE SE CALCULA HOY EN EL NAVEGADOR (motor por reglas del Pipeline, 0 IA). Un
--       informe PROGRAMADO corre en el servidor, donde no hay navegador: el backend tiene que
--       replicar ese mismo motor. Si las dos implementaciones se desincronizan, la pantalla y
--       el WhatsApp van a mostrar puntajes distintos. Es un riesgo de codigo, no de datos.
-- ============================================================================


-- ============================================================================
-- 6) VERIFICACION (correr DESPUES, para confirmar que quedo todo bien)
-- ----------------------------------------------------------------------------
-- select table_name from information_schema.tables
--  where table_schema='public'
--    and table_name in ('pipeline_vistas','reportes_informes','reportes_corridas','reportes_corrida_leads');
--
-- select relname, relrowsecurity as rls_activa from pg_class
--  where relname in ('pipeline_vistas','reportes_informes','reportes_corridas','reportes_corrida_leads');
--
-- select company_name, reportes_v2 from public.business_settings order by company_name;
--   -> TIENE QUE DAR false EN TODAS. Si alguna sale true, algo prendio solo: apagarla.
-- ============================================================================


-- ============================================================================
-- OBLIGATORIO Y AL FINAL: sin esto PostgREST no ve las tablas ni las columnas nuevas y todos
-- los inserts/updates fallan EN SILENCIO con PGRST204 (gotcha conocido del proyecto).
-- ============================================================================
notify pgrst, 'reload schema';
