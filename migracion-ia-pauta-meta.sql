-- ============================================================================
-- MIGRACION: PAUTA META (Click-to-WhatsApp) — flag ia_pauta_meta + columna pauta_meta
-- La corre el HUMANO en Supabase (el agente NO tiene acceso). NO incluye BEGIN/COMMIT.
--
-- Contexto: cuando un lead escribe viniendo de una PUBLICIDAD de Meta (CTWA), Baileys
-- pone los datos del aviso en contextInfo.externalAdReply. Con el flag ON:
--   NIVEL 1: esos datos (title/body/sourceUrl) se le pasan a la IA como CONTEXTO.
--   NIVEL 2: se intenta matchear ($0, codigo puro, SIN IA) el aviso contra el inventario
--            del tenant y, si matchea 1 opcion, se nombra esa opcion.
-- El codigo es FAIL-CLOSED: mientras la columna no exista, iaPautaMetaActivo() devuelve
-- OFF y el webhook + la IA quedan BYTE-IDENTICOS al actual (codigo INERTE). Recien
-- despues de correr este SQL el flag existe y queda ON en las cuentas NO congeladas.
--
-- 🔴💰 COSTO IA: NO agrega llamadas/turnos de IA. Solo suma unos POCOS CIENTOS de tokens
-- de INPUT al UNICO turno que ya se hace, y SOLO en los mensajes que vienen de un aviso
-- (raros). No cambia el cupo del plan (registrarUsoIA sigue contando base 1 igual que hoy)
-- ni dispara nada extra. Costo marginal estimado: << USD 0,01 por conversacion originada
-- en pauta. Correr este SQL = ACTIVAR ese pequeño gasto en las 3 mundos (cuentas viejas y
-- nuevas), excepto la congelada.
--
-- CANDADO (regla de Diego): la cuenta "Raices Meta Test" esta congelada
-- (business_settings.congelada = true) y NO se toca. Orden fail-closed:
--   1) ADD COLUMN ... DEFAULT false  -> TODAS las filas (incluida la congelada) arrancan OFF.
--   2) UPDATE ... = true WHERE congelada IS DISTINCT FROM true  -> prende SOLO las NO
--      congeladas (cubre tambien NULL). La congelada queda OFF.
--   3) ALTER COLUMN ... SET DEFAULT true  -> recien AHORA las cuentas NUEVAS nacen ON.
--
-- Idempotente: ADD COLUMN IF NOT EXISTS + UPDATE + ALTER DEFAULT. Se puede re-correr.
-- ============================================================================

-- 1) FLAG por-cuenta que gatea toda la feature (Nivel 1 + Nivel 2).
ALTER TABLE public.business_settings ADD COLUMN IF NOT EXISTS ia_pauta_meta boolean DEFAULT false;
UPDATE public.business_settings SET ia_pauta_meta = true WHERE congelada IS DISTINCT FROM true;
ALTER TABLE public.business_settings ALTER COLUMN ia_pauta_meta SET DEFAULT true;

-- 2) Columna aditiva para dejar REGISTRO del aviso en el mensaje entrante (best-effort).
--    jsonb nullable (sin default): solo se escribe cuando el flag esta ON y el mensaje trae
--    pauta. Si esta columna no existiera, el insert del webhook reintenta SIN ella (defensivo),
--    asi que el orden de deploy/migracion no rompe nada.
ALTER TABLE public.messages ADD COLUMN IF NOT EXISTS pauta_meta jsonb;

-- Refrescar el cache de esquema de PostgREST (si no, los reads/writes a las columnas nuevas
-- pueden fallar en silencio con PGRST204 hasta el proximo reload).
NOTIFY pgrst, 'reload schema';
