-- Cortesia con snapshot del plan previo (para restaurar el plan al sacar la cortesia).
-- Idempotente. NO ejecutar automaticamente: correr a mano en Supabase cuando se despliegue el feature.
-- El backend lee DEFENSIVO: si esta columna no existe, trata el snapshot como null y no rompe.
ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS snapshot_cortesia jsonb;
