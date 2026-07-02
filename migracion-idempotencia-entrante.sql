-- ============================================================================
-- MIGRACION: idempotencia del webhook ENTRANTE de WhatsApp
-- Fix "la IA se presenta 2 veces": persistir el key.id (wa_message_id) del
-- mensaje entrante del lead + indice UNIQUE parcial para que una RE-ENTREGA del
-- webhook (reintento de Evolution >6s, o multi-instancia) no genere un segundo
-- procesamiento/respuesta del agente.
--
-- Es ADITIVA y DEFENSIVA: la columna wa_message_id ya la usa el camino SALIENTE
-- (guardarMensajeSaliente / ack messages.update). Aca solo la reforzamos con
-- IF NOT EXISTS y agregamos el indice UNIQUE parcial que faltaba para el entrante.
-- Con la columna ausente, el server cae al comportamiento actual (sin dedupe
-- durable), asi que correr esta migracion NO es urgente para no romper nada.
--
-- NO ejecutar automaticamente. Correr en Supabase cuando Diego lo apruebe.
-- ============================================================================

-- 1) Columna para guardar el key.id de WhatsApp del mensaje entrante (idempotente).
ALTER TABLE messages ADD COLUMN IF NOT EXISTS wa_message_id text;

-- 2) Indice UNIQUE PARCIAL: dos entregas concurrentes del MISMO mensaje (misma
--    conversation_id + wa_message_id) fallan atomicamente en la DB (defensa extra
--    ante el race que el SELECT-guard en memoria no cubre al 100%). Parcial para
--    no chocar con los muchos mensajes historicos que tienen wa_message_id NULL.
CREATE UNIQUE INDEX IF NOT EXISTS messages_conv_waid_uidx
  ON messages (conversation_id, wa_message_id)
  WHERE wa_message_id IS NOT NULL;

-- 3) Refrescar el cache de schema de PostgREST (gotcha conocido: sin esto, los
--    writes que usan la columna nueva pueden fallar en silencio con PGRST204).
NOTIFY pgrst, 'reload schema';
