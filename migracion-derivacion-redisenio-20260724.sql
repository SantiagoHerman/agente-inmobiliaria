-- =====================================================================================================
-- MIGRACION — REDISENO DE DERIVACION / CONSULTA / ESTADOS (Raices CRM backend)
-- Fecha: 2026-07-24 · Rama: feature/derivacion-redisenio
-- =====================================================================================================
-- Agrega las COLUMNAS-FLAG por cuenta (business_settings) de los puntos del rediseno. TODAS default FALSE:
-- mientras esten en FALSE (o ausentes), el codigo es BYTE-IDENTICO al actual (deploy-safe / fail-closed).
-- Los flags se leen con el patron defensivo de repartoV2Activo/derivacionV4Activo (columna ausente / null /
-- error -> OFF). Cada flag es INDEPENDIENTE: prender uno NO altera el path de otro.
--
-- Mapa flag -> punto del rediseno:
--   historial_estados   -> PUNTO 5  (registra cada cambio de status como mensaje role='sistema' en el chat)
--   sin_consultar_solo  -> PUNTO 3  (modo 'preguntar' se trata como 'preguntar_derivar' -> nunca consultar-solo)
--   tools_combinadas    -> PUNTO 2  (derivar_a_humano + consultar_al_dueno en el MISMO turno se procesan AMBAS)
--   tildar_depto        -> PUNTO 6  (el clasificador deduce el depto SOLO para tildar/etiqueta, AISLADO de re-derivar)
--   relay_no_aplicable  -> PUNTO 4  (cuando la respuesta del dueno NO sirve como regla, el lead recibe un aviso minimo)
--
-- NOTA: relay_no_aplicable NO estaba en la lista de 4 flags del pedido, pero se agrego para cumplir la REGLA DURA
-- "cada punto detras de su PROPIO flag nuevo, default OFF" (el punto 4 toca comportamiento: manda un mensaje al lead
-- que hoy no recibe). Con el flag OFF el punto 4 es byte-identico a hoy.
-- =====================================================================================================

ALTER TABLE business_settings ADD COLUMN IF NOT EXISTS historial_estados  boolean NOT NULL DEFAULT false;
ALTER TABLE business_settings ADD COLUMN IF NOT EXISTS sin_consultar_solo boolean NOT NULL DEFAULT false;
ALTER TABLE business_settings ADD COLUMN IF NOT EXISTS tools_combinadas   boolean NOT NULL DEFAULT false;
ALTER TABLE business_settings ADD COLUMN IF NOT EXISTS tildar_depto       boolean NOT NULL DEFAULT false;
ALTER TABLE business_settings ADD COLUMN IF NOT EXISTS relay_no_aplicable boolean NOT NULL DEFAULT false;

-- PostgREST GOTCHA: ADD COLUMN no refresca el schema cache -> las escrituras/lecturas por la columna nueva
-- fallarian en silencio (PGRST204) hasta este NOTIFY. SIEMPRE al final de la migracion.
NOTIFY pgrst, 'reload schema';

-- =====================================================================================================
-- PUNTO 3 — MIGRACION DE DATOS (NO EJECUTAR AUTOMATICAMENTE). Correr SOLO cuando Diego autorice activar el punto 3.
-- Cambia el DEFAULT efectivo de ia_no_sabe_modo: las cuentas hoy en 'preguntar' (o NULL) pasan a 'preguntar_derivar'
-- (consultar al dueno + red de derivacion por el cron; nunca dejar al lead consultando-solo). Los 3 mundos + cuentas
-- viejas y nuevas. EXCLUYE la cuenta congelada "Raices Meta Test".
--
-- REGLA DURA DE DIEGO: BACKUP ANTES de tocar datos. Ejecutar el SELECT de backup PRIMERO, guardar el resultado, y
-- recien despues el UPDATE. El flag sin_consultar_solo hace lo mismo SIN migrar datos (trata 'preguntar' como
-- 'preguntar_derivar' en runtime); esta migracion es opcional (para persistir el modo real en la columna).
-- =====================================================================================================

-- La cuenta congelada "Raices Meta Test" se excluye por la columna canonica `congelada` (candado, ver server.js
-- ~28795). Se agrega ademas el filtro por company_name por si alguna fila no tuviera el flag seteado.

-- 1) BACKUP (correr y guardar el resultado antes del UPDATE):
-- SELECT bs.user_id, bs.company_name, bs.ia_no_sabe_modo
-- FROM business_settings bs
-- WHERE (bs.ia_no_sabe_modo = 'preguntar' OR bs.ia_no_sabe_modo IS NULL)
--   AND COALESCE(bs.congelada, false) = false
--   AND COALESCE(bs.company_name, '') NOT ILIKE '%meta test%';

-- 2) UPDATE (solo tras el backup + OK de Diego):
-- UPDATE business_settings
-- SET ia_no_sabe_modo = 'preguntar_derivar'
-- WHERE (ia_no_sabe_modo = 'preguntar' OR ia_no_sabe_modo IS NULL)
--   AND COALESCE(congelada, false) = false
--   AND COALESCE(company_name, '') NOT ILIKE '%meta test%';
-- NOTIFY pgrst, 'reload schema';
