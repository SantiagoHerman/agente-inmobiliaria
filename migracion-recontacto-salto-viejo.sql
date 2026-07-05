-- ============================================================================
-- MIGRACION: recontacto_salto_viejo_dia (salto de 'viejo' en la rampa, config)
-- ----------------------------------------------------------------------------
-- Agrega business_settings.recontacto_salto_viejo_dia (int, default 3): el dia
-- de la rampa de warm-up en el que ARRANCA un lead categoria 'viejo' (caliente,
-- YA escribio). Un 'viejo' empieza MAS ARRIBA en la rampa que un frio (que
-- arranca en dia 1): el presupuesto diario de la cuenta usa la rampa "boosteada"
-- (max entre el dia real de warm-up y este salto), mientras el sub-cupo de frios
-- sigue atado a la rampa BASE (el salto beneficia a los viejos, nunca a los frios).
--
-- SOLO aplica con recontacto_v2 = true. Con el flag OFF esta columna no se lee y
-- el comportamiento es IDENTICO al actual (cero regresion). El backend ademas lee
-- esta columna con un helper DEFENSIVO (_saltoViejoDia): si la columna todavia no
-- existe o falla la lectura, degrada al default 3 sin romper el motor.
--
-- Es IDEMPOTENTE (IF NOT EXISTS): se puede correr mas de una vez sin romper nada.
-- NO borra ni reescribe datos existentes.
--
-- IMPORTANTE (gotcha conocido): ADD COLUMN via la Management API NO refresca el
-- schema-cache de PostgREST -> los reads/writes de la columna nueva pueden fallar
-- con PGRST204 hasta el reload. Por eso hacemos NOTIFY pgrst al final.
-- ============================================================================

ALTER TABLE business_settings
  ADD COLUMN IF NOT EXISTS recontacto_salto_viejo_dia int DEFAULT 3;

-- Refrescar el schema-cache de PostgREST para que la columna nueva sea visible
-- de inmediato (sino los reads/writes pueden fallar con PGRST204).
NOTIFY pgrst, 'reload schema';
