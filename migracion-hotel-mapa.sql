-- ============================================================================================
-- migracion-hotel-mapa.sql
-- ============================================================================================
-- QUE AGREGA: dos columnas, `hotel_complejos.lat` y `hotel_complejos.lng`, para poder marcar en
-- el mapa la ubicacion exacta del complejo (igual que ya se hace en inmobiliaria y desarrolladora).
--
-- POR QUE: hoy el complejo guarda la ubicacion SOLO como texto libre (`ubicacion`). Con texto libre
-- la IA no puede contestar "que tan lejos esta de la playa" ni ordenar por cercania, y el cliente
-- no puede ver donde queda. Las otras dos verticales ya tienen lat/lng:
--   - inmobiliaria -> properties.lat / properties.lng  (ya existian)
--   - desarrolladora -> developments.lat / developments.lng  (ya existian)
-- Hotel era la unica que faltaba.
--
-- VA EN EL COMPLEJO, NO EN LA UNIDAD, a proposito: las unidades (habitaciones, cabañas) estan
-- TODAS en la misma direccion que su complejo. Ponerle coordenadas a cada unidad seria repetir el
-- mismo punto N veces y abrir la puerta a que queden desincronizadas.
--
-- La columna `ubicacion` (texto) NO se toca: se sigue usando para la direccion escrita.
--
-- 100% ADITIVA. No toca ninguna fila, no borra nada, no cambia comportamiento. Un complejo sin
-- coordenadas sigue funcionando exactamente igual que hoy.
-- SE PUEDE CORRER MAS DE UNA VEZ.
--
-- COMO CORRERLA: pegar todo esto en el editor SQL de Supabase y apretar Run.
-- ============================================================================================

ALTER TABLE public.hotel_complejos ADD COLUMN IF NOT EXISTS lat double precision;
ALTER TABLE public.hotel_complejos ADD COLUMN IF NOT EXISTS lng double precision;

-- Indice parcial: solo indexa los complejos que TIENEN ubicacion marcada. Hoy son 0 y siempre van
-- a ser pocos (un cliente de hotel tiene uno o dos complejos), asi que un indice normal seria casi
-- todo entradas nulas.
CREATE INDEX IF NOT EXISTS hotel_complejos_geo_idx
  ON public.hotel_complejos (user_id)
  WHERE lat IS NOT NULL;

-- PostgREST cachea el esquema: sin este NOTIFY la API sigue sin ver las columnas (PGRST204).
NOTIFY pgrst, 'reload schema';


-- ============================================================================================
-- VERIFICACION: tiene que devolver 2 filas (lat y lng).
-- ============================================================================================
SELECT table_name || '.' || column_name AS columna, data_type
  FROM information_schema.columns
 WHERE table_schema = 'public' AND table_name = 'hotel_complejos' AND column_name IN ('lat','lng')
 ORDER BY column_name;


-- ============================================================================================
-- PARA VOLVER ATRAS (nada depende de esto; el form convive con las columnas ausentes):
--   DROP INDEX IF EXISTS hotel_complejos_geo_idx;
--   ALTER TABLE public.hotel_complejos DROP COLUMN IF EXISTS lat;
--   ALTER TABLE public.hotel_complejos DROP COLUMN IF EXISTS lng;
--   NOTIFY pgrst, 'reload schema';
-- ============================================================================================
