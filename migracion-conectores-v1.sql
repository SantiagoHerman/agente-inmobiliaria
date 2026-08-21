-- CONECTORES V1 (F1) — flag por cuenta para resolver el motor de reservas POR COMPLEJO.
-- Con el flag OFF (default false / columna ausente) TODO sigue byte-identico a hoy:
-- consultar_disponibilidad usa _pxsolConfigDeCuenta (el primer complejo con PXSOL de la cuenta).
-- Con el flag ON: la tool resuelve el conector de CADA complejo (hotel_complejos.atributos.conector),
-- con 2+ complejos exige complejo_id, y cruza PXSOL contra hotel_reservas ("lo ocupado manda").
-- La corre Diego a mano en Supabase. Solo agrega una columna en false: no cambia comportamiento.

alter table business_settings add column if not exists conectores_v1 boolean default false;

-- PostgREST no refresca el schema solo (gotcha PGRST204): avisarle.
notify pgrst, 'reload schema';
