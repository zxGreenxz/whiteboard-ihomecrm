-- Disposable permission-graph fixtures, never applied to production.
ALTER TABLE organization_memberships ADD COLUMN id uuid DEFAULT gen_random_uuid();
CREATE TABLE permission_definitions(key text,permission_domain text,is_active boolean,scope_kinds text[],requires_cashbook_possession boolean,accepted_possession_kinds text[]);
CREATE TABLE organization_roles(id uuid,organization_id uuid,name text,status text);
CREATE TABLE role_bindings(id uuid,organization_id uuid,membership_id uuid,role_id uuid,valid_from timestamptz,valid_to timestamptz);
CREATE TABLE role_permissions(organization_id uuid,role_id uuid,permission_key text,effect text);
CREATE TABLE authorization_scopes(id uuid,organization_id uuid,scope_type text,cashbook_id uuid);
CREATE TABLE role_binding_scopes(organization_id uuid,role_binding_id uuid,scope_id uuid);
CREATE TABLE member_permission_overrides(id uuid,membership_id uuid,permission_key text,effect text,revoked_at timestamptz,expires_at timestamptz);
CREATE TABLE member_override_scopes(override_id uuid,scope_id uuid);
CREATE TABLE cashbook_possession_bindings(membership_id uuid,cashbook_id uuid,possession_kind text,valid_from timestamptz,valid_to timestamptz);
CREATE TABLE app_private.tenant_emergency_denies(organization_id uuid,permission_key text,active_from timestamptz,expires_at timestamptz);
