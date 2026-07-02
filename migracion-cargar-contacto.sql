-- ============================================================================
-- FEATURE: "Cargar contacto manual" desde Conversaciones (permiso por-usuario)
-- ----------------------------------------------------------------------------
-- Agrega el permiso por-asesor `puede_cargar_contacto`. Con DEFAULT false, la
-- feature queda INERTE hasta que el dueno se lo habilite a un asesor puntual
-- (checkbox en /asesores). El endpoint POST /api/contactos/cargar-manual exige
-- este flag === true (fail-safe: si la columna aun no existe, lo trata como
-- false y responde 403, asi el codigo se puede desplegar ANTES de esta migracion
-- sin habilitar nada por accidente).
--
-- No corre solo: aplicar manualmente (browser / Management API) y DESPUES recargar
-- el schema cache de PostgREST con el NOTIFY de abajo (gotcha conocido: ADD COLUMN
-- via Management API no refresca PostgREST -> los writes fallan en silencio con
-- PGRST204 hasta que se recarga el schema).
-- ============================================================================

ALTER TABLE asesores ADD COLUMN IF NOT EXISTS puede_cargar_contacto boolean DEFAULT false;

-- Refrescar el schema cache de PostgREST (si no, los reads/writes de la nueva columna dan PGRST204).
NOTIFY pgrst, 'reload schema';
