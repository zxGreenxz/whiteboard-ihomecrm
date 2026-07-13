-- =============================================================================
-- Sprint 2a — Normalized RBAC schema (ADDITIVE / INERT).
-- (AUTHORIZATION-PLAN.md §11.3–11.5)
--
-- Tạo bảng permission_definitions / organization_roles / role_permissions /
-- role_bindings / authorization_scopes / role_binding_scopes /
-- member_permission_overrides / member_override_scopes.
--
-- Additive + inert: chưa enforce (RLS/RPC cũ giữ nguyên). Composite FK cùng org
-- dùng UNIQUE(organization_id,id) đã tạo ở Sprint 1 (organizations/memberships)
-- và các root tables (areas/buildings/accounts). Rollback = DROP các bảng này.
-- Idempotent.
-- =============================================================================

BEGIN;

-- Registry key chuẩn hoá (nguồn sự thật cho permission).
CREATE TABLE IF NOT EXISTS public.permission_definitions (
  key               text PRIMARY KEY,          -- '<resource>.<action>'
  resource          text NOT NULL,
  action            text NOT NULL,
  sensitivity       text NOT NULL CHECK (sensitivity IN ('VIEW','MANAGE','ELEVATED','PLATFORM')),
  permission_domain text NOT NULL DEFAULT 'TENANT' CHECK (permission_domain IN ('TENANT','PLATFORM')),
  scope_kinds       text[] NOT NULL DEFAULT ARRAY['ORGANIZATION']::text[],
  is_active         boolean NOT NULL DEFAULT true,
  UNIQUE (resource, action)
);

CREATE TABLE IF NOT EXISTS public.organization_roles (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE RESTRICT,
  name            text NOT NULL,
  is_system       boolean NOT NULL DEFAULT false,
  legacy_role_id  uuid,                          -- trace về roles.id (materialize)
  version         bigint NOT NULL DEFAULT 1,
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, id)
);
CREATE UNIQUE INDEX IF NOT EXISTS org_roles_org_name_lower_uidx
  ON public.organization_roles (organization_id, lower(name));

CREATE TABLE IF NOT EXISTS public.role_permissions (
  organization_id uuid NOT NULL,
  role_id         uuid NOT NULL,
  permission_key  text NOT NULL REFERENCES public.permission_definitions(key),
  effect          text NOT NULL DEFAULT 'ALLOW' CHECK (effect IN ('ALLOW','DENY')),
  PRIMARY KEY (organization_id, role_id, permission_key),
  FOREIGN KEY (organization_id, role_id)
    REFERENCES public.organization_roles(organization_id, id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS public.role_bindings (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  membership_id   uuid NOT NULL,
  role_id         uuid NOT NULL,
  legacy_assignment_id uuid,                     -- trace về staff_assignments.id
  valid_from      timestamptz DEFAULT now(),
  valid_to        timestamptz,
  version         bigint NOT NULL DEFAULT 1,
  UNIQUE (organization_id, id),
  FOREIGN KEY (organization_id, membership_id)
    REFERENCES public.organization_memberships(organization_id, id) ON DELETE CASCADE,
  FOREIGN KEY (organization_id, role_id)
    REFERENCES public.organization_roles(organization_id, id) ON DELETE CASCADE,
  CHECK (valid_to IS NULL OR valid_from IS NULL OR valid_to > valid_from)
);
CREATE INDEX IF NOT EXISTS role_bindings_membership_idx ON public.role_bindings (membership_id, valid_to);
CREATE INDEX IF NOT EXISTS role_bindings_role_idx       ON public.role_bindings (role_id, valid_to);

CREATE TABLE IF NOT EXISTS public.authorization_scopes (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  scope_type      text NOT NULL CHECK (scope_type IN ('ORGANIZATION','AREA','BUILDING','CASHBOOK')),
  area_id         uuid,
  building_id     uuid,
  cashbook_id     uuid,
  UNIQUE (organization_id, id),
  FOREIGN KEY (organization_id, area_id)     REFERENCES public.areas(organization_id, id),
  FOREIGN KEY (organization_id, building_id) REFERENCES public.buildings(organization_id, id),
  FOREIGN KEY (organization_id, cashbook_id) REFERENCES public.accounts(organization_id, id),
  CHECK (
    (scope_type='ORGANIZATION' AND area_id IS NULL AND building_id IS NULL AND cashbook_id IS NULL)
    OR (scope_type='AREA' AND area_id IS NOT NULL AND building_id IS NULL AND cashbook_id IS NULL)
    OR (scope_type='BUILDING' AND building_id IS NOT NULL AND area_id IS NULL AND cashbook_id IS NULL)
    OR (scope_type='CASHBOOK' AND cashbook_id IS NOT NULL AND area_id IS NULL AND building_id IS NULL)
  )
);
-- Canonicalize: 1 ORGANIZATION scope/org; 1 scope/building; /area; /cashbook.
CREATE UNIQUE INDEX IF NOT EXISTS auth_scope_org_uidx      ON public.authorization_scopes (organization_id) WHERE scope_type='ORGANIZATION';
CREATE UNIQUE INDEX IF NOT EXISTS auth_scope_building_uidx ON public.authorization_scopes (organization_id, building_id) WHERE scope_type='BUILDING';
CREATE UNIQUE INDEX IF NOT EXISTS auth_scope_area_uidx     ON public.authorization_scopes (organization_id, area_id) WHERE scope_type='AREA';
CREATE UNIQUE INDEX IF NOT EXISTS auth_scope_cashbook_uidx ON public.authorization_scopes (organization_id, cashbook_id) WHERE scope_type='CASHBOOK';

CREATE TABLE IF NOT EXISTS public.role_binding_scopes (
  organization_id uuid NOT NULL,
  role_binding_id uuid NOT NULL,
  scope_id        uuid NOT NULL,
  PRIMARY KEY (role_binding_id, scope_id),
  FOREIGN KEY (organization_id, role_binding_id)
    REFERENCES public.role_bindings(organization_id, id) ON DELETE CASCADE,
  FOREIGN KEY (organization_id, scope_id)
    REFERENCES public.authorization_scopes(organization_id, id)
);

CREATE TABLE IF NOT EXISTS public.member_permission_overrides (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  membership_id   uuid NOT NULL,
  permission_key  text NOT NULL REFERENCES public.permission_definitions(key),
  effect          text NOT NULL CHECK (effect IN ('ALLOW','DENY')),
  reason          text NOT NULL DEFAULT 'legacy per-staff snapshot diff',
  expires_at      timestamptz,
  created_by      uuid,
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, id),
  FOREIGN KEY (organization_id, membership_id)
    REFERENCES public.organization_memberships(organization_id, id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS member_overrides_membership_idx ON public.member_permission_overrides (membership_id, permission_key);
-- Legacy per-staff perms là org-wide (nhất quán across assignments) ⇒ override
-- unscoped, tối đa 1/(membership,key). (Scoped override có thể thêm sau.)
CREATE UNIQUE INDEX IF NOT EXISTS member_overrides_unique_uidx
  ON public.member_permission_overrides (organization_id, membership_id, permission_key);

CREATE TABLE IF NOT EXISTS public.member_override_scopes (
  organization_id uuid NOT NULL,
  override_id     uuid NOT NULL,
  scope_id        uuid NOT NULL,
  PRIMARY KEY (override_id, scope_id),
  FOREIGN KEY (organization_id, override_id)
    REFERENCES public.member_permission_overrides(organization_id, id) ON DELETE CASCADE,
  FOREIGN KEY (organization_id, scope_id)
    REFERENCES public.authorization_scopes(organization_id, id)
);

-- RLS: chỉ super_admin đọc; không client DML (inert).
DO $rls$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'permission_definitions','organization_roles','role_permissions','role_bindings',
    'authorization_scopes','role_binding_scopes','member_permission_overrides','member_override_scopes'
  ] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS %I_select_super ON public.%I', t, t);
    EXECUTE format('CREATE POLICY %I_select_super ON public.%I FOR SELECT TO authenticated USING (public.is_super_admin())', t, t);
    EXECUTE format('REVOKE ALL ON public.%I FROM anon, authenticated', t);
    EXECUTE format('GRANT SELECT ON public.%I TO authenticated', t);
  END LOOP;
END $rls$;

COMMIT;
