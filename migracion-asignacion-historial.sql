-- ============================================================================
-- ASIGNACION + HISTORIAL DE PASES (rediseño de asignación de leads)
--
-- (R4) departamento_manual: distingue el ORIGEN del conversations.departamento_id:
--   - TRUE  -> lo fijó un HUMANO a mano (al asignar un asesor de un depto en el
--              panel de conversaciones). Es una asignación de área deliberada.
--   - FALSE -> lo dedujo/clasificó la IA (deducción de departamento en el agente).
--              Es una clasificación automática para el enrutamiento de reparto_v2.
--
-- Lo usa el DESASIGNAR INTELIGENTE del front: al sacar la asignación ("Sin
-- asignar"), si departamento_manual = true se limpia departamento_id (el área se
-- va); si es false (lo puso la IA, o no se sabe) se CONSERVA departamento_id para
-- no romper la clasificación/enrutamiento de la IA.
--
-- DEFAULT false: ADITIVO y SIN REGRESION. Las conversaciones existentes y las
-- cuentas sin reparto_v2 quedan con departamento_manual = false (= "no manual"),
-- que es exactamente el comportamiento conservador (no se pierde nada al desasignar).
--
-- DEFENSIVO: todos los writes a esta columna en el código son best-effort
-- (envueltos en try / .catch); si la columna aún no existe, la asignación NO se
-- rompe (sólo se omite el flag).
--
-- ADITIVO y reentrante (IF NOT EXISTS): seguro de correr más de una vez.
-- ============================================================================

ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS departamento_manual boolean DEFAULT false;

-- Refrescar el schema cache de PostgREST: sin esto, los writes a la columna
-- recién creada pueden fallar en silencio (PGRST204). Ver MEMORY: supabase-migraciones-cache.
NOTIFY pgrst, 'reload schema';
