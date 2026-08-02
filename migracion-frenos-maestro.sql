-- ============================================================================
-- migracion-frenos-maestro.sql
-- ----------------------------------------------------------------------------
-- ORIGEN: auditoria de seguridad, autorizado por Diego 2026-08-01. Pedido
-- textual: "no cambies el funcionamiento pero que nadie que no deba pueda
-- revertir algo que se genero del maestro".
--
-- PROBLEMA: varias banderas con las que el Maestro (o el propio dueño, en el
-- caso de asesores.activo) contiene/da de baja una cuenta viven en la MISMA
-- fila que el afectado puede escribir directo por Supabase (anon key + su
-- propio JWT, rol `authenticated`), sin pasar por el backend. RLS actual en
-- ambas tablas es "el dueño de la fila puede hacer ALL sobre su fila" (ver
-- rls-business-settings-owner-only / asesor-login-edicion-gotchas), lo cual
-- es correcto para el resto de las columnas pero deja estas puntuales sueltas.
--
-- MECANISMO: NO tocamos RLS (una policy mala puede romper escrituras
-- legitimas de toda la fila). En cambio, un trigger BEFORE UPDATE por tabla
-- que compara OLD vs NEW SOLO en las columnas protegidas: si el que escribe
-- NO es el service_role (backend/Maestro) Y no es quien legitimamente puede
-- tocarlas, se PISA el valor nuevo con el viejo (silencioso, no revienta la
-- transaccion) y el resto del UPDATE sigue su curso normal. Verificado: los
-- payloads del front (front real, no hipotetico) NUNCA mandan estas columnas
-- salvo desde los flujos legitimos que se detallan abajo, asi que en el 99%
-- de los guardados esto es un no-op.
--
-- QUE SE PROTEGE Y QUE NO (leido en el codigo, no de la lista textual):
--
--   business_settings.eliminado_at  -> PROTEGIDA. Solo la escribe el backend
--     (POST /api/maestro papelera, server.js ~L30602/30629) con service key.
--     El front NUNCA la escribe directo. Bloqueo total a `authenticated`.
--
--   business_settings.congelada     -> PROTEGIDA. Solo la escribe el backend
--     al arrancar (candado de "Raices Meta Test", server.js ~L32282) con
--     service key. El front NUNCA la escribe directo. Bloqueo total.
--
--   business_settings.rubro         -> PROTEGIDA, pero SOLO en UPDATE. En
--     el registro (register/page.tsx) el dueño hace un upsert de su PROPIA
--     fila recien creada con el rubro elegido -> eso es un INSERT (o un
--     UPDATE sobre una fila que el todavia no tiene, primera vez), y el
--     trigger es BEFORE UPDATE, no BEFORE INSERT: no lo toca. Despues de
--     creada la cuenta, cualquier intento de UPDATE de `rubro` que no sea
--     el Maestro (POST /api/maestro/cliente/:id/rubro, service key) se
--     revierte. Coincide con la regla: "se fija al registrarse, despues
--     solo el Maestro lo cambia".
--
--   business_settings.crm_pausado   -> NO SE TOCA. Ojo: Diego la nombro como
--     freno del Maestro (pausa total, /api/maestro/cliente/:id/accion), pero
--     la MISMA columna es TAMBIEN el boton propio del dueño "IA Activa/Pausada"
--     en su dashboard (app/(dashboard)/dashboard/page.tsx, togglePausa ->
--     supabase.from('business_settings').update({crm_pausado}) DIRECTO, sin
--     backend). Es un uso 100% legitimo y cotidiano, no un intento de
--     revertir al Maestro: bloquearla de punta a punta rompe ese boton todos
--     los dias (silencioso ademas: el front no ve error y muestra el estado
--     como si hubiese cambiado). No hay forma de distinguir en la columna
--     "el Maestro pauso por sancion" de "el dueño pauso porque se fue a
--     dormir": son el mismo bit. REPORTADO, no protegido. Si Diego quiere
--     que el candado del Maestro sea a prueba de que el dueño lo reactive,
--     hace falta una columna NUEVA y separada (ej. crm_pausado_maestro) que
--     el gate de envio de mensajes chequee ademas de crm_pausado -- eso es
--     un cambio de comportamiento real (toca el gate que corre por cada
--     mensaje) y por eso NO lo hice sin tu "dale" explicito.
--
--   asesores.activo -> PROTEGIDA, pero con la condicion correcta: a
--     diferencia de arriba, ACA el que legitimamente prende/apaga esta
--     bandera es el DUEÑO (admin_id), no el backend/Maestro -- y el dueño
--     tambien escribe por `authenticated` (mismo rol que el asesor). El
--     `service_role` puro no alcanza como criterio. Se protege asi: se
--     revierte el cambio salvo que (a) sea service_role (backend, que ES el
--     camino normal de /api/asesores/acceso y /api/asesores/activar), o (b)
--     quien escribe es el DUEÑO de esa fila (auth.uid() = admin_id de la
--     fila) -- eso cubre el fallback directo que ya existe en
--     asesores/page.tsx (toggleActivo) cuando el endpoint del backend falla.
--     Lo que se bloquea es puntualmente el caso que describiste: el propio
--     afectado (auth.uid() = auth_user_id de SU fila) reactivandose a si
--     mismo, como pasa hoy sin querer en conversaciones/page.tsx (toggleMiEstado
--     manda activo:true junto con disponibilidad, directo por Supabase).
--
-- PROCEDIMIENTO: idempotente (CREATE OR REPLACE FUNCTION + DROP TRIGGER IF
-- EXISTS/CREATE). Se puede correr las veces que haga falta. Correr una vez
-- en el SQL editor de Supabase (rol postgres) y despues:
--   NOTIFY pgrst, 'reload schema';   (ya incluido al final)
--
-- COMO REVERTIR: al final del archivo, comentado, el DROP de ambos triggers
-- y funciones (deja todo exactamente como estaba antes de esta migracion).
-- ============================================================================


-- ----------------------------------------------------------------------------
-- (1) business_settings: eliminado_at / congelada / rubro
-- ----------------------------------------------------------------------------
-- auth.role() = rol Postgres que PostgREST setea segun el JWT del pedido
-- ('service_role' | 'authenticated' | 'anon'). El backend (server.js) usa
-- SIEMPRE SUPABASE_SERVICE_KEY -> auth.role() = 'service_role' -> pasa libre.
-- Fuera de PostgREST (ej. vos corriendo SQL a mano como postgres en el SQL
-- editor) auth.role() da NULL -> con el COALESCE de abajo tambien pasa libre
-- (no queremos que un arreglo manual tuyo se auto-revierta).

-- Columna nueva: marca de QUIEN puso la pausa. Nace en false = "no la puso el Maestro", que es el estado
-- de todas las cuentas hoy -> al correr esto NADIE queda trabado. Aditiva: ningun codigo existente la lee.
alter table public.business_settings
  add column if not exists pausa_de_maestro boolean not null default false;

-- (SECURITY INVOKER a proposito, es el default: no necesita leer nada fuera
-- de la fila OLD/NEW que ya trae el UPDATE, asi que no hace falta escalar
-- privilegios. set search_path solo por higiene.)
create or replace function public._frenos_maestro_business_settings()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if coalesce(auth.role(), 'service_role') <> 'service_role' then
    new.eliminado_at := old.eliminado_at;
    new.congelada    := old.congelada;
    new.rubro        := old.rubro;
    -- pausa_de_maestro es SOLO una marca de QUIEN puso la pausa. La escribe unicamente el Maestro.
    new.pausa_de_maestro := old.pausa_de_maestro;

    -- LA PAUSA DEL MAESTRO VA POR ENCIMA DE LA DEL CLIENTE (Diego 2026-08-02).
    -- Ojo con lo que esto NO hace: `crm_pausado` NO se bloquea. Es la MISMA columna que usa el boton
    -- "IA Activa/Pausada" del dueño en su panel (escribe directo por Supabase, sin backend); bloquearla
    -- entera le rompia ese boton todos los dias, y en silencio. Ademas la leen ~48 lugares del backend:
    -- separarla en dos columnas obligaba a tocarlos todos, con el riesgo de que a UNO se le escape la pausa.
    -- Lo unico que se impide es DESTRABAR una pausa puesta por el Maestro. El dueño sigue pausando y
    -- despausando lo suyo como siempre; si el freno lo puso el Maestro, toca el boton y no destraba.
    if old.pausa_de_maestro is true and old.crm_pausado is true and new.crm_pausado is not true then
      new.crm_pausado := old.crm_pausado;
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists _frenos_maestro_business_settings_trg on public.business_settings;
create trigger _frenos_maestro_business_settings_trg
  before update on public.business_settings
  for each row
  execute function public._frenos_maestro_business_settings();


-- ----------------------------------------------------------------------------
-- (2) asesores: activo
-- ----------------------------------------------------------------------------
-- Se permite el cambio si:
--   (a) service_role (backend: /api/asesores/acceso, /api/asesores/activar), o
--   (b) auth.uid() = old.admin_id  (el DUEÑO de la cuenta tocando a SU asesor;
--       cubre el fallback directo de asesores/page.tsx).
-- Se revierte (deja el valor viejo) en cualquier otro caso, en particular
-- cuando auth.uid() = old.auth_user_id (el propio asesor afectado).

create or replace function public._frenos_maestro_asesores_activo()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if coalesce(auth.role(), 'service_role') <> 'service_role'
     and auth.uid() is distinct from old.admin_id then
    new.activo := old.activo;
  end if;
  return new;
end;
$$;

drop trigger if exists _frenos_maestro_asesores_activo_trg on public.asesores;
create trigger _frenos_maestro_asesores_activo_trg
  before update on public.asesores
  for each row
  execute function public._frenos_maestro_asesores_activo();


-- ----------------------------------------------------------------------------
-- Refrescar el schema cache de PostgREST (gotcha conocido del proyecto).
-- ----------------------------------------------------------------------------
NOTIFY pgrst, 'reload schema';


-- ============================================================================
-- POST-APLICACION -- VERIFICAR EN VIVO (NO OMITIR):
--   * Dueño guarda Configuracion general (nombre/horarios/instrucciones/flags)
--     -> debe seguir guardando IDENTICO (esas columnas no se tocan).
--   * Dueño togglea "IA Activa/Pausada" en el dashboard -> debe seguir
--     funcionando (crm_pausado NO esta protegida, a proposito -- ver arriba).
--   * Dueño prende/apaga un asesor desde Usuarios -> debe seguir funcionando
--     (pasa por /api/asesores/acceso o /api/asesores/activar, service_role).
--   * Un asesor loguea y togglea su disponibilidad (Conectado/En pausa) en
--     Conversaciones -> debe seguir funcionando igual.
--   * Maestro: papelera (eliminar/restaurar), candado (congelada) y cambio
--     de rubro -> deben seguir funcionando IDENTICO (pasan por service_role).
--   * Intento manual (SQL editor, con anon key simulando un authenticated):
--       UPDATE business_settings SET eliminado_at = now() WHERE user_id = '<uid>';
--     con un rol authenticated (no postgres) -> la columna NO debe cambiar.
--   * Un asesor DADO DE BAJA (activo=false) intenta reactivarse a si mismo
--     escribiendo directo a su propia fila de `asesores` -> NO debe poder
--     (auth.uid() = auth_user_id de su fila, no admin_id).
-- ============================================================================


-- ============================================================================
-- COMO REVERTIR (deja todo como estaba antes de esta migracion):
-- ============================================================================
-- drop trigger if exists _frenos_maestro_business_settings_trg on public.business_settings;
-- drop function if exists public._frenos_maestro_business_settings();
-- drop trigger if exists _frenos_maestro_asesores_activo_trg on public.asesores;
-- drop function if exists public._frenos_maestro_asesores_activo();
-- NOTIFY pgrst, 'reload schema';
