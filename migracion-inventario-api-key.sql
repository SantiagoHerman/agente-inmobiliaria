-- ============================================================================
-- Migracion: business_settings.inventario_api_key (API de sincronizacion de inventario)
-- Cada cliente tiene su API key para que su sistema/web EMPUJE su inventario al CRM
-- (POST /api/public/inventario/sync con header x-api-key). Aditiva + idempotente.
-- El backend genera la key on-demand (GET /api/inventario/api-key); esta columna la guarda.
-- ============================================================================

alter table public.business_settings
  add column if not exists inventario_api_key text;

-- Indice para resolver el tenant por su key en el endpoint publico (busqueda por igualdad).
create index if not exists idx_business_settings_inv_api_key
  on public.business_settings (inventario_api_key)
  where inventario_api_key is not null;

notify pgrst, 'reload schema';
