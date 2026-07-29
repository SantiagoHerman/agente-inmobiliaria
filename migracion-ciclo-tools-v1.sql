-- ============================================================================
-- Migracion: CICLO DE TOOLS (ciclo_tools_v1) — 1 flag por-cuenta
-- Correr UNA vez en el SQL Editor de Supabase (como owner). ADITIVA, cero riesgo.
-- ----------------------------------------------------------------------------
-- QUE PRENDE ESTE FLAG
--   Hoy generarRespuestaAgente tiene DOS turnos fijos con el modelo:
--     1) el modelo contesta y pide una herramienta;
--     2) el codigo ejecuta UNA sola herramienta y le devuelve el resultado,
--        ofreciendole todas las tools otra vez... pero al leer la respuesta SOLO
--        busca el bloque de TEXTO. Si el modelo pide otra herramienta, ese pedido
--        SE DESCARTA EN SILENCIO y sale una promesa ("dejame buscar y te paso")
--        que nunca se cumple.
--   Ademas, si el modelo pide 2+ herramientas en el MISMO turno, hoy se ejecuta
--   una sola y se manda UN solo tool_result: la API de Anthropic exige uno por
--   cada tool_use y responde 400 -> el catch cae en la misma promesa.
--   Caso real (2026-07-28, lead Alejandro Cabrera / cuenta Anton): pidio el
--   detalle de 4 locales, ficha_inventario acepta UN id por llamada -> 4 promesas
--   seguidas y lead perdido. El mismo mecanismo impedia que la IA DERIVARA
--   despues de ver los resultados.
--
--   business_settings.ciclo_tools_v1 : boolean, DEFAULT false.
--     true  -> el turno pasa a ser un CICLO real de herramientas: se ejecutan
--              TODAS las tools de cada vuelta, se devuelve UN tool_result por
--              cada tool_use y se vuelve a llamar al modelo mientras siga
--              pidiendo herramientas, con TOPE DURO de 3 vueltas (maximo 4
--              llamadas al modelo por mensaje del lead; hoy son 2 cuando usa una
--              tool). En la ultima vuelta el request va con tool_choice 'none':
--              el modelo queda obligado a cerrar con texto, nunca con una promesa.
--     false -> comportamiento ACTUAL EXACTO (2 turnos fijos, una sola tool).
--
--   COSTO: cada vuelta extra es UNA llamada mas al modelo. Peor caso +2 llamadas
--   por mensaje (4 en vez de 2); caso tipico SIN cambio (los turnos que hoy se
--   resuelven en 1 o 2 llamadas siguen igual). Ver el reporte del cambio.
--
--   NO toca ruteo, reparto/rotacion, estados, clasificador, prompt ni tools:
--   no cambia QUE decide la IA, solo la deja TERMINAR lo que ya decidio.
-- ============================================================================

alter table public.business_settings
  add column if not exists ciclo_tools_v1 boolean default false;

-- Refrescar el cache de esquema de PostgREST (gotcha conocido: ADD COLUMN via API
-- no refresca el cache y los reads/writes de la columna nueva fallan en silencio
-- con PGRST204 hasta este NOTIFY).
notify pgrst, 'reload schema';

-- ----------------------------------------------------------------------------
-- ACTIVACION POR CUENTA (piloto). NO ejecutar en esta migracion: correr a mano el
-- dia que se decida prender, UNA cuenta por vez (empezar por Anton, que es donde
-- se midio el problema). "Raices Meta Test" esta CONGELADA: queda afuera.
-- ----------------------------------------------------------------------------
-- update public.business_settings set ciclo_tools_v1 = true where company_name = 'Anton';

-- Volver atras (apagar) si algo se ve raro:
-- update public.business_settings set ciclo_tools_v1 = false where company_name = 'Anton';
