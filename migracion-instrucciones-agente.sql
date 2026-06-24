-- ============================================================================
-- Migracion: Editor de instrucciones del agente (items editables por cliente)
-- Correr UNA vez en el SQL Editor de Supabase (como owner / service key).
-- ----------------------------------------------------------------------------
-- Agrega una columna jsonb a business_settings que guarda las instrucciones del
-- agente PERSONALIZADAS por el cliente (comportamiento + rubro + internas) como
-- una lista de items: { items: [ { id, categoria, texto, activo, protegido, orden } ], updated_at }.
--
-- Es ADITIVO y A PRUEBA DE FALLOS: si la columna esta en NULL (o no existe), el
-- backend arma el prompt con los DEFAULTS hardcodeados (comportamiento + rubro +
-- el viejo business_settings.instructions) => el prompt queda IDENTICO al actual.
-- Solo cuando el cliente guarda desde el editor, esta columna pasa a mandar.
-- Las instrucciones CRITICAS (no-inventar, respeta-config) son 'protegido:true':
-- la UI no deja borrarlas/apagarlas y el backend las re-inyecta si faltan.
-- ============================================================================

alter table public.business_settings
  add column if not exists instrucciones_agente jsonb;
