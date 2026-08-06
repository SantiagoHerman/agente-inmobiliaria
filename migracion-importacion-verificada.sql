-- ============================================================================
-- MIGRACION: importacion verificada contra WhatsApp + boton unico de chat en la ficha
-- (Diego 2026-08-06). La corre el HUMANO en Supabase (el agente NO tiene acceso).
--
-- POR QUE: en Andres Galdames entro un contacto con el telefono `1165078185` -- 10
-- digitos, SIN codigo de pais, cuando todos los demas son `549...` de 13. Ese numero
-- no puede coincidir NUNCA con un WhatsApp real: el contacto quedo huerfano, sin poder
-- tener conversacion jamas. Y en otra cuenta entraron 44 contactos de la agenda del
-- celular (escribanias, librerias, clubes) a una cola de recontacto sin que nadie los
-- revisara. La vista previa hasta hoy solo CONTABA nuevos vs existentes; con estos
-- flags pasa a FILTRAR: verifica cada numero contra WhatsApp y solo importa lo tildado.
--
-- FAIL-CLOSED: mientras estas columnas no existan, /api/ui-flags devuelve false y el
-- codigo se comporta EXACTAMENTE como hoy (la pantalla nueva no se dibuja, la red de
-- contencion de codigo de pais NO corre, los importadores no cambian).
--
-- ARRANCAN EN false EN TODAS LAS CUENTAS, A PROPOSITO. A diferencia de otras
-- migraciones, aca NO se prende nada solo: la red de contencion RECHAZA altas que hoy
-- pasan (numeros sin codigo de pais) y eso hay que verlo primero en una cuenta de
-- prueba. Diego prende cuenta por cuenta con el UPDATE comentado del final.
--
-- CANDADO (regla de Diego): la cuenta "Raices Meta Test" esta congelada
-- (business_settings.congelada = true) y queda afuera de cualquier rollout con flag.
--
-- Idempotente: ADD COLUMN IF NOT EXISTS. Se puede re-correr.
-- ============================================================================

-- 1) Gate del importador verificado (vista previa que filtra + red de contencion del backend)
ALTER TABLE public.business_settings ADD COLUMN IF NOT EXISTS importacion_verificada_v1 boolean DEFAULT false;

-- 2) Gate del boton unico "Crear chat" / "Abrir chat" en la ficha del contacto
ALTER TABLE public.business_settings ADD COLUMN IF NOT EXISTS chat_desde_ficha_v1 boolean DEFAULT false;

-- ----------------------------------------------------------------------------
-- PRENDER (NO CORRER JUNTO CON LO DE ARRIBA -- Diego decide cuenta por cuenta).
-- Descomentar y reemplazar <UUID-DE-LA-CUENTA> por el user_id del DUEÑO.
-- Recomendado: primero en "Raices Inmobiliaria" (la cuenta de PRUEBA).
-- ----------------------------------------------------------------------------
-- UPDATE public.business_settings
--   SET importacion_verificada_v1 = true, chat_desde_ficha_v1 = true
--   WHERE user_id = '<UUID-DE-LA-CUENTA>' AND congelada IS DISTINCT FROM true;

-- APAGAR (rollback instantaneo, sin deploy):
-- UPDATE public.business_settings
--   SET importacion_verificada_v1 = false, chat_desde_ficha_v1 = false
--   WHERE user_id = '<UUID-DE-LA-CUENTA>';

-- Refrescar el cache de esquema de PostgREST (si no, los reads a las columnas nuevas
-- fallan con PGRST204 hasta el proximo reload).
NOTIFY pgrst, 'reload schema';
