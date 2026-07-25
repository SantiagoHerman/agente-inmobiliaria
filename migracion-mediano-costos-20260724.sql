-- ============================================================================
-- Migracion: PLAN MEDIANO (optimizacion de costos IA) — 5 flags por-cuenta
-- Correr UNA vez en el SQL Editor de Supabase (como owner). ADITIVA, cero riesgo.
-- ----------------------------------------------------------------------------
-- Objetivo: agregar los 5 flags que gatean las optimizaciones del Plan Mediano.
-- TODOS boolean DEFAULT false => con la columna recien creada (todas las cuentas
-- en false) el backend queda BYTE-IDENTICO al actual (cada feature es fail-closed:
-- flag ausente/null/false -> OFF). NO hay UPDATE masivo: la activacion es SOLO por
-- cuenta (piloto Anton), con un UPDATE puntual (ver abajo). "Raices Meta Test"
-- (congelada) queda afuera. Aislamiento por tenant intacto (RLS por user_id).
--
--   business_settings.comportamiento_compacto : boolean, DEFAULT false.
--     true  -> usa la variante COMPACTA de las reglas de comportamiento (remueve las
--              lineas ya cubiertas por el premium playbook / la voz) SOLO cuando
--              premium o voz estan ON. Achica el bloque estatico CACHEADO (~menos
--              tokens/mensaje). Mantiene TODAS las reglas duras (no-inventar,
--              no-prometer-disponibilidad, cierre/handoff, config, etc.).
--     false -> comportamiento ACTUAL EXACTO.
--
--   business_settings.ia_prefetch_pauta : boolean, DEFAULT false.
--     true  -> cuando el lead llega de una PAUTA que matchea una PROPIEDAD
--              (inmobiliaria) con id, se adjunta la FICHA COMPLETA en la PRIMERA
--              llamada (evita el 2do round-trip de ficha_inventario). 1 query $0.
--     false -> comportamiento ACTUAL EXACTO (se nombra la opcion + numero).
--
--   business_settings.ia_tool_combinada : boolean, DEFAULT false.
--     true  -> registra la tool buscar_y_detallar (busca top-N + ficha resumida en
--              UNA llamada), evitando el 3er round-trip (buscar -> elegir -> ficha).
--              Solo aplica con el RAG de inventario (propiedades) activo (ia_rag_v1).
--     false -> la tool NO se registra (tools_hash/prefijo cacheado sin cambios).
--
--   business_settings.ia_historial_corto : boolean, DEFAULT false.
--     true  -> usa 12 mensajes de historial por turno (en vez de 16): menos tokens
--              dinamicos por respuesta.
--     false -> 16 mensajes (comportamiento ACTUAL EXACTO).
--
--   business_settings.ia_haiku_fusion : boolean, DEFAULT false.
--     true  -> fusiona las 3 llamadas internas Haiku (idioma + datos + estado) en
--              UNA sola por turno (menos llamadas/latencia). Preserva los guards de
--              trivial (no clasifica saludos). Nota: en fusion los datos se extraen
--              del texto ORIGINAL (no del traducido) -> identico para leads en el
--              idioma base; diferencia posible solo en idioma NO-base.
--     false -> 3 llamadas separadas (comportamiento ACTUAL EXACTO).
-- ============================================================================

alter table public.business_settings
  add column if not exists comportamiento_compacto boolean default false;
alter table public.business_settings
  add column if not exists ia_prefetch_pauta boolean default false;
alter table public.business_settings
  add column if not exists ia_tool_combinada boolean default false;
alter table public.business_settings
  add column if not exists ia_historial_corto boolean default false;
alter table public.business_settings
  add column if not exists ia_haiku_fusion boolean default false;

-- Refrescar el cache de esquema de PostgREST (gotcha conocido: ADD COLUMN via API
-- no refresca el cache y los writes/reads de la columna nueva fallan en silencio
-- con PGRST204 hasta este NOTIFY).
notify pgrst, 'reload schema';

-- ----------------------------------------------------------------------------
-- ACTIVACION POR CUENTA (piloto). NO ejecutar en esta migracion: correr a mano el
-- dia que se decida prender, UNA cuenta por vez. Ejemplo para Anton (reemplazar el
-- company_name exacto de la cuenta). Se puede prender un flag a la vez para medir.
-- ----------------------------------------------------------------------------
-- update public.business_settings set comportamiento_compacto = true where company_name = 'Anton';
-- update public.business_settings set ia_prefetch_pauta       = true where company_name = 'Anton';
-- update public.business_settings set ia_tool_combinada       = true where company_name = 'Anton';
-- update public.business_settings set ia_historial_corto      = true where company_name = 'Anton';
-- update public.business_settings set ia_haiku_fusion         = true where company_name = 'Anton';
