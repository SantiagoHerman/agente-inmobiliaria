-- ============================================================================
-- Migracion 2026-07-31 — Bajar el costo por mensaje + backup de instrucciones
-- Correr UNA vez en el SQL Editor de Supabase. TODO ADITIVO: no toca ni una
-- fila existente y con los flags en false el sistema se comporta EXACTAMENTE
-- como hoy (los dos son fail-closed en el codigo).
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1) BACKUP de las instrucciones del agente (punto de retorno)
--    Guarda el set completo de las 4 cuentas + los perfiles guardados.
--    Para volver atras: UPDATE business_settings copiando desde esta tabla.
-- ----------------------------------------------------------------------------
create table if not exists instrucciones_backup (
  id            bigserial primary key,
  user_id       uuid not null,
  motivo        text not null,
  tomado_en     timestamptz not null default now(),
  instrucciones jsonb,
  perfiles      jsonb
);
alter table instrucciones_backup enable row level security;
-- Sin policies: solo la service key (el backend) la lee/escribe. Ningun cliente la ve.

insert into instrucciones_backup (user_id, motivo, instrucciones, perfiles)
select user_id, 'pre-capas-20260731', instrucciones_agente, instruccion_perfiles
from business_settings;

-- ----------------------------------------------------------------------------
-- 2) FLAG derivacion_validada_v1 — valida el AREA que elige la IA al derivar
--    Con true: antes de aplicar el departamento que la IA escribio a mano, el
--    codigo chequea que lo que dijo el LEAD lo respalde, contra el
--    criterio_derivacion que el dueno cargo para ese departamento. Si no hay
--    respaldo, el lead SE DERIVA IGUAL pero sin area (va al reparto general).
--    Es generico: no menciona compra ni alquiler, asi que funciona con
--    Limpieza, Mantenimiento, Capacitacion o los que se creen manana.
--    Caso que arregla: Max (30/07) derivado a "Alquiler Temporal" en su primer
--    mensaje, sin haber dicho nunca si compraba o alquilaba.
-- ----------------------------------------------------------------------------
alter table business_settings add column if not exists derivacion_validada_v1 boolean default false;

-- ----------------------------------------------------------------------------
-- 3) FLAG tools_bajo_demanda_v1 — las 5 fuentes de datos vivos solo si hacen falta
--    Con true: cotizacion_dolar, pronostico_clima, feriados_ar,
--    normalizar_direccion_ar y distancia_viaje se agregan SOLO si el lead
--    nombro el tema en la charla. Hoy viajan siempre y pesan 1.303 tokens
--    dentro del bloque CACHEADO, que se paga en cada escritura de cache.
--    Medido en Anton (28 al 31/07): 770 llamadas al modelo, NINGUNA a estas
--    tools, y aun asi se pagaron en las 38 escrituras de cache.
--    FAIL-OPEN: si no se puede leer el texto de la charla, se agregan igual.
-- ----------------------------------------------------------------------------
alter table business_settings add column if not exists tools_bajo_demanda_v1 boolean default false;

-- ----------------------------------------------------------------------------
-- 4) Refrescar el cache de esquema de PostgREST (si no, los writes fallan PGRST204)
-- ----------------------------------------------------------------------------
notify pgrst, 'reload schema';

-- ----------------------------------------------------------------------------
-- 5) Verificacion
-- ----------------------------------------------------------------------------
select motivo,
       count(*) as cuentas_respaldadas,
       sum(jsonb_array_length(coalesce(instrucciones->'items','[]'::jsonb))) as items_guardados
from instrucciones_backup
group by motivo;
