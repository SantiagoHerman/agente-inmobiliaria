-- ============================================================================
-- migracion-derivacion-v3-default-on.sql
-- ----------------------------------------------------------------------------
-- Diego 2026-08-02: "prende V3 en todas las cuentas" + "asegurate de que este
-- en todas las futuras cuentas nuevas que se crean".
--
-- PROBLEMA: la columna se creo con DEFAULT false (ver migracion-derivacion-v3.sql),
-- asi que cada cuenta NUEVA nace con un false EXPLICITO. El backend respeta un
-- false explicito como "lo apagaron a proposito" -> la cuenta arranca sin la
-- herramienta de derivar. Le paso a Andres Galdames: 46 conversaciones, CERO
-- derivaciones, y sin ningun error visible.
--
-- YA CUBIERTO POR CODIGO (desplegado 2026-08-02, no depende de esta migracion):
--   - backend: derivacionV3Activo() ahora devuelve ON salvo false explicito
--   - frontend: el registro escribe derivacion_v3 = true al crear la cuenta
-- ESTA MIGRACION cierra el tercer flanco: las cuentas que YA existen con false,
-- y el default de la columna para cualquier fila que se cree por otra via.
--
-- EXCEPCION FIJA: las cuentas CONGELADAS (Raices Meta Test) quedan afuera.
-- REVERTIR: alter table ... set default false;  + poner en false las que quieras.
-- ============================================================================

alter table public.business_settings
  alter column derivacion_v3 set default true;

update public.business_settings
   set derivacion_v3 = true
 where coalesce(congelada, false) = false
   and coalesce(derivacion_v3, false) = false;

notify pgrst, 'reload schema';

-- Verificacion: las vivas en true, Meta Test en false.
select company_name, congelada, derivacion_v3
  from public.business_settings
 order by 1;
