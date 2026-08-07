-- ============================================================================
-- ARREGLO DEL INCIDENTE — 2026-08-07
-- SINTOMA: la IA deriva, asigna el asesor, y el estado nunca pasa a listo_humano.
-- Nadie recibe aviso, no hay rotacion ni reloj, y todo cae siempre en la misma persona.
--
-- CAUSA (server.js ~5305-5341, commit f2e1721a del 2026-08-04 03:33):
--   con derivacion_unificada_v1 ON, iniciarRotacionDerivacionV3 hace:
--     1) derivarAHumano(...)  -> YA escribe conversations.asesor_id
--     2) _asignarRotacionV3(..., condicional=true) -> UPDATE ... WHERE asesor_id IS NULL
--   El paso 2 matchea CERO filas SIEMPRE (el paso 1 acaba de llenar ese campo) y la
--   rotacion se aborta creyendo que la tomo un humano. El humano es ella misma.
--
-- EVIDENCIA:
--   * avisos al equipo (los emite la linea que queda inalcanzable): 2-4/dia -> 0 el 04/08
--   * de 1.364 conversaciones: derivacion_rotando=true -> CERO
--   * 22 de 22 derivaciones desde el 04/08 quedaron mudas. Antes: cero mudas.
--   * el cursor de reparto no avanza: Bianca Correa 13 de 24 derivaciones
--
-- ESTO ES UN REVERT: apaga SOLO el flag que entro el 04/08 y devuelve el sistema al
-- camino del 03/08, que funcionaba (ese dia hubo 14 rotaciones y los avisos salieron).
-- NO se toca derivacion_v3 ni derivacion_v4: estaban igual el 03/08.
-- La cuenta congelada queda afuera. Reversible con rollback-derivacion-unificada-20260807.sql
-- ============================================================================

UPDATE public.business_settings SET derivacion_unificada_v1 = false WHERE user_id <> '190b9a5c-9a3e-4053-80a2-21fb47cac10d';

SELECT company_name, derivacion_unificada_v1 FROM public.business_settings ORDER BY company_name;
