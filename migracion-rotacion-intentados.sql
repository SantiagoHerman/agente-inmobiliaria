-- ============================================================================
-- MIGRACION: ROTACION DE DERIVACION v3 - REGISTRO DE "YA INTENTADOS" (fix ping-pong)
-- ----------------------------------------------------------------------------
-- NO EJECUTAR automaticamente: la corre el supervisor a mano.
-- Es IDEMPOTENTE (IF NOT EXISTS) y NO toca ninguna fila existente. El backend
-- lee/escribe SIEMPRE defensivo (retry sin la columna en el SELECT del cron +
-- try/catch en los UPDATE): funciona aunque esta columna todavia NO exista
-- (cae al comportamiento ACTUAL byte-identico). TODO opt-in / deploy-safe.
-- ============================================================================

-- PROBLEMA: la rotacion v3 (revisarRotacionDerivacionV3) hacia PING-PONG entre los
-- 2 asesores de MENOR carga: el picker equitativo (asesorMenorCarga) cuenta solo
-- leads en status='listo_humano', y el lead que rota esta en 'interesado'/'en_
-- conversacion' (no suma carga) -> los 2 menos cargados quedaban siempre empatados
-- como "los de menor carga" y, como el selector solo excluia al asesor ACTUAL,
-- rebotaba eternamente entre esos 2 sin darle el turno a los demas del depto.
--
-- FIX: llevar en la propia conversacion el SET de asesores YA INTENTADOS en la
-- vuelta actual (array de asesor_id, jsonb). El selector los excluye del picker
-- para rotar por TODOS los disponibles del depto. Cuando ya se probaron todos y
-- nadie respondio, NO se frena (decision de Diego): se REINICIA la vuelta (se
-- limpia el set) y se sigue rotando indefinidamente hasta que un humano tome el
-- lead. El set se resetea (=null) al iniciar, finalizar y cancelar la rotacion.

-- Set de asesor_id ya intentados en la VUELTA de rotacion en curso (jsonb array).
-- null/ausente => vuelta vacia (arranque) o migracion no corrida => flujo actual.
ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS derivacion_intentados jsonb;

-- ---------------------------------------------------------------------------
-- GOTCHA Supabase: ADD COLUMN via Management API NO refresca el schema cache de
-- PostgREST -> los writes a la columna nueva fallan en silencio (PGRST204) hasta
-- recargar. Forzar el reload del esquema (si se corre por SQL editor, igual no molesta).
-- ---------------------------------------------------------------------------
NOTIFY pgrst, 'reload schema';
