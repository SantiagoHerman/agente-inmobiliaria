-- ============================================================================
-- MIGRACION: Cache TTL 1h por tenant + telemetria de caching (hashes + ttl)
-- Fecha: 2026-07-23
-- La corre el DUENO A MANO y DESPUES del deploy. El backend es DEPLOY-SAFE:
--   * Sin la columna business_settings.ai_cache_ttl_1h  -> flag OFF -> el cache_control
--     del bloque estatico queda BYTE-IDENTICO al actual (ephemeral SIN campo ttl).
--   * Sin las columnas de ia_uso (static_prompt_hash / tools_hash / cache_ttl) -> el
--     insert reintenta sin ellas -> la fila registrada es la EXACTA de hoy.
-- Nada de esto cambia el contenido del prompt, el modelo, las tools ni el flujo.
-- ============================================================================

-- 1) TELEMETRIA en ia_uso: hash canonico del bloque estatico cacheado, hash de las
--    tools, y el TTL efectivo del cache_control ('5m' u '1h'). Todas NULLABLE: las
--    filas viejas y las de etiquetas que no las mandan quedan en NULL sin problema.
ALTER TABLE ia_uso ADD COLUMN IF NOT EXISTS static_prompt_hash text;
ALTER TABLE ia_uso ADD COLUMN IF NOT EXISTS tools_hash text;
ALTER TABLE ia_uso ADD COLUMN IF NOT EXISTS cache_ttl text;

-- 2) FLAG por tenant: prende el TTL de 1h del bloque estatico cacheado. Default false
--    => mientras no se prenda explicitamente, el comportamiento es el ACTUAL EXACTO.
ALTER TABLE business_settings ADD COLUMN IF NOT EXISTS ai_cache_ttl_1h boolean DEFAULT false;

-- 3) INDICE para la consulta de comparacion (gaps de reuso del cache por tenant +
--    static_prompt_hash a lo largo del tiempo, antes/despues de subir el TTL a 1h).
CREATE INDEX IF NOT EXISTS ia_uso_user_statichash_created_idx
  ON ia_uso (user_id, static_prompt_hash, created_at);

-- 4) Refrescar el cache de esquema de PostgREST para que reconozca las columnas nuevas
--    (si no, los writes con esos campos fallan en silencio con PGRST204).
NOTIFY pgrst, 'reload schema';

-- ============================================================================
-- CONSULTA DE COMPARACION (para correr a mano, NO es parte de la migracion):
-- gaps entre respuestas consecutivas con el MISMO bloque estatico por tenant.
-- Un gap de 5-60 min pierde el cache con TTL 5m pero lo aprovecharia con TTL 1h.
--
--   WITH t AS (
--     SELECT user_id,
--            static_prompt_hash,
--            created_at,
--            cache_ttl,
--            cache_read,
--            cache_creation,
--            LAG(created_at) OVER (
--              PARTITION BY user_id, static_prompt_hash ORDER BY created_at
--            ) AS prev_created_at
--     FROM ia_uso
--     WHERE static_prompt_hash IS NOT NULL
--       AND etiqueta LIKE 'respuesta_agente%'
--   )
--   SELECT user_id,
--          static_prompt_hash,
--          COUNT(*) FILTER (
--            WHERE prev_created_at IS NOT NULL
--              AND created_at - prev_created_at BETWEEN interval '5 minutes' AND interval '60 minutes'
--          ) AS gaps_5_60_min,
--          COUNT(*) FILTER (
--            WHERE prev_created_at IS NOT NULL
--              AND created_at - prev_created_at > interval '60 minutes'
--          ) AS gaps_60_plus_min,
--          SUM(cache_creation) AS total_cache_write,
--          SUM(cache_read)     AS total_cache_read
--   FROM t
--   GROUP BY user_id, static_prompt_hash
--   ORDER BY gaps_5_60_min DESC;
-- ============================================================================
