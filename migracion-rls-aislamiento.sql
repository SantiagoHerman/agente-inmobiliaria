-- =====================================================================
-- migracion-rls-aislamiento.sql
-- AISLAMIENTO ENTRE CLIENTES (defensa en profundidad) -- ITEM 3 (b)
-- =====================================================================
--
-- !!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!
-- PARA REVISION DE DIEGO -- NO APLICAR A CIEGAS.
-- !!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!
--
-- Esta migracion endurece la RLS de messages / conversations / contacts
-- para que NINGUN cliente pueda escribir filas en el tenant de otro
-- (ni por INSERT ni cambiando el owner via UPDATE). Es DELICADA: una
-- policy mal puesta puede ROMPER escrituras legitimas del frontend
-- (un asesor insertando un mensaje de sistema, updates de conversacion,
-- creacion de contactos, etc.).
--
-- PROCEDIMIENTO OBLIGATORIO ANTES DE APLICAR:
--   1) Correr SOLO el bloque DIAGNOSTICO (Paso 0) y mirar las policies
--      ACTUALES de las 3 tablas.
--   2) Si la RLS actual YA ata cada fila al tenant en INSERT y UPDATE
--      (es decir, ya cubre dueno + asesores con WITH CHECK), entonces
--      NO HACE FALTA APLICAR NADA. Cerrar el archivo.
--   3) Si decidis aplicar, verificar columna por columna que el modelo
--      de datos real coincide (ver SUPUESTOS abajo) y probar en un
--      entorno de staging las escrituras legitimas ANTES de produccion.
--
-- SUPUESTOS (CONFIRMAR contra el schema real antes de aplicar):
--   - messages, conversations, contacts tienen una columna `user_id`
--     (uuid) que es el TENANT dueno (= auth.users.id del dueno).
--   - La tabla `asesores` tiene:
--       * admin_id       -> uuid del TENANT dueno (el user_id de arriba)
--       * auth_user_id   -> uuid de auth.users del asesor logueado
--   - El dueno NO tiene fila en `asesores`; su identidad es su auth.uid().
--   Si alguno de estos nombres difiere en tu schema, AJUSTAR el SQL.
--
-- NOTA: No tocamos SELECT/READ aca. El acceso de lectura del asesor a
--       conversaciones es por MEMBRESIA y se filtra en otra capa; meter
--       user_id = auth.uid() en SELECT romperia la vista del asesor.
--       Estas policies son SOLO de ESCRITURA (INSERT / UPDATE).
-- =====================================================================


-- =====================================================================
-- PASO 0 -- DIAGNOSTICO (CORRER ESTO PRIMERO, SOLO LECTURA)
-- Descomentar y ejecutar para ver el ESTADO ACTUAL antes de tocar nada.
-- =====================================================================
--
-- SELECT
--   schemaname,
--   tablename,
--   policyname,
--   cmd,          -- SELECT / INSERT / UPDATE / DELETE / ALL
--   permissive,
--   roles,
--   qual          AS using_expr,        -- condicion USING (lectura / fila objetivo)
--   with_check    AS with_check_expr    -- condicion WITH CHECK (fila resultante)
-- FROM pg_policies
-- WHERE tablename IN ('messages', 'conversations', 'contacts')
-- ORDER BY tablename, cmd, policyname;
--
-- -- Tambien util: confirmar que RLS esta habilitada/forzada en cada tabla.
-- SELECT relname, relrowsecurity AS rls_enabled, relforcerowsecurity AS rls_forced
-- FROM pg_class
-- WHERE relname IN ('messages', 'conversations', 'contacts');
--
-- =====================================================================
-- FIN DIAGNOSTICO. Si lo de arriba YA cubre INSERT+UPDATE atando la
-- fila al tenant (dueno + asesores), NO sigas: NO apliques lo de abajo.
-- =====================================================================


-- =====================================================================
-- PASO 1 -- POLICIES RECOMENDADAS (SOLO APLICAR TRAS REVISAR EL PASO 0)
-- Idempotentes: DROP POLICY IF EXISTS + CREATE.
-- Atan la fila al tenant: el actor debe ser el DUENO (user_id = auth.uid())
-- o uno de SUS asesores (user_id IN (admin_id de mis filas en asesores)).
-- =====================================================================

-- Asegurar RLS activa (no rompe nada si ya estaba activa).
ALTER TABLE public.messages      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.conversations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.contacts      ENABLE ROW LEVEL SECURITY;

-- ---------------------------------------------------------------------
-- MESSAGES
-- ---------------------------------------------------------------------
DROP POLICY IF EXISTS tenant_write_insert ON public.messages;
CREATE POLICY tenant_write_insert ON public.messages
  FOR INSERT
  TO authenticated
  WITH CHECK (
    user_id = auth.uid()
    OR user_id IN (SELECT admin_id FROM public.asesores WHERE auth_user_id = auth.uid())
  );

DROP POLICY IF EXISTS tenant_write_update ON public.messages;
CREATE POLICY tenant_write_update ON public.messages
  FOR UPDATE
  TO authenticated
  USING (
    user_id = auth.uid()
    OR user_id IN (SELECT admin_id FROM public.asesores WHERE auth_user_id = auth.uid())
  )
  WITH CHECK (
    user_id = auth.uid()
    OR user_id IN (SELECT admin_id FROM public.asesores WHERE auth_user_id = auth.uid())
  );

-- ---------------------------------------------------------------------
-- CONVERSATIONS
-- ---------------------------------------------------------------------
DROP POLICY IF EXISTS tenant_write_insert ON public.conversations;
CREATE POLICY tenant_write_insert ON public.conversations
  FOR INSERT
  TO authenticated
  WITH CHECK (
    user_id = auth.uid()
    OR user_id IN (SELECT admin_id FROM public.asesores WHERE auth_user_id = auth.uid())
  );

DROP POLICY IF EXISTS tenant_write_update ON public.conversations;
CREATE POLICY tenant_write_update ON public.conversations
  FOR UPDATE
  TO authenticated
  USING (
    user_id = auth.uid()
    OR user_id IN (SELECT admin_id FROM public.asesores WHERE auth_user_id = auth.uid())
  )
  WITH CHECK (
    user_id = auth.uid()
    OR user_id IN (SELECT admin_id FROM public.asesores WHERE auth_user_id = auth.uid())
  );

-- ---------------------------------------------------------------------
-- CONTACTS
-- ---------------------------------------------------------------------
DROP POLICY IF EXISTS tenant_write_insert ON public.contacts;
CREATE POLICY tenant_write_insert ON public.contacts
  FOR INSERT
  TO authenticated
  WITH CHECK (
    user_id = auth.uid()
    OR user_id IN (SELECT admin_id FROM public.asesores WHERE auth_user_id = auth.uid())
  );

DROP POLICY IF EXISTS tenant_write_update ON public.contacts;
CREATE POLICY tenant_write_update ON public.contacts
  FOR UPDATE
  TO authenticated
  USING (
    user_id = auth.uid()
    OR user_id IN (SELECT admin_id FROM public.asesores WHERE auth_user_id = auth.uid())
  )
  WITH CHECK (
    user_id = auth.uid()
    OR user_id IN (SELECT admin_id FROM public.asesores WHERE auth_user_id = auth.uid())
  );

-- ---------------------------------------------------------------------
-- Refrescar el schema cache de PostgREST (gotcha conocido del proyecto).
-- ---------------------------------------------------------------------
NOTIFY pgrst, 'reload schema';

-- =====================================================================
-- POST-APLICACION -- VERIFICAR ESCRITURAS LEGITIMAS (NO OMITIR):
--   * Asesor inserta un mensaje de sistema -> debe FUNCIONAR.
--   * Update de estado/asignacion de una conversation por el asesor -> OK.
--   * Creacion/edicion de un contacto -> OK.
--   * Intento cross-tenant (escribir con user_id de OTRO cliente) -> DEBE FALLAR.
-- Si alguna escritura legitima rompe, REVERTIR (volver a las policies del
-- Paso 0) y ajustar la condicion segun el modelo de datos real.
-- =====================================================================
