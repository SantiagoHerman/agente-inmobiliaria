-- ============================================================================
-- Migracion: FLAG consulta_dueno_activa (ciclo "consultar al dueno" + fuera de horario)
-- Correr UNA vez en el SQL Editor de Supabase (como owner). ADITIVA, cero riesgo.
-- ----------------------------------------------------------------------------
-- Objetivo: DESACOPLAR el ciclo de aprendizaje / consulta-al-dueno de reparto_v2.
-- Hasta ahora la tool `consultar_al_dueno` (la IA le pregunta al dueno cuando NO
-- sabe una politica/dato del negocio, le avisa, el dueno responde y la IA lo
-- guarda como regla) SOLO corria con reparto_v2 ON. Con este flag propio, la
-- feature se puede encender sin encender el reparto por departamento.
--
--   business_settings.consulta_dueno_activa : boolean, DEFAULT false.
--     El ciclo corre cuando (consulta_dueno_activa OR reparto_v2) = true.
--     true  -> se ofrece la tool consultar_al_dueno; cuando el dueno responde,
--              ademas de guardar la regla en knowledge_base, la IA le RESPONDE al
--              lead que quedo esperando y continua la conversacion; y si la consulta
--              se dispara FUERA del horario de oficina, el aviso al lead usa la
--              variante "voy a ver si consigo a alguien del equipo / si no, a
--              primera hora del otro dia en horario de oficina".
--     false (y reparto_v2 false) -> comportamiento ACTUAL EXACTO (nada cambia).
--
-- NO toca ninguna otra tabla ni columna. Aislamiento por tenant intacto.
-- Costo de IA: sin cambios de costo por-mensaje. La UNICA llamada de IA del ciclo
-- (Haiku, barata) es PUNTUAL: 1 por respuesta del dueno (no por mensaje del lead).
-- ============================================================================

alter table public.business_settings
  add column if not exists consulta_dueno_activa boolean default false;

-- Refrescar el cache de esquema de PostgREST (gotcha conocido: ADD COLUMN via API
-- no refresca el cache y los reads/writes de la columna nueva fallan en silencio
-- con PGRST204 hasta este NOTIFY).
notify pgrst, 'reload schema';
