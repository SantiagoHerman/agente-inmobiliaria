-- ============================================================================
-- MIGRACION: recontacto_reglas_v2 (2 reglas de Diego, 2026-07-02)
-- ----------------------------------------------------------------------------
-- Regla 1 (R1) — DERIVACION MANUAL CANCELA EL RELOJ DE RECONTACTO:
--   Cuando un humano (admin/asesor) deriva/asigna a mano un lead, o lo TOMA
--   manualmente (admin_tomo), se "congela": conversations.recontacto_congelado
--   = true. Con eso el cron de inactividad (revisarInactividad) NO lo barre a
--   recontacto y el sender (legacy + v2) NO le manda recontacto. El lead queda
--   donde lo mando el humano. Al DESASIGNAR se descongela (vuelve al flujo).
--
-- Regla 2 (R2) — EL RELOJ DE 72hs CORRE SOLO CON LA IA ENCENDIDA:
--   revisarInactividad no barre a recontacto si la IA esta pausada AHORA
--   (conv ai_enabled=false, cuenta crm_pausado/agente_pausado, o _pausaGlobal).
--   No necesita columna nueva; se apoya en columnas ya existentes.
--
-- GATE: todo el comportamiento nuevo esta detras del flag
--   business_settings.recontacto_reglas_v2 (default FALSE = OFF).
--   Con el flag OFF, el backend se comporta BYTE-IDENTICO al actual.
--   El backend es fail-safe: si el flag es false/NULL o la lectura falla -> OFF.
--
-- 0 IA / 0 tokens: son guards de SQL/logica, ninguna llamada a modelo.
--
-- IMPORTANTE (Diego): correr ESTA migracion ANTES de activar el flag en
-- cualquier cuenta. Agrega las 2 columnas y refresca el schema-cache de
-- PostgREST (gotcha conocido: ADD COLUMN via API no refresca el cache y los
-- writes fallan en silencio con PGRST204).
-- ============================================================================

-- Flag de la feature (por cuenta). Default OFF = comportamiento actual exacto.
ALTER TABLE business_settings
  ADD COLUMN IF NOT EXISTS recontacto_reglas_v2 boolean DEFAULT false;

-- Marca de "congelado por humano" (por conversacion). Default false = no congelado.
ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS recontacto_congelado boolean DEFAULT false;

-- Refrescar el schema-cache de PostgREST para que los writes/reads de las
-- columnas nuevas no fallen con PGRST204 (schema cache stale).
NOTIFY pgrst, 'reload schema';
