-- ============================================================================
-- EXCLUSIVIDAD DE CUENTAS META ENTRE INQUILINOS (incidente 2026-07-17)
-- Un DM de Instagram a @raicescrm (cuenta del tenant de PRUEBA) lo procesó ANTON
-- porque su tenant tenía una credencial VIEJA activa apuntando a la misma cuenta
-- de IG. La IA de Anton ("Nadia") le respondió a un lead de otro tenant.
-- Este script: (1) muestra el estado (backup), (2) limpia el cruce actual,
-- (3) crea el CANDADO de base: dos credenciales ACTIVAS no pueden compartir
-- la misma cuenta de IG ni la misma Página. El código además ya aplica:
-- OAuth reclama y desactiva al anterior; carga manual se rechaza con 409.
-- Correr en el editor SQL de Supabase EN ORDEN. Es idempotente.
-- ============================================================================

-- 1) BACKUP / estado actual (guardar este resultado antes de seguir):
select id, user_id, canal, page_id, ig_user_id, activo, created_at
from messenger_credentials
order by canal, ig_user_id nulls last, page_id nulls last;

-- 2) LIMPIEZA del cruce: @raicescrm (ig_user_id 27462544573385130) pertenece a la
--    cuenta de PRUEBA (190b9a5c-9a3e-4053-80a2-21fb47cac10d). Desactivar la
--    credencial de CUALQUIER otro tenant (la vieja de Anton) sobre esa cuenta:
update messenger_credentials
set activo = false
where ig_user_id = '27462544573385130'
  and user_id <> '190b9a5c-9a3e-4053-80a2-21fb47cac10d'
returning id, user_id, canal, activo;

-- 3) Asegurar ACTIVA la credencial del tenant de prueba (el dueño real de @raicescrm):
update messenger_credentials
set activo = true
where ig_user_id = '27462544573385130'
  and user_id = '190b9a5c-9a3e-4053-80a2-21fb47cac10d'
returning id, user_id, canal, activo;

-- 4) CANDADO DE BASE (lo que hace IMPOSIBLE que se repita, falle lo que falle):
--    dos filas ACTIVAS no pueden compartir cuenta de IG ni Página de Facebook.
create unique index if not exists ux_meta_ig_activa
  on messenger_credentials (ig_user_id)
  where activo = true and ig_user_id is not null;

create unique index if not exists ux_meta_page_activa
  on messenger_credentials (page_id)
  where activo = true and page_id is not null;

-- 5) Refrescar el esquema de PostgREST (gotcha conocido):
notify pgrst, 'reload schema';
