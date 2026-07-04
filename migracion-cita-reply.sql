-- ============================================================================
-- MIGRACION: CITA / REPLY en el chat de WhatsApp
-- ----------------------------------------------------------------------------
-- Feature "cita/reply": mostrar en el chat cuando un mensaje ENTRANTE del lead
-- es una respuesta (cita) a otro mensaje de WhatsApp, tipo "↩ en respuesta a: …"
-- arriba de la burbuja.
--
-- Baileys/Evolution traen la cita en contextInfo del mensaje entrante:
--   contextInfo.stanzaId      = wa_message_id del mensaje CITADO
--   contextInfo.quotedMessage = copia del contenido citado (de ahi el texto)
--
-- Columnas nuevas (ambas nullable; null = el mensaje NO cita a ninguno):
--   messages.responde_a_wa_id text   -- wa_message_id del mensaje citado (stanzaId)
--   messages.cita_texto       text   -- texto citado (truncado ~200 chars por el backend)
--
-- El front, si responde_a_wa_id existe, dibuja un mini-bloque de cita sobre la
-- burbuja. Si ademas encuentra en la lista el mensaje con wa_message_id ===
-- responde_a_wa_id, permite tocar la cita para scrollear al original.
--
-- TODO es idempotente (IF NOT EXISTS) y NO destruye datos. NO corre sola:
-- ejecutarla a mano en Supabase cuando Diego lo apruebe. Con las columnas
-- ausentes, el server cae al comportamiento actual (el insert entrante reintenta
-- SIN estas columnas), asi que desplegar el backend ANTES de correr esta
-- migracion NO rompe nada.
--
-- Al final: NOTIFY pgrst para refrescar el schema cache de PostgREST (gotcha
-- conocido: sin esto los writes a columnas recien agregadas fallan con PGRST204).
-- ============================================================================

ALTER TABLE messages ADD COLUMN IF NOT EXISTS responde_a_wa_id text;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS cita_texto text;

-- ===== Refrescar el schema cache de PostgREST (sin esto, los writes fallan con PGRST204) =====
NOTIFY pgrst, 'reload schema';
