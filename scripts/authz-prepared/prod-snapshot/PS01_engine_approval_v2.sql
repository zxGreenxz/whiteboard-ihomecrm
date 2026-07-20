-- =====================================================================
-- PS01 -- SNAPSHOT DINH NGHIA THAT DANG CHAY TREN PROD (engine duyet v2)
-- Sinh TU DONG tu prod ngay 2026-07-19 (PostgreSQL 17.6, project
-- tryymsxyyckgbrmmvozx) bang truy van catalog -- KHONG SUA TAY.
-- Muc dich: khoi phuc tham hoa / dung lai moi truong. Day KHONG phai
-- migration: sua schema thi viet migration moi duoi supabase/migrations/
-- roi sinh lai file nay tu prod.
--
-- Vi sao co file: toan bo may duyet (approval engine) hien chi song trong
-- DB -- nhieu ham/bang KHONG co file nguon nao tren main, DR se mat trang.
--
-- ---------------------------------------------------------------------
-- DOI TUONG TRONG FILE (tong 112 khoi DDL)
-- ---------------------------------------------------------------------
-- [1] BANG (10)           -- 8 public.approval_* + 2 app_private (108 cot)
--     public.approval_rule_sets, approval_rules, approval_rule_steps,
--     approval_step_approvers, approval_requests, approval_request_steps,
--     approval_request_step_candidates, approval_decisions
--     app_private.emergency_override_events
--     app_private.ie_transition_authorization
-- [2] CONSTRAINT (57)     -- PK/UNIQUE -> CHECK -> FOREIGN KEY
-- [3] INDEX (3)           -- chi index DOC LAP; index cua PK/UNIQUE do
--                          ADD CONSTRAINT tao nen khong lap lai
-- [4] RLS (8)             -- ENABLE ROW LEVEL SECURITY
-- [5] HAM app_private (22) -- pg_get_functiondef nguyen van
-- [6] TRIGGER (4)
-- [7] POLICY (8)
-- [8] GRANT/REVOKE        -- dung lai tu relacl / proacl / nspacl thuc te
--
-- ---------------------------------------------------------------------
-- PHU THUOC NGOAI (KHONG nam trong file nay -- phai co TRUOC khi chay)
-- ---------------------------------------------------------------------
-- (danh sach duoi day do quet tu chinh than 22 ham + qual cua policy,
--  khong phai phong doan)
--
-- CHAN NGAY neu thieu -- la dich cua FOREIGN KEY o muc [2]:
--        public.organizations, public.organization_memberships
--
-- CHAN TRIGGER a75 neu thieu (muc [6] tu bo qua + raise notice):
--        public.income_expenses
--
-- Doc luc CHAY (thieu thi DDL van vao, nhung ham loi khi goi):
--        accounts, area_buildings, authorization_scopes, buildings,
--        cashbook_possession_bindings, income_expense_items,
--        income_expense_types, member_override_scopes,
--        member_permission_overrides, organization_roles,
--        permission_definitions, role_binding_scopes, role_bindings,
--        role_permissions
--        (phan lon do app_private.authorize_tenant_action_v3 -- resolver RBAC)
--
-- Ham public.* (chi 3, da doi chieu):
--        public.nrm_vn(text)        -- submit_ / self_approve_within_limit_
--        public.is_super_admin()    -- qual cua ca 8 POLICY o muc [7]
--        public.my_org_ids()        -- qual cua ca 8 POLICY o muc [7]
--
-- Role:  authenticated, service_role, anon, ie_canonical_writer
--
-- CANH BAO DR (tinh trang 2026-07-19): ba RPC wrapper public.* cua t5_26
-- (list_my_pending_approvals_v1, decide_financial_request_v2,
-- withdraw_financial_request_v1) va public._eval_approval_rule /
-- public.nrm_vn HIEN CHUA CO trong bat ky file PS0*.sql nao. Chung la be
-- mat public nen nam ngoai pham vi PS01, NHUNG khoi phuc chi bang PS01 se
-- dung duoc engine ma KHONG co man "Cho duyet". Can mot PS rieng cho lop
-- RPC public truoc khi coi bo snapshot la du cho DR.
--
-- ---------------------------------------------------------------------
-- CACH CHAY LAI
-- ---------------------------------------------------------------------
--   psql "$PROD" -v ON_ERROR_STOP=1 -f PS01_engine_approval_v2.sql
-- Chay bang role so huu schema (postgres). File idempotent -- chay nhieu
-- lan khong loi (IF NOT EXISTS / CREATE OR REPLACE / DROP ... IF EXISTS).
--
-- HAN CHE DA BIET (khong bia -- ghi dung nhung gi snapshot KHONG lam duoc):
--  - CREATE TABLE IF NOT EXISTS: neu bang da ton tai nhung THIEU cot thi
--    file nay KHONG them cot. Chi dung khi dung tu DB trang hoac schema khop.
--  - Khong dump DU LIEU (rule set / rule / step / approver cua tung org).
--    Cau hinh rule la du lieu -- phuc hoi tu backup logic, khong tu file nay.
--  - Khong dump OWNER (moi doi tuong tren prod owner = postgres; chay file
--    bang postgres la khop).
--  - app_private.ie_cancel_close_request_v1 co proacl = NULL tren prod
--    (mac dinh PUBLIC EXECUTE, chua tung REVOKE). Giu NGUYEN trang thai do,
--    file KHONG phat REVOKE -- xem ghi chu o muc [8].
--  - THAN HAM CHUA CRLF: 20/22 ham co ky tu CR that su trong pg_proc.prosrc
--    (migration goc viet tren Windows). File giu NGUYEN byte de re-dump ve
--    sau diff sach. DUNG normalize line-ending cua file nay.
--
-- ---------------------------------------------------------------------
-- TU KIEM (chay luc sinh file, 2026-07-19)
-- ---------------------------------------------------------------------
--  - So doi tuong liet ke tu catalog == so khoi DDL trong file:
--    bang 10 / constraint 57 / index 3 / rls 8 / ham 22 / trigger 4 / policy 8
--  - 22/22 than ham khop NGUYEN VAN voi pg_get_functiondef tren prod
--    (so sanh chuoi, khong dich line-ending).
--  - Tach statement ton trong dollar-quote: 199 statement, khong con du,
--    dollar-quote can bang, begin/commit dung 1 lan.
--  - Quet secret: khong co token/password/PAT/uuid-org nao trong file.
-- =====================================================================

begin;

create schema if not exists app_private;


-- =====================================================================
-- [1] BANG (10) -- cot + default + not null
-- =====================================================================

create table if not exists public.approval_rule_sets (
  id uuid default gen_random_uuid() not null,
  organization_id uuid not null,
  transaction_domain text not null,
  version integer not null,
  status text default 'ACTIVE'::text not null,
  effective_from timestamp with time zone default now() not null,
  effective_to timestamp with time zone,
  published_by uuid,
  published_at timestamp with time zone default now()
);

create table if not exists public.approval_rules (
  id uuid default gen_random_uuid() not null,
  organization_id uuid not null,
  rule_set_id uuid not null,
  name text not null,
  priority integer not null,
  effect text not null,
  transaction_type text,
  category_id uuid,
  cashbook_id uuid,
  building_id uuid,
  area_id uuid,
  system_source text,
  amount_min numeric(18,2),
  amount_max numeric(18,2),
  is_fallback boolean default false not null,
  force_match boolean default false not null,
  active boolean default true not null
);

create table if not exists public.approval_rule_steps (
  id uuid default gen_random_uuid() not null,
  organization_id uuid not null,
  rule_id uuid not null,
  step_no integer not null,
  min_approvals integer default 1 not null,
  mode text default 'ANY'::text not null
);

create table if not exists public.approval_step_approvers (
  id uuid default gen_random_uuid() not null,
  organization_id uuid not null,
  step_id uuid not null,
  approver_type text not null,
  membership_id uuid,
  role_id uuid,
  permission_key text,
  scope_id uuid
);

create table if not exists public.approval_requests (
  id uuid default gen_random_uuid() not null,
  organization_id uuid not null,
  submission_no integer default 1 not null,
  subject_type text not null,
  subject_id uuid not null,
  state text not null,
  maker_membership_id uuid not null,
  maker_user_id uuid not null,
  rule_set_id uuid not null,
  rule_set_version integer not null,
  matched_rule_id uuid not null,
  rule_effect text not null,
  payload_snapshot jsonb not null,
  payload_hash text not null,
  amount numeric(18,2) not null,
  category_id uuid,
  cashbook_id uuid,
  building_id uuid,
  system_source text,
  submitted_at timestamp with time zone default now(),
  posted_at timestamp with time zone,
  posted_event_id uuid,
  version bigint default 1 not null,
  reverses_request_id uuid,
  reversed_by_request_id uuid
);

create table if not exists public.approval_request_steps (
  id uuid default gen_random_uuid() not null,
  organization_id uuid not null,
  request_id uuid not null,
  step_no integer not null,
  status text not null,
  mode text not null,
  min_approvals integer not null,
  current_generation integer default 1 not null,
  rule_step_snapshot jsonb default '{}'::jsonb not null,
  candidate_count integer default 0 not null
);

create table if not exists public.approval_request_step_candidates (
  id uuid default gen_random_uuid() not null,
  organization_id uuid not null,
  request_step_id uuid not null,
  membership_id uuid not null,
  generation integer not null,
  source_kind text not null,
  source_id uuid,
  eligible_at_submit boolean default true not null,
  valid_from timestamp with time zone default now() not null,
  valid_to timestamp with time zone
);

create table if not exists public.approval_decisions (
  id uuid default gen_random_uuid() not null,
  organization_id uuid not null,
  request_id uuid not null,
  request_step_id uuid not null,
  candidate_id uuid,
  candidate_generation integer,
  actor_membership_id uuid not null,
  actor_user_id uuid not null,
  decision text not null,
  reason text,
  decided_at timestamp with time zone default now() not null,
  request_version bigint not null
);

create table if not exists app_private.emergency_override_events (
  id uuid default gen_random_uuid() not null,
  organization_id uuid not null,
  request_id uuid not null,
  actor_membership_id uuid not null,
  actor_user_id uuid not null,
  reason text not null,
  created_at timestamp with time zone default clock_timestamp() not null
);

create table if not exists app_private.ie_transition_authorization (
  income_expense_id uuid not null,
  xid xid8 not null,
  purpose text not null,
  granted_at timestamp with time zone default clock_timestamp() not null
);


-- =====================================================================
-- [2] CONSTRAINT (57) -- PK/UNIQUE -> CHECK -> FOREIGN KEY
--     ADD CONSTRAINT khong co IF NOT EXISTS -> boc DO block idempotent
-- =====================================================================

do $do$ begin
  if not exists (select 1 from pg_constraint
                  where conname = 'approval_rule_sets_pkey'
                    and conrelid = 'public.approval_rule_sets'::regclass) then
    alter table public.approval_rule_sets add constraint approval_rule_sets_pkey
      PRIMARY KEY (id);
  end if;
end $do$;

do $do$ begin
  if not exists (select 1 from pg_constraint
                  where conname = 'approval_rules_pkey'
                    and conrelid = 'public.approval_rules'::regclass) then
    alter table public.approval_rules add constraint approval_rules_pkey
      PRIMARY KEY (id);
  end if;
end $do$;

do $do$ begin
  if not exists (select 1 from pg_constraint
                  where conname = 'approval_rule_steps_pkey'
                    and conrelid = 'public.approval_rule_steps'::regclass) then
    alter table public.approval_rule_steps add constraint approval_rule_steps_pkey
      PRIMARY KEY (id);
  end if;
end $do$;

do $do$ begin
  if not exists (select 1 from pg_constraint
                  where conname = 'approval_step_approvers_pkey'
                    and conrelid = 'public.approval_step_approvers'::regclass) then
    alter table public.approval_step_approvers add constraint approval_step_approvers_pkey
      PRIMARY KEY (id);
  end if;
end $do$;

do $do$ begin
  if not exists (select 1 from pg_constraint
                  where conname = 'approval_requests_pkey'
                    and conrelid = 'public.approval_requests'::regclass) then
    alter table public.approval_requests add constraint approval_requests_pkey
      PRIMARY KEY (id);
  end if;
end $do$;

do $do$ begin
  if not exists (select 1 from pg_constraint
                  where conname = 'approval_request_steps_pkey'
                    and conrelid = 'public.approval_request_steps'::regclass) then
    alter table public.approval_request_steps add constraint approval_request_steps_pkey
      PRIMARY KEY (id);
  end if;
end $do$;

do $do$ begin
  if not exists (select 1 from pg_constraint
                  where conname = 'approval_request_step_candidates_pkey'
                    and conrelid = 'public.approval_request_step_candidates'::regclass) then
    alter table public.approval_request_step_candidates add constraint approval_request_step_candidates_pkey
      PRIMARY KEY (id);
  end if;
end $do$;

do $do$ begin
  if not exists (select 1 from pg_constraint
                  where conname = 'approval_decisions_pkey'
                    and conrelid = 'public.approval_decisions'::regclass) then
    alter table public.approval_decisions add constraint approval_decisions_pkey
      PRIMARY KEY (id);
  end if;
end $do$;

do $do$ begin
  if not exists (select 1 from pg_constraint
                  where conname = 'emergency_override_events_pkey'
                    and conrelid = 'app_private.emergency_override_events'::regclass) then
    alter table app_private.emergency_override_events add constraint emergency_override_events_pkey
      PRIMARY KEY (id);
  end if;
end $do$;

do $do$ begin
  if not exists (select 1 from pg_constraint
                  where conname = 'ie_transition_authorization_pkey'
                    and conrelid = 'app_private.ie_transition_authorization'::regclass) then
    alter table app_private.ie_transition_authorization add constraint ie_transition_authorization_pkey
      PRIMARY KEY (income_expense_id);
  end if;
end $do$;

do $do$ begin
  if not exists (select 1 from pg_constraint
                  where conname = 'approval_rule_sets_organization_id_id_key'
                    and conrelid = 'public.approval_rule_sets'::regclass) then
    alter table public.approval_rule_sets add constraint approval_rule_sets_organization_id_id_key
      UNIQUE (organization_id, id);
  end if;
end $do$;

do $do$ begin
  if not exists (select 1 from pg_constraint
                  where conname = 'approval_rule_sets_organization_id_transaction_domain_versi_key'
                    and conrelid = 'public.approval_rule_sets'::regclass) then
    alter table public.approval_rule_sets add constraint approval_rule_sets_organization_id_transaction_domain_versi_key
      UNIQUE (organization_id, transaction_domain, version);
  end if;
end $do$;

do $do$ begin
  if not exists (select 1 from pg_constraint
                  where conname = 'approval_rules_organization_id_id_key'
                    and conrelid = 'public.approval_rules'::regclass) then
    alter table public.approval_rules add constraint approval_rules_organization_id_id_key
      UNIQUE (organization_id, id);
  end if;
end $do$;

do $do$ begin
  if not exists (select 1 from pg_constraint
                  where conname = 'approval_rules_rule_set_id_priority_key'
                    and conrelid = 'public.approval_rules'::regclass) then
    alter table public.approval_rules add constraint approval_rules_rule_set_id_priority_key
      UNIQUE (rule_set_id, priority);
  end if;
end $do$;

do $do$ begin
  if not exists (select 1 from pg_constraint
                  where conname = 'approval_rule_steps_organization_id_id_key'
                    and conrelid = 'public.approval_rule_steps'::regclass) then
    alter table public.approval_rule_steps add constraint approval_rule_steps_organization_id_id_key
      UNIQUE (organization_id, id);
  end if;
end $do$;

do $do$ begin
  if not exists (select 1 from pg_constraint
                  where conname = 'approval_rule_steps_rule_id_step_no_key'
                    and conrelid = 'public.approval_rule_steps'::regclass) then
    alter table public.approval_rule_steps add constraint approval_rule_steps_rule_id_step_no_key
      UNIQUE (rule_id, step_no);
  end if;
end $do$;

do $do$ begin
  if not exists (select 1 from pg_constraint
                  where conname = 'approval_requests_organization_id_id_key'
                    and conrelid = 'public.approval_requests'::regclass) then
    alter table public.approval_requests add constraint approval_requests_organization_id_id_key
      UNIQUE (organization_id, id);
  end if;
end $do$;

do $do$ begin
  if not exists (select 1 from pg_constraint
                  where conname = 'approval_requests_organization_id_subject_type_subject_id_s_key'
                    and conrelid = 'public.approval_requests'::regclass) then
    alter table public.approval_requests add constraint approval_requests_organization_id_subject_type_subject_id_s_key
      UNIQUE (organization_id, subject_type, subject_id, submission_no);
  end if;
end $do$;

do $do$ begin
  if not exists (select 1 from pg_constraint
                  where conname = 'approval_requests_posted_event_id_key'
                    and conrelid = 'public.approval_requests'::regclass) then
    alter table public.approval_requests add constraint approval_requests_posted_event_id_key
      UNIQUE (posted_event_id);
  end if;
end $do$;

do $do$ begin
  if not exists (select 1 from pg_constraint
                  where conname = 'approval_request_steps_organization_id_id_key'
                    and conrelid = 'public.approval_request_steps'::regclass) then
    alter table public.approval_request_steps add constraint approval_request_steps_organization_id_id_key
      UNIQUE (organization_id, id);
  end if;
end $do$;

do $do$ begin
  if not exists (select 1 from pg_constraint
                  where conname = 'approval_request_steps_organization_id_request_id_id_key'
                    and conrelid = 'public.approval_request_steps'::regclass) then
    alter table public.approval_request_steps add constraint approval_request_steps_organization_id_request_id_id_key
      UNIQUE (organization_id, request_id, id);
  end if;
end $do$;

do $do$ begin
  if not exists (select 1 from pg_constraint
                  where conname = 'approval_request_steps_request_id_step_no_key'
                    and conrelid = 'public.approval_request_steps'::regclass) then
    alter table public.approval_request_steps add constraint approval_request_steps_request_id_step_no_key
      UNIQUE (request_id, step_no);
  end if;
end $do$;

do $do$ begin
  if not exists (select 1 from pg_constraint
                  where conname = 'approval_request_step_candida_organization_id_request_step__key'
                    and conrelid = 'public.approval_request_step_candidates'::regclass) then
    alter table public.approval_request_step_candidates add constraint approval_request_step_candida_organization_id_request_step__key
      UNIQUE (organization_id, request_step_id, membership_id, generation);
  end if;
end $do$;

do $do$ begin
  if not exists (select 1 from pg_constraint
                  where conname = 'approval_request_step_candidates_organization_id_id_key'
                    and conrelid = 'public.approval_request_step_candidates'::regclass) then
    alter table public.approval_request_step_candidates add constraint approval_request_step_candidates_organization_id_id_key
      UNIQUE (organization_id, id);
  end if;
end $do$;

do $do$ begin
  if not exists (select 1 from pg_constraint
                  where conname = 'approval_rule_sets_check'
                    and conrelid = 'public.approval_rule_sets'::regclass) then
    alter table public.approval_rule_sets add constraint approval_rule_sets_check
      CHECK (((effective_to IS NULL) OR (effective_to > effective_from)));
  end if;
end $do$;

do $do$ begin
  if not exists (select 1 from pg_constraint
                  where conname = 'approval_rule_sets_status_check'
                    and conrelid = 'public.approval_rule_sets'::regclass) then
    alter table public.approval_rule_sets add constraint approval_rule_sets_status_check
      CHECK ((status = ANY (ARRAY['DRAFT'::text, 'ACTIVE'::text, 'RETIRED'::text])));
  end if;
end $do$;

do $do$ begin
  if not exists (select 1 from pg_constraint
                  where conname = 'approval_rules_amount_max_check'
                    and conrelid = 'public.approval_rules'::regclass) then
    alter table public.approval_rules add constraint approval_rules_amount_max_check
      CHECK (((amount_max IS NULL) OR (amount_max >= (0)::numeric)));
  end if;
end $do$;

do $do$ begin
  if not exists (select 1 from pg_constraint
                  where conname = 'approval_rules_amount_min_check'
                    and conrelid = 'public.approval_rules'::regclass) then
    alter table public.approval_rules add constraint approval_rules_amount_min_check
      CHECK (((amount_min IS NULL) OR (amount_min >= (0)::numeric)));
  end if;
end $do$;

do $do$ begin
  if not exists (select 1 from pg_constraint
                  where conname = 'approval_rules_check'
                    and conrelid = 'public.approval_rules'::regclass) then
    alter table public.approval_rules add constraint approval_rules_check
      CHECK (((amount_max IS NULL) OR (amount_min IS NULL) OR (amount_max >= amount_min)));
  end if;
end $do$;

do $do$ begin
  if not exists (select 1 from pg_constraint
                  where conname = 'approval_rules_check1'
                    and conrelid = 'public.approval_rules'::regclass) then
    alter table public.approval_rules add constraint approval_rules_check1
      CHECK ((is_fallback OR (transaction_type IS NOT NULL) OR force_match OR (system_source IS NOT NULL) OR (category_id IS NOT NULL)));
  end if;
end $do$;

do $do$ begin
  if not exists (select 1 from pg_constraint
                  where conname = 'approval_rules_check2'
                    and conrelid = 'public.approval_rules'::regclass) then
    alter table public.approval_rules add constraint approval_rules_check2
      CHECK (((NOT is_fallback) OR ((effect = 'REQUIRE_APPROVAL'::text) AND (transaction_type IS NULL) AND (category_id IS NULL) AND (cashbook_id IS NULL) AND (building_id IS NULL) AND (area_id IS NULL) AND (system_source IS NULL) AND (amount_min IS NULL) AND (amount_max IS NULL) AND (NOT force_match))));
  end if;
end $do$;

do $do$ begin
  if not exists (select 1 from pg_constraint
                  where conname = 'approval_rules_effect_check'
                    and conrelid = 'public.approval_rules'::regclass) then
    alter table public.approval_rules add constraint approval_rules_effect_check
      CHECK ((effect = ANY (ARRAY['AUTO_POST'::text, 'REQUIRE_APPROVAL'::text, 'DENY'::text])));
  end if;
end $do$;

do $do$ begin
  if not exists (select 1 from pg_constraint
                  where conname = 'approval_rule_steps_check'
                    and conrelid = 'public.approval_rule_steps'::regclass) then
    alter table public.approval_rule_steps add constraint approval_rule_steps_check
      CHECK (((step_no > 0) AND (min_approvals > 0)));
  end if;
end $do$;

do $do$ begin
  if not exists (select 1 from pg_constraint
                  where conname = 'approval_rule_steps_mode_check'
                    and conrelid = 'public.approval_rule_steps'::regclass) then
    alter table public.approval_rule_steps add constraint approval_rule_steps_mode_check
      CHECK ((mode = ANY (ARRAY['ANY'::text, 'ALL'::text, 'QUORUM'::text])));
  end if;
end $do$;

do $do$ begin
  if not exists (select 1 from pg_constraint
                  where conname = 'approval_step_approvers_approver_type_check'
                    and conrelid = 'public.approval_step_approvers'::regclass) then
    alter table public.approval_step_approvers add constraint approval_step_approvers_approver_type_check
      CHECK ((approver_type = ANY (ARRAY['MEMBER'::text, 'ROLE'::text, 'PERMISSION'::text, 'CASHBOOK_APPROVER'::text, 'AREA_APPROVER'::text, 'BUILDING_APPROVER'::text])));
  end if;
end $do$;

do $do$ begin
  if not exists (select 1 from pg_constraint
                  where conname = 'approval_requests_rule_effect_check'
                    and conrelid = 'public.approval_requests'::regclass) then
    alter table public.approval_requests add constraint approval_requests_rule_effect_check
      CHECK ((rule_effect = ANY (ARRAY['AUTO_POST'::text, 'REQUIRE_APPROVAL'::text, 'DENY'::text, 'REVERSAL'::text])));
  end if;
end $do$;

do $do$ begin
  if not exists (select 1 from pg_constraint
                  where conname = 'approval_requests_state_check'
                    and conrelid = 'public.approval_requests'::regclass) then
    alter table public.approval_requests add constraint approval_requests_state_check
      CHECK ((state = ANY (ARRAY['PENDING_APPROVAL'::text, 'POSTED'::text, 'DENIED'::text, 'REJECTED'::text, 'CANCELLED'::text, 'REVERSED'::text])));
  end if;
end $do$;

do $do$ begin
  if not exists (select 1 from pg_constraint
                  where conname = 'approval_request_steps_check'
                    and conrelid = 'public.approval_request_steps'::regclass) then
    alter table public.approval_request_steps add constraint approval_request_steps_check
      CHECK (((step_no > 0) AND (min_approvals > 0) AND (current_generation > 0)));
  end if;
end $do$;

do $do$ begin
  if not exists (select 1 from pg_constraint
                  where conname = 'approval_request_steps_mode_check'
                    and conrelid = 'public.approval_request_steps'::regclass) then
    alter table public.approval_request_steps add constraint approval_request_steps_mode_check
      CHECK ((mode = ANY (ARRAY['ANY'::text, 'ALL'::text, 'QUORUM'::text])));
  end if;
end $do$;

do $do$ begin
  if not exists (select 1 from pg_constraint
                  where conname = 'approval_request_steps_status_check'
                    and conrelid = 'public.approval_request_steps'::regclass) then
    alter table public.approval_request_steps add constraint approval_request_steps_status_check
      CHECK ((status = ANY (ARRAY['WAITING'::text, 'PENDING'::text, 'APPROVED'::text, 'REJECTED'::text, 'CANCELLED'::text, 'BYPASSED'::text])));
  end if;
end $do$;

do $do$ begin
  if not exists (select 1 from pg_constraint
                  where conname = 'approval_request_step_candidates_check'
                    and conrelid = 'public.approval_request_step_candidates'::regclass) then
    alter table public.approval_request_step_candidates add constraint approval_request_step_candidates_check
      CHECK (((valid_to IS NULL) OR (valid_to > valid_from)));
  end if;
end $do$;

do $do$ begin
  if not exists (select 1 from pg_constraint
                  where conname = 'approval_request_step_candidates_generation_check'
                    and conrelid = 'public.approval_request_step_candidates'::regclass) then
    alter table public.approval_request_step_candidates add constraint approval_request_step_candidates_generation_check
      CHECK ((generation > 0));
  end if;
end $do$;

do $do$ begin
  if not exists (select 1 from pg_constraint
                  where conname = 'approval_decisions_check1'
                    and conrelid = 'public.approval_decisions'::regclass) then
    alter table public.approval_decisions add constraint approval_decisions_check1
      CHECK (((decision <> 'EMERGENCY_APPROVE'::text) OR ((reason IS NOT NULL) AND (length(btrim(reason)) >= 20))));
  end if;
end $do$;

do $do$ begin
  if not exists (select 1 from pg_constraint
                  where conname = 'approval_decisions_decision_candidate_check'
                    and conrelid = 'public.approval_decisions'::regclass) then
    alter table public.approval_decisions add constraint approval_decisions_decision_candidate_check
      CHECK ((((decision = ANY (ARRAY['APPROVE'::text, 'REJECT'::text])) AND (candidate_id IS NOT NULL)) OR ((decision = ANY (ARRAY['EMERGENCY_APPROVE'::text, 'CHECKER_APPROVE'::text, 'CHECKER_REJECT'::text, 'SELF_APPROVED_WITHIN_LIMIT'::text, 'REVERSAL_POSTED'::text])) AND (candidate_id IS NULL))));
  end if;
end $do$;

do $do$ begin
  if not exists (select 1 from pg_constraint
                  where conname = 'approval_decisions_decision_check'
                    and conrelid = 'public.approval_decisions'::regclass) then
    alter table public.approval_decisions add constraint approval_decisions_decision_check
      CHECK ((decision = ANY (ARRAY['APPROVE'::text, 'REJECT'::text, 'EMERGENCY_APPROVE'::text, 'CHECKER_APPROVE'::text, 'CHECKER_REJECT'::text, 'SELF_APPROVED_WITHIN_LIMIT'::text, 'REVERSAL_POSTED'::text])));
  end if;
end $do$;

do $do$ begin
  if not exists (select 1 from pg_constraint
                  where conname = 'approval_rule_sets_organization_id_fkey'
                    and conrelid = 'public.approval_rule_sets'::regclass) then
    alter table public.approval_rule_sets add constraint approval_rule_sets_organization_id_fkey
      FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE RESTRICT;
  end if;
end $do$;

do $do$ begin
  if not exists (select 1 from pg_constraint
                  where conname = 'approval_rules_organization_id_rule_set_id_fkey'
                    and conrelid = 'public.approval_rules'::regclass) then
    alter table public.approval_rules add constraint approval_rules_organization_id_rule_set_id_fkey
      FOREIGN KEY (organization_id, rule_set_id) REFERENCES approval_rule_sets(organization_id, id) ON DELETE CASCADE;
  end if;
end $do$;

do $do$ begin
  if not exists (select 1 from pg_constraint
                  where conname = 'approval_rule_steps_organization_id_rule_id_fkey'
                    and conrelid = 'public.approval_rule_steps'::regclass) then
    alter table public.approval_rule_steps add constraint approval_rule_steps_organization_id_rule_id_fkey
      FOREIGN KEY (organization_id, rule_id) REFERENCES approval_rules(organization_id, id) ON DELETE CASCADE;
  end if;
end $do$;

do $do$ begin
  if not exists (select 1 from pg_constraint
                  where conname = 'approval_step_approvers_organization_id_step_id_fkey'
                    and conrelid = 'public.approval_step_approvers'::regclass) then
    alter table public.approval_step_approvers add constraint approval_step_approvers_organization_id_step_id_fkey
      FOREIGN KEY (organization_id, step_id) REFERENCES approval_rule_steps(organization_id, id) ON DELETE CASCADE;
  end if;
end $do$;

do $do$ begin
  if not exists (select 1 from pg_constraint
                  where conname = 'approval_requests_organization_id_fkey'
                    and conrelid = 'public.approval_requests'::regclass) then
    alter table public.approval_requests add constraint approval_requests_organization_id_fkey
      FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE RESTRICT;
  end if;
end $do$;

do $do$ begin
  if not exists (select 1 from pg_constraint
                  where conname = 'approval_requests_organization_id_maker_membership_id_make_fkey'
                    and conrelid = 'public.approval_requests'::regclass) then
    alter table public.approval_requests add constraint approval_requests_organization_id_maker_membership_id_make_fkey
      FOREIGN KEY (organization_id, maker_membership_id, maker_user_id) REFERENCES organization_memberships(organization_id, id, user_id);
  end if;
end $do$;

do $do$ begin
  if not exists (select 1 from pg_constraint
                  where conname = 'approval_request_steps_organization_id_request_id_fkey'
                    and conrelid = 'public.approval_request_steps'::regclass) then
    alter table public.approval_request_steps add constraint approval_request_steps_organization_id_request_id_fkey
      FOREIGN KEY (organization_id, request_id) REFERENCES approval_requests(organization_id, id) ON DELETE CASCADE;
  end if;
end $do$;

do $do$ begin
  if not exists (select 1 from pg_constraint
                  where conname = 'approval_request_step_candida_organization_id_membership_i_fkey'
                    and conrelid = 'public.approval_request_step_candidates'::regclass) then
    alter table public.approval_request_step_candidates add constraint approval_request_step_candida_organization_id_membership_i_fkey
      FOREIGN KEY (organization_id, membership_id) REFERENCES organization_memberships(organization_id, id);
  end if;
end $do$;

do $do$ begin
  if not exists (select 1 from pg_constraint
                  where conname = 'approval_request_step_candida_organization_id_request_step_fkey'
                    and conrelid = 'public.approval_request_step_candidates'::regclass) then
    alter table public.approval_request_step_candidates add constraint approval_request_step_candida_organization_id_request_step_fkey
      FOREIGN KEY (organization_id, request_step_id) REFERENCES approval_request_steps(organization_id, id) ON DELETE CASCADE;
  end if;
end $do$;

do $do$ begin
  if not exists (select 1 from pg_constraint
                  where conname = 'approval_decisions_organization_id_request_id_fkey'
                    and conrelid = 'public.approval_decisions'::regclass) then
    alter table public.approval_decisions add constraint approval_decisions_organization_id_request_id_fkey
      FOREIGN KEY (organization_id, request_id) REFERENCES approval_requests(organization_id, id) ON DELETE CASCADE;
  end if;
end $do$;

do $do$ begin
  if not exists (select 1 from pg_constraint
                  where conname = 'approval_decisions_organization_id_request_id_request_step_fkey'
                    and conrelid = 'public.approval_decisions'::regclass) then
    alter table public.approval_decisions add constraint approval_decisions_organization_id_request_id_request_step_fkey
      FOREIGN KEY (organization_id, request_id, request_step_id) REFERENCES approval_request_steps(organization_id, request_id, id);
  end if;
end $do$;

do $do$ begin
  if not exists (select 1 from pg_constraint
                  where conname = 'emergency_override_events_organization_id_fkey'
                    and conrelid = 'app_private.emergency_override_events'::regclass) then
    alter table app_private.emergency_override_events add constraint emergency_override_events_organization_id_fkey
      FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE RESTRICT;
  end if;
end $do$;


-- =====================================================================
-- [3] INDEX DOC LAP (3) -- index cua PK/UNIQUE da do [2] tao
-- =====================================================================

CREATE UNIQUE INDEX IF NOT EXISTS approval_decisions_one_normal_per_generation ON public.approval_decisions USING btree (organization_id, request_step_id, actor_user_id, candidate_generation) WHERE (decision = ANY (ARRAY['APPROVE'::text, 'REJECT'::text]));

CREATE UNIQUE INDEX IF NOT EXISTS approval_requests_one_open_subject ON public.approval_requests USING btree (organization_id, subject_type, subject_id) WHERE (state = 'PENDING_APPROVAL'::text);

CREATE UNIQUE INDEX IF NOT EXISTS approval_requests_one_reversal_uidx ON public.approval_requests USING btree (organization_id, reverses_request_id) WHERE (reverses_request_id IS NOT NULL);


-- =====================================================================
-- [4] ROW LEVEL SECURITY (8 bang bat)
--     2 bang app_private KHONG bat RLS -- nam ngoai schema public nen
--     PostgREST khong expose, chi ham SECURITY DEFINER cham toi.
-- =====================================================================

alter table public.approval_rule_sets enable row level security;
alter table public.approval_rules enable row level security;
alter table public.approval_rule_steps enable row level security;
alter table public.approval_step_approvers enable row level security;
alter table public.approval_requests enable row level security;
alter table public.approval_request_steps enable row level security;
alter table public.approval_request_step_candidates enable row level security;
alter table public.approval_decisions enable row level security;


-- =====================================================================
-- [5] HAM app_private (22) -- nguyen van pg_get_functiondef tren prod.
--     Gom 8 ham engine goc + closure de quy qua prosrc + 2 trigger guard
--     + 4 ham engine ke (publish / next_submission_no / self_approve /
--     reverse). Thu tu alphabet; CREATE OR REPLACE nen khong ke thu tu.
-- =====================================================================

-- ---- app_private.assert_no_engine_request_v1(p_voucher_id uuid)
CREATE OR REPLACE FUNCTION app_private.assert_no_engine_request_v1(p_voucher_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'pg_catalog', 'public', 'app_private'
AS $function$
begin
  if exists (
    select 1 from public.approval_requests ar
     where ar.subject_type = 'FINANCIAL_VOUCHER'
       and ar.subject_id = p_voucher_id
       and ar.state in ('PENDING_APPROVAL', 'POSTED')
  ) then
    raise exception 'Phiếu thuộc luồng duyệt engine (lương/lợi nhuận/chi cần duyệt) — xử lý tại màn hình "Chờ duyệt", không duyệt/huỷ duyệt trực tiếp'
      using errcode = '55000';
  end if;
end;
$function$;

-- ---- app_private.authorize_tenant_action_v3(p_actor uuid, p_organization_id uuid, p_permission_key text, p_building_id uuid, p_cashbook_id uuid)
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
$function$;

-- ---- app_private.decide_financial_request_v1(p_request_id uuid, p_expected_version bigint, p_actor_membership uuid, p_actor_user uuid, p_decision text, p_reason text)
CREATE OR REPLACE FUNCTION app_private.decide_financial_request_v1(p_request_id uuid, p_expected_version bigint, p_actor_membership uuid, p_actor_user uuid, p_decision text, p_reason text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'app_private', 'public'
AS $function$
declare
  v_req public.approval_requests;
  v_ie public.income_expenses;
  v_posting uuid;
  v_step public.approval_request_steps;
  v_next_pending uuid;
begin
  if p_decision not in ('APPROVE','REJECT') then
    raise exception 'invalid decision %', p_decision using errcode='22023';
  end if;
  select * into v_req from public.approval_requests
   where id = p_request_id for update;
  if not found then raise exception 'request not found' using errcode='P0002'; end if;
  if v_req.version <> p_expected_version then
    raise exception 'version conflict' using errcode='40001';
  end if;
  if v_req.state <> 'PENDING_APPROVAL' then
    raise exception 'request not decidable from %', v_req.state using errcode='55000';
  end if;

  -- maker-checker: decider must not be the maker (membership OR user)
  if p_actor_membership = v_req.maker_membership_id
     or p_actor_user = v_req.maker_user_id then
    raise exception 'maker cannot approve own request' using errcode='42501';
  end if;

  -- snapshot revalidation FAIL-CLOSED (H2): a request always has a payload_hash
  -- (NOT NULL column). If the subject lost its hash or drifted, reject.
  select * into v_ie from public.income_expenses
   where id = v_req.subject_id and organization_id = v_req.organization_id
   for update;
  if not found then raise exception 'subject missing' using errcode='P0002'; end if;
  if v_ie.source_payload_hash is null
     or v_req.payload_hash is null
     or v_req.payload_hash <> v_ie.source_payload_hash then
    raise exception 'subject changed or lost its snapshot hash (fail-closed)'
      using errcode='55000';
  end if;

  -- the CURRENT open step is the lowest step_no still PENDING; a request in
  -- PENDING_APPROVAL always has exactly one (submit sets step 1 PENDING, later
  -- steps WAITING, and each satisfied step promotes the next).
  select * into v_step from public.approval_request_steps
   where request_id = p_request_id and status = 'PENDING'
   order by step_no limit 1;
  if not found then
    raise exception 'no PENDING step to decide' using errcode='55000';
  end if;

  -- ELIGIBILITY (C1/H5): the decider must be a current-generation candidate of
  -- THIS step. Non-candidates cannot approve or reject.
  if not app_private.is_eligible_current_candidate_v1(v_step.id, p_actor_membership) then
    raise exception 'actor is not an eligible candidate for this step'
      using errcode='42501';
  end if;

  insert into public.approval_decisions
    (organization_id, request_id, request_step_id, actor_membership_id,
     actor_user_id, decision, reason, request_version)
  values
    (v_req.organization_id, p_request_id, v_step.id, p_actor_membership,
     p_actor_user,
     case p_decision when 'APPROVE' then 'CHECKER_APPROVE' else 'CHECKER_REJECT' end,
     p_reason, v_req.version);

  -- REJECT: any single reject terminates the request.
  if p_decision = 'REJECT' then
    update public.approval_request_steps set status = 'REJECTED' where id = v_step.id;
    update public.approval_requests
       set state = 'REJECTED', version = version + 1
     where id = p_request_id and version = p_expected_version;
    return null;
  end if;

  -- APPROVE: only advance when the step's mode/min_approvals are satisfied by
  -- current-generation candidate approvals (H5 counts correctly).
  if not app_private.step_is_satisfied_v1(v_step.id) then
    -- step not yet satisfied (e.g. QUORUM needs more approvals) — record and stop.
    return null;
  end if;
  update public.approval_request_steps set status = 'APPROVED' where id = v_step.id;

  -- promote the next WAITING step to PENDING, if any (multi-step).
  select id into v_next_pending from public.approval_request_steps
   where request_id = p_request_id and status = 'WAITING'
   order by step_no limit 1;
  if v_next_pending is not null then
    update public.approval_request_steps set status = 'PENDING' where id = v_next_pending;
    return null; -- more approvals required at the next step; not posted yet
  end if;

  -- all steps approved → post exactly once.
  v_posting := app_private.post_financial_request_v1(
    p_request_id, v_req.version, p_actor_user);
  return v_posting;
end;
$function$;

-- ---- app_private.emergency_approve_financial_v1(p_request_id uuid, p_expected_version bigint, p_actor_membership uuid, p_actor_user uuid, p_reason text, p_reauth_fresh boolean)
CREATE OR REPLACE FUNCTION app_private.emergency_approve_financial_v1(p_request_id uuid, p_expected_version bigint, p_actor_membership uuid, p_actor_user uuid, p_reason text, p_reauth_fresh boolean)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'app_private', 'public'
AS $function$
declare
  v_req public.approval_requests;
  v_member public.organization_memberships;
  v_allowed boolean;
  v_posting uuid;
begin
  if not p_reauth_fresh then
    raise exception 're-authentication required' using errcode='42501';
  end if;
  if coalesce(length(btrim(p_reason)), 0) < 20 then
    raise exception 'emergency reason must be >= 20 chars' using errcode='22023';
  end if;

  select * into v_req from public.approval_requests
   where id = p_request_id for update;
  if not found then raise exception 'request not found' using errcode='P0002'; end if;
  if v_req.version <> p_expected_version then
    raise exception 'version conflict' using errcode='40001'; end if;
  if v_req.state <> 'PENDING_APPROVAL' then
    raise exception 'request not pending' using errcode='55000'; end if;

  -- actor must be an ACTIVE OWNER membership
  select * into v_member from public.organization_memberships
   where id = p_actor_membership and organization_id = v_req.organization_id
     and status = 'ACTIVE' and member_type = 'OWNER';
  if not found then
    raise exception 'emergency override requires active OWNER' using errcode='42501';
  end if;
  if v_member.user_id is distinct from p_actor_user then
    raise exception 'membership/user mismatch' using errcode='42501';
  end if;

  -- owner-is-maker cannot use emergency to bypass force-approval
  if p_actor_membership = v_req.maker_membership_id then
    raise exception 'maker cannot self-emergency-approve' using errcode='42501';
  end if;

  -- must hold approvals.emergency_override per the T2 resolver
  perform app_private.lock_org_for_decision_v1(v_req.organization_id);
  select allowed into v_allowed
    from app_private.authorize_tenant_action_v3(
      p_actor_user, v_req.organization_id, 'approvals.emergency_override',
      v_req.building_id, v_req.cashbook_id);
  if not coalesce(v_allowed, false) then
    raise exception 'actor lacks approvals.emergency_override' using errcode='42501';
  end if;

  -- BYPASS all open steps
  update public.approval_request_steps
     set status = 'BYPASSED'
   where request_id = p_request_id and status in ('WAITING','PENDING');

  insert into public.approval_decisions
    (organization_id, request_id, request_step_id, actor_membership_id,
     actor_user_id, decision, reason, request_version)
  select v_req.organization_id, p_request_id, s.id, p_actor_membership,
         p_actor_user, 'EMERGENCY_APPROVE', p_reason, v_req.version
    from public.approval_request_steps s
   where s.request_id = p_request_id
   order by s.step_no limit 1;

  insert into app_private.emergency_override_events
    (organization_id, request_id, actor_membership_id, actor_user_id, reason)
  values (v_req.organization_id, p_request_id, p_actor_membership, p_actor_user, p_reason);

  v_posting := app_private.post_financial_request_v1(
    p_request_id, v_req.version, p_actor_user);
  return v_posting;
end;
$function$;

-- ---- app_private.guard_emergency_events_immutable()
CREATE OR REPLACE FUNCTION app_private.guard_emergency_events_immutable()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog'
AS $function$
begin raise exception 'emergency override events are append-only' using errcode='55000'; end;
$function$;

-- ---- app_private.guard_published_rule_set()
CREATE OR REPLACE FUNCTION app_private.guard_published_rule_set()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
declare
  v_status text;
begin
  if tg_table_name = 'approval_rule_sets' then
    -- H6 fix: ALLOWLIST. Once published (ACTIVE/RETIRED), the ONLY legal changes
    -- are the retire transition (status ACTIVE→RETIRED + effective_to) driven by
    -- publish_rule_set_v1. Everything else — including resurrecting RETIRED→ACTIVE,
    -- moving effective_from, editing config — is rejected. We compare the whole
    -- row minus the retire-transition columns.
    if tg_op = 'UPDATE' and old.status in ('ACTIVE','RETIRED') then
      -- forbid resurrecting a RETIRED set to ACTIVE
      if old.status = 'RETIRED' and new.status <> 'RETIRED' then
        raise exception 'RETIRED rule set cannot be resurrected' using errcode='55000';
      end if;
      -- ACTIVE may only go to RETIRED; nothing else may change except the
      -- retire bookkeeping columns.
      if old.status = 'ACTIVE' and new.status not in ('ACTIVE','RETIRED') then
        raise exception 'published rule set status transition illegal' using errcode='55000';
      end if;
      if (to_jsonb(old) - array['status','effective_to'])
         is distinct from (to_jsonb(new) - array['status','effective_to']) then
        raise exception 'published rule set content is immutable' using errcode='55000';
      end if;
    end if;
    if tg_op = 'DELETE' and old.status in ('ACTIVE','RETIRED') then
      raise exception 'published rule set cannot be deleted' using errcode='55000';
    end if;
    return case when tg_op='DELETE' then old else new end;
  end if;

  -- approval_rules: frozen once their rule set is published
  select status into v_status from public.approval_rule_sets
   where id = coalesce(new.rule_set_id, old.rule_set_id);
  if v_status in ('ACTIVE','RETIRED') then
    raise exception 'rules of a published rule set are immutable' using errcode='55000';
  end if;
  return case when tg_op='DELETE' then old else new end;
end;
$function$;

-- ---- app_private.ie_cancel_close_request_v1()
CREATE OR REPLACE FUNCTION app_private.ie_cancel_close_request_v1()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'app_private'
AS $function$
begin
  update public.approval_requests ar
     set state = 'CANCELLED', version = ar.version + 1
   where ar.subject_type = 'FINANCIAL_VOUCHER'
     and ar.subject_id = new.id
     and ar.state = 'PENDING_APPROVAL';
  return null;
end;
$function$;

-- ---- app_private.ie_transaction_domain_v1()
CREATE OR REPLACE FUNCTION app_private.ie_transaction_domain_v1()
 RETURNS text
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO 'pg_catalog'
AS $function$ select 'FINANCIAL_VOUCHER'::text $function$;

-- ---- app_private.is_eligible_current_candidate_v1(p_request_step_id uuid, p_actor_membership uuid)
CREATE OR REPLACE FUNCTION app_private.is_eligible_current_candidate_v1(p_request_step_id uuid, p_actor_membership uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
  select exists (
    select 1
      from public.approval_request_step_candidates c
      join public.approval_request_steps s on s.id = c.request_step_id
     where c.request_step_id = p_request_step_id
       and c.membership_id = p_actor_membership
       and c.generation = s.current_generation
       and c.valid_to is null
  );
$function$;

-- ---- app_private.is_income_expense_flow_owned(p_id uuid)
CREATE OR REPLACE FUNCTION app_private.is_income_expense_flow_owned(p_id uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'app_private'
AS $function$
  select exists (
    select 1 from app_private.income_expense_flow_ownership
     where income_expense_id = p_id);
$function$;

-- ---- app_private.lock_org_for_decision_v1(p_organization_id uuid)
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
$function$;

-- ---- app_private.materialize_step_candidates_v1(p_request_step_id uuid)
CREATE OR REPLACE FUNCTION app_private.materialize_step_candidates_v1(p_request_step_id uuid)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'app_private', 'public'
AS $function$
declare
  v_step public.approval_request_steps;
  v_req public.approval_requests;
  v_gen integer;
  v_count integer;
  v_rule_step_id uuid;
begin
  select * into v_step from public.approval_request_steps
   where id = p_request_step_id for update;
  if not found then raise exception 'step not found' using errcode='P0002'; end if;

  select * into v_req from public.approval_requests
   where id = v_step.request_id;

  -- the approver spec is attached to the source rule step; the request step's
  -- snapshot carries that id.
  v_rule_step_id := nullif(v_step.rule_step_snapshot->>'rule_step_id','')::uuid;
  v_gen := v_step.current_generation + 1;

  -- F12 fix: take the org share-lock in a PRIOR statement before the resolver is
  -- evaluated as a scalar subquery below, so PERMISSION-type candidate matching
  -- reads a witness snapshot taken after any concurrent mutation's lock wait.
  perform app_private.lock_org_for_decision_v1(v_req.organization_id);

  -- close prior generation (valid_to set; history preserved)
  update public.approval_request_step_candidates
     set valid_to = clock_timestamp()
   where request_step_id = p_request_step_id
     and generation = v_step.current_generation
     and valid_to is null;

  -- materialize the union of all approver specs into distinct memberships,
  -- excluding the maker (a maker can never be their own checker candidate).
  insert into public.approval_request_step_candidates
    (organization_id, request_step_id, membership_id, generation,
     source_kind, source_id, eligible_at_submit, valid_from)
  select distinct on (m.id)
    v_req.organization_id, p_request_step_id, m.id, v_gen,
    sa.approver_type, sa.id, true, clock_timestamp()
  from public.approval_step_approvers sa
  join public.organization_memberships m
    on m.organization_id = v_req.organization_id and m.status = 'ACTIVE'
  where sa.step_id = v_rule_step_id
    -- M10 fix: exclude the maker by BOTH membership AND user_id (a maker with a
    -- second ACTIVE membership must not inflate candidate_count or self-approve).
    and m.id <> v_req.maker_membership_id
    and m.user_id <> v_req.maker_user_id
    and (
      -- MEMBER: the exact membership
      (sa.approver_type = 'MEMBER' and sa.membership_id = m.id)
      -- ROLE: any member bound to the role (nonlegacy binding, active)
      or (sa.approver_type = 'ROLE' and exists (
        select 1 from public.role_bindings rb
         where rb.organization_id = v_req.organization_id
           and rb.membership_id = m.id and rb.role_id = sa.role_id
           and coalesce(rb.valid_from,'-infinity') <= clock_timestamp()
           and (rb.valid_to is null or rb.valid_to > clock_timestamp())))
      -- PERMISSION: any member the T2 resolver would ALLOW for the permission
      or (sa.approver_type = 'PERMISSION' and (
        select allowed from app_private.authorize_tenant_action_v3(
          m.user_id, v_req.organization_id, sa.permission_key,
          v_req.building_id, v_req.cashbook_id)))
      -- CASHBOOK_APPROVER: holds possession on the request cashbook
      or (sa.approver_type = 'CASHBOOK_APPROVER' and v_req.cashbook_id is not null
          and exists (
        select 1 from public.cashbook_possession_bindings cp
         where cp.organization_id = v_req.organization_id
           and cp.cashbook_id = v_req.cashbook_id and cp.membership_id = m.id
           and cp.valid_from <= clock_timestamp()
           and (cp.valid_to is null or cp.valid_to > clock_timestamp())))
      -- BUILDING_APPROVER: role binding scoped to the request building
      or (sa.approver_type = 'BUILDING_APPROVER' and v_req.building_id is not null
          and exists (
        select 1 from public.role_bindings rb
         join public.role_binding_scopes rbs
           on rbs.organization_id = rb.organization_id and rbs.role_binding_id = rb.id
         join public.authorization_scopes s
           on s.organization_id = rbs.organization_id and s.id = rbs.scope_id
         where rb.organization_id = v_req.organization_id and rb.membership_id = m.id
           and s.scope_type = 'BUILDING' and s.building_id = v_req.building_id))
      -- AREA_APPROVER: role binding scoped to an area covering the building
      or (sa.approver_type = 'AREA_APPROVER' and v_req.building_id is not null
          and exists (
        select 1 from public.role_bindings rb
         join public.role_binding_scopes rbs
           on rbs.organization_id = rb.organization_id and rbs.role_binding_id = rb.id
         join public.authorization_scopes s
           on s.organization_id = rbs.organization_id and s.id = rbs.scope_id
         join public.area_buildings ab
           on ab.organization_id = s.organization_id and ab.area_id = s.area_id
         where rb.organization_id = v_req.organization_id and rb.membership_id = m.id
           and s.scope_type = 'AREA' and ab.building_id = v_req.building_id))
    );
  get diagnostics v_count = row_count;

  update public.approval_request_steps
     set current_generation = v_gen, candidate_count = v_count
   where id = p_request_step_id;

  -- fail-closed: no candidate, or quorum impossible
  if v_count = 0 then
    raise exception 'step % has zero eligible candidates', p_request_step_id
      using errcode='55000';
  end if;
  if v_step.mode = 'ALL' and v_step.min_approvals <> v_count then
    -- ALL requires min = candidate_count; adjust or fail. We fail-closed so
    -- the rule author must reconcile min_approvals with the ALL semantics.
    raise exception 'ALL-mode step % min_approvals % <> candidate_count %',
      p_request_step_id, v_step.min_approvals, v_count using errcode='55000';
  end if;
  if v_step.mode = 'QUORUM' and v_step.min_approvals > v_count then
    raise exception 'QUORUM step % needs % approvals but only % candidates',
      p_request_step_id, v_step.min_approvals, v_count using errcode='55000';
  end if;

  return v_count;
end;
$function$;

-- ---- app_private.next_submission_no_v1(p_organization_id uuid, p_subject_type text, p_subject_id uuid)
CREATE OR REPLACE FUNCTION app_private.next_submission_no_v1(p_organization_id uuid, p_subject_type text, p_subject_id uuid)
 RETURNS integer
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
  select coalesce(max(submission_no), 0) + 1
    from public.approval_requests
   where organization_id = p_organization_id
     and subject_type = p_subject_type
     and subject_id = p_subject_id;
$function$;

-- ---- app_private.post_financial_request_v1(p_request_id uuid, p_expected_version bigint, p_actor uuid)
CREATE OR REPLACE FUNCTION app_private.post_financial_request_v1(p_request_id uuid, p_expected_version bigint, p_actor uuid)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'app_private', 'public'
AS $function$
declare
  v_req public.approval_requests;
  v_ie public.income_expenses;
  v_posting uuid := gen_random_uuid();
  v_rows int;
begin
  select * into v_req from public.approval_requests
   where id = p_request_id for update;
  if not found then raise exception 'request not found' using errcode='P0002'; end if;
  if v_req.version <> p_expected_version then
    raise exception 'version conflict' using errcode='40001';
  end if;
  if v_req.state <> 'PENDING_APPROVAL' then
    raise exception 'request not postable from state %', v_req.state using errcode='55000';
  end if;
  if v_req.posted_event_id is not null then
    raise exception 'request already posted' using errcode='55000';
  end if;

  -- lock + transition the subject voucher; assert exactly one row
  select * into v_ie from public.income_expenses
   where id = v_req.subject_id and organization_id = v_req.organization_id
   for update;
  if not found then raise exception 'subject missing' using errcode='P0002'; end if;
  if v_ie.approval_status = 'APPROVED' or v_ie.posting_id is not null then
    raise exception 'subject already posted' using errcode='55000';
  end if;

  -- Transition the subject voucher through the freeze-exempt canonical path
  -- (t3_10). Only lifecycle columns move; the financial payload stays frozen.
  -- For canonical-marked subjects this is the ONLY legal write path; for legacy
  -- unmarked subjects the plain UPDATE below applies (the guard is a no-op).
  if app_private.is_income_expense_flow_owned(v_req.subject_id) then
    perform app_private.transition_canonical_income_expense_v1(
      v_req.subject_id, 'APPROVED', v_posting, null);
  else
    update public.income_expenses
       set approval_status = 'APPROVED', posting_id = v_posting,
           posted_at_v2 = clock_timestamp()
     where id = v_req.subject_id;
  end if;

  update public.approval_requests
     set state = 'POSTED', posted_at = clock_timestamp(),
         posted_event_id = v_posting, version = version + 1
   where id = p_request_id and version = p_expected_version;
  get diagnostics v_rows = row_count;
  if v_rows <> 1 then
    raise exception 'posting affected % request rows (expected 1)', v_rows
      using errcode='55000';
  end if;

  return v_posting;
end;
$function$;

-- ---- app_private.publish_rule_set_v1(p_rule_set_id uuid, p_actor uuid)
CREATE OR REPLACE FUNCTION app_private.publish_rule_set_v1(p_rule_set_id uuid, p_actor uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
declare
  v_rs public.approval_rule_sets;
  v_fallbacks int;
begin
  select * into v_rs from public.approval_rule_sets
   where id = p_rule_set_id for update;
  if not found then raise exception 'rule set not found' using errcode='P0002'; end if;
  if v_rs.status <> 'DRAFT' then
    raise exception 'only DRAFT rule sets can be published (is %)', v_rs.status
      using errcode='55000';
  end if;

  -- M7 fix: exactly one fallback rule OVERALL, and it must be REQUIRE_APPROVAL.
  select count(*) into v_fallbacks from public.approval_rules
   where rule_set_id = p_rule_set_id and is_fallback;
  if v_fallbacks <> 1 then
    raise exception 'rule set must have exactly one fallback rule (has %)',
      v_fallbacks using errcode='55000';
  end if;
  if not exists (
    select 1 from public.approval_rules
     where rule_set_id = p_rule_set_id and is_fallback and effect = 'REQUIRE_APPROVAL') then
    raise exception 'the fallback rule must be REQUIRE_APPROVAL' using errcode='55000';
  end if;

  -- retire the current ACTIVE version for the same (org, domain)
  update public.approval_rule_sets
     set status = 'RETIRED', effective_to = clock_timestamp()
   where organization_id = v_rs.organization_id
     and transaction_domain = v_rs.transaction_domain
     and status = 'ACTIVE'
     and id <> p_rule_set_id;

  update public.approval_rule_sets
     set status = 'ACTIVE',
         effective_from = clock_timestamp(),
         published_by = p_actor,
         published_at = clock_timestamp()
   where id = p_rule_set_id;
end;
$function$;

-- ---- app_private.raise_malformed_override(p_organization_id uuid, p_permission_key text)
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
$function$;

-- ---- app_private.resolve_active_rule_set_v1(p_organization_id uuid, p_transaction_domain text)
CREATE OR REPLACE FUNCTION app_private.resolve_active_rule_set_v1(p_organization_id uuid, p_transaction_domain text)
 RETURNS uuid
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
declare
  v_count int;
  v_id uuid;
begin
  select count(*) into v_count
    from public.approval_rule_sets
   where organization_id = p_organization_id
     and transaction_domain = p_transaction_domain
     and status = 'ACTIVE'
     and effective_from <= clock_timestamp()
     and (effective_to is null or effective_to > clock_timestamp());
  if v_count <> 1 then
    raise exception 'rule resolution not unique: % ACTIVE versions for %/%',
      v_count, p_organization_id, p_transaction_domain using errcode='55000';
  end if;
  select id into v_id
    from public.approval_rule_sets
   where organization_id = p_organization_id
     and transaction_domain = p_transaction_domain
     and status = 'ACTIVE'
     and effective_from <= clock_timestamp()
     and (effective_to is null or effective_to > clock_timestamp());
  return v_id;
end;
$function$;

-- ---- app_private.reverse_financial_request_v1(p_original_request_id uuid, p_actor_membership uuid, p_actor_user uuid, p_reason text)
CREATE OR REPLACE FUNCTION app_private.reverse_financial_request_v1(p_original_request_id uuid, p_actor_membership uuid, p_actor_user uuid, p_reason text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'app_private', 'public'
AS $function$
declare
  v_orig public.approval_requests;
  v_rev_id uuid;
  v_sub_no int;
begin
  select * into v_orig from public.approval_requests
   where id = p_original_request_id for update;
  if not found then raise exception 'original not found' using errcode='P0002'; end if;
  if v_orig.state <> 'POSTED' then
    raise exception 'only POSTED requests can be reversed' using errcode='55000';
  end if;
  if v_orig.reversed_by_request_id is not null then
    raise exception 'request already reversed' using errcode='55000';
  end if;

  v_sub_no := app_private.next_submission_no_v1(
    v_orig.organization_id, v_orig.subject_type, v_orig.subject_id);

  insert into public.approval_requests
    (organization_id, submission_no, subject_type, subject_id, state,
     maker_membership_id, maker_user_id, rule_set_id, rule_set_version,
     matched_rule_id, rule_effect, payload_snapshot, payload_hash,
     amount, category_id, cashbook_id, building_id, system_source,
     submitted_at, reverses_request_id)
  values
    (v_orig.organization_id, v_sub_no, v_orig.subject_type, v_orig.subject_id,
     'POSTED', p_actor_membership, p_actor_user, v_orig.rule_set_id,
     v_orig.rule_set_version, v_orig.matched_rule_id, 'REVERSAL',
     v_orig.payload_snapshot, v_orig.payload_hash,
     -coalesce(v_orig.amount, 0), v_orig.category_id, v_orig.cashbook_id,
     v_orig.building_id, 'reversal', clock_timestamp(), p_original_request_id)
  returning id into v_rev_id;

  update public.approval_requests
     set state = 'REVERSED', reversed_by_request_id = v_rev_id,
         version = version + 1
   where id = p_original_request_id;

  -- Reversal provenance is the reverses_request_id link + the (chained) audit
  -- event appended by the calling public wrapper; the decision table requires a
  -- step row, and a reversal has no approval step, so we do not write one here.
  -- The full T3 wrapper appends a REVERSAL audit event via the A.5 primitive.

  return v_rev_id;
end;
$function$;

-- ---- app_private.self_approve_within_limit_v1(p_request_id uuid, p_expected_version bigint, p_actor_membership uuid, p_actor_user uuid)
CREATE OR REPLACE FUNCTION app_private.self_approve_within_limit_v1(p_request_id uuid, p_expected_version bigint, p_actor_membership uuid, p_actor_user uuid)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'app_private', 'public'
AS $function$
declare
  v_req public.approval_requests;
  v_limit numeric(15,2);
  v_posting uuid;
  v_holds boolean;
  v_is_force boolean;
  v_batch_total numeric(15,2);
  v_allowed boolean;
begin
  select * into v_req from public.approval_requests
   where id = p_request_id for update;
  if not found then raise exception 'request not found' using errcode='P0002'; end if;
  if v_req.version <> p_expected_version then
    raise exception 'version conflict' using errcode='40001'; end if;
  if v_req.state <> 'PENDING_APPROVAL' then
    raise exception 'not pending' using errcode='55000'; end if;

  -- must be the maker (this is a self-approval)
  if p_actor_membership <> v_req.maker_membership_id then
    raise exception 'self-approve requires maker' using errcode='42501';
  end if;

  -- H3 fix: force-approval class is derived from the SUBJECT'S item types
  -- (schema-owned is_deposit + commission/bonus names), NOT from a client-
  -- settable system_source. Force categories can never self-approve.
  select bool_or(coalesce(t.is_deposit,false)
                 or public.nrm_vn(t.name) in ('hoa hong moi gioi','thuong nong sale'))
    into v_is_force
    from public.income_expense_items i
    join public.income_expense_types t on t.id = i.income_expense_type_id
   where i.income_expense_id = v_req.subject_id;
  if coalesce(v_is_force,false) then
    raise exception 'force-approval class cannot self-approve' using errcode='42501';
  end if;

  -- M8 fix: exact permissions via the T2 resolver (self_approve_within_limit
  -- AND cashbooks.post), not just possession.
  perform app_private.lock_org_for_decision_v1(v_req.organization_id);
  select allowed into v_allowed from app_private.authorize_tenant_action_v3(
    p_actor_user, v_req.organization_id,
    'income_expenses.self_approve_within_limit', v_req.building_id, v_req.cashbook_id);
  if not coalesce(v_allowed,false) then
    raise exception 'actor lacks income_expenses.self_approve_within_limit' using errcode='42501';
  end if;
  select allowed into v_allowed from app_private.authorize_tenant_action_v3(
    p_actor_user, v_req.organization_id, 'cashbooks.post',
    v_req.building_id, v_req.cashbook_id);
  if not coalesce(v_allowed,false) then
    raise exception 'actor lacks cashbooks.post' using errcode='42501';
  end if;

  -- versioned limit (default 0 disables self-approval entirely)
  select max_single_amount_vnd into v_limit
    from app_private.self_approve_limits
   where organization_id = v_req.organization_id
   order by version desc limit 1;
  v_limit := coalesce(v_limit, 0);
  if v_limit = 0 then
    raise exception 'self-approve disabled (limit 0)' using errcode='42501';
  end if;
  -- H4 fix: anti-split. Sum this maker's OTHER self-approved-or-pending requests
  -- for the SAME subject (correlation) plus this one; the aggregate must be
  -- within the limit, so splitting one business event into N vouchers is caught.
  select coalesce(sum(r.amount),0) into v_batch_total
    from public.approval_requests r
   where r.organization_id = v_req.organization_id
     and r.subject_id = v_req.subject_id
     and r.maker_membership_id = v_req.maker_membership_id
     and r.state in ('PENDING_APPROVAL','POSTED')
     and r.id <> v_req.id;
  if coalesce(v_req.amount,0) + v_batch_total > v_limit then
    raise exception 'aggregate self-approve amount exceeds limit (% > %)',
      coalesce(v_req.amount,0) + v_batch_total, v_limit using errcode='42501';
  end if;

  -- must hold the cashbook the request posts to
  if v_req.cashbook_id is null then
    raise exception 'self-approve requires a held cashbook' using errcode='42501';
  end if;
  select exists (
    select 1 from public.cashbook_possession_bindings cp
     where cp.organization_id = v_req.organization_id
       and cp.cashbook_id = v_req.cashbook_id
       and cp.membership_id = p_actor_membership
       and cp.possession_kind in ('CUSTODIAN','OPERATOR')
       and cp.valid_from <= clock_timestamp()
       and (cp.valid_to is null or cp.valid_to > clock_timestamp())
  ) into v_holds;
  if not v_holds then
    raise exception 'maker does not hold the target cashbook' using errcode='42501';
  end if;

  declare v_step uuid;
  begin
    select id into v_step from public.approval_request_steps
     where request_id = p_request_id
     order by (status = 'PENDING') desc, step_no limit 1;
    insert into public.approval_decisions
      (organization_id, request_id, request_step_id, actor_membership_id,
       actor_user_id, decision, reason, request_version)
    values
      (v_req.organization_id, p_request_id, v_step, p_actor_membership,
       p_actor_user, 'SELF_APPROVED_WITHIN_LIMIT', 'within versioned limit',
       v_req.version);
  end;

  v_posting := app_private.post_financial_request_v1(
    p_request_id, v_req.version, p_actor_user);
  return v_posting;
end;
$function$;

-- ---- app_private.step_is_satisfied_v1(p_request_step_id uuid)
CREATE OR REPLACE FUNCTION app_private.step_is_satisfied_v1(p_request_step_id uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
  -- H5 fix: count only DISTINCT approvals by members who are current-generation
  -- candidates of THIS step (a member removed on rematerialize no longer counts,
  -- and non-candidate approvals never counted). candidate_count is recomputed
  -- from live current-generation candidates so ALL cannot be satisfied by a
  -- stale ceiling.
  select case s.mode
    when 'ANY' then approvals >= 1
    when 'ALL' then approvals >= live_candidates and live_candidates > 0
    when 'QUORUM' then approvals >= s.min_approvals
    else false
  end
  from public.approval_request_steps s
  cross join lateral (
    select
      count(distinct d.actor_membership_id) filter (
        where d.decision in ('APPROVE','CHECKER_APPROVE')
          and exists (
            select 1 from public.approval_request_step_candidates c
             where c.request_step_id = s.id
               and c.membership_id = d.actor_membership_id
               and c.generation = s.current_generation
               and c.valid_to is null)) as approvals,
      (select count(*) from public.approval_request_step_candidates c
        where c.request_step_id = s.id
          and c.generation = s.current_generation
          and c.valid_to is null) as live_candidates
      from public.approval_decisions d
     where d.request_step_id = p_request_step_id
  ) a
  where s.id = p_request_step_id;
$function$;

-- ---- app_private.submit_financial_request_v1(p_subject_id uuid, p_actor_membership uuid, p_actor_user uuid, p_idempotency_key text)
CREATE OR REPLACE FUNCTION app_private.submit_financial_request_v1(p_subject_id uuid, p_actor_membership uuid, p_actor_user uuid, p_idempotency_key text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'app_private', 'public'
AS $function$

declare

  v_ie public.income_expenses;

  v_org uuid;

  v_rule_set uuid;

  v_rule public.approval_rules;

  v_effect text;

  v_is_force boolean;

  v_sub_no int;

  v_hash text;

  v_snapshot jsonb;

  v_req uuid;

  v_ver bigint;

  v_type record;

  r_step record;

  v_step_id uuid;

  v_posting uuid;

  v_existing uuid;

begin

  -- 1. lock + derive from the subject (never trust client-derived fields)

  select * into v_ie from public.income_expenses

   where id = p_subject_id and deleted_at is null for update;

  if not found then raise exception 'subject not found' using errcode='P0002'; end if;

  v_org := v_ie.organization_id;

  if v_org is null then raise exception 'subject has no organization' using errcode='23514'; end if;



  -- maker attribution must be a real ACTIVE membership of this org matching the

  -- actor user (composite FK on approval_requests enforces this too).

  if not exists (

    select 1 from public.organization_memberships m

     where m.id = p_actor_membership and m.organization_id = v_org

       and m.user_id = p_actor_user and m.status = 'ACTIVE') then

    raise exception 'maker membership/user not active in org' using errcode='42501';

  end if;



  -- idempotent replay: an open request for the same subject with the same key

  -- returns the same request (append-only; one-open-subject guarantees <=1).

  select id into v_existing from public.approval_requests

   where organization_id = v_org and subject_type = 'FINANCIAL_VOUCHER'

     and subject_id = p_subject_id and state = 'PENDING_APPROVAL';

  if v_existing is not null then

    return v_existing; -- already submitted; idempotent

  end if;



  -- 2. resolve the single ACTIVE rule set (fail-closed)

  v_rule_set := app_private.resolve_active_rule_set_v1(

    v_org, app_private.ie_transaction_domain_v1());



  -- classify force categories from the item types of the subject

  select bool_or(coalesce(t.is_deposit,false)

                 or public.nrm_vn(t.name) in ('hoa hong moi gioi','thuong nong sale')
                 or coalesce(t.force_approval,false))

    into v_is_force

    from public.income_expense_items i

    join public.income_expense_types t on t.id = i.income_expense_type_id

   where i.income_expense_id = p_subject_id;

  v_is_force := coalesce(v_is_force, false);



  -- 3. match the highest-priority active rule; else fallback

  select * into v_rule from public.approval_rules r

   where r.rule_set_id = v_rule_set and r.active

     and not r.is_fallback

     and (r.force_match

          or r.transaction_type is null or r.transaction_type = v_ie.type)

     and (r.building_id is null or r.building_id = v_ie.building_id)

     and (r.cashbook_id is null or r.cashbook_id = v_ie.account_id)

     and (r.category_id is null or exists (

       select 1 from public.income_expense_items i

        where i.income_expense_id = p_subject_id

          and i.income_expense_type_id = r.category_id))

     and (r.system_source is null or r.system_source = v_ie.system_source)

     and (r.amount_min is null or v_ie.total_amount >= r.amount_min)

     and (r.amount_max is null or v_ie.total_amount <= r.amount_max)

   order by r.priority asc

   limit 1;

  if not found then

    select * into v_rule from public.approval_rules r

     where r.rule_set_id = v_rule_set and r.is_fallback and r.active

     limit 1;

    if not found then

      raise exception 'no matching or fallback rule (fail-closed)' using errcode='55000';

    end if;

  end if;



  -- force categories can never AUTO_POST

  v_effect := v_rule.effect;

  if v_is_force and v_effect = 'AUTO_POST' then

    v_effect := 'REQUIRE_APPROVAL';

  end if;



  -- 5. submission_no under the subject lock

  select coalesce(max(submission_no),0) + 1 into v_sub_no

    from public.approval_requests

   where organization_id = v_org and subject_type = 'FINANCIAL_VOUCHER'

     and subject_id = p_subject_id;



  -- 6. snapshot + hash (canonical fields only; not client spelling)

  v_snapshot := jsonb_build_object(

    'subject_id', p_subject_id, 'amount', v_ie.total_amount,

    'account_id', v_ie.account_id, 'building_id', v_ie.building_id,

    'type', v_ie.type, 'source_payload_hash', v_ie.source_payload_hash);

  v_hash := coalesce(v_ie.source_payload_hash, md5(v_snapshot::text));



  insert into public.approval_requests

    (organization_id, submission_no, subject_type, subject_id, state,

     maker_membership_id, maker_user_id, rule_set_id, rule_set_version,

     matched_rule_id, rule_effect, payload_snapshot, payload_hash, amount,

     category_id, cashbook_id, building_id, system_source, submitted_at, version)

  select

    v_org, v_sub_no, 'FINANCIAL_VOUCHER', p_subject_id,

    case v_effect when 'AUTO_POST' then 'PENDING_APPROVAL'

                  when 'DENY' then 'DENIED'

                  else 'PENDING_APPROVAL' end,

    p_actor_membership, p_actor_user, rs.id, rs.version,

    v_rule.id, v_effect, v_snapshot, v_hash, v_ie.total_amount,

    v_rule.category_id, v_ie.account_id, v_ie.building_id, v_ie.system_source,

    clock_timestamp(), 1

  from public.approval_rule_sets rs where rs.id = v_rule_set

  returning id, version into v_req, v_ver;



  -- DENY: terminal, no steps

  if v_effect = 'DENY' then

    return v_req;

  end if;



  -- AUTO_POST: post immediately (no approval steps)

  if v_effect = 'AUTO_POST' then

    v_posting := app_private.post_financial_request_v1(v_req, v_ver, p_actor_user);

    return v_req;

  end if;



  -- REQUIRE_APPROVAL: materialize steps from the matched rule's rule steps,

  -- then candidates for each. Fail-closed if the rule has no steps.

  if not exists (select 1 from public.approval_rule_steps

                  where rule_id = v_rule.id) then

    raise exception 'REQUIRE_APPROVAL rule % has no steps', v_rule.id using errcode='55000';

  end if;



  for r_step in

    select * from public.approval_rule_steps

     where rule_id = v_rule.id order by step_no

  loop

    insert into public.approval_request_steps

      (organization_id, request_id, step_no, status, mode, min_approvals,

       current_generation, rule_step_snapshot, candidate_count)

    values

      (v_org, v_req, r_step.step_no,

       case when r_step.step_no = 1 then 'PENDING' else 'WAITING' end,

       r_step.mode, r_step.min_approvals, 1,

       jsonb_build_object('rule_step_id', r_step.id), 0)

    returning id into v_step_id;



    perform app_private.materialize_step_candidates_v1(v_step_id);

  end loop;



  return v_req;

end;

$function$;

-- ---- app_private.transition_canonical_income_expense_v1(p_income_expense_id uuid, p_new_approval_status text, p_posting_id uuid, p_reversed_by_posting_id uuid)
CREATE OR REPLACE FUNCTION app_private.transition_canonical_income_expense_v1(p_income_expense_id uuid, p_new_approval_status text, p_posting_id uuid, p_reversed_by_posting_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'app_private', 'public'
AS $function$
declare
  v_rows int;
begin
  if not app_private.is_income_expense_flow_owned(p_income_expense_id) then
    raise exception 'not a canonical row: %', p_income_expense_id using errcode='55000';
  end if;
  if p_new_approval_status not in ('APPROVED','CANCELLED','REVERSED','DENIED','REJECTED') then
    raise exception 'illegal transition target %', p_new_approval_status using errcode='22023';
  end if;

  insert into app_private.ie_transition_authorization
    (income_expense_id, xid, purpose)
  values (p_income_expense_id, pg_current_xact_id(), p_new_approval_status);

  update public.income_expenses
     set approval_status = p_new_approval_status,
         posting_id = coalesce(p_posting_id, posting_id),
         posted_at_v2 = case when p_new_approval_status='APPROVED'
                             then clock_timestamp() else posted_at_v2 end,
         reversed_by_posting_id = coalesce(p_reversed_by_posting_id, reversed_by_posting_id)
   where id = p_income_expense_id;
  get diagnostics v_rows = row_count;

  delete from app_private.ie_transition_authorization
   where income_expense_id = p_income_expense_id and xid = pg_current_xact_id();

  if v_rows <> 1 then
    raise exception 'transition affected % rows (expected 1)', v_rows using errcode='55000';
  end if;
end;
$function$;


-- =====================================================================
-- [6] TRIGGER (4)
-- =====================================================================

drop trigger if exists a00_rule_set_immutable on public.approval_rule_sets;
CREATE TRIGGER a00_rule_set_immutable BEFORE DELETE OR UPDATE ON public.approval_rule_sets FOR EACH ROW EXECUTE FUNCTION app_private.guard_published_rule_set();

drop trigger if exists a00_rules_immutable on public.approval_rules;
CREATE TRIGGER a00_rules_immutable BEFORE INSERT OR DELETE OR UPDATE ON public.approval_rules FOR EACH ROW EXECUTE FUNCTION app_private.guard_published_rule_set();

drop trigger if exists a00_emergency_events_immutable on app_private.emergency_override_events;
CREATE TRIGGER a00_emergency_events_immutable BEFORE DELETE OR UPDATE ON app_private.emergency_override_events FOR EACH ROW EXECUTE FUNCTION app_private.guard_emergency_events_immutable();

-- a75 nam tren public.income_expenses (bang NGOAI file nay) ->
-- boc dieu kien de PS01 van chay duoc khi IE chua restore.
do $do$ begin
  if to_regclass('public.income_expenses') is not null then
    drop trigger if exists a75_ie_cancel_close_request on public.income_expenses;
    execute $t$CREATE TRIGGER a75_ie_cancel_close_request AFTER UPDATE OF approval_status ON public.income_expenses FOR EACH ROW WHEN (((new.approval_status = 'CANCELLED'::text) AND (old.approval_status IS DISTINCT FROM 'CANCELLED'::text))) EXECUTE FUNCTION app_private.ie_cancel_close_request_v1()$t$;
  else
    raise notice 'BO QUA trigger a75_ie_cancel_close_request: chua co bang public.income_expenses';
  end if;
end $do$;


-- =====================================================================
-- [7] POLICY (8) -- doc theo org cua minh; MOI ghi di qua RPC
--     SECURITY DEFINER, khong co policy INSERT/UPDATE/DELETE nao.
-- =====================================================================

drop policy if exists approval_decisions_select_member on public.approval_decisions;
create policy approval_decisions_select_member on public.approval_decisions
  as permissive
  for select
  to authenticated
  using ((is_super_admin() OR (organization_id IN ( SELECT unnest(my_org_ids()) AS unnest))));

drop policy if exists approval_request_step_candidates_select_member on public.approval_request_step_candidates;
create policy approval_request_step_candidates_select_member on public.approval_request_step_candidates
  as permissive
  for select
  to authenticated
  using ((is_super_admin() OR (organization_id IN ( SELECT unnest(my_org_ids()) AS unnest))));

drop policy if exists approval_request_steps_select_member on public.approval_request_steps;
create policy approval_request_steps_select_member on public.approval_request_steps
  as permissive
  for select
  to authenticated
  using ((is_super_admin() OR (organization_id IN ( SELECT unnest(my_org_ids()) AS unnest))));

drop policy if exists approval_requests_select_member on public.approval_requests;
create policy approval_requests_select_member on public.approval_requests
  as permissive
  for select
  to authenticated
  using ((is_super_admin() OR (organization_id IN ( SELECT unnest(my_org_ids()) AS unnest))));

drop policy if exists approval_rule_sets_select_member on public.approval_rule_sets;
create policy approval_rule_sets_select_member on public.approval_rule_sets
  as permissive
  for select
  to authenticated
  using ((is_super_admin() OR (organization_id IN ( SELECT unnest(my_org_ids()) AS unnest))));

drop policy if exists approval_rule_steps_select_member on public.approval_rule_steps;
create policy approval_rule_steps_select_member on public.approval_rule_steps
  as permissive
  for select
  to authenticated
  using ((is_super_admin() OR (organization_id IN ( SELECT unnest(my_org_ids()) AS unnest))));

drop policy if exists approval_rules_select_member on public.approval_rules;
create policy approval_rules_select_member on public.approval_rules
  as permissive
  for select
  to authenticated
  using ((is_super_admin() OR (organization_id IN ( SELECT unnest(my_org_ids()) AS unnest))));

drop policy if exists approval_step_approvers_select_member on public.approval_step_approvers;
create policy approval_step_approvers_select_member on public.approval_step_approvers
  as permissive
  for select
  to authenticated
  using ((is_super_admin() OR (organization_id IN ( SELECT unnest(my_org_ids()) AS unnest))));


-- =====================================================================
-- [8] GRANT / REVOKE -- dung lai tu relacl / proacl / nspacl THUC TE
-- =====================================================================

-- Schema: nspacl = postgres=UC/postgres | ie_canonical_writer=U/postgres
revoke all on schema app_private from public;
revoke all on schema app_private from anon, authenticated, service_role;
do $do$ begin
  if exists (select 1 from pg_roles where rolname = 'ie_canonical_writer') then
    grant usage on schema app_private to ie_canonical_writer;
  else
    raise notice 'BO QUA grant schema: chua co role ie_canonical_writer';
  end if;
end $do$;

-- Bang public.approval_*: relacl = postgres(owner) | service_role=ALL
--                         | authenticated=SELECT  (anon: khong co gi)
revoke all on table public.approval_rule_sets from public, anon;
grant all on table public.approval_rule_sets to service_role;
grant select on table public.approval_rule_sets to authenticated;
revoke all on table public.approval_rules from public, anon;
grant all on table public.approval_rules to service_role;
grant select on table public.approval_rules to authenticated;
revoke all on table public.approval_rule_steps from public, anon;
grant all on table public.approval_rule_steps to service_role;
grant select on table public.approval_rule_steps to authenticated;
revoke all on table public.approval_step_approvers from public, anon;
grant all on table public.approval_step_approvers to service_role;
grant select on table public.approval_step_approvers to authenticated;
revoke all on table public.approval_requests from public, anon;
grant all on table public.approval_requests to service_role;
grant select on table public.approval_requests to authenticated;
revoke all on table public.approval_request_steps from public, anon;
grant all on table public.approval_request_steps to service_role;
grant select on table public.approval_request_steps to authenticated;
revoke all on table public.approval_request_step_candidates from public, anon;
grant all on table public.approval_request_step_candidates to service_role;
grant select on table public.approval_request_step_candidates to authenticated;
revoke all on table public.approval_decisions from public, anon;
grant all on table public.approval_decisions to service_role;
grant select on table public.approval_decisions to authenticated;

-- Bang app_private.*: relacl chi co owner -> khong role nao khac cham duoc
revoke all on table app_private.emergency_override_events from public;
revoke all on table app_private.emergency_override_events from anon, authenticated, service_role;
revoke all on table app_private.ie_transition_authorization from public;
revoke all on table app_private.ie_transition_authorization from anon, authenticated, service_role;

-- Ham engine: proacl = postgres=X/postgres -> CHI owner EXECUTE.
-- Client goi qua RPC public.* SECURITY DEFINER, khong goi thang app_private.
revoke all on function app_private.assert_no_engine_request_v1(p_voucher_id uuid) from public;
revoke all on function app_private.assert_no_engine_request_v1(p_voucher_id uuid) from anon, authenticated, service_role;
revoke all on function app_private.authorize_tenant_action_v3(p_actor uuid, p_organization_id uuid, p_permission_key text, p_building_id uuid, p_cashbook_id uuid) from public;
revoke all on function app_private.authorize_tenant_action_v3(p_actor uuid, p_organization_id uuid, p_permission_key text, p_building_id uuid, p_cashbook_id uuid) from anon, authenticated, service_role;
revoke all on function app_private.decide_financial_request_v1(p_request_id uuid, p_expected_version bigint, p_actor_membership uuid, p_actor_user uuid, p_decision text, p_reason text) from public;
revoke all on function app_private.decide_financial_request_v1(p_request_id uuid, p_expected_version bigint, p_actor_membership uuid, p_actor_user uuid, p_decision text, p_reason text) from anon, authenticated, service_role;
revoke all on function app_private.emergency_approve_financial_v1(p_request_id uuid, p_expected_version bigint, p_actor_membership uuid, p_actor_user uuid, p_reason text, p_reauth_fresh boolean) from public;
revoke all on function app_private.emergency_approve_financial_v1(p_request_id uuid, p_expected_version bigint, p_actor_membership uuid, p_actor_user uuid, p_reason text, p_reauth_fresh boolean) from anon, authenticated, service_role;
revoke all on function app_private.guard_emergency_events_immutable() from public;
revoke all on function app_private.guard_emergency_events_immutable() from anon, authenticated, service_role;
revoke all on function app_private.guard_published_rule_set() from public;
revoke all on function app_private.guard_published_rule_set() from anon, authenticated, service_role;
-- app_private.ie_cancel_close_request_v1(): proacl IS NULL tren prod (mac dinh PUBLIC EXECUTE).
-- La trigger function, chi trigger a75 goi. GIU NGUYEN -- khong REVOKE.
revoke all on function app_private.ie_transaction_domain_v1() from public;
revoke all on function app_private.ie_transaction_domain_v1() from anon, authenticated, service_role;
revoke all on function app_private.is_eligible_current_candidate_v1(p_request_step_id uuid, p_actor_membership uuid) from public;
revoke all on function app_private.is_eligible_current_candidate_v1(p_request_step_id uuid, p_actor_membership uuid) from anon, authenticated, service_role;
revoke all on function app_private.is_income_expense_flow_owned(p_id uuid) from public;
revoke all on function app_private.is_income_expense_flow_owned(p_id uuid) from anon, authenticated, service_role;
revoke all on function app_private.lock_org_for_decision_v1(p_organization_id uuid) from public;
revoke all on function app_private.lock_org_for_decision_v1(p_organization_id uuid) from anon, authenticated, service_role;
revoke all on function app_private.materialize_step_candidates_v1(p_request_step_id uuid) from public;
revoke all on function app_private.materialize_step_candidates_v1(p_request_step_id uuid) from anon, authenticated, service_role;
revoke all on function app_private.next_submission_no_v1(p_organization_id uuid, p_subject_type text, p_subject_id uuid) from public;
revoke all on function app_private.next_submission_no_v1(p_organization_id uuid, p_subject_type text, p_subject_id uuid) from anon, authenticated, service_role;
revoke all on function app_private.post_financial_request_v1(p_request_id uuid, p_expected_version bigint, p_actor uuid) from public;
revoke all on function app_private.post_financial_request_v1(p_request_id uuid, p_expected_version bigint, p_actor uuid) from anon, authenticated, service_role;
revoke all on function app_private.publish_rule_set_v1(p_rule_set_id uuid, p_actor uuid) from public;
revoke all on function app_private.publish_rule_set_v1(p_rule_set_id uuid, p_actor uuid) from anon, authenticated, service_role;
revoke all on function app_private.raise_malformed_override(p_organization_id uuid, p_permission_key text) from public;
revoke all on function app_private.raise_malformed_override(p_organization_id uuid, p_permission_key text) from anon, authenticated, service_role;
revoke all on function app_private.resolve_active_rule_set_v1(p_organization_id uuid, p_transaction_domain text) from public;
revoke all on function app_private.resolve_active_rule_set_v1(p_organization_id uuid, p_transaction_domain text) from anon, authenticated, service_role;
revoke all on function app_private.reverse_financial_request_v1(p_original_request_id uuid, p_actor_membership uuid, p_actor_user uuid, p_reason text) from public;
revoke all on function app_private.reverse_financial_request_v1(p_original_request_id uuid, p_actor_membership uuid, p_actor_user uuid, p_reason text) from anon, authenticated, service_role;
revoke all on function app_private.self_approve_within_limit_v1(p_request_id uuid, p_expected_version bigint, p_actor_membership uuid, p_actor_user uuid) from public;
revoke all on function app_private.self_approve_within_limit_v1(p_request_id uuid, p_expected_version bigint, p_actor_membership uuid, p_actor_user uuid) from anon, authenticated, service_role;
revoke all on function app_private.step_is_satisfied_v1(p_request_step_id uuid) from public;
revoke all on function app_private.step_is_satisfied_v1(p_request_step_id uuid) from anon, authenticated, service_role;
revoke all on function app_private.submit_financial_request_v1(p_subject_id uuid, p_actor_membership uuid, p_actor_user uuid, p_idempotency_key text) from public;
revoke all on function app_private.submit_financial_request_v1(p_subject_id uuid, p_actor_membership uuid, p_actor_user uuid, p_idempotency_key text) from anon, authenticated, service_role;
revoke all on function app_private.transition_canonical_income_expense_v1(p_income_expense_id uuid, p_new_approval_status text, p_posting_id uuid, p_reversed_by_posting_id uuid) from public;
revoke all on function app_private.transition_canonical_income_expense_v1(p_income_expense_id uuid, p_new_approval_status text, p_posting_id uuid, p_reversed_by_posting_id uuid) from anon, authenticated, service_role;

commit;

-- KIEM TRA SAU KHI CHAY:
--   select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
--    where n.nspname = 'app_private'
--      and p.proname in ('submit_financial_request_v1', ...);   -- ky vong 22
--   node scripts/check-view-invoker.mjs   -- khong view nao ho security_invoker
