-- ============================================================================
-- MIGRACION: Recontacto — TEXTOS EDITABLES POR RUBRO (F1-F4, F6, F7b)
-- ----------------------------------------------------------------------------
-- Agrega a business_settings:
--   1) recontacto_textos_v2      boolean  -> FLAG maestro fail-closed de la feature.
--   2) recontacto_plantillas     jsonb    -> plantillas EDITADAS por el dueno (o NULL = usar fabrica).
--   3) recontacto_plantillas_prev jsonb   -> backup de la version previa (para "Deshacer ultimo").
--
-- Forma del jsonb recontacto_plantillas:
--   { "primer_contacto": { "textos": [ { "texto": "..." }, ... ] },
--     "seguimiento":     { "textos": [ { "texto": "..." }, ... ] } }
-- El backend SANEA y COMPLETA con la fabrica del rubro al leer (helper _recontactoPlantillasMerge);
-- guardar texto basura NO rompe nada (se aplasta a 1 linea, se recorta a 300, se quitan emojis y links).
--
-- GATEADO 100% por recontacto_textos_v2. Con el flag OFF (o sin la columna, ANTES de esta migracion) el
-- backend es FAIL-CLOSED: los dos motores de recontacto (viejo y v2) siguen por el camino de siempre y el
-- comportamiento es BYTE-IDENTICO al actual. Recien con el flag ON se activan F1 (freno de gasto), F2 (textos
-- por rubro), F3 (no repetir al mismo lead), F4 (plantillas editables), F6 (deteccion correcta de primer
-- contacto + IA en seguimientos) y F7b (prompt alineado a rubro / sin emojis).
--
-- CANDADO (regla de Diego): la cuenta "Raices Meta Test" esta congelada (business_settings.congelada = true)
-- y NO se toca. Por eso el flag usa el patron congelada-safe:
--   1) ADD COLUMN ... DEFAULT false  -> TODAS las filas existentes (incluida la congelada) arrancan en false.
--   2) UPDATE ... = true WHERE congelada IS DISTINCT FROM true  -> prende SOLO las NO congeladas (cubre NULL).
--   3) ALTER COLUMN ... SET DEFAULT true  -> recien AHORA las cuentas NUEVAS nacen ON.
-- (Nunca DEFAULT true en el ADD: backfillearia la fila congelada en true y el UPDATE ya no la apagaria.)
--
-- Idempotente (ADD COLUMN IF NOT EXISTS + UPDATE + ALTER DEFAULT). Se puede re-correr. NO borra ni reescribe
-- datos existentes. Sin BEGIN/COMMIT, sin tablas temporales (patron seguro de este proyecto).
--
-- GOTCHA conocido: ADD COLUMN via la Management API NO refresca el schema-cache de PostgREST -> los reads/writes
-- de las columnas nuevas pueden fallar con PGRST204 hasta el reload. Por eso hacemos NOTIFY pgrst al final.
-- ============================================================================

-- 1) FLAG maestro de la feature (congelada-safe: OFF en la congelada, ON en el resto, ON para las nuevas).
ALTER TABLE public.business_settings ADD COLUMN IF NOT EXISTS recontacto_textos_v2 boolean DEFAULT false;
UPDATE public.business_settings SET recontacto_textos_v2 = true WHERE congelada IS DISTINCT FROM true;
ALTER TABLE public.business_settings ALTER COLUMN recontacto_textos_v2 SET DEFAULT true;

-- 2) Plantillas editadas por el dueno (NULL = usar la fabrica del rubro). No necesita flip: null es el estado inicial.
ALTER TABLE public.business_settings ADD COLUMN IF NOT EXISTS recontacto_plantillas jsonb DEFAULT NULL;

-- 3) Backup de la version previa de las plantillas (para el boton "Deshacer ultimo" del frontend).
ALTER TABLE public.business_settings ADD COLUMN IF NOT EXISTS recontacto_plantillas_prev jsonb DEFAULT NULL;

-- Refrescar el schema-cache de PostgREST para que las columnas nuevas sean visibles de inmediato.
NOTIFY pgrst, 'reload schema';
