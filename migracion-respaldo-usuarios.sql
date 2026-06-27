-- ============================================================================
-- RESPALDO (Plan B) configurable: lista de usuarios que reciben los leads
-- cuando la IA no respondio en X minutos.
--
-- Agrega business_settings.respaldo_usuarios = array jsonb de ids de asesor
-- (DEFAULT array VACIO). Vacio => el respaldo usa el reparto normal del equipo;
-- con ids => reparte EQUITATIVAMENTE solo entre esos usuarios.
--
-- respaldo_v2 (bool) y respaldo_umbral_min (int 1-240) YA EXISTEN: no se tocan.
--
-- TODO sigue gateado por respaldo_v2 por-tenant (sin activar, no cambia nada).
-- Idempotente (IF NOT EXISTS). Aislado por tenant (cada fila es de su user_id).
-- ============================================================================

ALTER TABLE business_settings
  ADD COLUMN IF NOT EXISTS respaldo_usuarios jsonb NOT NULL DEFAULT '[]'::jsonb;

-- GOTCHA conocido del proyecto: ADD COLUMN via Management API NO refresca el
-- schema cache de PostgREST -> los writes a la columna nueva fallan en silencio
-- (PGRST204). Forzar el reload del cache:
NOTIFY pgrst, 'reload schema';
