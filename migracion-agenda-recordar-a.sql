-- Agenda: campo "Recordar a" — a quiénes (asesores) pushear el recordatorio de una cita,
-- ADEMÁS del asesor dueño. Se guarda como JSON de asesor ids (text). Aditivo, nullable,
-- sin default: las citas existentes quedan en NULL (comportamiento actual: solo avisa al dueño).
-- Cero IA / cero tokens. Consumido por _enviarRecordatorioUno en server.js.
ALTER TABLE citas ADD COLUMN IF NOT EXISTS recordar_a text;

-- IMPORTANTE (gotcha PostgREST): tras un ADD COLUMN, el schema cache de PostgREST NO se refresca
-- solo → los writes al campo nuevo fallan en silencio (PGRST204). Forzar el reload:
NOTIFY pgrst, 'reload schema';
