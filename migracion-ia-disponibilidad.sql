-- Flag por cuenta (fail-closed, default OFF): activa la tool consultar_disponibilidad
-- (hotel PXSOL) que consulta disponibilidad+precio en vivo por fechas.
alter table public.business_settings add column if not exists ia_disponibilidad boolean default false;
notify pgrst, 'reload schema';
