-- ============================================================================
-- migracion-derivacion-unificada-v1.sql
-- FASE 1 del PLAN-DERIVACION-UNIFICADA.md (Diego 2026-08-04).
--
-- QUE HABILITA: que la rotacion (v3) DEJE DE ELEGIR A QUIEN y le pregunte a la v2.
-- Regla acordada: "la v2 decide A QUIEN, la v3 decide QUE PASA DESPUES".
--
-- ADITIVA + IDEMPOTENTE. Solo agrega el flag por-cuenta. NO toca ninguna otra columna,
-- NO cambia datos, NO cambia comportamiento por si sola: con la columna en false (default)
-- el sistema corre EXACTAMENTE como hoy.
--
-- ORDEN CORRECTO (importa, ya nos mordio con pausa_de_maestro):
--   1) correr ESTA migracion
--   2) verificar que la columna existe
--   3) RECIEN AHI prender el flag, y PRIMERO en la cuenta de prueba (Raices Inmobiliaria)
--   4) verificar el caso real
--   5) recien despues, las demas cuentas
--
-- NUNCA en Raices Meta Test (cuenta congelada, fuera de todos los rollouts).
--
-- REVERTIR: poner la columna en false. El codigo vuelve al camino de hoy, byte-identico.
-- ============================================================================

alter table public.business_settings
  add column if not exists derivacion_unificada_v1 boolean default false;

-- Refrescar el schema cache de PostgREST. Sin esto, aunque la columna exista en la base,
-- las lecturas/escrituras fallan con PGRST204 hasta el proximo restart natural del cache
-- (gotcha conocido del proyecto).
notify pgrst, 'reload schema';

-- Verificacion (deberia devolver 1 fila):
-- select column_name, data_type, column_default
--   from information_schema.columns
--  where table_schema = 'public'
--    and table_name   = 'business_settings'
--    and column_name  = 'derivacion_unificada_v1';

-- Para PRENDERLO en la cuenta de prueba (correr recien despues de verificar):
-- update public.business_settings
--    set derivacion_unificada_v1 = true
--  where company_name = 'Raices Inmobiliaria';
