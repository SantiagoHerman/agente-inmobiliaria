-- ARREGLO DEL INCIDENTE 2026-08-07: la IA deriva y el estado nunca pasa a listo_humano.
-- CAUSA: con derivacion_v4 ON, la rama de server.js:13121 reemplaza al unico update({status}).
-- La rotacion que deberia reemplazarlo NO ocurre (0 conversaciones rotando en toda la base).
-- EVIDENCIA: de 173 pases a listo_humano desde el 24/07, CERO salieron del clasificador.
-- La cuenta congelada (Raices Meta Test) queda afuera, como siempre.

UPDATE public.business_settings SET derivacion_v4 = false WHERE user_id <> '190b9a5c-9a3e-4053-80a2-21fb47cac10d';

SELECT company_name, derivacion_v4 FROM public.business_settings ORDER BY company_name;
