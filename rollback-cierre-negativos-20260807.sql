-- ROLLBACK del cierre de negativos (2026-08-07): devuelve cada conversacion a su estado exacto
UPDATE public.conversations SET status = 'recontacto', recontacto_excluido = false, motivo_perdida = NULL WHERE id = '0dc0ed1b-e7bc-407c-a343-81fd04ab9936';
UPDATE public.conversations SET status = 'recontacto', recontacto_excluido = false, motivo_perdida = NULL WHERE id = '12f6efa2-94df-447b-bbba-21f2e9898a75';
UPDATE public.conversations SET status = 'recontacto', recontacto_excluido = false, motivo_perdida = NULL WHERE id = '1b7c06a2-b9a7-406e-853c-876e59417ea4';
UPDATE public.conversations SET status = 'recontacto', recontacto_excluido = false, motivo_perdida = NULL WHERE id = '20fb3b1c-076f-4bd1-89a8-7d673ccb29ae';
UPDATE public.conversations SET status = 'recontacto', recontacto_excluido = false, motivo_perdida = NULL WHERE id = '354edf41-b152-437d-9a2e-9648bd49727f';
UPDATE public.conversations SET status = 'recontacto', recontacto_excluido = false, motivo_perdida = NULL WHERE id = '4efb62bd-068e-4bcd-88f4-1f8ede87cad2';
UPDATE public.conversations SET status = 'recontacto', recontacto_excluido = false, motivo_perdida = NULL WHERE id = '5a49c33b-77b5-4c72-adcc-0eb226173310';
UPDATE public.conversations SET status = 'recontacto', recontacto_excluido = false, motivo_perdida = NULL WHERE id = '6b92d6aa-104a-414b-bfcc-7c795411e7bb';
UPDATE public.conversations SET status = 'recontacto', recontacto_excluido = false, motivo_perdida = NULL WHERE id = 'a305ba4c-73ea-466e-ac03-22236ea70562';
UPDATE public.conversations SET status = 'recontacto', recontacto_excluido = false, motivo_perdida = NULL WHERE id = 'b83529e4-0d41-47bd-915d-05dfa5b5976d';
UPDATE public.conversations SET status = 'recontacto', recontacto_excluido = false, motivo_perdida = NULL WHERE id = 'c68fa1b6-b6ba-4d63-8733-9e113c019c42';
UPDATE public.conversations SET status = 'recontacto', recontacto_excluido = false, motivo_perdida = NULL WHERE id = 'cfdf930c-7d85-42b5-8496-d8f470a9b7b7';
UPDATE public.conversations SET status = 'recontacto', recontacto_excluido = false, motivo_perdida = NULL WHERE id = 'd4cc1510-523d-4224-a196-2d262dbd50d6';
UPDATE public.conversations SET status = 'en_conversacion', recontacto_excluido = false, motivo_perdida = NULL WHERE id = 'dbaa2c6d-d6f3-4155-b2e2-55195dc8d63a';
UPDATE public.conversations SET status = 'recontacto', recontacto_excluido = false, motivo_perdida = NULL WHERE id = 'f6d41956-0807-4584-9a34-397e4b7795ff';
