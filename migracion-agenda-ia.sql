-- ============================================================================
-- MIGRACION: FEATURE #15 — "LA IA AGENDA CITAS" (Opcion B: tentativo + claim)
--                                                                   [DEFAULT OFF]
-- ----------------------------------------------------------------------------
-- NO EJECUTAR automaticamente: la corre el supervisor a mano en el SQL Editor
-- de Supabase (como owner). Es IDEMPOTENTE (IF NOT EXISTS) y NO toca ninguna
-- fila existente. El backend lee/escribe SIEMPRE defensivo (try/catch + gate
-- fail-safe): funciona aunque estas columnas todavia no existan (cae al
-- comportamiento ACTUAL EXACTO). TODO opt-in por cuenta via el flag ia_agenda
-- (default false).
--
-- QUE HABILITA (solo con ia_agenda=true por cuenta):
--   1) La tool agendar_cita se le OFRECE al agente (Sonnet). Cuando el lead
--      coordina un dia/hora, el agente la llama y queda una cita TENTATIVA:
--      estado='agendada', asesor_id=NULL (sin asignar), origen='agente',
--      fecha_fin = fecha_hora + 60 min. La IA le confirma al lead en GENERICO
--      ("queda agendado, un asesor del equipo te confirma") — sin nombrar a nadie.
--   2) Se avisa al canal interno "Todos" (0 IA, texto fijo) que hay una cita
--      nueva para tomar. Opcional: tambien al canal del depto si se sabe.
--   3) Un asesor la RECLAMA desde la agenda (POST /api/citas/tomar): claim
--      ATOMICO (compare-and-set sobre asesor_id IS NULL). El primero gana; el
--      resto recibe 409 "Ya la tomo otro asesor".
-- Con el flag OFF (o estas columnas ausentes) NADA de esto corre: la tool no se
-- ofrece, el prompt/flujo del agente queda BYTE-IDENTICO al actual.
--
-- Aislamiento multi-tenant: igual que `citas`, sin RLS; el backend accede con la
-- service key y SIEMPRE filtra por user_id (.eq). Por eso no se crean policies.
--
-- GOTCHA OBLIGATORIO (MEMORY: supabase-migraciones-cache): tras cada ADD COLUMN
-- hay que hacer NOTIFY pgrst 'reload schema' o los writes/reads de lo nuevo
-- fallan EN SILENCIO con PGRST204. El NOTIFY va al final.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1) `citas.departamento_id`: a que depto pertenece la cita tentativa (para
--    poder avisar tambien al canal del depto, y para futuros filtros). NULLABLE:
--    la cita puede ser de cualquier depto o de ninguno (el agente no siempre lo
--    sabe). NO se crea FK a proposito (borrar un depto no debe tocar el historial
--    de citas; el backend tolera un departamento_id colgando).
-- ---------------------------------------------------------------------------
ALTER TABLE citas
  ADD COLUMN IF NOT EXISTS departamento_id uuid;

-- ---------------------------------------------------------------------------
-- 2) FLAG POR-CUENTA que GATEA TODO el comportamiento nuevo. DEFAULT false (OFF).
--    Fail-safe: si esta columna no existe, iaAgendaActivo() devuelve false -> OFF.
-- ---------------------------------------------------------------------------
ALTER TABLE business_settings
  ADD COLUMN IF NOT EXISTS ia_agenda boolean DEFAULT false;

-- ---------------------------------------------------------------------------
-- GOTCHA Supabase: ADD COLUMN via Management API NO refresca el schema cache de
-- PostgREST -> los writes a la columna nueva fallan en silencio (PGRST204) hasta
-- recargar. Forzar el reload del esquema (si se corre por SQL editor, igual no molesta).
-- ---------------------------------------------------------------------------
NOTIFY pgrst, 'reload schema';
