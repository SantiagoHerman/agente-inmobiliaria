-- ============================================================================================
-- reparacion-etiquetas-importadas-20260817.sql
-- ============================================================================================
-- QUE ARREGLA: los contactos importados quedaron con el NOMBRE de la etiqueta guardado en
-- `contacts.etiquetas` (ej: "Hoteles Costa"), pero el segmento por etiqueta de Oportunidades
-- filtra por ID (server.js ~14324: .overlaps('etiquetas', _etqIds) con 'etq:<id>').
-- Nombre contra id no coinciden nunca -> el segmento devolvia CERO leads siempre.
--
-- El codigo ya guarda el id (server.js -> _etiquetaIdPorNombre). Esto repara lo YA cargado.
--
-- QUE HACE: por cada contacto, cambia en `etiquetas` todo valor que sea el NOMBRE de una
-- etiqueta del catalogo del tenant (business_settings.etiquetas) por el ID de esa etiqueta.
-- Los valores que ya son ids quedan intactos. No agrega ni borra etiquetas: solo traduce.
--
-- SEGURA: no toca contactos sin etiquetas, ni etiquetas que no esten en el catalogo (esas se
-- dejan como estan para no perder informacion). SE PUEDE CORRER MAS DE UNA VEZ.
--
-- COMO CORRERLA: pegar todo en el editor SQL de Supabase y apretar Run.
--   PASO 1 = backup    PASO 2 = ver que se va a cambiar    PASO 3 = aplicar    PASO 4 = verificar
-- ============================================================================================


-- ============================================================================================
-- PASO 1 — BACKUP. Copia de las etiquetas actuales. NO borrar esta tabla hasta estar seguros.
-- ============================================================================================
CREATE TABLE IF NOT EXISTS public.backup_etiquetas_contacts_20260817 AS
SELECT id, user_id, etiquetas, now() AS respaldado_at
FROM public.contacts
WHERE etiquetas IS NOT NULL AND jsonb_array_length(etiquetas) > 0;

SELECT count(*) AS contactos_respaldados FROM public.backup_etiquetas_contacts_20260817;


-- ============================================================================================
-- PASO 2 — QUE SE VA A CAMBIAR (solo mira, no toca nada). Revisar antes de seguir.
-- ============================================================================================
SELECT c.id AS contact_id, e.valor AS guardado_hoy, cat.etq->>'id' AS pasaria_a_ser
FROM public.contacts c
CROSS JOIN LATERAL jsonb_array_elements_text(c.etiquetas) AS e(valor)
JOIN public.business_settings bs ON bs.user_id = c.user_id
CROSS JOIN LATERAL jsonb_array_elements(bs.etiquetas) AS cat(etq)
WHERE c.etiquetas IS NOT NULL
  AND lower(trim(cat.etq->>'nombre')) = lower(trim(e.valor))   -- guardado por NOMBRE
  AND cat.etq->>'id' <> e.valor                                 -- y el id es otra cosa
LIMIT 200;


-- ============================================================================================
-- PASO 3 — APLICAR. Traduce nombre -> id, dejando intacto todo lo demas.
-- ============================================================================================
WITH traducido AS (
  SELECT c.id AS contact_id,
         jsonb_agg(DISTINCT COALESCE(cat.etq->>'id', e.valor)) AS nuevas
  FROM public.contacts c
  CROSS JOIN LATERAL jsonb_array_elements_text(c.etiquetas) AS e(valor)
  LEFT JOIN public.business_settings bs ON bs.user_id = c.user_id
  LEFT JOIN LATERAL (
    SELECT x AS etq
    FROM jsonb_array_elements(COALESCE(bs.etiquetas, '[]'::jsonb)) AS x
    WHERE lower(trim(x->>'nombre')) = lower(trim(e.valor))
    LIMIT 1
  ) cat ON true
  WHERE c.etiquetas IS NOT NULL AND jsonb_array_length(c.etiquetas) > 0
  GROUP BY c.id
)
UPDATE public.contacts c
SET etiquetas = t.nuevas
FROM traducido t
WHERE c.id = t.contact_id
  AND c.etiquetas IS DISTINCT FROM t.nuevas;


-- ============================================================================================
-- PASO 4 — VERIFICACION. Tiene que devolver 0 filas: ya no queda ningun NOMBRE guardado.
-- ============================================================================================
SELECT c.id AS contact_id, e.valor AS todavia_por_nombre
FROM public.contacts c
CROSS JOIN LATERAL jsonb_array_elements_text(c.etiquetas) AS e(valor)
JOIN public.business_settings bs ON bs.user_id = c.user_id
CROSS JOIN LATERAL jsonb_array_elements(bs.etiquetas) AS cat(etq)
WHERE c.etiquetas IS NOT NULL
  AND lower(trim(cat.etq->>'nombre')) = lower(trim(e.valor))
  AND cat.etq->>'id' <> e.valor;


-- ============================================================================================
-- ROLLBACK (si algo salio mal):
--   UPDATE public.contacts c SET etiquetas = b.etiquetas
--   FROM public.backup_etiquetas_contacts_20260817 b WHERE c.id = b.id;
-- ============================================================================================
