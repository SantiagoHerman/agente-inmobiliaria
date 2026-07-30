-- ============================================================================
-- Migracion: pipeline_filtros_v1 — gate del panel de FILTROS + RESUMEN POR USUARIO
-- del Pipeline. Correr UNA vez en el SQL Editor de Supabase. ADITIVA, cero riesgo.
-- ----------------------------------------------------------------------------
-- QUE PRENDE
--   Hoy el Pipeline tiene UN solo filtro: texto libre sobre nombre / telefono /
--   ultimo mensaje. Con el flag ON aparece:
--     * Panel de FILTROS (mismo molde que Conversaciones: boton con contador,
--       grupos de chips multi-select, chips removibles, "limpiar"). 12 grupos:
--       estado, puntaje (bandas + "de"/"a"), usuario (+ Sin asignar), interes,
--       temperatura, etiquetas, departamento, canal, alta, sin tocar hace,
--       IA prendida/apagada, con cita.
--     * RESUMEN POR USUARIO arriba del tablero, con "Sin asignar" PRIMERO
--       (N leads / N urgentes / N sin tocar hace M dias). Para la reunion de equipo.
--     * Orden por puntaje descendente dentro de cada columna.
--
--   business_settings.pipeline_filtros_v1 : boolean, DEFAULT false.
--     true  -> se ve todo lo de arriba.
--     false -> el Pipeline queda EXACTAMENTE como hoy (solo el buscador de texto).
--
--   FAIL-CLOSED: el front arranca en false y solo lo prende si /api/ui-flags
--   responde true explicito. Columna ausente / error / endpoint caido -> apagado.
--
--   COSTO DE IA: $0. Es una vista sobre datos que ya llegan. No llama a ningun modelo.
--   El puntaje del Pipeline se calcula por REGLAS en el navegador, no con IA.
--
--   NO toca ruteo, reparto, estados, clasificador ni prompt. El Pipeline es SOLO
--   LECTURA: no escribe nada en la base.
--
-- ACTIVACION (Diego 2026-07-30): primero SOLO Anton -- "desplegalo y quiero verlo
-- en Anton y espera mi dale para los 3 mundos". El UPDATE de Anton va incluido;
-- el de las otras cuentas queda comentado hasta que Diego lo autorice.
-- "Raices Meta Test" esta CONGELADA: queda afuera siempre.
-- ============================================================================

alter table public.business_settings
  add column if not exists pipeline_filtros_v1 boolean default false;

notify pgrst, 'reload schema';

-- Piloto: SOLO Anton.
update public.business_settings
   set pipeline_filtros_v1 = true
 where company_name = 'Anton Bienes Raices';

-- Cuando Diego de el OK para los 3 mundos (Meta Test queda afuera):
-- update public.business_settings set pipeline_filtros_v1 = true
--  where coalesce(company_name,'') not ilike '%meta test%';

-- Apagar si algo se ve raro:
-- update public.business_settings set pipeline_filtros_v1 = false where company_name = 'Anton Bienes Raices';

-- Verificacion:
select company_name, pipeline_filtros_v1 from public.business_settings order by company_name;
