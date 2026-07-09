-- ============================================================================
-- Migracion: asesores.notif_wa_activa (switch por-usuario de aviso por WhatsApp)
-- Correr UNA vez en el SQL Editor de Supabase (service key / owner).
-- Aditiva + idempotente. Default TRUE => comportamiento actual EXACTO (todos
-- reciben, si el flag global notif_dm_wa_on esta ON). Apagarla por usuario evita
-- la notificacion DOBLE (push + WhatsApp) en usuarios Android.
-- El backend ya lo escribe/lee DEFENSIVAMENTE: si esta migracion no corrio, la
-- feature queda inerte (se trata como ON) y nada se rompe.
-- ============================================================================

alter table public.asesores
  add column if not exists notif_wa_activa boolean default true;

-- Refrescar el cache de PostgREST para que la columna sea visible de inmediato.
notify pgrst, 'reload schema';
