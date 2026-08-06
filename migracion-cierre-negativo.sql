-- ============================================================================================
-- migracion-cierre-negativo.sql
--
-- Diego, 2026-08-06: "cierre negativo prendelo en todos lados y las cuentas nuevas" +
-- REGLA DE ORO: "si aplico cambios en todas las cuentas es si o si para las cuentas futuras".
--
-- OJO, ESTA MIGRACION NO ES LA QUE PRENDE LA FUNCION. La funcion ya viene PRENDIDA por codigo:
-- el gate `cierreNegativoActivo()` es FAIL-OPEN (al reves de todos los demas flags del sistema).
--   columna ausente  -> PRENDIDO
--   columna NULL     -> PRENDIDO   (una cuenta nueva nace con la funcion puesta: la regla de oro)
--   columna en FALSE -> apagado    (el UNICO caso apagado)
--
-- ENTONCES PARA QUE SIRVE ESTO: para tener la PERILLA DE APAGADO, y para apagarla en la unica
-- cuenta que tiene que quedar afuera: Raices Meta Test, que esta congelada.
-- Sin correr esto igual funciona en las 8 cuentas -- pero tambien en la congelada, y no habria
-- forma de apagarla en una cuenta puntual sin desplegar codigo.
--
-- SE PUEDE CORRER MAS DE UNA VEZ: todo es IF NOT EXISTS / idempotente.
-- COMO CORRERLA: pegar TODO este archivo en el editor SQL de Supabase y apretar Run.
-- ============================================================================================

-- 1) La perilla. SIN default a proposito: NULL = "nadie la toco" = prendido (lo resuelve el codigo).
--    Ponerle DEFAULT true seria redundante y ademas escondería la diferencia entre "nadie eligio"
--    y "alguien la prendio a mano".
ALTER TABLE public.business_settings ADD COLUMN IF NOT EXISTS cierre_negativo_v1 boolean;

-- 2) La UNICA cuenta que queda afuera: Raices Meta Test (congelada, fuera de todo rollout).
UPDATE public.business_settings
SET cierre_negativo_v1 = false
WHERE user_id = '190b9a5c-9a3e-4053-80a2-21fb47cac10d';

-- 3) PostgREST cachea el esquema: sin este NOTIFY la API sigue sin ver la columna nueva.
NOTIFY pgrst, 'reload schema';

-- 4) VERIFICACION. Esperado: la fila de Raices Meta Test en `false` y TODAS las demas en NULL
--    (NULL = prendido). Ninguna deberia quedar en `true`: no hace falta prenderla explicitamente.
SELECT
  user_id,
  cierre_negativo_v1,
  CASE WHEN cierre_negativo_v1 IS FALSE THEN 'APAGADO' ELSE 'prendido' END AS estado_real
FROM public.business_settings
ORDER BY cierre_negativo_v1 NULLS LAST, user_id;

-- ============================================================================================
-- PARA APAGARLO EN UNA CUENTA PUNTUAL (sin desplegar):
--   UPDATE public.business_settings SET cierre_negativo_v1 = false WHERE user_id = '<uuid>';
--
-- PARA APAGARLO EN TODAS (freno de mano):
--   UPDATE public.business_settings SET cierre_negativo_v1 = false;
--
-- PARA VOLVER A PRENDER una cuenta: poner NULL (o true, es lo mismo para el codigo).
--   UPDATE public.business_settings SET cierre_negativo_v1 = NULL WHERE user_id = '<uuid>';
-- ============================================================================================
