-- ============================================================================
-- migracion-reportes-envio.sql   (Diego 2026-08-02)
--
-- Complemento de migracion-reportes-v2.sql para "EL ENVIO": el TOPE DIARIO de mensajes de
-- reportes por cuenta, PERSISTIDO (para que sobreviva un reinicio del server -- si solo viviera
-- en memoria, un restart de Railway a mitad de dia resetearia el contador y se podria superar
-- el tope real de WhatsApp mandados). Mismo patron exacto que ya usa el recontacto
-- (business_settings.recontacto_enviados_hoy / recontacto_enviados_fecha).
--
-- NO CORRER TODAVIA. Se aplica cuando Diego lo autorice, junto con migracion-reportes-v2.sql
-- (o despues; el orden entre las dos no importa, el backend tolera cualquiera de las dos ausente).
--
-- ADITIVA E IDEMPOTENTE. No borra ni reescribe nada. El backend YA tolera que estas columnas
-- no existan (_repTopeDiarioLeer/_repTopeDiarioSumar en server.js, seccion "EL ENVIO"): sin
-- ellas, el tope diario simplemente no se puede hacer cumplir ENTRE reinicios del server (se
-- degrada, no bloquea envios) -- documentado ahi mismo.
-- ============================================================================

alter table public.business_settings
  add column if not exists reportes_envios_hoy   integer default 0;
alter table public.business_settings
  add column if not exists reportes_envios_fecha  date;

-- ============================================================================
-- VERIFICACION (correr DESPUES):
--   select company_name, reportes_envios_hoy, reportes_envios_fecha
--     from public.business_settings order by company_name;
--   -> tiene que dar 0 / null en todas las cuentas (nadie mando nada todavia).
-- ============================================================================

-- OBLIGATORIO Y AL FINAL: sin esto PostgREST no ve las columnas nuevas (gotcha conocido del
-- proyecto: ADD COLUMN necesita NOTIFY pgrst o los reads/writes fallan en silencio con PGRST204).
notify pgrst, 'reload schema';
