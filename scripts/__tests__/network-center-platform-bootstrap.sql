-- Network Center disposable-database platform bootstrap.
--
-- WHY THIS FILE EXISTS
-- The repository's 499 historical migrations cannot be replayed from a blank
-- database: several pre-boundary files reference columns no migration in this
-- repository ever creates (for example `contracts.building_id`, read by
-- 016_meter_readings_enhancements.sql), one contains an outright SQL syntax
-- error (025_create_contract_files_bucket.sql's `COMMENT ON CONSTRAINT ... IS`
-- without an `ON <table>` clause) and two files create the same `roles` table
-- because numeric-prefixed and timestamp-prefixed names interleave badly under
-- lexicographic ordering. Production is unaffected: those migrations were
-- applied incrementally, in real time order, against a database that already
-- carried out-of-band changes.
--
-- So the disposable database does not replay history. It declares the platform
-- surface the Network Center migrations actually depend on -- proven by static
-- analysis of every `public.`/`app_private.`/`auth.` reference in
-- supabase/migrations/20260729*.sql that those migrations do not create
-- themselves -- and then applies the REAL, unmodified Network Center migration
-- files on top. Every security assertion therefore runs against shipped
-- migration source, not against a re-typed copy of it.
--
-- Table shapes below are a faithful subset: column names, types, nullability
-- and the constraints the Network Center migrations depend on are copied from
-- the shipped migrations. Columns no Network Center migration reads are
-- omitted deliberately, so this file stays reviewable.

-- ---------------------------------------------------------------------------
-- Supabase-compatible principals, schemas and extensions.
-- ---------------------------------------------------------------------------
CREATE ROLE anon NOLOGIN NOINHERIT;
CREATE ROLE authenticated NOLOGIN NOINHERIT;
CREATE ROLE service_role NOLOGIN NOINHERIT BYPASSRLS;

CREATE SCHEMA auth;
CREATE SCHEMA app_private;
CREATE SCHEMA extensions;

GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
GRANT USAGE ON SCHEMA extensions TO anon, authenticated, service_role;

CREATE EXTENSION pgcrypto WITH SCHEMA extensions;

-- Supabase ships this publication; the Network Center migrations add and drop
-- tables on it, so the object has to exist with no members.
CREATE PUBLICATION supabase_realtime;

-- ---------------------------------------------------------------------------
-- auth schema: only the surface the Network Center migrations touch.
-- ---------------------------------------------------------------------------
CREATE TABLE auth.users (
  id uuid PRIMARY KEY,
  aud varchar(255),
  role varchar(255),
  email varchar(255) UNIQUE,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

-- Mirrors Supabase's auth.uid(): the request-scoped subject claim, NULL when
-- the statement runs without one. The disposable harness sets the claim with
-- SET LOCAL so a single transaction can act as several tenants in turn.
CREATE FUNCTION auth.uid() RETURNS uuid
LANGUAGE sql
STABLE
AS $fn$
  SELECT nullif(
    current_setting('request.jwt.claim.sub', true), ''
  )::uuid
$fn$;

CREATE FUNCTION auth.role() RETURNS text
LANGUAGE sql
STABLE
AS $fn$
  SELECT coalesce(
    nullif(current_setting('request.jwt.claim.role', true), ''),
    'authenticated'
  )
$fn$;

GRANT USAGE ON SCHEMA auth TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION auth.uid() TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION auth.role() TO anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Tenancy tables (subset of 20260713* organization rollout).
-- ---------------------------------------------------------------------------
CREATE TABLE public.organizations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug text NOT NULL UNIQUE,
  name text NOT NULL,
  status text NOT NULL DEFAULT 'ACTIVE'
    CHECK (status IN ('ACTIVE', 'SUSPENDED', 'CLOSED')),
  is_demo boolean NOT NULL DEFAULT false,
  created_by uuid REFERENCES auth.users(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE public.organization_memberships (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id),
  user_id uuid NOT NULL REFERENCES auth.users(id),
  UNIQUE (organization_id, id),
  member_type text NOT NULL
    CHECK (member_type IN ('OWNER', 'STAFF', 'SHAREHOLDER', 'PARTNER', 'SERVICE')),
  status text NOT NULL DEFAULT 'ACTIVE'
    CHECK (status IN ('INVITED', 'ACTIVE', 'SUSPENDED', 'REVOKED')),
  valid_from timestamptz NOT NULL DEFAULT clock_timestamp(),
  valid_to timestamptz,
  activated_at timestamptz,
  revoked_at timestamptz,
  version bigint NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (organization_id, user_id)
);

CREATE TABLE public.buildings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid REFERENCES auth.users(id),
  organization_id uuid REFERENCES public.organizations(id),
  name text NOT NULL,
  code text,
  province text,
  district text,
  ward text,
  total_floors integer NOT NULL DEFAULT 1,
  total_rooms integer NOT NULL DEFAULT 0,
  is_virtual boolean NOT NULL DEFAULT false,
  deleted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (organization_id, id)
);

CREATE TABLE public.rooms (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid REFERENCES public.organizations(id),
  building_id uuid REFERENCES public.buildings(id),
  name text NOT NULL,
  deleted_at timestamptz
);

CREATE TABLE public.customers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid REFERENCES public.organizations(id),
  full_name text NOT NULL,
  phone text,
  deleted_at timestamptz
);

CREATE TABLE public.contracts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid REFERENCES public.organizations(id),
  room_id uuid REFERENCES public.rooms(id),
  status text NOT NULL DEFAULT 'ACTIVE',
  deleted_at timestamptz
);

-- ---------------------------------------------------------------------------
-- Authorization surface (subset of the 20260725* authz cutover).
-- ---------------------------------------------------------------------------
-- Shape copied from 20260713110000_sprint2a_rbac_schema.sql plus the four
-- columns later migrations added (scope_match_mode, requires_cashbook_
-- possession, accepted_possession_kinds, required_dimensions), because
-- 20260729010000 inserts all of them.
CREATE TABLE public.permission_definitions (
  key text PRIMARY KEY,
  resource text NOT NULL,
  action text NOT NULL,
  sensitivity text NOT NULL
    CHECK (sensitivity IN ('VIEW', 'MANAGE', 'ELEVATED', 'PLATFORM')),
  permission_domain text NOT NULL DEFAULT 'TENANT'
    CHECK (permission_domain IN ('TENANT', 'PLATFORM')),
  scope_kinds text[] NOT NULL DEFAULT ARRAY['ORGANIZATION']::text[],
  is_active boolean NOT NULL DEFAULT true,
  scope_match_mode text NOT NULL DEFAULT 'ANY_MATCH'
    CHECK (scope_match_mode IN ('ANY_MATCH', 'ALL_MATCH')),
  requires_cashbook_possession boolean NOT NULL DEFAULT false,
  accepted_possession_kinds text[] NOT NULL DEFAULT ARRAY[]::text[],
  required_dimensions text[] NOT NULL DEFAULT ARRAY[]::text[],
  UNIQUE (resource, action)
);

CREATE TABLE public.authorization_scopes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id),
  scope_type text NOT NULL
    CHECK (scope_type IN ('ORGANIZATION', 'AREA', 'BUILDING', 'CASHBOOK')),
  area_id uuid,
  building_id uuid,
  cashbook_id uuid,
  UNIQUE (organization_id, id),
  FOREIGN KEY (organization_id, building_id)
    REFERENCES public.buildings(organization_id, id),
  CHECK (
    (scope_type = 'ORGANIZATION' AND area_id IS NULL AND building_id IS NULL
      AND cashbook_id IS NULL)
    OR (scope_type = 'BUILDING' AND building_id IS NOT NULL AND area_id IS NULL
      AND cashbook_id IS NULL)
  )
);
CREATE UNIQUE INDEX auth_scope_org_uidx
  ON public.authorization_scopes (organization_id)
  WHERE scope_type = 'ORGANIZATION';
CREATE UNIQUE INDEX auth_scope_building_uidx
  ON public.authorization_scopes (organization_id, building_id)
  WHERE scope_type = 'BUILDING';

CREATE TABLE public.member_permission_overrides (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  membership_id uuid NOT NULL,
  permission_key text NOT NULL REFERENCES public.permission_definitions(key),
  effect text NOT NULL CHECK (effect IN ('ALLOW', 'DENY')),
  scope_mode text NOT NULL DEFAULT 'ORGANIZATION'
    CHECK (scope_mode IN ('ORGANIZATION', 'SCOPED')),
  reason text NOT NULL DEFAULT 'disposable network-center fixture',
  expires_at timestamptz,
  revoked_at timestamptz,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (organization_id, id),
  FOREIGN KEY (organization_id, membership_id)
    REFERENCES public.organization_memberships(organization_id, id)
    ON DELETE CASCADE
);
CREATE UNIQUE INDEX member_overrides_unique_uidx
  ON public.member_permission_overrides
     (organization_id, membership_id, permission_key);

CREATE TABLE public.member_override_scopes (
  organization_id uuid NOT NULL,
  override_id uuid NOT NULL,
  scope_id uuid NOT NULL,
  PRIMARY KEY (override_id, scope_id),
  FOREIGN KEY (organization_id, override_id)
    REFERENCES public.member_permission_overrides(organization_id, id)
    ON DELETE CASCADE,
  FOREIGN KEY (organization_id, scope_id)
    REFERENCES public.authorization_scopes(organization_id, id)
);

CREATE TABLE public.organization_roles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id),
  name text NOT NULL,
  is_system boolean NOT NULL DEFAULT false,
  version bigint NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (organization_id, id)
);
CREATE UNIQUE INDEX org_roles_org_name_lower_uidx
  ON public.organization_roles (organization_id, lower(name));

CREATE TABLE public.role_permissions (
  organization_id uuid NOT NULL,
  role_id uuid NOT NULL,
  permission_key text NOT NULL REFERENCES public.permission_definitions(key),
  effect text NOT NULL DEFAULT 'ALLOW' CHECK (effect IN ('ALLOW', 'DENY')),
  PRIMARY KEY (organization_id, role_id, permission_key),
  FOREIGN KEY (organization_id, role_id)
    REFERENCES public.organization_roles(organization_id, id) ON DELETE CASCADE
);

CREATE TABLE public.role_bindings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  membership_id uuid NOT NULL,
  role_id uuid NOT NULL,
  legacy_assignment_id uuid,
  valid_from timestamptz DEFAULT clock_timestamp(),
  valid_to timestamptz,
  version bigint NOT NULL DEFAULT 1,
  UNIQUE (organization_id, id),
  FOREIGN KEY (organization_id, membership_id)
    REFERENCES public.organization_memberships(organization_id, id)
    ON DELETE CASCADE,
  FOREIGN KEY (organization_id, role_id)
    REFERENCES public.organization_roles(organization_id, id) ON DELETE CASCADE,
  CHECK (valid_to IS NULL OR valid_from IS NULL OR valid_to > valid_from)
);
CREATE INDEX role_bindings_membership_idx
  ON public.role_bindings (membership_id, valid_to);

-- One place that answers "which permission keys does this signed-in principal
-- hold, and over which scopes", from both grant mechanisms production uses:
-- role bindings and per-member overrides. DENY from either mechanism wins,
-- matching app_private.authorized_scope_all_v3.
CREATE FUNCTION app_private.granted_scopes_v1(p_permission_key text)
RETURNS TABLE (organization_id uuid, org_wide boolean, building_id uuid)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'app_private', 'public'
AS $fn$
  WITH principal AS (
    SELECT membership.id AS membership_id, membership.organization_id
    FROM public.organization_memberships membership
    WHERE membership.user_id = (SELECT auth.uid())
      AND membership.status = 'ACTIVE'
      AND (membership.valid_to IS NULL
        OR membership.valid_to > clock_timestamp())
  ),
  active_definition AS (
    SELECT definition.key
    FROM public.permission_definitions definition
    WHERE definition.key = p_permission_key AND definition.is_active
  ),
  role_grants AS (
    SELECT
      principal.organization_id,
      permission.effect,
      true AS org_wide,
      NULL::uuid AS building_id
    FROM principal
    JOIN active_definition ON true
    JOIN public.role_bindings binding
      ON binding.organization_id = principal.organization_id
     AND binding.membership_id = principal.membership_id
     AND (binding.valid_from IS NULL
       OR binding.valid_from <= clock_timestamp())
     AND (binding.valid_to IS NULL OR binding.valid_to > clock_timestamp())
    JOIN public.role_permissions permission
      ON permission.organization_id = binding.organization_id
     AND permission.role_id = binding.role_id
     AND permission.permission_key = p_permission_key
  ),
  override_grants AS (
    SELECT
      principal.organization_id,
      override.effect,
      bool_or(scope.scope_type = 'ORGANIZATION' OR scope.id IS NULL)
        OVER (PARTITION BY override.id) AS org_wide,
      scope.building_id
    FROM principal
    JOIN active_definition ON true
    JOIN public.member_permission_overrides override
      ON override.organization_id = principal.organization_id
     AND override.membership_id = principal.membership_id
     AND override.permission_key = p_permission_key
     AND override.revoked_at IS NULL
     AND (override.expires_at IS NULL
       OR override.expires_at > clock_timestamp())
    LEFT JOIN public.member_override_scopes override_scope
      ON override_scope.override_id = override.id
    LEFT JOIN public.authorization_scopes scope
      ON scope.id = override_scope.scope_id
  ),
  combined AS (
    SELECT * FROM role_grants
    UNION ALL
    SELECT * FROM override_grants
  )
  SELECT combined.organization_id, combined.org_wide, combined.building_id
  FROM combined
  WHERE combined.effect = 'ALLOW'
    AND NOT EXISTS (
      SELECT 1 FROM combined denied
      WHERE denied.effect = 'DENY'
        AND denied.organization_id = combined.organization_id
    )
$fn$;

-- Faithful-subset authorization decision. The production chain is
-- can_do_on_building -> can_v3 -> authorized_scope_all_v3 -> override/scope
-- tables; this reproduces the observable contract that matters to Network
-- Center: an ACTIVE membership plus an active GRANT override whose scope is
-- either organization-wide or names this exact building, and never for a
-- deleted building or an inactive membership.
CREATE FUNCTION app_private.has_any_scope_v3(p_permission_key text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'app_private', 'public'
AS $fn$
  SELECT EXISTS (
    SELECT 1 FROM app_private.granted_scopes_v1(p_permission_key)
  )
$fn$;

CREATE FUNCTION public.can_do_on_building(
  _table text, _action text, _building_id uuid
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public', 'app_private'
AS $fn$
  SELECT EXISTS (
    SELECT 1
    FROM app_private.granted_scopes_v1(_table || '.' || _action) grant_row
    JOIN public.buildings building
      ON building.organization_id = grant_row.organization_id
     AND building.id = _building_id
     AND building.deleted_at IS NULL
    WHERE grant_row.org_wide
       OR grant_row.building_id = _building_id
  )
$fn$;

CREATE FUNCTION public.update_updated_at_column()
RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  NEW.updated_at := clock_timestamp();
  RETURN NEW;
END;
$fn$;

GRANT EXECUTE ON FUNCTION public.can_do_on_building(text, text, uuid)
  TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION app_private.has_any_scope_v3(text)
  TO authenticated, service_role;
