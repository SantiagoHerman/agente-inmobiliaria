-- ============================================================================
-- MIGRACION: REPARTO POR ORDEN DE ALTA (rotacion | fija) POR DEPARTAMENTO
-- ----------------------------------------------------------------------------
-- NO EJECUTAR automaticamente: la corre el supervisor a mano.
-- Es IDEMPOTENTE (IF NOT EXISTS) y NO toca ninguna fila existente. El backend
-- lee/escribe SIEMPRE defensivo (retry sin las columnas en los SELECT + try/catch
-- en los UPDATE/INSERT): funciona aunque estas columnas todavia NO existan (cae al
-- comportamiento ACTUAL byte-identico: menor-carga / responsable_fijo). Deploy-safe.
-- ============================================================================
--
-- MODELO (decision de Diego 2026-07-24): el reparto por departamento se elige por
-- el ORDEN en que se agregaron los usuarios al departamento (NO menor-carga, NO
-- responsable_fijo). Dos modos por departamento:
--   - 'rotacion' (DEFAULT): el lead arranca en el que le toca (round-robin por el
--     cursor ultimo_asignado_id) y, si no ESCRIBE, el cron pasa al SIGUIENTE en
--     orden recorriendo a TODOS, hasta que alguien escribe (la IA cubre mientras).
--   - 'fija': cada lead NUEVO va directo al siguiente en orden y QUEDA con el (no
--     rota). La IA cubre hasta que ese humano escribe.
-- En ambos modos, la regla universal existente sigue: cuando el asesor ESCRIBE, la
-- conv pasa a 'listo_humano' + ai_enabled=false y se lo queda el que escribio.

-- Modo de asignacion del departamento: 'rotacion' (default) | 'fija'.
-- Con la columna AUSENTE el backend usa el picker de HOY (menor-carga / responsable_fijo).
ALTER TABLE departamentos
  ADD COLUMN IF NOT EXISTS modo_asignacion text DEFAULT 'rotacion';

-- Cursor round-robin: a quien le toco ULTIMO un lead NUEVO (para saber quien sigue
-- en el orden de alta). null => arrancar por el primero del orden. Best-effort/defensivo.
ALTER TABLE departamentos
  ADD COLUMN IF NOT EXISTS ultimo_asignado_id uuid;

-- Set de asesor_id ya intentados en la VUELTA de rotacion en curso (jsonb array).
-- Puede que la migracion vieja (migracion-rotacion-intentados.sql) ya la haya creado:
-- IF NOT EXISTS => no-op si ya existe. null/ausente => vuelta vacia / flujo actual.
ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS derivacion_intentados jsonb;

-- ---------------------------------------------------------------------------
-- GOTCHA Supabase: ADD COLUMN via Management API NO refresca el schema cache de
-- PostgREST -> los writes a la columna nueva fallan en silencio (PGRST204) hasta
-- recargar. Forzar el reload del esquema (si se corre por SQL editor, igual no molesta).
-- ---------------------------------------------------------------------------
NOTIFY pgrst, 'reload schema';
