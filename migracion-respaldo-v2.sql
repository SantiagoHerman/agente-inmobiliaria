-- ============================================================================
-- RESPALDO v2 (plan B): derivacion automatica a un humano si la IA NO le
-- responde a un lead en X minutos (default 5). Sistema de RESGUARDO para que un
-- lead NUNCA quede colgado (ej: se acabo el credito de mensajes y la IA esta
-- bloqueada, o fallo algun sistema).
--
-- TODO GATEADO detras de business_settings.respaldo_v2 (DEFAULT false):
-- con el flag OFF -> CERO cambio de comportamiento (el cron solo procesa
-- cuentas con respaldo_v2 = true; fail-safe: si la columna no existe -> OFF).
--
-- ADITIVO y reentrante (IF NOT EXISTS): seguro de correr mas de una vez.
-- ============================================================================

ALTER TABLE business_settings
  ADD COLUMN IF NOT EXISTS respaldo_v2 boolean DEFAULT false,
  ADD COLUMN IF NOT EXISTS respaldo_umbral_min integer DEFAULT 5;

-- Marca persistente best-effort para NO re-procesar (anti doble-derivacion) la
-- misma conversacion en cada tick del cron. DEFAULT false. Defensivo: si esta
-- columna no existe, el cron igual dedupea con un Set en memoria dentro del proceso.
ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS respaldo_derivado boolean DEFAULT false;

-- Refrescar el schema cache de PostgREST: sin esto, los writes a las columnas
-- recien creadas pueden fallar en silencio (PGRST204). Ver MEMORY: supabase-migraciones-cache.
NOTIFY pgrst, 'reload schema';
