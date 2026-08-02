-- ============================================================================
-- Migracion: visibilidad_server_v1 — gate de los endpoints /api/leads/* que
-- resuelven en el SERVIDOR la visibilidad de leads (auditoria de seguridad,
-- Diego 2026-08-01). Correr UNA vez en el SQL Editor de Supabase. ADITIVA.
-- ----------------------------------------------------------------------------
-- QUE PRENDE
--   Con el flag ON, los endpoints nuevos (GET /api/leads, /api/leads/contadores,
--   /api/leads/uno, /api/leads/mensajes, POST /api/leads/actualizar) responden
--   de verdad, recortando por la `visibilidad` de quien pide (ver esAdministrador()
--   y _scopeLeadsDe() en server.js). Con el flag OFF (default) esos endpoints
--   devuelven 409 {gated:true} y NO CAMBIA NADA: el front (que hoy no los llama
--   todavia) sigue leyendo Supabase directo, byte-identico a hoy.
--
--   GET /api/leads/scope es la UNICA excepcion: NO esta gateado por este flag
--   (es de solo lectura/diagnostico, pensado para F0 -- comparar en vivo antes
--   de prender esto en ninguna cuenta).
--
--   business_settings.visibilidad_server_v1 : boolean, DEFAULT false.
--     true  -> los endpoints /api/leads/* (salvo /scope) sirven de verdad.
--     false -> 409 gated, comportamiento actual intacto.
--
--   FAIL-CLOSED en el recorte (ante duda, MENOS datos) / FAIL-OPEN en la
--   disponibilidad (un error de base es un 500 claro, nunca una lista vacia
--   silenciosa). Columna ausente / error de lectura -> flag OFF.
--
--   COSTO DE IA: $0. Es un recorte de lectura/escritura sobre datos que ya
--   existen. No llama a ningun modelo.
--
--   NO TOCA: el panel Maestro, el motor de reparto/derivacion, los estados ni
--   el prompt de la IA. En v1 la visibilidad 'departamento' se trata IGUAL que
--   'propias' a proposito (ver comentario de _scopeLeadsDe en server.js) --
--   activarla de verdad es una fase aparte, con su propio flag.
--
-- ACTIVACION: sin decidir todavia. Diego no eligio cuenta piloto para ESTA
-- fase (es distinta de pipeline_filtros_v1). El UPDATE de activacion queda
-- comentado a proposito -- no correr sin su "dale" explicito para ESTE cambio,
-- y arrancando por UNA sola cuenta (ver riesgo 2 del estudio previo: leads que
-- "desaparecen" de recontactos/agenda si el asesor no tiene visibilidad
-- 'generales'). "Raices Meta Test" queda SIEMPRE afuera (cuenta congelada).
-- ============================================================================

alter table public.business_settings
  add column if not exists visibilidad_server_v1 boolean default false;

notify pgrst, 'reload schema';

-- Piloto (EJEMPLO, no correr sin que Diego elija la cuenta y de el "dale"):
-- update public.business_settings
--    set visibilidad_server_v1 = true
--  where company_name = '<cuenta que Diego elija>';

-- Apagar si algo se ve raro (rollback inmediato, sin tocar codigo):
-- update public.business_settings set visibilidad_server_v1 = false where company_name = '<cuenta>';

-- Antes de F1 conviene correr esto (dato que el estudio previo NO pudo verificar en vivo):
-- cuantos usuarios tienen HOY visibilidad = ['departamento'] cargada (para dimensionar el
-- riesgo de la fase futura que la implemente de verdad).
-- select id, nombre, admin_id, visibilidad from public.asesores where visibilidad @> array['departamento'];

-- Verificacion del flag por cuenta:
select company_name, visibilidad_server_v1 from public.business_settings order by company_name;
