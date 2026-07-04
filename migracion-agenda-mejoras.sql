-- ============================================================================
-- MIGRACION: AGENDA — 5 MEJORAS (refinan la feature #15 ya desplegada)
-- ----------------------------------------------------------------------------
-- Correr UNA vez en el SQL Editor de Supabase (como owner). NO se ejecuta sola.
-- ADITIVA, IDEMPOTENTE (IF NOT EXISTS) y SIN REGRESION: las citas actuales
-- siguen funcionando EXACTAMENTE igual. Cero IA.
--
-- Aislamiento multi-tenant: igual que `citas` / `business_settings`, se accede
-- desde el backend con la service key filtrando SIEMPRE por user_id (.eq). Por eso
-- no se crean policies aca (mismo modelo que migracion-agenda-tareas.sql).
--
-- DEFENSIVO en el backend: todo read/write de las columnas nuevas va envuelto en
-- try/.catch y degrada a los defaults actuales si la migracion aun no corrio
-- (recordatorios: cae a [24,1]h = comportamiento byte-identico de hoy; `lugar`:
-- se ignora si no existe). Desplegar el backend SIN correr esto NO rompe nada.
--
-- GOTCHA OBLIGATORIO (MEMORY: supabase-migraciones-cache): tras cada ADD COLUMN
-- hay que hacer NOTIFY pgrst 'reload schema' o los writes/reads de lo nuevo fallan
-- EN SILENCIO con PGRST204. El NOTIFY va al final.
-- ============================================================================

-- ---------- 1) `citas.lugar` — texto libre del lugar de la cita ----------
-- MEJORA #4: mostrar DONDE es la cita. Si hay `property_id` la agenda muestra la
-- propiedad; si NO hay propiedad ligada, `lugar` guarda una direccion/lugar de
-- texto. NULL/DEFAULT => las citas existentes quedan identicas.
ALTER TABLE citas
  ADD COLUMN IF NOT EXISTS lugar text;

-- ---------- 2) `business_settings.recordatorio_citas_horas` — offsets config ----------
-- MEJORA #3: cuantas HORAS antes de la cita se manda el recordatorio, configurable
-- por cuenta. Se guarda como TEXTO JSON de un array de horas, ej. '[24,1]' = 24h y
-- 1h antes. Si la cuenta NO lo definio (NULL / vacio / invalido) el backend cae al
-- DEFAULT [24,1] (24h + 1h antes) => comportamiento actual. Se usa text (no jsonb)
-- para que el backend lo parsee defensivamente y tolere strings sueltos.
ALTER TABLE business_settings
  ADD COLUMN IF NOT EXISTS recordatorio_citas_horas text;

-- ---------- 3) `citas.recordatorios_enviados` — traza multi-offset (idempotencia) ----------
-- MEJORA #3 (mecanismo): hoy `recordatorio_enviado` (boolean) dispara UN recordatorio
-- en la ventana de 24h. Para soportar VARIOS offsets (ej. 24h Y 1h) sin re-enviar,
-- guardamos aca la lista de offsets (en horas) YA enviados para esa cita, como texto
-- JSON, ej. '[24]' => ya se mando el de 24h, falta el de 1h. NULL/'[]' => ninguno.
-- DEFENSIVO: si la columna no existe el cron degrada al flag boolean clasico
-- (recordatorio_enviado) => comportamiento byte-identico. `recordatorio_enviado`
-- se sigue marcando (compat con el reset en /api/citas/actualizar y el resto del codigo).
ALTER TABLE citas
  ADD COLUMN IF NOT EXISTS recordatorios_enviados text;

-- ---------- Refrescar el schema cache de PostgREST (gotcha PGRST204) ----------
NOTIFY pgrst, 'reload schema';
