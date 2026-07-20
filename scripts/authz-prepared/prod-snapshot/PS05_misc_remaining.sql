-- =====================================================================
-- PS05_misc_remaining.sql
--
-- SNAPSHOT sinh tu dong tu PROD ngay 2026-07-19 — KHONG SUA TAY.
-- Bo sung phan CON THIEU cua bo snapshot PS01..PS04 (do completeness-critic
-- doi chieu catalog PROD phat hien). Dung cho khoi phuc tham hoa (DR).
-- Nguon: catalog PROD (pg_proc / pg_get_functiondef / pg_constraint /
--        pg_get_indexdef / pg_trigger / pg_attribute / pg_class.relacl).
-- Muon doi hanh vi: sua tren DB bang migration roi SINH LAI file nay.
--
-- ---------------------------------------------------------------------
-- DANH SACH DOI TUONG  (tong: 8 bang / 28 constraint / 2 index /
--   62 ham / 13 trigger)
-- ---------------------------------------------------------------------
-- (a) ROLLOUT / FEATURE FLAG  (control-plane cua 15/15 flag canonical)
--     bang: server_feature_flags, server_feature_flag_canary_orgs,
--           server_feature_flag_events, server_feature_flag_operations
--     ham : evaluate_feature_route, set_feature_route_v1,
--           guard_rollout_ledger_immutable
-- (b) AUDIT CHAIN (tamper-evidence so ke IE)
--     bang: income_expense_audit_chain_heads
--     ham : verify_income_expense_audit_chain_v1, guard_audit_log_write,
--           guard_audit_log_append_only, guard_audit_log_truncate
-- (c) SELF-APPROVE / EMERGENCY / POSSESSION (engine duyet mo rong)
--     bang: self_approve_limits, tenant_emergency_denies,
--           cashbook_possession_candidates
-- (d) RPC ENGINE t5_26 + AUTHZ CORE (lop public — DR-hole da bao cao)
--     ham : list_my_pending_approvals_v1, decide_financial_request_v2,
--           withdraw_financial_request_v1, authorize_v2, effective_perms_v2,
--           set_membership_status_v1, submit_financial_voucher,
--           _eval_approval_rule, nrm_vn
-- (e) OFF-BOARDING / ROLE-BINDING / OWNERSHIP
--     ham : is_actor_offboarded_v1, sync_revoke_role_binding_v1,
--           guard_last_owner, authorize_income_expense_on_building,
--           grant_ie_claim_capability_v1, ie_actor_display_name_v1,
--           accrue_salary_paid_on_approve
-- (f) MONEY WRITER _vN (di qua engine duyet) — IE/cashbook/salary/contract/
--     meter/payment: approve_/cancel_/create_income_expense_v1, verify_..,
--     record_invoice_payment_v2/v3, create_/update_/archive_cashbook..,
--     salary_payout_v1, manager_salary_payout_v1, distribute_shareholder..,
--     lock_/unlock_salary/profit_month, create_contract_v1, approve_/reject_
--     contract_termination_v1, create_reservation_deposit_v1,
--     request_opening_balance_adjustment_v1, attach_payment_receipt_v1,
--     create_/update_/delete_/bulk_*_meter_readings_v1, generate_*_v2 ...
-- (g) READ-ONLY REPORTING _vN (doc, khong ghi tien/quyen — dua vao cho du
--     bo _vN: get_change_breakdown_v2, get_deposit_breakdown_v2,
--     get_invoice_statistics_v2, get_meters_without_readings_v2,
--     get_salary_progress_v5, occupancy_snapshot_v2, occupancy_upcoming_vacancy_v2)
--
-- ---------------------------------------------------------------------
-- KHONG NAM TRONG FILE NAY (phu thuoc — phai co TRUOC khi chay)
-- ---------------------------------------------------------------------
-- * Chay PS05 SAU CUNG: sau PS01(engine)+PS02(payment/invoice)+PS03(storage)+
--   PS04(rbac) VA sau snapshot bang nen nghiep vu. Nhieu ham o day goi bang/
--   ham do 4 file kia hoac base-schema tao (approval_*, authorization_*,
--   income_expenses, invoices, payments, cashbooks, meters, salary...).
-- * Bang nen tham chieu boi FK/trigger o file nay (KHONG do file nay tao):
--   public.organizations, public.organization_memberships, public.staff_assignments,
--   public.income_expenses, public.income_expense_audit_log, public.invoice_audit_log,
--   public.cashbook_possession_bindings (PS04).
-- * 9 trigger cross-table (muc 5) gan len bang nghiep vu ngoai file -> boc
--   to_regclass(...) IS NOT NULL, bang chua ton tai thi BO QUA co canh bao
--   (khong lam vo restore).
-- * SET check_function_bodies = off (giong pg_dump): cho phep tao ham SQL-lang
--   (list_my_pending_approvals_v1, effective_perms_v2, _eval_approval_rule,
--   get_*_breakdown_v2, occupancy_*_v2) ma khong phu thuoc thu tu resolve.
-- * Role Supabase (anon/authenticated/service_role) + ie_canonical_writer coi
--   nhu da co (PS04 tao ie_canonical_writer; file nay cung tu tao neu thieu).
--
-- ---------------------------------------------------------------------
-- CACH CHAY LAI
-- ---------------------------------------------------------------------
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f PS05_misc_remaining.sql
-- Idempotent: IF NOT EXISTS / OR REPLACE / DROP ... IF EXISTS truoc CREATE /
-- DO-block cho constraint & role. Chay lai nhieu lan khong loi.
-- =====================================================================

\set ON_ERROR_STOP on

-- search_path co dinh + tat kiem than ham (giong pg_dump) de restore tat dinh.
SET search_path = pg_catalog, public, app_private;
SET check_function_bodies = off;

BEGIN;


-- =====================================================================
-- MUC 0 — SCHEMA + ROLE tien de
-- =====================================================================

CREATE SCHEMA IF NOT EXISTS app_private;

DO $ps05$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ie_canonical_writer') THEN
    CREATE ROLE ie_canonical_writer NOLOGIN NOINHERIT;
  END IF;
END $ps05$;


-- =====================================================================
-- MUC 1 — BANG app_private (8)
-- =====================================================================

CREATE TABLE IF NOT EXISTS app_private.cashbook_possession_candidates (
  candidate_key text NOT NULL,
  organization_id uuid NOT NULL,
  cashbook_id uuid NOT NULL,
  membership_id uuid,
  proposed_kind text NOT NULL,
  source_kind text NOT NULL,
  source_relation text NOT NULL,
  source_row_id uuid,
  source_user_id uuid,
  status text DEFAULT 'PENDING_REVIEW'::text NOT NULL,
  evidence jsonb DEFAULT '{}'::jsonb NOT NULL,
  reviewed_by uuid,
  reviewed_at timestamp with time zone,
  review_reason text,
  materialized_binding_id uuid,
  version bigint DEFAULT 1 NOT NULL,
  updated_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
  created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL
);

CREATE TABLE IF NOT EXISTS app_private.income_expense_audit_chain_heads (
  organization_id uuid NOT NULL,
  last_sequence_no bigint DEFAULT 0 NOT NULL,
  last_event_hash text DEFAULT repeat('0'::text, 64) NOT NULL,
  updated_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL
);

CREATE TABLE IF NOT EXISTS app_private.self_approve_limits (
  organization_id uuid NOT NULL,
  version bigint DEFAULT 1 NOT NULL,
  max_single_amount_vnd numeric(15,2) DEFAULT 0 NOT NULL,
  updated_by uuid,
  updated_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL
);

CREATE TABLE IF NOT EXISTS app_private.server_feature_flag_canary_orgs (
  feature_key text NOT NULL,
  organization_id uuid NOT NULL,
  added_by uuid,
  added_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS app_private.server_feature_flag_events (
  id bigint NOT NULL,
  feature_key text NOT NULL,
  event_type text NOT NULL,
  before_mode text,
  after_mode text,
  before_version bigint,
  after_version bigint,
  detail jsonb,
  actor uuid,
  created_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS app_private.server_feature_flag_operations (
  id bigint NOT NULL,
  feature_key text NOT NULL,
  config_version bigint NOT NULL,
  operation_key text NOT NULL,
  organization_id uuid NOT NULL,
  amount_vnd numeric(15,2) DEFAULT 0 NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS app_private.server_feature_flags (
  feature_key text NOT NULL,
  domain text NOT NULL,
  risk_class text DEFAULT 'MONEY'::text NOT NULL,
  mode text DEFAULT 'OFF'::text NOT NULL,
  force_freeze boolean DEFAULT false NOT NULL,
  config_version bigint DEFAULT 1 NOT NULL,
  starts_at timestamp with time zone,
  ends_at timestamp with time zone,
  max_operation_count integer DEFAULT 0 NOT NULL,
  max_single_amount_vnd numeric(15,2) DEFAULT 0 NOT NULL,
  max_total_amount_vnd numeric(15,2) DEFAULT 0 NOT NULL,
  commit_sha text,
  migration_sha256 text,
  maintenance_window_id text,
  approval_reference text,
  reason text,
  updated_by uuid,
  updated_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS app_private.tenant_emergency_denies (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  organization_id uuid NOT NULL,
  permission_key text,
  active_from timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
  expires_at timestamp with time zone,
  reason text NOT NULL,
  created_by uuid,
  created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL
);


-- =====================================================================
-- MUC 2 — CONSTRAINT (28)  [PK -> UNIQUE -> CHECK -> FK], boc DO/EXCEPTION
-- =====================================================================

DO $ps05$ BEGIN
  ALTER TABLE app_private.cashbook_possession_candidates ADD CONSTRAINT cashbook_possession_candidates_pkey PRIMARY KEY (candidate_key);
EXCEPTION WHEN duplicate_table OR duplicate_object THEN NULL;
END $ps05$;

DO $ps05$ BEGIN
  ALTER TABLE app_private.cashbook_possession_candidates ADD CONSTRAINT cashbook_possession_candidates_check CHECK ((((status = 'PENDING_REVIEW'::text) AND (reviewed_at IS NULL)) OR ((status = 'AMBIGUOUS'::text) AND (reviewed_at IS NOT NULL) AND (review_reason IS NOT NULL)) OR ((status = ANY (ARRAY['APPROVED'::text, 'REJECTED'::text])) AND (reviewed_at IS NOT NULL) AND (reviewed_by IS NOT NULL) AND (review_reason IS NOT NULL))));
EXCEPTION WHEN duplicate_table OR duplicate_object THEN NULL;
END $ps05$;

DO $ps05$ BEGIN
  ALTER TABLE app_private.cashbook_possession_candidates ADD CONSTRAINT cashbook_possession_candidates_check1 CHECK (((status <> 'APPROVED'::text) OR (membership_id IS NOT NULL)));
EXCEPTION WHEN duplicate_table OR duplicate_object THEN NULL;
END $ps05$;

DO $ps05$ BEGIN
  ALTER TABLE app_private.cashbook_possession_candidates ADD CONSTRAINT cashbook_possession_candidates_check2 CHECK (((reviewed_by IS NULL) OR (source_user_id IS NULL) OR (reviewed_by <> source_user_id)));
EXCEPTION WHEN duplicate_table OR duplicate_object THEN NULL;
END $ps05$;

DO $ps05$ BEGIN
  ALTER TABLE app_private.cashbook_possession_candidates ADD CONSTRAINT cashbook_possession_candidates_proposed_kind_check CHECK ((proposed_kind = ANY (ARRAY['CUSTODIAN'::text, 'OPERATOR'::text])));
EXCEPTION WHEN duplicate_table OR duplicate_object THEN NULL;
END $ps05$;

DO $ps05$ BEGIN
  ALTER TABLE app_private.cashbook_possession_candidates ADD CONSTRAINT cashbook_possession_candidates_status_check CHECK ((status = ANY (ARRAY['PENDING_REVIEW'::text, 'APPROVED'::text, 'REJECTED'::text, 'AMBIGUOUS'::text])));
EXCEPTION WHEN duplicate_table OR duplicate_object THEN NULL;
END $ps05$;

DO $ps05$ BEGIN
  ALTER TABLE app_private.cashbook_possession_candidates ADD CONSTRAINT cashbook_possession_candidates_materialized_binding_id_fkey FOREIGN KEY (materialized_binding_id) REFERENCES cashbook_possession_bindings(id);
EXCEPTION WHEN duplicate_table OR duplicate_object THEN NULL;
END $ps05$;

DO $ps05$ BEGIN
  ALTER TABLE app_private.income_expense_audit_chain_heads ADD CONSTRAINT income_expense_audit_chain_heads_pkey PRIMARY KEY (organization_id);
EXCEPTION WHEN duplicate_table OR duplicate_object THEN NULL;
END $ps05$;

DO $ps05$ BEGIN
  ALTER TABLE app_private.income_expense_audit_chain_heads ADD CONSTRAINT income_expense_audit_chain_heads_last_event_hash_check CHECK ((last_event_hash ~ '^[0-9a-f]{64}$'::text));
EXCEPTION WHEN duplicate_table OR duplicate_object THEN NULL;
END $ps05$;

DO $ps05$ BEGIN
  ALTER TABLE app_private.income_expense_audit_chain_heads ADD CONSTRAINT income_expense_audit_chain_heads_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE RESTRICT;
EXCEPTION WHEN duplicate_table OR duplicate_object THEN NULL;
END $ps05$;

DO $ps05$ BEGIN
  ALTER TABLE app_private.self_approve_limits ADD CONSTRAINT self_approve_limits_pkey PRIMARY KEY (organization_id, version);
EXCEPTION WHEN duplicate_table OR duplicate_object THEN NULL;
END $ps05$;

DO $ps05$ BEGIN
  ALTER TABLE app_private.self_approve_limits ADD CONSTRAINT self_approve_limits_max_single_amount_vnd_check CHECK ((max_single_amount_vnd >= (0)::numeric));
EXCEPTION WHEN duplicate_table OR duplicate_object THEN NULL;
END $ps05$;

DO $ps05$ BEGIN
  ALTER TABLE app_private.self_approve_limits ADD CONSTRAINT self_approve_limits_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE RESTRICT;
EXCEPTION WHEN duplicate_table OR duplicate_object THEN NULL;
END $ps05$;

DO $ps05$ BEGIN
  ALTER TABLE app_private.server_feature_flag_canary_orgs ADD CONSTRAINT server_feature_flag_canary_orgs_pkey PRIMARY KEY (feature_key, organization_id);
EXCEPTION WHEN duplicate_table OR duplicate_object THEN NULL;
END $ps05$;

DO $ps05$ BEGIN
  ALTER TABLE app_private.server_feature_flag_canary_orgs ADD CONSTRAINT server_feature_flag_canary_orgs_feature_key_fkey FOREIGN KEY (feature_key) REFERENCES app_private.server_feature_flags(feature_key);
EXCEPTION WHEN duplicate_table OR duplicate_object THEN NULL;
END $ps05$;

DO $ps05$ BEGIN
  ALTER TABLE app_private.server_feature_flag_canary_orgs ADD CONSTRAINT server_feature_flag_canary_orgs_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES organizations(id);
EXCEPTION WHEN duplicate_table OR duplicate_object THEN NULL;
END $ps05$;

DO $ps05$ BEGIN
  ALTER TABLE app_private.server_feature_flag_events ADD CONSTRAINT server_feature_flag_events_pkey PRIMARY KEY (id);
EXCEPTION WHEN duplicate_table OR duplicate_object THEN NULL;
END $ps05$;

DO $ps05$ BEGIN
  ALTER TABLE app_private.server_feature_flag_operations ADD CONSTRAINT server_feature_flag_operations_pkey PRIMARY KEY (id);
EXCEPTION WHEN duplicate_table OR duplicate_object THEN NULL;
END $ps05$;

DO $ps05$ BEGIN
  ALTER TABLE app_private.server_feature_flag_operations ADD CONSTRAINT server_feature_flag_operation_feature_key_config_version_op_key UNIQUE (feature_key, config_version, operation_key);
EXCEPTION WHEN duplicate_table OR duplicate_object THEN NULL;
END $ps05$;

DO $ps05$ BEGIN
  ALTER TABLE app_private.server_feature_flag_operations ADD CONSTRAINT server_feature_flag_operations_amount_nonneg CHECK ((amount_vnd >= (0)::numeric));
EXCEPTION WHEN duplicate_table OR duplicate_object THEN NULL;
END $ps05$;

DO $ps05$ BEGIN
  ALTER TABLE app_private.server_feature_flags ADD CONSTRAINT server_feature_flags_pkey PRIMARY KEY (feature_key);
EXCEPTION WHEN duplicate_table OR duplicate_object THEN NULL;
END $ps05$;

DO $ps05$ BEGIN
  ALTER TABLE app_private.server_feature_flags ADD CONSTRAINT server_feature_flags_canary_limits_check CHECK (((mode <> 'CANARY'::text) OR ((starts_at IS NOT NULL) AND (ends_at IS NOT NULL) AND isfinite(starts_at) AND isfinite(ends_at) AND (starts_at < ends_at) AND (max_operation_count > 0) AND (max_single_amount_vnd > (0)::numeric) AND (max_total_amount_vnd > (0)::numeric))));
EXCEPTION WHEN duplicate_table OR duplicate_object THEN NULL;
END $ps05$;

DO $ps05$ BEGIN
  ALTER TABLE app_private.server_feature_flags ADD CONSTRAINT server_feature_flags_finite_values_check CHECK ((((starts_at IS NULL) OR isfinite(starts_at)) AND ((ends_at IS NULL) OR isfinite(ends_at)) AND ((max_single_amount_vnd)::text <> ALL (ARRAY['NaN'::text, 'Infinity'::text, '-Infinity'::text])) AND ((max_total_amount_vnd)::text <> ALL (ARRAY['NaN'::text, 'Infinity'::text, '-Infinity'::text]))));
EXCEPTION WHEN duplicate_table OR duplicate_object THEN NULL;
END $ps05$;

DO $ps05$ BEGIN
  ALTER TABLE app_private.server_feature_flags ADD CONSTRAINT server_feature_flags_mode_check CHECK ((mode = ANY (ARRAY['OFF'::text, 'SHADOW'::text, 'CANARY'::text, 'ON'::text])));
EXCEPTION WHEN duplicate_table OR duplicate_object THEN NULL;
END $ps05$;

DO $ps05$ BEGIN
  ALTER TABLE app_private.server_feature_flags ADD CONSTRAINT server_feature_flags_risk_class_check CHECK ((risk_class = ANY (ARRAY['MONEY'::text, 'NON_MONEY'::text])));
EXCEPTION WHEN duplicate_table OR duplicate_object THEN NULL;
END $ps05$;

DO $ps05$ BEGIN
  ALTER TABLE app_private.tenant_emergency_denies ADD CONSTRAINT tenant_emergency_denies_pkey PRIMARY KEY (id);
EXCEPTION WHEN duplicate_table OR duplicate_object THEN NULL;
END $ps05$;

DO $ps05$ BEGIN
  ALTER TABLE app_private.tenant_emergency_denies ADD CONSTRAINT tenant_emergency_denies_check CHECK (((expires_at IS NULL) OR (expires_at > active_from)));
EXCEPTION WHEN duplicate_table OR duplicate_object THEN NULL;
END $ps05$;

DO $ps05$ BEGIN
  ALTER TABLE app_private.tenant_emergency_denies ADD CONSTRAINT tenant_emergency_denies_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE RESTRICT;
EXCEPTION WHEN duplicate_table OR duplicate_object THEN NULL;
END $ps05$;


-- =====================================================================
-- MUC 3 — INDEX (2)  [khong ke index do PK/UNIQUE sinh]
-- =====================================================================

CREATE INDEX IF NOT EXISTS cashbook_possession_candidates_review_idx ON app_private.cashbook_possession_candidates USING btree (organization_id, cashbook_id, status);
CREATE INDEX IF NOT EXISTS tenant_emergency_denies_active_idx ON app_private.tenant_emergency_denies USING btree (organization_id, active_from, expires_at);


-- =====================================================================
-- MUC 4 — FUNCTION (62: 14 app_private + 48 public)
-- =====================================================================

-- --- app_private ---

CREATE OR REPLACE FUNCTION app_private.guard_audit_log_write()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'app_private'
AS $function$

begin

  if tg_op in ('UPDATE', 'DELETE') then

    raise exception 'income_expense_audit_log is append-only'

      using errcode = '55000';

  end if;

  -- INSERT: chained rows only (legacy all-NULL inserts are no longer allowed;

  -- everything must route through the primitive, which stamps the chain).

  if new.event_hash is null then

    raise exception 'audit inserts must go through append_income_expense_event_v1'

      using errcode = '55000';

  end if;

  return new;

end;

$function$
;

CREATE OR REPLACE FUNCTION app_private.guard_audit_log_append_only()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog'
AS $function$
begin
  raise exception 'audit log is append-only (%. %)', tg_table_name, tg_op
    using errcode = '55000';
end;
$function$
;

CREATE OR REPLACE FUNCTION app_private.guard_audit_log_truncate()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog'
AS $function$

begin

  raise exception 'income_expense_audit_log cannot be truncated'

    using errcode = '55000';

end;

$function$
;

CREATE OR REPLACE FUNCTION app_private.guard_rollout_ledger_immutable()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog'
AS $function$

begin

  raise exception 'rollout ledger is append-only' using errcode = '55000';

end;

$function$
;

CREATE OR REPLACE FUNCTION app_private.guard_last_owner()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
declare v_remaining int;
begin
  if old.member_type = 'OWNER' and old.status = 'ACTIVE' then
    select count(*) into v_remaining
      from public.organization_memberships m
     where m.organization_id = old.organization_id
       and m.member_type = 'OWNER' and m.status = 'ACTIVE' and m.id <> old.id;
    if tg_op = 'UPDATE' and new.member_type = 'OWNER' and new.status = 'ACTIVE'
       and (new.valid_to is null or new.valid_to > now()) then
      v_remaining := v_remaining + 1;
    end if;
    if v_remaining < 1
       and exists (select 1 from public.organizations o where o.id = old.organization_id and o.status = 'ACTIVE') then
      raise exception 'Không thể gỡ/tạm ngưng chủ sở hữu CUỐI CÙNG của tổ chức đang hoạt động'
        using errcode = '23514';
    end if;
  end if;
  return coalesce(new, old);
end;
$function$
;

CREATE OR REPLACE FUNCTION app_private.evaluate_feature_route(p_feature_key text, p_organization_id uuid)
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'app_private', 'public'
AS $function$

DECLARE

  f app_private.server_feature_flags%ROWTYPE;

  v_now timestamptz := clock_timestamp();

BEGIN

  SELECT * INTO f

    FROM app_private.server_feature_flags

   WHERE feature_key = p_feature_key;

  IF NOT FOUND THEN RETURN 'LEGACY'; END IF;

  IF f.force_freeze THEN RETURN 'FROZEN'; END IF;

  IF f.mode = 'OFF' THEN RETURN 'LEGACY'; END IF;

  IF f.mode = 'SHADOW' THEN RETURN 'SHADOW'; END IF;

  IF NULLIF(btrim(f.commit_sha), '') IS NULL

     OR NULLIF(btrim(f.migration_sha256), '') IS NULL

     OR NULLIF(btrim(f.maintenance_window_id), '') IS NULL

     OR NULLIF(btrim(f.approval_reference), '') IS NULL THEN

    RETURN 'FROZEN';

  END IF;

  IF f.mode = 'ON' THEN RETURN 'CANONICAL'; END IF;



  IF NOT EXISTS (

    SELECT 1

      FROM app_private.server_feature_flag_canary_orgs c

     WHERE c.feature_key = p_feature_key

       AND c.organization_id = p_organization_id

  ) THEN RETURN 'LEGACY'; END IF;

  IF f.starts_at IS NULL

     OR f.ends_at IS NULL

     OR NOT isfinite(f.starts_at)

     OR NOT isfinite(f.ends_at)

     OR f.starts_at >= f.ends_at THEN

    RETURN 'FROZEN';

  END IF;

  IF v_now < f.starts_at THEN RETURN 'LEGACY'; END IF;

  IF v_now >= f.ends_at THEN RETURN 'FROZEN'; END IF;

  IF f.max_operation_count <= 0

     OR f.max_single_amount_vnd::text IN ('NaN', 'Infinity', '-Infinity')

     OR f.max_total_amount_vnd::text IN ('NaN', 'Infinity', '-Infinity')

     OR f.max_single_amount_vnd <= 0

     OR f.max_total_amount_vnd <= 0 THEN

    RETURN 'FROZEN';

  END IF;

  IF (

    SELECT count(*)

      FROM app_private.server_feature_flag_operations o

     WHERE o.feature_key = f.feature_key

       AND o.config_version = f.config_version

  ) >= f.max_operation_count THEN

    RETURN 'FROZEN';

  END IF;

  RETURN 'CANONICAL';

END;

$function$
;

CREATE OR REPLACE FUNCTION app_private.set_feature_route_v1(p_feature_key text, p_expected_config_version bigint, p_mode text, p_starts_at timestamp with time zone, p_ends_at timestamp with time zone, p_max_operation_count integer, p_max_single_amount_vnd numeric, p_max_total_amount_vnd numeric, p_commit_sha text, p_migration_sha256 text, p_maintenance_window_id text, p_approval_reference text, p_actor uuid, p_reason text)
 RETURNS bigint
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'app_private'
AS $function$

declare

  v_flag app_private.server_feature_flags;

  v_new_version bigint;

begin

  if p_mode not in ('OFF','SHADOW','CANARY','ON') then

    raise exception 'invalid mode %', p_mode using errcode='22023';

  end if;



  select * into v_flag from app_private.server_feature_flags

   where feature_key = p_feature_key for update;

  if not found then

    raise exception 'feature % not found', p_feature_key using errcode='P0002';

  end if;

  -- CAS: caller must present the current config_version

  if v_flag.config_version <> p_expected_config_version then

    raise exception 'config_version conflict (have %, expected %)',

      v_flag.config_version, p_expected_config_version using errcode='40001';

  end if;



  -- release identity required for any active (ON/CANARY) mode

  if p_mode in ('ON','CANARY') then

    if p_commit_sha !~ '^[0-9a-f]{40}$'

       or p_migration_sha256 !~ '^[0-9a-f]{64}$'

       or coalesce(btrim(p_maintenance_window_id), '') = ''

       or coalesce(btrim(p_approval_reference), '') = '' then

      raise exception 'ON/CANARY requires full release identity' using errcode='22023';

    end if;

  end if;

  -- CANARY requires a finite half-open window and positive caps

  if p_mode = 'CANARY' then

    if p_starts_at is null or p_ends_at is null or p_ends_at <= p_starts_at then

      raise exception 'CANARY requires a finite half-open window' using errcode='22023';

    end if;

    if coalesce(p_max_operation_count,0) <= 0

       or coalesce(p_max_single_amount_vnd,0) <= 0

       or coalesce(p_max_total_amount_vnd,0) <= 0 then

      raise exception 'CANARY requires positive caps' using errcode='22023';

    end if;

  end if;



  v_new_version := v_flag.config_version + 1;



  update app_private.server_feature_flags

     set mode = p_mode,

         config_version = v_new_version,

         starts_at = p_starts_at,

         ends_at = p_ends_at,

         max_operation_count = coalesce(p_max_operation_count, 0),

         max_single_amount_vnd = coalesce(p_max_single_amount_vnd, 0),

         max_total_amount_vnd = coalesce(p_max_total_amount_vnd, 0),

         commit_sha = p_commit_sha,

         migration_sha256 = p_migration_sha256,

         maintenance_window_id = p_maintenance_window_id,

         approval_reference = p_approval_reference,

         reason = p_reason,

         updated_by = p_actor,

         updated_at = clock_timestamp()

   where feature_key = p_feature_key

     and config_version = p_expected_config_version;



  insert into app_private.server_feature_flag_events

    (feature_key, event_type, before_mode, after_mode,

     before_version, after_version, detail, actor, created_at)

  values

    (p_feature_key, 'ROUTE_CHANGED', v_flag.mode, p_mode,

     v_flag.config_version, v_new_version,

     jsonb_build_object('reason', p_reason), p_actor, clock_timestamp());



  return v_new_version;

end;

$function$
;

CREATE OR REPLACE FUNCTION app_private.authorize_income_expense_on_building(p_actor uuid, p_organization_id uuid, p_action text, p_building_id uuid)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$

BEGIN

  IF p_action NOT IN ('create', 'restricted_create') THEN

    RETURN false;

  END IF;



  -- Acquire the complete candidate witness graph in a deterministic order. A

  -- permission row inserted after this point cannot be used by this statement;

  -- revocations/edits of existing witnesses wait until it commits.

  PERFORM 1

    FROM public.organization_memberships grantor

   WHERE grantor.organization_id = p_organization_id

     AND grantor.member_type = 'OWNER'

     AND grantor.user_id IN (

       SELECT sa.user_id

         FROM public.staff_assignments sa

        WHERE sa.staff_id = p_actor

          AND sa.organization_id = p_organization_id

     )

   ORDER BY grantor.id

   FOR SHARE;

  PERFORM 1

    FROM public.staff_assignments sa

   WHERE sa.staff_id = p_actor

     AND sa.organization_id = p_organization_id

   ORDER BY sa.id

   FOR SHARE;

  PERFORM 1

    FROM public.roles r

   WHERE r.id IN (

     SELECT sa.role_id

       FROM public.staff_assignments sa

      WHERE sa.staff_id = p_actor

        AND sa.organization_id = p_organization_id

   )

   ORDER BY r.id

   FOR SHARE;

  PERFORM 1

    FROM public.areas a

   WHERE a.id IN (

     SELECT sa.area_id

       FROM public.staff_assignments sa

      WHERE sa.staff_id = p_actor

        AND sa.organization_id = p_organization_id

        AND sa.area_id IS NOT NULL

   )

   ORDER BY a.id

   FOR SHARE;

  PERFORM 1

    FROM public.area_buildings ab

   WHERE ab.building_id = p_building_id

     AND ab.area_id IN (

       SELECT sa.area_id

         FROM public.staff_assignments sa

        WHERE sa.staff_id = p_actor

          AND sa.organization_id = p_organization_id

          AND sa.area_id IS NOT NULL

     )

   ORDER BY ab.area_id, ab.building_id

   FOR SHARE;



  RETURN EXISTS (

    SELECT 1

      FROM public.staff_assignments sa

      JOIN public.roles r

        ON r.id = sa.role_id

       AND r.organization_id = p_organization_id

       AND r.user_id = sa.user_id

      JOIN public.organization_memberships grantor

        ON grantor.organization_id = p_organization_id

       AND grantor.user_id = sa.user_id

       AND grantor.member_type = 'OWNER'

       AND grantor.status = 'ACTIVE'

       AND grantor.valid_from <= clock_timestamp()

       AND (grantor.valid_to IS NULL OR clock_timestamp() < grantor.valid_to)

     WHERE sa.staff_id = p_actor

       AND sa.organization_id = p_organization_id

       AND jsonb_extract_path(

             COALESCE(sa.permissions, r.permissions),

             'income_expenses',

             p_action

           ) = 'true'::jsonb

       AND (

         sa.building_id = p_building_id

         OR (sa.building_id IS NULL AND sa.area_id IS NULL)

         OR jsonb_extract_path(

              COALESCE(sa.permissions, r.permissions),

              'income_expenses',

              'all_buildings'

            ) = 'true'::jsonb

         OR EXISTS (

           SELECT 1

             FROM public.area_buildings ab

             JOIN public.areas a

               ON a.id = ab.area_id

              AND a.organization_id = p_organization_id

              AND a.status = 'ACTIVE'

              AND a.deleted_at IS NULL

            WHERE ab.area_id = sa.area_id

              AND ab.building_id = p_building_id

              AND ab.organization_id = p_organization_id

         )

       )

  );

END;

$function$
;

CREATE OR REPLACE FUNCTION app_private.is_actor_offboarded_v1()
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'app_private'
AS $function$
  select auth.uid() is not null
     and exists (select 1 from public.organization_memberships m
                  where m.user_id = auth.uid())
     and not exists (select 1 from public.organization_memberships m
                      where m.user_id = auth.uid() and m.status = 'ACTIVE');
$function$
;

CREATE OR REPLACE FUNCTION app_private.sync_revoke_role_binding_v1()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'app_private'
AS $function$
declare
  v_org uuid;
begin
  -- Đóng mọi binding chuẩn hoá gắn với assignment vừa bị xoá / đổi vai trò.
  update public.role_bindings rb
     set valid_to = now(), version = rb.version + 1
   where rb.legacy_assignment_id = old.id
     and rb.valid_to is null
  returning rb.organization_id into v_org;

  if v_org is not null then
    update public.organizations
       set authorization_version = authorization_version + 1
     where id = v_org;
  end if;
  return null;
end;
$function$
;

CREATE OR REPLACE FUNCTION app_private.grant_ie_claim_capability_v1()
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog'
AS $function$

declare

  v_nonce text := encode(pg_catalog.sha256(

    convert_to(pg_current_xact_id()::text || clock_timestamp()::text, 'UTF8')), 'hex');

begin

  -- local = true → reset at transaction end; cannot outlive the wrapper tx.

  perform set_config('app_private.ie_claim_capability', v_nonce, true);

  return v_nonce;

end;

$function$
;

CREATE OR REPLACE FUNCTION app_private.ie_actor_display_name_v1(p_actor uuid)
 RETURNS text
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'auth'
AS $function$

  select coalesce(nullif(btrim(p.full_name), ''), nullif(btrim(p.email), ''),

                  u.email, 'Người dùng')

    from auth.users u

    left join public.profiles p on p.id = u.id

   where u.id = p_actor;

$function$
;

CREATE OR REPLACE FUNCTION app_private.accrue_salary_paid_on_approve()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'app_private'
AS $function$
declare
  v_take_home numeric;
  v_period date;
  v_sm_id uuid;
begin
  -- Chỉ quan tâm phiếu CHI LƯƠNG (gắn nhân viên hưởng lương).
  if new.salary_staff_id is null then
    return new;
  end if;

  -- ── Trở thành APPROVED ──────────────────────────────────────────────
  if new.approval_status = 'APPROVED'
     and coalesce(old.approval_status,'') is distinct from 'APPROVED' then

    -- "Tiền thực nhận": ưu tiên dòng item có tên đó (phiếu tách 2 dòng khi gạch
    -- nợ tiền phòng); không có → tổng phiếu.
    select coalesce(
             (select sum(it.amount) from public.income_expense_items it
               where it.income_expense_id = new.id
                 and it.description = 'Tiền thực nhận'),
             new.total_amount, 0)
      into v_take_home;

    -- KỲ LƯƠNG — nguồn đúng là DẤU payout_voucher_id do writer đóng lúc submit
    -- (chi-trước lương tháng sau: voucher_date KHÔNG suy ra được kỳ — bug bắt được
    -- test B2 2026-07-19: phiếu kỳ 08 trả ngày 19/07 bị gạch nhầm kỳ 06).
    -- Fallback heuristic theo voucher_date CHỈ cho phiếu legacy (không có dấu).
    select id into v_sm_id from public.salary_monthly
     where payout_voucher_id = new.id limit 1;
    if v_sm_id is null then
      select id into v_sm_id
        from public.salary_monthly
       where staff_id = new.salary_staff_id
         and period_month <= date_trunc('month', new.voucher_date)::date
       order by period_month desc
       limit 1;
    end if;

    if v_sm_id is not null then
      -- Chuyển-trạng-thái thuần: mỗi lần VÀO APPROVED cộng đúng 1 lần (WHEN đã
      -- chặn APPROVED→APPROVED). Stamp chỉ bổ sung khi trống (phiếu legacy).
      update public.salary_monthly
         set paid = coalesce(paid,0) + coalesce(v_take_home,0),
             payout_voucher_id = coalesce(payout_voucher_id, new.id)
       where id = v_sm_id;
    end if;
    return new;
  end if;

  -- ── Rời APPROVED (bỏ duyệt / huỷ): trừ lại — đối xứng với nhánh cộng ──
  if coalesce(old.approval_status,'') = 'APPROVED'
     and new.approval_status is distinct from 'APPROVED' then
    select coalesce(
             (select sum(it.amount) from public.income_expense_items it
               where it.income_expense_id = new.id
                 and it.description = 'Tiền thực nhận'),
             new.total_amount, 0)
      into v_take_home;
    -- Trừ trên CÙNG row nhánh cộng đã chọn: ưu tiên DẤU, fallback heuristic.
    -- KHÔNG xoá dấu (writer sở hữu linkage; trigger chỉ mirror tiền) — nhờ đó
    -- duyệt lại sau khi bỏ duyệt vẫn tìm đúng kỳ.
    select id into v_sm_id from public.salary_monthly
     where payout_voucher_id = new.id limit 1;
    if v_sm_id is null then
      select id into v_sm_id
        from public.salary_monthly
       where staff_id = new.salary_staff_id
         and period_month <= date_trunc('month', new.voucher_date)::date
       order by period_month desc
       limit 1;
    end if;
    if v_sm_id is not null then
      update public.salary_monthly
         set paid = greatest(coalesce(paid,0) - coalesce(v_take_home,0), 0)
       where id = v_sm_id;
    end if;
    return new;
  end if;

  return new;
end;
$function$
;

CREATE OR REPLACE FUNCTION app_private.verify_income_expense_audit_chain_v1(p_organization_id uuid)
 RETURNS TABLE(valid boolean, checked_events bigint, first_broken_sequence bigint)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'app_private', 'public'
AS $function$

declare

  r record;

  v_prev text := repeat('0', 64);

  v_expected text;

  v_count bigint := 0;

begin

  for r in

    select * from public.income_expense_audit_log

     where organization_id = p_organization_id and sequence_no is not null

     order by sequence_no

  loop

    v_expected := encode(sha256(convert_to(concat_ws(chr(31),

      'PG_SHA256_CANONICAL_V1',

      r.organization_id::text,

      r.sequence_no::text,

      v_prev,

      r.income_expense_id::text,

      r.action,

      r.actor_id::text,

      coalesce(r.actor_name, ''),

      coalesce(r.old_status, ''),

      coalesce(r.new_status, ''),

      coalesce(r.note, ''),

      to_char(r.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')),

      'UTF8')), 'hex');

    if r.prev_event_hash <> v_prev or r.event_hash <> v_expected then

      return query select false, v_count, r.sequence_no;

      return;

    end if;

    v_prev := r.event_hash;

    v_count := v_count + 1;

  end loop;

  return query select true, v_count, null::bigint;

end;

$function$
;

-- --- public (helper truoc, roi _vN) ---

CREATE OR REPLACE FUNCTION public.nrm_vn(s text)
 RETURNS text
 LANGUAGE sql
 IMMUTABLE PARALLEL SAFE
AS $function$
  SELECT trim(replace(
    lower(regexp_replace(normalize(coalesce(s, ''), NFD), '[̀-ͯ]', '', 'g')),
    'đ', 'd'
  ))
$function$
;

CREATE OR REPLACE FUNCTION public._eval_approval_rule(p_org uuid, p_amount numeric, p_txn_type text, p_system_source text, p_category uuid, p_cashbook uuid, p_building uuid)
 RETURNS TABLE(rule_set_id uuid, version integer, rule_id uuid, effect text)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
  WITH aset AS (
    SELECT id, version FROM public.approval_rule_sets
    WHERE organization_id=p_org AND transaction_domain='FINANCIAL_VOUCHER' AND status='ACTIVE'
      AND effective_from <= now() AND (effective_to IS NULL OR effective_to > now())
    ORDER BY version DESC LIMIT 1
  ),
  matches AS (
    SELECT r.id, r.effect, r.priority, r.is_fallback, s.id AS rs_id, s.version AS rs_ver,
      CASE WHEN r.effect='DENY' THEN 0
           WHEN r.effect='REQUIRE_APPROVAL' AND r.force_match THEN 1
           ELSE 2 END AS eff_rank
    FROM public.approval_rules r JOIN aset s ON r.rule_set_id=s.id
    WHERE r.active AND (
      r.is_fallback OR (
        (r.transaction_type IS NULL OR r.transaction_type=p_txn_type)
        AND (r.system_source IS NULL OR r.system_source=p_system_source)
        AND (r.category_id IS NULL OR r.category_id=p_category)
        AND (r.cashbook_id IS NULL OR r.cashbook_id=p_cashbook)
        AND (r.building_id IS NULL OR r.building_id=p_building)
        AND (r.amount_min IS NULL OR p_amount >= r.amount_min)
        AND (r.amount_max IS NULL OR p_amount <= r.amount_max)
      )
    )
  )
  SELECT rs_id, rs_ver, id, effect FROM matches
  ORDER BY is_fallback ASC, eff_rank ASC, priority ASC LIMIT 1;
$function$
;

CREATE OR REPLACE FUNCTION public.submit_financial_voucher(p_voucher uuid, p_idempotency_key text DEFAULT NULL::text, p_system_source text DEFAULT NULL::text, p_txn_type text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v record;
  v_org uuid; v_mem uuid; v_amount numeric;
  v_rule record; v_req uuid; v_state text; v_step uuid; v_cand int;
  v_existing uuid;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'Chưa đăng nhập' USING ERRCODE='42501'; END IF;
  SELECT * INTO v FROM public.income_expenses WHERE id=p_voucher AND deleted_at IS NULL FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Không tìm thấy phiếu' USING ERRCODE='P0002'; END IF;
  v_org := v.organization_id; v_amount := COALESCE(v.total_amount,0);

  SELECT id INTO v_mem FROM public.organization_memberships
   WHERE user_id=v_uid AND organization_id=v_org AND status='ACTIVE' LIMIT 1;
  IF v_mem IS NULL AND NOT public.is_super_admin() THEN
    RAISE EXCEPTION 'Bạn không thuộc tổ chức của phiếu' USING ERRCODE='42501';
  END IF;
  IF v_mem IS NULL THEN
    SELECT id INTO v_mem FROM public.organization_memberships WHERE organization_id=v_org AND member_type='OWNER' LIMIT 1;
  END IF;

  -- Idempotency / one-open-request: nếu đã có request OPEN cho subject, trả lại.
  SELECT id INTO v_existing FROM public.approval_requests
   WHERE organization_id=v_org AND subject_type='FINANCIAL_VOUCHER' AND subject_id=p_voucher
     AND state IN ('PENDING_APPROVAL','POSTED') LIMIT 1;
  IF v_existing IS NOT NULL THEN
    RETURN jsonb_build_object('ok',true,'request_id',v_existing,'idempotent',true);
  END IF;

  SELECT * INTO v_rule FROM public._eval_approval_rule(v_org, v_amount, p_txn_type, p_system_source, NULL, v.account_id, v.building_id);
  IF v_rule.rule_id IS NULL THEN
    RAISE EXCEPTION 'Không có rule set ACTIVE — fail closed' USING ERRCODE='42501';
  END IF;

  v_state := CASE v_rule.effect WHEN 'AUTO_POST' THEN 'POSTED' WHEN 'DENY' THEN 'DENIED' ELSE 'PENDING_APPROVAL' END;

  INSERT INTO public.approval_requests (organization_id, subject_type, subject_id, state,
      maker_membership_id, maker_user_id, rule_set_id, rule_set_version, matched_rule_id, rule_effect,
      payload_snapshot, payload_hash, amount, cashbook_id, building_id, system_source)
  VALUES (v_org, 'FINANCIAL_VOUCHER', p_voucher, v_state, v_mem, v_uid,
      v_rule.rule_set_id, v_rule.version, v_rule.rule_id, v_rule.effect,
      to_jsonb(v), md5(to_jsonb(v)::text), v_amount, v.account_id, v.building_id, p_system_source)
  RETURNING id INTO v_req;

  IF v_rule.effect='AUTO_POST' THEN
    PERFORM public._post_financial_voucher(p_voucher, v_req, v_uid);
  ELSIF v_rule.effect='REQUIRE_APPROVAL' THEN
    -- create step 1 + candidates (PERMISSION income_expenses.approve, exclude maker).
    INSERT INTO public.approval_request_steps (organization_id, request_id, step_no, status, mode, min_approvals, candidate_count)
    VALUES (v_org, v_req, 1, 'PENDING', 'ANY', 1, 0) RETURNING id INTO v_step;
    INSERT INTO public.approval_request_step_candidates (organization_id, request_step_id, membership_id, generation, source_kind)
    SELECT v_org, v_step, m.id, 1, 'PERMISSION'
    FROM public.organization_memberships m
    WHERE m.organization_id=v_org AND m.status='ACTIVE' AND m.id <> v_mem
      AND (m.member_type='OWNER'
           OR EXISTS(SELECT 1 FROM public.super_admins s WHERE s.user_id=m.user_id)
           OR (public.effective_perms_v2(m.user_id, v_org) -> 'income_expenses' ->> 'approve')='true');
    GET DIAGNOSTICS v_cand = ROW_COUNT;
    UPDATE public.approval_request_steps SET candidate_count=v_cand WHERE id=v_step;
    IF v_cand < 1 THEN
      RAISE EXCEPTION 'Không có người duyệt đủ điều kiện (fail closed)' USING ERRCODE='42501';
    END IF;
  END IF;

  RETURN jsonb_build_object('ok',true,'request_id',v_req,'effect',v_rule.effect,'state',v_state);
END; $function$
;

CREATE OR REPLACE FUNCTION public.approve_contract_termination_v1(p_termination_id uuid, p_note text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'app_private'
AS $function$
declare
  v_actor uuid := auth.uid();
  v_actor_name text;
  v_term public.contract_terminations%rowtype;
  v_contract public.contracts%rowtype;
  v_building uuid;
  v_refund numeric;
  v_type_id uuid;
  v_voucher_id uuid;
  v_voucher_kind text;
  v_type_names text[];
  v_desc text;
begin
  if v_actor is null then
    raise exception 'Chưa đăng nhập' using errcode = '42501';
  end if;

  select * into v_term from public.contract_terminations
   where id = p_termination_id for update;
  if not found then
    raise exception 'Không tìm thấy yêu cầu thanh lý hoặc bạn không có quyền' using errcode = '42501';
  end if;

  select * into v_contract from public.contracts
   where id = v_term.contract_id for update;
  if not found then
    raise exception 'Hợp đồng của yêu cầu thanh lý không còn tồn tại';
  end if;

  -- contracts KHÔNG có cột building_id — toà suy qua phòng (helper chuẩn RLS).
  v_building := public.building_of_contract(v_contract.id);
  if not (public.is_super_admin()
          or public.can_do_on_building('contracts', 'edit', v_building)) then
    raise exception 'Không có quyền duyệt thanh lý hợp đồng này' using errcode = '42501';
  end if;

  if v_term.status = 'COMPLETED' then
    return jsonb_build_object('termination_id', v_term.id, 'status', 'COMPLETED',
                              'voucher_id', null, 'noop', true);
  end if;

  select coalesce(nullif(btrim(full_name), ''), nullif(btrim(email), ''), 'Người dùng')
    into v_actor_name from public.profiles where id = v_actor;

  -- 1-3: chuỗi trạng thái (giữ nguyên thứ tự legacy, nay atomic trong 1 tx)
  update public.contract_terminations
     set status = 'APPROVED', approved_by = v_actor, approved_at = now()
   where id = v_term.id;

  update public.contracts
     set status = 'TERMINATED', updated_at = now()
   where id = v_contract.id;

  update public.contract_terminations
     set status = 'COMPLETED', refund_date = now()
   where id = v_term.id;

  -- 4: bút toán tiền (thay cash_book đã chết) — phiếu NHÁP chờ kế toán
  v_refund := coalesce(v_term.refund_amount, 0);
  if v_refund <> 0 then
    if v_refund > 0 then
      v_voucher_kind := 'EXPENSE';
      v_type_names := array['Hoàn cọc / tiền thừa khi thanh lý',
                            'Hoàn trả thanh lý',
                            'Hoàn cọc thanh lý',
                            'Hoàn tiền thừa thanh lý'];
      v_desc := 'Hoàn cọc thanh lý hợp đồng';
    else
      v_voucher_kind := 'INCOME';
      v_type_names := array['Thu thanh lý (khách trả thêm)',
                            'Doanh thu thanh lý'];
      v_desc := 'Thu thêm từ thanh lý hợp đồng';
    end if;

    -- Resolve hạng mục trong org theo thứ tự ưu tiên; trùng tên → bản cũ nhất.
    select t.id into v_type_id
      from public.income_expense_types t
     where t.organization_id = v_term.organization_id
       and lower(t.type) = lower(v_voucher_kind)
       and t.name = any (v_type_names)
     order by array_position(v_type_names, t.name), t.created_at
     limit 1;
    if v_type_id is null then
      raise exception 'Org chưa có hạng mục "%" cho bút toán thanh lý — tạo hạng mục rồi duyệt lại',
        v_type_names[1];
    end if;

    insert into public.income_expenses (
      user_id, creator_name, type, name,
      building_id, room_id, contract_id, account_id,
      payer_name, approval_status, voucher_date, attachments,
      notes, organization_id
    ) values (
      v_actor, coalesce(v_actor_name, 'Người dùng'), v_voucher_kind,
      v_desc || ' ' || coalesce(v_contract.contract_number, left(v_contract.id::text, 8)),
      v_building, v_contract.room_id, v_contract.id, null,
      null, 'UNAPPROVED', current_date, '[]'::jsonb,
      nullif(btrim(coalesce(p_note, '')), ''), v_term.organization_id
    ) returning id into v_voucher_id;

    insert into public.income_expense_items (
      income_expense_id, income_expense_type_id, description,
      quantity, unit_price, start_date, end_date
    ) values (
      v_voucher_id, v_type_id,
      v_desc || ' (yêu cầu ' || left(v_term.id::text, 8) || ')',
      1, abs(v_refund), current_date, current_date
    );
  end if;

  -- 5: trả phòng
  if v_contract.room_id is not null then
    update public.rooms set status = 'AVAILABLE' where id = v_contract.room_id;
  end if;

  return jsonb_build_object('termination_id', v_term.id, 'status', 'COMPLETED',
                            'voucher_id', v_voucher_id, 'room_id', v_contract.room_id);
end;
$function$
;

CREATE OR REPLACE FUNCTION public.approve_income_expense_v1(p_voucher_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'app_private'
AS $function$
declare
  v_actor uuid := auth.uid();
  v_actor_name text;
  v_row public.income_expenses%rowtype;
  v_rows integer;
begin
  if v_actor is null then
    raise exception 'Chưa đăng nhập' using errcode = '42501';
  end if;

  select * into v_row from public.income_expenses
   where id = p_voucher_id and deleted_at is null
   for update;
  if not found then
    raise exception 'Không thể duyệt phiếu: phiếu không tồn tại hoặc bạn không có quyền duyệt phiếu này'
      using errcode = '42501';
  end if;

  -- Row legacy → tín hiệu fallback (hook chuyển sang approve_voucher legacy).
  if not app_private.is_income_expense_flow_owned(v_row.id) then
    raise exception 'Phiếu chưa thuộc luồng canonical — dùng đường legacy'
      using errcode = '55000';
  end if;

  if v_row.approval_status = 'APPROVED' then
    return; -- idempotent no-op
  end if;

  -- t5_26: phiếu đang chờ engine → chỉ quyết qua màn Chờ duyệt
  perform app_private.assert_no_engine_request_v1(v_row.id);

  if v_row.approval_status = 'CANCELLED' then
    -- Phương án A: phiếu huỷ là terminal — dùng nút "Tạo bản sao".
    raise exception 'Phiếu đã huỷ — không thể duyệt. Hãy dùng "Tạo bản sao" để lập phiếu mới.';
  end if;

  -- Parity legacy: phải có sổ quỹ trước khi duyệt.
  if v_row.account_id is null then
    raise exception 'Phiếu chưa có sổ quỹ — phiếu canonical không sửa được: Huỷ phiếu rồi Tạo bản sao kèm sổ quỹ.';
  end if;

  -- Permission parity với public.approve_voucher.
  if not (
    v_row.user_id = v_actor
    or public.is_super_admin()
    or (v_row.building_id is not null
        and public.can_do_on_building('income_expenses', 'approve', v_row.building_id))
  ) then
    raise exception 'Không thể duyệt phiếu: phiếu không tồn tại hoặc bạn không có quyền duyệt phiếu này'
      using errcode = '42501';
  end if;

  v_actor_name := app_private.ie_actor_display_name_v1(v_actor);

  insert into app_private.ie_transition_authorization (income_expense_id, xid, purpose)
  values (v_row.id, pg_current_xact_id(), 'APPROVED');

  update public.income_expenses
     set approval_status = 'APPROVED',
         approved_by = v_actor,
         approved_at = now()
   where id = v_row.id;
  get diagnostics v_rows = row_count;

  delete from app_private.ie_transition_authorization
   where income_expense_id = v_row.id and xid = pg_current_xact_id();

  if v_rows <> 1 then
    raise exception 'approve transition affected % rows (expected 1)', v_rows
      using errcode = '55000';
  end if;

  perform app_private.append_income_expense_event_v1(
    v_row.organization_id, v_row.id, 'APPROVED', v_actor, v_actor_name,
    v_row.approval_status, 'APPROVED', 'Duyệt qua approve_income_expense_v1');
end;
$function$
;

CREATE OR REPLACE FUNCTION public.archive_cashbook_v1(p_cashbook_id uuid)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'app_private'
AS $function$

declare

  v_actor uuid := auth.uid();

  v_acct record; v_org uuid; v_authz boolean; v_route text; v_vouchers int;

begin

  if v_actor is null then raise exception 'Chưa đăng nhập' using errcode='42501'; end if;

  select a.id, a.organization_id into v_acct

    from public.accounts a where a.id=p_cashbook_id and a.deleted_at is null for update;

  if not found then raise exception 'Không tìm thấy sổ quỹ' using errcode='42501'; end if;

  v_org := v_acct.organization_id;

  if v_org is null then raise exception 'Sổ quỹ chưa gắn tổ chức' using errcode='23514'; end if;



  perform app_private.lock_org_for_decision_v1(v_org);

  select allowed into v_authz from app_private.authorize_tenant_action_v3(

    v_actor, v_org, 'cashbooks.delete', null, p_cashbook_id);

  if not coalesce(v_authz,false) then

    raise exception 'Không có quyền lưu trữ sổ quỹ (cashbooks.delete)' using errcode='42501'; end if;



  v_route := app_private.evaluate_feature_route('cashbook.archive.v1', v_org);

  if v_route <> 'CANONICAL' then raise exception 'Writer lưu trữ sổ quỹ chưa bật' using errcode='55000'; end if;



  select count(*) into v_vouchers from public.income_expenses

   where account_id=p_cashbook_id and deleted_at is null;

  if v_vouchers > 0 then

    raise exception 'Sổ quỹ còn % phiếu — không thể lưu trữ', v_vouchers using errcode='55000'; end if;



  update public.accounts set deleted_at = now() where id = p_cashbook_id;

  return json_build_object('cashbook_id', p_cashbook_id, 'archived', true);

end;

$function$
;

CREATE OR REPLACE FUNCTION public.attach_payment_receipt_v1(p_payment_id uuid, p_receipt_url text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'app_private'
AS $function$

declare

  v_actor uuid := auth.uid();

  v_payment public.payments;

  v_invoice public.invoices;

  v_voucher record;

  v_updated int := 0;

  v_url text;

begin

  if v_actor is null then

    raise exception 'Chưa đăng nhập' using errcode = '42501';

  end if;



  -- Server-side URL validation: https, project storage path, sane charset,

  -- bounded length. (Bucket/host pinning per attachment contract.)

  v_url := btrim(coalesce(p_receipt_url, ''));

  if v_url = '' or char_length(v_url) > 2048

     or v_url !~ '^https://[A-Za-z0-9.-]+/storage/v1/object/[A-Za-z0-9._~:/?#\[\]@!$&''()*+,;=%-]+$'

     or v_url ~ '[[:cntrl:][:space:]]' then

    raise exception 'URL chứng từ không hợp lệ' using errcode = '22023';

  end if;



  -- Lock payment first (deterministic order: invoice → payment → voucher is

  -- v3's order; here we start from payment and lock its invoice next, which

  -- is safe because we never lock another payment afterwards).

  select * into v_payment from public.payments

   where id = p_payment_id for update;

  if not found then

    raise exception 'Không tìm thấy giao dịch thu tiền' using errcode = 'P0002';

  end if;



  -- Authorization: invoice-linked payments require building edit permission;

  -- standalone payments require ownership.

  if v_payment.invoice_id is not null then

    select * into v_invoice from public.invoices

     where id = v_payment.invoice_id and deleted_at is null for update;

    if not found then

      raise exception 'Hóa đơn của giao dịch không còn tồn tại' using errcode = 'P0002';

    end if;

    if not public.can_do_on_building('invoices', 'edit', v_invoice.building_id) then

      raise exception 'Không có quyền cập nhật chứng từ cho hóa đơn này'

        using errcode = '42501';

    end if;

  elsif v_payment.user_id is distinct from v_actor

        and not public.is_super_admin() then

    raise exception 'Không có quyền cập nhật giao dịch này' using errcode = '42501';

  end if;



  -- Lock ALL linked vouchers (no LIMIT 1 assumption) and reject canonical rows.

  for v_voucher in

    select ie.id, ie.attachments, ie.organization_id,

           ie.approval_status

      from public.income_expenses ie

     where ie.payment_id = p_payment_id and ie.deleted_at is null

     order by ie.id

     for update

  loop

    if app_private.is_income_expense_flow_owned(v_voucher.id) then

      raise exception 'Phiếu liên kết là canonical draft — cập nhật chứng từ phải qua luồng duyệt'

        using errcode = '55000';

    end if;

  end loop;



  update public.payments

     set receipt_image_url = v_url

   where id = p_payment_id;



  update public.income_expenses ie

     set attachments = (

       select coalesce(jsonb_agg(distinct x), '[]'::jsonb)

         from (

           select jsonb_array_elements_text(coalesce(ie.attachments, '[]'::jsonb)) as x

           union

           select v_url

         ) u

     )

   where ie.payment_id = p_payment_id and ie.deleted_at is null;

  get diagnostics v_updated = row_count;



  return jsonb_build_object(

    'payment_id', p_payment_id,

    'receipt_url', v_url,

    'vouchers_updated', v_updated);

end;

$function$
;

CREATE OR REPLACE FUNCTION public.authorize_v2(p_permission_key text, p_org uuid, p_resource_type text, p_resource_id uuid)
 RETURNS boolean
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
DECLARE
  v_user uuid := auth.uid();
  v_mem  uuid;
  v_bid  uuid;   -- building resolved
  v_aid  uuid;   -- area resolved
  v_deny boolean;
  v_allow boolean;
BEGIN
  IF v_user IS NULL THEN RETURN false; END IF;
  SELECT id INTO v_mem FROM public.organization_memberships
   WHERE user_id = v_user AND organization_id = p_org AND status='ACTIVE' LIMIT 1;
  IF v_mem IS NULL THEN RETURN false; END IF;

  -- Per-user DENY (unscoped legacy overrides) thắng tuyệt đối.
  SELECT EXISTS(SELECT 1 FROM public.member_permission_overrides o
     WHERE o.membership_id=v_mem AND o.permission_key=p_permission_key AND o.effect='DENY'
       AND (o.expires_at IS NULL OR o.expires_at>now())) INTO v_deny;
  IF v_deny THEN RETURN false; END IF;

  -- Resolve building/area context của resource.
  IF p_resource_type='BUILDING' THEN v_bid := p_resource_id;
  ELSIF p_resource_type='AREA' THEN v_aid := p_resource_id;
  ELSIF p_resource_type='CASHBOOK' THEN
    -- cashbook scope: match trực tiếp theo cashbook_id.
    NULL;
  END IF;

  -- Per-user ALLOW override (unscoped) cấp quyền ngay.
  SELECT EXISTS(SELECT 1 FROM public.member_permission_overrides o
     WHERE o.membership_id=v_mem AND o.permission_key=p_permission_key AND o.effect='ALLOW'
       AND (o.expires_at IS NULL OR o.expires_at>now())) INTO v_allow;
  IF v_allow THEN RETURN true; END IF;

  -- Role ALLOW qua binding có scope khớp resource.
  SELECT EXISTS(
    SELECT 1
    FROM public.role_bindings rb
    JOIN public.role_permissions rp
      ON rp.organization_id=p_org AND rp.role_id=rb.role_id
     AND rp.permission_key=p_permission_key AND rp.effect='ALLOW'
    JOIN public.role_binding_scopes rbs
      ON rbs.role_binding_id=rb.id
    JOIN public.authorization_scopes s
      ON s.id=rbs.scope_id AND s.organization_id=p_org
    WHERE rb.membership_id=v_mem AND (rb.valid_to IS NULL OR rb.valid_to>now())
      AND (
        s.scope_type='ORGANIZATION'
        OR (s.scope_type='BUILDING' AND v_bid IS NOT NULL AND s.building_id=v_bid)
        OR (s.scope_type='AREA' AND v_aid IS NOT NULL AND s.area_id=v_aid)
        OR (s.scope_type='AREA' AND v_bid IS NOT NULL
            AND EXISTS(SELECT 1 FROM public.area_buildings ab
                       WHERE ab.area_id=s.area_id AND ab.building_id=v_bid))
        OR (s.scope_type='CASHBOOK' AND p_resource_type='CASHBOOK' AND s.cashbook_id=p_resource_id)
      )
  ) INTO v_allow;
  RETURN v_allow;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.bulk_create_meter_readings_v1(p_readings jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_caller uuid := auth.uid();
  v_item jsonb;
  v_row public.meter_readings;
  v_results jsonb := '[]'::jsonb;
BEGIN
  IF v_caller IS NULL THEN RAISE EXCEPTION 'Chưa đăng nhập' USING ERRCODE='42501'; END IF;
  IF jsonb_typeof(p_readings) <> 'array' THEN RAISE EXCEPTION 'p_readings phải là mảng'; END IF;

  FOR v_item IN SELECT * FROM jsonb_array_elements(p_readings)
  LOOP
    BEGIN
      v_row := public.create_meter_reading_v1(
        (v_item->>'meter_id')::uuid,
        (v_item->>'reading_date')::date,
        (v_item->>'current_reading')::numeric,
        NULLIF(v_item->>'notes',''),
        NULLIF(v_item->>'meter_image_url','')
      );
      v_results := v_results || jsonb_build_object(
        'success', true, 'reading_id', v_row.id, 'reading_code', v_row.reading_code,
        'meter_id', v_row.meter_id, 'error_message', NULL);
    EXCEPTION WHEN OTHERS THEN
      v_results := v_results || jsonb_build_object(
        'success', false, 'reading_id', NULL, 'reading_code', NULL,
        'meter_id', v_item->>'meter_id', 'error_message', SQLERRM);
    END;
  END LOOP;

  RETURN v_results;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.bulk_delete_meter_readings_v1(p_ids uuid[])
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_caller uuid := auth.uid();
  v_id uuid;
  v_deleted jsonb := '[]'::jsonb;
BEGIN
  IF v_caller IS NULL THEN RAISE EXCEPTION 'Chưa đăng nhập' USING ERRCODE='42501'; END IF;

  FOREACH v_id IN ARRAY COALESCE(p_ids, ARRAY[]::uuid[])
  LOOP
    BEGIN
      PERFORM public.delete_meter_reading_v1(v_id);
      v_deleted := v_deleted || jsonb_build_object('id', v_id, 'success', true);
    EXCEPTION WHEN OTHERS THEN
      v_deleted := v_deleted || jsonb_build_object('id', v_id, 'success', false, 'error_message', SQLERRM);
    END;
  END LOOP;

  RETURN v_deleted;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.cancel_income_expense_v1(p_voucher_id uuid, p_reason text DEFAULT NULL::text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'app_private'
AS $function$
declare
  v_actor uuid := auth.uid();
  v_actor_name text;
  v_row public.income_expenses%rowtype;
  v_allowed boolean;
  v_rows integer;
begin
  if v_actor is null then
    raise exception 'Chưa đăng nhập' using errcode = '42501';
  end if;

  select * into v_row from public.income_expenses
   where id = p_voucher_id and deleted_at is null
   for update;
  if not found then
    raise exception 'Không tìm thấy phiếu';
  end if;

  if not app_private.is_income_expense_flow_owned(v_row.id) then
    raise exception 'Phiếu chưa thuộc luồng canonical — dùng đường legacy'
      using errcode = '55000';
  end if;

  -- Defensive: create canonical không bao giờ gắn payment. Nếu có → thuộc domain
  -- payment (hoàn qua reverse_invoice_payment_v3), tuyệt đối không huỷ ở đây.
  if v_row.payment_id is not null then
    raise exception 'Phiếu gắn thanh toán hoá đơn — hãy hoàn tiền qua chức năng hoàn thanh toán';
  end if;

  if v_row.approval_status = 'CANCELLED' then
    return; -- idempotent no-op
  end if;

  -- t5_26: phiếu ĐÃ POSTED qua engine không huỷ trực tiếp (dùng reversal);
  -- request đang PENDING sẽ được TỰ ĐÓNG bên dưới sau khi huỷ phiếu.
  if exists (select 1 from public.approval_requests ar
              where ar.subject_type='FINANCIAL_VOUCHER' and ar.subject_id = v_row.id
                and ar.state = 'POSTED') then
    raise exception 'Phiếu đã được duyệt qua engine — dùng bút toán hoàn/đảo, không huỷ trực tiếp'
      using errcode = '55000';
  end if;

  -- Permission parity với RLS UPDATE legacy:
  --  PERMISSIVE (một trong): super_admin | update_rbac (admin/full-scope/building
  --  permitted 'edit') | owner + all_buildings('edit')
  --  RESTRICTIVE (bắt buộc): restricted-item rule.
  v_allowed :=
    public.is_super_admin()
    or public.is_admin()
    or public.has_perm_full_scope('income_expenses', 'edit')
    or (v_row.building_id is not null and v_row.building_id in
          (select public.permitted_building_ids('income_expenses', 'edit')))
    or (v_row.user_id = v_actor and v_row.building_id in
          (select public.ie_all_buildings_action_ids('edit')));
  if v_allowed and v_row.has_restricted_item then
    v_allowed := (v_row.user_id = v_actor)
      or public.can_view_restricted_ie()
      or public.is_super_admin();
  end if;
  if not v_allowed then
    raise exception 'Không có quyền huỷ phiếu này' using errcode = '42501';
  end if;

  v_actor_name := app_private.ie_actor_display_name_v1(v_actor);

  insert into app_private.ie_transition_authorization (income_expense_id, xid, purpose)
  values (v_row.id, pg_current_xact_id(), 'CANCELLED');

  update public.income_expenses
     set approval_status = 'CANCELLED'
   where id = v_row.id;
  get diagnostics v_rows = row_count;

  delete from app_private.ie_transition_authorization
   where income_expense_id = v_row.id and xid = pg_current_xact_id();

  if v_rows <> 1 then
    raise exception 'cancel transition affected % rows (expected 1)', v_rows
      using errcode = '55000';
  end if;

  -- t5_26: tự đóng approval_request đang mở của phiếu (giải one-open-subject).
  update public.approval_requests ar
     set state = 'CANCELLED', version = ar.version + 1
   where ar.subject_type = 'FINANCIAL_VOUCHER'
     and ar.subject_id = v_row.id
     and ar.state = 'PENDING_APPROVAL';

  perform app_private.append_income_expense_event_v1(
    v_row.organization_id, v_row.id, 'CANCELLED', v_actor, v_actor_name,
    v_row.approval_status, 'CANCELLED',
    nullif(btrim(coalesce(p_reason, '')), ''));
end;
$function$
;

CREATE OR REPLACE FUNCTION public.create_cashbook_v1(p_name text, p_initial_amount numeric, p_initial_date date, p_bank_name text, p_account_number text, p_quick_default_building_id uuid, p_idempotency_key text, p_description text DEFAULT NULL::text, p_is_default boolean DEFAULT false, p_owner_user_id uuid DEFAULT NULL::uuid)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'app_private'
AS $function$
declare
  v_actor uuid := auth.uid(); v_org uuid; v_authz boolean; v_owner uuid;
  v_key text; v_hash text; v_op app_private.canonical_write_operations%rowtype;
  v_route text; v_id uuid; v_resp json;
  v_memb uuid; v_scope uuid; v_ovr uuid;
  c_op constant text := 'cashbook.create.v1';
begin
  if v_actor is null then raise exception 'Chưa đăng nhập' using errcode='42501'; end if;
  v_key := btrim(coalesce(p_idempotency_key,''));
  if char_length(v_key) < 8 or char_length(v_key) > 200
     or v_key !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{7,199}$' then
    raise exception 'idempotency_key phải dài 8-200 ký tự ASCII an toàn'; end if;
  if coalesce(length(btrim(p_name)),0)=0 then raise exception 'Tên sổ quỹ trống'; end if;
  if p_initial_amount is null or round(p_initial_amount,2) <> p_initial_amount then
    raise exception 'Số dư đầu không hợp lệ'; end if;
  if p_initial_date is null then raise exception 'Ngày đầu kỳ trống'; end if;

  select m.organization_id into v_org from public.organization_memberships m
   where m.user_id=v_actor and m.status='ACTIVE' group by m.organization_id having count(*)=1;
  if v_org is null then raise exception 'Không xác định được tổ chức duy nhất của người dùng' using errcode='42501'; end if;

  -- owner: admin có thể gán người phụ trách khác, phải là member ACTIVE cùng org.
  v_owner := coalesce(p_owner_user_id, v_actor);
  if v_owner <> v_actor then
    perform 1 from public.organization_memberships m
      where m.user_id=v_owner and m.organization_id=v_org and m.status='ACTIVE';
    if not found then raise exception 'Người phụ trách không thuộc tổ chức' using errcode='42501'; end if;
  end if;

  if p_quick_default_building_id is not null then
    perform 1 from public.buildings b where b.id=p_quick_default_building_id
      and b.deleted_at is null and b.organization_id=v_org for share;
    if not found then raise exception 'Toà nhà mặc định không thuộc tổ chức' using errcode='42501'; end if;
  end if;

  perform app_private.lock_org_for_decision_v1(v_org);
  select allowed into v_authz from app_private.authorize_tenant_action_v3(
    v_actor, v_org, 'cashbooks.create', null, null);
  if not coalesce(v_authz,false) then
    raise exception 'Không có quyền tạo sổ quỹ (cashbooks.create)' using errcode='42501'; end if;

  v_hash := md5(jsonb_build_object('name',p_name,'org',v_org,'init',p_initial_amount,'date',p_initial_date,'owner',v_owner)::text);
  insert into app_private.canonical_write_operations
    (organization_id, operation, subject_scope, actor_id, idempotency_key, payload_hash)
  values (v_org, c_op, v_org::text, v_actor, v_key, v_hash)
  on conflict (organization_id, operation, subject_scope, actor_id, idempotency_key) do nothing;
  select * into v_op from app_private.canonical_write_operations o
   where o.organization_id=v_org and o.operation=c_op and o.subject_scope=v_org::text
     and o.actor_id=v_actor and o.idempotency_key=v_key for update;
  if v_op.payload_hash <> v_hash then raise exception 'idempotency_key đã dùng với nội dung khác' using errcode='23505'; end if;
  if v_op.completed_at is not null then return v_op.response_payload::json; end if;

  v_route := app_private.evaluate_feature_route(c_op, v_org);
  if v_route <> 'CANONICAL' then raise exception 'Writer sổ quỹ chưa bật' using errcode='55000'; end if;

  -- default duy nhất: nếu tạo sổ default, bỏ default các sổ khác cùng org.
  if coalesce(p_is_default,false) then
    update public.accounts set is_default=false
     where organization_id=v_org and is_default=true and deleted_at is null;
  end if;

  insert into public.accounts
    (user_id, organization_id, name, description, initial_amount, initial_date,
     is_default, is_virtual, bank_name, account_number, quick_default_building_id)
  values (v_owner, v_org, btrim(p_name), nullif(btrim(p_description),''),
          p_initial_amount, p_initial_date, coalesce(p_is_default,false), false,
          nullif(btrim(p_bank_name),''), nullif(btrim(p_account_number),''),
          p_quick_default_building_id)
  returning id into v_id;

  -- t5_20 auto-bind: người phụ trách sổ = CUSTODIAN + edge CASHBOOK (mở khoá
  -- cashbooks.post/điều chỉnh đầu kỳ cho sổ MỚI mà không cần seed tay).
  select m.id into v_memb from public.organization_memberships m
   where m.user_id=v_owner and m.organization_id=v_org and m.status='ACTIVE' limit 1;
  if v_memb is not null then
    insert into public.authorization_scopes (organization_id, scope_type, cashbook_id)
    values (v_org, 'CASHBOOK', v_id) returning id into v_scope;

    select o.id into v_ovr from public.member_permission_overrides o
     where o.organization_id=v_org and o.membership_id=v_memb
       and o.permission_key='cashbooks.post' and o.effect='ALLOW' and o.revoked_at is null
     limit 1;
    if v_ovr is null then
      insert into public.member_permission_overrides
        (organization_id, membership_id, permission_key, effect, scope_mode, reason)
      values (v_org, v_memb, 'cashbooks.post', 'ALLOW', 'SCOPED',
              'auto-bind khi tạo sổ quỹ (người phụ trách)')
      returning id into v_ovr;
    end if;
    insert into public.member_override_scopes (organization_id, override_id, scope_id)
    select v_org, v_ovr, v_scope
     where not exists (select 1 from public.member_override_scopes x
                        where x.organization_id=v_org and x.override_id=v_ovr and x.scope_id=v_scope);

    insert into public.cashbook_possession_bindings
      (organization_id, cashbook_id, membership_id, possession_kind, valid_from, granted_by, reason)
    values (v_org, v_id, v_memb, 'CUSTODIAN', now(), v_actor, 'auto-bind khi tạo sổ quỹ');
  end if;

  v_resp := json_build_object('cashbook_id', v_id);
  update app_private.canonical_write_operations
     set completed_at=now(), subject_id=v_id, response_payload=v_resp::jsonb
   where organization_id=v_org and operation=c_op and subject_scope=v_org::text
     and actor_id=v_actor and idempotency_key=v_key;
  return v_resp;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.create_contract_v1(p_room_id uuid, p_customer_ids uuid[], p_signed_date date, p_start_date date, p_end_date date, p_rent_price numeric, p_total_deposit numeric, p_services jsonb, p_first_invoice jsonb, p_idempotency_key text)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'app_private'
AS $function$

declare

  v_actor uuid := auth.uid();

  v_org uuid; v_building uuid;

  v_authz boolean; v_key text; v_hash text;

  v_op app_private.canonical_write_operations%rowtype; v_route text;

  v_contract uuid; v_cust uuid; v_svc jsonb; v_inv json := null;

  v_resp json;

  c_op constant text := 'contract.create.v1';

begin

  if v_actor is null then raise exception 'Chưa đăng nhập' using errcode='42501'; end if;

  v_key := btrim(coalesce(p_idempotency_key,''));

  if v_key !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{7,199}$' then

    raise exception 'idempotency_key phải dài 8-200 ký tự ASCII an toàn'; end if;

  if p_start_date is null or p_end_date is null or p_start_date > p_end_date then

    raise exception 'Ngày hợp đồng không hợp lệ'; end if;

  if p_rent_price is null or p_rent_price < 0 then raise exception 'Giá thuê không hợp lệ'; end if;

  if p_customer_ids is null or array_length(p_customer_ids,1) is null then

    raise exception 'Cần ít nhất một khách hàng'; end if;



  -- room → building → org; room locked FOR NO KEY UPDATE.

  select r.building_id into v_building from public.rooms r

   where r.id=p_room_id and r.deleted_at is null for no key update;

  if not found then raise exception 'Không tìm thấy phòng' using errcode='42501'; end if;

  select b.organization_id into v_org from public.buildings b

    join public.organizations o on o.id=b.organization_id and o.status='ACTIVE'

   where b.id=v_building and b.deleted_at is null for share of o,b;

  if v_org is null then raise exception 'Toà nhà không thuộc tổ chức đang hoạt động' using errcode='42501'; end if;



  perform app_private.lock_org_for_decision_v1(v_org);

  select allowed into v_authz from app_private.authorize_tenant_action_v3(

    v_actor, v_org, 'contracts.create', v_building, null);

  if not coalesce(v_authz,false) then

    raise exception 'Không có quyền tạo hợp đồng (contracts.create)' using errcode='42501'; end if;



  -- validate customers same-org.

  foreach v_cust in array p_customer_ids loop

    perform 1 from public.customers cu where cu.id=v_cust

      and (cu.organization_id is null or cu.organization_id=v_org) for share;

    if not found then raise exception 'Khách hàng không thuộc tổ chức' using errcode='42501'; end if;

  end loop;



  v_hash := md5(jsonb_build_object('room',p_room_id,'org',v_org,'start',p_start_date,

    'rent',p_rent_price)::text);

  insert into app_private.canonical_write_operations

    (organization_id, operation, subject_scope, actor_id, idempotency_key, payload_hash)

  values (v_org, c_op, p_room_id::text || '|' || p_start_date::text, v_actor, v_key, v_hash)

  on conflict (organization_id, operation, subject_scope, actor_id, idempotency_key) do nothing;

  select * into v_op from app_private.canonical_write_operations o

   where o.organization_id=v_org and o.operation=c_op

     and o.subject_scope=p_room_id::text || '|' || p_start_date::text

     and o.actor_id=v_actor and o.idempotency_key=v_key for update;

  if v_op.payload_hash <> v_hash then raise exception 'idempotency_key đã dùng với nội dung khác' using errcode='23505'; end if;

  -- idempotency replay BEFORE the business guard, so a legitimate retry returns

  -- the original contract instead of tripping "room already has a contract".

  if v_op.completed_at is not null then return v_op.response_payload::json; end if;



  -- guard: room must not already be OCCUPIED by an ACTIVE contract (a NEW claim).

  if exists (select 1 from public.contracts c

             where c.room_id=p_room_id and c.deleted_at is null and c.status='ACTIVE') then

    raise exception 'Phòng đã có hợp đồng đang hiệu lực' using errcode='55000'; end if;



  v_route := app_private.evaluate_feature_route(c_op, v_org);

  if v_route <> 'CANONICAL' then raise exception 'Writer hợp đồng chưa bật' using errcode='55000'; end if;



  -- create the contract (org auto-fills via trigger; public_code auto).

  insert into public.contracts

    (user_id, organization_id, room_id, signed_date, start_date, end_date,

     rent_price, total_deposit, status)

  values (v_actor, v_org, p_room_id, coalesce(p_signed_date,p_start_date),

          p_start_date, p_end_date, p_rent_price, coalesce(p_total_deposit,0), 'ACTIVE')

  returning id into v_contract;



  foreach v_cust in array p_customer_ids loop

    insert into public.contract_customers (contract_id, customer_id)

    values (v_contract, v_cust) on conflict do nothing;

  end loop;



  if p_services is not null and jsonb_typeof(p_services)='array' then

    for v_svc in select value from jsonb_array_elements(p_services) loop

      insert into public.contract_services (contract_id, service_id, unit_price)

      values (v_contract, (v_svc->>'service_id')::uuid, coalesce((v_svc->>'unit_price')::numeric,0));

    end loop;

  end if;



  -- optional first invoice via the canonical invoice writer (reuse t5_02).

  if p_first_invoice is not null then

    v_inv := public.create_invoice_v1(

      v_contract, v_building, p_room_id,

      p_first_invoice->>'billing_month',

      coalesce(nullif(p_first_invoice->>'issue_date','')::date, current_date),

      coalesce(nullif(p_first_invoice->>'due_date','')::date, current_date + 15),

      'MONTHLY',

      coalesce((p_first_invoice->>'subtotal')::numeric,0), 0,

      coalesce((p_first_invoice->>'total_amount')::numeric,0), 0,

      coalesce(p_first_invoice->'items','[]'::jsonb),

      v_key || '-inv');

  end if;



  -- consume any live 24h hold on the room (link it to the contract).

  update public.room_reservation_holds

     set status='APPROVED', contract_id=v_contract

   where room_id=p_room_id and status='PENDING_APPROVAL';



  -- room OCCUPIED as the LAST mutation (dominates recompute_room_reservation).

  update public.rooms set status='OCCUPIED' where id=p_room_id;



  v_resp := json_build_object('contract_id', v_contract, 'first_invoice', v_inv);

  update app_private.canonical_write_operations

     set subject_id=v_contract, response_payload=to_jsonb(v_resp), completed_at=now()

   where organization_id=v_org and operation=c_op

     and subject_scope=p_room_id::text || '|' || p_start_date::text

     and actor_id=v_actor and idempotency_key=v_key;

  return v_resp;

end;

$function$
;

CREATE OR REPLACE FUNCTION public.create_income_expense_v1(p_type text, p_name text, p_building_id uuid, p_room_id uuid, p_tenant_id uuid, p_contract_id uuid, p_payer_name text, p_receive_bank_account text, p_receive_bank_name text, p_account_id uuid, p_attachments jsonb, p_business_result_accounting boolean, p_notes text, p_voucher_date date, p_items jsonb, p_idempotency_key text)
 RETURNS income_expenses
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'app_private'
AS $function$







DECLARE



  -- t5_23/24: trạng thái sinh theo phương án org (cờ hạng mục + ngưỡng chi)

  v_birth_status text;

  v_birth_by uuid;

  v_birth_at timestamptz;

  v_force_cat boolean;

  v_auto_threshold numeric;









  v_actor uuid := app_private.current_uid_v1();







  v_claim_cap text;







  v_actor_name text;







  v_name text;







  v_org uuid;







  v_membership_id uuid;







  v_room_id uuid := p_room_id;







  v_tenant_id uuid := p_tenant_id;







  v_contract_room_id uuid;







  v_contract_tenant_id uuid;







  v_contract_deposit_paid_before public.contracts.deposit_paid%TYPE;







  v_contract_updated_at_before public.contracts.updated_at%TYPE;







  v_room_status_before public.rooms.status%TYPE;







  v_room_updated_at_before public.rooms.updated_at%TYPE;







  v_account_owner_id uuid;







  v_account_lock_date date;







  v_account_is_shared boolean := false;







  v_can_create_on_building boolean := false;







  v_can_create_restricted boolean := false;







  v_requires_restricted boolean := false;







  v_row public.income_expenses;







  v_operation app_private.canonical_write_operations%ROWTYPE;







  v_feature app_private.server_feature_flags%ROWTYPE;







  v_feature_route text;







  v_feature_operation_key text;







  v_feature_evaluated_at timestamptz;







  v_item jsonb;







  v_item_count integer;







  v_accrual_bucket_count integer := 0;







  v_index integer := 0;







  v_type_id uuid;







  v_type_is_restricted boolean;







  v_type_is_deposit boolean;







  v_type_normalized_name text;







  v_quantity numeric;







  v_unit_price_raw numeric;







  v_unit_price numeric;







  v_start_date date;







  v_end_date date;







  v_description text;







  v_expected_type text;







  v_canonical_items jsonb := '[]'::jsonb;







  v_canonical_payload jsonb;







  v_payload_hash text;







  v_idempotency_key text;







  v_total_amount numeric := 0;







  v_feature_operation_count bigint;







  v_feature_total_amount numeric;







  v_stored_item_count bigint;







  v_stored_total_amount numeric;







  v_stored_has_restricted boolean;







  v_stored_counts_in_business_result boolean;







  v_stored_kqkd_amount numeric;







  v_attachments jsonb := COALESCE(p_attachments, '[]'::jsonb);







  c_max_money constant numeric := 9999999999999.99;







  c_max_attachments constant integer := 20;







  c_max_attachment_length constant integer := 2048;







  c_max_name_length constant integer := 500;







  c_max_short_text_length constant integer := 255;







  c_max_notes_length constant integer := 5000;







  c_max_item_description_length constant integer := 1000;







  c_max_item_period_days constant integer := 3660;







  c_max_accrual_buckets constant integer := 2400;







  c_extra_whitespace constant text :=







    chr(160) || chr(173) || chr(5760)







    || chr(8192) || chr(8193) || chr(8194) || chr(8195) || chr(8196)







    || chr(8197) || chr(8198) || chr(8199) || chr(8200) || chr(8201)







    || chr(8202) || chr(8203) || chr(8232) || chr(8233) || chr(8239)







    || chr(8287) || chr(8288) || chr(12288) || chr(65279);







BEGIN







  IF v_actor IS NULL THEN







    RAISE EXCEPTION 'Chưa đăng nhập' USING ERRCODE = '42501';







  END IF;















  -- A.9 smallest-shape: actor display name via postgres-owned DEFINER delegate







  -- (auth.users/profiles RLS is not part of the writer role's capability set).







  v_actor_name := app_private.ie_actor_display_name_v1(v_actor);







  IF v_actor_name IS NULL THEN







    RAISE EXCEPTION 'Không tìm thấy người dùng hiện tại' USING ERRCODE = '42501';







  END IF;















  -- Platform administration is not tenant business authority. A platform actor







  -- must also hold an active tenant membership and normalized tenant permission;







  -- emergency platform operations belong to a separate, audited endpoint.







  IF p_type NOT IN ('INCOME', 'EXPENSE') THEN







    RAISE EXCEPTION 'Loại phiếu không hợp lệ';







  END IF;







  v_name := btrim(p_name, E' \t\n\r\f\v' || c_extra_whitespace);







  IF p_name IS NULL OR v_name = '' THEN







    RAISE EXCEPTION 'Tên phiếu không được trống';







  END IF;







  IF char_length(v_name) > c_max_name_length THEN







    RAISE EXCEPTION 'Tên phiếu vượt quá % ký tự', c_max_name_length;







  END IF;







  IF p_building_id IS NULL THEN







    RAISE EXCEPTION 'Thiếu building_id';







  END IF;







  IF p_voucher_date IS NULL







     OR NOT isfinite(p_voucher_date)







     OR p_voucher_date < DATE '2000-01-01'







     OR p_voucher_date > DATE '2100-12-31' THEN







    RAISE EXCEPTION 'Ngày phiếu phải nằm trong khoảng 2000-01-01 đến 2100-12-31';







  END IF;







  v_idempotency_key := btrim(p_idempotency_key);







  IF v_idempotency_key IS NULL







     OR char_length(v_idempotency_key) < 8







     OR char_length(v_idempotency_key) > 200







     OR v_idempotency_key !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{7,199}$' THEN







    RAISE EXCEPTION 'idempotency_key phải dài 8-200 ký tự ASCII và chỉ chứa A-Z, a-z, 0-9, ., _, :, -';







  END IF;







  IF p_payer_name IS NOT NULL







     AND char_length(btrim(p_payer_name)) > c_max_short_text_length THEN







    RAISE EXCEPTION 'Tên người nộp/nhận vượt quá % ký tự', c_max_short_text_length;







  END IF;







  IF p_receive_bank_account IS NOT NULL







     AND char_length(btrim(p_receive_bank_account)) > c_max_short_text_length THEN







    RAISE EXCEPTION 'Số tài khoản nhận vượt quá % ký tự', c_max_short_text_length;







  END IF;







  IF p_receive_bank_name IS NOT NULL







     AND char_length(btrim(p_receive_bank_name)) > c_max_short_text_length THEN







    RAISE EXCEPTION 'Tên ngân hàng nhận vượt quá % ký tự', c_max_short_text_length;







  END IF;







  IF p_notes IS NOT NULL AND char_length(p_notes) > c_max_notes_length THEN







    RAISE EXCEPTION 'Ghi chú vượt quá % ký tự', c_max_notes_length;







  END IF;







  IF jsonb_typeof(v_attachments) <> 'array'







     OR jsonb_array_length(v_attachments) > c_max_attachments







     OR EXISTS (







       SELECT 1







         FROM jsonb_array_elements(v_attachments) x(value)







        WHERE jsonb_typeof(value) <> 'string'







           OR char_length(value #>> '{}') < 1







           OR char_length(value #>> '{}') > c_max_attachment_length







           OR value #>> '{}' ~ '[[:cntrl:]]'







           OR value #>> '{}' !~







                '^https://[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?(?::[0-9]{1,5})?(?:[/?#][^[:space:]\\]*)?$'







     ) THEN







    RAISE EXCEPTION 'attachments phải là mảng tối đa % HTTPS URL an toàn, mỗi URL dài 1-% ký tự',







      c_max_attachments, c_max_attachment_length;







  END IF;







  IF p_items IS NULL OR jsonb_typeof(p_items) <> 'array' THEN







    RAISE EXCEPTION 'items phải là mảng';







  END IF;







  v_item_count := jsonb_array_length(p_items);







  IF v_item_count < 1 OR v_item_count > 200 THEN







    RAISE EXCEPTION 'Phiếu phải có từ 1 đến 200 hạng mục';







  END IF;















  -- Lock order: organization/building → membership → staff/role scope → room →







  -- tenant → contract/contract_tenant → account/share → item types → feature row.







  SELECT b.organization_id







    INTO v_org







    FROM public.buildings b







    JOIN public.organizations o







      ON o.id = b.organization_id







     AND o.status = 'ACTIVE'







   WHERE b.id = p_building_id







     AND b.deleted_at IS NULL







   FOR SHARE OF o, b;







  IF NOT FOUND OR v_org IS NULL THEN







    RAISE EXCEPTION 'Không tìm thấy toà nhà trong tổ chức đang hoạt động'







      USING ERRCODE = '42501';







  END IF;















  SELECT m.id







    INTO v_membership_id







    FROM public.organization_memberships m







   WHERE m.user_id = v_actor







     AND m.organization_id = v_org







     AND m.status = 'ACTIVE'







     AND m.valid_from <= clock_timestamp()







     AND (m.valid_to IS NULL OR clock_timestamp() < m.valid_to)







   ORDER BY m.id







   LIMIT 1







   FOR SHARE;







  IF NOT FOUND THEN







    RAISE EXCEPTION 'Không còn là thành viên đang hoạt động của tổ chức'







      USING ERRCODE = '42501';







  END IF;















  v_can_create_on_building :=







    app_private.authorize_income_expense_on_building(







      v_actor, v_org, 'create', p_building_id







    );















  v_can_create_restricted :=







    app_private.authorize_income_expense_on_building(







      v_actor, v_org, 'restricted_create', p_building_id







    );















  IF p_room_id IS NOT NULL THEN







    PERFORM 1







      FROM public.rooms r







     WHERE r.id = p_room_id







       AND r.deleted_at IS NULL







       AND r.building_id = p_building_id







       AND r.organization_id = v_org







     FOR SHARE;







    IF NOT FOUND THEN







      RAISE EXCEPTION 'Phòng không thuộc toà/tổ chức của phiếu'







        USING ERRCODE = '42501';







    END IF;







  END IF;















  IF p_tenant_id IS NOT NULL THEN







    PERFORM 1







      FROM public.tenants t







     WHERE t.id = p_tenant_id







       AND t.deleted_at IS NULL







       AND t.organization_id = v_org







     FOR SHARE;







    IF NOT FOUND THEN







      RAISE EXCEPTION 'Khách thuê không thuộc tổ chức của phiếu'







        USING ERRCODE = '42501';







    END IF;







  END IF;















  IF p_contract_id IS NOT NULL THEN







    SELECT c.room_id, c.tenant_id, c.deposit_paid, c.updated_at







      INTO v_contract_room_id, v_contract_tenant_id,







           v_contract_deposit_paid_before, v_contract_updated_at_before







      FROM public.contracts c







      JOIN public.rooms r







        ON r.id = c.room_id







       AND r.deleted_at IS NULL







       AND r.building_id = p_building_id







       AND r.organization_id = v_org







     WHERE c.id = p_contract_id







       AND c.deleted_at IS NULL







       AND c.organization_id = v_org







     FOR SHARE OF c, r;







    IF NOT FOUND THEN







      RAISE EXCEPTION 'Hợp đồng không thuộc toà/tổ chức của phiếu'







        USING ERRCODE = '42501';







    END IF;







    IF p_room_id IS NOT NULL AND p_room_id IS DISTINCT FROM v_contract_room_id THEN







      RAISE EXCEPTION 'Hợp đồng không khớp phòng của phiếu'







        USING ERRCODE = '42501';







    END IF;















    IF v_contract_tenant_id IS NOT NULL THEN







      PERFORM 1







        FROM public.tenants t







       WHERE t.id = v_contract_tenant_id







         AND t.deleted_at IS NULL







         AND t.organization_id = v_org







       FOR SHARE;







      IF NOT FOUND THEN







        RAISE EXCEPTION 'Khách thuê đại diện của hợp đồng không còn hợp lệ'







          USING ERRCODE = '42501';







      END IF;







      IF p_tenant_id IS NOT NULL







         AND p_tenant_id IS DISTINCT FROM v_contract_tenant_id THEN







        RAISE EXCEPTION 'Hợp đồng không khớp khách thuê của phiếu'







          USING ERRCODE = '42501';







      END IF;







      v_tenant_id := v_contract_tenant_id;







    ELSIF p_tenant_id IS NOT NULL THEN







      -- contracts.tenant_id is a nullable legacy representative. Only the legacy







      -- contract_tenants relation can prove a supplied tenants.id; contract_customers







      -- references public.customers and must never be used as a tenant bridge.







      PERFORM 1







        FROM public.contract_tenants ct







       WHERE ct.contract_id = p_contract_id







         AND ct.tenant_id = p_tenant_id







         AND (ct.organization_id IS NULL OR ct.organization_id = v_org)







       FOR SHARE;







      IF NOT FOUND THEN







        RAISE EXCEPTION 'Khách thuê không thuộc hợp đồng'







          USING ERRCODE = '42501';







      END IF;







      v_tenant_id := p_tenant_id;







    ELSE







      v_tenant_id := NULL;







    END IF;















    v_room_id := v_contract_room_id;







  END IF;















  IF NOT v_can_create_on_building THEN







    RAISE EXCEPTION 'Không có quyền tạo phiếu thu/chi cho toà này'







      USING ERRCODE = '42501';







  END IF;















  IF v_room_id IS NOT NULL THEN







    SELECT r.status, r.updated_at







      INTO v_room_status_before, v_room_updated_at_before







      FROM public.rooms r







     WHERE r.id = v_room_id







       AND r.deleted_at IS NULL







       AND r.building_id = p_building_id







       AND r.organization_id = v_org







     FOR SHARE;







    IF NOT FOUND THEN







      RAISE EXCEPTION 'Phòng hiệu lực không thuộc toà/tổ chức của phiếu'







        USING ERRCODE = '42501';







    END IF;







  END IF;















  IF p_account_id IS NOT NULL THEN







    SELECT a.user_id, a.lock_date







      INTO v_account_owner_id, v_account_lock_date







      FROM public.accounts a







     WHERE a.id = p_account_id







       AND a.deleted_at IS NULL







       AND a.organization_id = v_org







     FOR SHARE;







    IF NOT FOUND THEN







      RAISE EXCEPTION 'Sổ quỹ không thuộc tổ chức của phiếu'







        USING ERRCODE = '42501';







    END IF;















    -- Lock every candidate share row, not only the first match; otherwise a







    -- concurrent revoke of a different matching row can evade the final recheck.







    PERFORM 1







      FROM public.account_shared_users s







     WHERE s.account_id = p_account_id







       AND s.user_id = v_actor







     ORDER BY s.id







     FOR SHARE;







    SELECT EXISTS (







      SELECT 1







        FROM public.account_shared_users s







       WHERE s.account_id = p_account_id







         AND s.user_id = v_actor







         AND (s.organization_id IS NULL OR s.organization_id = v_org)







    ) INTO v_account_is_shared;















    -- Cashbook ownership/sharing remains semantically authoritative until the







    -- normalized cashbooks.post resolver is complete. Building permission never







    -- implies use of an arbitrary same-organization cashbook, while account







    -- ownership/sharing never implies permission to create on the building.







    IF NOT (







      v_account_owner_id = v_actor







      OR v_account_is_shared







    ) THEN







      RAISE EXCEPTION 'Không có quyền sử dụng sổ quỹ này'







        USING ERRCODE = '42501';







    END IF;















  END IF;















  v_expected_type := CASE p_type WHEN 'INCOME' THEN 'income' ELSE 'expense' END;















  FOR v_item IN SELECT value FROM jsonb_array_elements(p_items)







  LOOP







    v_index := v_index + 1;







    IF jsonb_typeof(v_item) <> 'object' THEN







      RAISE EXCEPTION 'Hạng mục % phải là object', v_index;







    END IF;







    IF (v_item - ARRAY[







      'income_expense_type_id', 'description', 'quantity', 'unit_price', 'start_date', 'end_date'







    ]) <> '{}'::jsonb THEN







      RAISE EXCEPTION 'Hạng mục % chứa trường không được phép', v_index;







    END IF;







    IF NOT (v_item ? 'income_expense_type_id')







       OR jsonb_typeof(v_item->'income_expense_type_id') <> 'string' THEN







      RAISE EXCEPTION 'Loại thu/chi hạng mục % phải là UUID dạng chuỗi', v_index;







    END IF;







    IF NOT (v_item ? 'quantity')







       OR jsonb_typeof(v_item->'quantity') <> 'number' THEN







      RAISE EXCEPTION 'Số lượng hạng mục % phải là JSON number', v_index;







    END IF;







    IF NOT (v_item ? 'unit_price')







       OR jsonb_typeof(v_item->'unit_price') <> 'number' THEN







      RAISE EXCEPTION 'Đơn giá hạng mục % phải là JSON number', v_index;







    END IF;







    IF NOT (v_item ? 'start_date')







       OR jsonb_typeof(v_item->'start_date') <> 'string'







       OR v_item->>'start_date' !~ '^\d{4}-\d{2}-\d{2}$' THEN







      RAISE EXCEPTION 'Ngày bắt đầu hạng mục % phải là YYYY-MM-DD', v_index;







    END IF;







    IF NOT (v_item ? 'end_date')







       OR jsonb_typeof(v_item->'end_date') <> 'string'







       OR v_item->>'end_date' !~ '^\d{4}-\d{2}-\d{2}$' THEN







      RAISE EXCEPTION 'Ngày kết thúc hạng mục % phải là YYYY-MM-DD', v_index;







    END IF;







    IF v_item ? 'description'







       AND jsonb_typeof(v_item->'description') NOT IN ('string', 'null') THEN







      RAISE EXCEPTION 'Mô tả hạng mục % phải là chuỗi', v_index;







    END IF;















    BEGIN







      v_type_id := NULLIF(v_item->>'income_expense_type_id', '')::uuid;







      v_quantity := (v_item->>'quantity')::numeric;







      v_unit_price_raw := (v_item->>'unit_price')::numeric;







      v_unit_price := round(v_unit_price_raw, 2);







      v_start_date := (v_item->>'start_date')::date;







      v_end_date := (v_item->>'end_date')::date;







      v_description := NULLIF(btrim(v_item->>'description'), '');







    EXCEPTION







      WHEN invalid_text_representation







        OR invalid_datetime_format







        OR numeric_value_out_of_range







        OR datetime_field_overflow THEN







        RAISE EXCEPTION 'Hạng mục % có dữ liệu không hợp lệ', v_index;







    END;















    IF v_type_id IS NULL THEN







      RAISE EXCEPTION 'Hạng mục % thiếu loại thu/chi', v_index;







    END IF;







    IF v_description IS NOT NULL







       AND char_length(v_description) > c_max_item_description_length THEN







      RAISE EXCEPTION 'Mô tả hạng mục % vượt quá % ký tự',







        v_index, c_max_item_description_length;







    END IF;







    IF v_quantity IS NULL







       OR v_quantity::text IN ('NaN', 'Infinity', '-Infinity')







       OR v_quantity < 1







       OR v_quantity > 2147483647







       OR v_quantity <> trunc(v_quantity) THEN







      RAISE EXCEPTION 'Số lượng hạng mục % phải là số nguyên hợp lệ >= 1', v_index;







    END IF;







    -- Quantity is stored as integer; normalize numeric spelling before hashing.







    v_quantity := trunc(v_quantity);







    IF v_unit_price_raw IS NULL







       OR v_unit_price_raw::text IN ('NaN', 'Infinity', '-Infinity')







       OR v_unit_price_raw < 0







       OR v_unit_price < 0







       OR v_unit_price > c_max_money THEN







      RAISE EXCEPTION 'Đơn giá hạng mục % không hợp lệ', v_index;







    END IF;







    IF v_quantity * v_unit_price > c_max_money THEN







      RAISE EXCEPTION 'Thành tiền hạng mục % vượt giới hạn', v_index;







    END IF;







    IF v_start_date IS NULL







       OR v_end_date IS NULL







       OR NOT isfinite(v_start_date)







       OR NOT isfinite(v_end_date)







       OR v_start_date < DATE '2000-01-01'







       OR v_end_date > DATE '2100-12-31'







       OR v_start_date > v_end_date







       OR v_end_date - v_start_date > c_max_item_period_days THEN







      RAISE EXCEPTION 'Kỳ áp dụng hạng mục % phải nằm trong 2000-01-01..2100-12-31 và không quá % ngày',







        v_index, c_max_item_period_days;







    END IF;







    v_accrual_bucket_count := v_accrual_bucket_count







      + (







          extract(year FROM v_end_date)::integer * 12







          + extract(month FROM v_end_date)::integer







          - extract(year FROM v_start_date)::integer * 12







          - extract(month FROM v_start_date)::integer







          + 1







        );







    IF v_accrual_bucket_count > c_max_accrual_buckets THEN







      RAISE EXCEPTION 'Tổng số bucket dồn tích vượt giới hạn %', c_max_accrual_buckets







        USING ERRCODE = '54000';







    END IF;















    SELECT t.is_restricted, t.is_deposit, public.nrm_vn(t.name)







      INTO v_type_is_restricted, v_type_is_deposit, v_type_normalized_name







      FROM public.income_expense_types t







     WHERE t.id = v_type_id







       AND lower(t.type) = v_expected_type







       AND t.organization_id = v_org







     FOR SHARE;







    IF NOT FOUND THEN







      RAISE EXCEPTION 'Loại hạng mục % không thuộc tổ chức hoặc sai chiều thu/chi', v_index







        USING ERRCODE = '42501';







    END IF;







    IF v_type_is_deposit THEN







      RAISE EXCEPTION 'Writer phiếu nháp tổng quát không hỗ trợ hạng mục tiền cọc'







        USING ERRCODE = '0A000';







    END IF;







    IF v_type_normalized_name IN ('hoa hong moi gioi', 'thuong nong sale') THEN







      RAISE EXCEPTION 'Writer phiếu nháp tổng quát không hỗ trợ hạng mục hoa hồng/thưởng Sale; dùng flow hoa hồng chuyên biệt'







        USING ERRCODE = '0A000';







    END IF;







    IF v_type_is_restricted THEN







      v_requires_restricted := true;







      IF NOT v_can_create_restricted THEN







        RAISE EXCEPTION 'Không có quyền tạo hạng mục thu/chi hạn chế'







          USING ERRCODE = '42501';







      END IF;







    END IF;















    v_total_amount := v_total_amount + (v_quantity * v_unit_price);







    IF v_total_amount > c_max_money THEN







      RAISE EXCEPTION 'Tổng tiền phiếu vượt giới hạn';







    END IF;















    -- Build the equality token from typed values, not caller UUID/date spelling.







    v_canonical_items := v_canonical_items || jsonb_build_array(







      jsonb_strip_nulls(jsonb_build_object(







        'income_expense_type_id', v_type_id,







        'description', v_description,







        'quantity', v_quantity,







        'unit_price', v_unit_price,







        'start_date', v_start_date,







        'end_date', v_end_date







      ))







    );







  END LOOP;















  v_canonical_payload := jsonb_strip_nulls(jsonb_build_object(







    'type', p_type,







    'name', v_name,







    'building_id', p_building_id,







    'room_id', v_room_id,







    'tenant_id', v_tenant_id,







    'contract_id', p_contract_id,







    'payer_name', NULLIF(btrim(p_payer_name), ''),







    'receive_bank_account', NULLIF(btrim(p_receive_bank_account), ''),







    'receive_bank_name', NULLIF(btrim(p_receive_bank_name), ''),







    'account_id', p_account_id,







    'attachments', v_attachments,







    'business_result_accounting', p_business_result_accounting,







    'notes', NULLIF(p_notes, ''),







    'voucher_date', p_voucher_date,







    'items', v_canonical_items







  ));







  -- md5(jsonb::text) is deterministic for PostgreSQL jsonb canonical key ordering;







  -- payload_hash is an equality token, not a password/signature.







  v_payload_hash := md5(v_canonical_payload::text);















  -- The unconditional unique claim is the linearization point. ON CONFLICT waits







  -- for an in-flight claimant: if it aborts this transaction becomes the claimant;







  -- if it commits the locked reread observes its immutable completion. Rollout state







  -- is deliberately not consulted until after that outcome is known.







  INSERT INTO app_private.canonical_write_operations (







    organization_id, operation, subject_scope, actor_id,







    idempotency_key, payload_hash







  ) VALUES (







    v_org, 'income_expense.create_draft.v1', p_building_id::text, v_actor,







    v_idempotency_key, v_payload_hash







  )







  ON CONFLICT (organization_id, operation, subject_scope, actor_id, idempotency_key)







  DO NOTHING;















  SELECT *







    INTO v_operation







    FROM app_private.canonical_write_operations o







   WHERE o.organization_id = v_org







     AND o.operation = 'income_expense.create_draft.v1'







     AND o.subject_scope = p_building_id::text







     AND o.actor_id = v_actor







     AND o.idempotency_key = v_idempotency_key







   FOR UPDATE;







  IF NOT FOUND THEN







    RAISE EXCEPTION 'Không thể nhận diện operation idempotency đã claim'







      USING ERRCODE = '55000';







  END IF;







  IF v_operation.payload_hash <> v_payload_hash THEN







    RAISE EXCEPTION 'idempotency_key đã được dùng với payload khác'







      USING ERRCODE = '23505';







  END IF;















  -- Completed replay still requires current tenant authority, but it must not depend







  -- on mutable rollout admission, canary enrollment/caps, or the cashbook lock date.







  -- Platform-super status is intentionally irrelevant to tenant business authority.







  IF NOT EXISTS (







    SELECT 1







      FROM public.organization_memberships m







     WHERE m.id = v_membership_id







       AND m.organization_id = v_org







       AND m.user_id = v_actor







       AND m.status = 'ACTIVE'







       AND m.valid_from <= clock_timestamp()







       AND (m.valid_to IS NULL OR clock_timestamp() < m.valid_to)







  ) THEN







    RAISE EXCEPTION 'Tư cách thành viên đã hết hiệu lực'







      USING ERRCODE = '42501';







  END IF;







  IF NOT app_private.authorize_income_expense_on_building(







    v_actor, v_org, 'create', p_building_id







  ) THEN







    RAISE EXCEPTION 'Quyền tạo phiếu trên toà đã bị thu hồi'







      USING ERRCODE = '42501';







  END IF;







  IF v_requires_restricted







     AND NOT app_private.authorize_income_expense_on_building(







       v_actor, v_org, 'restricted_create', p_building_id







     ) THEN







    RAISE EXCEPTION 'Quyền tạo hạng mục hạn chế đã bị thu hồi'







      USING ERRCODE = '42501';







  END IF;







  IF p_account_id IS NOT NULL







     AND v_account_owner_id IS DISTINCT FROM v_actor







     AND NOT EXISTS (







       SELECT 1







         FROM public.account_shared_users s







        WHERE s.account_id = p_account_id







          AND s.user_id = v_actor







          AND (s.organization_id IS NULL OR s.organization_id = v_org)







     ) THEN







    RAISE EXCEPTION 'Quyền sử dụng sổ quỹ đã bị thu hồi'







      USING ERRCODE = '42501';







  END IF;















  IF v_operation.completed_at IS NOT NULL THEN







    SELECT *







      INTO v_row







      FROM jsonb_populate_record(







        NULL::public.income_expenses,







        v_operation.response_payload







      );







    IF v_row.id IS NULL OR v_row.id IS DISTINCT FROM v_operation.subject_id THEN







      RAISE EXCEPTION 'Kết quả idempotency không còn nhất quán';







    END IF;







    RETURN v_row;







  END IF;















  -- Only a new/pending claimant enters rollout admission. A completed operation above







  -- can therefore replay after OFF/freeze, enrollment removal, or window closure.







  SELECT *







    INTO v_feature







    FROM app_private.server_feature_flags f







   WHERE f.feature_key = 'income_expense.create_draft.v1'







   FOR SHARE;







  IF NOT FOUND THEN







    RAISE EXCEPTION 'Canonical writer chưa được cấu hình' USING ERRCODE = '55000';







  END IF;















  -- A CANARY enrollment used for admission must survive through commit. The shared







  -- feature lock freezes the release identity/configuration for this transaction.







  IF v_feature.mode = 'CANARY' THEN







    PERFORM 1







      FROM app_private.server_feature_flag_canary_orgs c







     WHERE c.feature_key = v_feature.feature_key







       AND c.organization_id = v_org







     FOR SHARE;







    IF NOT FOUND THEN







      RAISE EXCEPTION 'Tổ chức không còn trong canary'







        USING ERRCODE = '55000';







    END IF;







  END IF;















  v_feature_route := app_private.evaluate_feature_route(







    v_feature.feature_key, v_org







  );







  IF v_feature_route <> 'CANONICAL' THEN







    RAISE EXCEPTION 'Canonical writer chưa được bật hoặc đang đóng băng cho tổ chức này'







      USING ERRCODE = '55000';







  END IF;















  IF v_feature.mode = 'CANARY' THEN







    -- Serialize only one feature/config cap bucket; do not upgrade the shared row







    -- lock, which would deadlock concurrent readers and globally serialize ON mode.







    PERFORM pg_catalog.pg_advisory_xact_lock(







      pg_catalog.hashtextextended(







        v_feature.feature_key || ':' || v_feature.config_version::text,







        0







      )







    );







    v_feature_evaluated_at := clock_timestamp();







    IF v_feature.starts_at IS NULL







       OR v_feature.ends_at IS NULL







       OR NOT isfinite(v_feature.starts_at)







       OR NOT isfinite(v_feature.ends_at)







       OR v_feature.starts_at >= v_feature.ends_at







       OR v_feature_evaluated_at < v_feature.starts_at







       OR v_feature_evaluated_at >= v_feature.ends_at THEN







      RAISE EXCEPTION 'Cửa sổ canary không còn hiệu lực'







        USING ERRCODE = '55000';







    END IF;







    IF v_feature.max_single_amount_vnd::text IN ('NaN', 'Infinity', '-Infinity')







       OR v_feature.max_total_amount_vnd::text IN ('NaN', 'Infinity', '-Infinity')







       OR v_feature.max_operation_count <= 0







       OR v_feature.max_single_amount_vnd <= 0







       OR v_feature.max_total_amount_vnd <= 0 THEN







      RAISE EXCEPTION 'Hạn mức canary không hợp lệ'







        USING ERRCODE = '55000';







    END IF;







    IF v_total_amount > v_feature.max_single_amount_vnd THEN







      RAISE EXCEPTION 'Số tiền vượt cap canary cho một phiếu'







        USING ERRCODE = '54000';







    END IF;















    SELECT count(*), COALESCE(sum(o.amount_vnd), 0)







      INTO v_feature_operation_count, v_feature_total_amount







      FROM app_private.server_feature_flag_operations o







     WHERE o.feature_key = v_feature.feature_key







       AND o.config_version = v_feature.config_version;







    IF v_feature_operation_count >= v_feature.max_operation_count THEN







      RAISE EXCEPTION 'Đã hết số lượt canary' USING ERRCODE = '54000';







    END IF;







    IF v_feature_total_amount + v_total_amount > v_feature.max_total_amount_vnd THEN







      RAISE EXCEPTION 'Đã hết tổng hạn mức tiền canary' USING ERRCODE = '54000';







    END IF;







  END IF;















  -- Recheck expiring tenant authority after every idempotency, rollout, enrollment,







  -- and advisory-lock wait. Account lock_date is an effect-only rule: it is applied







  -- here for a new effect but was intentionally skipped by completed replay above.







  IF NOT EXISTS (







    SELECT 1







      FROM public.organization_memberships m







     WHERE m.id = v_membership_id







       AND m.organization_id = v_org







       AND m.user_id = v_actor







       AND m.status = 'ACTIVE'







       AND m.valid_from <= clock_timestamp()







       AND (m.valid_to IS NULL OR clock_timestamp() < m.valid_to)







  ) THEN







    RAISE EXCEPTION 'Tư cách thành viên đã hết hiệu lực'







      USING ERRCODE = '42501';







  END IF;







  IF NOT app_private.authorize_income_expense_on_building(







    v_actor, v_org, 'create', p_building_id







  ) THEN







    RAISE EXCEPTION 'Quyền tạo phiếu trên toà đã bị thu hồi'







      USING ERRCODE = '42501';







  END IF;







  IF v_requires_restricted







     AND NOT app_private.authorize_income_expense_on_building(







       v_actor, v_org, 'restricted_create', p_building_id







     ) THEN







    RAISE EXCEPTION 'Quyền tạo hạng mục hạn chế đã bị thu hồi'







      USING ERRCODE = '42501';







  END IF;







  IF p_account_id IS NOT NULL THEN







    IF v_account_owner_id IS DISTINCT FROM v_actor







       AND NOT EXISTS (







         SELECT 1







           FROM public.account_shared_users s







          WHERE s.account_id = p_account_id







            AND s.user_id = v_actor







            AND (s.organization_id IS NULL OR s.organization_id = v_org)







       ) THEN







      RAISE EXCEPTION 'Quyền sử dụng sổ quỹ đã bị thu hồi'







        USING ERRCODE = '42501';







    END IF;







    IF v_account_lock_date IS NOT NULL AND p_voucher_date <= v_account_lock_date THEN







      RAISE EXCEPTION 'Sổ quỹ đã khoá tại ngày phiếu';







    END IF;







  END IF;















  IF v_feature.mode = 'CANARY' THEN







    v_feature_operation_key := md5(concat_ws(







      '|',







      'income_expense.create_draft.v1',







      v_org::text,







      p_building_id::text,







      v_actor::text,







      v_idempotency_key







    ));







    INSERT INTO app_private.server_feature_flag_operations (







      feature_key, config_version, operation_key, organization_id, amount_vnd







    ) VALUES (







      v_feature.feature_key, v_feature.config_version, v_feature_operation_key,







      v_org, v_total_amount







    );







  END IF;















  -- Deliberately unresolved: the final T3 containment contract must supply a







  -- server-owned canonical-flow marker that exists at draft creation time. Neither







  -- approval_request_id (NULL before submit) nor the private idempotency ledger is an







  -- acceptable provenance marker. Keep this function revoked until the replacement







  -- source writes that marker atomically with the header and legacy transition guards







  -- reject marked rows.







    -- t5_23/24: chọn trạng thái sinh — auto-duyệt TRỪ hạng mục đặc biệt (cờ

  -- force_approval, gồm hoàn cọc/thanh lý/lương/LN/HH/thưởng...) và TRỪ phiếu

  -- CHI từ ngưỡng cài đặt trở lên (app_private.ie_auto_approve_config; chưa

  -- đặt ngưỡng = tự duyệt như cũ). Phiếu không tự duyệt sinh ở NHÁP chờ duyệt tay.

  SELECT bool_or(coalesce(t.force_approval, false))

    INTO v_force_cat

    FROM jsonb_array_elements(p_items) AS it

    JOIN public.income_expense_types t

      ON t.id = (it->>'income_expense_type_id')::uuid;

  SELECT c.threshold INTO v_auto_threshold

    FROM app_private.ie_auto_approve_config c

   WHERE c.organization_id = v_org;

  IF coalesce(v_force_cat, false) THEN

    v_birth_status := 'UNAPPROVED';

  ELSIF p_type = 'EXPENSE' AND v_auto_threshold IS NOT NULL

        AND v_total_amount >= v_auto_threshold THEN

    v_birth_status := 'UNAPPROVED';

  ELSE

    v_birth_status := 'APPROVED';

  END IF;

  IF v_birth_status = 'APPROVED' THEN

    v_birth_by := v_actor; v_birth_at := now();

  ELSE

    v_birth_by := NULL; v_birth_at := NULL;

  END IF;



  INSERT INTO public.income_expenses (







    user_id, creator_name, organization_id,







    type, name, building_id, room_id, tenant_id, contract_id,







    payer_name, receive_bank_account, receive_bank_name, account_id,







    attachments, business_result_accounting, notes,







    repeat_cycle, repeat_infinity, repeat_count, repeat_auto_approve,







    repeat_remaining, repeat_next_date,







    voucher_date, approval_status, approved_by, approved_at,







    source_payload_hash, system_source







  ) VALUES (







    v_actor, v_actor_name, v_org,







    p_type, v_name, p_building_id, v_room_id, v_tenant_id, NULL,







    NULLIF(btrim(p_payer_name), ''), NULLIF(btrim(p_receive_bank_account), ''),







    NULLIF(btrim(p_receive_bank_name), ''), p_account_id,







    v_attachments, p_business_result_accounting, NULLIF(p_notes, ''),







    'NONE', false, 0, false,







    0, NULL,







    p_voucher_date, v_birth_status, v_birth_by, v_birth_at,







    v_payload_hash, NULL







  )







  RETURNING * INTO v_row;















  INSERT INTO public.income_expense_items (







    income_expense_id, income_expense_type_id, description,







    quantity, unit_price, start_date, end_date, organization_id







  )







  SELECT







    v_row.id,







    (item->>'income_expense_type_id')::uuid,







    item->>'description',







    (item->>'quantity')::integer,







    (item->>'unit_price')::numeric,







    (item->>'start_date')::date,







    (item->>'end_date')::date,







    v_org







  FROM jsonb_array_elements(v_canonical_items) AS x(item);















  -- Keep the parent detached while non-deposit/non-commission items are inserted.







  -- The legacy item trigger otherwise recomputes any historical approved deposit on







  -- the contract and churns contracts.updated_at even though this draft has no deposit.







  -- Commission flows are excluded above and retain their specialized writer because







  -- their invariants require contract_id on the header before item insertion.







  IF p_contract_id IS NOT NULL THEN







    UPDATE public.income_expenses







       SET contract_id = p_contract_id







     WHERE id = v_row.id







       AND contract_id IS NULL;







    IF NOT FOUND THEN







      RAISE EXCEPTION 'Không thể gắn hợp đồng đã xác thực vào phiếu nháp'







        USING ERRCODE = '23514';







    END IF;







  END IF;















  SELECT * INTO v_row FROM public.income_expenses WHERE id = v_row.id;















  SELECT count(*), COALESCE(sum(it.amount), 0), COALESCE(bool_or(t.is_restricted), false)







    INTO v_stored_item_count, v_stored_total_amount, v_stored_has_restricted







    FROM public.income_expense_items it







    JOIN public.income_expense_types t ON t.id = it.income_expense_type_id







   WHERE it.income_expense_id = v_row.id;







  v_stored_counts_in_business_result := COALESCE(







    p_business_result_accounting,







    true







  );







  v_stored_kqkd_amount := CASE







    WHEN p_business_result_accounting IS FALSE THEN 0







    ELSE v_total_amount







  END;







  IF v_stored_item_count <> v_item_count







     OR v_stored_total_amount IS DISTINCT FROM v_total_amount







     OR v_row.total_amount IS DISTINCT FROM v_total_amount







     OR v_row.has_restricted_item IS DISTINCT FROM v_stored_has_restricted







     OR v_row.counts_in_business_result IS DISTINCT FROM v_stored_counts_in_business_result







     OR v_row.kqkd_amount IS DISTINCT FROM v_stored_kqkd_amount THEN







    RAISE EXCEPTION 'Trigger thu/chi không tạo đúng các trường tài chính suy diễn'







      USING ERRCODE = '23514';







  END IF;















  -- Generic non-deposit drafts must not reconcile pre-existing deposit or room







  -- reservation state. The earlier row locks make any difference attributable to







  -- this statement; aborting here rolls back the complete writer transaction.







  IF p_contract_id IS NOT NULL AND EXISTS (







    SELECT 1







      FROM public.contracts c







     WHERE c.id = p_contract_id







       AND (







         c.deposit_paid IS DISTINCT FROM v_contract_deposit_paid_before







         OR c.updated_at IS DISTINCT FROM v_contract_updated_at_before







       )







  ) THEN







    RAISE EXCEPTION 'Writer phiếu nháp tổng quát đã tác động trạng thái tiền cọc hợp đồng'







      USING ERRCODE = '23514';







  END IF;







  IF v_room_id IS NOT NULL AND EXISTS (







    SELECT 1







      FROM public.rooms r







     WHERE r.id = v_room_id







       AND (







         r.status IS DISTINCT FROM v_room_status_before







         OR r.updated_at IS DISTINCT FROM v_room_updated_at_before







       )







  ) THEN







    RAISE EXCEPTION 'Writer phiếu nháp tổng quát đã tác động trạng thái giữ phòng'







      USING ERRCODE = '23514';







  END IF;















  -- The shared feature-row lock and, for CANARY, shared enrollment lock keep the







  -- admitted rollout identity stable. Re-evaluate only the time boundary here:







  -- counting the reservation we just inserted as a new admission would reject the







  -- exact final permitted count slot (count = max) after its effects were built.







  IF v_feature.mode = 'CANARY' AND (







    clock_timestamp() < v_feature.starts_at







    OR clock_timestamp() >= v_feature.ends_at







  ) THEN







    RAISE EXCEPTION 'Cửa sổ canary đã đóng trước khi hoàn tất'







      USING ERRCODE = '55000';







  END IF;















  -- =========================================================================







  -- T3 CLAIM (A.2 integration point): after construction + invariants +







  -- canary time recheck; before audit append and operation completion.







  -- A.9 smallest-shape: this wrapper is SECURITY DEFINER owned by postgres (so







  -- auth access + INVOKER triggers resolve on Supabase). Capability is proven by







  -- a transaction-local token stamped by a postgres-owned DEFINER setter that no







  -- app role can call, then echoed to the claim. (Replaces the unreachable







  -- current_user='ie_canonical_writer' gate — see t3_12.)







  -- =========================================================================







  v_claim_cap := app_private.grant_ie_claim_capability_v1();







  PERFORM app_private.claim_canonical_income_expense_draft_v1(







    v_row.id, v_idempotency_key, v_claim_cap);







  SELECT * INTO v_row FROM public.income_expenses WHERE id = v_row.id;















  -- A.5: canonical audit goes through the single hash-chain primitive; the







  -- audit-log writer-monopoly guard rejects any direct unchained INSERT.







  PERFORM app_private.append_income_expense_event_v1(







    v_org, v_row.id, 'CREATED_DRAFT', v_actor, v_actor_name,







    NULL, v_birth_status,

    CASE WHEN v_birth_status = 'APPROVED'

         THEN 'Tạo phiếu TỰ DUYỆT (ngoài hạng mục đặc biệt, dưới ngưỡng)'

         ELSE 'Tạo phiếu NHÁP chờ duyệt (hạng mục đặc biệt hoặc chi vượt ngưỡng)' END);















  UPDATE app_private.canonical_write_operations







     SET subject_id = v_row.id,







         response_payload = to_jsonb(v_row),







         completed_at = now()







   WHERE organization_id = v_org







     AND operation = 'income_expense.create_draft.v1'







     AND subject_scope = p_building_id::text







     AND actor_id = v_actor







     AND idempotency_key = v_idempotency_key;















  RETURN v_row;







END;







$function$
;

CREATE OR REPLACE FUNCTION public.create_meter_reading_v1(p_meter_id uuid, p_reading_date date, p_current_reading numeric, p_notes text DEFAULT NULL::text, p_meter_image_url text DEFAULT NULL::text)
 RETURNS meter_readings
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_caller uuid := auth.uid();
  v_meter RECORD;
  v_row public.meter_readings;
BEGIN
  IF v_caller IS NULL THEN RAISE EXCEPTION 'Chưa đăng nhập' USING ERRCODE='42501'; END IF;
  IF p_meter_id IS NULL THEN RAISE EXCEPTION 'Thiếu meter_id'; END IF;
  IF p_reading_date IS NULL THEN RAISE EXCEPTION 'Thiếu ngày ghi'; END IF;
  IF p_current_reading IS NULL OR p_current_reading < 0 THEN RAISE EXCEPTION 'Chỉ số không hợp lệ'; END IF;

  SELECT id, building_id, room_id, organization_id INTO v_meter
  FROM public.meters WHERE id = p_meter_id AND deleted_at IS NULL;
  IF NOT FOUND THEN RAISE EXCEPTION 'Không tìm thấy đồng hồ' USING ERRCODE='42501'; END IF;
  IF v_meter.building_id IS NULL THEN RAISE EXCEPTION 'Đồng hồ chưa gắn toà nhà'; END IF;

  -- Defense-in-depth org boundary: definer bypass RLS nên phải tự kiểm org membership
  -- (mirror policy meter_readings_org_boundary NULL-tolerant) NGOÀI building-RBAC.
  IF NOT (v_meter.organization_id IS NULL
          OR public.is_super_admin()
          OR v_meter.organization_id = ANY(public.my_org_ids())) THEN
    RAISE EXCEPTION 'Đồng hồ thuộc tổ chức khác' USING ERRCODE='42501';
  END IF;
  IF NOT public.can_do_on_building('meter_readings','create', v_meter.building_id) THEN
    RAISE EXCEPTION 'Không có quyền tạo chỉ số cho toà này' USING ERRCODE='42501';
  END IF;

  BEGIN
    INSERT INTO public.meter_readings
      (meter_id, reading_date, current_reading, notes, meter_image_url, status, approved_by, approved_at)
    VALUES
      (p_meter_id, p_reading_date, p_current_reading, p_notes, p_meter_image_url, 'APPROVED', v_caller, now())
    RETURNING * INTO v_row;
  EXCEPTION WHEN check_violation THEN
    RAISE EXCEPTION 'Chỉ số mới không hợp lệ (phải ≥ chỉ số kỳ trước)' USING ERRCODE='23514';
  END;

  RETURN v_row;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.create_reservation_deposit_v1(p_room_id uuid, p_amount numeric, p_idempotency_key text)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'app_private'
AS $function$

declare

  v_actor uuid := auth.uid();

  v_org uuid; v_building uuid;

  v_authz boolean; v_key text; v_hash text;

  v_op app_private.canonical_write_operations%rowtype; v_route text;

  v_hold uuid; v_resp json;

  c_op constant text := 'deposit.hold.v1';

begin

  if v_actor is null then raise exception 'Chưa đăng nhập' using errcode='42501'; end if;

  v_key := btrim(coalesce(p_idempotency_key,''));

  if v_key !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{7,199}$' then

    raise exception 'idempotency_key phải dài 8-200 ký tự ASCII an toàn'; end if;

  if p_amount is null or p_amount <= 0 or round(p_amount,2) <> p_amount then

    raise exception 'Số tiền cọc không hợp lệ'; end if;



  -- room → building → org; lock the room FOR NO KEY UPDATE (avoid the reconcile

  -- lock-upgrade deadlock).

  select r.building_id into v_building from public.rooms r

   where r.id=p_room_id and r.deleted_at is null for no key update;

  if not found then raise exception 'Không tìm thấy phòng' using errcode='42501'; end if;

  select b.organization_id into v_org from public.buildings b

    join public.organizations o on o.id=b.organization_id and o.status='ACTIVE'

   where b.id=v_building and b.deleted_at is null for share of o,b;

  if v_org is null then raise exception 'Toà nhà không thuộc tổ chức đang hoạt động' using errcode='42501'; end if;



  perform app_private.lock_org_for_decision_v1(v_org);

  select allowed into v_authz from app_private.authorize_tenant_action_v3(

    v_actor, v_org, 'deposits.create', v_building, null);

  if not coalesce(v_authz,false) then

    raise exception 'Không có quyền đặt cọc giữ chỗ (deposits.create)' using errcode='42501'; end if;



  v_hash := md5(jsonb_build_object('room',p_room_id,'org',v_org,'amount',p_amount)::text);

  insert into app_private.canonical_write_operations

    (organization_id, operation, subject_scope, actor_id, idempotency_key, payload_hash)

  values (v_org, c_op, p_room_id::text, v_actor, v_key, v_hash)

  on conflict (organization_id, operation, subject_scope, actor_id, idempotency_key) do nothing;

  select * into v_op from app_private.canonical_write_operations o

   where o.organization_id=v_org and o.operation=c_op and o.subject_scope=p_room_id::text

     and o.actor_id=v_actor and o.idempotency_key=v_key for update;

  if v_op.payload_hash <> v_hash then raise exception 'idempotency_key đã dùng với nội dung khác' using errcode='23505'; end if;

  if v_op.completed_at is not null then return v_op.response_payload::json; end if;



  v_route := app_private.evaluate_feature_route(c_op, v_org);

  if v_route <> 'CANONICAL' then raise exception 'Writer cọc giữ chỗ chưa bật' using errcode='55000'; end if;



  -- the exclusion constraint enforces no-double-hold; a concurrent live hold on

  -- the same room raises 23P01 (exclusion_violation) → surface as "đã có cọc giữ".

  begin

    insert into public.room_reservation_holds

      (organization_id, building_id, room_id, amount, held_by, expires_at)

    values (v_org, v_building, p_room_id, p_amount, v_actor,

            clock_timestamp() + interval '24 hours')

    returning id into v_hold;

  exception when exclusion_violation then

    raise exception 'Phòng đang có cọc giữ chỗ còn hiệu lực' using errcode='55000';

  end;



  v_resp := json_build_object('hold_id', v_hold, 'room_id', p_room_id,

    'expires_at', (clock_timestamp() + interval '24 hours'));

  update app_private.canonical_write_operations

     set subject_id=v_hold, response_payload=to_jsonb(v_resp), completed_at=now()

   where organization_id=v_org and operation=c_op and subject_scope=p_room_id::text

     and actor_id=v_actor and idempotency_key=v_key;

  return v_resp;

end;

$function$
;

CREATE OR REPLACE FUNCTION public.decide_financial_request_v2(p_request_id uuid, p_decision text, p_reason text DEFAULT NULL::text)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'app_private'
AS $function$
declare
  v_actor uuid := auth.uid();
  v_memb uuid; v_ver bigint; v_state text;
begin
  if v_actor is null then raise exception 'Chưa đăng nhập' using errcode='42501'; end if;
  if p_decision not in ('APPROVE','REJECT') then
    raise exception 'Quyết định không hợp lệ (APPROVE/REJECT)' using errcode='22023';
  end if;

  -- Tôi phải là ỨNG VIÊN hiện hành của bước PENDING (engine sẽ re-check lần nữa).
  select c.membership_id, ar.version into v_memb, v_ver
    from public.approval_requests ar
    join public.approval_request_steps s
      on s.request_id = ar.id and s.status = 'PENDING'
    join public.approval_request_step_candidates c
      on c.request_step_id = s.id
     and c.generation = s.current_generation
     and c.valid_to is null
    join public.organization_memberships m
      on m.id = c.membership_id and m.status = 'ACTIVE' and m.user_id = v_actor
   where ar.id = p_request_id and ar.state = 'PENDING_APPROVAL'
   limit 1;
  if v_memb is null then
    raise exception 'Bạn không nằm trong danh sách người duyệt của yêu cầu này'
      using errcode = '42501';
  end if;

  perform app_private.decide_financial_request_v1(
    p_request_id, v_ver, v_memb, v_actor, p_decision,
    nullif(btrim(coalesce(p_reason,'')),''));

  select ar.state into v_state from public.approval_requests ar where ar.id = p_request_id;
  return json_build_object('request_id', p_request_id, 'state', v_state);
end;
$function$
;

CREATE OR REPLACE FUNCTION public.delete_meter_reading_v1(p_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_caller uuid := auth.uid();
  v_r RECORD;
BEGIN
  IF v_caller IS NULL THEN RAISE EXCEPTION 'Chưa đăng nhập' USING ERRCODE='42501'; END IF;

  SELECT id, building_id, organization_id INTO v_r
  FROM public.meter_readings WHERE id = p_id AND deleted_at IS NULL FOR UPDATE;
  -- Idempotent: xoá row không tồn tại / đã xoá = success im lặng (parity đường cũ,
  -- chống double-click / concurrent delete báo lỗi thừa).
  IF NOT FOUND THEN RETURN; END IF;
  IF v_r.building_id IS NULL THEN RAISE EXCEPTION 'Chỉ số chưa gắn toà nhà'; END IF;

  IF NOT (v_r.organization_id IS NULL
          OR public.is_super_admin()
          OR v_r.organization_id = ANY(public.my_org_ids())) THEN
    RAISE EXCEPTION 'Chỉ số thuộc tổ chức khác' USING ERRCODE='42501';
  END IF;
  IF NOT public.can_do_on_building('meter_readings','delete', v_r.building_id) THEN
    RAISE EXCEPTION 'Không có quyền xoá chỉ số cho toà này' USING ERRCODE='42501';
  END IF;

  UPDATE public.meter_readings SET deleted_at = now()
  WHERE id = p_id AND deleted_at IS NULL;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.distribute_shareholder_profit_v1(p_shareholder_id uuid, p_amount numeric, p_account_id uuid, p_voucher_date date, p_note text, p_idempotency_key text)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'app_private'
AS $function$
declare
  v_actor uuid := auth.uid();
  v_actor_name text;
  v_org uuid; v_building uuid; v_type uuid; v_membership uuid;
  v_subject_name text;
  v_authz boolean; v_key text; v_hash text;
  v_op app_private.canonical_write_operations%rowtype; v_route text;
  v_voucher uuid; v_req uuid; v_name text; v_resp json;
  c_op constant text := 'shareholder_profit.distribute.v1';
begin
  if v_actor is null then raise exception 'Chưa đăng nhập' using errcode='42501'; end if;

  -- Validate idempotency key + số tiền (mirror salary_payout_v1).
  v_key := btrim(coalesce(p_idempotency_key,''));
  if v_key !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{7,199}$' then
    raise exception 'idempotency_key phải dài 8-200 ký tự ASCII an toàn'; end if;
  if p_amount is null or p_amount <= 0 or round(p_amount,2) <> p_amount then
    raise exception 'Số tiền chia lợi nhuận không hợp lệ'; end if;
  -- Phiếu chi phải có sổ quỹ nguồn (money-movement). Chặt hơn salary_payout_v1.
  if p_account_id is null then
    raise exception 'Thiếu sổ quỹ để chi chia lợi nhuận' using errcode='42501'; end if;

  -- [D1] Org resolve từ SUBJECT (cổ đông). shareholders.organization_id prod đo được
  -- org_null=0 → tin cậy. RLS bị bypass trong SECURITY DEFINER nên PHẢI tự chốt org.
  select s.organization_id, coalesce(nullif(btrim(s.name),''), 'Cổ đông')
    into v_org, v_subject_name
    from public.shareholders s
   where s.id = p_shareholder_id and s.deleted_at is null
   for share;
  if not found or v_org is null then
    raise exception 'Không tìm thấy cổ đông hoặc cổ đông chưa gán tổ chức' using errcode='42501';
  end if;

  -- Toà ảo "Chung" TRONG org (org phải ACTIVE). Org chưa có toà ảo (vd dddd) → báo rõ,
  -- KHÔNG misroute sang org khác như global-scan của salary_payout_v1.
  select b.id into v_building
    from public.buildings b
    join public.organizations o on o.id = b.organization_id and o.status = 'ACTIVE'
   where b.organization_id = v_org and b.is_virtual = true and b.deleted_at is null
   order by b.created_at limit 1
   for share of o, b;
  if v_building is null then
    raise exception 'Tổ chức chưa có toà ảo (Chung) để hạch toán phiếu chia lợi nhuận' using errcode='55000';
  end if;

  -- Quyền chính xác shareholder_profit.distribute + membership ACTIVE của actor.
  perform app_private.lock_org_for_decision_v1(v_org);
  select allowed into v_authz from app_private.authorize_tenant_action_v3(
    v_actor, v_org, 'shareholder_profit.distribute', v_building, p_account_id);
  if not coalesce(v_authz,false) then
    raise exception 'Không có quyền chia lợi nhuận (shareholder_profit.distribute)' using errcode='42501'; end if;
  select m.id into v_membership from public.organization_memberships m
   where m.user_id=v_actor and m.organization_id=v_org and m.status='ACTIVE' limit 1 for share;
  if v_membership is null then raise exception 'Không còn là thành viên tổ chức' using errcode='42501'; end if;

  -- Idempotency: subject_scope = cổ đông (owner có thể chia nhiều lần → key phân biệt).
  v_hash := md5(jsonb_build_object(
    'shareholder', p_shareholder_id, 'amount', round(p_amount,2),
    'account', p_account_id, 'voucher_date', p_voucher_date, 'org', v_org)::text);
  insert into app_private.canonical_write_operations
    (organization_id, operation, subject_scope, actor_id, idempotency_key, payload_hash)
  values (v_org, c_op, p_shareholder_id::text, v_actor, v_key, v_hash)
  on conflict (organization_id, operation, subject_scope, actor_id, idempotency_key) do nothing;
  select * into v_op from app_private.canonical_write_operations o
   where o.organization_id=v_org and o.operation=c_op and o.subject_scope=p_shareholder_id::text
     and o.actor_id=v_actor and o.idempotency_key=v_key for update;
  if v_op.payload_hash <> v_hash then
    raise exception 'idempotency_key đã dùng với nội dung khác' using errcode='23505'; end if;
  if v_op.completed_at is not null then return v_op.response_payload::json; end if;

  -- Gate flag (INERT tới khi có row server_feature_flags cho c_op).
  v_route := app_private.evaluate_feature_route(c_op, v_org);
  if v_route <> 'CANONICAL' then raise exception 'Writer chia lợi nhuận chưa bật' using errcode='55000'; end if;

  -- Tên người tạo (mirror creatorName client: full_name || email || 'Người dùng').
  select coalesce(nullif(btrim(full_name),''), nullif(btrim(email),''), 'Người dùng')
    into v_actor_name from public.profiles where id = v_actor;

  -- Hạng mục 'Chia lợi nhuận cổ đông' resolve/tạo THEO ORG. [D2] stamp user_id (vá
  -- latent bug salary_payout_v1). category='Chia lợi nhuận' mirror client hook.
  select id into v_type from public.income_expense_types
   where organization_id = v_org and lower(type) = 'expense' and name = 'Chia lợi nhuận cổ đông'
   order by created_at limit 1;
  if v_type is null then
    insert into public.income_expense_types
      (user_id, organization_id, name, type, category, is_default, is_deposit)
    values (v_actor, v_org, 'Chia lợi nhuận cổ đông', 'expense', 'Chia lợi nhuận', false, false)
    returning id into v_type;
  end if;

  -- Voucher name mirror client fallback-chain: note?.trim() || 'Chia lợi nhuận: <tên>'.
  v_name := coalesce(nullif(btrim(coalesce(p_note,'')),''), 'Chia lợi nhuận: ' || v_subject_name);

  -- Phiếu EXPENSE UNAPPROVED (KQKD=false, gắn shareholder_id). NOTE đi vào ITEM
  -- description (mirror client) — voucher.notes để null. source_payload_hash link op.
  insert into public.income_expenses (
    user_id, organization_id, creator_name, type, name,
    building_id, account_id, shareholder_id,
    business_result_accounting, approval_status, voucher_date,
    attachments, repeat_cycle, repeat_infinity, repeat_count, repeat_remaining,
    source_payload_hash
  ) values (
    v_actor, v_org, coalesce(v_actor_name,'Người dùng'), 'EXPENSE', v_name,
    v_building, p_account_id, p_shareholder_id,
    false, 'UNAPPROVED', p_voucher_date,
    '[]'::jsonb, 'NONE', false, 0, 0,
    v_hash
  ) returning id into v_voucher;

  -- 1 item → trigger tính amount = quantity*unit_price + total_amount trên phiếu.
  insert into public.income_expense_items (
    income_expense_id, organization_id, income_expense_type_id,
    description, quantity, unit_price, start_date, end_date
  ) values (
    v_voucher, v_org, v_type,
    nullif(btrim(coalesce(p_note,'')),''), 1, round(p_amount,2), p_voucher_date, p_voucher_date
  );

  -- FORK A: đẩy vào engine duyệt (FORCE-APPROVAL). Writer KHÔNG tự duyệt. submit_*
  -- fail-closed nếu org chưa có ACTIVE rule-set (lỗi cấu hình thật — để nổi).
  v_req := app_private.submit_financial_request_v1(v_voucher, v_membership, v_actor, v_key || '-sub');

  v_resp := json_build_object(
    'profit_voucher_id', v_voucher, 'approval_request_id', v_req,
    'shareholder_id', p_shareholder_id, 'state', 'PENDING_APPROVAL');
  update app_private.canonical_write_operations
     set subject_id=v_voucher, response_payload=to_jsonb(v_resp), completed_at=now()
   where organization_id=v_org and operation=c_op and subject_scope=p_shareholder_id::text
     and actor_id=v_actor and idempotency_key=v_key;
  return v_resp;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.effective_perms_v2(p_user uuid, p_org uuid)
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
  WITH mem AS (
    SELECT id FROM public.organization_memberships
    WHERE user_id = p_user AND organization_id = p_org AND status = 'ACTIVE'
  ),
  role_keys AS (
    SELECT DISTINCT rp.permission_key AS key
    FROM mem
    JOIN public.role_bindings rb
      ON rb.membership_id = mem.id AND (rb.valid_to IS NULL OR rb.valid_to > now())
    JOIN public.role_permissions rp
      ON rp.organization_id = p_org AND rp.role_id = rb.role_id AND rp.effect = 'ALLOW'
  ),
  allow_ov AS (
    SELECT o.permission_key AS key FROM public.member_permission_overrides o
    JOIN mem ON o.membership_id = mem.id
    WHERE o.effect = 'ALLOW' AND (o.expires_at IS NULL OR o.expires_at > now())
  ),
  deny_ov AS (
    SELECT o.permission_key AS key FROM public.member_permission_overrides o
    JOIN mem ON o.membership_id = mem.id
    WHERE o.effect = 'DENY' AND (o.expires_at IS NULL OR o.expires_at > now())
  ),
  effective AS (
    SELECT key FROM (SELECT key FROM role_keys UNION SELECT key FROM allow_ov) u
    WHERE key NOT IN (SELECT key FROM deny_ov)
  )
  SELECT COALESCE(jsonb_object_agg(resource, actions), '{}'::jsonb)
  FROM (
    SELECT pd.resource, jsonb_object_agg(pd.action, true) AS actions
    FROM effective e JOIN public.permission_definitions pd ON pd.key = e.key
    GROUP BY pd.resource
  ) g;
$function$
;

CREATE OR REPLACE FUNCTION public.generate_invoice_number_v2()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_prefix TEXT;
  v_year   TEXT;
  v_seq    INTEGER;
BEGIN
  IF NEW.invoice_number IS NOT NULL THEN
    RETURN NEW;
  END IF;

  v_year := TO_CHAR(NOW(), 'YYYY');

  SELECT COALESCE(value->>'invoice_prefix', 'INV')
    INTO v_prefix
    FROM settings
   WHERE user_id = NEW.user_id AND key = 'invoice_number_format';

  IF v_prefix IS NULL OR v_prefix = '' THEN
    v_prefix := 'INV';
  END IF;

  -- Serialize concurrent inserts sharing the same prefix+year so MAX+1 cannot race.
  PERFORM pg_advisory_xact_lock(hashtext('invoice_number:' || v_prefix || ':' || v_year));

  -- GLOBAL max over "<prefix>-<year>-<digits>" (constraint is global, not per-user).
  SELECT COALESCE(MAX(CAST(SUBSTRING(invoice_number FROM '(\d+)$') AS INTEGER)), 0) + 1
    INTO v_seq
    FROM invoices
   WHERE invoice_number LIKE (v_prefix || '-' || v_year || '-%')
     AND invoice_number ~ ('^' || v_prefix || '-' || v_year || '-\d+$');

  NEW.invoice_number := v_prefix || '-' || v_year || '-' || LPAD(v_seq::TEXT, 5, '0');
  RETURN NEW;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.generate_invoices_for_building_v2(p_building_id uuid, p_billing_month text, p_invoice_type text DEFAULT 'RENT'::text)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_caller uuid := auth.uid();
BEGIN
  IF NOT public.can_do_on_building('invoices','create', p_building_id) THEN
    RAISE EXCEPTION 'Access denied for building %', p_building_id;
  END IF;

  -- Delegate to v1 — v1 dùng p_user_id để INSERT; trigger auto sẽ override user_id = auth.uid()
  -- nhưng v1 còn dùng p_user_id ở nhiều chỗ filter. Để an toàn không thay đổi logic v1,
  -- ta gọi v1 với p_user_id = building owner (lookup buildings.user_id).
  RETURN public.generate_invoices_for_building(
    (SELECT user_id FROM buildings WHERE id = p_building_id),
    p_building_id, p_billing_month, p_invoice_type
  );
END;
$function$
;

CREATE OR REPLACE FUNCTION public.generate_recurring_vouchers_v2()
 RETURNS TABLE(parent_id uuid, child_id uuid, voucher_date date)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_owner_ids uuid[];
  v_owner uuid;
BEGIN
  -- Lấy danh sách owner mà caller có quyền (super_admin → all owners; staff → các owner mình thuộc)
  IF public.is_super_admin() THEN
    SELECT array_agg(DISTINCT user_id) INTO v_owner_ids FROM buildings WHERE deleted_at IS NULL;
  ELSE
    SELECT array_agg(DISTINCT sa.user_id) INTO v_owner_ids
    FROM staff_assignments sa WHERE sa.staff_id = auth.uid();
  END IF;

  IF v_owner_ids IS NULL OR array_length(v_owner_ids, 1) IS NULL THEN
    RETURN;
  END IF;

  FOREACH v_owner IN ARRAY v_owner_ids LOOP
    RETURN QUERY SELECT * FROM public.generate_recurring_vouchers(v_owner);
  END LOOP;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.get_change_breakdown_v2(p_building_id uuid DEFAULT NULL::uuid, p_room_id uuid DEFAULT NULL::uuid, p_status invoice_status DEFAULT NULL::invoice_status, p_start_date date DEFAULT NULL::date, p_end_date date DEFAULT NULL::date, p_billing_month text DEFAULT NULL::text, p_payment_status text DEFAULT NULL::text, p_building_ids uuid[] DEFAULT NULL::uuid[])
 RETURNS TABLE(account_id uuid, account_name text, billing_month text, building_name text, room_name text, payer_name text, voucher_date date, change_amount numeric, code text)
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT ie.change_account_id, COALESCE(ca.name,'(chưa gán sổ thối)'),
    i.billing_month, b.name, r.name,
    COALESCE(NULLIF(ie.payer_name,''), NULLIF(ie.creator_name,''), ''),
    ie.voucher_date, ie.change_amount, ie.code
  FROM income_expenses ie
  JOIN invoices i ON i.id = ie.invoice_id
  LEFT JOIN accounts ca ON ca.id = ie.change_account_id
  LEFT JOIN buildings b ON b.id = i.building_id
  LEFT JOIN rooms r ON r.id = i.room_id
  WHERE ie.deleted_at IS NULL AND ie.type='INCOME' AND ie.change_amount > 0
    AND i.deleted_at IS NULL
    -- scope set-based (thay can_access_building(i.building_id) per-row):
    AND (
      ( (SELECT public.has_full_building_scope())
        AND NOT (i.building_id = ANY (((SELECT public.demo_building_ids()))::uuid[])) )
      OR i.building_id IN (SELECT public.accessible_building_ids())
    )
    AND (p_building_id IS NULL OR i.building_id = p_building_id)
    AND (p_building_ids IS NULL OR i.building_id = ANY(p_building_ids))
    AND (p_room_id IS NULL OR i.room_id = p_room_id)
    AND (p_status IS NULL OR i.status = p_status)
    AND (p_start_date IS NULL OR i.issue_date >= p_start_date)
    AND (p_end_date IS NULL OR i.issue_date <= p_end_date)
    AND (p_billing_month IS NULL OR i.billing_month = p_billing_month)
    AND (p_payment_status IS NULL
      OR (p_payment_status='paid' AND i.status='PAID')
      OR (p_payment_status='partial' AND i.status='PARTIAL_PAID')
      OR (p_payment_status='unpaid' AND i.status NOT IN ('PAID','PARTIAL_PAID')))
  ORDER BY ca.name, i.billing_month, b.name, r.name;
$function$
;

CREATE OR REPLACE FUNCTION public.get_deposit_breakdown_v2(p_building_id uuid DEFAULT NULL::uuid, p_room_id uuid DEFAULT NULL::uuid, p_start_date date DEFAULT NULL::date, p_end_date date DEFAULT NULL::date, p_billing_month text DEFAULT NULL::text, p_building_ids uuid[] DEFAULT NULL::uuid[])
 RETURNS TABLE(building_id uuid, building_name text, room_id uuid, room_name text, contract_id uuid, contract_number text, total_deposit numeric, deposit_paid numeric, deposit_remaining numeric, deposit_debt_mode text, voucher_id uuid, code text, voucher_date date, amount numeric, account_name text, notes text, invoice_id uuid, invoice_number text, invoice_total numeric)
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT ie.building_id, b.name, ie.room_id, r.name,
    ie.contract_id, c.contract_number,
    c.total_deposit, c.deposit_paid, c.deposit_remaining, c.deposit_debt_mode,
    ie.id, ie.code, ie.voucher_date,
    dep.amount,
    COALESCE(a.name,''), ie.notes,
    inv.id, inv.invoice_number, inv.total_amount
  FROM income_expenses ie
  JOIN LATERAL (
    SELECT COALESCE(SUM(it.amount), 0) AS amount
    FROM income_expense_items it
    JOIN income_expense_types t ON t.id = it.income_expense_type_id
    WHERE it.income_expense_id = ie.id AND t.is_deposit = TRUE
  ) dep ON dep.amount > 0
  LEFT JOIN buildings b ON b.id = ie.building_id
  LEFT JOIN rooms r ON r.id = ie.room_id
  LEFT JOIN contracts c ON c.id = ie.contract_id
  LEFT JOIN accounts a ON a.id = ie.account_id
  LEFT JOIN invoices inv ON inv.id = ie.invoice_id AND inv.deleted_at IS NULL
  WHERE ie.deleted_at IS NULL AND ie.type='INCOME' AND ie.approval_status='APPROVED'
    -- scope set-based (thay can_access_building(ie.building_id) per-row);
    -- đặt TRƯỚC các filter khác về mặt logic — planner sẽ lọc scope bằng
    -- InitPlan trước khi chạy LATERAL SUM cho dòng ngoài phạm vi.
    AND (
      ( (SELECT public.has_full_building_scope())
        AND NOT (ie.building_id = ANY (((SELECT public.demo_building_ids()))::uuid[])) )
      OR ie.building_id IN (SELECT public.accessible_building_ids())
    )
    AND (p_building_id IS NULL OR ie.building_id = p_building_id)
    AND (p_building_ids IS NULL OR ie.building_id = ANY(p_building_ids))
    AND (p_room_id IS NULL OR ie.room_id = p_room_id)
    AND (p_start_date IS NULL OR ie.voucher_date >= p_start_date)
    AND (p_end_date IS NULL OR ie.voucher_date <= p_end_date)
    AND (p_billing_month IS NULL OR to_char(ie.voucher_date,'YYYY-MM') = p_billing_month)
  ORDER BY b.name, r.name, ie.voucher_date;
$function$
;

CREATE OR REPLACE FUNCTION public.get_invoice_statistics_v2(p_building_id uuid DEFAULT NULL::uuid, p_room_id uuid DEFAULT NULL::uuid, p_status invoice_status DEFAULT NULL::invoice_status, p_start_date date DEFAULT NULL::date, p_end_date date DEFAULT NULL::date, p_billing_month text DEFAULT NULL::text, p_payment_status text DEFAULT NULL::text, p_building_ids uuid[] DEFAULT NULL::uuid[])
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_total_paid        DECIMAL(15, 2) := 0;
  v_total_remaining   DECIMAL(15, 2) := 0;
  v_total_amount      DECIMAL(15, 2) := 0;
  v_total_refunded    DECIMAL(15, 2) := 0;
  v_total_count       BIGINT         := 0;
  v_rent_amount       DECIMAL(15, 2) := 0;
  v_electric_amount   DECIMAL(15, 2) := 0;
  v_water_amount      DECIMAL(15, 2) := 0;
  v_pdv_amount        DECIMAL(15, 2) := 0;
  v_total_collected   DECIMAL(15, 2) := 0;
  v_payment_tm        DECIMAL(15, 2) := 0;
  v_payment_tk        DECIMAL(15, 2) := 0;
  v_payment_tt        DECIMAL(15, 2) := 0;
  v_change_amount     DECIMAL(15, 2) := 0;
  v_deposit_collected DECIMAL(15, 2) := 0;
  v_payment_ct        DECIMAL(15, 2) := 0;
  v_priv              BOOLEAN        := FALSE;  -- thấy mọi toà
  v_bids              uuid[]         := NULL;   -- tập toà được phép (khi không priv)
BEGIN
  -- Tính phạm vi toà MỘT lần (thay can_access_building per-row).
  IF public.is_super_admin() OR public.is_admin()
     OR EXISTS (
       SELECT 1 FROM public.staff_assignments sa
       WHERE sa.staff_id = auth.uid() AND sa.building_id IS NULL AND sa.area_id IS NULL
     ) THEN
    v_priv := TRUE;
  ELSE
    SELECT array_agg(DISTINCT b) INTO v_bids
    FROM (
      SELECT sa.building_id AS b
      FROM public.staff_assignments sa
      WHERE sa.staff_id = auth.uid() AND sa.building_id IS NOT NULL
      UNION
      SELECT ab.building_id
      FROM public.staff_assignments sa2
      JOIN public.area_buildings ab ON ab.area_id = sa2.area_id
      WHERE sa2.staff_id = auth.uid() AND sa2.area_id IS NOT NULL
      UNION
      SELECT pmsb.building_id
      FROM public.profit_manager_salary_buildings pmsb
      JOIN public.profit_manager_salaries pms ON pms.id = pmsb.salary_id
      JOIN public.profit_managers pm ON pm.id = pms.manager_id
      WHERE pm.auth_user_id = auth.uid() AND pm.deleted_at IS NULL
    ) q;
  END IF;

  -- [DEMO-DOCS] Đặc quyền không bao gồm tòa demo sandbox: hạ v_priv xuống
  -- danh sách "MỌI tòa TRỪ demo" (kể cả tòa đã soft-delete — giữ nguyên hành vi
  -- cũ với hoá đơn thuộc tòa đã xoá mềm) để thống kê không lẫn số liệu demo.
  IF v_priv THEN
    v_priv := FALSE;
    SELECT array_agg(id) INTO v_bids
    FROM public.buildings
    WHERE NOT (id = ANY (public.demo_building_ids()));
  END IF;

  WITH filtered_invoices AS (
    SELECT i.id, i.total_amount, i.paid_amount, i.remaining_amount
    FROM public.invoices i
    WHERE i.deleted_at IS NULL
      AND (v_priv OR i.building_id = ANY(v_bids))
      AND (p_building_id   IS NULL OR i.building_id   = p_building_id)
      AND (p_building_ids  IS NULL OR i.building_id   = ANY(p_building_ids))
      AND (p_room_id       IS NULL OR i.room_id       = p_room_id)
      AND (p_status        IS NULL OR i.status        = p_status)
      AND (p_start_date    IS NULL OR i.issue_date    >= p_start_date)
      AND (p_end_date      IS NULL OR i.issue_date    <= p_end_date)
      AND (p_billing_month IS NULL OR i.billing_month = p_billing_month)
      AND (
        p_payment_status IS NULL
        OR (p_payment_status = 'paid'    AND i.status = 'PAID')
        OR (p_payment_status = 'partial' AND i.status = 'PARTIAL_PAID')
        OR (p_payment_status = 'unpaid'  AND i.status NOT IN ('PAID','PARTIAL_PAID'))
      )
  )
  SELECT
    COALESCE(SUM(total_amount), 0),
    COALESCE(SUM(paid_amount), 0),
    COALESCE(SUM(GREATEST(remaining_amount, 0)), 0),
    COALESCE(SUM(GREATEST(-remaining_amount, 0)), 0),
    COUNT(*)
  INTO v_total_amount, v_total_paid, v_total_remaining, v_total_refunded, v_total_count
  FROM filtered_invoices;

  SELECT
    COALESCE(SUM(CASE WHEN ii.type = 'RENT' THEN ii.amount ELSE 0 END), 0),
    COALESCE(SUM(CASE
      WHEN ii.type NOT IN ('RENT','DISCOUNT')
        AND LOWER(COALESCE(ii.description, '')) LIKE '%điện%'
      THEN ii.amount ELSE 0 END), 0),
    COALESCE(SUM(CASE
      WHEN ii.type NOT IN ('RENT','DISCOUNT')
        AND LOWER(COALESCE(ii.description, '')) LIKE '%nước%'
      THEN ii.amount ELSE 0 END), 0),
    COALESCE(SUM(CASE
      WHEN ii.type NOT IN ('RENT','DISCOUNT')
        AND LOWER(COALESCE(ii.description, '')) NOT LIKE '%điện%'
        AND LOWER(COALESCE(ii.description, '')) NOT LIKE '%nước%'
      THEN ii.amount ELSE 0 END), 0)
  INTO v_rent_amount, v_electric_amount, v_water_amount, v_pdv_amount
  FROM public.invoices i
  JOIN public.invoice_items ii ON ii.invoice_id = i.id
  WHERE i.deleted_at IS NULL
    AND (v_priv OR i.building_id = ANY(v_bids))
    AND (p_building_id   IS NULL OR i.building_id   = p_building_id)
    AND (p_building_ids  IS NULL OR i.building_id   = ANY(p_building_ids))
    AND (p_room_id       IS NULL OR i.room_id       = p_room_id)
    AND (p_status        IS NULL OR i.status        = p_status)
    AND (p_start_date    IS NULL OR i.issue_date    >= p_start_date)
    AND (p_end_date      IS NULL OR i.issue_date    <= p_end_date)
    AND (p_billing_month IS NULL OR i.billing_month = p_billing_month)
    AND (
      p_payment_status IS NULL
      OR (p_payment_status = 'paid'    AND i.status = 'PAID')
      OR (p_payment_status = 'partial' AND i.status = 'PARTIAL_PAID')
      OR (p_payment_status = 'unpaid'  AND i.status NOT IN ('PAID','PARTIAL_PAID'))
    );

  SELECT
    COALESCE(SUM(p.amount), 0),
    COALESCE(SUM(CASE WHEN p.payment_method = 'TM' THEN p.amount ELSE 0 END), 0),
    COALESCE(SUM(CASE WHEN p.payment_method = 'TK' THEN p.amount ELSE 0 END), 0),
    COALESCE(SUM(CASE WHEN p.payment_method = 'TT' THEN p.amount ELSE 0 END), 0),
    COALESCE(SUM(CASE WHEN p.payment_method = 'CT' THEN p.amount ELSE 0 END), 0)
  INTO v_total_collected, v_payment_tm, v_payment_tk, v_payment_tt, v_payment_ct
  FROM public.payments p
  JOIN public.invoices i ON i.id = p.invoice_id
  WHERE i.deleted_at IS NULL
    AND (v_priv OR i.building_id = ANY(v_bids))
    AND (p_building_id   IS NULL OR i.building_id   = p_building_id)
    AND (p_building_ids  IS NULL OR i.building_id   = ANY(p_building_ids))
    AND (p_room_id       IS NULL OR i.room_id       = p_room_id)
    AND (p_status        IS NULL OR i.status        = p_status)
    AND (p_start_date    IS NULL OR i.issue_date    >= p_start_date)
    AND (p_end_date      IS NULL OR i.issue_date    <= p_end_date)
    AND (p_billing_month IS NULL OR i.billing_month = p_billing_month)
    AND (
      p_payment_status IS NULL
      OR (p_payment_status = 'paid'    AND i.status = 'PAID')
      OR (p_payment_status = 'partial' AND i.status = 'PARTIAL_PAID')
      OR (p_payment_status = 'unpaid'  AND i.status NOT IN ('PAID','PARTIAL_PAID'))
    );

  SELECT COALESCE(SUM(ie.change_amount), 0)
  INTO v_change_amount
  FROM public.income_expenses ie
  JOIN public.invoices i ON i.id = ie.invoice_id
  WHERE ie.deleted_at IS NULL
    AND ie.type = 'INCOME'
    AND ie.change_amount > 0
    AND i.deleted_at IS NULL
    AND (v_priv OR i.building_id = ANY(v_bids))
    AND (p_building_id   IS NULL OR i.building_id   = p_building_id)
    AND (p_building_ids  IS NULL OR i.building_id   = ANY(p_building_ids))
    AND (p_room_id       IS NULL OR i.room_id       = p_room_id)
    AND (p_status        IS NULL OR i.status        = p_status)
    AND (p_start_date    IS NULL OR i.issue_date    >= p_start_date)
    AND (p_end_date      IS NULL OR i.issue_date    <= p_end_date)
    AND (p_billing_month IS NULL OR i.billing_month = p_billing_month)
    AND (
      p_payment_status IS NULL
      OR (p_payment_status = 'paid'    AND i.status = 'PAID')
      OR (p_payment_status = 'partial' AND i.status = 'PARTIAL_PAID')
      OR (p_payment_status = 'unpaid'  AND i.status NOT IN ('PAID','PARTIAL_PAID'))
    );

  -- Cọc đã thu — Σ ITEM cọc (phiếu trộn chỉ tính phần cọc, không lôi cả total).
  SELECT COALESCE(SUM(it.amount), 0)
  INTO v_deposit_collected
  FROM public.income_expenses ie
  JOIN public.income_expense_items it ON it.income_expense_id = ie.id
  JOIN public.income_expense_types t  ON t.id = it.income_expense_type_id AND t.is_deposit = TRUE
  WHERE ie.deleted_at IS NULL
    AND ie.type = 'INCOME'
    AND ie.approval_status = 'APPROVED'
    AND (v_priv OR ie.building_id = ANY(v_bids))
    AND (p_building_id   IS NULL OR ie.building_id   = p_building_id)
    AND (p_building_ids  IS NULL OR ie.building_id   = ANY(p_building_ids))
    AND (p_room_id       IS NULL OR ie.room_id       = p_room_id)
    AND (p_start_date    IS NULL OR ie.voucher_date  >= p_start_date)
    AND (p_end_date      IS NULL OR ie.voucher_date  <= p_end_date)
    AND (p_billing_month IS NULL OR to_char(ie.voucher_date, 'YYYY-MM') = p_billing_month);

  RETURN json_build_object(
    'total_amount',       v_total_amount,
    'total_paid',         v_total_paid,
    'total_remaining',    v_total_remaining,
    'total_refunded',     v_total_refunded,
    'total_count',        v_total_count,
    'rent_amount',        v_rent_amount,
    'electric_amount',    v_electric_amount,
    'water_amount',       v_water_amount,
    'pdv_amount',         v_pdv_amount,
    'total_collected',    v_total_collected,
    'payment_tm',         v_payment_tm,
    'payment_tk',         v_payment_tk,
    'payment_tt',         v_payment_tt,
    'payment_ct',         v_payment_ct,
    'change_amount',      v_change_amount,
    'deposit_collected',  v_deposit_collected
  );
END;
$function$
;

CREATE OR REPLACE FUNCTION public.get_meters_without_readings_v2(p_building_id uuid DEFAULT NULL::uuid, p_room_id uuid DEFAULT NULL::uuid, p_meter_type text DEFAULT NULL::text, p_month text DEFAULT NULL::text)
 RETURNS TABLE(meter_id uuid, code text, name text, room_name text, meter_type text, last_reading numeric, last_reading_date date)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_owner uuid;
BEGIN
  -- Single-org: caller có quyền access building → lấy owner của building đó qua FK
  -- Cách simple nhất: delegate v1 với p_user_id của 1 owner mà caller thấy được
  IF p_building_id IS NOT NULL THEN
    IF NOT public.can_access_building(p_building_id) THEN
      RAISE EXCEPTION 'Access denied for building %', p_building_id;
    END IF;
    SELECT user_id INTO v_owner FROM buildings WHERE id = p_building_id;
  ELSE
    -- Pick first owner visible to caller
    IF public.is_super_admin() THEN
      SELECT user_id INTO v_owner FROM buildings WHERE deleted_at IS NULL LIMIT 1;
    ELSE
      SELECT DISTINCT sa.user_id INTO v_owner FROM staff_assignments sa
       WHERE sa.staff_id = auth.uid() LIMIT 1;
    END IF;
  END IF;

  IF v_owner IS NULL THEN RETURN; END IF;

  RETURN QUERY SELECT * FROM public.get_meters_without_readings(v_owner, p_building_id, p_room_id, p_meter_type, p_month);
END;
$function$
;

CREATE OR REPLACE FUNCTION public.get_salary_progress_v5(p_month date DEFAULT NULL::date)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_uid UUID := auth.uid();
  v_month DATE := date_trunc('month', COALESCE(p_month, public.vn_local_date(now())))::date;
  v_days JSONB;
BEGIN
  PERFORM public.v5_recompute_streak(v_uid, v_month);
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'date', d.d, 'is_workday', (EXTRACT(dow FROM d.d) <> 0
        AND NOT EXISTS (SELECT 1 FROM public.salary_holidays h
              WHERE h.user_id=(SELECT user_id FROM public.super_admins ORDER BY created_at LIMIT 1)
                AND h.holiday_date=d.d)),
    'status', COALESCE(sad.status, 'pending'), 'source', sad.tick_source
  ) ORDER BY d.d), '[]'::jsonb) INTO v_days
  FROM generate_series(v_month, (v_month + INTERVAL '1 month')::date - 1, INTERVAL '1 day') d(d)
  LEFT JOIN public.salary_attendance_day sad ON sad.user_id = v_uid AND sad.work_date = d.d
  WHERE d.d <= public.vn_local_date(now());

  RETURN public.v5_month_money(v_uid, v_month) || jsonb_build_object('days', v_days);
END; $function$
;

CREATE OR REPLACE FUNCTION public.list_my_pending_approvals_v1()
 RETURNS TABLE(request_id uuid, submission_no bigint, submitted_at timestamp with time zone, amount numeric, voucher_id uuid, voucher_code text, voucher_name text, voucher_type text, maker_name text, step_no integer, request_version bigint)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'app_private'
AS $function$
  select ar.id, ar.submission_no, ar.submitted_at,
         ar.amount, ie.id, ie.code, ie.name, ie.type::text,
         coalesce(ie.creator_name, '—'), s.step_no, ar.version
    from public.approval_requests ar
    join public.approval_request_steps s
      on s.request_id = ar.id and s.status = 'PENDING'
    join public.approval_request_step_candidates c
      on c.request_step_id = s.id
     and c.generation = s.current_generation
     and c.valid_to is null
    join public.organization_memberships m
      on m.id = c.membership_id and m.status = 'ACTIVE'
    left join public.income_expenses ie on ie.id = ar.subject_id
   where ar.state = 'PENDING_APPROVAL'
     and ar.subject_type = 'FINANCIAL_VOUCHER'
     and m.user_id = auth.uid()
   order by ar.submitted_at asc;
$function$
;

CREATE OR REPLACE FUNCTION public.lock_cashbook_period_v1(p_cashbook_id uuid, p_lock_date date, p_unlock boolean DEFAULT false)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'app_private'
AS $function$

declare

  v_actor uuid := auth.uid();

  v_acct record; v_org uuid; v_authz boolean; v_route text; v_new date;

begin

  if v_actor is null then raise exception 'Chưa đăng nhập' using errcode='42501'; end if;

  select a.id, a.organization_id, a.lock_date into v_acct

    from public.accounts a where a.id=p_cashbook_id and a.deleted_at is null for update;

  if not found then raise exception 'Không tìm thấy sổ quỹ' using errcode='42501'; end if;

  v_org := v_acct.organization_id;

  if v_org is null then raise exception 'Sổ quỹ chưa gắn tổ chức' using errcode='23514'; end if;



  perform app_private.lock_org_for_decision_v1(v_org);

  select allowed into v_authz from app_private.authorize_tenant_action_v3(

    v_actor, v_org, 'cashbooks.edit', null, p_cashbook_id);

  if not coalesce(v_authz,false) then

    raise exception 'Không có quyền khoá sổ (cashbooks.edit)' using errcode='42501'; end if;



  v_route := app_private.evaluate_feature_route('cashbook.lock_period.v1', v_org);

  if v_route <> 'CANONICAL' then raise exception 'Writer khoá sổ chưa bật' using errcode='55000'; end if;



  if p_unlock then

    v_new := null; -- clearing the lock is the explicit unlock branch

  else

    if p_lock_date is null then raise exception 'Ngày khoá trống'; end if;

    -- monotonic: cannot move an existing lock earlier

    if v_acct.lock_date is not null and p_lock_date < v_acct.lock_date then

      raise exception 'Không thể lùi ngày khoá sổ' using errcode='55000'; end if;

    v_new := p_lock_date;

  end if;



  update public.accounts set lock_date = v_new where id = p_cashbook_id;

  return json_build_object('cashbook_id', p_cashbook_id, 'lock_date', v_new);

end;

$function$
;

CREATE OR REPLACE FUNCTION public.lock_profit_month_v1(p_period_month text, p_rows jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'app_private'
AS $function$

declare

  v_actor uuid := auth.uid();

  v_org uuid;

  v_authz boolean;

  v_row jsonb;

  v_building uuid;

  v_pm_id uuid;

  v_pm_ids uuid[] := '{}';

  v_alloc jsonb;

  v_locked int := 0;

  v_allocs int := 0;

  v_period date;

begin

  if v_actor is null then

    raise exception 'Chưa đăng nhập' using errcode = '42501';

  end if;

  if p_period_month is null or p_period_month !~ '^\d{4}-\d{2}(-\d{2})?$' then

    raise exception 'period_month phải dạng YYYY-MM hoặc YYYY-MM-DD';

  end if;

  -- Cột period_month là DATE — chuẩn hoá YYYY-MM về ngày đầu tháng.

  v_period := (case when length(p_period_month) = 7

                    then p_period_month || '-01' else p_period_month end)::date;

  if p_rows is null or jsonb_typeof(p_rows) <> 'array' or jsonb_array_length(p_rows) = 0 then

    raise exception 'Không có dữ liệu để chốt';

  end if;



  -- Org suy từ building đầu tiên; mọi building phải cùng org ACTIVE.

  select b.organization_id into v_org

    from public.buildings b

   where b.id = (p_rows->0->>'building_id')::uuid and b.deleted_at is null;

  if v_org is null then

    raise exception 'Toà nhà không hợp lệ hoặc chưa có tổ chức';

  end if;

  if exists (

    select 1 from jsonb_array_elements(p_rows) r

    left join public.buildings b on b.id = (r->>'building_id')::uuid and b.deleted_at is null

    where b.id is null or b.organization_id is distinct from v_org

  ) then

    raise exception 'Danh sách toà chứa toà không thuộc cùng tổ chức' using errcode = '42501';

  end if;



  perform app_private.lock_org_for_decision_v1(v_org);

  select allowed into v_authz from app_private.authorize_tenant_action_v3(

    v_actor, v_org, 'shareholder_profit.lock', null, null);

  if not coalesce(v_authz, false) then

    raise exception 'Không có quyền chốt lợi nhuận (shareholder_profit.lock)' using errcode = '42501';

  end if;



  for v_row in select * from jsonb_array_elements(p_rows) loop

    v_building := (v_row->>'building_id')::uuid;



    insert into public.profit_monthly as pm

      (user_id, building_id, period_month, computed_profit, adjusted_profit,

       management_salary, status, locked_at, locked_by, organization_id)

    values

      (v_actor, v_building, v_period,

       coalesce((v_row->>'computed_profit')::numeric, 0),

       coalesce((v_row->>'adjusted_profit')::numeric, 0),

       coalesce((v_row->>'management_salary')::numeric, 0),

       'LOCKED', now(), v_actor, v_org)

    on conflict (building_id, period_month) do update

      set computed_profit  = excluded.computed_profit,

          adjusted_profit  = excluded.adjusted_profit,

          management_salary = excluded.management_salary,

          status = 'LOCKED', locked_at = now(), locked_by = v_actor,

          organization_id = v_org

    returning pm.id into v_pm_id;



    v_pm_ids := v_pm_ids || v_pm_id;

    v_locked := v_locked + 1;

  end loop;



  delete from public.profit_allocations where profit_monthly_id = any (v_pm_ids);

  delete from public.profit_manager_allocations where profit_monthly_id = any (v_pm_ids);



  for v_row in select * from jsonb_array_elements(p_rows) loop

    select pm.id into v_pm_id from public.profit_monthly pm

     where pm.building_id = (v_row->>'building_id')::uuid

       and pm.period_month = v_period;



    for v_alloc in select * from jsonb_array_elements(coalesce(v_row->'allocations', '[]'::jsonb)) loop

      insert into public.profit_allocations

        (user_id, profit_monthly_id, shareholder_id, percent, amount, organization_id)

      values (v_actor, v_pm_id, (v_alloc->>'shareholder_id')::uuid,

              coalesce((v_alloc->>'percent')::numeric, 0),

              coalesce((v_alloc->>'amount')::numeric, 0), v_org);

      v_allocs := v_allocs + 1;

    end loop;



    for v_alloc in select * from jsonb_array_elements(coalesce(v_row->'manager_allocations', '[]'::jsonb)) loop

      continue when coalesce((v_alloc->>'amount')::numeric, 0) = 0;

      insert into public.profit_manager_allocations

        (user_id, profit_monthly_id, manager_id, amount, organization_id)

      values (v_actor, v_pm_id, (v_alloc->>'manager_id')::uuid,

              (v_alloc->>'amount')::numeric, v_org);

    end loop;

  end loop;



  return jsonb_build_object('locked', v_locked, 'allocations', v_allocs);

end;

$function$
;

CREATE OR REPLACE FUNCTION public.lock_salary_month_v1(p_period_month date, p_managers jsonb, p_idempotency_key text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'app_private'
AS $function$
declare
  v_actor uuid := auth.uid();
  v_org uuid;
  v_building uuid;
  v_authz boolean;
  v_key text;
  v_hash text;
  v_op app_private.canonical_write_operations%rowtype;
  v_route text;
  c_op constant text := 'salary.lock.v1';
  v_now timestamptz := now();
  v_mgr jsonb;
  v_staff uuid;
  v_owner uuid;
  v_monthly_id uuid;
  v_cur_status text;
  v_ledger jsonb;
  v_vid uuid;
  v_v_status text;
  v_v_owned boolean;
  v_locked_count int := 0;
  v_approved_count int := 0;
  v_resp json;
begin
  if v_actor is null then raise exception 'Chưa đăng nhập' using errcode='42501'; end if;

  v_key := btrim(coalesce(p_idempotency_key,''));
  if v_key !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{7,199}$' then
    raise exception 'idempotency_key phải dài 8-200 ký tự ASCII an toàn'; end if;
  if p_period_month is null then raise exception 'Kỳ lương trống'; end if;
  if p_managers is null or jsonb_typeof(p_managers) <> 'array' then
    raise exception 'p_managers phải là JSON array'; end if;

  -- R3-FIX: org SUBJECT-DERIVED (không global-scan toà ảo — sai đa tenant). Org =
  -- tổ chức của nhân viên ĐẦU TIÊN trong p_managers (qua manager_salary_config →
  -- fallback organization_memberships); MỌI nhân viên phải cùng org đó.
  declare
    v_first_staff uuid := nullif(p_managers->0->>'staff_id','')::uuid;
  begin
    if v_first_staff is null then raise exception 'p_managers rỗng hoặc thiếu staff_id'; end if;
    select organization_id into v_org from public.manager_salary_config
     where staff_id = v_first_staff and organization_id is not null
     order by is_active desc, created_at desc limit 1;
    if v_org is null then
      select organization_id into v_org from public.organization_memberships
       where user_id = v_first_staff and status='ACTIVE' limit 1;
    end if;
    if v_org is null then raise exception 'Không xác định được tổ chức của nhân viên'; end if;
    -- mọi staff còn lại phải cùng org
    if exists (
      select 1 from jsonb_array_elements(p_managers) mg
      where nullif(mg->>'staff_id','')::uuid is not null
        and not exists (
          select 1 from public.organization_memberships m2
           where m2.user_id = (mg->>'staff_id')::uuid and m2.organization_id = v_org and m2.status='ACTIVE')
    ) then
      raise exception 'Danh sách nhân viên chứa người khác tổ chức' using errcode='42501';
    end if;
  end;
  -- toà ảo của CHÍNH org đó (tham số scope cho authorize)
  select b.id into v_building
    from public.buildings b join public.organizations o on o.id=b.organization_id and o.status='ACTIVE'
   where b.organization_id = v_org and b.is_virtual=true and b.deleted_at is null
   order by b.created_at limit 1 for share of o,b;

  perform app_private.lock_org_for_decision_v1(v_org);

  select allowed into v_authz from app_private.authorize_tenant_action_v3(
    v_actor, v_org, 'salary.lock', v_building, null);
  if not coalesce(v_authz,false) then
    raise exception 'Không có quyền chốt lương (salary.lock)' using errcode='42501'; end if;

  -- idempotency toàn-mẻ (mirror salary_payout_v1)
  v_hash := md5(jsonb_build_object('period',p_period_month,'org',v_org,'managers',p_managers)::text);
  insert into app_private.canonical_write_operations
    (organization_id, operation, subject_scope, actor_id, idempotency_key, payload_hash)
  values (v_org, c_op, p_period_month::text, v_actor, v_key, v_hash)
  on conflict (organization_id, operation, subject_scope, actor_id, idempotency_key) do nothing;
  select * into v_op from app_private.canonical_write_operations o
   where o.organization_id=v_org and o.operation=c_op and o.subject_scope=p_period_month::text
     and o.actor_id=v_actor and o.idempotency_key=v_key for update;
  if v_op.payload_hash <> v_hash then
    raise exception 'idempotency_key đã dùng với nội dung khác' using errcode='23505'; end if;
  if v_op.completed_at is not null then return v_op.response_payload::json; end if;

  v_route := app_private.evaluate_feature_route(c_op, v_org);
  if v_route <> 'CANONICAL' then
    raise exception 'Writer chốt lương chưa bật' using errcode='55000'; end if;

  -- ═══ D2b — GUARD 1: LỢI NHUẬN THÁNG PHẢI CHỐT TRƯỚC (insight owner) ═══
  -- Phần "đầu tư" trong lương lấy từ chốt lợi nhuận tháng; nếu tháng đó còn
  -- profit_monthly ở DRAFT thì số đầu tư chưa chuẩn → CHẶN, buộc chốt LN trước.
  -- Chỉ áp khi org CÓ dữ liệu lợi nhuận cho kỳ (không có → bỏ qua, org không dùng).
  if exists (
    select 1 from public.profit_monthly pm
     where pm.organization_id = v_org
       and pm.period_month = p_period_month
       and pm.status <> 'LOCKED'
  ) then
    raise exception 'Phải CHỐT LỢI NHUẬN tháng % trước khi chốt lương (phần đầu tư trong lương lấy từ đó)',
      to_char(p_period_month, 'MM/YYYY') using errcode = '55000';
  end if;

  -- ═══ D2b — GUARD 2: PHIẾU HOA HỒNG THIẾU SỔ QUỸ (liệt kê rõ) ═══
  -- Duyệt hoa hồng qua writer chuẩn ĐÒI sổ quỹ. Thay vì fail giữa chừng khó hiểu,
  -- quét trước MỌI phiếu HH sẽ-được-duyệt còn thiếu account_id → báo danh sách mã
  -- phiếu để kế toán bổ sung, KHÔNG chốt tới khi đủ.
  declare
    v_missing text;
  begin
    select string_agg(coalesce(ie.code, left(ie.id::text,8)), ', ' order by ie.code)
      into v_missing
      from public.income_expenses ie
     where ie.deleted_at is null
       and ie.approval_status = 'UNAPPROVED'
       and ie.account_id is null
       and ie.id in (
         select e.value::uuid
           from jsonb_array_elements(p_managers) as mgr(value)
                cross join lateral
                  jsonb_array_elements_text(coalesce(mgr.value->'commission_voucher_ids','[]'::jsonb)) as e(value)
         where e.value is not null and e.value <> ''
       );
    if v_missing is not null then
      raise exception 'Các phiếu hoa hồng sau CHƯA CHỌN SỔ QUỸ — bổ sung rồi mới chốt được: %', v_missing
        using errcode = '55000';
    end if;
  end;

  -- 1) Duyệt phiếu hoa hồng (dedupe toàn bộ managers) — QUA writer, KHÔNG raw UPDATE.
  for v_vid in
    select distinct e.value::uuid
      from jsonb_array_elements(p_managers) as mgr(value)
           cross join lateral
             jsonb_array_elements_text(coalesce(mgr.value->'commission_voucher_ids','[]'::jsonb)) as e(value)
  loop
    if v_vid is null then continue; end if;
    select ie.approval_status, app_private.is_income_expense_flow_owned(ie.id)
      into v_v_status, v_v_owned
      from public.income_expenses ie
     where ie.id = v_vid and ie.deleted_at is null;
    if not found then
      -- TODO-REVIEW R5: phiếu không tồn tại/đã xoá → bỏ qua (legacy .in() cũng no-op).
      continue;
    end if;
    if v_v_status in ('APPROVED','CANCELLED') then
      continue; -- chỉ duyệt UNAPPROVED (bỏ qua đã duyệt / đã huỷ — xem R5)
    end if;

    -- Branch theo CHÍNH predicate mà approve_income_expense_v1 dùng nội bộ
    -- (is_income_expense_flow_owned) — deterministic, không dựa vào so khớp chuỗi
    -- thông báo lỗi. Row canonical → writer canonical; row legacy → approve_voucher.
    -- Mọi lỗi quyền/sổ-quỹ từ 2 writer con đều PROPAGATE (fail-closed) — xem R4.
    if v_v_owned then
      perform public.approve_income_expense_v1(v_vid);
    else
      perform public.approve_voucher(v_vid);
    end if;
    v_approved_count := v_approved_count + 1;
  end loop;

  -- 2) Đóng băng từng quản lý: guard DRAFT→LOCKED, upsert LOCKED, re-snapshot.
  for v_mgr in select value from jsonb_array_elements(p_managers) loop
    v_staff := nullif(v_mgr->>'staff_id','')::uuid;
    if v_staff is null then raise exception 'Thiếu staff_id trong p_managers'; end if;

    -- owner (mirror hook ownerId). TODO-REVIEW R2.
    select user_id into v_owner
      from public.manager_salary_config
     where staff_id = v_staff and is_active = true
       and effective_from <= p_period_month
       and (effective_to is null or effective_to >= p_period_month)
     order by created_at limit 1;
    if v_owner is null then
      select user_id into v_owner from public.super_admins order by created_at limit 1;
    end if;
    if v_owner is null then
      raise exception 'Không xác định được chủ bảng lương cho nhân viên %', v_staff; end if;

    -- guard DRAFT→LOCKED (idempotent: đã LOCKED → bỏ qua)
    select id, status into v_monthly_id, v_cur_status
      from public.salary_monthly
     where staff_id = v_staff and period_month = p_period_month
     for update;
    if v_cur_status = 'LOCKED' then
      continue; -- TODO-REVIEW: re-lock có cần re-snapshot lại không? Hiện no-op.
    end if;

    -- upsert LOCKED — MIRROR cột hook (R1: tin số client; R7: paid clobber; R6: org).
    insert into public.salary_monthly (
      user_id, staff_id, period_month, status, base_salary, work_bonus,
      contract_bonus, commission_total, investment_profit, adjustments_total,
      advances_total, room_rent, gross_total, take_home, paid,
      locked_at, locked_by, organization_id
    ) values (
      v_owner, v_staff, p_period_month, 'LOCKED',
      coalesce((v_mgr->>'base_salary')::numeric, 0),
      coalesce((v_mgr->>'work_bonus')::numeric, 0),
      coalesce((v_mgr->>'contract_bonus')::numeric, 0),
      coalesce((v_mgr->>'commission_total')::numeric, 0),
      coalesce((v_mgr->>'investment_profit')::numeric, 0),
      coalesce((v_mgr->>'adjustments_total')::numeric, 0),
      coalesce((v_mgr->>'advances_total')::numeric, 0),
      coalesce((v_mgr->>'room_rent')::numeric, 0),
      coalesce((v_mgr->>'gross_total')::numeric, 0),
      coalesce((v_mgr->>'take_home')::numeric, 0),
      coalesce((v_mgr->>'paid')::numeric, 0),
      v_now, v_actor, v_org
    )
    on conflict (staff_id, period_month) do update set
      user_id           = excluded.user_id,
      status            = 'LOCKED',
      base_salary       = excluded.base_salary,
      work_bonus        = excluded.work_bonus,
      contract_bonus    = excluded.contract_bonus,
      commission_total  = excluded.commission_total,
      investment_profit = excluded.investment_profit,
      adjustments_total = excluded.adjustments_total,
      advances_total    = excluded.advances_total,
      room_rent         = excluded.room_rent,
      gross_total       = excluded.gross_total,
      take_home         = excluded.take_home,
      paid              = excluded.paid,   -- TODO-REVIEW R7
      locked_at         = v_now,
      locked_by         = v_actor,
      organization_id   = coalesce(public.salary_monthly.organization_id, excluded.organization_id)
    returning id into v_monthly_id;

    -- re-snapshot bảng kê (xoá cũ + ghi lại) — MIRROR cột hook.
    delete from public.salary_work_ledger_snapshot where salary_monthly_id = v_monthly_id;
    v_ledger := coalesce(v_mgr->'ledger', '[]'::jsonb);
    if jsonb_typeof(v_ledger) = 'array' and jsonb_array_length(v_ledger) > 0 then
      insert into public.salary_work_ledger_snapshot (
        user_id, salary_monthly_id, staff_id, item_type, source_id, occurred_date,
        day_label, content, place, job_type_name, is_repair, is_contract,
        base_amount, weekend_amount, after_amount, cash_amount, has_photo,
        bonus_amount, reason, organization_id
      )
      select
        v_owner, v_monthly_id, v_staff,
        r->>'item_type',                              -- NOT NULL: client luôn cấp (R1)
        nullif(r->>'source_id','')::uuid,
        nullif(r->>'occurred_date','')::date,
        r->>'day_label', r->>'content', r->>'place', r->>'job_type_name',
        (r->>'is_repair')::boolean, (r->>'is_contract')::boolean,
        nullif(r->>'base_amount','')::numeric,
        nullif(r->>'weekend_amount','')::numeric,
        nullif(r->>'after_amount','')::numeric,
        nullif(r->>'cash_amount','')::numeric,
        (r->>'has_photo')::boolean,
        nullif(r->>'bonus_amount','')::numeric,
        r->>'reason', v_org
      from jsonb_array_elements(v_ledger) as t(r);
    end if;

    v_locked_count := v_locked_count + 1;
  end loop;

  v_resp := json_build_object(
    'period_month', p_period_month,
    'locked_count', v_locked_count,
    'commission_approved', v_approved_count,
    'state', 'LOCKED');
  -- Ledger-guard đòi set subject_id+response_payload+completed_at CÙNG LÚC.
  -- subject_id = bản ghi lương cuối cùng đã khoá (đại diện; luôn ≥1 do guard).
  update app_private.canonical_write_operations
     set subject_id = coalesce(v_monthly_id, v_actor),
         response_payload = to_jsonb(v_resp), completed_at = now()
   where organization_id=v_org and operation=c_op and subject_scope=p_period_month::text
     and actor_id=v_actor and idempotency_key=v_key;
  return v_resp;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.manager_salary_payout_v1(p_manager_id uuid, p_amount numeric, p_account_id uuid, p_voucher_date date, p_note text, p_idempotency_key text)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'app_private'
AS $function$
declare
  v_actor uuid := auth.uid();
  v_actor_name text;
  v_org uuid; v_building uuid; v_type uuid; v_membership uuid;
  v_subject_name text;
  v_authz boolean; v_key text; v_hash text;
  v_op app_private.canonical_write_operations%rowtype; v_route text;
  v_voucher uuid; v_req uuid; v_name text; v_resp json;
  c_op constant text := 'shareholder_profit.pay_manager.v1';
begin
  if v_actor is null then raise exception 'Chưa đăng nhập' using errcode='42501'; end if;

  v_key := btrim(coalesce(p_idempotency_key,''));
  if v_key !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{7,199}$' then
    raise exception 'idempotency_key phải dài 8-200 ký tự ASCII an toàn'; end if;
  if p_amount is null or p_amount <= 0 or round(p_amount,2) <> p_amount then
    raise exception 'Số tiền lương điều hành không hợp lệ'; end if;
  if p_account_id is null then
    raise exception 'Thiếu sổ quỹ để chi lương điều hành' using errcode='42501'; end if;

  -- [D1] Org resolve từ SUBJECT (quản lý). profit_managers.organization_id org_null=0.
  select m.organization_id, coalesce(nullif(btrim(m.name),''), 'Quản lý')
    into v_org, v_subject_name
    from public.profit_managers m
   where m.id = p_manager_id and m.deleted_at is null
   for share;
  if not found or v_org is null then
    raise exception 'Không tìm thấy quản lý hoặc quản lý chưa gán tổ chức' using errcode='42501';
  end if;

  select b.id into v_building
    from public.buildings b
    join public.organizations o on o.id = b.organization_id and o.status = 'ACTIVE'
   where b.organization_id = v_org and b.is_virtual = true and b.deleted_at is null
   order by b.created_at limit 1
   for share of o, b;
  if v_building is null then
    raise exception 'Tổ chức chưa có toà ảo (Chung) để hạch toán phiếu lương điều hành' using errcode='55000';
  end if;

  -- FORK B: quyền RIÊNG shareholder_profit.pay_manager.
  perform app_private.lock_org_for_decision_v1(v_org);
  select allowed into v_authz from app_private.authorize_tenant_action_v3(
    v_actor, v_org, 'shareholder_profit.pay_manager', v_building, p_account_id);
  if not coalesce(v_authz,false) then
    raise exception 'Không có quyền chi lương quản lý (shareholder_profit.pay_manager)' using errcode='42501'; end if;
  select m.id into v_membership from public.organization_memberships m
   where m.user_id=v_actor and m.organization_id=v_org and m.status='ACTIVE' limit 1 for share;
  if v_membership is null then raise exception 'Không còn là thành viên tổ chức' using errcode='42501'; end if;

  v_hash := md5(jsonb_build_object(
    'manager', p_manager_id, 'amount', round(p_amount,2),
    'account', p_account_id, 'voucher_date', p_voucher_date, 'org', v_org)::text);
  insert into app_private.canonical_write_operations
    (organization_id, operation, subject_scope, actor_id, idempotency_key, payload_hash)
  values (v_org, c_op, p_manager_id::text, v_actor, v_key, v_hash)
  on conflict (organization_id, operation, subject_scope, actor_id, idempotency_key) do nothing;
  select * into v_op from app_private.canonical_write_operations o
   where o.organization_id=v_org and o.operation=c_op and o.subject_scope=p_manager_id::text
     and o.actor_id=v_actor and o.idempotency_key=v_key for update;
  if v_op.payload_hash <> v_hash then
    raise exception 'idempotency_key đã dùng với nội dung khác' using errcode='23505'; end if;
  if v_op.completed_at is not null then return v_op.response_payload::json; end if;

  v_route := app_private.evaluate_feature_route(c_op, v_org);
  if v_route <> 'CANONICAL' then raise exception 'Writer lương điều hành chưa bật' using errcode='55000'; end if;

  select coalesce(nullif(btrim(full_name),''), nullif(btrim(email),''), 'Người dùng')
    into v_actor_name from public.profiles where id = v_actor;

  -- Hạng mục 'Lương điều hành' (category 'Chia lợi nhuận' — mirror client hook).
  select id into v_type from public.income_expense_types
   where organization_id = v_org and lower(type) = 'expense' and name = 'Lương điều hành'
   order by created_at limit 1;
  if v_type is null then
    insert into public.income_expense_types
      (user_id, organization_id, name, type, category, is_default, is_deposit)
    values (v_actor, v_org, 'Lương điều hành', 'expense', 'Chia lợi nhuận', false, false)
    returning id into v_type;
  end if;

  v_name := coalesce(nullif(btrim(coalesce(p_note,'')),''), 'Lương điều hành: ' || v_subject_name);

  insert into public.income_expenses (
    user_id, organization_id, creator_name, type, name,
    building_id, account_id, profit_manager_id,
    business_result_accounting, approval_status, voucher_date,
    attachments, repeat_cycle, repeat_infinity, repeat_count, repeat_remaining,
    source_payload_hash
  ) values (
    v_actor, v_org, coalesce(v_actor_name,'Người dùng'), 'EXPENSE', v_name,
    v_building, p_account_id, p_manager_id,
    false, 'UNAPPROVED', p_voucher_date,
    '[]'::jsonb, 'NONE', false, 0, 0,
    v_hash
  ) returning id into v_voucher;

  insert into public.income_expense_items (
    income_expense_id, organization_id, income_expense_type_id,
    description, quantity, unit_price, start_date, end_date
  ) values (
    v_voucher, v_org, v_type,
    nullif(btrim(coalesce(p_note,'')),''), 1, round(p_amount,2), p_voucher_date, p_voucher_date
  );

  v_req := app_private.submit_financial_request_v1(v_voucher, v_membership, v_actor, v_key || '-sub');

  v_resp := json_build_object(
    'manager_salary_voucher_id', v_voucher, 'approval_request_id', v_req,
    'manager_id', p_manager_id, 'state', 'PENDING_APPROVAL');
  update app_private.canonical_write_operations
     set subject_id=v_voucher, response_payload=to_jsonb(v_resp), completed_at=now()
   where organization_id=v_org and operation=c_op and subject_scope=p_manager_id::text
     and actor_id=v_actor and idempotency_key=v_key;
  return v_resp;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.occupancy_snapshot_v2(p_as_of_date date DEFAULT CURRENT_DATE, p_building_ids uuid[] DEFAULT NULL::uuid[])
 RETURNS TABLE(building_id uuid, building_name text, total integer, occupied integer, reserved integer, maintenance integer, unavailable integer, available integer, occupancy_pct numeric, committed_pct numeric, missed_revenue numeric, generated_at timestamp with time zone)
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $function$
  WITH allowed AS (
    SELECT b.id, b.name
    FROM public.buildings b
    WHERE b.deleted_at IS NULL
      AND b.is_virtual = false
      AND (p_building_ids IS NULL OR b.id = ANY(p_building_ids))
      AND public.can_access_building(b.id)
  ),
  classified AS (
    SELECT
      r.building_id AS bid,
      r.rent_price,
      CASE
        WHEN EXISTS (
          SELECT 1 FROM public.contracts c
          WHERE c.room_id = r.id
            AND c.deleted_at IS NULL
            AND c.status = 'ACTIVE'
            AND c.start_date <= p_as_of_date
            AND (c.actual_end_date IS NULL OR c.actual_end_date >= p_as_of_date)
        ) THEN 'occupied'
        WHEN r.status = 'RESERVED'    THEN 'reserved'
        WHEN r.status = 'MAINTENANCE' THEN 'maintenance'
        WHEN r.status = 'AVAILABLE'   THEN 'available'
        -- UNAVAILABLE + mọi trạng thái bất thường (VD OCCUPIED mồ côi HĐ):
        ELSE 'unavailable'
      END AS grp
    FROM public.rooms r
    JOIN allowed a ON a.id = r.building_id
    WHERE r.deleted_at IS NULL
  ),
  agg AS (
    SELECT
      bid,
      COUNT(*)::int                                   AS total,
      COUNT(*) FILTER (WHERE grp = 'occupied')::int    AS occupied,
      COUNT(*) FILTER (WHERE grp = 'reserved')::int    AS reserved,
      COUNT(*) FILTER (WHERE grp = 'maintenance')::int AS maintenance,
      COUNT(*) FILTER (WHERE grp = 'unavailable')::int AS unavailable,
      COUNT(*) FILTER (WHERE grp = 'available')::int   AS available,
      COALESCE(SUM(GREATEST(rent_price, 0)) FILTER (WHERE grp = 'available'), 0)::numeric
        AS missed_revenue
    FROM classified
    GROUP BY bid
  )
  SELECT
    a.id,
    a.name,
    COALESCE(g.total, 0),
    COALESCE(g.occupied, 0),
    COALESCE(g.reserved, 0),
    COALESCE(g.maintenance, 0),
    COALESCE(g.unavailable, 0),
    COALESCE(g.available, 0),
    CASE WHEN COALESCE(g.total, 0) = 0 THEN 0
         ELSE ROUND(g.occupied * 100.0 / g.total, 1) END::numeric,
    CASE WHEN COALESCE(g.total, 0) = 0 THEN 0
         ELSE ROUND((g.occupied + g.reserved) * 100.0 / g.total, 1) END::numeric,
    COALESCE(g.missed_revenue, 0),
    now()
  FROM allowed a
  LEFT JOIN agg g ON g.bid = a.id
  ORDER BY a.name;
$function$
;

CREATE OR REPLACE FUNCTION public.occupancy_upcoming_vacancy_v2(p_as_of_date date DEFAULT CURRENT_DATE, p_window_days integer DEFAULT 60, p_building_ids uuid[] DEFAULT NULL::uuid[])
 RETURNS TABLE(contract_id uuid, contract_number text, building_id uuid, building_name text, room_id uuid, room_name text, effective_end_date date, days_remaining integer, rent_price numeric, extension_applied boolean)
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $function$
  WITH allowed AS (
    SELECT b.id, b.name
    FROM public.buildings b
    WHERE b.deleted_at IS NULL
      AND b.is_virtual = false
      AND (p_building_ids IS NULL OR b.id = ANY(p_building_ids))
      AND public.can_access_building(b.id)
  ),
  eff AS (
    -- 1 dòng / HĐ ACTIVE đang hiệu lực tại as_of, kèm effective_end_date
    SELECT
      c.id,
      c.contract_number,
      c.room_id,
      GREATEST(
        c.end_date,
        COALESCE((
          SELECT MAX(ce.new_end_date::date)
          FROM public.contract_extensions ce
          WHERE ce.contract_id = c.id
            AND ce.status IN ('APPROVED', 'COMPLETED')
        ), c.end_date)
      )::date AS eff_end,
      EXISTS (
        SELECT 1 FROM public.contract_extensions ce
        WHERE ce.contract_id = c.id
          AND ce.status IN ('APPROVED', 'COMPLETED')
          AND ce.new_end_date::date > c.end_date
      ) AS ext_applied
    FROM public.contracts c
    WHERE c.deleted_at IS NULL
      AND c.status = 'ACTIVE'
      AND c.start_date <= p_as_of_date
      AND (c.actual_end_date IS NULL OR c.actual_end_date >= p_as_of_date)
  ),
  per_room AS (
    -- 1 phòng chỉ xuất hiện 1 lần: lấy HĐ có effective_end xa nhất
    SELECT DISTINCT ON (e.room_id)
      e.id, e.contract_number, e.room_id, e.eff_end, e.ext_applied
    FROM eff e
    ORDER BY e.room_id, e.eff_end DESC, e.id
  )
  SELECT
    p.id,
    p.contract_number,
    a.id,
    a.name,
    r.id,
    r.name,
    p.eff_end,
    (p.eff_end - p_as_of_date)::int,
    r.rent_price::numeric,
    p.ext_applied
  FROM per_room p
  JOIN public.rooms r ON r.id = p.room_id AND r.deleted_at IS NULL
  JOIN allowed a ON a.id = r.building_id
  WHERE (p.eff_end - p_as_of_date) BETWEEN 0 AND GREATEST(p_window_days, 0)
  ORDER BY p.eff_end, a.name, r.name;
$function$
;

CREATE OR REPLACE FUNCTION public.record_invoice_payment_v2(p_invoice_id uuid, p_amount numeric, p_payment_method payment_method, p_payment_date date, p_notes text DEFAULT NULL::text, p_receipt_image_url text DEFAULT NULL::text)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_invoice RECORD;
  v_payment_id uuid;
  v_new_paid_amount decimal(15,2);
  v_remaining decimal(15,2);
  v_excess decimal(15,2);
  v_new_status invoice_status;
  v_paid_date date;
  v_caller uuid := auth.uid();
BEGIN
  IF p_amount <= 0 THEN
    RAISE EXCEPTION 'Payment amount must be positive';
  END IF;

  -- Lookup invoice + check RBAC qua can_access_building
  SELECT id, user_id, building_id, contract_id, total_amount, paid_amount, remaining_amount, status
  INTO v_invoice
  FROM invoices
  WHERE id = p_invoice_id
    AND deleted_at IS NULL
    AND public.can_do_on_building('invoices','edit', building_id);

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Invoice not found or access denied';
  END IF;

  -- Insert payment (trigger set_user_id_audit auto-fill user_id = auth.uid())
  INSERT INTO payments (invoice_id, amount, payment_method, payment_date, notes, receipt_image_url)
  VALUES (p_invoice_id, p_amount, p_payment_method, p_payment_date, p_notes, p_receipt_image_url)
  RETURNING id INTO v_payment_id;

  v_new_paid_amount := COALESCE(v_invoice.paid_amount, 0) + p_amount;
  v_remaining := v_invoice.total_amount - v_new_paid_amount;

  IF v_new_paid_amount >= v_invoice.total_amount THEN
    v_new_status := 'PAID';
    v_paid_date := p_payment_date;
    v_excess := v_new_paid_amount - v_invoice.total_amount;

    IF v_excess > 0 THEN
      INSERT INTO excess_amounts (contract_id, amount, description, source_invoice_id, source_payment_id)
      VALUES (
        v_invoice.contract_id, v_excess,
        'Tiền thừa từ hoá đơn ' || (SELECT invoice_number FROM invoices WHERE id = p_invoice_id),
        p_invoice_id, v_payment_id
      );
    END IF;
  ELSE
    v_new_status := 'PARTIAL_PAID';
    v_paid_date := NULL;
    v_excess := 0;
  END IF;

  UPDATE invoices
  SET paid_amount = v_new_paid_amount,
      status = v_new_status,
      paid_date = v_paid_date
  WHERE id = p_invoice_id;

  RETURN json_build_object(
    'payment_id', v_payment_id,
    'new_paid_amount', v_new_paid_amount,
    'new_status', v_new_status,
    'excess_amount', v_excess
  );
END;
$function$
;

CREATE OR REPLACE FUNCTION public.record_invoice_payment_v3(p_invoice_id uuid, p_amount numeric, p_payment_method payment_method, p_payment_date date, p_idempotency_key text, p_account_id uuid DEFAULT NULL::uuid, p_notes text DEFAULT NULL::text, p_receipt_image_url text DEFAULT NULL::text, p_voucher jsonb DEFAULT NULL::jsonb, p_items jsonb DEFAULT NULL::jsonb, p_receipt_number text DEFAULT NULL::text, p_voucher_owner_id uuid DEFAULT NULL::uuid)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_caller uuid := auth.uid();
  v_inv RECORD; v_payment_id uuid; v_voucher_id uuid; v_owner uuid;
  v_new_paid numeric(15,2); v_status invoice_status; v_paid_date date; v_excess numeric(15,2) := 0;
  v_existing RECORD; it jsonb;
BEGIN
  IF v_caller IS NULL THEN RAISE EXCEPTION 'Chưa đăng nhập' USING ERRCODE='42501'; END IF;
  IF p_amount <= 0 THEN RAISE EXCEPTION 'Số tiền phải > 0'; END IF;
  IF p_idempotency_key IS NULL OR length(btrim(p_idempotency_key)) < 8 THEN RAISE EXCEPTION 'idempotency_key bắt buộc (>=8 ký tự)'; END IF;

  SELECT ie.id AS voucher_id, ie.payment_id INTO v_existing
  FROM income_expenses ie WHERE ie.idempotency_key = p_idempotency_key AND ie.deleted_at IS NULL LIMIT 1;
  IF FOUND THEN RETURN json_build_object('payment_id', v_existing.payment_id, 'voucher_id', v_existing.voucher_id, 'idempotent', true); END IF;

  SELECT id, user_id, building_id, contract_id, total_amount, paid_amount, status
  INTO v_inv FROM invoices WHERE id = p_invoice_id AND deleted_at IS NULL
    AND public.can_do_on_building('invoices','edit', building_id) FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Không tìm thấy hoá đơn hoặc không có quyền' USING ERRCODE='42501'; END IF;

  -- Voucher owner: mặc định caller; nếu truyền p_voucher_owner_id phải = invoice owner.
  IF p_voucher_owner_id IS NOT NULL AND p_voucher_owner_id <> v_inv.user_id THEN
    RAISE EXCEPTION 'p_voucher_owner_id phải là chủ hoá đơn' USING ERRCODE='42501';
  END IF;
  v_owner := COALESCE(p_voucher_owner_id, v_caller);

  INSERT INTO payments (invoice_id, amount, payment_method, payment_date, notes, receipt_image_url, receipt_number)
  VALUES (p_invoice_id, p_amount, p_payment_method, p_payment_date, p_notes, p_receipt_image_url, p_receipt_number)
  RETURNING id INTO v_payment_id;

  v_new_paid := COALESCE(v_inv.paid_amount,0) + p_amount;
  IF v_new_paid >= v_inv.total_amount THEN
    v_status := 'PAID'; v_paid_date := p_payment_date; v_excess := v_new_paid - v_inv.total_amount;
    IF v_excess > 0 THEN
      INSERT INTO excess_amounts (contract_id, amount, description, source_invoice_id, source_payment_id)
      VALUES (v_inv.contract_id, v_excess, 'Tiền thừa từ hoá đơn ' || (SELECT invoice_number FROM invoices WHERE id=p_invoice_id), p_invoice_id, v_payment_id);
    END IF;
  ELSE v_status := 'PARTIAL_PAID'; v_paid_date := NULL; END IF;

  UPDATE invoices SET paid_amount=v_new_paid, status=v_status, paid_date=v_paid_date WHERE id=p_invoice_id;

  IF p_account_id IS NOT NULL AND p_voucher IS NOT NULL THEN
    INSERT INTO income_expenses (
      user_id, type, name, building_id, room_id, contract_id, account_id, invoice_id, payment_id,
      voucher_date, payer_name, notes, attachments, approval_status, approved_by, approved_at,
      creator_name, business_result_accounting, change_amount, change_account_id, rounding_amount, rounding_account_id, idempotency_key
    ) VALUES (
      v_owner, 'INCOME', COALESCE(p_voucher->>'name','Thu tiền hoá đơn'),
      v_inv.building_id, NULLIF(p_voucher->>'room_id','')::uuid, v_inv.contract_id,
      p_account_id, p_invoice_id, v_payment_id, p_payment_date,
      p_voucher->>'payer_name', p_voucher->>'notes', COALESCE(p_voucher->'attachments','[]'::jsonb),
      'APPROVED', v_caller, now(), p_voucher->>'creator_name',
      CASE WHEN p_voucher ? 'business_result_accounting' AND jsonb_typeof(p_voucher->'business_result_accounting')='boolean'
           THEN (p_voucher->>'business_result_accounting')::boolean ELSE NULL END,
      COALESCE((p_voucher->>'change_amount')::numeric,0), NULLIF(p_voucher->>'change_account_id','')::uuid,
      COALESCE((p_voucher->>'rounding_amount')::numeric,0), NULLIF(p_voucher->>'rounding_account_id','')::uuid, p_idempotency_key
    ) RETURNING id INTO v_voucher_id;
    IF p_items IS NOT NULL THEN
      FOR it IN SELECT * FROM jsonb_array_elements(p_items) LOOP
        INSERT INTO income_expense_items (income_expense_id, income_expense_type_id, description, quantity, unit_price, start_date, end_date)
        VALUES (v_voucher_id, (it->>'income_expense_type_id')::uuid, it->>'description',
                COALESCE((it->>'quantity')::numeric,1), (it->>'unit_price')::numeric, NULLIF(it->>'start_date','')::date, NULLIF(it->>'end_date','')::date);
      END LOOP;
    END IF;
  END IF;

  RETURN json_build_object('payment_id', v_payment_id, 'voucher_id', v_voucher_id, 'new_paid_amount', v_new_paid, 'new_status', v_status, 'excess_amount', v_excess);
END;
$function$
;

CREATE OR REPLACE FUNCTION public.reject_contract_termination_v1(p_termination_id uuid, p_reason text DEFAULT NULL::text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'app_private'
AS $function$
declare
  v_actor uuid := auth.uid();
  v_term public.contract_terminations%rowtype;
  v_building uuid;
begin
  if v_actor is null then
    raise exception 'Chưa đăng nhập' using errcode = '42501';
  end if;

  select * into v_term from public.contract_terminations
   where id = p_termination_id for update;
  if not found then
    raise exception 'Không tìm thấy yêu cầu thanh lý hoặc bạn không có quyền' using errcode = '42501';
  end if;

  v_building := public.building_of_contract(v_term.contract_id);
  if not (public.is_super_admin()
          or public.can_do_on_building('contracts', 'edit', v_building)) then
    raise exception 'Không có quyền từ chối yêu cầu thanh lý này' using errcode = '42501';
  end if;

  if v_term.status = 'COMPLETED' then
    raise exception 'Yêu cầu đã hoàn tất thanh lý — không thể từ chối';
  end if;

  -- Mirror legacy: trả về DRAFT (không phải REJECTED) + prefix lý do vào notes.
  update public.contract_terminations
     set status = 'DRAFT',
         notes = case when nullif(btrim(coalesce(p_reason, '')), '') is not null
                      then '[Từ chối] ' || btrim(p_reason)
                      else notes end
   where id = v_term.id;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.request_opening_balance_adjustment_v1(p_cashbook_id uuid, p_delta numeric, p_reason text, p_idempotency_key text)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'app_private'
AS $function$

declare

  v_actor uuid := auth.uid();

  v_org uuid;

  v_acct record;

  v_authz boolean;

  v_holds boolean;

  v_key text; v_hash text;

  v_op app_private.canonical_write_operations%rowtype;

  v_route text;

  v_type uuid; v_voucher uuid;

  v_resp json;

  c_op constant text := 'cashbook.opening_adjust.v1';

begin

  if v_actor is null then raise exception 'Chưa đăng nhập' using errcode='42501'; end if;

  v_key := btrim(coalesce(p_idempotency_key,''));

  if char_length(v_key) < 8 or char_length(v_key) > 200

     or v_key !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{7,199}$' then

    raise exception 'idempotency_key phải dài 8-200 ký tự ASCII an toàn'; end if;

  if p_delta is null or p_delta = 0 or round(p_delta,2) <> p_delta then

    raise exception 'Giá trị điều chỉnh không hợp lệ'; end if;

  if coalesce(length(btrim(p_reason)),0) < 5 then raise exception 'Lý do điều chỉnh quá ngắn'; end if;



  select a.id, a.organization_id, a.initial_date, a.lock_date, a.quick_default_building_id

    into v_acct from public.accounts a

   where a.id=p_cashbook_id and a.deleted_at is null for update;

  if not found then raise exception 'Không tìm thấy sổ quỹ' using errcode='42501'; end if;

  v_org := v_acct.organization_id;

  if v_org is null then raise exception 'Sổ quỹ chưa gắn tổ chức' using errcode='23514'; end if;

  -- income_expenses.building_id is NOT NULL; an adjustment must be attributed to

  -- a building. Use the cashbook's default building, else the org's first one.

  if v_acct.quick_default_building_id is null then

    select id into v_acct.quick_default_building_id from public.buildings

     where organization_id=v_org and deleted_at is null order by created_at limit 1;

    if v_acct.quick_default_building_id is null then

      raise exception 'Không có toà nhà để ghi phiếu điều chỉnh' using errcode='55000'; end if;

  end if;



  -- exact permission cashbooks.post (requires possession) on this cashbook.

  perform app_private.lock_org_for_decision_v1(v_org);

  select allowed into v_authz from app_private.authorize_tenant_action_v3(

    v_actor, v_org, 'cashbooks.post', null, p_cashbook_id);

  if not coalesce(v_authz,false) then

    raise exception 'Không có quyền điều chỉnh sổ quỹ (cashbooks.post + possession)' using errcode='42501'; end if;



  v_hash := md5(jsonb_build_object('cb',p_cashbook_id,'org',v_org,'delta',p_delta)::text);

  insert into app_private.canonical_write_operations

    (organization_id, operation, subject_scope, actor_id, idempotency_key, payload_hash)

  values (v_org, c_op, p_cashbook_id::text, v_actor, v_key, v_hash)

  on conflict (organization_id, operation, subject_scope, actor_id, idempotency_key) do nothing;

  select * into v_op from app_private.canonical_write_operations o

   where o.organization_id=v_org and o.operation=c_op and o.subject_scope=p_cashbook_id::text

     and o.actor_id=v_actor and o.idempotency_key=v_key for update;

  if v_op.payload_hash <> v_hash then raise exception 'idempotency_key đã dùng với nội dung khác' using errcode='23505'; end if;

  if v_op.completed_at is not null then return v_op.response_payload::json; end if;



  v_route := app_private.evaluate_feature_route(c_op, v_org);

  if v_route <> 'CANONICAL' then raise exception 'Writer điều chỉnh sổ quỹ chưa bật' using errcode='55000'; end if;



  -- get-or-create the adjustment type; post a compensating voucher.

  select id into v_type from public.income_expense_types

   where organization_id=v_org and name='Điều chỉnh số dư đầu kỳ'

     and lower(coalesce(type,'income')) = case when p_delta > 0 then 'income' else 'expense' end

   limit 1;

  if v_type is null then

    insert into public.income_expense_types (organization_id, name, type)

    values (v_org, 'Điều chỉnh số dư đầu kỳ', case when p_delta>0 then 'income' else 'expense' end)

    returning id into v_type;

  end if;



  insert into public.income_expenses

    (user_id, organization_id, type, name, account_id, building_id, voucher_date,

     approval_status, approved_by, approved_at, notes)

  values (v_actor, v_org, case when p_delta>0 then 'INCOME' else 'EXPENSE' end,

          'Điều chỉnh số dư đầu kỳ', p_cashbook_id, v_acct.quick_default_building_id,

          greatest(v_acct.initial_date, coalesce(v_acct.lock_date, v_acct.initial_date) + 1),

          'APPROVED', v_actor, now(), 'Điều chỉnh: ' || p_reason)

  returning id into v_voucher;

  insert into public.income_expense_items

    (income_expense_id, organization_id, income_expense_type_id, description, quantity, unit_price)

  values (v_voucher, v_org, v_type, 'Điều chỉnh số dư đầu kỳ', 1, abs(p_delta));



  v_resp := json_build_object('adjustment_voucher_id', v_voucher, 'delta', p_delta);

  update app_private.canonical_write_operations

     set subject_id=v_voucher, response_payload=to_jsonb(v_resp), completed_at=now()

   where organization_id=v_org and operation=c_op and subject_scope=p_cashbook_id::text

     and actor_id=v_actor and idempotency_key=v_key;

  return v_resp;

end;

$function$
;

CREATE OR REPLACE FUNCTION public.salary_payout_v1(p_staff_id uuid, p_period_month date, p_take_home numeric, p_account_id uuid, p_voucher_date date, p_note text, p_idempotency_key text, p_rent_invoice_id uuid DEFAULT NULL::uuid, p_rent_amount numeric DEFAULT NULL::numeric)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'app_private'
AS $function$
declare
  v_actor uuid := auth.uid();
  v_org uuid; v_building uuid; v_type uuid; v_membership uuid;
  v_authz boolean; v_key text; v_hash text;
  v_op app_private.canonical_write_operations%rowtype; v_route text;
  v_voucher uuid; v_req uuid; v_resp json;
  -- rent-offset locals
  v_rent_collect numeric := 0;
  v_inv record;
  v_income_type uuid;
  v_rent_res json := null;
  c_op constant text := 'salary.payout.v1';
begin
  if v_actor is null then raise exception 'Chưa đăng nhập' using errcode='42501'; end if;
  v_key := btrim(coalesce(p_idempotency_key,''));
  if v_key !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{7,199}$' then
    raise exception 'idempotency_key phải dài 8-200 ký tự ASCII an toàn'; end if;
  if p_take_home is null or p_take_home <= 0 or round(p_take_home,2) <> p_take_home then
    raise exception 'Số tiền thực nhận không hợp lệ'; end if;
  if p_period_month is null then raise exception 'Kỳ lương trống'; end if;
  if p_rent_amount is not null and round(p_rent_amount,2) <> p_rent_amount then
    raise exception 'Tiền phòng khấu trừ không hợp lệ'; end if;

  -- R3-FIX (đồng bộ t5_11): org SUBJECT-DERIVED từ nhân viên nhận lương —
  -- KHÔNG global-scan toà ảo (đa tenant sẽ trỏ nhầm org). Toà ảo lấy TRONG org đó.
  select organization_id into v_org from public.manager_salary_config
   where staff_id = p_staff_id and organization_id is not null
   order by is_active desc, created_at desc limit 1;
  if v_org is null then
    select organization_id into v_org from public.organization_memberships
     where user_id = p_staff_id and status='ACTIVE' limit 1;
  end if;
  if v_org is null then raise exception 'Không xác định được tổ chức của nhân viên' using errcode='42501'; end if;
  select b.id into v_building
    from public.buildings b
    join public.organizations o on o.id=b.organization_id and o.status='ACTIVE'
   where b.organization_id = v_org and b.is_virtual=true and b.deleted_at is null
   order by b.created_at limit 1 for share of o,b;
  if v_building is null then raise exception 'Tổ chức chưa có toà ảo (Chung) để hạch toán phiếu lương' using errcode='55000'; end if;

  -- exact permission salary.distribute; require actor membership.
  perform app_private.lock_org_for_decision_v1(v_org);
  select allowed into v_authz from app_private.authorize_tenant_action_v3(
    v_actor, v_org, 'salary.distribute', v_building, p_account_id);
  if not coalesce(v_authz,false) then
    raise exception 'Không có quyền chi lương (salary.distribute)' using errcode='42501'; end if;
  select m.id into v_membership from public.organization_memberships m
   where m.user_id=v_actor and m.organization_id=v_org and m.status='ACTIVE' limit 1 for share;
  if v_membership is null then raise exception 'Không còn là thành viên tổ chức' using errcode='42501'; end if;

  -- idempotency (mở rộng hash: gồm cả rent để không nhầm "same key khác nội dung").
  v_hash := md5(jsonb_build_object('staff',p_staff_id,'period',p_period_month,
    'take_home',round(p_take_home,2),'org',v_org,
    'rent_invoice',p_rent_invoice_id,'rent_amount',round(coalesce(p_rent_amount,0),2))::text);
  insert into app_private.canonical_write_operations
    (organization_id, operation, subject_scope, actor_id, idempotency_key, payload_hash)
  values (v_org, c_op, p_staff_id::text || '|' || p_period_month::text, v_actor, v_key, v_hash)
  on conflict (organization_id, operation, subject_scope, actor_id, idempotency_key) do nothing;
  select * into v_op from app_private.canonical_write_operations o
   where o.organization_id=v_org and o.operation=c_op
     and o.subject_scope=p_staff_id::text || '|' || p_period_month::text
     and o.actor_id=v_actor and o.idempotency_key=v_key for update;
  if v_op.payload_hash <> v_hash then raise exception 'idempotency_key đã dùng với nội dung khác' using errcode='23505'; end if;
  if v_op.completed_at is not null then return v_op.response_payload::json; end if;

  v_route := app_private.evaluate_feature_route(c_op, v_org);
  if v_route <> 'CANONICAL' then raise exception 'Writer chi lương chưa bật' using errcode='55000'; end if;

  -- org-scoped "Lương quản lý" expense type.
  select id into v_type from public.income_expense_types
   where organization_id=v_org and lower(type)='expense' and name='Lương quản lý' limit 1;
  if v_type is null then
    insert into public.income_expense_types (organization_id, name, type)
    values (v_org, 'Lương quản lý', 'expense') returning id into v_type; end if;

  -- create the salary EXPENSE voucher UNAPPROVED (force-approval — never self-approve).
  insert into public.income_expenses
    (user_id, organization_id, type, name, building_id, account_id, salary_staff_id,
     voucher_date, approval_status, business_result_accounting, notes, source_payload_hash)
  values (v_actor, v_org, 'EXPENSE', 'Chi lương', v_building, p_account_id, p_staff_id,
          p_voucher_date, 'UNAPPROVED', false, coalesce(p_note,'Chi lương'), v_hash)
  returning id into v_voucher;

  -- item #1: tiền thực nhận (net).
  insert into public.income_expense_items
    (income_expense_id, organization_id, income_expense_type_id, description, quantity, unit_price)
  values (v_voucher, v_org, v_type, 'Tiền thực nhận', 1, round(p_take_home,2));

  -- ── RENT-OFFSET (phương án A) — chuẩn bị + thêm dòng #2 TRƯỚC khi submit ──
  -- (submit_financial_request_v1 chốt snapshot = income_expenses.total_amount, nên
  --  dòng tiền phòng phải có trước để engine thấy đúng GROSS.)
  if p_rent_invoice_id is not null and coalesce(p_rent_amount,0) > 0 then
    -- đọc hoá đơn (record_invoice_payment_v3 sẽ tự re-lock + check quyền — xem P4).
    select id, organization_id, user_id, building_id, total_amount,
           coalesce(remaining_amount, total_amount) as remaining
      into v_inv
      from public.invoices
     where id = p_rent_invoice_id and deleted_at is null;
    if not found then
      raise exception 'Hoá đơn tiền phòng không tồn tại' using errcode='42501'; end if;

    -- P5: clamp về phần còn nợ (mirror legacy; tránh excess ngoài ý muốn).
    v_rent_collect := least(round(p_rent_amount,2), coalesce(v_inv.remaining,0));
    if v_rent_collect <= 0 then
      v_rent_collect := 0;  -- hết nợ → bỏ offset, phiếu chi = net như thường.
    else
      -- item #2: dòng tiền phòng khấu trừ ⇒ phiếu chi = gross.
      insert into public.income_expense_items
        (income_expense_id, organization_id, income_expense_type_id, description, quantity, unit_price)
      values (v_voucher, v_org, v_type, 'Tiền phòng (khấu trừ)', 1, v_rent_collect);
    end if;
  end if;

  -- submit to the approval engine as FORCE-APPROVAL: submit_financial_request_v1
  -- classifies + routes; a salary voucher is never AUTO_POST. It is left PENDING
  -- for a checker to decide (this writer does not approve). Submit fails closed
  -- if no ACTIVE rule set exists — that is a real configuration error, surface it.
  v_req := app_private.submit_financial_request_v1(v_voucher, v_membership, v_actor, v_key || '-sub');

  -- ── RENT-OFFSET: ghi phiếu THU đối ứng qua record_invoice_payment_v3 (chữ ký THẬT).
  -- Nó tạo payments(CT) + income_expenses(INCOME, APPROVED) + cập nhật hoá đơn. Chạy
  -- SAU submit, CÙNG transaction. Xem P3 (bất đối xứng) / P4 (quyền) / P6 (loại thu).
  if v_rent_collect > 0 then
    -- P6: loại thu (không phải cọc) theo ORG CỦA HOÁ ĐƠN.
    select t.id into v_income_type
      from public.income_expense_types t
     where t.organization_id = v_inv.organization_id
       and lower(t.type) = 'income'
       and coalesce(t.is_deposit,false) = false
     order by
       (t.is_default is true) desc,
       (public.nrm_vn(t.name) = 'thu tien hoa don') desc,   -- nrm_vn: đã verify tồn tại (dùng trong submit_financial_request_v1). TODO-REVIEW P6: xác nhận CHUỖI tên loại thu chuẩn của org.
       t.created_at
     limit 1;
    if v_income_type is null then
      raise exception 'Org hoá đơn chưa có loại thu (không phải cọc) cho phiếu đối ứng tiền phòng'
        using errcode='55000'; end if;

    v_rent_res := public.record_invoice_payment_v3(
      p_invoice_id       => p_rent_invoice_id,
      p_amount           => v_rent_collect,
      p_payment_method   => 'CT'::public.payment_method,
      p_payment_date     => p_voucher_date,
      p_idempotency_key  => v_key || '-rent',
      p_account_id       => p_account_id,
      p_notes            => 'Cấn trừ tiền phòng vào lương',
      p_receipt_image_url=> null,
      p_voucher          => jsonb_build_object(
                              'name', 'Thu tiền phòng (khấu trừ lương)',
                              'payer_name', 'Khấu trừ lương',
                              'notes', 'Cấn trừ tiền phòng vào lương',
                              'creator_name', 'Chi lương'),
      p_items            => jsonb_build_array(jsonb_build_object(
                              'income_expense_type_id', v_income_type,
                              'description', 'Thu tiền phòng (khấu trừ lương)',
                              'quantity', 1,
                              'unit_price', v_rent_collect,
                              'start_date', p_voucher_date::text,
                              'end_date', p_voucher_date::text)),
      p_receipt_number   => null,
      p_voucher_owner_id => v_inv.user_id   -- phải = chủ hoá đơn (writer tự assert).
    );
  end if;

  -- salary_monthly bookkeeping.
  --  • ensure row tồn tại (như bản gốc).
  --  • STAMP payout_voucher_id = phiếu chi vừa tạo (link xác định — xem P2).
  --  • paid: KHÔNG đụng ở đây (tiền chưa POST). Cơ chế accrual paid khi POST chưa
  --    tồn tại trong engine — xem P1. KHÔNG bịa.
  insert into public.salary_monthly (user_id, staff_id, period_month, payout_voucher_id, organization_id)
  values (v_actor, p_staff_id, p_period_month, v_voucher, v_org)
  on conflict (staff_id, period_month) do update set
    payout_voucher_id = excluded.payout_voucher_id,
    organization_id   = coalesce(public.salary_monthly.organization_id, excluded.organization_id);

  v_resp := json_build_object('salary_voucher_id', v_voucher, 'approval_request_id', v_req,
    'state', 'PENDING_APPROVAL',
    'rent_offset', case when v_rent_collect > 0
                        then json_build_object('collected', v_rent_collect, 'result', v_rent_res)
                        else null end);
  update app_private.canonical_write_operations
     set subject_id=v_voucher, response_payload=to_jsonb(v_resp), completed_at=now()
   where organization_id=v_org and operation=c_op
     and subject_scope=p_staff_id::text || '|' || p_period_month::text
     and actor_id=v_actor and idempotency_key=v_key;
  return v_resp;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.set_cashbook_shared_users_v1(p_cashbook_id uuid, p_user_ids uuid[])
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'app_private'
AS $function$
declare v_actor uuid := auth.uid(); v_org uuid; v_authz boolean; v_uid uuid; v_bad int;
begin
  if v_actor is null then raise exception 'Chưa đăng nhập' using errcode='42501'; end if;
  select organization_id into v_org from public.accounts where id=p_cashbook_id and deleted_at is null;
  if v_org is null then raise exception 'Không tìm thấy sổ quỹ' using errcode='42501'; end if;
  perform app_private.lock_org_for_decision_v1(v_org);
  select allowed into v_authz from app_private.authorize_tenant_action_v3(
    v_actor, v_org, 'cashbooks.share', null, p_cashbook_id);
  if not coalesce(v_authz,false) then
    raise exception 'Không có quyền chia sẻ sổ quỹ (cashbooks.share)' using errcode='42501'; end if;

  -- validate mọi user cùng org
  select count(*) into v_bad from unnest(coalesce(p_user_ids,array[]::uuid[])) u(id)
    where not exists (select 1 from public.organization_memberships m
                       where m.user_id=u.id and m.organization_id=v_org and m.status='ACTIVE');
  if v_bad > 0 then raise exception 'Có % người dùng không thuộc tổ chức', v_bad using errcode='42501'; end if;

  delete from public.account_shared_users
   where account_id=p_cashbook_id
     and user_id <> all(coalesce(p_user_ids, array[]::uuid[]));
  foreach v_uid in array coalesce(p_user_ids, array[]::uuid[]) loop
    insert into public.account_shared_users (account_id, user_id, created_by, organization_id)
    values (p_cashbook_id, v_uid, v_actor, v_org)
    on conflict do nothing;
  end loop;
  return json_build_object('cashbook_id', p_cashbook_id, 'shared_count', coalesce(array_length(p_user_ids,1),0));
end;
$function$
;

CREATE OR REPLACE FUNCTION public.set_membership_status_v1(p_user_id uuid, p_status text, p_reason text DEFAULT NULL::text)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'app_private'
AS $function$
declare
  v_actor uuid := auth.uid();
  v_org uuid; v_memb uuid; v_owner_cnt int; v_sa_deleted int := 0;
begin
  if v_actor is null then raise exception 'Chưa đăng nhập' using errcode='42501'; end if;
  if p_status not in ('ACTIVE','SUSPENDED','REVOKED') then
    raise exception 'Trạng thái không hợp lệ (ACTIVE/SUSPENDED/REVOKED)' using errcode='22023';
  end if;
  if p_user_id = v_actor then
    raise exception 'Không thể tự đổi trạng thái của chính mình' using errcode='42501';
  end if;

  -- org: nơi người thao tác giữ role Chủ sở hữu tổ chức và đối tượng là thành viên
  select m.organization_id, m.id into v_org, v_memb
    from public.organization_memberships m
   where m.user_id = p_user_id
     and (
       public.is_super_admin()
       or exists (
         select 1 from public.role_bindings rb
           join public.organization_memberships om
             on om.id = rb.membership_id and om.organization_id = rb.organization_id
            and om.user_id = v_actor and om.status = 'ACTIVE'
           join public.organization_roles r
             on r.id = rb.role_id and r.name = 'Chủ sở hữu tổ chức'
          where rb.organization_id = m.organization_id
            and (rb.valid_to is null or rb.valid_to > now())
       )
     )
   order by (m.status = 'ACTIVE') desc
   limit 1;
  if v_memb is null then
    raise exception 'Không có quyền đổi trạng thái thành viên này' using errcode='42501';
  end if;

  -- không hạ cấp người chủ sở hữu cuối cùng
  if p_status <> 'ACTIVE' then
    select count(*) into v_owner_cnt
      from public.role_bindings rb
      join public.organization_memberships om
        on om.id = rb.membership_id and om.organization_id = rb.organization_id
       and om.status = 'ACTIVE'
      join public.organization_roles r
        on r.id = rb.role_id and r.name = 'Chủ sở hữu tổ chức'
     where rb.organization_id = v_org
       and (rb.valid_to is null or rb.valid_to > now())
       and om.user_id <> p_user_id;
    if v_owner_cnt = 0 and exists (
      select 1 from public.role_bindings rb
        join public.organization_memberships om
          on om.id = rb.membership_id and om.organization_id = rb.organization_id
         and om.user_id = p_user_id
        join public.organization_roles r
          on r.id = rb.role_id and r.name = 'Chủ sở hữu tổ chức'
       where rb.organization_id = v_org and (rb.valid_to is null or rb.valid_to > now())
    ) then
      raise exception 'Không thể đình chỉ/thu hồi CHỦ SỞ HỮU CUỐI CÙNG của tổ chức' using errcode='42501';
    end if;
  end if;

  update public.organization_memberships
     set status = p_status,
         revoked_at = case when p_status = 'REVOKED' then now() else null end,
         activated_at = case when p_status = 'ACTIVE' then coalesce(activated_at, now()) else activated_at end,
         version = version + 1
   where id = v_memb;

  -- THU HỒI: gỡ luôn assignment legacy (trigger a80 đóng role_binding).
  if p_status = 'REVOKED' then
    delete from public.staff_assignments
     where staff_id = p_user_id and organization_id = v_org;
    get diagnostics v_sa_deleted = row_count;
  end if;

  update public.organizations
     set authorization_version = authorization_version + 1
   where id = v_org;

  return json_build_object('user_id', p_user_id, 'organization_id', v_org,
                           'status', p_status, 'assignments_removed', v_sa_deleted,
                           'reason', nullif(btrim(coalesce(p_reason,'')),''));
end;
$function$
;

CREATE OR REPLACE FUNCTION public.unlock_profit_month_v1(p_period_month text, p_building_ids uuid[])
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'app_private'
AS $function$

declare

  v_actor uuid := auth.uid();

  v_org uuid;

  v_authz boolean;

  v_pm_ids uuid[];

  v_count int;

  v_period date;

begin

  if v_actor is null then

    raise exception 'Chưa đăng nhập' using errcode = '42501';

  end if;

  if p_building_ids is null or array_length(p_building_ids, 1) is null then

    return 0;

  end if;

  if p_period_month is null or p_period_month !~ '^\d{4}-\d{2}(-\d{2})?$' then

    raise exception 'period_month phải dạng YYYY-MM hoặc YYYY-MM-DD';

  end if;

  v_period := (case when length(p_period_month) = 7

                    then p_period_month || '-01' else p_period_month end)::date;



  select b.organization_id into v_org

    from public.buildings b where b.id = p_building_ids[1] and b.deleted_at is null;

  if v_org is null then

    raise exception 'Toà nhà không hợp lệ';

  end if;

  if exists (

    select 1 from unnest(p_building_ids) bid

    left join public.buildings b on b.id = bid and b.deleted_at is null

    where b.id is null or b.organization_id is distinct from v_org

  ) then

    raise exception 'Danh sách toà chứa toà không thuộc cùng tổ chức' using errcode = '42501';

  end if;



  perform app_private.lock_org_for_decision_v1(v_org);

  select allowed into v_authz from app_private.authorize_tenant_action_v3(

    v_actor, v_org, 'shareholder_profit.unlock', null, null);

  if not coalesce(v_authz, false) then

    raise exception 'Không có quyền mở khoá lợi nhuận (shareholder_profit.unlock)' using errcode = '42501';

  end if;



  select array_agg(id) into v_pm_ids from public.profit_monthly

   where period_month = v_period and building_id = any (p_building_ids);

  if v_pm_ids is null then return 0; end if;



  delete from public.profit_allocations where profit_monthly_id = any (v_pm_ids);

  delete from public.profit_manager_allocations where profit_monthly_id = any (v_pm_ids);

  update public.profit_monthly

     set status = 'DRAFT', management_salary = 0, locked_at = null, locked_by = null,

         organization_id = coalesce(organization_id, v_org)

   where id = any (v_pm_ids);

  get diagnostics v_count = row_count;

  return v_count;

end;

$function$
;

CREATE OR REPLACE FUNCTION public.unlock_salary_month_v1(p_period_month date, p_staff_ids uuid[], p_idempotency_key text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'app_private'
AS $function$
declare
  v_actor uuid := auth.uid();
  v_org uuid;
  v_building uuid;
  v_authz boolean;
  v_key text;
  v_hash text;
  v_op app_private.canonical_write_operations%rowtype;
  v_route text;
  c_op constant text := 'salary.unlock.v1';
  v_ids uuid[];
  v_unlocked_count int := 0;
  v_resp json;
begin
  if v_actor is null then raise exception 'Chưa đăng nhập' using errcode='42501'; end if;

  v_key := btrim(coalesce(p_idempotency_key,''));
  if v_key !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{7,199}$' then
    raise exception 'idempotency_key phải dài 8-200 ký tự ASCII an toàn'; end if;
  if p_period_month is null then raise exception 'Kỳ lương trống'; end if;
  if p_staff_ids is null or array_length(p_staff_ids,1) is null then
    raise exception 'Danh sách nhân viên trống'; end if;

  -- R3-FIX: org subject-derived từ nhân viên đầu tiên (đồng bộ lock).
  select organization_id into v_org from public.organization_memberships
   where user_id = p_staff_ids[1] and status='ACTIVE' limit 1;
  if v_org is null then
    select organization_id into v_org from public.manager_salary_config
     where staff_id = p_staff_ids[1] and organization_id is not null order by created_at desc limit 1;
  end if;
  if v_org is null then raise exception 'Không xác định được tổ chức của nhân viên'; end if;
  select b.id into v_building from public.buildings b
    join public.organizations o on o.id=b.organization_id and o.status='ACTIVE'
   where b.organization_id = v_org and b.is_virtual=true and b.deleted_at is null
   order by b.created_at limit 1 for share of o,b;

  perform app_private.lock_org_for_decision_v1(v_org);

  select allowed into v_authz from app_private.authorize_tenant_action_v3(
    v_actor, v_org, 'salary.unlock', v_building, null);
  if not coalesce(v_authz,false) then
    raise exception 'Không có quyền mở khoá lương (salary.unlock)' using errcode='42501'; end if;

  v_hash := md5(jsonb_build_object('period',p_period_month,'org',v_org,
                                   'staff', to_jsonb(p_staff_ids))::text);
  insert into app_private.canonical_write_operations
    (organization_id, operation, subject_scope, actor_id, idempotency_key, payload_hash)
  values (v_org, c_op, p_period_month::text, v_actor, v_key, v_hash)
  on conflict (organization_id, operation, subject_scope, actor_id, idempotency_key) do nothing;
  select * into v_op from app_private.canonical_write_operations o
   where o.organization_id=v_org and o.operation=c_op and o.subject_scope=p_period_month::text
     and o.actor_id=v_actor and o.idempotency_key=v_key for update;
  if v_op.payload_hash <> v_hash then
    raise exception 'idempotency_key đã dùng với nội dung khác' using errcode='23505'; end if;
  if v_op.completed_at is not null then return v_op.response_payload::json; end if;

  v_route := app_private.evaluate_feature_route(c_op, v_org);
  if v_route <> 'CANONICAL' then
    raise exception 'Writer mở khoá lương chưa bật' using errcode='55000'; end if;

  -- Chỉ mở các dòng đang LOCKED cho (kỳ, staff_ids) — guard LOCKED→DRAFT.
  -- (array_agg + FOR UPDATE không đi cùng → lock rows ở statement riêng trước.)
  perform 1 from public.salary_monthly
   where period_month = p_period_month and staff_id = any(p_staff_ids) and status = 'LOCKED'
   for update;
  select array_agg(id) into v_ids
    from public.salary_monthly
   where period_month = p_period_month
     and staff_id = any(p_staff_ids)
     and status = 'LOCKED';

  if v_ids is not null and array_length(v_ids,1) is not null then
    delete from public.salary_work_ledger_snapshot where salary_monthly_id = any(v_ids);
    update public.salary_monthly
       set status = 'DRAFT', locked_at = null, locked_by = null
     where id = any(v_ids);
    v_unlocked_count := array_length(v_ids,1);
  end if;
  -- CỐ Ý: KHÔNG đảo ngược duyệt hoa hồng (xem header). Không đụng income_expenses.

  v_resp := json_build_object(
    'period_month', p_period_month,
    'unlocked_count', v_unlocked_count,
    'state', 'DRAFT');
  update app_private.canonical_write_operations
     set subject_id = coalesce(v_ids[1], v_actor),
         response_payload = to_jsonb(v_resp), completed_at = now()
   where organization_id=v_org and operation=c_op and subject_scope=p_period_month::text
     and actor_id=v_actor and idempotency_key=v_key;
  return v_resp;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.update_cashbook_metadata_v1(p_cashbook_id uuid, p_name text, p_description text, p_initial_amount numeric, p_initial_date date, p_quick_default_building_id uuid, p_is_default boolean, p_owner_user_id uuid)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'app_private'
AS $function$
declare v_actor uuid := auth.uid(); v_org uuid; v_authz boolean; v_owner uuid;
begin
  if v_actor is null then raise exception 'Chưa đăng nhập' using errcode='42501'; end if;
  select organization_id into v_org from public.accounts where id=p_cashbook_id and deleted_at is null;
  if v_org is null then raise exception 'Không tìm thấy sổ quỹ' using errcode='42501'; end if;
  perform app_private.lock_org_for_decision_v1(v_org);
  select allowed into v_authz from app_private.authorize_tenant_action_v3(
    v_actor, v_org, 'cashbooks.edit', null, p_cashbook_id);
  if not coalesce(v_authz,false) then
    raise exception 'Không có quyền sửa sổ quỹ (cashbooks.edit)' using errcode='42501'; end if;
  if p_name is not null and length(btrim(p_name))=0 then raise exception 'Tên sổ quỹ trống'; end if;

  v_owner := p_owner_user_id;
  if v_owner is not null and v_owner <> (select user_id from public.accounts where id=p_cashbook_id) then
    perform 1 from public.organization_memberships m
      where m.user_id=v_owner and m.organization_id=v_org and m.status='ACTIVE';
    if not found then raise exception 'Người phụ trách không thuộc tổ chức' using errcode='42501'; end if;
  end if;

  if coalesce(p_is_default,false) then
    update public.accounts set is_default=false
     where organization_id=v_org and is_default=true and deleted_at is null and id<>p_cashbook_id;
  end if;

  update public.accounts set
    name = coalesce(nullif(btrim(p_name),''), name),
    description = case when p_description is null then description else nullif(btrim(p_description),'') end,
    initial_amount = coalesce(p_initial_amount, initial_amount),
    initial_date = coalesce(p_initial_date, initial_date),
    quick_default_building_id = p_quick_default_building_id,
    is_default = coalesce(p_is_default, is_default),
    user_id = coalesce(v_owner, user_id),
    updated_at = now()
  where id = p_cashbook_id;
  return json_build_object('cashbook_id', p_cashbook_id);
end;
$function$
;

CREATE OR REPLACE FUNCTION public.update_meter_reading_v1(p_id uuid, p_current_reading numeric DEFAULT NULL::numeric, p_reading_date date DEFAULT NULL::date, p_notes text DEFAULT NULL::text, p_meter_image_url text DEFAULT NULL::text, p_expected_updated_at timestamp with time zone DEFAULT NULL::timestamp with time zone)
 RETURNS meter_readings
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_caller uuid := auth.uid();
  v_r RECORD;
  v_row public.meter_readings;
BEGIN
  IF v_caller IS NULL THEN RAISE EXCEPTION 'Chưa đăng nhập' USING ERRCODE='42501'; END IF;

  SELECT id, building_id, organization_id, updated_at INTO v_r
  FROM public.meter_readings WHERE id = p_id AND deleted_at IS NULL FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Không tìm thấy chỉ số' USING ERRCODE='42501'; END IF;
  IF v_r.building_id IS NULL THEN RAISE EXCEPTION 'Chỉ số chưa gắn toà nhà'; END IF;

  IF NOT (v_r.organization_id IS NULL
          OR public.is_super_admin()
          OR v_r.organization_id = ANY(public.my_org_ids())) THEN
    RAISE EXCEPTION 'Chỉ số thuộc tổ chức khác' USING ERRCODE='42501';
  END IF;
  IF NOT public.can_do_on_building('meter_readings','edit', v_r.building_id) THEN
    RAISE EXCEPTION 'Không có quyền sửa chỉ số cho toà này' USING ERRCODE='42501';
  END IF;
  -- LƯU Ý: KHÔNG chặn edit khi APPROVED — giữ parity với đường cũ (form hiện sửa
  -- được chỉ số đã duyệt; chỉ số mới luôn tạo APPROVED). Chặn sẽ là đổi hành vi.
  -- Quyền đã được can_do_on_building enforce; đây không phải chứng từ tiền như invoice.
  IF p_expected_updated_at IS NOT NULL AND v_r.updated_at <> p_expected_updated_at THEN
    RAISE EXCEPTION 'Chỉ số đã bị thay đổi bởi người khác (version mismatch)' USING ERRCODE='40001';
  END IF;
  IF p_current_reading IS NOT NULL AND p_current_reading < 0 THEN
    RAISE EXCEPTION 'Chỉ số không hợp lệ';
  END IF;

  BEGIN
    UPDATE public.meter_readings SET
      current_reading = COALESCE(p_current_reading, current_reading),
      reading_date    = COALESCE(p_reading_date, reading_date),
      notes           = COALESCE(p_notes, notes),
      meter_image_url = COALESCE(p_meter_image_url, meter_image_url)
    WHERE id = p_id AND deleted_at IS NULL
    RETURNING * INTO v_row;
  EXCEPTION WHEN check_violation THEN
    RAISE EXCEPTION 'Chỉ số mới không hợp lệ (phải ≥ chỉ số kỳ trước)' USING ERRCODE='23514';
  END;

  RETURN v_row;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.verify_income_expense_v1(p_id uuid, p_note text DEFAULT NULL::text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'app_private'
AS $function$
declare
  v_actor uuid := auth.uid();
  v_row public.income_expenses%rowtype;
  v_can_see boolean;
  v_full_name text;
  v_rows integer;
begin
  if v_actor is null then
    raise exception 'Phải đăng nhập' using errcode = '42501';
  end if;

  select * into v_row from public.income_expenses
   where id = p_id
   for update;
  if not found then
    raise exception 'Không tìm thấy phiếu';
  end if;

  if not app_private.is_income_expense_flow_owned(v_row.id) then
    raise exception 'Phiếu chưa thuộc luồng canonical — dùng đường legacy'
      using errcode = '55000';
  end if;

  -- Parity verify legacy: caller phải có quyền xem phiếu.
  select (
    public.is_super_admin()
    or public.is_admin()
    or (v_row.building_id is not null and public.can_access_building(v_row.building_id))
    or public.is_account_shared_with_me(v_row.account_id)
  ) into v_can_see;
  if not v_can_see then
    raise exception 'Không có quyền xem phiếu này' using errcode = '42501';
  end if;

  if v_row.verified_at is not null then
    -- toggle bỏ kiểm: chỉ chủ kiểm hoặc super admin (parity legacy).
    if v_row.verified_by = v_actor or public.is_super_admin() then
      insert into app_private.ie_transition_authorization (income_expense_id, xid, purpose)
      values (v_row.id, pg_current_xact_id(), 'UNVERIFY');

      update public.income_expenses
         set verified_at = null, verified_by = null,
             verified_by_name = null, verified_note = null
       where id = v_row.id;
      get diagnostics v_rows = row_count;

      delete from app_private.ie_transition_authorization
       where income_expense_id = v_row.id and xid = pg_current_xact_id();

      if v_rows <> 1 then
        raise exception 'unverify affected % rows (expected 1)', v_rows using errcode = '55000';
      end if;

      perform app_private.append_income_expense_event_v1(
        v_row.organization_id, v_row.id, 'UNVERIFIED', v_actor,
        app_private.ie_actor_display_name_v1(v_actor),
        v_row.approval_status, v_row.approval_status, null);
      return;
    else
      raise exception 'Phiếu đã được % kiểm — chỉ super admin hoặc người kiểm mới bỏ được',
        coalesce(v_row.verified_by_name, 'người khác');
    end if;
  end if;

  select coalesce(full_name, email, 'Người dùng') into v_full_name
    from public.profiles where id = v_actor;

  insert into app_private.ie_transition_authorization (income_expense_id, xid, purpose)
  values (v_row.id, pg_current_xact_id(), 'VERIFY');

  update public.income_expenses
     set verified_at = now(), verified_by = v_actor,
         verified_by_name = v_full_name,
         verified_note = nullif(btrim(coalesce(p_note, '')), '')
   where id = v_row.id;
  get diagnostics v_rows = row_count;

  delete from app_private.ie_transition_authorization
   where income_expense_id = v_row.id and xid = pg_current_xact_id();

  if v_rows <> 1 then
    raise exception 'verify affected % rows (expected 1)', v_rows using errcode = '55000';
  end if;

  perform app_private.append_income_expense_event_v1(
    v_row.organization_id, v_row.id, 'VERIFIED', v_actor,
    coalesce(v_full_name, 'Người dùng'),
    v_row.approval_status, v_row.approval_status,
    nullif(btrim(coalesce(p_note, '')), ''));
end;
$function$
;

CREATE OR REPLACE FUNCTION public.withdraw_financial_request_v1(p_request_id uuid, p_reason text DEFAULT NULL::text)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'app_private'
AS $function$
declare
  v_actor uuid := auth.uid();
  v_req public.approval_requests%rowtype;
begin
  if v_actor is null then raise exception 'Chưa đăng nhập' using errcode='42501'; end if;
  select * into v_req from public.approval_requests
   where id = p_request_id for update;
  if not found then raise exception 'Không tìm thấy yêu cầu duyệt'; end if;
  if v_req.state <> 'PENDING_APPROVAL' then
    raise exception 'Yêu cầu không còn ở trạng thái chờ duyệt (%).', v_req.state;
  end if;
  if not (v_req.maker_user_id = v_actor or public.is_super_admin()) then
    raise exception 'Chỉ người lập (hoặc super admin) được rút yêu cầu' using errcode='42501';
  end if;

  update public.approval_requests
     set state = 'CANCELLED', version = version + 1
   where id = p_request_id;

  return json_build_object('request_id', p_request_id, 'state', 'CANCELLED');
end;
$function$
;


-- =====================================================================
-- MUC 5 — TRIGGER (13: 3 tren bang MUC 1 + 10 cross-table co guard)
-- =====================================================================

-- 5a. Tren bang do file nay tao (chay thang)
-- app_private.income_expense_audit_chain_heads
DROP TRIGGER IF EXISTS a00_chain_heads_no_truncate ON app_private.income_expense_audit_chain_heads;
CREATE TRIGGER a00_chain_heads_no_truncate BEFORE TRUNCATE ON app_private.income_expense_audit_chain_heads FOR EACH STATEMENT EXECUTE FUNCTION app_private.guard_audit_log_truncate();
-- app_private.server_feature_flag_events
DROP TRIGGER IF EXISTS a00_flag_events_immutable ON app_private.server_feature_flag_events;
CREATE TRIGGER a00_flag_events_immutable BEFORE DELETE OR UPDATE ON app_private.server_feature_flag_events FOR EACH ROW EXECUTE FUNCTION app_private.guard_rollout_ledger_immutable();
-- app_private.server_feature_flag_operations
DROP TRIGGER IF EXISTS a00_flag_operations_immutable ON app_private.server_feature_flag_operations;
CREATE TRIGGER a00_flag_operations_immutable BEFORE DELETE OR UPDATE ON app_private.server_feature_flag_operations FOR EACH ROW EXECUTE FUNCTION app_private.guard_rollout_ledger_immutable();

-- 5b. Cross-table: gan len bang nghiep vu NGOAI file -> guard to_regclass
-- public.income_expense_audit_log
DO $ps05$ BEGIN
  IF to_regclass('public.income_expense_audit_log') IS NOT NULL THEN
    DROP TRIGGER IF EXISTS a00_audit_append_only ON public.income_expense_audit_log;
    CREATE TRIGGER a00_audit_append_only BEFORE DELETE OR UPDATE ON public.income_expense_audit_log FOR EACH ROW EXECUTE FUNCTION app_private.guard_audit_log_append_only();
  ELSE
    RAISE NOTICE 'PS05: bo qua trigger a00_audit_append_only — bang public.income_expense_audit_log chua ton tai';
  END IF;
END $ps05$;

DO $ps05$ BEGIN
  IF to_regclass('public.income_expense_audit_log') IS NOT NULL THEN
    DROP TRIGGER IF EXISTS a00_audit_log_guard ON public.income_expense_audit_log;
    CREATE TRIGGER a00_audit_log_guard BEFORE INSERT OR DELETE OR UPDATE ON public.income_expense_audit_log FOR EACH ROW EXECUTE FUNCTION app_private.guard_audit_log_write();
  ELSE
    RAISE NOTICE 'PS05: bo qua trigger a00_audit_log_guard — bang public.income_expense_audit_log chua ton tai';
  END IF;
END $ps05$;

DO $ps05$ BEGIN
  IF to_regclass('public.income_expense_audit_log') IS NOT NULL THEN
    DROP TRIGGER IF EXISTS a00_audit_log_no_truncate ON public.income_expense_audit_log;
    CREATE TRIGGER a00_audit_log_no_truncate BEFORE TRUNCATE ON public.income_expense_audit_log FOR EACH STATEMENT EXECUTE FUNCTION app_private.guard_audit_log_truncate();
  ELSE
    RAISE NOTICE 'PS05: bo qua trigger a00_audit_log_no_truncate — bang public.income_expense_audit_log chua ton tai';
  END IF;
END $ps05$;

DO $ps05$ BEGIN
  IF to_regclass('public.income_expense_audit_log') IS NOT NULL THEN
    DROP TRIGGER IF EXISTS a00_audit_no_truncate ON public.income_expense_audit_log;
    CREATE TRIGGER a00_audit_no_truncate BEFORE TRUNCATE ON public.income_expense_audit_log FOR EACH STATEMENT EXECUTE FUNCTION app_private.guard_audit_log_append_only();
  ELSE
    RAISE NOTICE 'PS05: bo qua trigger a00_audit_no_truncate — bang public.income_expense_audit_log chua ton tai';
  END IF;
END $ps05$;

-- public.income_expenses
DO $ps05$ BEGIN
  IF to_regclass('public.income_expenses') IS NOT NULL THEN
    DROP TRIGGER IF EXISTS a70_salary_paid_accrual ON public.income_expenses;
    CREATE TRIGGER a70_salary_paid_accrual AFTER UPDATE ON public.income_expenses FOR EACH ROW WHEN ((new.salary_staff_id IS NOT NULL)) EXECUTE FUNCTION app_private.accrue_salary_paid_on_approve();
  ELSE
    RAISE NOTICE 'PS05: bo qua trigger a70_salary_paid_accrual — bang public.income_expenses chua ton tai';
  END IF;
END $ps05$;

-- public.invoice_audit_log
DO $ps05$ BEGIN
  IF to_regclass('public.invoice_audit_log') IS NOT NULL THEN
    DROP TRIGGER IF EXISTS a00_audit_append_only ON public.invoice_audit_log;
    CREATE TRIGGER a00_audit_append_only BEFORE DELETE OR UPDATE ON public.invoice_audit_log FOR EACH ROW EXECUTE FUNCTION app_private.guard_audit_log_append_only();
  ELSE
    RAISE NOTICE 'PS05: bo qua trigger a00_audit_append_only — bang public.invoice_audit_log chua ton tai';
  END IF;
END $ps05$;

DO $ps05$ BEGIN
  IF to_regclass('public.invoice_audit_log') IS NOT NULL THEN
    DROP TRIGGER IF EXISTS a00_audit_no_truncate ON public.invoice_audit_log;
    CREATE TRIGGER a00_audit_no_truncate BEFORE TRUNCATE ON public.invoice_audit_log FOR EACH STATEMENT EXECUTE FUNCTION app_private.guard_audit_log_append_only();
  ELSE
    RAISE NOTICE 'PS05: bo qua trigger a00_audit_no_truncate — bang public.invoice_audit_log chua ton tai';
  END IF;
END $ps05$;

-- public.organization_memberships
DO $ps05$ BEGIN
  IF to_regclass('public.organization_memberships') IS NOT NULL THEN
    DROP TRIGGER IF EXISTS a00_last_owner_guard ON public.organization_memberships;
    CREATE CONSTRAINT TRIGGER a00_last_owner_guard AFTER DELETE OR UPDATE ON public.organization_memberships DEFERRABLE INITIALLY IMMEDIATE FOR EACH ROW EXECUTE FUNCTION app_private.guard_last_owner();
  ELSE
    RAISE NOTICE 'PS05: bo qua trigger a00_last_owner_guard — bang public.organization_memberships chua ton tai';
  END IF;
END $ps05$;

-- public.staff_assignments
DO $ps05$ BEGIN
  IF to_regclass('public.staff_assignments') IS NOT NULL THEN
    DROP TRIGGER IF EXISTS a80_sa_revoke_sync ON public.staff_assignments;
    CREATE TRIGGER a80_sa_revoke_sync AFTER DELETE ON public.staff_assignments FOR EACH ROW EXECUTE FUNCTION app_private.sync_revoke_role_binding_v1();
  ELSE
    RAISE NOTICE 'PS05: bo qua trigger a80_sa_revoke_sync — bang public.staff_assignments chua ton tai';
  END IF;
END $ps05$;

DO $ps05$ BEGIN
  IF to_regclass('public.staff_assignments') IS NOT NULL THEN
    DROP TRIGGER IF EXISTS a81_sa_role_change_sync ON public.staff_assignments;
    CREATE TRIGGER a81_sa_role_change_sync AFTER UPDATE OF role_id, building_id, area_id, permissions ON public.staff_assignments FOR EACH ROW WHEN (((old.role_id IS DISTINCT FROM new.role_id) OR (old.building_id IS DISTINCT FROM new.building_id) OR (old.area_id IS DISTINCT FROM new.area_id) OR (old.permissions IS DISTINCT FROM new.permissions))) EXECUTE FUNCTION app_private.sync_revoke_role_binding_v1();
  ELSE
    RAISE NOTICE 'PS05: bo qua trigger a81_sa_role_change_sync — bang public.staff_assignments chua ton tai';
  END IF;
END $ps05$;


-- =====================================================================
-- MUC 6 — GRANT / REVOKE  (viet tuong minh tu pg_class.relacl / pg_proc.proacl)
-- =====================================================================

-- 6a. Bang
REVOKE ALL ON TABLE app_private.cashbook_possession_candidates FROM PUBLIC;

REVOKE ALL ON TABLE app_private.income_expense_audit_chain_heads FROM PUBLIC;

REVOKE ALL ON TABLE app_private.self_approve_limits FROM PUBLIC;

REVOKE ALL ON TABLE app_private.server_feature_flag_canary_orgs FROM PUBLIC;
GRANT INSERT, SELECT, UPDATE ON TABLE app_private.server_feature_flag_canary_orgs TO ie_canonical_writer;

REVOKE ALL ON TABLE app_private.server_feature_flag_events FROM PUBLIC;
GRANT INSERT, SELECT, UPDATE ON TABLE app_private.server_feature_flag_events TO ie_canonical_writer;

REVOKE ALL ON TABLE app_private.server_feature_flag_operations FROM PUBLIC;
GRANT INSERT, SELECT, UPDATE ON TABLE app_private.server_feature_flag_operations TO ie_canonical_writer;

REVOKE ALL ON TABLE app_private.server_feature_flags FROM PUBLIC;
GRANT INSERT, SELECT, UPDATE ON TABLE app_private.server_feature_flags TO ie_canonical_writer;

REVOKE ALL ON TABLE app_private.tenant_emergency_denies FROM PUBLIC;

-- 6b. Ham app_private
REVOKE ALL ON FUNCTION app_private.guard_audit_log_write() FROM PUBLIC;
REVOKE ALL ON FUNCTION app_private.guard_audit_log_append_only() FROM PUBLIC;
REVOKE ALL ON FUNCTION app_private.guard_audit_log_truncate() FROM PUBLIC;
REVOKE ALL ON FUNCTION app_private.guard_rollout_ledger_immutable() FROM PUBLIC;
REVOKE ALL ON FUNCTION app_private.guard_last_owner() FROM PUBLIC;
REVOKE ALL ON FUNCTION app_private.evaluate_feature_route(p_feature_key text, p_organization_id uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_private.evaluate_feature_route(p_feature_key text, p_organization_id uuid) TO ie_canonical_writer;
REVOKE ALL ON FUNCTION app_private.set_feature_route_v1(p_feature_key text, p_expected_config_version bigint, p_mode text, p_starts_at timestamp with time zone, p_ends_at timestamp with time zone, p_max_operation_count integer, p_max_single_amount_vnd numeric, p_max_total_amount_vnd numeric, p_commit_sha text, p_migration_sha256 text, p_maintenance_window_id text, p_approval_reference text, p_actor uuid, p_reason text) FROM PUBLIC;
REVOKE ALL ON FUNCTION app_private.authorize_income_expense_on_building(p_actor uuid, p_organization_id uuid, p_action text, p_building_id uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_private.authorize_income_expense_on_building(p_actor uuid, p_organization_id uuid, p_action text, p_building_id uuid) TO ie_canonical_writer;
REVOKE ALL ON FUNCTION app_private.is_actor_offboarded_v1() FROM PUBLIC;
REVOKE ALL ON FUNCTION app_private.sync_revoke_role_binding_v1() FROM PUBLIC;
REVOKE ALL ON FUNCTION app_private.grant_ie_claim_capability_v1() FROM PUBLIC;
REVOKE ALL ON FUNCTION app_private.ie_actor_display_name_v1(p_actor uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_private.ie_actor_display_name_v1(p_actor uuid) TO ie_canonical_writer;
-- app_private.accrue_salary_paid_on_approve: proacl NULL tren prod -> mac dinh PUBLIC EXECUTE (giu nguyen, khong REVOKE).
REVOKE ALL ON FUNCTION app_private.verify_income_expense_audit_chain_v1(p_organization_id uuid) FROM PUBLIC;

-- 6c. Ham public
GRANT EXECUTE ON FUNCTION public.nrm_vn(s text) TO anon;
GRANT EXECUTE ON FUNCTION public.nrm_vn(s text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.nrm_vn(s text) TO service_role;
-- (giu PUBLIC EXECUTE nhu prod: proacl co =X)
REVOKE ALL ON FUNCTION public._eval_approval_rule(p_org uuid, p_amount numeric, p_txn_type text, p_system_source text, p_category uuid, p_cashbook uuid, p_building uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public._eval_approval_rule(p_org uuid, p_amount numeric, p_txn_type text, p_system_source text, p_category uuid, p_cashbook uuid, p_building uuid) TO service_role;
REVOKE ALL ON FUNCTION public.submit_financial_voucher(p_voucher uuid, p_idempotency_key text, p_system_source text, p_txn_type text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.submit_financial_voucher(p_voucher uuid, p_idempotency_key text, p_system_source text, p_txn_type text) TO service_role;
REVOKE ALL ON FUNCTION public.approve_contract_termination_v1(p_termination_id uuid, p_note text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.approve_contract_termination_v1(p_termination_id uuid, p_note text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.approve_contract_termination_v1(p_termination_id uuid, p_note text) TO service_role;
REVOKE ALL ON FUNCTION public.approve_income_expense_v1(p_voucher_id uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.approve_income_expense_v1(p_voucher_id uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.approve_income_expense_v1(p_voucher_id uuid) TO service_role;
REVOKE ALL ON FUNCTION public.archive_cashbook_v1(p_cashbook_id uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.archive_cashbook_v1(p_cashbook_id uuid) TO authenticated;
REVOKE ALL ON FUNCTION public.attach_payment_receipt_v1(p_payment_id uuid, p_receipt_url text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.attach_payment_receipt_v1(p_payment_id uuid, p_receipt_url text) TO authenticated;
REVOKE ALL ON FUNCTION public.authorize_v2(p_permission_key text, p_org uuid, p_resource_type text, p_resource_id uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.authorize_v2(p_permission_key text, p_org uuid, p_resource_type text, p_resource_id uuid) TO service_role;
REVOKE ALL ON FUNCTION public.bulk_create_meter_readings_v1(p_readings jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.bulk_create_meter_readings_v1(p_readings jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.bulk_create_meter_readings_v1(p_readings jsonb) TO service_role;
REVOKE ALL ON FUNCTION public.bulk_delete_meter_readings_v1(p_ids uuid[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.bulk_delete_meter_readings_v1(p_ids uuid[]) TO authenticated;
GRANT EXECUTE ON FUNCTION public.bulk_delete_meter_readings_v1(p_ids uuid[]) TO service_role;
REVOKE ALL ON FUNCTION public.cancel_income_expense_v1(p_voucher_id uuid, p_reason text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.cancel_income_expense_v1(p_voucher_id uuid, p_reason text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.cancel_income_expense_v1(p_voucher_id uuid, p_reason text) TO service_role;
REVOKE ALL ON FUNCTION public.create_cashbook_v1(p_name text, p_initial_amount numeric, p_initial_date date, p_bank_name text, p_account_number text, p_quick_default_building_id uuid, p_idempotency_key text, p_description text, p_is_default boolean, p_owner_user_id uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.create_cashbook_v1(p_name text, p_initial_amount numeric, p_initial_date date, p_bank_name text, p_account_number text, p_quick_default_building_id uuid, p_idempotency_key text, p_description text, p_is_default boolean, p_owner_user_id uuid) TO authenticated;
REVOKE ALL ON FUNCTION public.create_contract_v1(p_room_id uuid, p_customer_ids uuid[], p_signed_date date, p_start_date date, p_end_date date, p_rent_price numeric, p_total_deposit numeric, p_services jsonb, p_first_invoice jsonb, p_idempotency_key text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.create_contract_v1(p_room_id uuid, p_customer_ids uuid[], p_signed_date date, p_start_date date, p_end_date date, p_rent_price numeric, p_total_deposit numeric, p_services jsonb, p_first_invoice jsonb, p_idempotency_key text) TO authenticated;
REVOKE ALL ON FUNCTION public.create_income_expense_v1(p_type text, p_name text, p_building_id uuid, p_room_id uuid, p_tenant_id uuid, p_contract_id uuid, p_payer_name text, p_receive_bank_account text, p_receive_bank_name text, p_account_id uuid, p_attachments jsonb, p_business_result_accounting boolean, p_notes text, p_voucher_date date, p_items jsonb, p_idempotency_key text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.create_income_expense_v1(p_type text, p_name text, p_building_id uuid, p_room_id uuid, p_tenant_id uuid, p_contract_id uuid, p_payer_name text, p_receive_bank_account text, p_receive_bank_name text, p_account_id uuid, p_attachments jsonb, p_business_result_accounting boolean, p_notes text, p_voucher_date date, p_items jsonb, p_idempotency_key text) TO authenticated;
REVOKE ALL ON FUNCTION public.create_meter_reading_v1(p_meter_id uuid, p_reading_date date, p_current_reading numeric, p_notes text, p_meter_image_url text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.create_meter_reading_v1(p_meter_id uuid, p_reading_date date, p_current_reading numeric, p_notes text, p_meter_image_url text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.create_meter_reading_v1(p_meter_id uuid, p_reading_date date, p_current_reading numeric, p_notes text, p_meter_image_url text) TO service_role;
REVOKE ALL ON FUNCTION public.create_reservation_deposit_v1(p_room_id uuid, p_amount numeric, p_idempotency_key text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.create_reservation_deposit_v1(p_room_id uuid, p_amount numeric, p_idempotency_key text) TO authenticated;
REVOKE ALL ON FUNCTION public.decide_financial_request_v2(p_request_id uuid, p_decision text, p_reason text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.decide_financial_request_v2(p_request_id uuid, p_decision text, p_reason text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.decide_financial_request_v2(p_request_id uuid, p_decision text, p_reason text) TO service_role;
REVOKE ALL ON FUNCTION public.delete_meter_reading_v1(p_id uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.delete_meter_reading_v1(p_id uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.delete_meter_reading_v1(p_id uuid) TO service_role;
REVOKE ALL ON FUNCTION public.distribute_shareholder_profit_v1(p_shareholder_id uuid, p_amount numeric, p_account_id uuid, p_voucher_date date, p_note text, p_idempotency_key text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.distribute_shareholder_profit_v1(p_shareholder_id uuid, p_amount numeric, p_account_id uuid, p_voucher_date date, p_note text, p_idempotency_key text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.distribute_shareholder_profit_v1(p_shareholder_id uuid, p_amount numeric, p_account_id uuid, p_voucher_date date, p_note text, p_idempotency_key text) TO service_role;
REVOKE ALL ON FUNCTION public.effective_perms_v2(p_user uuid, p_org uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.effective_perms_v2(p_user uuid, p_org uuid) TO service_role;
REVOKE ALL ON FUNCTION public.generate_invoice_number_v2() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.generate_invoice_number_v2() TO service_role;
GRANT EXECUTE ON FUNCTION public.generate_invoices_for_building_v2(p_building_id uuid, p_billing_month text, p_invoice_type text) TO anon;
GRANT EXECUTE ON FUNCTION public.generate_invoices_for_building_v2(p_building_id uuid, p_billing_month text, p_invoice_type text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.generate_invoices_for_building_v2(p_building_id uuid, p_billing_month text, p_invoice_type text) TO service_role;
-- (giu PUBLIC EXECUTE nhu prod: proacl co =X)
REVOKE ALL ON FUNCTION public.generate_recurring_vouchers_v2() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.generate_recurring_vouchers_v2() TO authenticated;
GRANT EXECUTE ON FUNCTION public.generate_recurring_vouchers_v2() TO service_role;
GRANT EXECUTE ON FUNCTION public.get_change_breakdown_v2(p_building_id uuid, p_room_id uuid, p_status invoice_status, p_start_date date, p_end_date date, p_billing_month text, p_payment_status text, p_building_ids uuid[]) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_change_breakdown_v2(p_building_id uuid, p_room_id uuid, p_status invoice_status, p_start_date date, p_end_date date, p_billing_month text, p_payment_status text, p_building_ids uuid[]) TO service_role;
-- (giu PUBLIC EXECUTE nhu prod: proacl co =X)
GRANT EXECUTE ON FUNCTION public.get_deposit_breakdown_v2(p_building_id uuid, p_room_id uuid, p_start_date date, p_end_date date, p_billing_month text, p_building_ids uuid[]) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_deposit_breakdown_v2(p_building_id uuid, p_room_id uuid, p_start_date date, p_end_date date, p_billing_month text, p_building_ids uuid[]) TO service_role;
-- (giu PUBLIC EXECUTE nhu prod: proacl co =X)
REVOKE ALL ON FUNCTION public.get_invoice_statistics_v2(p_building_id uuid, p_room_id uuid, p_status invoice_status, p_start_date date, p_end_date date, p_billing_month text, p_payment_status text, p_building_ids uuid[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_invoice_statistics_v2(p_building_id uuid, p_room_id uuid, p_status invoice_status, p_start_date date, p_end_date date, p_billing_month text, p_payment_status text, p_building_ids uuid[]) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_invoice_statistics_v2(p_building_id uuid, p_room_id uuid, p_status invoice_status, p_start_date date, p_end_date date, p_billing_month text, p_payment_status text, p_building_ids uuid[]) TO service_role;
GRANT EXECUTE ON FUNCTION public.get_meters_without_readings_v2(p_building_id uuid, p_room_id uuid, p_meter_type text, p_month text) TO anon;
GRANT EXECUTE ON FUNCTION public.get_meters_without_readings_v2(p_building_id uuid, p_room_id uuid, p_meter_type text, p_month text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_meters_without_readings_v2(p_building_id uuid, p_room_id uuid, p_meter_type text, p_month text) TO service_role;
-- (giu PUBLIC EXECUTE nhu prod: proacl co =X)
REVOKE ALL ON FUNCTION public.get_salary_progress_v5(p_month date) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_salary_progress_v5(p_month date) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_salary_progress_v5(p_month date) TO service_role;
REVOKE ALL ON FUNCTION public.list_my_pending_approvals_v1() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.list_my_pending_approvals_v1() TO authenticated;
GRANT EXECUTE ON FUNCTION public.list_my_pending_approvals_v1() TO service_role;
REVOKE ALL ON FUNCTION public.lock_cashbook_period_v1(p_cashbook_id uuid, p_lock_date date, p_unlock boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.lock_cashbook_period_v1(p_cashbook_id uuid, p_lock_date date, p_unlock boolean) TO authenticated;
REVOKE ALL ON FUNCTION public.lock_profit_month_v1(p_period_month text, p_rows jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.lock_profit_month_v1(p_period_month text, p_rows jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.lock_profit_month_v1(p_period_month text, p_rows jsonb) TO service_role;
REVOKE ALL ON FUNCTION public.lock_salary_month_v1(p_period_month date, p_managers jsonb, p_idempotency_key text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.lock_salary_month_v1(p_period_month date, p_managers jsonb, p_idempotency_key text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.lock_salary_month_v1(p_period_month date, p_managers jsonb, p_idempotency_key text) TO service_role;
REVOKE ALL ON FUNCTION public.manager_salary_payout_v1(p_manager_id uuid, p_amount numeric, p_account_id uuid, p_voucher_date date, p_note text, p_idempotency_key text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.manager_salary_payout_v1(p_manager_id uuid, p_amount numeric, p_account_id uuid, p_voucher_date date, p_note text, p_idempotency_key text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.manager_salary_payout_v1(p_manager_id uuid, p_amount numeric, p_account_id uuid, p_voucher_date date, p_note text, p_idempotency_key text) TO service_role;
REVOKE ALL ON FUNCTION public.occupancy_snapshot_v2(p_as_of_date date, p_building_ids uuid[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.occupancy_snapshot_v2(p_as_of_date date, p_building_ids uuid[]) TO authenticated;
GRANT EXECUTE ON FUNCTION public.occupancy_snapshot_v2(p_as_of_date date, p_building_ids uuid[]) TO service_role;
REVOKE ALL ON FUNCTION public.occupancy_upcoming_vacancy_v2(p_as_of_date date, p_window_days integer, p_building_ids uuid[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.occupancy_upcoming_vacancy_v2(p_as_of_date date, p_window_days integer, p_building_ids uuid[]) TO authenticated;
GRANT EXECUTE ON FUNCTION public.occupancy_upcoming_vacancy_v2(p_as_of_date date, p_window_days integer, p_building_ids uuid[]) TO service_role;
REVOKE ALL ON FUNCTION public.record_invoice_payment_v2(p_invoice_id uuid, p_amount numeric, p_payment_method payment_method, p_payment_date date, p_notes text, p_receipt_image_url text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.record_invoice_payment_v2(p_invoice_id uuid, p_amount numeric, p_payment_method payment_method, p_payment_date date, p_notes text, p_receipt_image_url text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.record_invoice_payment_v2(p_invoice_id uuid, p_amount numeric, p_payment_method payment_method, p_payment_date date, p_notes text, p_receipt_image_url text) TO service_role;
REVOKE ALL ON FUNCTION public.record_invoice_payment_v3(p_invoice_id uuid, p_amount numeric, p_payment_method payment_method, p_payment_date date, p_idempotency_key text, p_account_id uuid, p_notes text, p_receipt_image_url text, p_voucher jsonb, p_items jsonb, p_receipt_number text, p_voucher_owner_id uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.record_invoice_payment_v3(p_invoice_id uuid, p_amount numeric, p_payment_method payment_method, p_payment_date date, p_idempotency_key text, p_account_id uuid, p_notes text, p_receipt_image_url text, p_voucher jsonb, p_items jsonb, p_receipt_number text, p_voucher_owner_id uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.record_invoice_payment_v3(p_invoice_id uuid, p_amount numeric, p_payment_method payment_method, p_payment_date date, p_idempotency_key text, p_account_id uuid, p_notes text, p_receipt_image_url text, p_voucher jsonb, p_items jsonb, p_receipt_number text, p_voucher_owner_id uuid) TO service_role;
REVOKE ALL ON FUNCTION public.reject_contract_termination_v1(p_termination_id uuid, p_reason text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.reject_contract_termination_v1(p_termination_id uuid, p_reason text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.reject_contract_termination_v1(p_termination_id uuid, p_reason text) TO service_role;
REVOKE ALL ON FUNCTION public.request_opening_balance_adjustment_v1(p_cashbook_id uuid, p_delta numeric, p_reason text, p_idempotency_key text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.request_opening_balance_adjustment_v1(p_cashbook_id uuid, p_delta numeric, p_reason text, p_idempotency_key text) TO authenticated;
REVOKE ALL ON FUNCTION public.salary_payout_v1(p_staff_id uuid, p_period_month date, p_take_home numeric, p_account_id uuid, p_voucher_date date, p_note text, p_idempotency_key text, p_rent_invoice_id uuid, p_rent_amount numeric) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.salary_payout_v1(p_staff_id uuid, p_period_month date, p_take_home numeric, p_account_id uuid, p_voucher_date date, p_note text, p_idempotency_key text, p_rent_invoice_id uuid, p_rent_amount numeric) TO authenticated;
GRANT EXECUTE ON FUNCTION public.salary_payout_v1(p_staff_id uuid, p_period_month date, p_take_home numeric, p_account_id uuid, p_voucher_date date, p_note text, p_idempotency_key text, p_rent_invoice_id uuid, p_rent_amount numeric) TO service_role;
REVOKE ALL ON FUNCTION public.set_cashbook_shared_users_v1(p_cashbook_id uuid, p_user_ids uuid[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.set_cashbook_shared_users_v1(p_cashbook_id uuid, p_user_ids uuid[]) TO authenticated;
REVOKE ALL ON FUNCTION public.set_membership_status_v1(p_user_id uuid, p_status text, p_reason text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.set_membership_status_v1(p_user_id uuid, p_status text, p_reason text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.set_membership_status_v1(p_user_id uuid, p_status text, p_reason text) TO service_role;
REVOKE ALL ON FUNCTION public.unlock_profit_month_v1(p_period_month text, p_building_ids uuid[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.unlock_profit_month_v1(p_period_month text, p_building_ids uuid[]) TO authenticated;
GRANT EXECUTE ON FUNCTION public.unlock_profit_month_v1(p_period_month text, p_building_ids uuid[]) TO service_role;
REVOKE ALL ON FUNCTION public.unlock_salary_month_v1(p_period_month date, p_staff_ids uuid[], p_idempotency_key text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.unlock_salary_month_v1(p_period_month date, p_staff_ids uuid[], p_idempotency_key text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.unlock_salary_month_v1(p_period_month date, p_staff_ids uuid[], p_idempotency_key text) TO service_role;
REVOKE ALL ON FUNCTION public.update_cashbook_metadata_v1(p_cashbook_id uuid, p_name text, p_description text, p_initial_amount numeric, p_initial_date date, p_quick_default_building_id uuid, p_is_default boolean, p_owner_user_id uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.update_cashbook_metadata_v1(p_cashbook_id uuid, p_name text, p_description text, p_initial_amount numeric, p_initial_date date, p_quick_default_building_id uuid, p_is_default boolean, p_owner_user_id uuid) TO authenticated;
REVOKE ALL ON FUNCTION public.update_meter_reading_v1(p_id uuid, p_current_reading numeric, p_reading_date date, p_notes text, p_meter_image_url text, p_expected_updated_at timestamp with time zone) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.update_meter_reading_v1(p_id uuid, p_current_reading numeric, p_reading_date date, p_notes text, p_meter_image_url text, p_expected_updated_at timestamp with time zone) TO authenticated;
GRANT EXECUTE ON FUNCTION public.update_meter_reading_v1(p_id uuid, p_current_reading numeric, p_reading_date date, p_notes text, p_meter_image_url text, p_expected_updated_at timestamp with time zone) TO service_role;
REVOKE ALL ON FUNCTION public.verify_income_expense_v1(p_id uuid, p_note text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.verify_income_expense_v1(p_id uuid, p_note text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.verify_income_expense_v1(p_id uuid, p_note text) TO service_role;
REVOKE ALL ON FUNCTION public.withdraw_financial_request_v1(p_request_id uuid, p_reason text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.withdraw_financial_request_v1(p_request_id uuid, p_reason text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.withdraw_financial_request_v1(p_request_id uuid, p_reason text) TO service_role;


COMMIT;

-- =====================================================================
-- HET FILE — 8 bang / 28 constraint / 2 index / 62 ham / 13 trigger.
-- =====================================================================
