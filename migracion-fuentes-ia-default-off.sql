-- ============================================================================
-- LAS 5 FUENTES IA LIVE DEJAN DE NACER PRENDIDAS (Diego 2026-08-19)
-- ============================================================================
-- POR QUE. Las definiciones de estas 5 herramientas viajan en el prompt de CADA
-- llamada a la IA, se usen o no. MEDIDO contra ia_decisiones (30 dias, 1.361
-- turnos de las 3 cuentas activas):
--
--   pronostico_clima        339 tokens/llamada   ->  0 usos
--   feriados_ar             316 tokens/llamada   ->  0 usos
--   cotizacion_dolar        305 tokens/llamada   ->  0 usos
--   normalizar_direccion_ar 242 tokens/llamada   ->  0 usos
--   distancia_viaje         350 tokens/llamada   ->  3 usos
--
-- Son 1.552 tokens en cada llamada de cada cuenta para algo que se uso 3 veces
-- en un mes. Ya se apagaron en las 7 cuentas activas por UPDATE
-- (backup: backup-flags-tools-ANTES-20260819.json).
--
-- ESTE ARCHIVO ARREGLA LO OTRO: la migracion original (migracion-5-fuentes-flags.sql)
-- dejo `ALTER COLUMN ... SET DEFAULT true`, asi que CADA CUENTA NUEVA nace con las
-- cinco prendidas y desharia el ahorro. Es exactamente la regla de oro de Diego:
-- "todas" tiene que incluir a las FUTURAS, y para eso la columna no puede nacer
-- con un default que las prenda.
--
-- QUE NO HACE. No toca las cuentas existentes (ya estan apagadas) ni borra las
-- columnas: el dueño puede prender cualquiera de las cinco en una cuenta puntual
-- desde el panel cuando le sirva (ej: un hotel que si quiera el pronostico del
-- clima). Solo cambia con que valor NACE una cuenta nueva.
--
-- REVERTIR: volver a poner DEFAULT true en las que se quieran.
-- ============================================================================

ALTER TABLE public.business_settings ALTER COLUMN ia_dolar_lead SET DEFAULT false;
ALTER TABLE public.business_settings ALTER COLUMN ia_clima      SET DEFAULT false;
ALTER TABLE public.business_settings ALTER COLUMN ia_feriados   SET DEFAULT false;
ALTER TABLE public.business_settings ALTER COLUMN ia_georef     SET DEFAULT false;
ALTER TABLE public.business_settings ALTER COLUMN ia_osrm       SET DEFAULT false;

-- PostgREST cachea el esquema: sin esto puede seguir devolviendo el default viejo.
NOTIFY pgrst, 'reload schema';

-- ---------------------------------------------------------------------------
-- VERIFICACION (deberia devolver false en las 5 filas)
-- ---------------------------------------------------------------------------
SELECT column_name, column_default
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name = 'business_settings'
  AND column_name IN ('ia_dolar_lead','ia_clima','ia_feriados','ia_georef','ia_osrm')
ORDER BY column_name;
