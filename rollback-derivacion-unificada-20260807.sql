-- ROLLBACK: vuelve derivacion_unificada_v1 al estado EXACTO de antes del apagado
UPDATE public.business_settings SET derivacion_unificada_v1 = true WHERE user_id = '2893a542-7cc3-40ca-9a78-ab93298734a8';
UPDATE public.business_settings SET derivacion_unificada_v1 = true WHERE user_id = 'f771e75e-c12a-4010-b301-d59796da5168';
UPDATE public.business_settings SET derivacion_unificada_v1 = true WHERE user_id = '8e810148-af29-4ffd-a965-331ee120464a';
UPDATE public.business_settings SET derivacion_unificada_v1 = true WHERE user_id = '02aacbf1-af83-4ef6-b4cc-0b81f7197e4f';
UPDATE public.business_settings SET derivacion_unificada_v1 = true WHERE user_id = 'be10f668-6719-40c6-9cfc-00039adda9e0';
UPDATE public.business_settings SET derivacion_unificada_v1 = true WHERE user_id = 'fdde5351-128d-4c82-9d5e-922baaff98b6';
UPDATE public.business_settings SET derivacion_unificada_v1 = true WHERE user_id = '673ed078-2336-417a-a2c5-00697a063b4b';
UPDATE public.business_settings SET derivacion_unificada_v1 = false WHERE user_id = '190b9a5c-9a3e-4053-80a2-21fb47cac10d';
