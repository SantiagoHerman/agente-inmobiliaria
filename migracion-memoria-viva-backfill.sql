-- ============================================================================
-- migracion-memoria-viva-backfill.sql
-- UNA sola columna: el interruptor del backfill de la MEMORIA VIVA (el resumen por conversacion).
-- Diego 2026-08-05, arreglo #6.
--
-- NO CORRER TODAVIA. Se escribe, no se corre (restriccion dura del pedido).
--
-- POR QUE VA EN UN ARCHIVO APARTE Y NO EN migracion-fichas-fases-245.sql: son dos cosas distintas.
-- La de fichas se puede correr sin tocar la memoria viva y al reves. Mezclarlas obligaria a decidir
-- las dos juntas.
--
-- QUE HABILITA: el endpoint POST /api/memoria-viva/backfill (server.js), que genera el resumen de
-- las conversaciones VIEJAS que hoy no lo tienen. Es una corrida MANUAL y de una sola vez.
--
-- ATENCION, ESTO GASTA PLATA: cada conversacion es 1 llamada a Haiku. Medido en produccion: 563
-- llamadas de memoria viva costaron USD 0,31 => USD 0,00055 por conversacion. El endpoint arranca
-- SIEMPRE en modo simulacion (dice cuantas son y cuanto sale) y no gasta un centavo hasta que se lo
-- confirma explicitamente con la palabra exacta. Ver el comentario del endpoint en server.js.
--
-- FAIL-CLOSED: default false. Con la columna en false (o ausente) el endpoint devuelve 409 y NO hace
-- absolutamente nada. Correr esta migracion NO dispara ningun gasto por si sola.
-- ============================================================================

alter table public.business_settings
  add column if not exists memoria_backfill_v1 boolean default false;

-- Gotcha conocido del proyecto: ADD COLUMN NO refresca el schema cache de PostgREST. Sin esto, la
-- columna existe en la base pero las lecturas fallan con PGRST204.
notify pgrst, 'reload schema';
