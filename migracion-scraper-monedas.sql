-- ============================================================================
-- Migracion: MONEDA POR OPERACION + "no disponible en la web"  (properties)
-- Correr UNA vez en el SQL Editor de Supabase (como owner). ADITIVA e IDEMPOTENTE.
-- ----------------------------------------------------------------------------
-- POR QUE (incidente 2026-07-28, cuenta Anton, lead Alejandro Cabrera):
-- la ficha web trae UN precio ("U$S 30.000") y el importador lo copiaba a TODAS las
-- operaciones TIRANDO LA MONEDA. El prompt de la IA, a su vez, HARDCODEA la moneda por
-- operacion (venta=USD, anual=$/mes, temporal=$/dia) -> la IA ofrecio locales EN VENTA
-- en dolares como "alquiler mensual en pesos" y le juro al lead que eran pesos.
--
-- Estas columnas hacen que la moneda sea un DATO, no una suposicion del prompt.
--
--   properties.venta_moneda      text  ('USD' | 'ARS' | null = no se sabe)
--   properties.anual_moneda      text  ('USD' | 'ARS' | null = no se sabe)
--   properties.temporal_moneda   text  ('USD' | 'ARS' | null = no se sabe)
--   properties.no_disponible_web boolean default false
--       Lo que DECLARA la web ("No disponible" / "Vendida" / "Alquilada") dentro de la
--       ficha. Es un campo INTERNO: sirve para NO OFRECER la propiedad. La IA NUNCA le
--       dice "no disponible" al lead (correccion D1 de Diego): dice que no cuenta con
--       esa informacion y deriva al departamento que corresponde.
--
-- TODAS nullable / con default inocuo: si el codigo corre ANTES de esta migracion,
-- se comporta EXACTAMENTE como hoy (el backend prueba las columnas y cae al
-- comportamiento anterior si no existen). Cero regresion en los dos ordenes.
--
-- VIGENCIA DE TEMPORADA: NO se agrega ninguna columna de texto. La vigencia del precio
-- temporal va por FECHAS en la tabla que YA existe: `temporario_periodos`
-- (property_id, user_id, fecha_desde, fecha_hasta, estado, precio_dia, nota).
-- Es la misma tabla que ya leen el prompt y el filtro del RAG. Verano e invierno se
-- distinguen por el RANGO: verano = 1-dic a 31-mar; invierno = todo julio.
--
-- ⚠ VERIFICAR ANTES DE DEPLOYAR (no se pudo comprobar sin acceso a la base):
-- las temporadas se guardan con estado='temporada' (valor NUEVO; los consumidores actuales
-- solo miran estado='ocupado', asi que les resulta invisible y no bloquean disponibilidad).
-- Si `estado` tuviera un CHECK que no admita ese valor, el insert falla y la feature queda
-- muerta (queda en el log como "[scraper temporada] no se pudo guardar..."). Chequeo:
--   select con.conname, pg_get_constraintdef(con.oid)
--     from pg_constraint con join pg_class rel on rel.oid = con.conrelid
--    where rel.relname = 'temporario_periodos' and con.contype = 'c';
-- Si aparece un CHECK sobre `estado`, hay que ampliarlo para incluir 'temporada'.
--
-- DUDAS DEL SCRAPER: tampoco necesitan tabla nueva. Van a `scraping_pendientes` con
-- tipo_cambio='duda' y el motivo dentro de datos_nuevos (jsonb). OJO: NO usar
-- `scrape_jobs` (es la cola de DESARROLLADORA y su runner toma el pendiente mas viejo
-- sin filtrar por tipo: meter una duda ahi bloquea esa cola).
-- ============================================================================

alter table public.properties add column if not exists venta_moneda text;
alter table public.properties add column if not exists anual_moneda text;
alter table public.properties add column if not exists temporal_moneda text;
alter table public.properties add column if not exists no_disponible_web boolean default false;

-- ----------------------------------------------------------------------------
-- BACKFILL DE MONEDA (solo la MONEDA; NO toca ningun numero).
-- Donde el texto del precio publicado dice dolares y la propiedad tiene la venta activa,
-- la moneda de venta es USD. Es lo unico que se puede afirmar sin ambiguedad desde el
-- texto. Los numeros mal asignados (anual/temporal que en realidad son venta USD) NO se
-- tocan aca: esa es la limpieza de datos posterior al deploy, con SELECT previo.
-- Idempotente: solo escribe donde venta_moneda esta vacia.
-- ----------------------------------------------------------------------------
update public.properties
   set venta_moneda = 'USD'
 where venta_moneda is null
   and venta_activa is true
   and price ~* '(u\$s|us\$|u\$d|usd|d[oó]lar)';

-- Control (correr a mano despues del update, no rompe nada):
--   select count(*) as venta_usd from public.properties where venta_moneda = 'USD';
--   select count(*) as anual_en_dolares_sospechosos from public.properties
--    where anual_activa is true and anual_precio is not null and price ~* '(u\$s|us\$|usd)';
--   select count(*) as por_noche_que_es_venta_usd from public.properties
--    where temporal_activa is true and temporal_precio_dia is not null
--      and price ~* '(u\$s|us\$|usd)' and price !~* '(por noche|por d[ií]a)';

-- GOTCHA PGRST204: sin esto PostgREST sigue con el schema viejo en cache y los INSERT/UPDATE
-- que usen las columnas nuevas fallan aunque la columna exista.
notify pgrst, 'reload schema';
