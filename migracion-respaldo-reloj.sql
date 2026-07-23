-- ============================================================================
-- RESPALDO FALLO IA — RELOJ POR MENSAJE (Diego 2026-07-23)
-- ----------------------------------------------------------------------------
-- Rediseño del respaldo: en vez de BARRER candidatos (que con >1000 conversaciones
-- se comía el tope de 1000 filas y tomaba SIEMPRE las viejas, salteando las nuevas),
-- ahora cada mensaje del lead ARMA un "reloj" (respaldo_reloj = ahora) y se APAGA
-- cuando la IA/humano responde. El cron solo mira los relojes ARMADOS y vencidos.
--
-- DEPLOY-SAFE: el backend ya está desplegado y queda INERTE hasta correr esto
-- (si la columna no existe, el armado falla en silencio y el cron no deriva nada).
-- Correr esto ACTIVA el respaldo nuevo. 0 costo IA.
-- ============================================================================

-- Columna del reloj: timestamp de cuándo entró el último mensaje del lead sin responder.
ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS respaldo_reloj timestamptz;

-- Índice parcial: el cron consulta SOLO los relojes armados (respaldo_reloj IS NOT NULL),
-- ordenados por respaldo_reloj. Así la consulta es O(relojes armados), no un scan de la tabla.
CREATE INDEX IF NOT EXISTS idx_conversations_respaldo_reloj
  ON conversations (respaldo_reloj)
  WHERE respaldo_reloj IS NOT NULL;

-- Refrescar el cache de esquema de PostgREST (si no, los writes a la columna nueva
-- fallan en silencio con PGRST204 hasta el próximo reload).
NOTIFY pgrst, 'reload schema';
