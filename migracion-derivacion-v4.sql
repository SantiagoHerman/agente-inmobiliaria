-- ============================================================================
-- MIGRACION: DERIVACION v4 (flag por-cuenta + columna de estado de la pregunta de depto)
-- ============================================================================
-- Rediseño de derivacion pedido por Diego: CUALQUIER disparador de derivacion entra en ROTACION
-- (la IA sigue atendiendo, tambien de noche) y el UNICO pase a listo_humano + IA off es que un
-- ASESOR ESCRIBA. Todo el comportamiento nuevo esta GATEADO por business_settings.derivacion_v4
-- (default false). Con el flag OFF (o la columna ausente) el sistema se comporta BYTE-IDENTICO
-- al de hoy (post-hotfix misruteo A+C+D). El helper derivacionV4Activo(user_id, bs) es defensivo:
-- si esta columna no existe, trata la cuenta como v4 OFF.
--
-- REQUISITO OPERATIVO: v4 se apoya en la maquinaria de rotacion de derivacion_v3 (la tool
-- derivar_a_humano + el cron revisarRotacionDerivacionV3). En una cuenta con derivacion_v4 ON
-- tambien debe estar derivacion_v3 ON. El codigo NO lo fuerza (cada gate es independiente); es
-- una condicion de configuracion.
--
-- Idempotente (ADD COLUMN IF NOT EXISTS). Incluye el NOTIFY pgrst para refrescar el schema cache
-- de PostgREST (si no, los writes a la columna fallan en silencio con PGRST204).
-- ============================================================================

-- 1) Flag por-cuenta que activa el rediseño v4 (default OFF -> comportamiento actual exacto).
ALTER TABLE business_settings
  ADD COLUMN IF NOT EXISTS derivacion_v4 boolean DEFAULT false;

-- 2) Estado de la PREGUNTA de departamento pendiente (PUNTO 2): cuando el lead pide explicitamente
--    un humano, la IA le pregunta con que area quiere hablar y deja esta marca en true hasta que
--    responde (o se cancela). Persistencia defensiva del Map en memoria _deptoPreguntaPendiente
--    (sobrevive a un reinicio del proceso). Default false.
ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS derivacion_pregunta_depto boolean DEFAULT false;

-- Refrescar el schema cache de PostgREST para que las columnas nuevas sean escribibles ya mismo
-- (gotcha conocido: ADD COLUMN via Management API no refresca PostgREST -> PGRST204 en los writes).
NOTIFY pgrst, 'reload schema';
