-- ============================================================================
-- RAG DE INVENTARIO — flag ia_rag_v1 (gateo fail-closed, POR CUENTA)
-- ============================================================================
-- Feature: buscador de inventario (INDICE + tools buscar_inventario/ficha_inventario)
-- que reemplaza el catalogo COMPLETO en el prompt SOLO cuando ia_rag_v1 = true.
--
-- DEPLOY-SAFE / FAIL-CLOSED:
--   * El backend YA funciona igual SIN correr esta migracion: iaRagActivo() hace un
--     probe defensivo y ante columna ausente / select error devuelve false => el
--     comportamiento es BYTE-IDENTICO al actual (inventario completo en el prompt).
--   * Esta migracion SOLO agrega la columna en DEFAULT false. NO hay UPDATE masivo a
--     true: la activacion es POR CUENTA, en piloto gradual (esto toca el corazon del
--     chat). Las cuentas nuevas tambien nacen en false.
--   * "Raices Meta Test" (congelada) JAMAS se activa.
--
-- Sin BEGIN/COMMIT ni TEMP tables (editor de Supabase). NOTIFY al final.
-- La corre Diego (regla 2 y 6 de CLAUDE.md). NO se corre desde el backend.
-- ============================================================================

ALTER TABLE business_settings
  ADD COLUMN IF NOT EXISTS ia_rag_v1 boolean DEFAULT false;

-- Recargar el schema de PostgREST para que el nuevo campo sea visible de inmediato
-- (evita PGRST204 en lecturas/escrituras que referencian la columna recien creada).
NOTIFY pgrst, 'reload schema';

-- ============================================================================
-- ACTIVAR el piloto en UNA cuenta (ejecutar a mano, cuando Diego de el "dale"):
--   UPDATE business_settings SET ia_rag_v1 = true  WHERE user_id = '<UUID_CUENTA>';
-- ROLLBACK instantaneo (sin deploy):
--   UPDATE business_settings SET ia_rag_v1 = false WHERE user_id = '<UUID_CUENTA>';
-- ============================================================================
