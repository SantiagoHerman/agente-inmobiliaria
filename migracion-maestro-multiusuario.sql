-- ============================================================================
-- Migracion: Panel Maestro MULTI-USUARIO con permisos por seccion (Fase 1)
-- ----------------------------------------------------------------------------
-- Tablas DEL SISTEMA (no de un tenant): las accede el server con service_role.
-- BEST-EFFORT: todo es CREATE ... IF NOT EXISTS -> no toca datos existentes ni
-- rompe el Maestro actual si se corre dos veces. NO correr en prod sin backup
-- del schema. Tras correrla, ejecutar NOTIFY pgrst para refrescar PostgREST.
--
-- IMPORTANTE (fail-safe): si esta migracion NO se corre, el super-admin
-- (clave MAESTRO + 2FA) sigue intacto; solo la rama de EMPLEADOS devuelve 401.
-- ============================================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS maestro_usuarios (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  usuario         text NOT NULL,
  clave_hash      text NOT NULL,                 -- scryptSync hex (mismo _hashPass existente)
  clave_salt      text NOT NULL,
  totp_secret     text,                          -- base32; NULL hasta primer setup
  totp_confirmado boolean NOT NULL DEFAULT false,
  permisos        jsonb NOT NULL DEFAULT '[]'::jsonb, -- ["clientes","consumo",...]
  activo          boolean NOT NULL DEFAULT true, -- baja LOGICA (nunca DELETE)
  inactividad_min int NOT NULL DEFAULT 30,
  tope_abs_min    int NOT NULL DEFAULT 480,      -- 8h
  creado_por      text DEFAULT 'superadmin',
  created_at      timestamptz NOT NULL DEFAULT now(),
  last_login      timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS maestro_usuarios_usuario_ci_uniq ON maestro_usuarios (lower(usuario));
CREATE INDEX IF NOT EXISTS maestro_usuarios_activo_idx ON maestro_usuarios (activo);

CREATE TABLE IF NOT EXISTS maestro_sesiones (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  maestro_usuario_id  uuid NOT NULL REFERENCES maestro_usuarios(id) ON DELETE CASCADE,
  jti                 text NOT NULL UNIQUE,
  created_at          timestamptz NOT NULL DEFAULT now(),
  last_activity       timestamptz NOT NULL DEFAULT now(),
  expires_at          timestamptz NOT NULL,      -- tope ABSOLUTO
  revocada            boolean NOT NULL DEFAULT false,
  revocada_por        text,                      -- 'superadmin' | 'self' | 'idle' | 'tope'
  revocada_at         timestamptz,
  ip                  text,
  user_agent          text
);
CREATE INDEX IF NOT EXISTS maestro_sesiones_usuario_idx ON maestro_sesiones (maestro_usuario_id);
CREATE INDEX IF NOT EXISTS maestro_sesiones_activas_idx ON maestro_sesiones (revocada, expires_at);

ALTER TABLE maestro_usuarios ENABLE ROW LEVEL SECURITY;
ALTER TABLE maestro_sesiones ENABLE ROW LEVEL SECURITY;
-- Sin CREATE POLICY: anon/authenticated no ven nada; service_role bypassa.

NOTIFY pgrst, 'reload schema';
