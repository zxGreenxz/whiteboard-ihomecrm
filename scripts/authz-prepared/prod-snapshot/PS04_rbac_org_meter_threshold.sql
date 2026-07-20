-- =====================================================================
-- PS04_rbac_org_meter_threshold.sql
--
-- SNAPSHOT sinh tu dong tu PROD ngay 2026-07-19 — KHONG SUA TAY.
-- Dung cho khoi phuc tham hoa (disaster recovery) / dung lai moi truong.
-- Nguon: catalog PROD (pg_proc / pg_trigger / pg_policies / pg_indexes /
--        pg_constraint / pg_attribute / pg_class.relacl).
-- Muon doi hanh vi: sua tren DB bang migration roi SINH LAI file nay.
--
-- ---------------------------------------------------------------------
-- DANH SACH DOI TUONG TRONG FILE  (tong 222 khoi)
-- ---------------------------------------------------------------------
--   14  CREATE TABLE           (muc 1)
--   57  ALTER TABLE ADD CONSTRAINT (muc 2)  -- da loai 2 constraint-trigger, xem muc 5
--   16  CREATE INDEX           (muc 3)
--   27  CREATE OR REPLACE FUNCTION (muc 4)
--   46  CREATE TRIGGER         (muc 5)
--   10  ENABLE ROW LEVEL SECURITY (muc 6)
--   10  CREATE POLICY          (muc 7)
--   41  khoi GRANT/REVOKE      (muc 8)  -- 14 bang + 27 ham
--    1  COMMENT ON             (muc 9)
--
-- (a) RBAC chuan hoa
--     bang: permission_definitions, organization_roles, role_permissions,
--           role_bindings, role_binding_scopes, member_permission_overrides,
--           member_override_scopes, authorization_scopes,
--           cashbook_possession_bindings
--     ham : app_private.authorize_tenant_action_v3, raise_malformed_override,
--           lock_org_for_decision_v1, bump_org_authorization_version,
--           assert_override_scope_shape, guard_tenant_role_permission_domain
-- (b) org integrity
--     bang: authorization_migration_exceptions
--     ham : public._autofill_org  (+ 29 trigger autofill dang gan tren 29 bang)
-- (c) meter
--     ham : approve_meter_reading_v1, bulk_approve_meter_readings_v1,
--           unapprove_meter_reading_v1, can_do_on_building (helper)
-- (d) nguong tu duyet
--     bang: app_private.ie_auto_approve_config
--     ham : get_ie_auto_approve_threshold_v1, set_ie_auto_approve_threshold_v1,
--           is_super_admin (helper)
-- (e) freeze / ownership IE
--     bang: app_private.income_expense_flow_ownership(+_events),
--           app_private.ie_transition_authorization
--     ham : guard_income_expense_owned_payload / _owned_items / _truncate,
--           is_income_expense_flow_owned, reject_income_expense_flow_mutation,
--           reject_income_expense_flow_truncate, current_uid_v1,
--           has_ie_claim_capability_v1, ie_lock_row_for_claim_v1,
--           ie_lock_operation_for_claim_v1,
--           claim_canonical_income_expense_draft_v1 (CA 2 OVERLOAD),
--           append_income_expense_event_v1
--     trigger: a00_ie_owned_payload_freeze, a00_ie_item_owned_payload_freeze,
--           a00_ie_truncate_freeze, a00_ie_item_truncate_freeze
--
-- ---------------------------------------------------------------------
-- KHONG NAM TRONG FILE NAY (phu thuoc — phai co TRUOC khi chay)
-- ---------------------------------------------------------------------
-- Cac bang nen cua he thong, file nay KHONG dung lai (thuoc snapshot khac):
--   public.organizations, public.organization_memberships, public.buildings,
--   public.accounts, public.areas, public.area_buildings, public.rooms,
--   public.contracts, public.customers, public.invoices, public.meters,
--   public.meter_readings, public.income_expenses, public.income_expense_items,
--   public.income_expense_audit_log,
--   app_private.tenant_emergency_denies, app_private.canonical_write_operations,
--   app_private.income_expense_audit_chain_heads
--   -> 17 khoa ngoai o muc 2 tro toi: organizations, organization_memberships,
--      buildings, accounts, areas, income_expenses. Thieu chung -> muc 2 BAO LOI
--      (co y: bao loi to hon la nuot lang).
-- 29 trigger autofill o muc 5 gan len cac bang nghiep vu khong do file nay tao;
--   bang nao chua ton tai thi CREATE TRIGGER do se loi.
-- Role Supabase (anon / authenticated / service_role) coi nhu da co san.
--   Rieng role ung dung `ie_canonical_writer` file nay TU TAO neu thieu (muc 0).
-- Ham legacy public.approve_meter_reading(uuid) / bulk_approve_meter_readings(uuid[])
--   CO tren prod nhung KHONG dump (ngoai pham vi — chi dump ban _v1 dang dung).
--
-- ---------------------------------------------------------------------
-- CACH CHAY LAI
-- ---------------------------------------------------------------------
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f PS04_rbac_org_meter_threshold.sql
-- Idempotent: chay lai nhieu lan khong loi (IF NOT EXISTS / OR REPLACE /
-- DROP ... IF EXISTS truoc CREATE). Chay SAU snapshot bang nen, TRUOC cac
-- snapshot phu thuoc engine duyet.
-- CHUAN HOA DUY NHAT so voi catalog: pg_get_triggerdef / pg_policies in ten ham
--   public khong kem schema (do search_path phien dump). File nay ep qualify
--   thanh public._autofill_org() / public.is_super_admin() de restore khong phu
--   thuoc search_path. Ngoai ra khong sua gi so voi ban goc tren PROD.
-- Sau khi chay: node scripts/check-view-invoker.mjs (an le security_invoker).
-- =====================================================================

\set ON_ERROR_STOP on

BEGIN;


-- =====================================================================
-- MUC 0 — SCHEMA + ROLE tien de
-- =====================================================================

CREATE SCHEMA IF NOT EXISTS app_private;

-- role ghi canonical cho bang so huu IE (khong login, chi duoc INSERT)
DO $ps04$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ie_canonical_writer') THEN
    CREATE ROLE ie_canonical_writer NOLOGIN NOINHERIT;
  END IF;
END $ps04$;


-- =====================================================================
-- MUC 1 — BANG (14)
-- =====================================================================

CREATE TABLE IF NOT EXISTS public.permission_definitions (
  key text NOT NULL,
  resource text NOT NULL,
  action text NOT NULL,
  sensitivity text NOT NULL,
  permission_domain text DEFAULT 'TENANT'::text NOT NULL,
  scope_kinds text[] DEFAULT ARRAY['ORGANIZATION'::text] NOT NULL,
  is_active boolean DEFAULT true NOT NULL,
  scope_match_mode text DEFAULT 'ANY_MATCH'::text NOT NULL,
  requires_cashbook_possession boolean DEFAULT false NOT NULL,
  accepted_possession_kinds text[] DEFAULT ARRAY[]::text[] NOT NULL,
  required_dimensions text[] DEFAULT ARRAY[]::text[] NOT NULL
);

CREATE TABLE IF NOT EXISTS public.organization_roles (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  organization_id uuid NOT NULL,
  name text NOT NULL,
  is_system boolean DEFAULT false NOT NULL,
  legacy_role_id uuid,
  version bigint DEFAULT 1 NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  system_key text,
  status text DEFAULT 'ACTIVE'::text NOT NULL
);

CREATE TABLE IF NOT EXISTS public.role_permissions (
  organization_id uuid NOT NULL,
  role_id uuid NOT NULL,
  permission_key text NOT NULL,
  effect text DEFAULT 'ALLOW'::text NOT NULL
);

CREATE TABLE IF NOT EXISTS public.role_bindings (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  organization_id uuid NOT NULL,
  membership_id uuid NOT NULL,
  role_id uuid NOT NULL,
  legacy_assignment_id uuid,
  valid_from timestamp with time zone DEFAULT now(),
  valid_to timestamp with time zone,
  version bigint DEFAULT 1 NOT NULL
);

CREATE TABLE IF NOT EXISTS public.role_binding_scopes (
  organization_id uuid NOT NULL,
  role_binding_id uuid NOT NULL,
  scope_id uuid NOT NULL
);

CREATE TABLE IF NOT EXISTS public.member_permission_overrides (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  organization_id uuid NOT NULL,
  membership_id uuid NOT NULL,
  permission_key text NOT NULL,
  effect text NOT NULL,
  reason text DEFAULT 'legacy per-staff snapshot diff'::text NOT NULL,
  expires_at timestamp with time zone,
  created_by uuid,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  scope_mode text DEFAULT 'ORGANIZATION'::text NOT NULL,
  revoked_at timestamp with time zone
);

CREATE TABLE IF NOT EXISTS public.member_override_scopes (
  organization_id uuid NOT NULL,
  override_id uuid NOT NULL,
  scope_id uuid NOT NULL
);

CREATE TABLE IF NOT EXISTS public.authorization_scopes (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  organization_id uuid NOT NULL,
  scope_type text NOT NULL,
  area_id uuid,
  building_id uuid,
  cashbook_id uuid
);

CREATE TABLE IF NOT EXISTS public.cashbook_possession_bindings (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  organization_id uuid NOT NULL,
  cashbook_id uuid NOT NULL,
  membership_id uuid NOT NULL,
  possession_kind text NOT NULL,
  valid_from timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
  valid_to timestamp with time zone,
  version bigint DEFAULT 1 NOT NULL,
  granted_by uuid,
  reason text,
  created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL
);

CREATE TABLE IF NOT EXISTS public.authorization_migration_exceptions (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  table_name text NOT NULL,
  row_id uuid,
  reason text NOT NULL,
  details jsonb,
  resolved boolean DEFAULT false NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  row_key jsonb
);

CREATE TABLE IF NOT EXISTS app_private.ie_auto_approve_config (
  organization_id uuid NOT NULL,
  threshold numeric(15,2),
  updated_by uuid,
  updated_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS app_private.income_expense_flow_ownership (
  income_expense_id uuid NOT NULL,
  organization_id uuid NOT NULL,
  flow_kind text DEFAULT 'CANONICAL_INCOME_EXPENSE'::text NOT NULL,
  flow_version smallint DEFAULT 1 NOT NULL,
  lifecycle_owner text DEFAULT 'APPROVAL_ENGINE_V2'::text NOT NULL,
  lifecycle_state text DEFAULT 'DRAFT'::text NOT NULL,
  writer_operation text NOT NULL,
  payload_hash_scheme text DEFAULT 'PG_MD5_JSONB_TEXT_V1'::text NOT NULL,
  payload_hash_value text NOT NULL,
  maker_user_id uuid NOT NULL,
  claimed_by_user_id uuid NOT NULL,
  correlation_id uuid,
  claimed_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL
);

CREATE TABLE IF NOT EXISTS app_private.income_expense_flow_ownership_events (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  organization_id uuid NOT NULL,
  income_expense_id uuid NOT NULL,
  event_type text NOT NULL,
  actor_user_id uuid NOT NULL,
  detail jsonb DEFAULT '{}'::jsonb NOT NULL,
  created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL
);

CREATE TABLE IF NOT EXISTS app_private.ie_transition_authorization (
  income_expense_id uuid NOT NULL,
  xid xid8 NOT NULL,
  purpose text NOT NULL,
  granted_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL
);


-- =====================================================================
-- MUC 2 — CONSTRAINT (57)  [PK -> UNIQUE -> CHECK -> FK]
-- Bao boc DO/EXCEPTION de chay lai khong loi trung ten.
-- =====================================================================

DO $ps04$ BEGIN
  ALTER TABLE app_private.ie_auto_approve_config ADD CONSTRAINT ie_auto_approve_config_pkey PRIMARY KEY (organization_id);
EXCEPTION WHEN duplicate_table OR duplicate_object THEN NULL;
END $ps04$;

DO $ps04$ BEGIN
  ALTER TABLE app_private.ie_auto_approve_config ADD CONSTRAINT ie_auto_approve_config_threshold_check CHECK (((threshold IS NULL) OR (threshold > (0)::numeric)));
EXCEPTION WHEN duplicate_table OR duplicate_object THEN NULL;
END $ps04$;

DO $ps04$ BEGIN
  ALTER TABLE app_private.ie_transition_authorization ADD CONSTRAINT ie_transition_authorization_pkey PRIMARY KEY (income_expense_id);
EXCEPTION WHEN duplicate_table OR duplicate_object THEN NULL;
END $ps04$;

DO $ps04$ BEGIN
  ALTER TABLE app_private.income_expense_flow_ownership ADD CONSTRAINT income_expense_flow_ownership_pkey PRIMARY KEY (income_expense_id);
EXCEPTION WHEN duplicate_table OR duplicate_object THEN NULL;
END $ps04$;

DO $ps04$ BEGIN
  ALTER TABLE app_private.income_expense_flow_ownership ADD CONSTRAINT income_expense_flow_ownership_organization_id_income_expens_key UNIQUE (organization_id, income_expense_id);
EXCEPTION WHEN duplicate_table OR duplicate_object THEN NULL;
END $ps04$;

DO $ps04$ BEGIN
  ALTER TABLE app_private.income_expense_flow_ownership ADD CONSTRAINT income_expense_flow_ownership_payload_hash_scheme_check CHECK ((payload_hash_scheme = 'PG_MD5_JSONB_TEXT_V1'::text));
EXCEPTION WHEN duplicate_table OR duplicate_object THEN NULL;
END $ps04$;

DO $ps04$ BEGIN
  ALTER TABLE app_private.income_expense_flow_ownership ADD CONSTRAINT income_expense_flow_ownership_payload_hash_value_check CHECK ((payload_hash_value ~ '^[0-9a-f]{32}$'::text));
EXCEPTION WHEN duplicate_table OR duplicate_object THEN NULL;
END $ps04$;

DO $ps04$ BEGIN
  ALTER TABLE app_private.income_expense_flow_ownership ADD CONSTRAINT income_expense_flow_ownership_organization_id_income_expen_fkey FOREIGN KEY (organization_id, income_expense_id) REFERENCES income_expenses(organization_id, id) ON DELETE RESTRICT;
EXCEPTION WHEN duplicate_table OR duplicate_object THEN NULL;
END $ps04$;

DO $ps04$ BEGIN
  ALTER TABLE app_private.income_expense_flow_ownership_events ADD CONSTRAINT income_expense_flow_ownership_events_pkey PRIMARY KEY (id);
EXCEPTION WHEN duplicate_table OR duplicate_object THEN NULL;
END $ps04$;

DO $ps04$ BEGIN
  ALTER TABLE app_private.income_expense_flow_ownership_events ADD CONSTRAINT income_expense_flow_ownership_events_event_type_check CHECK ((event_type = 'FLOW_CLAIMED'::text));
EXCEPTION WHEN duplicate_table OR duplicate_object THEN NULL;
END $ps04$;

DO $ps04$ BEGIN
  ALTER TABLE public.authorization_migration_exceptions ADD CONSTRAINT authorization_migration_exceptions_pkey PRIMARY KEY (id);
EXCEPTION WHEN duplicate_table OR duplicate_object THEN NULL;
END $ps04$;

DO $ps04$ BEGIN
  ALTER TABLE public.authorization_scopes ADD CONSTRAINT authorization_scopes_pkey PRIMARY KEY (id);
EXCEPTION WHEN duplicate_table OR duplicate_object THEN NULL;
END $ps04$;

DO $ps04$ BEGIN
  ALTER TABLE public.authorization_scopes ADD CONSTRAINT authorization_scopes_organization_id_id_key UNIQUE (organization_id, id);
EXCEPTION WHEN duplicate_table OR duplicate_object THEN NULL;
END $ps04$;

DO $ps04$ BEGIN
  ALTER TABLE public.authorization_scopes ADD CONSTRAINT authorization_scopes_check CHECK ((((scope_type = 'ORGANIZATION'::text) AND (area_id IS NULL) AND (building_id IS NULL) AND (cashbook_id IS NULL)) OR ((scope_type = 'AREA'::text) AND (area_id IS NOT NULL) AND (building_id IS NULL) AND (cashbook_id IS NULL)) OR ((scope_type = 'BUILDING'::text) AND (building_id IS NOT NULL) AND (area_id IS NULL) AND (cashbook_id IS NULL)) OR ((scope_type = 'CASHBOOK'::text) AND (cashbook_id IS NOT NULL) AND (area_id IS NULL) AND (building_id IS NULL))));
EXCEPTION WHEN duplicate_table OR duplicate_object THEN NULL;
END $ps04$;

DO $ps04$ BEGIN
  ALTER TABLE public.authorization_scopes ADD CONSTRAINT authorization_scopes_scope_type_check CHECK ((scope_type = ANY (ARRAY['ORGANIZATION'::text, 'AREA'::text, 'BUILDING'::text, 'CASHBOOK'::text])));
EXCEPTION WHEN duplicate_table OR duplicate_object THEN NULL;
END $ps04$;

DO $ps04$ BEGIN
  ALTER TABLE public.authorization_scopes ADD CONSTRAINT authorization_scopes_organization_id_area_id_fkey FOREIGN KEY (organization_id, area_id) REFERENCES areas(organization_id, id);
EXCEPTION WHEN duplicate_table OR duplicate_object THEN NULL;
END $ps04$;

DO $ps04$ BEGIN
  ALTER TABLE public.authorization_scopes ADD CONSTRAINT authorization_scopes_organization_id_building_id_fkey FOREIGN KEY (organization_id, building_id) REFERENCES buildings(organization_id, id);
EXCEPTION WHEN duplicate_table OR duplicate_object THEN NULL;
END $ps04$;

DO $ps04$ BEGIN
  ALTER TABLE public.authorization_scopes ADD CONSTRAINT authorization_scopes_organization_id_cashbook_id_fkey FOREIGN KEY (organization_id, cashbook_id) REFERENCES accounts(organization_id, id);
EXCEPTION WHEN duplicate_table OR duplicate_object THEN NULL;
END $ps04$;

DO $ps04$ BEGIN
  ALTER TABLE public.cashbook_possession_bindings ADD CONSTRAINT cashbook_possession_bindings_pkey PRIMARY KEY (id);
EXCEPTION WHEN duplicate_table OR duplicate_object THEN NULL;
END $ps04$;

DO $ps04$ BEGIN
  ALTER TABLE public.cashbook_possession_bindings ADD CONSTRAINT cashbook_possession_bindings_check CHECK (((valid_to IS NULL) OR (valid_to > valid_from)));
EXCEPTION WHEN duplicate_table OR duplicate_object THEN NULL;
END $ps04$;

DO $ps04$ BEGIN
  ALTER TABLE public.cashbook_possession_bindings ADD CONSTRAINT cashbook_possession_bindings_possession_kind_check CHECK ((possession_kind = ANY (ARRAY['CUSTODIAN'::text, 'OPERATOR'::text])));
EXCEPTION WHEN duplicate_table OR duplicate_object THEN NULL;
END $ps04$;

DO $ps04$ BEGIN
  ALTER TABLE public.cashbook_possession_bindings ADD CONSTRAINT cashbook_possession_bindings_organization_id_cashbook_id_fkey FOREIGN KEY (organization_id, cashbook_id) REFERENCES accounts(organization_id, id) ON DELETE RESTRICT;
EXCEPTION WHEN duplicate_table OR duplicate_object THEN NULL;
END $ps04$;

DO $ps04$ BEGIN
  ALTER TABLE public.cashbook_possession_bindings ADD CONSTRAINT cashbook_possession_bindings_organization_id_membership_id_fkey FOREIGN KEY (organization_id, membership_id) REFERENCES organization_memberships(organization_id, id) ON DELETE RESTRICT;
EXCEPTION WHEN duplicate_table OR duplicate_object THEN NULL;
END $ps04$;

DO $ps04$ BEGIN
  ALTER TABLE public.member_override_scopes ADD CONSTRAINT member_override_scopes_pkey PRIMARY KEY (override_id, scope_id);
EXCEPTION WHEN duplicate_table OR duplicate_object THEN NULL;
END $ps04$;

DO $ps04$ BEGIN
  ALTER TABLE public.member_override_scopes ADD CONSTRAINT member_override_scopes_organization_id_override_id_fkey FOREIGN KEY (organization_id, override_id) REFERENCES member_permission_overrides(organization_id, id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_table OR duplicate_object THEN NULL;
END $ps04$;

DO $ps04$ BEGIN
  ALTER TABLE public.member_override_scopes ADD CONSTRAINT member_override_scopes_organization_id_scope_id_fkey FOREIGN KEY (organization_id, scope_id) REFERENCES authorization_scopes(organization_id, id);
EXCEPTION WHEN duplicate_table OR duplicate_object THEN NULL;
END $ps04$;

DO $ps04$ BEGIN
  ALTER TABLE public.member_permission_overrides ADD CONSTRAINT member_permission_overrides_pkey PRIMARY KEY (id);
EXCEPTION WHEN duplicate_table OR duplicate_object THEN NULL;
END $ps04$;

DO $ps04$ BEGIN
  ALTER TABLE public.member_permission_overrides ADD CONSTRAINT member_permission_overrides_organization_id_id_key UNIQUE (organization_id, id);
EXCEPTION WHEN duplicate_table OR duplicate_object THEN NULL;
END $ps04$;

DO $ps04$ BEGIN
  ALTER TABLE public.member_permission_overrides ADD CONSTRAINT member_permission_overrides_effect_check CHECK ((effect = ANY (ARRAY['ALLOW'::text, 'DENY'::text])));
EXCEPTION WHEN duplicate_table OR duplicate_object THEN NULL;
END $ps04$;

DO $ps04$ BEGIN
  ALTER TABLE public.member_permission_overrides ADD CONSTRAINT member_permission_overrides_revoked_after_created_check CHECK (((revoked_at IS NULL) OR (revoked_at >= created_at)));
EXCEPTION WHEN duplicate_table OR duplicate_object THEN NULL;
END $ps04$;

DO $ps04$ BEGIN
  ALTER TABLE public.member_permission_overrides ADD CONSTRAINT member_permission_overrides_scope_mode_check CHECK ((scope_mode = ANY (ARRAY['ORGANIZATION'::text, 'SCOPED'::text])));
EXCEPTION WHEN duplicate_table OR duplicate_object THEN NULL;
END $ps04$;

DO $ps04$ BEGIN
  ALTER TABLE public.member_permission_overrides ADD CONSTRAINT member_permission_overrides_organization_id_membership_id_fkey FOREIGN KEY (organization_id, membership_id) REFERENCES organization_memberships(organization_id, id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_table OR duplicate_object THEN NULL;
END $ps04$;

DO $ps04$ BEGIN
  ALTER TABLE public.member_permission_overrides ADD CONSTRAINT member_permission_overrides_permission_key_fkey FOREIGN KEY (permission_key) REFERENCES permission_definitions(key);
EXCEPTION WHEN duplicate_table OR duplicate_object THEN NULL;
END $ps04$;

DO $ps04$ BEGIN
  ALTER TABLE public.organization_roles ADD CONSTRAINT organization_roles_pkey PRIMARY KEY (id);
EXCEPTION WHEN duplicate_table OR duplicate_object THEN NULL;
END $ps04$;

DO $ps04$ BEGIN
  ALTER TABLE public.organization_roles ADD CONSTRAINT organization_roles_organization_id_id_key UNIQUE (organization_id, id);
EXCEPTION WHEN duplicate_table OR duplicate_object THEN NULL;
END $ps04$;

DO $ps04$ BEGIN
  ALTER TABLE public.organization_roles ADD CONSTRAINT organization_roles_status_check CHECK ((status = ANY (ARRAY['ACTIVE'::text, 'RETIRED'::text])));
EXCEPTION WHEN duplicate_table OR duplicate_object THEN NULL;
END $ps04$;

DO $ps04$ BEGIN
  ALTER TABLE public.organization_roles ADD CONSTRAINT organization_roles_system_key_check CHECK (((system_key IS NULL) OR (is_system AND (system_key ~ '^[A-Z][A-Z0-9_]{2,63}$'::text))));
EXCEPTION WHEN duplicate_table OR duplicate_object THEN NULL;
END $ps04$;

DO $ps04$ BEGIN
  ALTER TABLE public.organization_roles ADD CONSTRAINT organization_roles_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE RESTRICT;
EXCEPTION WHEN duplicate_table OR duplicate_object THEN NULL;
END $ps04$;

DO $ps04$ BEGIN
  ALTER TABLE public.permission_definitions ADD CONSTRAINT permission_definitions_pkey PRIMARY KEY (key);
EXCEPTION WHEN duplicate_table OR duplicate_object THEN NULL;
END $ps04$;

DO $ps04$ BEGIN
  ALTER TABLE public.permission_definitions ADD CONSTRAINT permission_definitions_resource_action_key UNIQUE (resource, action);
EXCEPTION WHEN duplicate_table OR duplicate_object THEN NULL;
END $ps04$;

DO $ps04$ BEGIN
  ALTER TABLE public.permission_definitions ADD CONSTRAINT permission_definitions_permission_domain_check CHECK ((permission_domain = ANY (ARRAY['TENANT'::text, 'PLATFORM'::text])));
EXCEPTION WHEN duplicate_table OR duplicate_object THEN NULL;
END $ps04$;

DO $ps04$ BEGIN
  ALTER TABLE public.permission_definitions ADD CONSTRAINT permission_definitions_possession_contract_check CHECK ((((NOT requires_cashbook_possession) AND (cardinality(accepted_possession_kinds) = 0)) OR (requires_cashbook_possession AND ('CASHBOOK'::text = ANY (scope_kinds)) AND (cardinality(accepted_possession_kinds) > 0) AND (accepted_possession_kinds <@ ARRAY['CUSTODIAN'::text, 'OPERATOR'::text]))));
EXCEPTION WHEN duplicate_table OR duplicate_object THEN NULL;
END $ps04$;

DO $ps04$ BEGIN
  ALTER TABLE public.permission_definitions ADD CONSTRAINT permission_definitions_required_dimensions_check CHECK ((required_dimensions <@ ARRAY['BUILDING'::text, 'CASHBOOK'::text]));
EXCEPTION WHEN duplicate_table OR duplicate_object THEN NULL;
END $ps04$;

DO $ps04$ BEGIN
  ALTER TABLE public.permission_definitions ADD CONSTRAINT permission_definitions_scope_match_mode_check CHECK ((scope_match_mode = 'ANY_MATCH'::text));
EXCEPTION WHEN duplicate_table OR duplicate_object THEN NULL;
END $ps04$;

DO $ps04$ BEGIN
  ALTER TABLE public.permission_definitions ADD CONSTRAINT permission_definitions_sensitivity_check CHECK ((sensitivity = ANY (ARRAY['VIEW'::text, 'MANAGE'::text, 'ELEVATED'::text, 'PLATFORM'::text])));
EXCEPTION WHEN duplicate_table OR duplicate_object THEN NULL;
END $ps04$;

DO $ps04$ BEGIN
  ALTER TABLE public.role_binding_scopes ADD CONSTRAINT role_binding_scopes_pkey PRIMARY KEY (role_binding_id, scope_id);
EXCEPTION WHEN duplicate_table OR duplicate_object THEN NULL;
END $ps04$;

DO $ps04$ BEGIN
  ALTER TABLE public.role_binding_scopes ADD CONSTRAINT role_binding_scopes_organization_id_role_binding_id_fkey FOREIGN KEY (organization_id, role_binding_id) REFERENCES role_bindings(organization_id, id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_table OR duplicate_object THEN NULL;
END $ps04$;

DO $ps04$ BEGIN
  ALTER TABLE public.role_binding_scopes ADD CONSTRAINT role_binding_scopes_organization_id_scope_id_fkey FOREIGN KEY (organization_id, scope_id) REFERENCES authorization_scopes(organization_id, id);
EXCEPTION WHEN duplicate_table OR duplicate_object THEN NULL;
END $ps04$;

DO $ps04$ BEGIN
  ALTER TABLE public.role_bindings ADD CONSTRAINT role_bindings_pkey PRIMARY KEY (id);
EXCEPTION WHEN duplicate_table OR duplicate_object THEN NULL;
END $ps04$;

DO $ps04$ BEGIN
  ALTER TABLE public.role_bindings ADD CONSTRAINT role_bindings_organization_id_id_key UNIQUE (organization_id, id);
EXCEPTION WHEN duplicate_table OR duplicate_object THEN NULL;
END $ps04$;

DO $ps04$ BEGIN
  ALTER TABLE public.role_bindings ADD CONSTRAINT role_bindings_check CHECK (((valid_to IS NULL) OR (valid_from IS NULL) OR (valid_to > valid_from)));
EXCEPTION WHEN duplicate_table OR duplicate_object THEN NULL;
END $ps04$;

DO $ps04$ BEGIN
  ALTER TABLE public.role_bindings ADD CONSTRAINT role_bindings_organization_id_membership_id_fkey FOREIGN KEY (organization_id, membership_id) REFERENCES organization_memberships(organization_id, id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_table OR duplicate_object THEN NULL;
END $ps04$;

DO $ps04$ BEGIN
  ALTER TABLE public.role_bindings ADD CONSTRAINT role_bindings_organization_id_role_id_fkey FOREIGN KEY (organization_id, role_id) REFERENCES organization_roles(organization_id, id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_table OR duplicate_object THEN NULL;
END $ps04$;

DO $ps04$ BEGIN
  ALTER TABLE public.role_permissions ADD CONSTRAINT role_permissions_pkey PRIMARY KEY (organization_id, role_id, permission_key);
EXCEPTION WHEN duplicate_table OR duplicate_object THEN NULL;
END $ps04$;

DO $ps04$ BEGIN
  ALTER TABLE public.role_permissions ADD CONSTRAINT role_permissions_effect_check CHECK ((effect = ANY (ARRAY['ALLOW'::text, 'DENY'::text])));
EXCEPTION WHEN duplicate_table OR duplicate_object THEN NULL;
END $ps04$;

DO $ps04$ BEGIN
  ALTER TABLE public.role_permissions ADD CONSTRAINT role_permissions_organization_id_role_id_fkey FOREIGN KEY (organization_id, role_id) REFERENCES organization_roles(organization_id, id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_table OR duplicate_object THEN NULL;
END $ps04$;

DO $ps04$ BEGIN
  ALTER TABLE public.role_permissions ADD CONSTRAINT role_permissions_permission_key_fkey FOREIGN KEY (permission_key) REFERENCES permission_definitions(key);
EXCEPTION WHEN duplicate_table OR duplicate_object THEN NULL;
END $ps04$;


-- =====================================================================
-- MUC 3 — INDEX (16)  [khong ke index do PK/UNIQUE sinh ra o muc 2]
-- =====================================================================

CREATE INDEX IF NOT EXISTS ie_flow_ownership_events_voucher_idx ON app_private.income_expense_flow_ownership_events USING btree (organization_id, income_expense_id);

CREATE UNIQUE INDEX IF NOT EXISTS authorization_migration_exceptions_open_rowid_uq ON public.authorization_migration_exceptions USING btree (table_name, row_id) WHERE ((resolved = false) AND (row_id IS NOT NULL));

CREATE UNIQUE INDEX IF NOT EXISTS authorization_migration_exceptions_open_rowkey_uq ON public.authorization_migration_exceptions USING btree (table_name, row_key) WHERE ((resolved = false) AND (row_key IS NOT NULL));

CREATE UNIQUE INDEX IF NOT EXISTS auth_scope_area_uidx ON public.authorization_scopes USING btree (organization_id, area_id) WHERE (scope_type = 'AREA'::text);

CREATE UNIQUE INDEX IF NOT EXISTS auth_scope_building_uidx ON public.authorization_scopes USING btree (organization_id, building_id) WHERE (scope_type = 'BUILDING'::text);

CREATE UNIQUE INDEX IF NOT EXISTS auth_scope_cashbook_uidx ON public.authorization_scopes USING btree (organization_id, cashbook_id) WHERE (scope_type = 'CASHBOOK'::text);

CREATE UNIQUE INDEX IF NOT EXISTS auth_scope_org_uidx ON public.authorization_scopes USING btree (organization_id) WHERE (scope_type = 'ORGANIZATION'::text);

CREATE UNIQUE INDEX IF NOT EXISTS cashbook_possession_one_open_kind_uidx ON public.cashbook_possession_bindings USING btree (organization_id, cashbook_id, membership_id, possession_kind) WHERE (valid_to IS NULL);

CREATE INDEX IF NOT EXISTS cashbook_possession_resolver_idx ON public.cashbook_possession_bindings USING btree (organization_id, membership_id, cashbook_id, valid_from, valid_to);

CREATE INDEX IF NOT EXISTS member_overrides_membership_idx ON public.member_permission_overrides USING btree (membership_id, permission_key);

CREATE UNIQUE INDEX IF NOT EXISTS member_overrides_open_uidx ON public.member_permission_overrides USING btree (organization_id, membership_id, permission_key, effect, scope_mode) WHERE (revoked_at IS NULL);

CREATE UNIQUE INDEX IF NOT EXISTS org_roles_org_name_lower_uidx ON public.organization_roles USING btree (organization_id, lower(name));

CREATE UNIQUE INDEX IF NOT EXISTS organization_roles_system_key_uidx ON public.organization_roles USING btree (organization_id, system_key) WHERE (system_key IS NOT NULL);

CREATE INDEX IF NOT EXISTS role_bindings_membership_idx ON public.role_bindings USING btree (membership_id, valid_to);

CREATE UNIQUE INDEX IF NOT EXISTS role_bindings_one_open_canonical_role_uidx ON public.role_bindings USING btree (organization_id, membership_id, role_id) WHERE ((legacy_assignment_id IS NULL) AND (valid_to IS NULL));

CREATE INDEX IF NOT EXISTS role_bindings_role_idx ON public.role_bindings USING btree (role_id, valid_to);


-- =====================================================================
-- MUC 4 — HAM (27)
-- =====================================================================


-- ---------------------------------------------------------------------
-- (a) RBAC chuan hoa — engine v3 + bang phan quyen
-- ---------------------------------------------------------------------

-- app_private.authorize_tenant_action_v3(uuid,uuid,text,uuid,uuid) -- engine quyet dinh RBAC v3
CREATE OR REPLACE FUNCTION app_private.authorize_tenant_action_v3(p_actor uuid, p_organization_id uuid, p_permission_key text, p_building_id uuid DEFAULT NULL::uuid, p_cashbook_id uuid DEFAULT NULL::uuid)
 RETURNS TABLE(allowed boolean, authorization_version bigint, nearest_deadline timestamp with time zone, evaluated_at timestamp with time zone, decision_reason text)
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'app_private', 'public'
AS $function$

with

at as materialized (

  select clock_timestamp() as evaluated_at

),

-- Caller contract: app_private.lock_org_for_decision_v1() was called in a

-- PRIOR statement of this transaction. The FOR SHARE here is then a no-wait

-- re-entrant lock and this statement's snapshot postdates the lock wait.

locked_org as materialized (

  select o.id, o.authorization_version

    from public.organizations o

   where o.id = p_organization_id

     and o.status = 'ACTIVE'

   for share

),

permission as materialized (

  select pd.*

    from public.permission_definitions pd

    join locked_org lo on true

   where pd.key = p_permission_key

     and pd.permission_domain = 'TENANT'

     and pd.is_active

),

-- Fix #4: required dimensions must be supplied.

dimensions as materialized (

  select

    not exists (

      select 1 from permission pd

       where ('BUILDING' = any(pd.required_dimensions) and p_building_id is null)

          or ('CASHBOOK' = any(pd.required_dimensions) and p_cashbook_id is null)

    ) as satisfied

),

membership as materialized (

  select m.*

    from public.organization_memberships m

    join locked_org lo on lo.id = m.organization_id

    cross join at

   where m.user_id = p_actor

     and m.status = 'ACTIVE'

     and coalesce(m.valid_from, '-infinity') <= at.evaluated_at

     and (m.valid_to is null or m.valid_to > at.evaluated_at)

),

target as materialized (

  select

    (p_building_id is null or exists (

       select 1 from public.buildings b

        where b.id = p_building_id and b.organization_id = p_organization_id))

    and

    (p_cashbook_id is null or exists (

       select 1 from public.accounts a

        where a.id = p_cashbook_id and a.organization_id = p_organization_id

          and a.deleted_at is null)) as valid

),

-- Open member overrides for this key: malformed (zero-edge) witnesses raise.

member_overrides as materialized (

  select o.id, o.effect, o.scope_mode, o.expires_at

    from membership m

    join public.member_permission_overrides o

      on o.organization_id = m.organization_id

     and o.membership_id = m.id

     and o.permission_key = p_permission_key

    cross join at

   where o.revoked_at is null

     and (o.expires_at is null or o.expires_at > at.evaluated_at)

),

malformed_guard as materialized (

  select case when exists (

    select 1 from member_overrides mo

     where not exists (

       select 1 from public.member_override_scopes mos

        where mos.organization_id = p_organization_id

          and mos.override_id = mo.id)

  ) then app_private.raise_malformed_override(p_organization_id, p_permission_key)

  else 0 end as ok

),

-- Scope edges of member overrides.

member_edges as materialized (

  select mo.id, mo.effect, mo.scope_mode, s.scope_type,

         s.building_id, s.cashbook_id, s.area_id

    from member_overrides mo

    join public.member_override_scopes mos

      on mos.organization_id = p_organization_id and mos.override_id = mo.id

    join public.authorization_scopes s

      on s.organization_id = p_organization_id and s.id = mos.scope_id

),

-- Role statements: bindings valid now (NULL valid_from = always active, fix #5)

role_edges as materialized (

  select rp.effect, s.scope_type, s.building_id, s.cashbook_id, s.area_id

    from membership m

    join public.role_bindings rb

      on rb.organization_id = m.organization_id and rb.membership_id = m.id

    join public.organization_roles r

      on r.organization_id = rb.organization_id and r.id = rb.role_id

     and coalesce(r.status, 'ACTIVE') = 'ACTIVE'

    join public.role_permissions rp

      on rp.organization_id = rb.organization_id

     and rp.role_id = rb.role_id

     and rp.permission_key = p_permission_key

    join public.role_binding_scopes rbs

      on rbs.organization_id = rb.organization_id and rbs.role_binding_id = rb.id

    join public.authorization_scopes s

      on s.organization_id = rbs.organization_id and s.id = rbs.scope_id

    cross join at

   where coalesce(rb.valid_from, '-infinity') <= at.evaluated_at

     and (rb.valid_to is null or rb.valid_to > at.evaluated_at)

),

-- Fix #2: DENY matches any scope COVERING the target (broad).

-- A scope covers the target when:

--   ORGANIZATION: always

--   BUILDING: p_building_id matches

--   AREA: p_building_id inside the area

--   CASHBOOK: p_cashbook_id matches

scope_cover as materialized (

  select

    exists (

      select 1 from member_edges e

       where e.effect = 'DENY' and (

         e.scope_type = 'ORGANIZATION'

         or (e.scope_type = 'BUILDING' and e.building_id = p_building_id)

         or (e.scope_type = 'CASHBOOK' and e.cashbook_id = p_cashbook_id)

         or (e.scope_type = 'AREA' and p_building_id is not null and exists (

              select 1 from public.area_buildings ab

               where ab.organization_id = p_organization_id

                 and ab.area_id = e.area_id and ab.building_id = p_building_id)))

    ) as member_deny,

    exists (

      select 1 from role_edges e

       where e.effect = 'DENY' and (

         e.scope_type = 'ORGANIZATION'

         or (e.scope_type = 'BUILDING' and e.building_id = p_building_id)

         or (e.scope_type = 'CASHBOOK' and e.cashbook_id = p_cashbook_id)

         or (e.scope_type = 'AREA' and p_building_id is not null and exists (

              select 1 from public.area_buildings ab

               where ab.organization_id = p_organization_id

                 and ab.area_id = e.area_id and ab.building_id = p_building_id)))

    ) as role_deny,

    -- ALLOW: possession-required keys need the exact CASHBOOK edge; other keys

    -- accept any covering edge whose kind the registry permits (ANY_MATCH).

    exists (

      select 1 from member_edges e, permission pd

       where e.effect = 'ALLOW'

         and e.scope_type = any(pd.scope_kinds)

         and case

           when pd.requires_cashbook_possession then

             e.scope_type = 'CASHBOOK' and e.cashbook_id = p_cashbook_id

           else

             e.scope_type = 'ORGANIZATION'

             or (e.scope_type = 'BUILDING' and e.building_id = p_building_id)

             or (e.scope_type = 'CASHBOOK' and e.cashbook_id = p_cashbook_id)

             or (e.scope_type = 'AREA' and p_building_id is not null and exists (

                  select 1 from public.area_buildings ab

                   where ab.organization_id = p_organization_id

                     and ab.area_id = e.area_id and ab.building_id = p_building_id))

         end

    ) as member_allow,

    exists (

      select 1 from role_edges e, permission pd

       where e.effect = 'ALLOW'

         and e.scope_type = any(pd.scope_kinds)

         and case

           when pd.requires_cashbook_possession then

             e.scope_type = 'CASHBOOK' and e.cashbook_id = p_cashbook_id

           else

             e.scope_type = 'ORGANIZATION'

             or (e.scope_type = 'BUILDING' and e.building_id = p_building_id)

             or (e.scope_type = 'CASHBOOK' and e.cashbook_id = p_cashbook_id)

             or (e.scope_type = 'AREA' and p_building_id is not null and exists (

                  select 1 from public.area_buildings ab

                   where ab.organization_id = p_organization_id

                     and ab.area_id = e.area_id and ab.building_id = p_building_id))

         end

    ) as role_allow

),

emergency as materialized (

  select exists (

    select 1 from app_private.tenant_emergency_denies d

      join locked_org lo on lo.id = d.organization_id

      cross join at

     where (d.permission_key is null or d.permission_key = p_permission_key)

       and d.active_from <= at.evaluated_at

       and (d.expires_at is null or d.expires_at > at.evaluated_at)

  ) as denied

),

-- Fix #7: possession is fail-closed on missing permission too.

possession as materialized (

  select case

    when not exists (select 1 from permission) then false

    when not (select requires_cashbook_possession from permission) then true

    when p_cashbook_id is null then false

    else exists (

      select 1

        from public.cashbook_possession_bindings cp

        join membership m

          on m.organization_id = cp.organization_id and m.id = cp.membership_id

        join permission pd

          on cp.possession_kind = any(pd.accepted_possession_kinds)

        cross join at

       where cp.organization_id = p_organization_id

         and cp.cashbook_id = p_cashbook_id

         and cp.valid_from <= at.evaluated_at

         and (cp.valid_to is null or cp.valid_to > at.evaluated_at))

  end as accepted

),

-- Fix #8: all arms org-filtered. Activation AND expiry boundaries.

boundaries as materialized (

  select min(x.boundary) as nearest_deadline

    from (

      select m0.valid_from as boundary

        from public.organization_memberships m0

       where m0.organization_id = p_organization_id and m0.user_id = p_actor

      union all

      select m0.valid_to

        from public.organization_memberships m0

       where m0.organization_id = p_organization_id and m0.user_id = p_actor

      union all

      select rb.valid_from

        from public.role_bindings rb

        join public.organization_memberships m0

          on m0.organization_id = rb.organization_id and m0.id = rb.membership_id

       where m0.user_id = p_actor and rb.organization_id = p_organization_id

      union all

      select rb.valid_to

        from public.role_bindings rb

        join public.organization_memberships m0

          on m0.organization_id = rb.organization_id and m0.id = rb.membership_id

       where m0.user_id = p_actor and rb.organization_id = p_organization_id

      union all

      select o.expires_at

        from public.member_permission_overrides o

        join public.organization_memberships m0

          on m0.organization_id = o.organization_id and m0.id = o.membership_id

       where m0.user_id = p_actor

         and o.organization_id = p_organization_id

         and o.permission_key = p_permission_key

         and o.revoked_at is null

      union all

      select cp.valid_from

        from public.cashbook_possession_bindings cp

        join public.organization_memberships m0

          on m0.organization_id = cp.organization_id and m0.id = cp.membership_id

       where m0.user_id = p_actor

         and cp.organization_id = p_organization_id

         and cp.cashbook_id = p_cashbook_id

      union all

      select cp.valid_to

        from public.cashbook_possession_bindings cp

        join public.organization_memberships m0

          on m0.organization_id = cp.organization_id and m0.id = cp.membership_id

       where m0.user_id = p_actor

         and cp.organization_id = p_organization_id

         and cp.cashbook_id = p_cashbook_id

      union all

      select d.active_from from app_private.tenant_emergency_denies d

       where d.organization_id = p_organization_id

         and (d.permission_key is null or d.permission_key = p_permission_key)

      union all

      select d.expires_at from app_private.tenant_emergency_denies d

       where d.organization_id = p_organization_id

         and (d.permission_key is null or d.permission_key = p_permission_key)

    ) x, at

   where x.boundary is not null and x.boundary > at.evaluated_at

)

select

  case

    when not exists (select 1 from locked_org) then false

    when not exists (select 1 from permission) then false

    when not (select satisfied from dimensions) then false

    when not exists (select 1 from membership) then false

    when not coalesce((select valid from target), false) then false

    when (select denied from emergency) then false

    when (select ok from malformed_guard) < 0 then false -- never taken; forces eval

    when (select member_deny from scope_cover) then false

    when (select role_deny from scope_cover) then false

    when not (select accepted from possession) then false

    when (select member_allow from scope_cover) then true

    when (select role_allow from scope_cover) then true

    else false

  end as allowed,

  (select lo.authorization_version from locked_org lo),

  (select b.nearest_deadline from boundaries b),

  (select a.evaluated_at from at a),

  case

    when not exists (select 1 from locked_org) then 'ORGANIZATION_INACTIVE_OR_MISSING'

    when not exists (select 1 from permission) then 'PERMISSION_INACTIVE_OR_MISSING'

    when not (select satisfied from dimensions) then 'REQUIRED_DIMENSION_MISSING'

    when not exists (select 1 from membership) then 'MEMBERSHIP_INACTIVE_OR_MISSING'

    when not coalesce((select valid from target), false) then 'TARGET_CROSS_ORG_OR_MISSING'

    when (select denied from emergency) then 'EMERGENCY_DENY'

    when (select member_deny from scope_cover) then 'MEMBER_DENY'

    when (select role_deny from scope_cover) then 'ROLE_DENY'

    when not (select accepted from possession) then 'POSSESSION_MISSING'

    when (select member_allow from scope_cover) then 'MEMBER_ALLOW'

    when (select role_allow from scope_cover) then 'ROLE_ALLOW'

    else 'DEFAULT_DENY'

  end as decision_reason

from (select 1) _;

$function$

-- app_private.raise_malformed_override(uuid,text) -- helper: authorize_tenant_action_v3 goi
CREATE OR REPLACE FUNCTION app_private.raise_malformed_override(p_organization_id uuid, p_permission_key text)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$

begin

  raise exception 'authorize_tenant_action_v3: open zero-edge override for % in org %',

    p_permission_key, p_organization_id using errcode = '23514';

end;

$function$

-- app_private.lock_org_for_decision_v1(uuid) -- helper: caller contract cua v3
CREATE OR REPLACE FUNCTION app_private.lock_org_for_decision_v1(p_organization_id uuid)
 RETURNS bigint
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$

  -- Statement 1 of the writer protocol: take the shared org lock FIRST so the

  -- witness statement that follows runs on a snapshot taken AFTER any waiting.

  select o.authorization_version

    from public.organizations o

   where o.id = p_organization_id

     and o.status = 'ACTIVE'

     for share;

$function$

-- app_private.bump_org_authorization_version() -- trigger fn tren cac bang RBAC
CREATE OR REPLACE FUNCTION app_private.bump_org_authorization_version()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
declare v_org uuid;
begin
  if tg_op = 'DELETE' then v_org := (to_jsonb(old)->>'organization_id')::uuid;
  else v_org := (to_jsonb(new)->>'organization_id')::uuid; end if;
  if v_org is not null then
    update public.organizations set authorization_version = authorization_version + 1 where id = v_org;
  end if;
  return coalesce(new, old);
end;
$function$

-- app_private.assert_override_scope_shape() -- constraint trigger fn override shape
CREATE OR REPLACE FUNCTION app_private.assert_override_scope_shape()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$

declare

  v_override_id uuid;

  v_bad record;

begin

  -- Branch on table BEFORE touching record fields: member_override_scopes has

  -- no `id` column and plpgsql raises on missing record fields at runtime.

  if tg_table_name = 'member_override_scopes' then

    if tg_op = 'DELETE' then

      v_override_id := old.override_id;

    else

      v_override_id := new.override_id;

    end if;

  else

    if tg_op = 'DELETE' then

      v_override_id := old.id;

    else

      v_override_id := new.id;

    end if;

  end if;



  select o.id, o.scope_mode, o.permission_key, o.organization_id,

         count(mos.scope_id) as edge_count,

         count(*) filter (where s.scope_type = 'ORGANIZATION') as org_edges,

         count(*) filter (

           where s.scope_type is not null

             and not (s.scope_type = any(pd.scope_kinds))

         ) as illegal_kind_edges

    into v_bad

    from public.member_permission_overrides o

    left join public.member_override_scopes mos

      on mos.organization_id = o.organization_id and mos.override_id = o.id

    left join public.authorization_scopes s

      on s.organization_id = o.organization_id and s.id = mos.scope_id

    left join public.permission_definitions pd on pd.key = o.permission_key

   where o.id = v_override_id

     and o.revoked_at is null

   group by o.id, o.scope_mode, o.permission_key, o.organization_id;



  if v_bad.id is null then

    return null; -- row deleted or already revoked; nothing to assert

  end if;



  if v_bad.scope_mode = 'ORGANIZATION'

     and not (v_bad.edge_count = 1 and v_bad.org_edges = 1) then

    raise exception 'override %: ORGANIZATION mode requires exactly one ORGANIZATION edge (has % edges, % org)',

      v_bad.id, v_bad.edge_count, v_bad.org_edges using errcode = '23514';

  end if;

  if v_bad.scope_mode = 'SCOPED'

     and not (v_bad.edge_count >= 1 and v_bad.org_edges = 0) then

    raise exception 'override %: SCOPED mode requires >=1 non-ORGANIZATION edge (has % edges, % org)',

      v_bad.id, v_bad.edge_count, v_bad.org_edges using errcode = '23514';

  end if;

  if v_bad.illegal_kind_edges > 0 then

    raise exception 'override %: % edge(s) outside permitted scope_kinds of %',

      v_bad.id, v_bad.illegal_kind_edges, v_bad.permission_key using errcode = '23514';

  end if;

  return null;

end;

$function$

-- app_private.guard_tenant_role_permission_domain() -- trigger fn role_permissions
CREATE OR REPLACE FUNCTION app_private.guard_tenant_role_permission_domain()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$

begin

  if not exists (

    select 1 from public.permission_definitions pd

     where pd.key = new.permission_key

       and pd.permission_domain = 'TENANT'

  ) then

    raise exception 'role_permissions: % is not a TENANT permission', new.permission_key

      using errcode = '23514';

  end if;

  return new;

end;

$function$


-- ---------------------------------------------------------------------
-- (b) org integrity — autofill organization_id
-- ---------------------------------------------------------------------

-- public._autofill_org() -- trigger fn autofill organization_id
CREATE OR REPLACE FUNCTION public._autofill_org()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
DECLARE
  j jsonb := to_jsonb(NEW);
  v uuid;
  n_orgs int;
  PROD constant uuid := 'aaaa0000-0000-4000-8000-000000000001';
BEGIN
  IF NEW.organization_id IS NOT NULL THEN RETURN NEW; END IF;
  IF (j->>'building_id') IS NOT NULL THEN SELECT organization_id INTO v FROM public.buildings WHERE id=(j->>'building_id')::uuid; END IF;
  IF v IS NULL AND (j->>'room_id') IS NOT NULL THEN SELECT organization_id INTO v FROM public.rooms WHERE id=(j->>'room_id')::uuid; END IF;
  IF v IS NULL AND (j->>'contract_id') IS NOT NULL THEN SELECT organization_id INTO v FROM public.contracts WHERE id=(j->>'contract_id')::uuid; END IF;
  IF v IS NULL AND (j->>'invoice_id') IS NOT NULL THEN SELECT organization_id INTO v FROM public.invoices WHERE id=(j->>'invoice_id')::uuid; END IF;
  IF v IS NULL AND (j->>'income_expense_id') IS NOT NULL THEN SELECT organization_id INTO v FROM public.income_expenses WHERE id=(j->>'income_expense_id')::uuid; END IF;
  IF v IS NULL AND (j->>'account_id') IS NOT NULL THEN SELECT organization_id INTO v FROM public.accounts WHERE id=(j->>'account_id')::uuid; END IF;
  IF v IS NULL AND (j->>'customer_id') IS NOT NULL THEN SELECT organization_id INTO v FROM public.customers WHERE id=(j->>'customer_id')::uuid; END IF;
  -- Membership: CHỈ khi user thuộc đúng MỘT org ACTIVE (uuid-safe, không dùng min()).
  IF v IS NULL AND (j->>'user_id') IS NOT NULL THEN
    SELECT (array_agg(DISTINCT organization_id))[1], count(DISTINCT organization_id)
      INTO v, n_orgs
      FROM public.organization_memberships
     WHERE user_id=(j->>'user_id')::uuid AND status='ACTIVE';
    IF n_orgs IS DISTINCT FROM 1 THEN v := NULL; END IF;
  END IF;

  IF v IS NULL THEN
    BEGIN
      INSERT INTO public.authorization_migration_exceptions(table_name, reason, details)
      VALUES (TG_TABLE_NAME, 'PROD_DEFAULT_FALLBACK at insert',
              jsonb_build_object('source', '_autofill_org', 'at', now(),
                                 'new_row_keys', (SELECT jsonb_object_agg(k, j->k)
                                                  FROM unnest(ARRAY['id','user_id','building_id','room_id','contract_id','invoice_id','account_id','customer_id']) AS k
                                                  WHERE j ? k)));
    EXCEPTION WHEN OTHERS THEN
      NULL;
    END;
    v := PROD;
  END IF;

  NEW.organization_id := v;
  RETURN NEW;
END;
$function$


-- ---------------------------------------------------------------------
-- (c) meter — duyet / bo duyet chi so
-- ---------------------------------------------------------------------

-- public.approve_meter_reading_v1(uuid)
CREATE OR REPLACE FUNCTION public.approve_meter_reading_v1(p_id uuid)
 RETURNS meter_readings
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
declare v_row public.meter_readings; v_building uuid;
begin
  select * into v_row from public.meter_readings where id = p_id and deleted_at is null;
  if not found then raise exception 'Không tìm thấy chỉ số' using errcode='42501'; end if;
  select building_id into v_building from public.meters where id = v_row.meter_id;
  if not public.can_do_on_building('meter_readings','edit',v_building) then
    raise exception 'Không có quyền duyệt chỉ số cho toà này' using errcode='42501'; end if;
  if v_row.status = 'APPROVED' then return v_row; end if; -- idempotent
  update public.meter_readings
     set status='APPROVED', approved_by=auth.uid(), approved_at=now()
   where id = p_id returning * into v_row;
  return v_row;
end;
$function$

-- public.bulk_approve_meter_readings_v1(uuid[])
CREATE OR REPLACE FUNCTION public.bulk_approve_meter_readings_v1(p_ids uuid[])
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
declare v_id uuid; v_n int := 0;
begin
  foreach v_id in array coalesce(p_ids, array[]::uuid[]) loop
    begin
      perform public.approve_meter_reading_v1(v_id);
      v_n := v_n + 1;
    exception when insufficient_privilege then
      -- bỏ qua item không đủ quyền/không tồn tại; đếm số duyệt thành công
      null;
    end;
  end loop;
  return v_n;
end;
$function$

-- public.unapprove_meter_reading_v1(uuid)
CREATE OR REPLACE FUNCTION public.unapprove_meter_reading_v1(p_id uuid)
 RETURNS meter_readings
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
declare v_row public.meter_readings; v_building uuid;
begin
  select * into v_row from public.meter_readings where id = p_id and deleted_at is null;
  if not found then raise exception 'Không tìm thấy chỉ số' using errcode='42501'; end if;
  select building_id into v_building from public.meters where id = v_row.meter_id;
  if not public.can_do_on_building('meter_readings','edit',v_building) then
    raise exception 'Không có quyền bỏ duyệt chỉ số cho toà này' using errcode='42501'; end if;
  if v_row.status = 'UNAPPROVED' then return v_row; end if; -- idempotent
  update public.meter_readings
     set status='UNAPPROVED', approved_by=null, approved_at=null
   where id = p_id returning * into v_row;
  return v_row;
end;
$function$

-- public.can_do_on_building(text,text,uuid) -- helper: 3 ham meter goi
CREATE OR REPLACE FUNCTION public.can_do_on_building(_table text, _action text, _building_id uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'auth', 'app_private'
AS $function$
  SELECT
    -- t5_27: thành viên bị đình chỉ/thu hồi ⇒ chặn ngay ở đường cũ.
    NOT app_private.is_actor_offboarded_v1()
    AND (
    public.is_super_admin()
    -- admin cấp-tenant (owner-join): admin làm mọi thứ trong tenant mình
    OR EXISTS (SELECT 1 FROM public.staff_assignments sa
               JOIN public.roles r ON r.id = sa.role_id
               JOIN public.buildings b ON b.user_id = sa.user_id AND b.id = _building_id
               WHERE sa.staff_id = auth.uid()
                 AND (r.name = 'Admin' OR r.permissions @> '{"__superadmin": true}'::jsonb))
    -- full-scope + quyền (owner-join): mọi tòa CÙNG owner
    OR EXISTS (SELECT 1 FROM public.staff_assignments sa
               LEFT JOIN public.roles r ON r.id = sa.role_id
               JOIN public.buildings b ON b.user_id = sa.user_id AND b.id = _building_id
               WHERE sa.staff_id = auth.uid()
                 AND sa.building_id IS NULL AND sa.area_id IS NULL
                 AND COALESCE((COALESCE(sa.permissions, r.permissions) -> _table ->> _action)::boolean, false) = true)
    -- gán tòa cụ thể + quyền (KHÔNG owner-join)
    OR EXISTS (SELECT 1 FROM public.staff_assignments sa
               LEFT JOIN public.roles r ON r.id = sa.role_id
               WHERE sa.staff_id = auth.uid() AND sa.building_id = _building_id
                 AND COALESCE((COALESCE(sa.permissions, r.permissions) -> _table ->> _action)::boolean, false) = true)
    -- gán theo khu + quyền (KHÔNG owner-join)
    OR EXISTS (SELECT 1 FROM public.staff_assignments sa
               LEFT JOIN public.roles r ON r.id = sa.role_id
               JOIN public.area_buildings ab ON ab.area_id = sa.area_id
               WHERE sa.staff_id = auth.uid() AND sa.area_id IS NOT NULL AND ab.building_id = _building_id
                 AND COALESCE((COALESCE(sa.permissions, r.permissions) -> _table ->> _action)::boolean, false) = true)
    );
$function$


-- ---------------------------------------------------------------------
-- (d) nguong tu duyet phieu chi
-- ---------------------------------------------------------------------

-- public.get_ie_auto_approve_threshold_v1()
CREATE OR REPLACE FUNCTION public.get_ie_auto_approve_threshold_v1()
 RETURNS numeric
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'app_private'
AS $function$
declare
  v_actor uuid := auth.uid();
  v_org uuid; v_cnt int; v_owner_org uuid;
begin
  if v_actor is null then raise exception 'Chưa đăng nhập' using errcode='42501'; end if;
  select count(distinct m.organization_id), min(m.organization_id::text)::uuid
    into v_cnt, v_org
    from public.organization_memberships m
   where m.user_id = v_actor and m.status = 'ACTIVE';
  if coalesce(v_cnt,0) = 0 then raise exception 'Không thuộc tổ chức nào' using errcode='42501'; end if;
  if v_cnt > 1 then
    select rb.organization_id into v_owner_org
      from public.role_bindings rb
      join public.organization_memberships m
        on m.id = rb.membership_id and m.organization_id = rb.organization_id
       and m.user_id = v_actor and m.status = 'ACTIVE'
      join public.organization_roles r
        on r.id = rb.role_id and r.name = 'Chủ sở hữu tổ chức'
     limit 1;
    if v_owner_org is not null then v_org := v_owner_org; end if;
  end if;
  return (select c.threshold from app_private.ie_auto_approve_config c
           where c.organization_id = v_org);
end;
$function$

-- public.set_ie_auto_approve_threshold_v1(numeric)
CREATE OR REPLACE FUNCTION public.set_ie_auto_approve_threshold_v1(p_threshold numeric)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'app_private'
AS $function$
declare
  v_actor uuid := auth.uid();
  v_org uuid; v_cnt int; v_owner_org uuid; v_is_owner boolean;
begin
  if v_actor is null then raise exception 'Chưa đăng nhập' using errcode='42501'; end if;
  if p_threshold is not null and (p_threshold <= 0 or round(p_threshold,2) <> p_threshold) then
    raise exception 'Ngưỡng không hợp lệ (phải > 0)' using errcode='22023';
  end if;
  select count(distinct m.organization_id), min(m.organization_id::text)::uuid
    into v_cnt, v_org
    from public.organization_memberships m
   where m.user_id = v_actor and m.status = 'ACTIVE';
  if coalesce(v_cnt,0) = 0 then raise exception 'Không thuộc tổ chức nào' using errcode='42501'; end if;
  if v_cnt > 1 then
    select rb.organization_id into v_owner_org
      from public.role_bindings rb
      join public.organization_memberships m
        on m.id = rb.membership_id and m.organization_id = rb.organization_id
       and m.user_id = v_actor and m.status = 'ACTIVE'
      join public.organization_roles r
        on r.id = rb.role_id and r.name = 'Chủ sở hữu tổ chức'
     limit 1;
    if v_owner_org is not null then v_org := v_owner_org; end if;
  end if;

  select exists (
    select 1 from public.role_bindings rb
      join public.organization_memberships m
        on m.id = rb.membership_id and m.organization_id = rb.organization_id
       and m.user_id = v_actor and m.status = 'ACTIVE'
      join public.organization_roles r
        on r.id = rb.role_id and r.name = 'Chủ sở hữu tổ chức'
     where rb.organization_id = v_org
  ) into v_is_owner;
  if not (coalesce(v_is_owner,false) or coalesce(public.is_super_admin(),false)) then
    raise exception 'Chỉ Chủ sở hữu tổ chức được đặt ngưỡng tự duyệt' using errcode='42501';
  end if;

  insert into app_private.ie_auto_approve_config (organization_id, threshold, updated_by, updated_at)
  values (v_org, p_threshold, v_actor, now())
  on conflict (organization_id)
  do update set threshold = excluded.threshold,
                updated_by = excluded.updated_by,
                updated_at = excluded.updated_at;

  return json_build_object('organization_id', v_org, 'threshold', p_threshold);
end;
$function$

-- public.is_super_admin() -- helper: set_ie_auto_approve_threshold_v1 goi
CREATE OR REPLACE FUNCTION public.is_super_admin()
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT EXISTS (
    SELECT 1 FROM public.super_admins WHERE user_id = auth.uid()
  );
$function$


-- ---------------------------------------------------------------------
-- (e) freeze + ownership phieu thu/chi (IE)
-- ---------------------------------------------------------------------

-- app_private.guard_income_expense_owned_payload() -- guard trigger a00_ie_owned_payload_freeze
CREATE OR REPLACE FUNCTION app_private.guard_income_expense_owned_payload()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'app_private'
AS $function$
declare
  v_authorized boolean;
begin
  if tg_op = 'DELETE' then
    if app_private.is_income_expense_flow_owned(old.id) then
      raise exception 'canonical income expense % is frozen (delete rejected)', old.id
        using errcode = '55000';
    end if;
    return old;
  end if;

  if tg_op = 'UPDATE' then
    if not app_private.is_income_expense_flow_owned(old.id)
       and not (new.id is distinct from old.id
                and app_private.is_income_expense_flow_owned(new.id)) then
      return new; -- unmarked legacy row: unchanged behavior
    end if;

    -- canonical row: check for a live transition token in THIS transaction
    select exists (
      select 1 from app_private.ie_transition_authorization t
       where t.income_expense_id = old.id and t.xid = pg_current_xact_id()
    ) into v_authorized;

    if not v_authorized then
      raise exception 'canonical income expense % is frozen (update rejected)', old.id
        using errcode = '55000';
    end if;

    -- ALLOWLIST, not denylist. t5_08 widened: lifecycle metadata
    -- (approved_by/approved_at, verified_*) joins the original lifecycle
    -- columns. EVERY other column must be NOT DISTINCT FROM its old value.
    if (to_jsonb(old) - array['approval_status','posting_id','posted_at_v2',
                              'reversed_by_posting_id','updated_at',
                              'approved_by','approved_at',
                              'verified_at','verified_by','verified_by_name',
                              'verified_note'])
       is distinct from
       (to_jsonb(new) - array['approval_status','posting_id','posted_at_v2',
                              'reversed_by_posting_id','updated_at',
                              'approved_by','approved_at',
                              'verified_at','verified_by','verified_by_name',
                              'verified_note']) then
      raise exception 'authorized transition may only change lifecycle columns of %', old.id
        using errcode = '55000';
    end if;
    return new;
  end if;

  return new;
end;
$function$

-- app_private.guard_income_expense_owned_items() -- guard trigger a00_ie_item_owned_payload_freeze
CREATE OR REPLACE FUNCTION app_private.guard_income_expense_owned_items()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'app_private'
AS $function$

declare

  v_old uuid;

  v_new uuid;

begin

  if tg_op = 'DELETE' then

    v_old := old.income_expense_id;

    if app_private.is_income_expense_flow_owned(v_old) then

      raise exception 'items of canonical income expense % are frozen', v_old

        using errcode = '55000';

    end if;

    return old;

  end if;

  v_new := new.income_expense_id;

  if tg_op = 'UPDATE' then

    v_old := old.income_expense_id;

    if v_old is distinct from v_new

       and app_private.is_income_expense_flow_owned(v_old) then

      raise exception 'items of canonical income expense % are frozen', v_old

        using errcode = '55000';

    end if;

  end if;

  if app_private.is_income_expense_flow_owned(v_new) then

    raise exception 'items of canonical income expense % are frozen', v_new

      using errcode = '55000';

  end if;

  return new;

end;

$function$

-- app_private.guard_income_expense_truncate() -- guard trigger a00_ie_truncate_freeze / item
CREATE OR REPLACE FUNCTION app_private.guard_income_expense_truncate()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'app_private'
AS $function$

begin

  if exists (select 1 from app_private.income_expense_flow_ownership) then

    raise exception 'TRUNCATE rejected: canonical income expenses exist'

      using errcode = '55000';

  end if;

  return null;

end;

$function$

-- app_private.is_income_expense_flow_owned(uuid) -- helper: guard payload goi
CREATE OR REPLACE FUNCTION app_private.is_income_expense_flow_owned(p_id uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'app_private'
AS $function$

  select exists (

    select 1 from app_private.income_expense_flow_ownership

     where income_expense_id = p_id);

$function$

-- app_private.reject_income_expense_flow_mutation() -- trigger fn bat bien so huu
CREATE OR REPLACE FUNCTION app_private.reject_income_expense_flow_mutation()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog'
AS $function$

begin

  raise exception 'canonical flow ownership records are immutable'

    using errcode = '55000';

end;

$function$

-- app_private.reject_income_expense_flow_truncate() -- trigger fn chan TRUNCATE so huu
CREATE OR REPLACE FUNCTION app_private.reject_income_expense_flow_truncate()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog'
AS $function$

begin

  raise exception 'canonical flow ownership tables cannot be truncated'

    using errcode = '55000';

end;

$function$

-- app_private.current_uid_v1() -- helper: claim_* goi
CREATE OR REPLACE FUNCTION app_private.current_uid_v1()
 RETURNS uuid
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'auth'
AS $function$ select auth.uid() $function$

-- app_private.has_ie_claim_capability_v1(text) -- helper: claim_* (3 tham so) goi
CREATE OR REPLACE FUNCTION app_private.has_ie_claim_capability_v1(p_nonce text)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog'
AS $function$

  -- Strictly boolean, fail-closed: a NULL nonce, an unset GUC, or a mismatch all

  -- return false (never NULL — an IF NOT on NULL would silently skip the guard).

  select coalesce(

    p_nonce = nullif(current_setting('app_private.ie_claim_capability', true), ''),

    false);

$function$

-- app_private.ie_lock_row_for_claim_v1(uuid) -- helper: claim_* goi
CREATE OR REPLACE FUNCTION app_private.ie_lock_row_for_claim_v1(p_id uuid)
 RETURNS income_expenses
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$

declare

  v_row public.income_expenses;

begin

  select * into v_row from public.income_expenses

   where id = p_id and deleted_at is null

   for update; -- TOCTOU fix: concurrent UPDATE waits, then sees the marker

  if not found then

    raise exception 'income expense not found' using errcode = 'P0002';

  end if;

  return v_row;

end;

$function$

-- app_private.ie_lock_operation_for_claim_v1(uuid,text,uuid,text,text) -- helper: claim_* goi
CREATE OR REPLACE FUNCTION app_private.ie_lock_operation_for_claim_v1(p_organization_id uuid, p_subject_scope text, p_actor uuid, p_idempotency_key text, p_payload_hash text)
 RETURNS app_private.canonical_write_operations
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'app_private'
AS $function$

declare

  v_op app_private.canonical_write_operations;

begin

  select * into v_op

    from app_private.canonical_write_operations o

   where o.organization_id = p_organization_id

     and o.operation = 'income_expense.create_draft.v1'

     and o.subject_scope = p_subject_scope

     and o.actor_id = p_actor

     and o.idempotency_key = p_idempotency_key

     and o.subject_id is null

     and o.response_payload is null

     and o.completed_at is null

     and o.payload_hash = p_payload_hash

   for update;

  if not found then

    raise exception 'no matching in-progress canonical operation'

      using errcode = 'P0002';

  end if;

  return v_op;

end;

$function$

-- app_private.claim_canonical_income_expense_draft_v1(uuid,text) -- overload 2 tham so
CREATE OR REPLACE FUNCTION app_private.claim_canonical_income_expense_draft_v1(p_income_expense_id uuid, p_idempotency_key text)
 RETURNS void
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'app_private', 'public'
AS $function$



declare



  v_row public.income_expenses;



  v_op app_private.canonical_write_operations;



  v_actor uuid;



begin



  if current_user <> 'ie_canonical_writer' then



    raise exception 'canonical claim capability required' using errcode = '42501';



  end if;







  v_actor := app_private.current_uid_v1();  -- DEFINER delegate; role has no auth USAGE



  if v_actor is null then



    raise exception 'authentication required' using errcode = '42501';



  end if;







  v_row := app_private.ie_lock_row_for_claim_v1(p_income_expense_id);







  if v_row.user_id is distinct from v_actor then



    raise exception 'claim actor is not the maker' using errcode = '42501';



  end if;



  -- t5_22: phuong an org = phieu thuong TU DUYET khi tao -> chap nhan them

  -- hinh dang "APPROVED tu luc sinh boi chinh maker" (self-approved-at-birth).

  if (v_row.approval_status is distinct from 'UNAPPROVED'

      and not (v_row.approval_status = 'APPROVED'

               and v_row.approved_by is not distinct from v_actor))

     or v_row.approval_request_id is not null



     or v_row.posting_id is not null



     or v_row.posted_at_v2 is not null



     or v_row.reversed_by_posting_id is not null



     or v_row.system_source is not null then



    raise exception 'row is not claimable as canonical draft' using errcode = '23514';



  end if;



  if v_row.source_payload_hash is null



     or v_row.source_payload_hash !~ '^[0-9a-f]{32}$' then



    raise exception 'row lacks canonical payload hash' using errcode = '23514';



  end if;







  v_op := app_private.ie_lock_operation_for_claim_v1(



    v_row.organization_id, v_row.building_id::text, v_actor,



    p_idempotency_key, v_row.source_payload_hash);







  insert into app_private.income_expense_flow_ownership (



    income_expense_id, organization_id, writer_operation,



    payload_hash_scheme, payload_hash_value,



    maker_user_id, claimed_by_user_id, correlation_id)



  values (



    v_row.id, v_row.organization_id, v_op.operation,



    'PG_MD5_JSONB_TEXT_V1', v_row.source_payload_hash,



    v_row.user_id, v_actor, null);







  insert into app_private.income_expense_flow_ownership_events (



    organization_id, income_expense_id, event_type, actor_user_id, detail)



  values (



    v_row.organization_id, v_row.id, 'FLOW_CLAIMED', v_actor,



    jsonb_build_object('operation', v_op.operation,



                       'idempotency_key', p_idempotency_key));



end;



$function$

-- app_private.claim_canonical_income_expense_draft_v1(uuid,text,text) -- overload 3 tham so
CREATE OR REPLACE FUNCTION app_private.claim_canonical_income_expense_draft_v1(p_income_expense_id uuid, p_idempotency_key text, p_capability_nonce text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'app_private', 'public'
AS $function$



declare



  v_row public.income_expenses;



  v_op app_private.canonical_write_operations;



  v_actor uuid;



begin



  if not app_private.has_ie_claim_capability_v1(p_capability_nonce) then



    raise exception 'canonical claim capability required' using errcode = '42501';



  end if;







  v_actor := app_private.current_uid_v1();



  if v_actor is null then



    raise exception 'authentication required' using errcode = '42501';



  end if;







  v_row := app_private.ie_lock_row_for_claim_v1(p_income_expense_id);



  if v_row.user_id is distinct from v_actor then



    raise exception 'claim actor is not the maker' using errcode = '42501';



  end if;



  -- t5_22: phuong an org = phieu thuong TU DUYET khi tao -> chap nhan them

  -- hinh dang "APPROVED tu luc sinh boi chinh maker" (self-approved-at-birth).

  if (v_row.approval_status is distinct from 'UNAPPROVED'

      and not (v_row.approval_status = 'APPROVED'

               and v_row.approved_by is not distinct from v_actor))

     or v_row.approval_request_id is not null



     or v_row.posting_id is not null



     or v_row.posted_at_v2 is not null



     or v_row.reversed_by_posting_id is not null



     or v_row.system_source is not null then



    raise exception 'row is not claimable as canonical draft' using errcode = '23514';



  end if;



  if v_row.source_payload_hash is null



     or v_row.source_payload_hash !~ '^[0-9a-f]{32}$' then



    raise exception 'row lacks canonical payload hash' using errcode = '23514';



  end if;







  v_op := app_private.ie_lock_operation_for_claim_v1(



    v_row.organization_id, v_row.building_id::text, v_actor,



    p_idempotency_key, v_row.source_payload_hash);







  insert into app_private.income_expense_flow_ownership (



    income_expense_id, organization_id, writer_operation,



    payload_hash_scheme, payload_hash_value,



    maker_user_id, claimed_by_user_id, correlation_id)



  values (



    v_row.id, v_row.organization_id, v_op.operation,



    'PG_MD5_JSONB_TEXT_V1', v_row.source_payload_hash,



    v_row.user_id, v_actor, null);







  insert into app_private.income_expense_flow_ownership_events (



    organization_id, income_expense_id, event_type, actor_user_id, detail)



  values (



    v_row.organization_id, v_row.id, 'FLOW_CLAIMED', v_actor,



    jsonb_build_object('operation', v_op.operation,



                       'idempotency_key', p_idempotency_key));



end;



$function$

-- app_private.append_income_expense_event_v1(uuid,uuid,text,uuid,text,text,text,text)
CREATE OR REPLACE FUNCTION app_private.append_income_expense_event_v1(p_organization_id uuid, p_income_expense_id uuid, p_action text, p_actor_id uuid, p_actor_name text, p_old_status text, p_new_status text, p_note text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'app_private', 'public'
AS $function$

declare

  v_head app_private.income_expense_audit_chain_heads;

  v_seq bigint;

  v_canonical text;

  v_hash text;

  v_id uuid;

  v_now timestamptz := clock_timestamp();

begin

  if p_organization_id is null or p_income_expense_id is null

     or p_action is null or p_actor_id is null then

    raise exception 'append_income_expense_event_v1: required argument NULL'

      using errcode = '22004';

  end if;



  -- F5: bootstrap + lock. Head is the last lock taken before the INSERT.

  insert into app_private.income_expense_audit_chain_heads (organization_id)

  values (p_organization_id)

  on conflict (organization_id) do nothing;



  select * into v_head

    from app_private.income_expense_audit_chain_heads

   where organization_id = p_organization_id

   for update;



  v_seq := v_head.last_sequence_no + 1;



  -- F2/F3 canonical serialization (byte-level pinned):

  --   fields joined by \x1f, timestamps rendered UTC ISO-8601 fixed format,

  --   NULLs rendered as empty string, preimage prefixed with org + seq +

  --   prev hash. No jsonb round-trip → no numeric/TZ instability.

  v_canonical := concat_ws(chr(31),

    'PG_SHA256_CANONICAL_V1',

    p_organization_id::text,

    v_seq::text,

    v_head.last_event_hash,

    p_income_expense_id::text,

    p_action,

    p_actor_id::text,

    coalesce(p_actor_name, ''),

    coalesce(p_old_status, ''),

    coalesce(p_new_status, ''),

    coalesce(p_note, ''),

    to_char(v_now at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'));



  v_hash := encode(sha256(convert_to(v_canonical, 'UTF8')), 'hex');



  insert into public.income_expense_audit_log (

    income_expense_id, action, actor_id, actor_name,

    old_status, new_status, note, organization_id,

    sequence_no, prev_event_hash, event_hash, hash_scheme, created_at)

  values (

    p_income_expense_id, p_action, p_actor_id, p_actor_name,

    p_old_status, p_new_status, p_note, p_organization_id,

    v_seq, v_head.last_event_hash, v_hash, 'PG_SHA256_CANONICAL_V1', v_now)

  returning id into v_id;



  update app_private.income_expense_audit_chain_heads

     set last_sequence_no = v_seq,

         last_event_hash = v_hash,

         updated_at = v_now

   where organization_id = p_organization_id;



  return v_id;

end;

$function$


-- =====================================================================
-- MUC 5 — TRIGGER (46)
-- =====================================================================


-- app_private.income_expense_flow_ownership
DROP TRIGGER IF EXISTS a00_flow_ownership_immutable ON app_private.income_expense_flow_ownership;
CREATE TRIGGER a00_flow_ownership_immutable BEFORE DELETE OR UPDATE ON app_private.income_expense_flow_ownership FOR EACH ROW EXECUTE FUNCTION app_private.reject_income_expense_flow_mutation();
DROP TRIGGER IF EXISTS a00_flow_ownership_no_truncate ON app_private.income_expense_flow_ownership;
CREATE TRIGGER a00_flow_ownership_no_truncate BEFORE TRUNCATE ON app_private.income_expense_flow_ownership FOR EACH STATEMENT EXECUTE FUNCTION app_private.reject_income_expense_flow_truncate();

-- app_private.income_expense_flow_ownership_events
DROP TRIGGER IF EXISTS a00_flow_events_immutable ON app_private.income_expense_flow_ownership_events;
CREATE TRIGGER a00_flow_events_immutable BEFORE DELETE OR UPDATE ON app_private.income_expense_flow_ownership_events FOR EACH ROW EXECUTE FUNCTION app_private.reject_income_expense_flow_mutation();
DROP TRIGGER IF EXISTS a00_flow_events_no_truncate ON app_private.income_expense_flow_ownership_events;
CREATE TRIGGER a00_flow_events_no_truncate BEFORE TRUNCATE ON app_private.income_expense_flow_ownership_events FOR EACH STATEMENT EXECUTE FUNCTION app_private.reject_income_expense_flow_truncate();

-- public.accounts
DROP TRIGGER IF EXISTS a01_autofill_org ON public.accounts;
CREATE TRIGGER a01_autofill_org BEFORE INSERT ON public.accounts FOR EACH ROW EXECUTE FUNCTION public._autofill_org();

-- public.assets
DROP TRIGGER IF EXISTS trg_autofill_org ON public.assets;
CREATE TRIGGER trg_autofill_org BEFORE INSERT ON public.assets FOR EACH ROW EXECUTE FUNCTION public._autofill_org();

-- public.authorization_scopes
DROP TRIGGER IF EXISTS a10_bump_authz_version ON public.authorization_scopes;
CREATE TRIGGER a10_bump_authz_version AFTER INSERT OR DELETE OR UPDATE ON public.authorization_scopes FOR EACH ROW EXECUTE FUNCTION app_private.bump_org_authorization_version();

-- public.building_services
DROP TRIGGER IF EXISTS trg_autofill_org ON public.building_services;
CREATE TRIGGER trg_autofill_org BEFORE INSERT ON public.building_services FOR EACH ROW EXECUTE FUNCTION public._autofill_org();

-- public.contract_customers
DROP TRIGGER IF EXISTS trg_autofill_org ON public.contract_customers;
CREATE TRIGGER trg_autofill_org BEFORE INSERT ON public.contract_customers FOR EACH ROW EXECUTE FUNCTION public._autofill_org();

-- public.contract_extensions
DROP TRIGGER IF EXISTS trg_autofill_org ON public.contract_extensions;
CREATE TRIGGER trg_autofill_org BEFORE INSERT ON public.contract_extensions FOR EACH ROW EXECUTE FUNCTION public._autofill_org();

-- public.contract_services
DROP TRIGGER IF EXISTS trg_autofill_org ON public.contract_services;
CREATE TRIGGER trg_autofill_org BEFORE INSERT ON public.contract_services FOR EACH ROW EXECUTE FUNCTION public._autofill_org();

-- public.contract_tenants
DROP TRIGGER IF EXISTS trg_autofill_org ON public.contract_tenants;
CREATE TRIGGER trg_autofill_org BEFORE INSERT ON public.contract_tenants FOR EACH ROW EXECUTE FUNCTION public._autofill_org();

-- public.contract_terminations
DROP TRIGGER IF EXISTS trg_autofill_org ON public.contract_terminations;
CREATE TRIGGER trg_autofill_org BEFORE INSERT ON public.contract_terminations FOR EACH ROW EXECUTE FUNCTION public._autofill_org();

-- public.contract_transfers
DROP TRIGGER IF EXISTS trg_autofill_org ON public.contract_transfers;
CREATE TRIGGER trg_autofill_org BEFORE INSERT ON public.contract_transfers FOR EACH ROW EXECUTE FUNCTION public._autofill_org();

-- public.contracts
DROP TRIGGER IF EXISTS trg_autofill_org ON public.contracts;
CREATE TRIGGER trg_autofill_org BEFORE INSERT ON public.contracts FOR EACH ROW EXECUTE FUNCTION public._autofill_org();

-- public.customers
DROP TRIGGER IF EXISTS trg_autofill_org ON public.customers;
CREATE TRIGGER trg_autofill_org BEFORE INSERT ON public.customers FOR EACH ROW EXECUTE FUNCTION public._autofill_org();

-- public.deposits
DROP TRIGGER IF EXISTS trg_autofill_org ON public.deposits;
CREATE TRIGGER trg_autofill_org BEFORE INSERT ON public.deposits FOR EACH ROW EXECUTE FUNCTION public._autofill_org();

-- public.excess_amounts
DROP TRIGGER IF EXISTS trg_autofill_org ON public.excess_amounts;
CREATE TRIGGER trg_autofill_org BEFORE INSERT ON public.excess_amounts FOR EACH ROW EXECUTE FUNCTION public._autofill_org();

-- public.floors
DROP TRIGGER IF EXISTS trg_autofill_org ON public.floors;
CREATE TRIGGER trg_autofill_org BEFORE INSERT ON public.floors FOR EACH ROW EXECUTE FUNCTION public._autofill_org();

-- public.income_expense_batch_items
DROP TRIGGER IF EXISTS trg_autofill_org ON public.income_expense_batch_items;
CREATE TRIGGER trg_autofill_org BEFORE INSERT ON public.income_expense_batch_items FOR EACH ROW EXECUTE FUNCTION public._autofill_org();

-- public.income_expense_batches
DROP TRIGGER IF EXISTS trg_autofill_org ON public.income_expense_batches;
CREATE TRIGGER trg_autofill_org BEFORE INSERT ON public.income_expense_batches FOR EACH ROW EXECUTE FUNCTION public._autofill_org();

-- public.income_expense_items
DROP TRIGGER IF EXISTS a00_ie_item_owned_payload_freeze ON public.income_expense_items;
CREATE TRIGGER a00_ie_item_owned_payload_freeze BEFORE INSERT OR DELETE OR UPDATE ON public.income_expense_items FOR EACH ROW EXECUTE FUNCTION app_private.guard_income_expense_owned_items();
DROP TRIGGER IF EXISTS a00_ie_item_truncate_freeze ON public.income_expense_items;
CREATE TRIGGER a00_ie_item_truncate_freeze BEFORE TRUNCATE ON public.income_expense_items FOR EACH STATEMENT EXECUTE FUNCTION app_private.guard_income_expense_truncate();
DROP TRIGGER IF EXISTS trg_autofill_org ON public.income_expense_items;
CREATE TRIGGER trg_autofill_org BEFORE INSERT ON public.income_expense_items FOR EACH ROW EXECUTE FUNCTION public._autofill_org();

-- public.income_expenses
DROP TRIGGER IF EXISTS a00_ie_owned_payload_freeze ON public.income_expenses;
CREATE TRIGGER a00_ie_owned_payload_freeze BEFORE DELETE OR UPDATE ON public.income_expenses FOR EACH ROW EXECUTE FUNCTION app_private.guard_income_expense_owned_payload();
DROP TRIGGER IF EXISTS a00_ie_truncate_freeze ON public.income_expenses;
CREATE TRIGGER a00_ie_truncate_freeze BEFORE TRUNCATE ON public.income_expenses FOR EACH STATEMENT EXECUTE FUNCTION app_private.guard_income_expense_truncate();
DROP TRIGGER IF EXISTS trg_autofill_org ON public.income_expenses;
CREATE TRIGGER trg_autofill_org BEFORE INSERT ON public.income_expenses FOR EACH ROW EXECUTE FUNCTION public._autofill_org();

-- public.invoice_items
DROP TRIGGER IF EXISTS trg_autofill_org ON public.invoice_items;
CREATE TRIGGER trg_autofill_org BEFORE INSERT ON public.invoice_items FOR EACH ROW EXECUTE FUNCTION public._autofill_org();

-- public.invoices
DROP TRIGGER IF EXISTS trg_autofill_org ON public.invoices;
CREATE TRIGGER trg_autofill_org BEFORE INSERT ON public.invoices FOR EACH ROW EXECUTE FUNCTION public._autofill_org();

-- public.jobs
DROP TRIGGER IF EXISTS trg_autofill_org ON public.jobs;
CREATE TRIGGER trg_autofill_org BEFORE INSERT ON public.jobs FOR EACH ROW EXECUTE FUNCTION public._autofill_org();

-- public.leads
DROP TRIGGER IF EXISTS trg_autofill_org ON public.leads;
CREATE TRIGGER trg_autofill_org BEFORE INSERT ON public.leads FOR EACH ROW EXECUTE FUNCTION public._autofill_org();

-- public.member_override_scopes
DROP TRIGGER IF EXISTS a10_bump_authz_version ON public.member_override_scopes;
CREATE TRIGGER a10_bump_authz_version AFTER INSERT OR DELETE OR UPDATE ON public.member_override_scopes FOR EACH ROW EXECUTE FUNCTION app_private.bump_org_authorization_version();
DROP TRIGGER IF EXISTS a90_override_edge_shape ON public.member_override_scopes;
CREATE CONSTRAINT TRIGGER a90_override_edge_shape AFTER INSERT OR DELETE OR UPDATE ON public.member_override_scopes DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app_private.assert_override_scope_shape();

-- public.member_permission_overrides
DROP TRIGGER IF EXISTS a10_bump_authz_version ON public.member_permission_overrides;
CREATE TRIGGER a10_bump_authz_version AFTER INSERT OR DELETE OR UPDATE ON public.member_permission_overrides FOR EACH ROW EXECUTE FUNCTION app_private.bump_org_authorization_version();
DROP TRIGGER IF EXISTS a90_override_shape ON public.member_permission_overrides;
CREATE CONSTRAINT TRIGGER a90_override_shape AFTER INSERT OR UPDATE ON public.member_permission_overrides DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app_private.assert_override_scope_shape();

-- public.meter_readings
DROP TRIGGER IF EXISTS trg_autofill_org ON public.meter_readings;
CREATE TRIGGER trg_autofill_org BEFORE INSERT ON public.meter_readings FOR EACH ROW EXECUTE FUNCTION public._autofill_org();

-- public.meters
DROP TRIGGER IF EXISTS trg_autofill_org ON public.meters;
CREATE TRIGGER trg_autofill_org BEFORE INSERT ON public.meters FOR EACH ROW EXECUTE FUNCTION public._autofill_org();

-- public.payments
DROP TRIGGER IF EXISTS trg_autofill_org ON public.payments;
CREATE TRIGGER trg_autofill_org BEFORE INSERT ON public.payments FOR EACH ROW EXECUTE FUNCTION public._autofill_org();

-- public.role_binding_scopes
DROP TRIGGER IF EXISTS a10_bump_authz_version ON public.role_binding_scopes;
CREATE TRIGGER a10_bump_authz_version AFTER INSERT OR DELETE OR UPDATE ON public.role_binding_scopes FOR EACH ROW EXECUTE FUNCTION app_private.bump_org_authorization_version();

-- public.role_bindings
DROP TRIGGER IF EXISTS a10_bump_authz_version ON public.role_bindings;
CREATE TRIGGER a10_bump_authz_version AFTER INSERT OR DELETE OR UPDATE ON public.role_bindings FOR EACH ROW EXECUTE FUNCTION app_private.bump_org_authorization_version();

-- public.role_permissions
DROP TRIGGER IF EXISTS a00_guard_tenant_role_permission_domain ON public.role_permissions;
CREATE TRIGGER a00_guard_tenant_role_permission_domain BEFORE INSERT OR UPDATE OF permission_key ON public.role_permissions FOR EACH ROW EXECUTE FUNCTION app_private.guard_tenant_role_permission_domain();
DROP TRIGGER IF EXISTS a10_bump_authz_version ON public.role_permissions;
CREATE TRIGGER a10_bump_authz_version AFTER INSERT OR DELETE OR UPDATE ON public.role_permissions FOR EACH ROW EXECUTE FUNCTION app_private.bump_org_authorization_version();

-- public.rooms
DROP TRIGGER IF EXISTS trg_autofill_org ON public.rooms;
CREATE TRIGGER trg_autofill_org BEFORE INSERT ON public.rooms FOR EACH ROW EXECUTE FUNCTION public._autofill_org();

-- public.services
DROP TRIGGER IF EXISTS trg_autofill_org ON public.services;
CREATE TRIGGER trg_autofill_org BEFORE INSERT ON public.services FOR EACH ROW EXECUTE FUNCTION public._autofill_org();

-- public.tenants
DROP TRIGGER IF EXISTS trg_autofill_org ON public.tenants;
CREATE TRIGGER trg_autofill_org BEFORE INSERT ON public.tenants FOR EACH ROW EXECUTE FUNCTION public._autofill_org();

-- public.vehicles
DROP TRIGGER IF EXISTS trg_autofill_org ON public.vehicles;
CREATE TRIGGER trg_autofill_org BEFORE INSERT ON public.vehicles FOR EACH ROW EXECUTE FUNCTION public._autofill_org();

-- =====================================================================
-- MUC 6 — ROW LEVEL SECURITY (10)
-- =====================================================================

ALTER TABLE public.authorization_migration_exceptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.authorization_scopes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.cashbook_possession_bindings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.member_override_scopes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.member_permission_overrides ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.organization_roles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.permission_definitions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.role_binding_scopes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.role_bindings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.role_permissions ENABLE ROW LEVEL SECURITY;

-- =====================================================================
-- MUC 7 — POLICY (10)
-- =====================================================================

DROP POLICY IF EXISTS authorization_migration_exceptions_select_super ON public.authorization_migration_exceptions;
CREATE POLICY authorization_migration_exceptions_select_super ON public.authorization_migration_exceptions
  AS PERMISSIVE FOR SELECT
  TO authenticated
  USING (public.is_super_admin());

DROP POLICY IF EXISTS authorization_scopes_select_super ON public.authorization_scopes;
CREATE POLICY authorization_scopes_select_super ON public.authorization_scopes
  AS PERMISSIVE FOR SELECT
  TO authenticated
  USING (public.is_super_admin());

DROP POLICY IF EXISTS cashbook_possession_select_super ON public.cashbook_possession_bindings;
CREATE POLICY cashbook_possession_select_super ON public.cashbook_possession_bindings
  AS PERMISSIVE FOR SELECT
  TO authenticated
  USING (public.is_super_admin());

DROP POLICY IF EXISTS member_override_scopes_select_super ON public.member_override_scopes;
CREATE POLICY member_override_scopes_select_super ON public.member_override_scopes
  AS PERMISSIVE FOR SELECT
  TO authenticated
  USING (public.is_super_admin());

DROP POLICY IF EXISTS member_permission_overrides_select_super ON public.member_permission_overrides;
CREATE POLICY member_permission_overrides_select_super ON public.member_permission_overrides
  AS PERMISSIVE FOR SELECT
  TO authenticated
  USING (public.is_super_admin());

DROP POLICY IF EXISTS organization_roles_select_super ON public.organization_roles;
CREATE POLICY organization_roles_select_super ON public.organization_roles
  AS PERMISSIVE FOR SELECT
  TO authenticated
  USING (public.is_super_admin());

DROP POLICY IF EXISTS permission_definitions_select_super ON public.permission_definitions;
CREATE POLICY permission_definitions_select_super ON public.permission_definitions
  AS PERMISSIVE FOR SELECT
  TO authenticated
  USING (public.is_super_admin());

DROP POLICY IF EXISTS role_binding_scopes_select_super ON public.role_binding_scopes;
CREATE POLICY role_binding_scopes_select_super ON public.role_binding_scopes
  AS PERMISSIVE FOR SELECT
  TO authenticated
  USING (public.is_super_admin());

DROP POLICY IF EXISTS role_bindings_select_super ON public.role_bindings;
CREATE POLICY role_bindings_select_super ON public.role_bindings
  AS PERMISSIVE FOR SELECT
  TO authenticated
  USING (public.is_super_admin());

DROP POLICY IF EXISTS role_permissions_select_super ON public.role_permissions;
CREATE POLICY role_permissions_select_super ON public.role_permissions
  AS PERMISSIVE FOR SELECT
  TO authenticated
  USING (public.is_super_admin());


-- =====================================================================
-- MUC 8 — GRANT / REVOKE (41 khoi: 14 bang + 27 ham)
-- Viet tuong minh tu pg_class.relacl / pg_proc.proacl.
-- =====================================================================

REVOKE ALL ON TABLE app_private.ie_auto_approve_config FROM PUBLIC;

REVOKE ALL ON TABLE app_private.ie_transition_authorization FROM PUBLIC;

REVOKE ALL ON TABLE app_private.income_expense_flow_ownership FROM PUBLIC;
GRANT INSERT ON TABLE app_private.income_expense_flow_ownership TO ie_canonical_writer;

REVOKE ALL ON TABLE app_private.income_expense_flow_ownership_events FROM PUBLIC;
GRANT INSERT ON TABLE app_private.income_expense_flow_ownership_events TO ie_canonical_writer;

REVOKE ALL ON TABLE public.authorization_migration_exceptions FROM PUBLIC;
GRANT INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public.authorization_migration_exceptions TO service_role;
GRANT SELECT ON TABLE public.authorization_migration_exceptions TO authenticated;

REVOKE ALL ON TABLE public.authorization_scopes FROM PUBLIC;
GRANT INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public.authorization_scopes TO service_role;
GRANT SELECT ON TABLE public.authorization_scopes TO authenticated;

REVOKE ALL ON TABLE public.cashbook_possession_bindings FROM PUBLIC;
GRANT SELECT ON TABLE public.cashbook_possession_bindings TO authenticated;

REVOKE ALL ON TABLE public.member_override_scopes FROM PUBLIC;
GRANT INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public.member_override_scopes TO service_role;
GRANT SELECT ON TABLE public.member_override_scopes TO authenticated;

REVOKE ALL ON TABLE public.member_permission_overrides FROM PUBLIC;
GRANT INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public.member_permission_overrides TO service_role;
GRANT SELECT ON TABLE public.member_permission_overrides TO authenticated;

REVOKE ALL ON TABLE public.organization_roles FROM PUBLIC;
GRANT INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public.organization_roles TO service_role;
GRANT SELECT ON TABLE public.organization_roles TO authenticated;

REVOKE ALL ON TABLE public.permission_definitions FROM PUBLIC;
GRANT INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public.permission_definitions TO service_role;
GRANT SELECT ON TABLE public.permission_definitions TO authenticated;

REVOKE ALL ON TABLE public.role_binding_scopes FROM PUBLIC;
GRANT INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public.role_binding_scopes TO service_role;
GRANT SELECT ON TABLE public.role_binding_scopes TO authenticated;

REVOKE ALL ON TABLE public.role_bindings FROM PUBLIC;
GRANT INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public.role_bindings TO service_role;
GRANT SELECT ON TABLE public.role_bindings TO authenticated;

REVOKE ALL ON TABLE public.role_permissions FROM PUBLIC;
GRANT INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public.role_permissions TO service_role;
GRANT SELECT ON TABLE public.role_permissions TO authenticated;

REVOKE ALL ON FUNCTION app_private.authorize_tenant_action_v3(uuid,uuid,text,uuid,uuid) FROM PUBLIC;

REVOKE ALL ON FUNCTION app_private.raise_malformed_override(uuid,text) FROM PUBLIC;

REVOKE ALL ON FUNCTION app_private.lock_org_for_decision_v1(uuid) FROM PUBLIC;

REVOKE ALL ON FUNCTION app_private.bump_org_authorization_version() FROM PUBLIC;

REVOKE ALL ON FUNCTION app_private.assert_override_scope_shape() FROM PUBLIC;

REVOKE ALL ON FUNCTION app_private.guard_tenant_role_permission_domain() FROM PUBLIC;

REVOKE ALL ON FUNCTION public._autofill_org() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public._autofill_org() TO service_role;

REVOKE ALL ON FUNCTION public.approve_meter_reading_v1(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.approve_meter_reading_v1(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.approve_meter_reading_v1(uuid) TO service_role;

REVOKE ALL ON FUNCTION public.bulk_approve_meter_readings_v1(uuid[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.bulk_approve_meter_readings_v1(uuid[]) TO authenticated;
GRANT EXECUTE ON FUNCTION public.bulk_approve_meter_readings_v1(uuid[]) TO service_role;

REVOKE ALL ON FUNCTION public.unapprove_meter_reading_v1(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.unapprove_meter_reading_v1(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.unapprove_meter_reading_v1(uuid) TO service_role;

REVOKE ALL ON FUNCTION public.can_do_on_building(text,text,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.can_do_on_building(text,text,uuid) TO PUBLIC;
GRANT EXECUTE ON FUNCTION public.can_do_on_building(text,text,uuid) TO anon;
GRANT EXECUTE ON FUNCTION public.can_do_on_building(text,text,uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.can_do_on_building(text,text,uuid) TO service_role;

REVOKE ALL ON FUNCTION public.get_ie_auto_approve_threshold_v1() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_ie_auto_approve_threshold_v1() TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_ie_auto_approve_threshold_v1() TO service_role;

REVOKE ALL ON FUNCTION public.set_ie_auto_approve_threshold_v1(numeric) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.set_ie_auto_approve_threshold_v1(numeric) TO authenticated;
GRANT EXECUTE ON FUNCTION public.set_ie_auto_approve_threshold_v1(numeric) TO service_role;

REVOKE ALL ON FUNCTION public.is_super_admin() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.is_super_admin() TO PUBLIC;
GRANT EXECUTE ON FUNCTION public.is_super_admin() TO anon;
GRANT EXECUTE ON FUNCTION public.is_super_admin() TO authenticated;
GRANT EXECUTE ON FUNCTION public.is_super_admin() TO service_role;

REVOKE ALL ON FUNCTION app_private.guard_income_expense_owned_payload() FROM PUBLIC;

REVOKE ALL ON FUNCTION app_private.guard_income_expense_owned_items() FROM PUBLIC;

REVOKE ALL ON FUNCTION app_private.guard_income_expense_truncate() FROM PUBLIC;

REVOKE ALL ON FUNCTION app_private.is_income_expense_flow_owned(uuid) FROM PUBLIC;

REVOKE ALL ON FUNCTION app_private.reject_income_expense_flow_mutation() FROM PUBLIC;

REVOKE ALL ON FUNCTION app_private.reject_income_expense_flow_truncate() FROM PUBLIC;

REVOKE ALL ON FUNCTION app_private.current_uid_v1() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_private.current_uid_v1() TO ie_canonical_writer;

REVOKE ALL ON FUNCTION app_private.has_ie_claim_capability_v1(text) FROM PUBLIC;

REVOKE ALL ON FUNCTION app_private.ie_lock_row_for_claim_v1(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_private.ie_lock_row_for_claim_v1(uuid) TO ie_canonical_writer;

REVOKE ALL ON FUNCTION app_private.ie_lock_operation_for_claim_v1(uuid,text,uuid,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_private.ie_lock_operation_for_claim_v1(uuid,text,uuid,text,text) TO ie_canonical_writer;

REVOKE ALL ON FUNCTION app_private.claim_canonical_income_expense_draft_v1(uuid,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_private.claim_canonical_income_expense_draft_v1(uuid,text) TO ie_canonical_writer;

REVOKE ALL ON FUNCTION app_private.claim_canonical_income_expense_draft_v1(uuid,text,text) FROM PUBLIC;

REVOKE ALL ON FUNCTION app_private.append_income_expense_event_v1(uuid,uuid,text,uuid,text,text,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_private.append_income_expense_event_v1(uuid,uuid,text,uuid,text,text,text,text) TO ie_canonical_writer;


-- =====================================================================
-- MUC 9 — COMMENT (1)
-- =====================================================================

COMMENT ON TABLE app_private.ie_auto_approve_config IS 'Ngưỡng tự duyệt phiếu CHI thường (t5_23). NULL/không dòng = tự duyệt mọi phiếu chi thường (hành vi hiện tại); đặt số = chi >= ngưỡng sinh ở NHÁP.';

COMMIT;

-- =====================================================================
-- HET FILE — 222 khoi doi tuong.
-- =====================================================================
