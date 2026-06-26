-- ============================================================================
-- MIGRACION: Recontacto v2 (paulatino / aleatorio / seguro, anti-baneo)
-- ----------------------------------------------------------------------------
-- TODO gateado detras de business_settings.recontacto_v2 (default FALSE).
-- Con el flag OFF el comportamiento es IDENTICO al actual (cero regresion):
-- estas columnas simplemente no se leen. Solo aplican cuando recontacto_v2 = true.
--
-- Es IDEMPOTENTE (IF NOT EXISTS / WHERE acotado): se puede correr mas de una vez
-- sin romper nada. NO borra ni reescribe datos existentes.
-- ============================================================================

-- 1) Columnas por-conversacion (categoria + pausas/exclusiones de recontacto)
ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS recontacto_categoria   text    DEFAULT 'frio',
  ADD COLUMN IF NOT EXISTS recontacto_pausado_lead boolean DEFAULT false,
  ADD COLUMN IF NOT EXISTS recontacto_excluido     boolean DEFAULT false;

-- 2) Columnas por-cuenta (flag, pausa global de recontacto, warm-up, topes, agresividad)
ALTER TABLE business_settings
  ADD COLUMN IF NOT EXISTS recontacto_v2            boolean DEFAULT false,
  ADD COLUMN IF NOT EXISTS recontacto_pausado       boolean DEFAULT false,
  ADD COLUMN IF NOT EXISTS recontacto_warmup_dia    int     DEFAULT 0,
  ADD COLUMN IF NOT EXISTS recontacto_enviados_hoy  int     DEFAULT 0,
  ADD COLUMN IF NOT EXISTS recontacto_enviados_fecha date,
  ADD COLUMN IF NOT EXISTS recontacto_tope_max      int     DEFAULT 400,
  ADD COLUMN IF NOT EXISTS recontacto_agresividad   text    DEFAULT 'normal',
  ADD COLUMN IF NOT EXISTS recontacto_subcupo_frio  int     DEFAULT 60;

-- 3) Refrescar el schema cache de PostgREST para que las nuevas columnas sean
--    visibles de inmediato (sino los writes/reads pueden fallar con PGRST204).
NOTIFY pgrst, 'reload schema';

-- 4) BACKFILL: marcar como 'viejo' las conversaciones que YA tuvieron una charla
--    previa (estado_previo IS NOT NULL = pasaron por algun estado antes del
--    recontacto). Estos arrancan la rampa como si fueran dia 3 y pueden usar
--    IA-memoria. El resto queda 'frio' (default) -> primer mensaje plantilla.
UPDATE conversations
   SET recontacto_categoria = 'viejo'
 WHERE estado_previo IS NOT NULL
   AND (recontacto_categoria IS NULL OR recontacto_categoria = 'frio');
