-- Vuelve atras EXACTAMENTE los 14 flags de las 5 cuentas atrasadas.
-- Valores leidos de la base el 2026-08-10T23:23:29.250Z.
UPDATE public.business_settings SET respaldo_v2 = false, notif_presencia = false WHERE user_id = '8e810148-af29-4ffd-a965-331ee120464a';  -- Hosteria Tequendama
UPDATE public.business_settings SET respaldo_v2 = false, notif_presencia = false WHERE user_id = '02aacbf1-af83-4ef6-b4cc-0b81f7197e4f';  -- Pagel Propiedades
UPDATE public.business_settings SET respaldo_v2 = false, notif_presencia = false WHERE user_id = 'be10f668-6719-40c6-9cfc-00039adda9e0';  -- Raices CRM
UPDATE public.business_settings SET respaldo_v2 = false, notif_presencia = false, sin_consultar_solo = false, pipeline_filtros_v1 = false, pipeline_exportar_v1 = false, reportes_v2 = false WHERE user_id = 'fdde5351-128d-4c82-9d5e-922baaff98b6';  -- Raices Desarrolladora
UPDATE public.business_settings SET respaldo_v2 = false, notif_presencia = false WHERE user_id = '673ed078-2336-417a-a2c5-00697a063b4b';  -- Raices Inmobiliaria
