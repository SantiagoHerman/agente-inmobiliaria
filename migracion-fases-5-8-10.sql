-- ============================================================================================
-- migracion-fases-5-8-10.sql  ·  UNA SOLA CORRIDA para no interrumpir a Diego tres veces
-- ============================================================================================
-- Junta TODO lo que necesitan las fases que quedan del plan Cloud API:
--   FASE 5  -> catalogo central de plantillas de Raices
--   FASE 8  -> unificacion de contacto Instagram/Messenger -> WhatsApp
--   FASE 10 -> importacion inteligente (staging con aprobacion) + etiquetas en contactos
--
-- 100% ADITIVA: no toca ninguna fila existente, no borra nada, no cambia ningun comportamiento.
-- SE PUEDE CORRER MAS DE UNA VEZ (todo con IF NOT EXISTS).
--
-- EL CODIGO YA ESTA DESPLEGADO Y ANDA SIN ESTO. Cada lectura nueva esta envuelta en try/catch:
-- si la columna o la tabla no existe, esa funcion queda en no-op y el resto sigue igual. Por eso
-- el orden migracion/deploy no importa.
--
-- COMO CORRERLA: pegar TODO este archivo en el editor SQL de Supabase y apretar Run.
-- ============================================================================================


-- ============================================================================================
-- FASE 10 — ETIQUETAS EN CONTACTOS
-- Diego: "si importo contactos de un telefono de alquileres, a todos les pongo una etiqueta de
-- alquileres viejos y al buscar en oportunidades los puedo buscar con esa etiqueta".
-- Hoy las etiquetas viven SOLO en conversations.etiquetas, y un contacto recien importado NO tiene
-- conversacion -> seria invisible para Oportunidades. Por eso la columna va tambien en contacts.
-- ============================================================================================
ALTER TABLE public.contacts ADD COLUMN IF NOT EXISTS etiquetas text[];
CREATE INDEX IF NOT EXISTS contacts_etiquetas_idx ON public.contacts USING GIN (etiquetas);


-- ============================================================================================
-- FASE 8 — UNIFICACION DE CONTACTO (Instagram/Messenger -> WhatsApp)
-- En IG/MSN el "telefono" es un IGSID/PSID, que no se parece a un numero. Cuando el lead pasa a
-- WhatsApp, para el sistema es una persona nueva. Estas dos columnas permiten enlazarlos SIN
-- borrar ni pisar nada: el contacto de IG conserva su fila y apunta al principal.
-- ============================================================================================
ALTER TABLE public.contacts ADD COLUMN IF NOT EXISTS telefono_capturado text;
ALTER TABLE public.contacts ADD COLUMN IF NOT EXISTS contacto_principal_id uuid;
CREATE INDEX IF NOT EXISTS contacts_tel_capturado_idx ON public.contacts (user_id, telefono_capturado);
CREATE INDEX IF NOT EXISTS contacts_principal_idx ON public.contacts (contacto_principal_id);


-- ============================================================================================
-- FASE 5 — CATALOGO CENTRAL DE PLANTILLAS DE RAICES
-- Las plantillas se aprueban POR WABA (por cliente), no se comparten entre cuentas. Pero el
-- catalogo lo mantiene Raices una sola vez y cada cliente elige cuales manda a aprobar a SU WABA.
-- Esta tabla es el catalogo maestro; el estado por cliente sigue viviendo en cloud_api_templates.
-- ============================================================================================
CREATE TABLE IF NOT EXISTS public.plantillas_catalogo (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  nombre        text NOT NULL,              -- nombre tecnico (minusculas_con_guiones)
  idioma        text NOT NULL DEFAULT 'es_AR',
  categoria     text NOT NULL,              -- MARKETING | UTILITY | AUTHENTICATION
  cuerpo        text NOT NULL,              -- con {{1}}, {{2}}... posicionales
  variables     jsonb,                      -- [{n:1, que:'nombre del lead'}, ...]
  rubro         text,                       -- inmobiliaria | hotel_cabanas | desarrolladora | null = todos
  caso          text,                       -- recontacto | oportunidad | derivacion
  riesgo        text,                       -- bajo | medio | alto (criterio de Raices, no de Meta)
  activa        boolean NOT NULL DEFAULT true,
  creado_at     timestamptz DEFAULT now(),
  actualizado_at timestamptz DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS plantillas_catalogo_uq ON public.plantillas_catalogo (nombre, idioma);
ALTER TABLE public.plantillas_catalogo ENABLE ROW LEVEL SECURITY;
-- Sin policies: solo la service key del backend accede (mismo criterio que cloud_api_numbers).


-- ============================================================================================
-- FASE 10 — IMPORTACION INTELIGENTE: STAGING CON APROBACION
-- Diego: "aprobar y dar el ok de cada contacto nuevo o de cada informacion o ficha que se le debe
-- agregar a uno existente" + "siempre pedir permiso para ese gasto".
-- NADA de lo que interpreta la IA escribe directo en contacts: todo pasa por aca y espera el OK.
-- ============================================================================================
CREATE TABLE IF NOT EXISTS public.import_lotes (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         uuid NOT NULL,
  nombre          text,                     -- como lo nombro el usuario ("agenda vieja alquileres")
  origen          text,                     -- csv | excel | pdf | imagen
  archivos        jsonb,                    -- [{nombre, url, paginas}]
  estado          text NOT NULL DEFAULT 'presupuestado',
                                            -- presupuestado -> aprobado -> procesando -> listo -> aplicado | cancelado
  modelo          text,                     -- haiku | sonnet (cual se eligio y por que)
  costo_estimado  numeric,                  -- USD, lo que se le muestra ANTES de gastar
  costo_real      numeric,                  -- USD, lo que efectivamente se gasto
  aprobado_por    uuid,                     -- quien apreto "aprobar gasto"
  aprobado_at     timestamptz,
  etiqueta_lote   text,                     -- la etiqueta que se aplica a todo el lote
  total_items     integer DEFAULT 0,
  aplicados       integer DEFAULT 0,
  creado_at       timestamptz DEFAULT now(),
  actualizado_at  timestamptz DEFAULT now()
);
CREATE INDEX IF NOT EXISTS import_lotes_user_idx ON public.import_lotes (user_id, creado_at DESC);
ALTER TABLE public.import_lotes ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS public.import_items (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  lote_id         uuid NOT NULL,
  user_id         uuid NOT NULL,
  tipo            text NOT NULL,            -- contacto_nuevo | actualizacion | ficha
  contact_id      uuid,                     -- si es actualizacion o ficha: a quien
  propuesto       jsonb NOT NULL,           -- lo que la IA leyo
  actual          jsonb,                    -- lo que hay hoy (para mostrar el diff)
  pisa_manual     boolean DEFAULT false,    -- true = reemplazaria un dato cargado a mano -> OK explicito
  etiquetas       text[],                   -- override por contacto sobre la del lote
  estado          text NOT NULL DEFAULT 'pendiente',   -- pendiente | aprobado | rechazado | aplicado | error
  error           text,
  decidido_por    uuid,
  decidido_at     timestamptz,
  creado_at       timestamptz DEFAULT now()
);
CREATE INDEX IF NOT EXISTS import_items_lote_idx ON public.import_items (lote_id, estado);
CREATE INDEX IF NOT EXISTS import_items_user_idx ON public.import_items (user_id, estado);
ALTER TABLE public.import_items ENABLE ROW LEVEL SECURITY;


-- PostgREST cachea el esquema: sin este NOTIFY la API sigue sin ver lo nuevo (42703 / PGRST204).
NOTIFY pgrst, 'reload schema';


-- ============================================================================================
-- VERIFICACION: tiene que devolver 5 columnas nuevas y 3 tablas nuevas.
-- ============================================================================================
SELECT 'columna' AS que, table_name || '.' || column_name AS nombre
  FROM information_schema.columns
 WHERE table_schema = 'public'
   AND ((table_name = 'contacts' AND column_name IN ('etiquetas','telefono_capturado','contacto_principal_id')))
UNION ALL
SELECT 'tabla', table_name
  FROM information_schema.tables
 WHERE table_schema = 'public' AND table_name IN ('plantillas_catalogo','import_lotes','import_items')
 ORDER BY 1, 2;


-- ============================================================================================
-- PARA VOLVER ATRAS (nada del sistema depende de esto; el codigo degrada a no-op):
--   DROP TABLE IF EXISTS public.import_items;
--   DROP TABLE IF EXISTS public.import_lotes;
--   DROP TABLE IF EXISTS public.plantillas_catalogo;
--   ALTER TABLE public.contacts DROP COLUMN IF EXISTS contacto_principal_id;
--   ALTER TABLE public.contacts DROP COLUMN IF EXISTS telefono_capturado;
--   ALTER TABLE public.contacts DROP COLUMN IF EXISTS etiquetas;
--   NOTIFY pgrst, 'reload schema';
-- ============================================================================================
