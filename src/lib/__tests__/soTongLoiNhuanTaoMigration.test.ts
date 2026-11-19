import { readFileSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { isCanonicalFallbackSignal } from "@/lib/canonicalFallback";

/**
 * Migration 20261115084108 (M2-tạo của sổ tổng lợi nhuận cổ đông): E4 xem trước chi, E5 lập phiếu chi theo sổ
 * tổng, E8/E9 mốc "đã trả đủ đến hết tháng X", E11 lương điều hành (thay thân), F4 chốt phạm vi phiếu chi lợi
 * nhuận (thay thân), D1.8 đóng cửa lập tay.
 *
 * Chạy THẬT trên PostgreSQL nhúng:
 *  - hàm quyền / khoá / công tắc / sổ quỹ là ĐỊNH NGHĨA ĐANG CHẠY trước M1 (file migration sau mốc baseline, không
 *    có thì supabase/baseline/schema.sql): authorize_tenant_action_v3, authorized_scope_v3, profit_viewer_can_v1,
 *    lock_org_for_decision_v1, assert_cashbook_access_v2, evaluate_feature_route, claim_feature_operation_v1, …;
 *  - ba thân bị thay lấy từ bản đã phát hành và đo md5 = production; đo hành vi CŨ trước khi chạy migration;
 *  - M1 rồi migration này chạy HAI lượt; một instance riêng dán thân hai lần trong MỘT giao dịch như lane;
 *  - engine duyệt (submit_financial_request_v1) là bản giả có chế độ: REQUIRE_APPROVAL (mặc định), DENY,
 *    AUTO_POST (hạng mục bắt buộc duyệt thì thành REQUIRE_APPROVAL như engine thật), AUTO_POST_HONG (engine hỏng).
 * Ca hai phiên, engine duyệt thật và JWT thật chạy trên TEST (thư mục hồ sơ, tao_test_thu.sql).
 * Ca có tên mở đầu "[ghim]" chỉ đo md5 / dấu vân tay — script đột biến cần ít nhất một ca KHÁC đỏ.
 */
const DIR = "supabase/migrations";
const FILE = `${DIR}/20261115084108_so_tong_loi_nhuan_tao.sql`;
const FILE_M1 = `${DIR}/20261115063149_so_tong_loi_nhuan_nen.sql`;
const FILE_IE_COMPAT_CU = `${DIR}/20261030100148_khoa_cot_hoa_hong_ie_compat.sql`;
const BASELINE = "supabase/baseline/schema.sql";
/** Hàm "đang chạy trước M1": file migration sau mốc baseline (20260805120000) và trước M1; không có thì baseline. */
const MOC_BASELINE = "20260805120000";
const MOC_M1 = "20261115063149";
const MD5_CU = { e11: "44af93a19bba496769bbc608f07976da", f4: "6d949fed2a66e52bb49ee490146e1a85", ie: "7c73daff8de8848a8802bb548a6c7e87" };
// md5 thân do migration ghi — migration ghim các giá trị này cho lượt chạy lại; sửa thân thì phải sửa cả hai nơi.
const MD5_MOI = { e11: "7b364f53ecc3c11d6baeecfc638e270c", f4: "e6f0764b2b9d4c8de8bf73c2331a4fbb", ie: "342adaf725191f931739db5ef8c54620" };

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const mem = (user: string) => user.replace("4000-8000-0000000000", "4000-8000-1000000000");
const [ORG_A, ORG_B] = [1, 2].map(id);
const [CHU, CHU2, TAM_UNG, KHONG_QUYEN, NGOAI, SUPER, TAM_UNG_GO, CHI_LUONG] = [11, 12, 13, 14, 15, 16, 17, 18].map(id);
const [VAI_CHU_A, VAI_CHU_B, VAI_LUONG_A] = [31, 32, 33].map(id);
const [PHAM_VI_A, PHAM_VI_B] = [41, 42].map(id);
const [TOA_AO, TOA_1, TOA_AO_B] = [51, 52, 53].map(id);
const [SO_QUY, SO_GIU, SO_AO, SO_QUY_B, SO_QUY_2] = [54, 55, 56, 57, 58].map(id);
const [CD1, CD_TU, CD_NGHI, CD_XOA, CD_B] = [61, 62, 63, 64, 65].map(id);
const [QL1, QL_XOA, QL_B] = [71, 72, 73].map(id);
const [PM_07, PM_08, PM_AO_05, PM_B] = [81, 82, 83, 84].map(id);
const [LOAI_CLN_A, LOAI_LDH_A, LOAI_VP_A, LOAI_CLN_B, LOAI_LDH_B] = [91, 92, 93, 94, 95].map(id);
const CO = "shareholder_profit.ledger_payout.v1";
/** Số dư gốc: CD1 = 100 + 50; CD_TU = 40 − 10 (dòng âm); QL1 = 30 + 20. */
const CD1_GOC = 150;
const CD_TU_GOC = 30;
const QL1_GOC = 50;

const md5 = (s: string) => createHash("md5").update(s.replace(/\r/g, ""), "utf8").digest("hex");
/** Cắt nguyên câu CREATE FUNCTION <tên> (tới hết dollar-quote đóng + dấu ;). */
function cauLenhTaoHam(sql: string, ten: string): string {
  const mo = new RegExp(`CREATE\\s+(?:OR\\s+REPLACE\\s+)?FUNCTION\\s+${ten.replace(".", "\\.")}\\s*\\(`, "i").exec(sql);
  if (!mo) throw new Error(`Không thấy câu tạo hàm ${ten}`);
  const sau = sql.slice(mo.index);
  const the = /\bAS\s+(\$[a-z_]*\$)/i.exec(sau);
  if (!the) throw new Error(`Không thấy dollar-quote của ${ten}`);
  const dong = sau.indexOf(the[1], the.index + the[0].length);
  return sau.slice(0, sau.indexOf(";", dong) + 1);
}
/** prosrc của câu tạo hàm (phần giữa hai dấu dollar-quote). */
function thanHam(sql: string, ten: string): string {
  const cau = cauLenhTaoHam(sql, ten);
  const the = /\bAS\s+(\$[a-z_]*\$)/i.exec(cau)!;
  const batDau = the.index + the[0].length;
  return cau.slice(batDau, cau.indexOf(the[1], batDau)).replace(/\r/g, "");
}
const BASE_SQL = readFileSync(BASELINE, "utf8");
function dinhNghiaTruocM1(ten: string): string {
  const re = new RegExp(`CREATE\\s+(?:OR\\s+REPLACE\\s+)?FUNCTION\\s+${ten.replace(".", "\\.")}\\s*\\(`, "i");
  let hit: string | null = null;
  for (const f of readdirSync(DIR).filter((x) => x.endsWith(".sql") && x > MOC_BASELINE && x < MOC_M1).sort()) {
    const sql = readFileSync(`${DIR}/${f}`, "utf8");
    if (re.test(sql)) hit = sql;
  }
  return cauLenhTaoHam(hit ?? BASE_SQL, ten);
}

const HAM_SONG = [
  "app_private.authorized_scope_v3", "app_private.profit_viewer_can_v1", "app_private.raise_malformed_override",
  "app_private.authorize_tenant_action_v3", "app_private.lock_org_for_decision_v1", "app_private.finance_v2_has_covering_deny",
  "app_private.assert_cashbook_access_v2", "app_private.evaluate_feature_route", "app_private.claim_feature_operation_v1",
  "app_private.begin_accounting_chain_write_v1", "app_private.end_accounting_chain_write_v1", "app_private.profit_month_locked_v1",
  "app_private.cashbook_closed_through_v1", "app_private.ie_compat_actor_v2", "app_private.ie_normalize_lifecycle_columns",
  "public.auto_calc_item_amount", "public.auto_recalc_total_amount", "public.set_ie_item_accounting_class",
].map((t) => dinhNghiaTruocM1(t));
const E11_CU = cauLenhTaoHam(BASE_SQL, "public.manager_salary_payout_v1");
const F4_CU = cauLenhTaoHam(BASE_SQL, "app_private.guard_profit_payout_scope_compat_v1");
const IE_CU = cauLenhTaoHam(readFileSync(FILE_IE_COMPAT_CU, "utf8"), "public.ie_compat_insert_v2");
const COMPAT_CU = dinhNghiaTruocM1("public.create_profit_payout_compat_v1");
const M1 = readFileSync(FILE_M1, "utf8");
const MIGRATION = readFileSync(FILE, "utf8");

// Bảng nền: đúng cột / ràng buộc mà M1, migration này và các hàm thật ở trên đụng tới (đối chiếu baseline + production).
const NEN = `
  CREATE ROLE authenticated; CREATE ROLE anon; CREATE ROLE service_role;
  CREATE SCHEMA auth; CREATE SCHEMA app_private;
  GRANT USAGE ON SCHEMA public, auth TO authenticated, anon, service_role;
  CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
  CREATE TABLE public.super_admins(user_id uuid PRIMARY KEY);
  CREATE FUNCTION public.is_super_admin() RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER AS $$ SELECT EXISTS(SELECT 1 FROM public.super_admins WHERE user_id = auth.uid()) $$;
  CREATE TABLE public.organizations(id uuid PRIMARY KEY, status text NOT NULL DEFAULT 'ACTIVE', authorization_version bigint NOT NULL DEFAULT 1);
  CREATE TABLE public.permission_definitions(
    key text PRIMARY KEY, resource text NOT NULL, action text NOT NULL,
    sensitivity text NOT NULL CHECK (sensitivity IN ('VIEW','MANAGE','ELEVATED','PLATFORM')),
    permission_domain text NOT NULL DEFAULT 'TENANT', scope_kinds text[] NOT NULL DEFAULT ARRAY['ORGANIZATION'],
    is_active boolean NOT NULL DEFAULT true, scope_match_mode text NOT NULL DEFAULT 'ANY_MATCH',
    requires_cashbook_possession boolean NOT NULL DEFAULT false, accepted_possession_kinds text[] NOT NULL DEFAULT ARRAY[]::text[],
    required_dimensions text[] NOT NULL DEFAULT ARRAY[]::text[], UNIQUE (resource, action));
  CREATE TABLE public.organization_memberships(id uuid PRIMARY KEY, user_id uuid NOT NULL, organization_id uuid NOT NULL,
    status text NOT NULL DEFAULT 'ACTIVE', revoked_at timestamptz, valid_from timestamptz NOT NULL DEFAULT '2020-01-01', valid_to timestamptz);
  CREATE TABLE app_private.tenant_emergency_denies(organization_id uuid, permission_key text, active_from timestamptz, expires_at timestamptz);
  CREATE TABLE public.member_permission_overrides(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid, membership_id uuid,
    permission_key text, effect text, scope_mode text NOT NULL DEFAULT 'ORGANIZATION', revoked_at timestamptz, expires_at timestamptz);
  CREATE TABLE public.member_override_scopes(organization_id uuid, override_id uuid, scope_id uuid);
  CREATE TABLE public.authorization_scopes(id uuid PRIMARY KEY, organization_id uuid, scope_type text, building_id uuid, cashbook_id uuid, area_id uuid);
  CREATE TABLE public.organization_roles(id uuid PRIMARY KEY, organization_id uuid NOT NULL, name text NOT NULL, is_system boolean NOT NULL DEFAULT false,
    system_key text, status text NOT NULL DEFAULT 'ACTIVE', UNIQUE (organization_id, id));
  CREATE TABLE public.role_permissions(organization_id uuid NOT NULL, role_id uuid NOT NULL,
    permission_key text NOT NULL REFERENCES public.permission_definitions(key), effect text NOT NULL DEFAULT 'ALLOW',
    PRIMARY KEY (organization_id, role_id, permission_key));
  CREATE TABLE public.role_bindings(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid, membership_id uuid, role_id uuid, valid_from timestamptz, valid_to timestamptz);
  CREATE TABLE public.role_binding_scopes(organization_id uuid, role_binding_id uuid, scope_id uuid);
  CREATE TABLE public.area_buildings(organization_id uuid, area_id uuid, building_id uuid);
  CREATE TABLE public.cashbook_possession_bindings(organization_id uuid, membership_id uuid, cashbook_id uuid, possession_kind text,
    valid_from timestamptz NOT NULL DEFAULT '2020-01-01', valid_to timestamptz);
  CREATE TABLE public.buildings(id uuid PRIMARY KEY, organization_id uuid NOT NULL, user_id uuid NOT NULL, name text NOT NULL DEFAULT 'Toà',
    is_virtual boolean NOT NULL DEFAULT false, deleted_at timestamptz, created_at timestamptz NOT NULL DEFAULT now());
  CREATE TABLE public.accounts(id uuid PRIMARY KEY, organization_id uuid NOT NULL, name text NOT NULL DEFAULT 'Sổ quỹ',
    is_virtual boolean NOT NULL DEFAULT false, lock_date date, deleted_at timestamptz);
  CREATE TABLE public.profiles(id uuid PRIMARY KEY, full_name text, email text);
  CREATE TABLE app_private.server_feature_flags(feature_key text PRIMARY KEY, domain text NOT NULL,
    risk_class text NOT NULL DEFAULT 'MONEY', mode text NOT NULL DEFAULT 'OFF' CHECK (mode IN ('OFF','SHADOW','CANARY','ON')),
    force_freeze boolean NOT NULL DEFAULT false, config_version bigint NOT NULL DEFAULT 1, starts_at timestamptz, ends_at timestamptz,
    max_operation_count integer, max_single_amount_vnd numeric(15,2), max_total_amount_vnd numeric(15,2),
    commit_sha text, migration_sha256 text, maintenance_window_id text, approval_reference text,
    reason text, updated_by uuid, updated_at timestamptz NOT NULL DEFAULT now());
  CREATE TABLE app_private.server_feature_flag_canary_orgs(feature_key text NOT NULL, organization_id uuid NOT NULL);
  CREATE TABLE app_private.server_feature_flag_operations(id bigserial PRIMARY KEY, feature_key text NOT NULL, config_version bigint NOT NULL,
    operation_key text NOT NULL, organization_id uuid NOT NULL, amount_vnd numeric(15,2) NOT NULL DEFAULT 0);
  -- "Hôm nay" của công ty: test tự đặt qua test.today.
  CREATE FUNCTION public.org_today_v1(p_organization_id uuid DEFAULT NULL) RETURNS date LANGUAGE sql STABLE
    AS $$ SELECT COALESCE(nullif(current_setting('test.today', true), '')::date, DATE '2026-11-15') $$;
  CREATE TABLE public.shareholders(id uuid PRIMARY KEY, organization_id uuid NOT NULL REFERENCES public.organizations(id), user_id uuid,
    auth_user_id uuid, name text NOT NULL, is_active boolean NOT NULL DEFAULT true, deleted_at timestamptz);
  CREATE UNIQUE INDEX shareholders_id_org_uq ON public.shareholders (id, organization_id);
  CREATE TABLE public.profit_managers(id uuid PRIMARY KEY, organization_id uuid NOT NULL REFERENCES public.organizations(id), user_id uuid,
    auth_user_id uuid, name text NOT NULL, is_active boolean NOT NULL DEFAULT true, deleted_at timestamptz);
  CREATE TABLE public.profit_monthly(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL, building_id uuid NOT NULL,
    period_month date NOT NULL, status text NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT','LOCKED')), is_stale boolean NOT NULL DEFAULT false,
    locked_at timestamptz, UNIQUE (building_id, period_month));
  CREATE TABLE public.profit_allocations(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    profit_monthly_id uuid NOT NULL REFERENCES public.profit_monthly(id) ON DELETE CASCADE,
    shareholder_id uuid NOT NULL REFERENCES public.shareholders(id) ON DELETE CASCADE,
    amount numeric(15,2) NOT NULL DEFAULT 0, organization_id uuid, UNIQUE (profit_monthly_id, shareholder_id));
  CREATE TABLE public.profit_manager_allocations(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    profit_monthly_id uuid NOT NULL REFERENCES public.profit_monthly(id) ON DELETE CASCADE,
    manager_id uuid NOT NULL REFERENCES public.profit_managers(id) ON DELETE CASCADE,
    amount numeric(15,2) NOT NULL DEFAULT 0, organization_id uuid, UNIQUE (profit_monthly_id, manager_id));
  CREATE TABLE public.income_expense_types(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name text NOT NULL,
    type text NOT NULL CHECK (type IN ('income','expense')), description text, is_default boolean DEFAULT false, user_id uuid NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), category text,
    is_deposit boolean NOT NULL DEFAULT false, is_restricted boolean NOT NULL DEFAULT false, hide_in_report boolean NOT NULL DEFAULT false,
    organization_id uuid NOT NULL, force_approval boolean NOT NULL DEFAULT false, system_only boolean NOT NULL DEFAULT false,
    rule_key text CHECK (rule_key IS NULL OR rule_key ~ '^[a-z0-9_]{2,40}$'), manual_hidden boolean NOT NULL DEFAULT false,
    quick_entry_hidden boolean NOT NULL DEFAULT false, internal_transfer boolean NOT NULL DEFAULT false);
  CREATE UNIQUE INDEX income_expense_types_org_rule_key_uq ON public.income_expense_types (organization_id, rule_key) WHERE rule_key IS NOT NULL;
  CREATE TABLE public.income_expenses(
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL, code text, type text NOT NULL CHECK (type IN ('INCOME','EXPENSE')),
    name text NOT NULL CHECK (char_length(name) > 0), building_id uuid NOT NULL, room_id uuid, tenant_id uuid, voucher_date date NOT NULL,
    total_amount numeric(15,2) NOT NULL DEFAULT 0 CHECK (total_amount >= 0),
    approval_status text NOT NULL DEFAULT 'APPROVED' CHECK (approval_status IN ('UNAPPROVED','APPROVED','CANCELLED')),
    approved_by uuid, approved_at timestamptz, notes text, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
    deleted_at timestamptz, payer_name text, account_id uuid, contract_id uuid, attachments jsonb NOT NULL DEFAULT '[]'::jsonb,
    business_result_accounting boolean, receive_bank_name text, receive_bank_account text, creator_name text, invoice_id uuid,
    repeat_cycle text DEFAULT 'NONE', repeat_infinity boolean NOT NULL DEFAULT false, repeat_count integer NOT NULL DEFAULT 0,
    repeat_remaining integer NOT NULL DEFAULT 0, repeat_next_date date, repeat_parent_id uuid, payment_id uuid,
    change_amount numeric(15,2) NOT NULL DEFAULT 0, change_account_id uuid, rounding_amount numeric(15,2) DEFAULT 0, rounding_account_id uuid,
    verified_at timestamptz, verified_by uuid, verified_by_name text, verified_note text, counts_in_business_result boolean NOT NULL DEFAULT true,
    shareholder_id uuid REFERENCES public.shareholders(id) ON DELETE SET NULL, handover_id uuid, has_restricted_item boolean NOT NULL DEFAULT false,
    handover_transfer_id uuid, salary_staff_id uuid, salary_role text, profit_manager_id uuid REFERENCES public.profit_managers(id) ON DELETE SET NULL,
    kqkd_amount numeric(15,2) NOT NULL DEFAULT 0, system_source text, utility_account_id uuid, commission_kind text,
    commission_legacy_dup boolean NOT NULL DEFAULT false, repeat_auto_approve boolean NOT NULL DEFAULT true, organization_id uuid NOT NULL,
    approval_request_id uuid, posting_id uuid, posted_at_v2 timestamptz, correlation_id uuid, idempotency_key text, reversed_by_posting_id uuid,
    source_payload_hash text, payment_collection_id uuid, reversal_of_income_expense_id uuid,
    posting_mode text CHECK (posting_mode IS NULL OR posting_mode IN ('CASHBOOK','NON_CASH')),
    posting_status text CHECK (posting_status IS NULL OR posting_status IN ('UNPOSTED','POSTED','REVERSED','NOT_APPLICABLE')),
    active_posting_id_v2 uuid, recognition_date date, recognition_source_mode text, review_state text, review_owner_membership_id uuid,
    review_reason text, review_deadline timestamptz, change_field_mask jsonb, review_version bigint NOT NULL DEFAULT 1,
    approval_version bigint NOT NULL DEFAULT 1, posting_version bigint NOT NULL DEFAULT 1, cancellation_kind text,
    maker_user_id uuid, maker_membership_id uuid, birth_operation_id uuid, birth_txid xid8,
    CONSTRAINT ie_unapproved_review_state_ck CHECK (deleted_at IS NOT NULL OR approval_status IS DISTINCT FROM 'UNAPPROVED'
      OR review_state IN ('PENDING','CHANGES_REQUESTED','DISPUTED')));
  CREATE TABLE public.income_expense_items(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    income_expense_id uuid NOT NULL REFERENCES public.income_expenses(id) ON DELETE CASCADE,
    income_expense_type_id uuid NOT NULL, description text, quantity numeric(15,4) NOT NULL DEFAULT 1 CHECK (quantity > 0),
    unit_price numeric(15,2) NOT NULL DEFAULT 0 CHECK (unit_price >= 0), amount numeric(15,2), notes text,
    created_at timestamptz NOT NULL DEFAULT now(), start_date date, end_date date, organization_id uuid,
    accounting_class text NOT NULL CHECK (accounting_class IN ('PNL','DEPOSIT','CUSTOMER_CREDIT','INTERNAL')));
  CREATE TABLE public.approval_requests(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL,
    submission_no integer NOT NULL DEFAULT 1, subject_type text NOT NULL, subject_id uuid NOT NULL,
    state text NOT NULL CHECK (state IN ('PENDING_APPROVAL','POSTED','DENIED','REJECTED','CANCELLED','REVERSED','APPROVED','WITHDRAWN','CHANGES_REQUESTED','DISPUTED')),
    maker_membership_id uuid, maker_user_id uuid, rule_effect text, payload_hash text, amount numeric(18,2), cashbook_id uuid,
    building_id uuid, system_source text, version bigint NOT NULL DEFAULT 1,
    UNIQUE (organization_id, subject_type, subject_id, submission_no));
  CREATE UNIQUE INDEX approval_requests_one_open ON public.approval_requests (organization_id, subject_type, subject_id) WHERE state = 'PENDING_APPROVAL';
  CREATE TABLE public.profit_payout_reservations(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid, payout_voucher_id uuid,
    shareholder_id uuid, amount numeric(15,2));
  CREATE TABLE app_private.canonical_write_operations(organization_id uuid NOT NULL, operation text NOT NULL, subject_scope text NOT NULL,
    actor_id uuid NOT NULL, idempotency_key text NOT NULL, payload_hash text NOT NULL, subject_id uuid, response_payload jsonb,
    created_at timestamptz NOT NULL DEFAULT now(), completed_at timestamptz, actor_membership_id uuid, transaction_id xid8,
    PRIMARY KEY (organization_id, operation, subject_scope, actor_id, idempotency_key),
    CHECK (((completed_at IS NULL) = (response_payload IS NULL)) AND ((completed_at IS NULL) = (subject_id IS NULL))),
    CHECK (idempotency_key ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{7,199}$'), CHECK (char_length(payload_hash) = 32));
  CREATE TABLE app_private.accounting_chain_writer_xids(transaction_id bigint NOT NULL, backend_pid integer NOT NULL,
    opened_at timestamptz NOT NULL DEFAULT clock_timestamp(), PRIMARY KEY (transaction_id, backend_pid));
  CREATE TABLE app_private.cashbook_closures(id bigserial PRIMARY KEY, organization_id uuid, cashbook_id uuid NOT NULL, closed_through date NOT NULL);
  CREATE TABLE app_private.cashbook_reopenings(id bigserial PRIMARY KEY, cashbook_id uuid NOT NULL, last_closure_id bigint);
  CREATE TABLE app_private.finance_v2_semantic_event_log(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid, event_kind text NOT NULL,
    source_table text, source_id uuid, source_kind text NOT NULL, actor uuid, txid xid8, created_at timestamptz NOT NULL DEFAULT now());
  -- Engine duyệt giả: chép hành vi của submit_financial_request_v1 thật ở phần sổ tổng cần (một yêu cầu mở mỗi phiếu,
  -- hạng mục bắt buộc duyệt không AUTO_POST, DENY trả id mà không raise).
  CREATE TABLE public.test_submit_calls(subject_id uuid, actor_membership uuid, actor_user uuid, idem text);
  CREATE FUNCTION app_private.submit_financial_request_v1(p_subject_id uuid, p_actor_membership uuid, p_actor_user uuid, p_idempotency_key text)
  RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'pg_catalog', 'app_private', 'public' AS $$
  DECLARE
    v_ie public.income_expenses; v_che_do text := COALESCE(nullif(current_setting('test.submit', true), ''), 'REQUIRE_APPROVAL');
    v_bat_buoc boolean; v_hieu_luc text; v_yc uuid; v_lan int;
  BEGIN
    SELECT * INTO v_ie FROM public.income_expenses WHERE id = p_subject_id AND deleted_at IS NULL FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'subject not found' USING ERRCODE = 'P0002'; END IF;
    INSERT INTO public.test_submit_calls VALUES (p_subject_id, p_actor_membership, p_actor_user, p_idempotency_key);
    SELECT id INTO v_yc FROM public.approval_requests WHERE organization_id = v_ie.organization_id AND subject_type = 'FINANCIAL_VOUCHER'
      AND subject_id = p_subject_id AND state = 'PENDING_APPROVAL';
    IF v_yc IS NOT NULL THEN RETURN v_yc; END IF;
    SELECT COALESCE(bool_or(t.force_approval), false) INTO v_bat_buoc FROM public.income_expense_items i
      JOIN public.income_expense_types t ON t.id = i.income_expense_type_id WHERE i.income_expense_id = p_subject_id;
    v_hieu_luc := CASE v_che_do WHEN 'DENY' THEN 'DENY'
                    WHEN 'AUTO_POST' THEN CASE WHEN v_bat_buoc THEN 'REQUIRE_APPROVAL' ELSE 'AUTO_POST' END
                    WHEN 'AUTO_POST_HONG' THEN 'AUTO_POST' ELSE 'REQUIRE_APPROVAL' END;
    SELECT COALESCE(max(submission_no), 0) + 1 INTO v_lan FROM public.approval_requests
     WHERE organization_id = v_ie.organization_id AND subject_type = 'FINANCIAL_VOUCHER' AND subject_id = p_subject_id;
    INSERT INTO public.approval_requests(organization_id, submission_no, subject_type, subject_id, state, maker_membership_id, maker_user_id,
        rule_effect, payload_hash, amount, cashbook_id, building_id, system_source)
      VALUES (v_ie.organization_id, v_lan, 'FINANCIAL_VOUCHER', p_subject_id,
        CASE v_hieu_luc WHEN 'DENY' THEN 'DENIED' WHEN 'AUTO_POST' THEN 'APPROVED' ELSE 'PENDING_APPROVAL' END,
        p_actor_membership, p_actor_user, v_hieu_luc, COALESCE(v_ie.source_payload_hash, md5(p_subject_id::text)),
        v_ie.total_amount, v_ie.account_id, v_ie.building_id, v_ie.system_source)
      RETURNING id INTO v_yc;
    IF v_hieu_luc = 'AUTO_POST' THEN
      UPDATE public.income_expenses SET approval_status = 'APPROVED', approved_by = p_actor_user, approved_at = now(), review_state = 'RESOLVED'
       WHERE id = p_subject_id;
    END IF;
    RETURN v_yc;
  END $$;
`;

const TRIGGER_NEN = `
  CREATE TRIGGER a001_ie_lifecycle_normalize BEFORE INSERT ON public.income_expenses
    FOR EACH ROW EXECUTE FUNCTION app_private.ie_normalize_lifecycle_columns();
  CREATE TRIGGER a00_00_profit_payout_account_guard BEFORE INSERT OR UPDATE OF shareholder_id, profit_manager_id, account_id, organization_id, system_source
    ON public.income_expenses FOR EACH ROW EXECUTE FUNCTION app_private.guard_profit_payout_scope_compat_v1();
  CREATE TRIGGER set_ie_item_accounting_class BEFORE INSERT OR UPDATE OF income_expense_type_id, accounting_class ON public.income_expense_items
    FOR EACH ROW EXECUTE FUNCTION public.set_ie_item_accounting_class();
  CREATE TRIGGER trigger_auto_calc_item_amount BEFORE INSERT OR UPDATE ON public.income_expense_items
    FOR EACH ROW EXECUTE FUNCTION public.auto_calc_item_amount();
  CREATE TRIGGER trigger_auto_recalc_total_amount AFTER INSERT OR UPDATE OR DELETE ON public.income_expense_items
    FOR EACH ROW EXECUTE FUNCTION public.auto_recalc_total_amount();
  REVOKE ALL ON FUNCTION public.manager_salary_payout_v1(uuid, numeric, uuid, date, text, text) FROM PUBLIC;
  GRANT EXECUTE ON FUNCTION public.manager_salary_payout_v1(uuid, numeric, uuid, date, text, text) TO authenticated, service_role;
  REVOKE ALL ON FUNCTION public.ie_compat_insert_v2(jsonb, jsonb) FROM PUBLIC;
  GRANT EXECUTE ON FUNCTION public.ie_compat_insert_v2(jsonb, jsonb) TO authenticated;
  REVOKE ALL ON FUNCTION public.create_profit_payout_compat_v1(text, uuid, numeric, uuid, date, text, text) FROM PUBLIC;
  GRANT EXECUTE ON FUNCTION public.create_profit_payout_compat_v1(text, uuid, numeric, uuid, date, text, text) TO authenticated;
  REVOKE ALL ON FUNCTION app_private.guard_profit_payout_scope_compat_v1() FROM PUBLIC;
`;

function duLieu(): string {
  const tv: [string, string][] = [[CHU, ORG_A], [CHU2, ORG_A], [TAM_UNG, ORG_A], [KHONG_QUYEN, ORG_A], [TAM_UNG_GO, ORG_A],
    [CHI_LUONG, ORG_A], [NGOAI, ORG_B]];
  const ganVai: [string, string, string, string][] = [
    [ORG_A, CHU, VAI_CHU_A, PHAM_VI_A], [ORG_A, CHU2, VAI_CHU_A, PHAM_VI_A], [ORG_A, CHI_LUONG, VAI_LUONG_A, PHAM_VI_A],
    [ORG_B, NGOAI, VAI_CHU_B, PHAM_VI_B]];
  return `
    INSERT INTO public.organizations(id) VALUES ('${ORG_A}'),('${ORG_B}');
    INSERT INTO public.super_admins VALUES ('${SUPER}');
    INSERT INTO public.profiles(id, full_name) VALUES ('${CHU}','Chủ A'),('${TAM_UNG}','Người giữ sổ'),('${NGOAI}','Chủ B');
    INSERT INTO public.permission_definitions(key, resource, action, sensitivity) VALUES
      ('shareholder_profit.distribute','shareholder_profit','distribute','ELEVATED'),
      ('shareholder_profit.pay_manager','shareholder_profit','pay_manager','ELEVATED');
    INSERT INTO public.organization_memberships(id, user_id, organization_id) VALUES ${tv.map(([u, o]) => `('${mem(u)}','${u}','${o}')`).join(",")};
    INSERT INTO public.authorization_scopes(id, organization_id, scope_type) VALUES ('${PHAM_VI_A}','${ORG_A}','ORGANIZATION'),('${PHAM_VI_B}','${ORG_B}','ORGANIZATION');
    INSERT INTO public.organization_roles(id, organization_id, name, is_system, system_key) VALUES
      ('${VAI_CHU_A}','${ORG_A}','Chủ sở hữu tổ chức',true,'TENANT_OWNER'), ('${VAI_CHU_B}','${ORG_B}','Chủ công ty',true,'TENANT_OWNER'),
      ('${VAI_LUONG_A}','${ORG_A}','Kế toán lương điều hành',false,NULL);
    INSERT INTO public.role_permissions(organization_id, role_id, permission_key) VALUES
      ('${ORG_A}','${VAI_CHU_A}','shareholder_profit.distribute'), ('${ORG_A}','${VAI_CHU_A}','shareholder_profit.pay_manager'),
      ('${ORG_B}','${VAI_CHU_B}','shareholder_profit.distribute'), ('${ORG_B}','${VAI_CHU_B}','shareholder_profit.pay_manager'),
      ('${ORG_A}','${VAI_LUONG_A}','shareholder_profit.pay_manager');
    ${ganVai.map(([o, u, r, s], i) => `
      INSERT INTO public.role_bindings(id, organization_id, membership_id, role_id) VALUES ('${id(100 + i)}','${o}','${mem(u)}','${r}');
      INSERT INTO public.role_binding_scopes VALUES ('${o}','${id(100 + i)}','${s}');`).join("")}
    INSERT INTO public.buildings(id, organization_id, user_id, name, is_virtual) VALUES
      ('${TOA_AO}','${ORG_A}','${CHU}','Chung',true), ('${TOA_1}','${ORG_A}','${CHU}','Toà 1',false), ('${TOA_AO_B}','${ORG_B}','${NGOAI}','Chung B',true);
    INSERT INTO public.accounts(id, organization_id, name, is_virtual) VALUES
      ('${SO_QUY}','${ORG_A}','Tiền mặt',false), ('${SO_GIU}','${ORG_A}','Sổ người giữ',false), ('${SO_AO}','${ORG_A}','Sổ ảo',true),
      ('${SO_QUY_B}','${ORG_B}','Tiền mặt B',false), ('${SO_QUY_2}','${ORG_A}','Ngân hàng',false);
    INSERT INTO public.cashbook_possession_bindings(organization_id, membership_id, cashbook_id, possession_kind) VALUES
      ('${ORG_A}','${mem(TAM_UNG)}','${SO_GIU}','CUSTODIAN'), ('${ORG_A}','${mem(TAM_UNG_GO)}','${SO_GIU}','CUSTODIAN'),
      ('${ORG_A}','${mem(CHU)}','${SO_QUY}','CUSTODIAN'), ('${ORG_A}','${mem(TAM_UNG)}','${SO_QUY}','KNOWER');
    INSERT INTO public.shareholders(id, organization_id, auth_user_id, name, is_active, deleted_at) VALUES
      ('${CD1}','${ORG_A}',NULL,'Cổ đông 1',true,NULL), ('${CD_TU}','${ORG_A}','${TAM_UNG}','Cổ đông giữ sổ',true,NULL),
      ('${CD_NGHI}','${ORG_A}',NULL,'Cổ đông nghỉ',false,NULL), ('${CD_XOA}','${ORG_A}',NULL,'Cổ đông đã xoá',true, now()),
      ('${CD_B}','${ORG_B}',NULL,'Cổ đông B',true,NULL);
    INSERT INTO public.profit_managers(id, organization_id, auth_user_id, name, deleted_at) VALUES
      ('${QL1}','${ORG_A}','${CHI_LUONG}','Quản lý 1',NULL), ('${QL_XOA}','${ORG_A}',NULL,'Quản lý đã xoá', now()), ('${QL_B}','${ORG_B}',NULL,'Quản lý B',NULL);
    INSERT INTO public.profit_monthly(id, organization_id, building_id, period_month, status, locked_at) VALUES
      ('${PM_07}','${ORG_A}','${TOA_1}','2026-07-01','LOCKED', now()), ('${PM_08}','${ORG_A}','${TOA_1}','2026-08-01','LOCKED', now()),
      ('${PM_AO_05}','${ORG_A}','${TOA_AO}','2026-05-01','LOCKED', now()), ('${PM_B}','${ORG_B}','${TOA_AO_B}','2026-04-01','LOCKED', now());
    INSERT INTO public.profit_allocations(profit_monthly_id, shareholder_id, amount, organization_id) VALUES
      ('${PM_07}','${CD1}',100,'${ORG_A}'), ('${PM_08}','${CD1}',50,'${ORG_A}'), ('${PM_07}','${CD_TU}',40,'${ORG_A}'), ('${PM_08}','${CD_TU}',-10,'${ORG_A}'),
      ('${PM_B}','${CD_B}',300,'${ORG_B}');
    INSERT INTO public.profit_manager_allocations(profit_monthly_id, manager_id, amount, organization_id) VALUES
      ('${PM_07}','${QL1}',30,'${ORG_A}'), ('${PM_08}','${QL1}',20,'${ORG_A}');
    -- Hạng mục như production 15/11: chưa đóng cửa lập tay, cùng ở hai công ty.
    INSERT INTO public.income_expense_types(id, name, type, user_id, organization_id, category, is_restricted, force_approval, system_only,
        rule_key, manual_hidden, quick_entry_hidden, internal_transfer) VALUES
      ('${LOAI_CLN_A}','Chia lợi nhuận cổ đông','expense','${CHU}','${ORG_A}','Nhân sự – sale',true,true,false,'chia_loi_nhuan',false,true,true),
      ('${LOAI_LDH_A}','Lương điều hành','expense','${CHU}','${ORG_A}','Nhân sự – sale',true,true,false,'luong_dieu_hanh',false,true,false),
      ('${LOAI_VP_A}','Văn phòng','expense','${CHU}','${ORG_A}','Hành chính – pháp lý',false,false,false,'van_phong',false,false,false),
      ('${LOAI_CLN_B}','Chia lợi nhuận cổ đông','expense','${NGOAI}','${ORG_B}','Nhân sự – sale',true,true,false,'chia_loi_nhuan',false,true,true),
      ('${LOAI_LDH_B}','Lương điều hành','expense','${NGOAI}','${ORG_B}','Nhân sự – sale',true,true,false,'luong_dieu_hanh',false,true,false);
    INSERT INTO app_private.server_feature_flags(feature_key, domain, mode, commit_sha, migration_sha256, maintenance_window_id, approval_reference)
      VALUES ('shareholder_profit.pay_manager.v1','profit','ON','${"c".repeat(40)}','${"d".repeat(64)}','mw-cu','ref-cu');
  `;
}
/** Ngoại lệ trên khoá mới (sau M1): người giữ sổ được cấp quyền tạm ứng; một người khác đã bị thu hồi. */
const NGOAI_LE = `
  INSERT INTO public.member_permission_overrides(id, organization_id, membership_id, permission_key, effect, revoked_at) VALUES
    ('${id(201)}','${ORG_A}','${mem(TAM_UNG)}','shareholder_profit.advance_own_cashbook','ALLOW',NULL),
    ('${id(202)}','${ORG_A}','${mem(TAM_UNG_GO)}','shareholder_profit.advance_own_cashbook','ALLOW', now() - interval '1 day');
  INSERT INTO public.member_override_scopes VALUES ('${ORG_A}','${id(201)}','${PHAM_VI_A}'), ('${ORG_A}','${id(202)}','${PHAM_VI_A}');
`;

async function dungCoSo(d: PGlite, o: { thanE11?: string; thanF4?: string; thanIe?: string } = {}) {
  await d.exec(NEN);
  for (const f of HAM_SONG) await d.exec(f);
  await d.exec(o.thanE11 ?? E11_CU);
  await d.exec(o.thanF4 ?? F4_CU);
  await d.exec(o.thanIe ?? IE_CU);
  await d.exec(COMPAT_CU);
  await d.exec(TRIGGER_NEN);
  await d.exec(duLieu());
}

const db = new PGlite();
const truoc: Record<string, unknown> = {};
const ghi: Record<string, unknown> = {};

type Loi = { code: string; message: string; detail: string | null; hint: string | null };
async function trongGiaoDich<T>(fn: () => Promise<T>): Promise<T> {
  await db.exec("BEGIN");
  try { return await fn(); } finally { await db.exec("ROLLBACK"); }
}
const mot = async <T>(sql: string, params: unknown[] = []) => (await db.query<{ v: T }>(sql, params)).rows[0].v;
const tron = (x: unknown) => Math.round(Number(x) * 100) / 100 + 0;
/** Gọi một câu với auth.uid() = user, dưới vai authenticated (đo cả ACL); trả cột v. */
async function la<T>(user: string | null, sql: string): Promise<T> {
  await db.query("SELECT set_config('request.jwt.claim.sub', $1, true)", [user ?? ""]);
  await db.exec("SET LOCAL ROLE authenticated");
  try { return (await db.query<{ v: T }>(sql)).rows[0].v; } finally { await db.exec("RESET ROLE"); }
}
/** Như la() nhưng chờ lỗi: chạy trong SAVEPOINT, trả mã + câu + DETAIL (null nếu chạy được). */
async function loiLa(user: string | null, sql: string): Promise<Loi | null> {
  await db.query("SELECT set_config('request.jwt.claim.sub', $1, true)", [user ?? ""]);
  await db.exec("SAVEPOINT thu; SET LOCAL ROLE authenticated");
  try {
    await db.query(sql);
    await db.exec("RESET ROLE; RELEASE SAVEPOINT thu");
    return null;
  } catch (e) {
    await db.exec("ROLLBACK TO SAVEPOINT thu; RESET ROLE");
    const x = e as { code?: string; message?: string; detail?: string; hint?: string };
    return { code: x.code ?? "?", message: x.message ?? "", detail: x.detail ?? null, hint: x.hint ?? null };
  }
}
/** Câu (có thể nhiều lệnh) chạy dưới vai chủ bảng (không qua ACL), chờ lỗi. */
async function loiChu(sql: string): Promise<Loi | null> {
  await db.exec("SAVEPOINT thu");
  try { await db.exec(sql); await db.exec("RELEASE SAVEPOINT thu"); return null; } catch (e) {
    await db.exec("ROLLBACK TO SAVEPOINT thu");
    const x = e as { code?: string; message?: string; detail?: string; hint?: string };
    return { code: x.code ?? "?", message: x.message ?? "", detail: x.detail ?? null, hint: x.hint ?? null };
  }
}
type Route = "LEGACY" | "SHADOW" | "CANONICAL" | "FROZEN";
async function datRoute(r: Route) {
  const [mode, dong] = r === "LEGACY" ? ["OFF", false] : r === "SHADOW" ? ["SHADOW", false] : r === "CANONICAL" ? ["ON", false] : ["ON", true];
  await db.exec(`UPDATE app_private.server_feature_flags SET mode = '${mode}', force_freeze = ${dong}, commit_sha = '${"a".repeat(40)}',
    migration_sha256 = '${"b".repeat(64)}', maintenance_window_id = 'mw-test', approval_reference = 'ref-test' WHERE feature_key = '${CO}'`);
}
const q = (x: string | null | undefined) => (x === null || x === undefined ? "NULL" : `'${x}'`);
interface ChiE5 { cd?: string; tien: number | string; so?: string | null; ngay?: string | null; ghiChu?: string | null; tamUng?: boolean | null; khoa: string }
const e5 = (o: ChiE5) => `SELECT public.shareholder_profit_ledger_payout_v1(${q(o.cd ?? CD1)}, ${o.tien}, ${o.so === null ? "NULL" : q(o.so ?? SO_QUY)},
  ${o.ngay === null ? "NULL" : q(o.ngay ?? "2026-11-10")}, ${o.ghiChu === undefined ? "'Chi lợi nhuận tháng 10'" : q(o.ghiChu)},
  ${o.tamUng === undefined ? "false" : o.tamUng === null ? "NULL" : o.tamUng}, '${o.khoa}') AS v`;
const e4 = (cd: string, tien: number | null, so: string | null) =>
  `SELECT public.shareholder_profit_payout_preview_v1('${cd}', ${tien ?? "NULL"}, ${q(so)}) AS v`;
const e11 = (ql: string, tien: number | string, khoa: string, so: string = SO_QUY, ngay = "2026-11-10") =>
  `SELECT public.manager_salary_payout_v1('${ql}', ${tien}, '${so}', '${ngay}', 'Lương điều hành tháng 10', '${khoa}')::text AS v`;
const e8 = (loai: string, chuThe: string, thang: string | null, org = ORG_A) =>
  `SELECT public.profit_ledger_marker_preview_v1('${org}','${loai}','${chuThe}', ${q(thang)}) AS v`;
const e9 = (loai: string, chuThe: string, thang: string | null, cu: string | null, xacNhan: boolean | null, khoa: string, lyDo = "Đã trả đủ theo sổ tay", org = ORG_A) =>
  `SELECT public.profit_ledger_set_marker_v1('${org}','${loai}','${chuThe}', ${q(thang)}, ${q(lyDo)}, ${q(cu)}, ${xacNhan === null ? "NULL" : xacNhan}, '${khoa}') AS v`;
interface SoDu { balance: number; allocated: number; payouts_approved: number; payouts_pending: number; excluded_before_marker: { allocated: number; payouts: number; salary: number }; marker: { id: string } | null; needs_review: { count: number } }
const soDu = (loai: string, chuThe: string, org = ORG_A) =>
  mot<SoDu>(`SELECT app_private.profit_ledger_balance_v1('${org}','${loai}','${chuThe}') AS v`);
const mocHieuLuc = async (loai: string, chuThe: string) =>
  (await db.query<{ v: string }>(`SELECT marker_id AS v FROM app_private.profit_ledger_active_marker_v1('${ORG_A}','${loai}','${chuThe}')`)).rows[0]?.v ?? null;
const dem = (bang: string, dk = "true") => mot<number>(`SELECT count(*)::int AS v FROM ${bang} WHERE ${dk}`);

/** Phiếu chi do "writer" khác ghi thẳng (đã mở quyền ghi chuỗi kế toán để qua F4). */
async function taoPhieu(p: { id: string; tien: number; coDong?: string; quanLy?: string; trangThai?: string; org?: string }) {
  await db.exec(`SELECT app_private.begin_accounting_chain_write_v1();
    INSERT INTO public.income_expenses(id, user_id, organization_id, type, name, building_id, voucher_date, approval_status, shareholder_id, profit_manager_id, total_amount, account_id)
    VALUES ('${p.id}','${CHU}','${p.org ?? ORG_A}','EXPENSE','Phiếu thử','${TOA_AO}','2026-11-01','${p.trangThai ?? "APPROVED"}', ${q(p.coDong)}, ${q(p.quanLy)}, ${p.tien}, '${SO_QUY}');
    SELECT app_private.end_accounting_chain_write_v1();`);
}
/** Dòng profit_ledger_payouts theo ĐÚNG nghi thức (chép từ test M1). */
async function ghiDongPhieu(phieu: string, loai: string, chuThe: string, soTien: number, tamUng = 0) {
  await db.exec(`
    INSERT INTO app_private.profit_ledger_write_contexts(income_expense_id, purpose) VALUES ('${phieu}', 'CREATE');
    SELECT app_private.profit_ledger_lock_v1('${ORG_A}', '${loai}', '${chuThe}');
    INSERT INTO app_private.profit_ledger_payouts(voucher_id, organization_id, subject_kind, shareholder_id, manager_id, account_id, amount,
      balance_before, within_amount, advance_amount, maker_user_id, maker_membership_id, maker_kind, payee_is_maker, payee_user_id, ledger_seq)
    VALUES ('${phieu}','${ORG_A}','${loai}', ${loai === "SHAREHOLDER" ? `'${chuThe}', NULL` : `NULL, '${chuThe}'`}, '${SO_QUY}', ${soTien}, 0,
      ${soTien - tamUng}, ${tamUng}, '${CHU}','${mem(CHU)}','OWNER', false, NULL, nextval('app_private.profit_ledger_seq'));
    DELETE FROM app_private.profit_ledger_write_contexts WHERE income_expense_id = '${phieu}';`);
}

beforeAll(async () => {
  await dungCoSo(db);
  const md5Db = async (ham: string) => mot<string>(`SELECT md5(replace(p.prosrc, chr(13), '')) AS v FROM pg_proc p WHERE p.oid = to_regprocedure('${ham}')`);
  truoc.md5 = {
    e11: await md5Db("public.manager_salary_payout_v1(uuid,numeric,uuid,date,text,text)"),
    f4: await md5Db("app_private.guard_profit_payout_scope_compat_v1()"),
    ie: await md5Db("public.ie_compat_insert_v2(jsonb,jsonb)"),
  };
  // Hành vi CŨ của lương điều hành, đo trên cùng đầu vào sẽ dùng sau migration.
  truoc.e11 = await trongGiaoDich(async () => {
    const tho = await la<string>(CHU, e11(QL1, 12.5, "khoa-e11-so-sanh"));
    const kq = JSON.parse(tho) as Record<string, string>;
    return { tho, kq, ...(await chupPhieuLuongDieuHanh(kq.manager_salary_voucher_id)) };
  });
  // Lỗ cũ: ie_compat_insert_v2 giữ shareholder_id do người gọi tự khai (phiếu thường bị tính là phiếu chi lợi nhuận).
  truoc.ieCompatGiuCoDong = await trongGiaoDich(async () => {
    const r = await la<{ id: string }>(CHU, ieCompat({ shareholder_id: CD1 }));
    return mot<{ s: string | null; m: string | null }>(`SELECT jsonb_build_object('s', shareholder_id, 'm', profit_manager_id) AS v FROM public.income_expenses WHERE id = '${r.id}'`);
  });
  // Lỗ cũ: chèn thẳng phiếu có shareholder_id mà không qua lệnh chi nào.
  truoc.f4ChenThang = await trongGiaoDich(() => loiChu(`INSERT INTO public.income_expenses(user_id, organization_id, type, name, building_id, voucher_date, shareholder_id, account_id)
    VALUES ('${CHU}','${ORG_A}','EXPENSE','Phiếu tay','${TOA_1}','2026-11-01','${CD1}','${SO_QUY}')`));

  await db.exec(M1);
  await db.exec(NGOAI_LE);
  await db.exec(MIGRATION);
  ghi.xminLoaiLuot1 = await mot<string>(`SELECT string_agg(xmin::text, ',' ORDER BY id) AS v FROM public.income_expense_types WHERE rule_key IN ('chia_loi_nhuan','luong_dieu_hanh')`);
  await db.exec(MIGRATION);
  ghi.xminLoaiLuot2 = await mot<string>(`SELECT string_agg(xmin::text, ',' ORDER BY id) AS v FROM public.income_expense_types WHERE rule_key IN ('chia_loi_nhuan','luong_dieu_hanh')`);
}, 180000);
afterAll(() => db.close());

function ieCompat(them: Record<string, unknown>, loai = LOAI_VP_A) {
  const dong = JSON.stringify({ type: "EXPENSE", name: "Phiếu tay", building_id: TOA_1, account_id: SO_QUY, voucher_date: "2026-11-10", ...them });
  return `SELECT public.ie_compat_insert_v2('${dong}'::jsonb, '[{"income_expense_type_id":"${loai}","quantity":1,"unit_price":10}]'::jsonb) AS v`;
}
async function chupPhieuLuongDieuHanh(voucher: string) {
  const bo = "ARRAY['id','created_at','updated_at','birth_operation_id','birth_txid']";
  return {
    phieu: await mot<Record<string, unknown>>(`SELECT to_jsonb(ie) - ${bo} AS v FROM public.income_expenses ie WHERE id = '${voucher}'`),
    dong: await mot<Record<string, unknown>>(`SELECT to_jsonb(i) - ARRAY['id','created_at','income_expense_id'] AS v FROM public.income_expense_items i WHERE income_expense_id = '${voucher}'`),
    yc: await mot<Record<string, unknown>>(`SELECT to_jsonb(r) - ARRAY['id','subject_id'] AS v FROM public.approval_requests r WHERE subject_id = '${voucher}'`),
    op: await mot<Record<string, unknown>>(`SELECT to_jsonb(o) - ARRAY['subject_id','response_payload','created_at','completed_at'] AS v FROM app_private.canonical_write_operations o WHERE subject_id = '${voucher}'`),
    soDong: await mot<number>(`SELECT count(*)::int AS v FROM public.income_expense_items WHERE income_expense_id = '${voucher}'`),
  };
}

describe("[ghim] thân cũ và thân mới", () => {
  it("[ghim] ba thân cũ nạp vào test trùng md5 production mà migration ghim", () => {
    expect(truoc.md5).toEqual(MD5_CU);
  });
  it("[ghim] thân sau migration đúng md5 mà migration ghim cho lượt chạy lại; file chứa cả hai giá trị", async () => {
    const md5Db = async (ham: string) => mot<string>(`SELECT md5(replace(p.prosrc, chr(13), '')) AS v FROM pg_proc p WHERE p.oid = to_regprocedure('${ham}')`);
    expect({
      e11: await md5Db("public.manager_salary_payout_v1(uuid,numeric,uuid,date,text,text)"),
      f4: await md5Db("app_private.guard_profit_payout_scope_compat_v1()"),
      ie: await md5Db("public.ie_compat_insert_v2(jsonb,jsonb)"),
    }).toEqual(MD5_MOI);
    for (const k of ["e11", "f4", "ie"] as const) expect(MIGRATION).toContain(`'${MD5_CU[k]}', '${MD5_MOI[k]}'`);
    expect(md5(thanHam(MIGRATION, "public.manager_salary_payout_v1"))).toBe(MD5_MOI.e11);
  });
});

describe("hình dạng, quyền gọi và volatility", () => {
  const RPC: [string, string][] = [
    ["public.shareholder_profit_payout_preview_v1(uuid,numeric,uuid)", "s"],
    ["public.shareholder_profit_ledger_payout_v1(uuid,numeric,uuid,date,text,boolean,text)", "v"],
    ["public.profit_ledger_marker_preview_v1(uuid,text,uuid,date)", "s"],
    ["public.profit_ledger_set_marker_v1(uuid,text,uuid,date,text,uuid,boolean,text)", "v"],
  ];
  const NOI_BO = [
    "app_private.profit_ledger_tao_assert_route_v1(uuid,text[])", "app_private.profit_ledger_tao_warnings_v1(numeric,numeric,numeric)",
    "app_private.profit_ledger_tao_check_month_v1(uuid,date)", "app_private.profit_ledger_tao_advance_erased_v1(uuid,text,uuid,date,numeric)",
    "app_private.profit_ledger_tao_set_marker_v1(uuid,text,uuid,date,text,uuid,boolean,text,uuid)", "app_private.guard_profit_payout_scope_compat_v1()",
  ];
  const quyen = (ham: string) => db.query<{ a: boolean; n: boolean; s: boolean; p: boolean; v: string; d: boolean; cfg: string[] | null }>(`
    SELECT has_function_privilege('authenticated', p.oid, 'EXECUTE') a, has_function_privilege('anon', p.oid, 'EXECUTE') n,
           has_function_privilege('service_role', p.oid, 'EXECUTE') s,
           EXISTS (SELECT 1 FROM aclexplode(p.proacl) x WHERE x.grantee = 0) p, p.provolatile v, p.prosecdef d, p.proconfig cfg
      FROM pg_proc p WHERE p.oid = to_regprocedure($1)`, [ham]).then((r) => r.rows[0]);
  it("bốn RPC mới: DEFINER, ghim search_path, đúng volatility, chỉ authenticated gọi được (không anon, PUBLIC, service_role)", async () => {
    for (const [ham, vol] of RPC) {
      expect(await quyen(ham), ham).toMatchObject({ a: true, n: false, s: false, p: false, v: vol, d: true, cfg: ["search_path=pg_catalog, app_private, public"] });
    }
    // Gọi thật bằng anon / service_role (kể cả khi có claim của chủ) ⇒ 42501 từ ACL, không chạm thân hàm.
    for (const vai of ["anon", "service_role"]) {
      await trongGiaoDich(async () => {
        await datRoute("CANONICAL");
        await db.query("SELECT set_config('request.jwt.claim.sub', $1, true)", [CHU]);
        await db.exec(`SET LOCAL ROLE ${vai}`);
        for (const sql of [e5({ tien: 10, khoa: "khoa-acl-0001" }), e4(CD1, null, null), e8("SHAREHOLDER", CD1, null),
          e9("SHAREHOLDER", CD1, "2026-07-01", null, true, "khoa-acl-0002")]) {
          expect((await loiChu(sql))?.code, `${vai}: ${sql.slice(7, 60)}`).toBe("42501");
        }
        await db.exec("RESET ROLE");
        expect(await dem("public.income_expenses")).toBe(0);
      });
    }
  });
  it("hàm nội bộ và hàm trigger F4: không vai nào gọi được; authenticated gọi thẳng bị 42501", async () => {
    for (const ham of NOI_BO) expect(await quyen(ham), ham).toMatchObject({ a: false, n: false, s: false, p: false });
    await trongGiaoDich(async () => {
      await db.exec("GRANT USAGE ON SCHEMA app_private TO authenticated");
      const r = await loiLa(CHU, `SELECT app_private.profit_ledger_tao_set_marker_v1('${ORG_A}','SHAREHOLDER','${CD1}', '2026-08-01', 'Lý do đủ dài', NULL, true, 'khoa-noi-bo-01', '${CHU}')`);
      expect(r?.code).toBe("42501");
    });
  });
  it("E11 giữ nguyên chữ ký, kiểu trả, DEFAULT, search_path, volatility và ACL (authenticated, service_role; không anon)", async () => {
    const r = (await db.query<{ args: string; ret: string; nd: number; v: string; d: boolean; cfg: string[] }>(`
      SELECT pg_get_function_identity_arguments(p.oid) args, p.prorettype::regtype::text ret, p.pronargdefaults nd, p.provolatile v,
             p.prosecdef d, p.proconfig cfg FROM pg_proc p WHERE p.oid = 'public.manager_salary_payout_v1(uuid,numeric,uuid,date,text,text)'::regprocedure`)).rows[0];
    expect(r).toEqual({ args: "p_manager_id uuid, p_amount numeric, p_account_id uuid, p_voucher_date date, p_note text, p_idempotency_key text",
      ret: "json", nd: 0, v: "v", d: true, cfg: ["search_path=pg_catalog, public, app_private"] });
    expect(await quyen("public.manager_salary_payout_v1(uuid,numeric,uuid,date,text,text)")).toMatchObject({ a: true, n: false, s: true, p: false });
  });
  it("ie_compat_insert_v2 giữ chữ ký / DEFAULT / search_path; chỉ authenticated", async () => {
    const r = (await db.query<{ args: string; nd: number; cfg: string[] }>(`SELECT pg_get_function_arguments(p.oid) args, p.pronargdefaults nd, p.proconfig cfg
      FROM pg_proc p WHERE p.oid = 'public.ie_compat_insert_v2(jsonb,jsonb)'::regprocedure`)).rows[0];
    expect(r).toEqual({ args: "p_row jsonb, p_items jsonb DEFAULT '[]'::jsonb", nd: 1, cfg: ["search_path=pg_catalog, app_private, public"] });
    expect(await quyen("public.ie_compat_insert_v2(jsonb,jsonb)")).toMatchObject({ a: true, n: false, s: false, p: false });
  });
  it("trigger a00_00_profit_payout_account_guard giữ tên, cột và hàm; không có bản sao", async () => {
    const r = (await db.query<{ tg: string; fn: string; cot: string }>(`
      SELECT t.tgname tg, t.tgfoid::regprocedure::text fn, pg_get_triggerdef(t.oid) cot FROM pg_trigger t
       WHERE t.tgrelid = 'public.income_expenses'::regclass AND NOT t.tgisinternal AND t.tgfoid = 'app_private.guard_profit_payout_scope_compat_v1()'::regprocedure`)).rows;
    expect(r).toHaveLength(1);
    expect(r[0].tg).toBe("a00_00_profit_payout_account_guard");
    expect(r[0].cot).toContain("BEFORE INSERT OR UPDATE OF shareholder_id, profit_manager_id, account_id, organization_id, system_source");
  });
  it("không hàm nào file này ghi tự ném mã lớp 40 (40001 / 40P01): PostgREST tự chạy lại giao dịch khi gặp 40001 ⇒ điều kiện cố định (CAS sai) lặp không dừng", async () => {
    const ten = [...new Set([...MIGRATION.matchAll(/CREATE OR REPLACE FUNCTION\s+([a-z_]+\.[a-z0-9_]+)\s*\(/gi)].map((m) => m[1].toLowerCase()))];
    expect(ten.length).toBeGreaterThanOrEqual(12); // chống xanh rỗng: đủ E4/E5/E8/E9/E11, F4, ie_compat và các hàm nội bộ
    const r = (await db.query<{ ten: string; than: string; mo_ta: string | null }>(`
      SELECT n.nspname || '.' || p.proname AS ten, p.prosrc AS than, obj_description(p.oid, 'pg_proc') AS mo_ta
        FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname || '.' || p.proname = ANY($1::text[])`, [ten])).rows;
    expect([...new Set(r.map((x) => x.ten))].sort()).toEqual([...ten].sort());
    // Bỏ chú thích "--" rồi dò: mã chuỗi, tên điều kiện và RAISE SQLSTATE của lớp 40.
    const MA_LOP_40 = /'40001'|'40P01'|'40\d{3}'|\bserialization_failure\b|\bdeadlock_detected\b|\bSQLSTATE\s+'40/i;
    for (const x of r) {
      expect(x.than.replace(/--[^\n]*/g, " "), x.ten).not.toMatch(MA_LOP_40);
      expect(x.mo_ta ?? "", `COMMENT ${x.ten}`).not.toMatch(/40001|40P01/);
    }
    // CAS của E9 dùng PT409, đúng một chỗ trong file.
    expect(MIGRATION.split("USING ERRCODE = 'PT409'").length - 1).toBe(1);
  });
  it("RPC đọc (E4, E8) không nằm trong bao đóng khoá dòng mà gate stable-fn-locks dò (4 tầng, theo tên)", async () => {
    // Cùng SQL của scripts/check-stable-fn-locks.mjs, chạy trên catalog của test (có hàm khoá thật: authorize_tenant_action_v3, lock_org_for_decision_v1, claim_feature_operation_v1…).
    const r = (await db.query<{ fn_name: string; lock_from: string }>(String.raw`
      WITH RECURSIVE fns AS (
        SELECT p.oid, n.nspname AS ns, p.proname AS nm, p.provolatile AS vol,
               regexp_replace(regexp_replace(pg_get_functiondef(p.oid), '/\*.*?\*/', ' ', 'gs'), '--[^' || chr(10) || ']*', ' ', 'g') AS def
          FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE p.prokind IN ('f','p') AND n.nspname IN ('public', 'app_private', 'api')),
      seed AS (SELECT oid, nm, 0 AS depth, nm AS via FROM fns
                WHERE def ~* '\mfor\s+(share|update|no key update|key share)\M' OR def ~* '\mlock\s+(table\s+)?[a-z_.]'),
      closure AS (SELECT oid, nm, depth, via FROM seed
        UNION SELECT f.oid, f.nm, c.depth + 1, c.via FROM fns f JOIN closure c ON c.depth < 4 AND f.oid <> c.oid AND f.def ~ ('\m' || c.nm || '\s*\('))
      SELECT DISTINCT f.nm AS fn_name, c.via AS lock_from FROM closure c JOIN fns f ON f.oid = c.oid
       WHERE f.ns IN ('public', 'api') AND f.vol <> 'v'`)).rows;
    expect(r).toEqual([]);
    // Chống xanh rỗng: bao đóng thật sự có hàm (các writer VOLATILE).
    const seeds = (await db.query<{ nm: string }>(String.raw`SELECT p.proname nm FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname IN ('public','app_private') AND p.prokind IN ('f','p') AND pg_get_functiondef(p.oid) ~* '\mfor\s+(share|update|no key update)\M'`)).rows.map((x) => x.nm);
    expect(seeds).toEqual(expect.arrayContaining(["shareholder_profit_ledger_payout_v1", "lock_org_for_decision_v1", "authorize_tenant_action_v3"]));
  });
});

describe("D1.8 — đóng cửa lập tay", () => {
  it("hai hạng mục ở MỌI công ty: chỉ hệ thống, ẩn ở Thu chi và Báo chi nhanh, nhóm 'Chia lợi nhuận'; bắt buộc duyệt và cờ nội bộ giữ nguyên", async () => {
    const r = (await db.query(`SELECT id, system_only, manual_hidden, quick_entry_hidden, category, force_approval, internal_transfer
      FROM public.income_expense_types ORDER BY id`)).rows;
    expect(r).toEqual([
      { id: LOAI_CLN_A, system_only: true, manual_hidden: true, quick_entry_hidden: true, category: "Chia lợi nhuận", force_approval: true, internal_transfer: true },
      { id: LOAI_LDH_A, system_only: true, manual_hidden: true, quick_entry_hidden: true, category: "Chia lợi nhuận", force_approval: true, internal_transfer: false },
      { id: LOAI_VP_A, system_only: false, manual_hidden: false, quick_entry_hidden: false, category: "Hành chính – pháp lý", force_approval: false, internal_transfer: false },
      { id: LOAI_CLN_B, system_only: true, manual_hidden: true, quick_entry_hidden: true, category: "Chia lợi nhuận", force_approval: true, internal_transfer: true },
      { id: LOAI_LDH_B, system_only: true, manual_hidden: true, quick_entry_hidden: true, category: "Chia lợi nhuận", force_approval: true, internal_transfer: false },
    ]);
  });
  it("lượt chạy lại không ghi lại hai hạng mục (xmin không đổi)", () => {
    expect(ghi.xminLoaiLuot2).toBe(ghi.xminLoaiLuot1);
  });
  it("ie_compat_insert_v2: shareholder_id / profit_manager_id người gọi tự khai bị lột (trước migration thì giữ nguyên)", async () => {
    expect(truoc.ieCompatGiuCoDong).toEqual({ s: CD1, m: null });
    await trongGiaoDich(async () => {
      for (const them of [{ shareholder_id: CD1 }, { profit_manager_id: QL1 }, { shareholder_id: CD1, profit_manager_id: QL1 }]) {
        const r = await la<{ id: string; approval_status: string }>(CHU, ieCompat(them));
        expect(r.approval_status).toBe("UNAPPROVED");
        expect(await mot(`SELECT jsonb_build_object('s', shareholder_id, 'm', profit_manager_id, 't', total_amount) AS v FROM public.income_expenses WHERE id = '${r.id}'`),
          JSON.stringify(them)).toEqual({ s: null, m: null, t: 10 });
      }
    });
  });
  it("ie_compat_insert_v2: dòng mang hạng mục chia_loi_nhuan / luong_dieu_hanh ⇒ 42501 HINT ie_system_only_manual_blocked", async () => {
    await trongGiaoDich(async () => {
      for (const loai of [LOAI_CLN_A, LOAI_LDH_A]) {
        const r = await loiLa(CHU, ieCompat({}, loai));
        expect(r).toMatchObject({ code: "42501", hint: "ie_system_only_manual_blocked" });
      }
    });
  });
  it("ie_compat_insert_v2: thân mới = thân 20261030100148 thêm ĐÚNG hai cột ở hai danh sách lột và một đoạn chú thích (còn lại giữ từng byte)", async () => {
    const cu = thanHam(IE_CU, "public.ie_compat_insert_v2");
    const moi = await mot<string>("SELECT replace(prosrc, chr(13), '') AS v FROM pg_proc WHERE oid = 'public.ie_compat_insert_v2(jsonb,jsonb)'::regprocedure");
    const ky = cu
      .replace("  v_clean := p_row - ARRAY[\n", `  -- 15/11/2026 (sổ tổng lợi nhuận): lột cả shareholder_id, profit_manager_id. Phiếu chi lợi
  -- nhuận cổ đông / lương điều hành chỉ sinh từ lệnh của sổ tổng
  -- (shareholder_profit_ledger_payout_v1, manager_salary_payout_v1); phiếu thường mang hai
  -- cột này sẽ bị trừ thẳng vào số dư sổ tổng của người đó.
  v_clean := p_row - ARRAY[\n`)
      .replace("'system_source',\n    'organization_id'", "'system_source',\n    'shareholder_id', 'profit_manager_id',\n    'organization_id'")
      .replace("'tenant_id', 'shareholder_id', 'utility_account_id'", "'tenant_id', 'shareholder_id', 'profit_manager_id', 'utility_account_id'");
    expect(ky).not.toBe(cu);
    expect(moi).toBe(ky);
  });
  it("create_profit_payout_compat_v1: authenticated / anon không còn EXECUTE; gọi bằng authenticated ⇒ 42501", async () => {
    expect(await mot<boolean>(`SELECT has_function_privilege('authenticated','public.create_profit_payout_compat_v1(text,uuid,numeric,uuid,date,text,text)','EXECUTE') AS v`)).toBe(false);
    expect(await mot<boolean>(`SELECT has_function_privilege('anon','public.create_profit_payout_compat_v1(text,uuid,numeric,uuid,date,text,text)','EXECUTE') AS v`)).toBe(false);
    await trongGiaoDich(async () => {
      const r = await loiLa(CHU, `SELECT public.create_profit_payout_compat_v1('SHAREHOLDER','${CD1}', 10, '${SO_QUY}', '2026-11-10', NULL, 'khoa-compat-0001')`);
      expect(r?.code).toBe("42501");
    });
  });
});

describe("F4 — chốt phạm vi phiếu chi lợi nhuận", () => {
  const chenThang = (them = "", gia = "") => `INSERT INTO public.income_expenses(user_id, organization_id, type, name, building_id, voucher_date, account_id${them})
    VALUES ('${CHU}','${ORG_A}','EXPENSE','Phiếu tay','${TOA_1}','2026-11-01','${SO_QUY}'${gia})`;
  it("chèn thẳng phiếu có shareholder_id / profit_manager_id mà không qua lệnh chi của hệ thống ⇒ 42501 (trước migration thì lọt)", async () => {
    expect(truoc.f4ChenThang).toBeNull();
    await trongGiaoDich(async () => {
      for (const [cot, gt] of [["shareholder_id", CD1], ["profit_manager_id", QL1]]) {
        const r = await loiChu(chenThang(`, ${cot}`, `, '${gt}'`));
        expect(r, cot).toMatchObject({ code: "42501", message: expect.stringContaining("PROFIT_PAYOUT_CHAIN_WRITER_REQUIRED") });
      }
    });
  });
  it("writer có mở quyền ghi chuỗi kế toán (mẫu distribute_shareholder_profit_v1, create_profit_payout_compat_v1) vẫn chèn được", async () => {
    await trongGiaoDich(async () => {
      expect(await loiChu(`SELECT app_private.begin_accounting_chain_write_v1(); ${chenThang(", shareholder_id, system_source", `, '${CD1}', 'profit.distribution'`)};
        SELECT app_private.end_accounting_chain_write_v1();`)).toBeNull();
      expect(await loiChu(`SELECT app_private.begin_accounting_chain_write_v1(); ${chenThang(", profit_manager_id", `, '${QL1}'`)};`)).toBeNull();
    });
  });
  it("đổi người nhận trên phiếu có sẵn ⇒ 42501; bước ghi sổ V2 đặt lại account_id (không đổi người nhận) vẫn qua", async () => {
    await trongGiaoDich(async () => {
      const P = id(3001);
      await taoPhieu({ id: P, tien: 10, coDong: CD1 });
      expect(await loiChu(`UPDATE public.income_expenses SET shareholder_id = '${CD_TU}' WHERE id = '${P}'`)).toMatchObject({ code: "42501" });
      expect(await loiChu(`UPDATE public.income_expenses SET shareholder_id = NULL WHERE id = '${P}'`)).toMatchObject({ code: "42501" });
      expect(await loiChu(`UPDATE public.income_expenses SET account_id = '${SO_QUY_2}', posting_status = 'POSTED' WHERE id = '${P}'`)).toBeNull();
      expect(await loiChu(`UPDATE public.income_expenses SET account_id = '${SO_QUY_2}', shareholder_id = '${CD1}' WHERE id = '${P}'`)).toBeNull();
    });
  });
  it("nguồn 'profit.ledger_payout' được coi là phiếu chi lợi nhuận: thiếu người nhận / sổ ảo ⇒ 42501 như hai nguồn cũ", async () => {
    await trongGiaoDich(async () => {
      const [P1, P2] = [id(3401), id(3402)];
      expect(await loiChu(`SELECT app_private.begin_accounting_chain_write_v1();
        INSERT INTO app_private.profit_ledger_write_contexts(income_expense_id, purpose) VALUES ('${P1}', 'CREATE');
        INSERT INTO public.income_expenses(id, user_id, organization_id, type, name, building_id, voucher_date, account_id, system_source, approval_status)
        VALUES ('${P1}','${CHU}','${ORG_A}','EXPENSE','x','${TOA_1}','2026-11-01','${SO_QUY}','profit.ledger_payout','UNAPPROVED')`))
        .toMatchObject({ code: "42501", message: expect.stringContaining("cannot clear its shareholder/manager identity") });
      expect(await loiChu(`SELECT app_private.begin_accounting_chain_write_v1();
        INSERT INTO app_private.profit_ledger_write_contexts(income_expense_id, purpose) VALUES ('${P2}', 'CREATE');
        INSERT INTO public.income_expenses(id, user_id, organization_id, type, name, building_id, voucher_date, account_id, shareholder_id, system_source, approval_status)
        VALUES ('${P2}','${CHU}','${ORG_A}','EXPENSE','x','${TOA_1}','2026-11-01','${SO_AO}','${CD1}','profit.ledger_payout','UNAPPROVED')`))
        .toMatchObject({ code: "42501", message: expect.stringContaining("real and in the same organization") });
    });
  });
  it("phiếu mang nguồn sổ tổng chỉ chèn được trong ngữ cảnh LẬP của chính phiếu, ở UNAPPROVED, chưa POSTED; sai ⇒ 55000 PROFIT_LEDGER_CREATE_ONLY", async () => {
    await trongGiaoDich(async () => {
      const chen = (p: string, nguon: string, them: { ngucanh?: string | null; duyet?: string | null; ghiSo?: string | null } = {}) => `
        SELECT app_private.begin_accounting_chain_write_v1();
        ${them.ngucanh === null ? "" : `INSERT INTO app_private.profit_ledger_write_contexts(income_expense_id, purpose) VALUES ('${them.ngucanh ?? p}', 'CREATE');`}
        INSERT INTO public.income_expenses(id, user_id, organization_id, type, name, building_id, voucher_date, account_id, system_source,
            ${nguon === "profit.manager_salary" ? "profit_manager_id" : "shareholder_id"}${them.duyet === null ? "" : ", approval_status"}${them.ghiSo ? ", posting_status" : ""})
        VALUES ('${p}','${CHU}','${ORG_A}','EXPENSE','x','${TOA_AO}','2026-11-01','${SO_QUY}','${nguon}',
            '${nguon === "profit.manager_salary" ? QL1 : CD1}'${them.duyet === null ? "" : `, '${them.duyet ?? "UNAPPROVED"}'`}${them.ghiSo ? `, '${them.ghiSo}'` : ""})`;
      let n = 3500;
      for (const nguon of ["profit.ledger_payout", "profit.manager_salary"]) {
        const ca: [string, Record<string, string | null>][] = [
          ["không ngữ cảnh", { ngucanh: null }],
          ["ngữ cảnh của phiếu KHÁC", { ngucanh: id(3999) }],
          ["để mặc định (APPROVED)", { duyet: null }],
          ["chèn ở APPROVED", { duyet: "APPROVED" }],
          ["chèn ở CANCELLED", { duyet: "CANCELLED" }],
          ["chèn đã POSTED", { ghiSo: "POSTED" }],
        ];
        for (const [ten, them] of ca) {
          expect(await loiChu(chen(id(n++), nguon, them)), `${nguon} · ${ten}`)
            .toMatchObject({ code: "55000", message: expect.stringContaining("PROFIT_LEDGER_CREATE_ONLY") });
        }
        // Ngữ cảnh 'CANCEL' (của lệnh huỷ) không thay được ngữ cảnh LẬP.
        const PC = id(n++);
        expect(await loiChu(`SELECT app_private.begin_accounting_chain_write_v1();
          INSERT INTO app_private.profit_ledger_write_contexts(income_expense_id, purpose) VALUES ('${PC}', 'CANCEL');
          ${chen(PC, nguon, { ngucanh: null }).replace("SELECT app_private.begin_accounting_chain_write_v1();", "")}`), `${nguon} · ngữ cảnh CANCEL`)
          .toMatchObject({ code: "55000", message: expect.stringContaining("PROFIT_LEDGER_CREATE_ONLY") });
        expect(await loiChu(chen(id(n++), nguon)), `${nguon} · đúng nghi thức`).toBeNull();
      }
      expect(await dem("public.income_expenses", "system_source IN ('profit.ledger_payout','profit.manager_salary') AND approval_status <> 'UNAPPROVED'")).toBe(0);
      // Nguồn khác (phiếu chi lợi nhuận kiểu cũ) không bị nhánh này đụng: chèn ở mặc định APPROVED vẫn qua.
      expect(await loiChu(`SELECT app_private.begin_accounting_chain_write_v1(); ${chenThang(", shareholder_id, system_source", `, '${CD1}', 'profit.distribution'`)}`)).toBeNull();
    });
  });
  it("E5 / E11 chèn phiếu TƯỜNG MINH 'UNAPPROVED' (không dựa vào mặc định APPROVED của cột)", () => {
    const e5Than = thanHam(MIGRATION, "public.shareholder_profit_ledger_payout_v1");
    const e11Than = thanHam(MIGRATION, "public.manager_salary_payout_v1");
    expect(e5Than).toMatch(/INSERT INTO public\.income_expenses \([\s\S]*?approval_status[\s\S]*?\) VALUES \([\s\S]*?'UNAPPROVED'/);
    expect(e11Than.match(/insert into public\.income_expenses \([\s\S]*?approval_status[\s\S]*?\) values \([\s\S]*?'UNAPPROVED'/g)).toHaveLength(2);
  });
  it("phiếu thường (không người nhận, không nguồn lợi nhuận) không bị đòi gì", async () => {
    await trongGiaoDich(async () => {
      expect(await loiChu(chenThang())).toBeNull();
      expect(await loiChu(chenThang(", system_source", ", 'contract.commission'"))).toBeNull();
    });
  });
  it("thân mới = thân production thêm đúng: nguồn 'profit.ledger_payout' ở hai danh sách và khối đòi quyền ghi chuỗi", async () => {
    const cu = thanHam(F4_CU, "app_private.guard_profit_payout_scope_compat_v1");
    const moi = await mot<string>("SELECT replace(prosrc, chr(13), '') AS v FROM pg_proc WHERE oid = 'app_private.guard_profit_payout_scope_compat_v1()'::regprocedure");
    const nguon = "IN ('profit.distribution', 'profit.manager_salary')";
    const ky = cu.split(nguon).join("IN ('profit.distribution', 'profit.manager_salary', 'profit.ledger_payout')")
      .replace("  v_is_payout boolean := false;\n", "  v_is_payout boolean := false;\n  v_doi_chu_the boolean := false;\n");
    const moc = "  IF NOT v_is_payout THEN\n    RETURN NEW;\n  END IF;\n";
    const [dau, sau] = ky.split(moc);
    expect(moi.startsWith(dau + moc)).toBe(true);
    expect(moi.endsWith(sau)).toBe(true);
    const chen = moi.slice((dau + moc).length, moi.length - sau.length);
    expect(chen).toContain("app_private.accounting_chain_writer_xids");
    expect(chen).toContain("app_private.profit_ledger_write_context_v1(NEW.id)");
    expect(chen.match(/RAISE EXCEPTION '(PROFIT_LEDGER_CREATE_ONLY|PROFIT_PAYOUT_CHAIN_WRITER_REQUIRED):/g)).toHaveLength(2);
    expect(chen.match(/RAISE EXCEPTION/g)).toHaveLength(2);
  });
});

describe("E5 — lập phiếu chi lợi nhuận theo sổ tổng", () => {
  it("công tắc TẮT / SHADOW ⇒ 55000 PROFIT_LEDGER_ROUTE_OFF; ĐÓNG BĂNG ⇒ 55000 PROFIT_LEDGER_FROZEN; câu báo không là tín hiệu rơi về đường cũ của web", async () => {
    await trongGiaoDich(async () => {
      for (const [route, ma] of [["LEGACY", "PROFIT_LEDGER_ROUTE_OFF"], ["SHADOW", "PROFIT_LEDGER_ROUTE_OFF"], ["FROZEN", "PROFIT_LEDGER_FROZEN"]] as const) {
        await datRoute(route);
        const r = await loiLa(CHU, e5({ tien: 10, khoa: `khoa-route-${route}` }));
        expect(r, route).toMatchObject({ code: "55000", message: expect.stringContaining(ma) });
        expect(isCanonicalFallbackSignal(r), route).toBe(false);
        expect(JSON.parse(r!.detail!).route).toBe(route);
      }
      expect(await dem("public.income_expenses", "system_source = 'profit.ledger_payout'")).toBe(0);
      expect(await dem("app_private.canonical_write_operations")).toBe(0);
    });
  });
  it("chủ chi trong số còn phải trả: phiếu UNAPPROVED đúng hình dạng, yêu cầu PENDING_APPROVAL, dòng sổ C2, nhật ký C5, dọn ngữ cảnh và quyền ghi chuỗi", async () => {
    await trongGiaoDich(async () => {
      await datRoute("CANONICAL");
      const r = await la<Record<string, unknown>>(CHU, e5({ tien: 120, khoa: "khoa-chi-0001" }));
      expect(r).toMatchObject({ shareholder_id: CD1, amount: 120, within_amount: 120, advance_amount: 0, balance_before: CD1_GOC,
        maker_kind: "OWNER", state: "PENDING_APPROVAL" });
      expect((r.warnings as { code: string }[]).map((w) => w.code)).toEqual(["NEEDS_OWNER_APPROVAL"]);
      const v = r.voucher_id as string;
      expect(await mot(`SELECT jsonb_build_object('type', type, 'st', approval_status, 'src', system_source, 'cd', shareholder_id, 'acc', account_id,
          'bld', building_id, 'user', user_id, 'tong', total_amount, 'kqkd', business_result_accounting, 'maker', maker_user_id, 'mem', maker_membership_id,
          'idem', idempotency_key, 'hash_ok', source_payload_hash IS NOT NULL, 'review', review_state, 'post', posting_status, 'name', name) AS v
        FROM public.income_expenses WHERE id = '${v}'`)).toEqual({ type: "EXPENSE", st: "UNAPPROVED", src: "profit.ledger_payout", cd: CD1, acc: SO_QUY,
        bld: TOA_AO, user: CHU, tong: 120, kqkd: false, maker: CHU, mem: mem(CHU), idem: "khoa-chi-0001", hash_ok: true, review: "PENDING",
        post: "UNPOSTED", name: "Chi lợi nhuận tháng 10" });
      expect(await mot(`SELECT jsonb_agg(jsonb_build_object('loai', income_expense_type_id, 'tien', amount, 'lop', accounting_class)) AS v
        FROM public.income_expense_items WHERE income_expense_id = '${v}'`)).toEqual([{ loai: LOAI_CLN_A, tien: 120, lop: "INTERNAL" }]);
      expect(await mot(`SELECT jsonb_build_object('st', state, 'eff', rule_effect, 'id_ok', id = '${r.approval_request_id}') AS v FROM public.approval_requests WHERE subject_id = '${v}'`))
        .toEqual({ st: "PENDING_APPROVAL", eff: "REQUIRE_APPROVAL", id_ok: true });
      expect(await mot(`SELECT to_jsonb(c) - ARRAY['created_at','ledger_seq','warnings'] AS v FROM app_private.profit_ledger_payouts c WHERE voucher_id = '${v}'`)).toEqual({
        voucher_id: v, organization_id: ORG_A, subject_kind: "SHAREHOLDER", shareholder_id: CD1, manager_id: null, account_id: SO_QUY, amount: 120,
        balance_before: CD1_GOC, within_amount: 120, advance_amount: 0, open_estimate: 100, maker_user_id: CHU, maker_membership_id: mem(CHU),
        maker_kind: "OWNER", payee_is_maker: false, payee_user_id: null, approval_request_id: r.approval_request_id });
      expect(await mot(`SELECT jsonb_build_object('k', event_kind, 'tien', amount, 'truoc', balance_before, 'sau', balance_after, 'ai', actor_id) AS v
        FROM app_private.profit_ledger_events WHERE voucher_id = '${v}'`)).toEqual({ k: "PAYOUT_CREATED", tien: 120, truoc: CD1_GOC, sau: 30, ai: CHU });
      expect(await dem("app_private.profit_ledger_write_contexts")).toBe(0);
      expect(await dem("app_private.accounting_chain_writer_xids")).toBe(0);
      expect(await dem("app_private.canonical_write_operations", `subject_id = '${v}' AND completed_at IS NOT NULL AND response_payload->>'voucher_id' = '${v}'`)).toBe(1);
      expect((await soDu("SHAREHOLDER", CD1)).balance).toBe(30);
      // Gửi duyệt đúng người lập và thành viên của họ.
      expect(await mot(`SELECT to_jsonb(c) AS v FROM public.test_submit_calls c`)).toEqual({ subject_id: v, actor_membership: mem(CHU), actor_user: CHU, idem: "khoa-chi-0001-sub" });
    });
  });
  it("vượt số còn phải trả mà không xác nhận ⇒ 22023 PROFIT_LEDGER_ADVANCE_CONFIRM + DETAIL; không để lại gì", async () => {
    await trongGiaoDich(async () => {
      await datRoute("CANONICAL");
      for (const tamUng of [false, null]) {
        const r = await loiLa(CHU, e5({ tien: 200, tamUng, khoa: "khoa-vuot-0001" }));
        expect(r).toMatchObject({ code: "22023", message: expect.stringContaining("PROFIT_LEDGER_ADVANCE_CONFIRM") });
        expect(JSON.parse(r!.detail!)).toEqual({ balance: CD1_GOC, within: 150, advance: 50 });
      }
      expect(await dem("public.income_expenses")).toBe(0);
      expect(await dem("app_private.profit_ledger_payouts")).toBe(0);
    });
  });
  it("vượt có xác nhận: tách đúng phần trong số dư và phần tạm ứng; cảnh báo vượt ước tính chỉ khi tổng tạm ứng còn treo > ước tính", async () => {
    await trongGiaoDich(async () => {
      await datRoute("CANONICAL");
      const a = await la<Record<string, unknown>>(CHU, e5({ tien: 200, tamUng: true, khoa: "khoa-vuot-0002" }));
      expect(a).toMatchObject({ within_amount: 150, advance_amount: 50, balance_before: CD1_GOC });
      expect((a.warnings as { code: string }[]).map((w) => w.code)).toEqual(["ADVANCE", "NEEDS_OWNER_APPROVAL"]);
      // Đang âm 50 (ước tính 100): chi thêm 60 ⇒ toàn bộ là tạm ứng, tổng treo 110 > 100 ⇒ cảnh báo, không chặn.
      const b = await la<Record<string, unknown>>(CHU, e5({ tien: 60, tamUng: true, khoa: "khoa-vuot-0003" }));
      expect(b).toMatchObject({ within_amount: 0, advance_amount: 60, balance_before: -50 });
      expect(b.warnings).toEqual([{ code: "ADVANCE", advance_amount: 60 }, { code: "ADVANCE_EXCEEDS_ESTIMATE", outstanding_advance: 110, open_estimate: 100 },
        { code: "NEEDS_OWNER_APPROVAL" }]);
      expect(await mot(`SELECT jsonb_agg(jsonb_build_array(within_amount, advance_amount, balance_before) ORDER BY ledger_seq) AS v FROM app_private.profit_ledger_payouts`))
        .toEqual([[150, 50, 150], [0, 60, -50]]);
    });
  });
  it("hai lần chi nối nhau: lần sau thấy phiếu chờ duyệt của lần trước (số dư trước giảm đúng), thứ tự sổ tăng dần", async () => {
    await trongGiaoDich(async () => {
      await datRoute("CANONICAL");
      await la(CHU, e5({ tien: 40, khoa: "khoa-noi-0001" }));
      const b = await la<Record<string, unknown>>(CHU, e5({ tien: 40, khoa: "khoa-noi-0002" }));
      expect(b.balance_before).toBe(110);
      expect(await mot(`SELECT bool_and(a.ledger_seq < b.ledger_seq) AS v FROM app_private.profit_ledger_payouts a, app_private.profit_ledger_payouts b
        WHERE a.balance_before = 150 AND b.balance_before = 110`)).toBe(true);
    });
  });
  it("cùng khoá ⇒ trả y hệt, không ghi thêm; cùng khoá khác số tiền / sổ / ghi chú ⇒ 23505", async () => {
    await trongGiaoDich(async () => {
      await datRoute("CANONICAL");
      const a = await la<Record<string, unknown>>(CHU, e5({ tien: 30, khoa: "khoa-lap-lai-01" }));
      expect(await la<Record<string, unknown>>(CHU, e5({ tien: 30, khoa: "khoa-lap-lai-01" }))).toEqual(a);
      expect(await dem("public.income_expenses")).toBe(1);
      expect((await loiLa(CHU, e5({ tien: 31, khoa: "khoa-lap-lai-01" })))?.code).toBe("23505");
      expect((await loiLa(CHU, e5({ tien: 30, so: SO_QUY_2, khoa: "khoa-lap-lai-01" })))?.code).toBe("23505");
      expect((await loiLa(CHU, e5({ tien: 30, ghiChu: "khác", khoa: "khoa-lap-lai-01" })))?.code).toBe("23505");
    });
  });
  it("người giữ sổ được cấp quyền tạm ứng: chi cho CHÍNH MÌNH từ sổ đang giữ ⇒ được (CUSTODIAN_ADVANCE, vẫn chờ chủ duyệt)", async () => {
    await trongGiaoDich(async () => {
      await datRoute("CANONICAL");
      const r = await la<Record<string, unknown>>(TAM_UNG, e5({ cd: CD_TU, tien: 50, so: SO_GIU, tamUng: true, khoa: "khoa-giu-so-01" }));
      expect(r).toMatchObject({ maker_kind: "CUSTODIAN_ADVANCE", within_amount: CD_TU_GOC, advance_amount: 20, state: "PENDING_APPROVAL" });
      expect(await mot(`SELECT jsonb_build_object('k', maker_kind, 'p', payee_is_maker, 'u', payee_user_id, 'm', maker_user_id) AS v FROM app_private.profit_ledger_payouts`))
        .toEqual({ k: "CUSTODIAN_ADVANCE", p: true, u: TAM_UNG, m: TAM_UNG });
    });
  });
  it("người giữ sổ: chi từ sổ KHÔNG giữ (kể cả sổ chỉ là KNOWER) ⇒ 42501; chi cho người khác ⇒ 42501; quyền đã thu hồi ⇒ 42501", async () => {
    await trongGiaoDich(async () => {
      await datRoute("CANONICAL");
      expect(await loiLa(TAM_UNG, e5({ cd: CD_TU, tien: 10, so: SO_QUY, khoa: "khoa-giu-so-02" })))
        .toMatchObject({ code: "42501", message: expect.stringContaining("PROFIT_LEDGER_ADVANCE_CASHBOOK") });
      expect(await loiLa(TAM_UNG, e5({ cd: CD_TU, tien: 10, so: SO_QUY_2, khoa: "khoa-giu-so-03" })))
        .toMatchObject({ code: "42501", message: expect.stringContaining("PROFIT_LEDGER_ADVANCE_CASHBOOK") });
      expect(await loiLa(TAM_UNG, e5({ cd: CD1, tien: 10, so: SO_GIU, khoa: "khoa-giu-so-04" })))
        .toMatchObject({ code: "42501", message: expect.stringContaining("PROFIT_LEDGER_ADVANCE_SELF_ONLY") });
      expect(await loiLa(TAM_UNG_GO, e5({ cd: CD_TU, tien: 10, so: SO_GIU, khoa: "khoa-giu-so-05" })))
        .toMatchObject({ code: "42501", message: "Không có quyền chi lợi nhuận cổ đông" });
      expect(await dem("public.income_expenses")).toBe(0);
    });
  });
  it("không quyền, người ngoài công ty, chưa đăng nhập ⇒ 42501; super admin không là thành viên cũng bị chặn", async () => {
    await trongGiaoDich(async () => {
      await datRoute("CANONICAL");
      for (const u of [KHONG_QUYEN, NGOAI, null, SUPER]) expect((await loiLa(u, e5({ tien: 10, khoa: "khoa-khong-quyen" })))?.code, String(u)).toBe("42501");
      expect(await dem("app_private.canonical_write_operations")).toBe(0);
    });
  });
  it("cổ đông nghỉ / đã xoá / công ty khác, sổ ảo / sổ công ty khác ⇒ 42501; công ty không có toà ảo ⇒ 55000", async () => {
    await trongGiaoDich(async () => {
      await datRoute("CANONICAL");
      for (const cd of [CD_NGHI, CD_XOA, CD_B, id(999)]) expect((await loiLa(CHU, e5({ cd, tien: 10, khoa: "khoa-sai-cd-01" })))?.code, cd).toBe("42501");
      for (const so of [SO_AO, SO_QUY_B]) expect((await loiLa(CHU, e5({ tien: 10, so, khoa: "khoa-sai-so-01" })))?.code, so).toBe("42501");
      await db.exec(`UPDATE public.buildings SET deleted_at = now() WHERE id = '${TOA_AO}'`);
      expect((await loiLa(CHU, e5({ tien: 10, khoa: "khoa-toa-ao-01" })))?.code).toBe("55000");
    });
  });
  it("đầu vào sai ⇒ 22023: khoá, số tiền (0, âm, 3 số lẻ, NaN, vô cực, quá lớn), thiếu sổ / ngày, ghi chú > 500", async () => {
    await trongGiaoDich(async () => {
      await datRoute("CANONICAL");
      expect((await loiLa(CHU, e5({ tien: 10, khoa: "ngan" })))?.code).toBe("22023");
      for (const tien of ["0", "-5", "10.001", "'NaN'::numeric", "'Infinity'::numeric", "10000000000000", "NULL"]) {
        expect((await loiLa(CHU, e5({ tien, khoa: "khoa-dau-vao-01" })))?.code, tien).toBe("22023");
      }
      expect((await loiLa(CHU, e5({ tien: 10, so: null, khoa: "khoa-dau-vao-02" })))?.code).toBe("22023");
      expect((await loiLa(CHU, e5({ tien: 10, ngay: null, khoa: "khoa-dau-vao-03" })))?.code).toBe("22023");
      expect((await loiLa(CHU, e5({ tien: 10, ghiChu: "x".repeat(501), khoa: "khoa-dau-vao-04" })))?.code).toBe("22023");
    });
  });
  it("cổ đông còn phiếu lương 'cần chủ xem lại' (phiếu lương còn sống) ⇒ 55000 PROFIT_LEDGER_SALARY_REVIEW_PENDING; phiếu lương đã huỷ thì không chặn", async () => {
    await trongGiaoDich(async () => {
      await datRoute("CANONICAL");
      const PL = id(3101);
      await db.exec(`INSERT INTO public.income_expenses(id, user_id, organization_id, type, name, building_id, voucher_date, total_amount, account_id)
        VALUES ('${PL}','${CHU}','${ORG_A}','EXPENSE','Lương','${TOA_1}','2026-10-31', 5, '${SO_QUY}');
        INSERT INTO app_private.profit_ledger_salary_settlement_vouchers(organization_id, shareholder_id, staff_id, period_month, salary_voucher_id,
          suggested_investment, sheet_status_at_quote, source, state) VALUES ('${ORG_A}','${CD1}','${CHU}','2026-10-01','${PL}', 5, 'DRAFT','PAYOUT_FALLBACK','NEEDS_REVIEW')`);
      const r = await loiLa(CHU, e5({ tien: 10, khoa: "khoa-xem-lai-01" }));
      expect(r).toMatchObject({ code: "55000", message: expect.stringContaining("PROFIT_LEDGER_SALARY_REVIEW_PENDING") });
      expect(JSON.parse(r!.detail!)).toEqual({ count: 1, suggested: 5 });
      await db.exec(`UPDATE public.income_expenses SET approval_status = 'CANCELLED' WHERE id = '${PL}'`);
      expect(await loiLa(CHU, e5({ tien: 10, khoa: "khoa-xem-lai-02" }))).toBeNull();
    });
  });
  it("luật duyệt DENY hoặc engine tự duyệt ⇒ 55000 PROFIT_LEDGER_REQUEST_NOT_PENDING, huỷ cả lệnh: không phiếu mồ côi, không yêu cầu, không dòng sổ, không operation", async () => {
    await trongGiaoDich(async () => {
      await datRoute("CANONICAL");
      for (const cheDo of ["DENY", "AUTO_POST_HONG"]) {
        await db.exec(`SELECT set_config('test.submit', '${cheDo}', true)`);
        const r = await loiLa(CHU, e5({ tien: 10, khoa: `khoa-luat-${cheDo.toLowerCase().replace(/_/g, "-")}` }));
        expect(r, cheDo).toMatchObject({ code: "55000", message: expect.stringContaining("PROFIT_LEDGER_REQUEST_NOT_PENDING") });
      }
      for (const bang of ["public.income_expenses", "public.approval_requests", "app_private.profit_ledger_payouts", "app_private.profit_ledger_events",
        "app_private.canonical_write_operations", "public.income_expense_items"]) expect(await dem(bang), bang).toBe(0);
      // Luật AUTO_POST thật: hạng mục bắt buộc duyệt ⇒ vẫn vào hàng chờ duyệt.
      await db.exec("SELECT set_config('test.submit', 'AUTO_POST', true)");
      expect(await la<Record<string, unknown>>(CHU, e5({ tien: 10, khoa: "khoa-luat-auto-01" }))).toMatchObject({ state: "PENDING_APPROVAL" });
      expect(await mot("SELECT state AS v FROM public.approval_requests")).toBe("PENDING_APPROVAL");
    });
  });
  it("hạng mục chia lợi nhuận mất 'bắt buộc duyệt' ⇒ 55000; chưa có hạng mục ⇒ tự tạo đúng cờ (chỉ hệ thống, ẩn, nội bộ, bắt buộc duyệt, rule_key)", async () => {
    await trongGiaoDich(async () => {
      await datRoute("CANONICAL");
      await db.exec(`UPDATE public.income_expense_types SET force_approval = false WHERE id = '${LOAI_CLN_A}'`);
      expect(await loiLa(CHU, e5({ tien: 10, khoa: "khoa-loai-0001" }))).toMatchObject({ code: "55000", message: expect.stringContaining("PROFIT_LEDGER_TYPE_NOT_FORCED") });
      await db.exec(`DELETE FROM public.income_expense_types WHERE id = '${LOAI_CLN_A}'`);
      const r = await la<{ voucher_id: string }>(CHU, e5({ tien: 10, khoa: "khoa-loai-0002" }));
      expect(await mot(`SELECT jsonb_build_object('rk', t.rule_key, 'so', t.system_only, 'mh', t.manual_hidden, 'qh', t.quick_entry_hidden, 'it', t.internal_transfer,
          'fa', t.force_approval, 'r', t.is_restricted, 'cat', t.category, 'lop', i.accounting_class) AS v
        FROM public.income_expense_items i JOIN public.income_expense_types t ON t.id = i.income_expense_type_id WHERE i.income_expense_id = '${r.voucher_id}'`))
        .toEqual({ rk: "chia_loi_nhuan", so: true, mh: true, qh: true, it: true, fa: true, r: true, cat: "Chia lợi nhuận", lop: "INTERNAL" });
    });
  });
  it("hai khoá ngày báo trước, dễ hiểu: tháng của toà ảo đã chốt LN ⇒ 55000 PROFIT_LEDGER_PROFIT_MONTH_LOCKED; sổ quỹ đã chốt ⇒ 55000 PROFIT_LEDGER_CASHBOOK_CLOSED", async () => {
    await trongGiaoDich(async () => {
      await datRoute("CANONICAL");
      expect(await loiLa(CHU, e5({ tien: 10, ngay: "2026-05-20", khoa: "khoa-ngay-0001" })))
        .toMatchObject({ code: "55000", message: expect.stringContaining("PROFIT_LEDGER_PROFIT_MONTH_LOCKED") });
      await db.exec(`INSERT INTO app_private.cashbook_closures(organization_id, cashbook_id, closed_through) VALUES ('${ORG_A}','${SO_QUY}','2026-11-10')`);
      const r = await loiLa(CHU, e5({ tien: 10, ngay: "2026-11-10", khoa: "khoa-ngay-0002" }));
      expect(r).toMatchObject({ code: "55000", message: expect.stringContaining("PROFIT_LEDGER_CASHBOOK_CLOSED") });
      expect(JSON.parse(r!.detail!)).toEqual({ closed_through: "2026-11-10", voucher_date: "2026-11-10" });
      expect(await loiLa(CHU, e5({ tien: 10, ngay: "2026-11-11", khoa: "khoa-ngay-0003" }))).toBeNull();
    });
  });
  it("công ty khác chi cho cổ đông của mình bình thường (toà ảo, hạng mục, số dư của đúng công ty)", async () => {
    await trongGiaoDich(async () => {
      await datRoute("CANONICAL");
      const r = await la<Record<string, unknown>>(NGOAI, e5({ cd: CD_B, tien: 300, so: SO_QUY_B, khoa: "khoa-cong-ty-b" }));
      expect(r).toMatchObject({ within_amount: 300, advance_amount: 0, balance_before: 300 });
      expect(await mot(`SELECT building_id AS v FROM public.income_expenses WHERE id = '${r.voucher_id}'`)).toBe(TOA_AO_B);
    });
  });
});

describe("E4 — xem trước một lần chi", () => {
  it("chưa gõ số tiền / chưa chọn sổ: chỉ số dư và ước tính, không cảnh báo, chưa lập được", async () => {
    await trongGiaoDich(async () => {
      await datRoute("CANONICAL");
      expect(await la(CHU, e4(CD1, null, null))).toMatchObject({ route: "CANONICAL", maker_kind: "OWNER", payee_is_maker: false, balance_before: CD1_GOC,
        within_amount: null, advance_amount: null, open_estimate: 100, warnings: [], requires_owner_approval: true, can_submit: false, blocked_reason: null });
    });
  });
  it("khớp đúng số E5 sẽ ghi (trong số dư, tạm ứng, cảnh báo) và lập được khi đủ điều kiện", async () => {
    await trongGiaoDich(async () => {
      await datRoute("CANONICAL");
      for (const tien of [100, 200, 300]) {
        const xem = await la<Record<string, unknown>>(CHU, e4(CD1, tien, SO_QUY));
        expect(xem.can_submit).toBe(true);
        await db.exec("SAVEPOINT lap");
        const lap = await la<Record<string, unknown>>(CHU, e5({ tien, tamUng: true, khoa: `khoa-khop-${tien}` }));
        await db.exec("ROLLBACK TO SAVEPOINT lap");
        for (const k of ["balance_before", "within_amount", "advance_amount", "warnings"]) expect(xem[k], `${tien} ${k}`).toEqual(lap[k]);
      }
    });
  });
  it("công tắc chưa CANONICAL ⇒ vẫn xem được số nhưng không lập được (blocked_reason ROUTE); còn phiếu lương cần xem lại ⇒ SALARY_REVIEW_PENDING", async () => {
    await trongGiaoDich(async () => {
      for (const route of ["LEGACY", "SHADOW", "FROZEN"] as const) {
        await datRoute(route);
        expect(await la(CHU, e4(CD1, 10, SO_QUY)), route).toMatchObject({ route, can_submit: false, blocked_reason: "ROUTE", balance_before: CD1_GOC });
      }
      await datRoute("CANONICAL");
      const PL = id(3102);
      await db.exec(`INSERT INTO public.income_expenses(id, user_id, organization_id, type, name, building_id, voucher_date, total_amount, account_id)
        VALUES ('${PL}','${CHU}','${ORG_A}','EXPENSE','Lương','${TOA_1}','2026-10-31', 5, '${SO_QUY}');
        INSERT INTO app_private.profit_ledger_salary_settlement_vouchers(organization_id, shareholder_id, staff_id, period_month, salary_voucher_id,
          sheet_status_at_quote, source, state) VALUES ('${ORG_A}','${CD1}','${CHU}','2026-10-01','${PL}','DRAFT','PAYOUT_FALLBACK','NEEDS_REVIEW')`);
      expect(await la(CHU, e4(CD1, 10, SO_QUY))).toMatchObject({ can_submit: false, blocked_reason: "SALARY_REVIEW_PENDING" });
    });
  });
  it("người giữ sổ: chỉ xem số của chính mình, từ sổ đang giữ; sổ không giữ / người khác / không quyền ⇒ 42501", async () => {
    await trongGiaoDich(async () => {
      await datRoute("CANONICAL");
      expect(await la(TAM_UNG, e4(CD_TU, 50, SO_GIU))).toMatchObject({ maker_kind: "CUSTODIAN_ADVANCE", payee_is_maker: true, balance_before: CD_TU_GOC,
        within_amount: CD_TU_GOC, advance_amount: 20, can_submit: true });
      expect(await la(TAM_UNG, e4(CD_TU, null, null))).toMatchObject({ maker_kind: "CUSTODIAN_ADVANCE", can_submit: false });
      expect(await loiLa(TAM_UNG, e4(CD_TU, 10, SO_QUY))).toMatchObject({ code: "42501", message: expect.stringContaining("PROFIT_LEDGER_ADVANCE_CASHBOOK") });
      expect(await loiLa(TAM_UNG, e4(CD1, null, null))).toMatchObject({ code: "42501", message: expect.stringContaining("PROFIT_LEDGER_ADVANCE_SELF_ONLY") });
      for (const u of [TAM_UNG_GO, KHONG_QUYEN, NGOAI, null, SUPER]) expect((await loiLa(u, e4(CD1, null, null)))?.code, String(u)).toBe("42501");
      expect((await loiLa(CHU, e4(CD1, 10, SO_AO)))?.code).toBe("42501");
      expect((await loiLa(CHU, e4(CD_XOA, null, null)))?.code).toBe("42501");
      expect((await loiLa(CHU, e4(CD1, 10.001, null)))?.code).toBe("22023");
    });
  });
  it("chạy được trong giao dịch CHỈ ĐỌC dưới vai authenticated (đúng cách PostgREST gọi hàm STABLE) — không 25006, không ghi gì", async () => {
    await datRoute("CANONICAL");
    try {
      await db.exec("BEGIN READ ONLY");
      try {
        expect(await la(TAM_UNG, e4(CD_TU, 50, SO_GIU))).toMatchObject({ can_submit: true });
        expect(await la(CHU, e4(CD1, 500, SO_QUY))).toMatchObject({ advance_amount: 350 });
      } finally { await db.exec("ROLLBACK"); }
    } finally { await datRoute("LEGACY"); }
  });
});

describe("E11 — lương điều hành", () => {
  it("sổ tổng TẮT: kết quả giống hệt thân cũ trên cùng đầu vào (thêm đúng khoá voucher_id); phiếu, dòng, yêu cầu, operation y hệt; qua F4", async () => {
    await trongGiaoDich(async () => {
      await datRoute("LEGACY");
      const cu = truoc.e11 as { tho: string; kq: Record<string, string>; phieu: unknown; dong: unknown; yc: unknown; op: unknown; soDong: number };
      const tho = await la<string>(CHU, e11(QL1, 12.5, "khoa-e11-so-sanh"));
      const kq = JSON.parse(tho) as Record<string, string>;
      expect(Object.keys(kq)).toEqual([...Object.keys(cu.kq), "voucher_id"]);
      expect(kq.voucher_id).toBe(kq.manager_salary_voucher_id);
      expect({ ...kq, manager_salary_voucher_id: "", approval_request_id: "", voucher_id: undefined })
        .toEqual({ ...cu.kq, manager_salary_voucher_id: "", approval_request_id: "", voucher_id: undefined });
      const moi = await chupPhieuLuongDieuHanh(kq.manager_salary_voucher_id);
      expect(moi.soDong).toBe(1);
      expect(moi).toEqual({ phieu: cu.phieu, dong: cu.dong, yc: cu.yc, op: cu.op, soDong: cu.soDong });
      expect(await dem("app_private.profit_ledger_payouts")).toBe(0);
      expect(await dem("app_private.accounting_chain_writer_xids")).toBe(0);
    });
  });
  it("SHADOW cũng chạy thân cũ (không dòng sổ, không system_source)", async () => {
    await trongGiaoDich(async () => {
      await datRoute("SHADOW");
      const kq = JSON.parse(await la<string>(CHU, e11(QL1, 70, "khoa-e11-shadow"))) as Record<string, string>;
      expect(kq.voucher_id).toBe(kq.manager_salary_voucher_id);
      expect(await mot(`SELECT system_source AS v FROM public.income_expenses WHERE id = '${kq.voucher_id}'`)).toBeNull();
      expect(await dem("app_private.profit_ledger_payouts")).toBe(0);
    });
  });
  it("sổ tổng BẬT: trong số còn lại ⇒ phiếu 'profit.manager_salary', dòng sổ (không tạm ứng), nhật ký, kết quả thêm balance_before", async () => {
    await trongGiaoDich(async () => {
      await datRoute("CANONICAL");
      const tho = await la<string>(CHU, e11(QL1, 20, "khoa-e11-bat-01"));
      const kq = JSON.parse(tho) as Record<string, unknown>;
      expect(Object.keys(kq)).toEqual(["manager_salary_voucher_id", "approval_request_id", "manager_id", "state", "voucher_id", "balance_before"]);
      expect(kq).toMatchObject({ manager_id: QL1, state: "PENDING_APPROVAL", balance_before: QL1_GOC });
      const v = kq.voucher_id as string;
      expect(await mot(`SELECT jsonb_build_object('src', system_source, 'ql', profit_manager_id, 'st', approval_status, 'tong', total_amount, 'idem', idempotency_key,
        'maker', maker_user_id) AS v FROM public.income_expenses WHERE id = '${v}'`)).toEqual({ src: "profit.manager_salary", ql: QL1, st: "UNAPPROVED", tong: 20,
        idem: "khoa-e11-bat-01", maker: CHU });
      expect(await mot(`SELECT jsonb_build_object('k', subject_kind, 'ql', manager_id, 'w', within_amount, 'a', advance_amount, 'b', balance_before, 'mk', maker_kind,
        'pu', payee_user_id, 'rq', approval_request_id = '${kq.approval_request_id}') AS v FROM app_private.profit_ledger_payouts WHERE voucher_id = '${v}'`))
        .toEqual({ k: "MANAGER", ql: QL1, w: 20, a: 0, b: QL1_GOC, mk: "OWNER", pu: CHI_LUONG, rq: true });
      expect(await dem("app_private.profit_ledger_events", `voucher_id = '${v}' AND event_kind = 'PAYOUT_CREATED' AND manager_id = '${QL1}'`)).toBe(1);
      expect(await dem("app_private.profit_ledger_write_contexts")).toBe(0);
      expect(await dem("app_private.accounting_chain_writer_xids")).toBe(0);
      expect((await soDu("MANAGER", QL1)).balance).toBe(30);
    });
  });
  it("sổ tổng BẬT: chi quá số còn lại ⇒ 22023 PROFIT_MANAGER_LEDGER_OVERDRAW + DETAIL; vừa đủ thì được", async () => {
    await trongGiaoDich(async () => {
      await datRoute("CANONICAL");
      await la(CHU, e11(QL1, 20, "khoa-e11-bat-02"));
      const r = await loiLa(CHU, e11(QL1, "30.01", "khoa-e11-bat-03"));
      expect(r).toMatchObject({ code: "22023", message: expect.stringContaining("PROFIT_MANAGER_LEDGER_OVERDRAW") });
      expect(JSON.parse(r!.detail!)).toEqual({ balance: 30, amount: 30.01, over: 0.01 });
      expect(await loiLa(CHU, e11(QL1, 30, "khoa-e11-bat-04"))).toBeNull();
      expect((await soDu("MANAGER", QL1)).balance).toBe(0);
    });
  });
  it("ĐÓNG BĂNG ⇒ 55000 PROFIT_LEDGER_FROZEN; quản lý đã xoá ⇒ 42501 như cũ; cờ cũ pay_manager.v1 tắt ⇒ câu báo cũ", async () => {
    await trongGiaoDich(async () => {
      await datRoute("FROZEN");
      expect(await loiLa(CHU, e11(QL1, 5, "khoa-e11-dong-01"))).toMatchObject({ code: "55000", message: expect.stringContaining("PROFIT_LEDGER_FROZEN") });
      await datRoute("CANONICAL");
      expect(await loiLa(CHU, e11(QL_XOA, 5, "khoa-e11-xoa-01"))).toMatchObject({ code: "42501", message: "Không tìm thấy quản lý hoặc quản lý chưa gán tổ chức" });
      await db.exec("UPDATE app_private.server_feature_flags SET mode = 'OFF' WHERE feature_key = 'shareholder_profit.pay_manager.v1'");
      expect(await loiLa(CHU, e11(QL1, 5, "khoa-e11-co-cu-1"))).toMatchObject({ code: "55000", message: "Writer lương điều hành chưa bật" });
    });
  });
  it("quyền giữ như cũ: chỉ pay_manager; người ngoài công ty / không quyền ⇒ 42501 cùng câu báo", async () => {
    await trongGiaoDich(async () => {
      await datRoute("CANONICAL");
      for (const u of [KHONG_QUYEN, NGOAI, TAM_UNG]) {
        expect(await loiLa(u, e11(QL1, 5, "khoa-e11-quyen-1")), u).toMatchObject({ code: "42501", message: "Không có quyền chi lương quản lý (shareholder_profit.pay_manager)" });
      }
      expect(await loiLa(CHI_LUONG, e11(QL1, 5, "khoa-e11-quyen-2"))).toBeNull();
    });
  });
  it("cùng khoá ⇒ y hệt (cả ở hai nhánh); kết quả lưu từ trước (chưa có voucher_id) được bổ sung voucher_id khi trả lại; số tiền NaN ⇒ từ chối", async () => {
    await trongGiaoDich(async () => {
      await datRoute("CANONICAL");
      const a = await la<string>(CHU, e11(QL1, 5, "khoa-e11-lap-01"));
      expect(JSON.parse(await la<string>(CHU, e11(QL1, 5, "khoa-e11-lap-01")))).toEqual(JSON.parse(a));
      await datRoute("LEGACY");
      expect(JSON.parse(await la<string>(CHU, e11(QL1, 5, "khoa-e11-lap-01")))).toEqual(JSON.parse(a));
      const PV = id(3201);
      await db.exec(`INSERT INTO app_private.canonical_write_operations(organization_id, operation, subject_scope, actor_id, idempotency_key, payload_hash, subject_id, response_payload, completed_at)
        VALUES ('${ORG_A}','shareholder_profit.pay_manager.v1','${QL1}','${CHU}','khoa-e11-cu-0001',
          md5(jsonb_build_object('manager','${QL1}'::uuid,'amount',round(7::numeric,2),'account','${SO_QUY}'::uuid,'voucher_date','2026-11-10'::date,'org','${ORG_A}'::uuid)::text),
          '${PV}', jsonb_build_object('manager_salary_voucher_id','${PV}','approval_request_id',NULL,'manager_id','${QL1}','state','PENDING_APPROVAL'), now())`);
      expect(JSON.parse(await la<string>(CHU, e11(QL1, 7, "khoa-e11-cu-0001")))).toMatchObject({ manager_salary_voucher_id: PV, voucher_id: PV });
      expect((await loiLa(CHU, e11(QL1, "'NaN'::numeric", "khoa-e11-nan-01")))?.message).toBe("Số tiền lương điều hành không hợp lệ");
    });
  });
});

describe("E8 / E9 — mốc 'đã trả đủ đến hết tháng X'", () => {
  it("SHADOW: xem trước rồi đặt mốc 07/2026 ⇒ số dư đúng như xem trước; đè mốc 08/2026; gỡ mốc trả về số dư không mốc", async () => {
    await trongGiaoDich(async () => {
      await datRoute("SHADOW");
      const xem = await la<Record<string, unknown>>(CHU, e8("SHAREHOLDER", CD1, "2026-07-01"));
      expect(xem).toMatchObject({ route: "SHADOW", current_marker: null, balance_now: CD1_GOC, balance_after: 50,
        excluded: { allocated: 100, payouts: 0, salary: 0 }, advance_erased: 0, requires_acknowledge: false });
      const dat = await la<Record<string, unknown>>(CHU, e9("SHAREHOLDER", CD1, "2026-07-01", null, false, "khoa-moc-0001"));
      expect(dat).toMatchObject({ settled_through_month: "2026-07-01", supersedes_id: null, balance_before: CD1_GOC, balance_after: 50, advance_erased: 0 });
      expect((await soDu("SHAREHOLDER", CD1)).balance).toBe(50);
      const m1 = dat.marker_id as string;
      expect(await mocHieuLuc("SHAREHOLDER", CD1)).toBe(m1);
      const dat2 = await la<Record<string, unknown>>(CHU, e9("SHAREHOLDER", CD1, "2026-08-01", m1, false, "khoa-moc-0002"));
      expect(dat2).toMatchObject({ supersedes_id: m1, balance_before: 50, balance_after: 0 });
      expect((await la<Record<string, unknown>>(CHU, e8("SHAREHOLDER", CD1, null))).balance_after).toBe(CD1_GOC);
      const go = await la<Record<string, unknown>>(CHU, e9("SHAREHOLDER", CD1, null, dat2.marker_id as string, false, "khoa-moc-0003"));
      expect(go).toMatchObject({ settled_through_month: null, balance_after: CD1_GOC });
      expect((await soDu("SHAREHOLDER", CD1)).balance).toBe(CD1_GOC);
      expect(await mot(`SELECT jsonb_agg(jsonb_build_array(event_kind, balance_before, balance_after, reason) ORDER BY created_at) AS v FROM app_private.profit_ledger_events`))
        .toEqual([["MARKER_SET", 150, 50, "Đã trả đủ theo sổ tay"], ["MARKER_SET", 50, 0, "Đã trả đủ theo sổ tay"], ["MARKER_SET", 0, 150, "Đã trả đủ theo sổ tay"]]);
    });
  });
  it("CAS: mốc mong đợi sai (kể cả NULL khi đã có mốc) ⇒ PT409 (HTTP 409, PostgREST không tự chạy lại) + DETAIL mốc hiện tại; không ghi gì", async () => {
    await trongGiaoDich(async () => {
      await datRoute("CANONICAL");
      const m1 = (await la<Record<string, string>>(CHU, e9("SHAREHOLDER", CD1, "2026-07-01", null, false, "khoa-cas-0001"))).marker_id;
      for (const cu of [null, id(999)]) {
        const r = await loiLa(CHU, e9("SHAREHOLDER", CD1, "2026-08-01", cu, false, `khoa-cas-${cu ? "sai" : "rong"}`));
        expect(r, String(cu)).toMatchObject({ code: "PT409", message: expect.stringContaining("PROFIT_LEDGER_MARKER_CHANGED") });
        expect(JSON.parse(r!.detail!)).toEqual({ current_marker_id: m1, expected_marker_id: cu });
      }
      expect(await dem("app_private.profit_ledger_markers")).toBe(1);
    });
  });
  it("mốc xoá dấu tạm ứng: không xác nhận ⇒ 22023 PROFIT_LEDGER_MARKER_ERASES_ADVANCE + DETAIL; có xác nhận ⇒ ghi advance_erased; xem trước báo cùng số", async () => {
    await trongGiaoDich(async () => {
      await datRoute("CANONICAL");
      await la(CHU, e5({ cd: CD_TU, tien: 50, tamUng: true, khoa: "khoa-tam-ung-01" })); // trong 30, tạm ứng 20 ⇒ số dư −20
      const xem = await la<Record<string, unknown>>(CHU, e8("SHAREHOLDER", CD_TU, "2026-08-01"));
      expect(xem).toMatchObject({ balance_now: -20, balance_after: 0, advance_erased: 20, requires_acknowledge: true });
      for (const xn of [false, null]) {
        const r = await loiLa(CHU, e9("SHAREHOLDER", CD_TU, "2026-08-01", null, xn, "khoa-xoa-dau-01"));
        expect(r).toMatchObject({ code: "22023", message: expect.stringContaining("PROFIT_LEDGER_MARKER_ERASES_ADVANCE") });
        expect(JSON.parse(r!.detail!)).toEqual({ advance_erased: 20, balance_now: -20, balance_after: 0 });
      }
      const dat = await la<Record<string, unknown>>(CHU, e9("SHAREHOLDER", CD_TU, "2026-08-01", null, true, "khoa-xoa-dau-02"));
      expect(dat).toMatchObject({ advance_erased: 20, balance_before: -20, balance_after: 0 });
      expect(await mot("SELECT advance_erased::float8 AS v FROM app_private.profit_ledger_markers")).toBe(20);
      // Gỡ mốc khi số dư không âm và mốc mới không loại gì ⇒ không đòi xác nhận.
      expect(await loiLa(CHU, e9("SHAREHOLDER", CD_TU, null, dat.marker_id as string, false, "khoa-xoa-dau-03"))).toBeNull();
    });
  });
  it("phiếu có phần tạm ứng mà mốc loại vẫn đòi xác nhận dù tháng sau đã bù (số dư dương): advance_erased = Σ phần tạm ứng của phiếu còn sống", async () => {
    await trongGiaoDich(async () => {
      await datRoute("CANONICAL");
      await la(CHU, e5({ cd: CD_TU, tien: 50, tamUng: true, khoa: "khoa-tam-ung-02" })); // tạm ứng 20
      await db.exec(`INSERT INTO public.profit_monthly(id, organization_id, building_id, period_month, status) VALUES ('${id(3301)}','${ORG_A}','${TOA_1}','2026-09-01','LOCKED');
        INSERT INTO public.profit_allocations(profit_monthly_id, shareholder_id, amount) VALUES ('${id(3301)}','${CD_TU}', 100)`);
      const xem = await la<Record<string, unknown>>(CHU, e8("SHAREHOLDER", CD_TU, "2026-08-01"));
      expect(xem).toMatchObject({ balance_now: 80, balance_after: 100, advance_erased: 20, requires_acknowledge: true });
      expect(await loiLa(CHU, e9("SHAREHOLDER", CD_TU, "2026-08-01", null, false, "khoa-xoa-dau-04")))
        .toMatchObject({ code: "22023", message: expect.stringContaining("PROFIT_LEDGER_MARKER_ERASES_ADVANCE") });
      // Phiếu tạm ứng bị từ chối (không còn sống) thì không tính.
      await db.exec(`UPDATE public.approval_requests SET state = 'REJECTED'`);
      expect(await la(CHU, e8("SHAREHOLDER", CD_TU, "2026-08-01"))).toMatchObject({ balance_now: 130, advance_erased: 0, requires_acknowledge: false });
    });
  });
  it("quyền: cổ đông cần distribute, lương điều hành cần pay_manager; không quyền / ngoài công ty ⇒ 42501; chủ thể khác công ty ⇒ P0002", async () => {
    await trongGiaoDich(async () => {
      await datRoute("CANONICAL");
      expect((await loiLa(CHI_LUONG, e9("SHAREHOLDER", CD1, "2026-07-01", null, true, "khoa-quyen-moc1")))?.code).toBe("42501");
      expect((await loiLa(CHI_LUONG, e8("SHAREHOLDER", CD1, "2026-07-01")))?.code).toBe("42501");
      expect(await la(CHI_LUONG, e8("MANAGER", QL1, "2026-07-01"))).toMatchObject({ balance_after: 20 });
      expect(await la(CHI_LUONG, e9("MANAGER", QL1, "2026-07-01", null, false, "khoa-quyen-moc2"))).toMatchObject({ balance_after: 20 });
      for (const u of [KHONG_QUYEN, TAM_UNG, NGOAI, null]) {
        expect((await loiLa(u, e9("SHAREHOLDER", CD1, "2026-07-01", null, true, "khoa-quyen-moc3")))?.code, String(u)).toBe("42501");
        expect((await loiLa(u, e8("SHAREHOLDER", CD1, "2026-07-01")))?.code, String(u)).toBe("42501");
      }
      expect((await loiLa(CHU, e9("SHAREHOLDER", CD_B, "2026-07-01", null, true, "khoa-quyen-moc4")))?.code).toBe("P0002");
      expect((await loiLa(CHU, e8("SHAREHOLDER", CD_B, "2026-07-01")))?.code).toBe("P0002");
    });
  });
  it("công tắc: TẮT ⇒ 55000 PROFIT_LEDGER_ROUTE_OFF, ĐÓNG BĂNG ⇒ 55000 PROFIT_LEDGER_FROZEN (E8 vẫn xem được và báo route)", async () => {
    await trongGiaoDich(async () => {
      for (const [route, ma] of [["LEGACY", "PROFIT_LEDGER_ROUTE_OFF"], ["FROZEN", "PROFIT_LEDGER_FROZEN"]] as const) {
        await datRoute(route);
        expect(await loiLa(CHU, e9("SHAREHOLDER", CD1, "2026-07-01", null, true, `khoa-route-${route}`)), route)
          .toMatchObject({ code: "55000", message: expect.stringContaining(ma) });
        expect(await la(CHU, e8("SHAREHOLDER", CD1, "2026-07-01"))).toMatchObject({ route, balance_after: 50 });
      }
      expect(await dem("app_private.profit_ledger_markers")).toBe(0);
    });
  });
  it("đầu vào: tháng HIỆN TẠI / tương lai ⇒ 22023 PROFIT_LEDGER_MARKER_MONTH; không phải ngày 1 / vô cực ⇒ 22023; lý do < 8 hoặc > 1000 ký tự ⇒ 22023; loại lạ ⇒ 22023", async () => {
    await trongGiaoDich(async () => {
      await datRoute("CANONICAL");
      // "Hôm nay" = 15/11/2026 ⇒ tháng 11 chưa kết thúc: mốc ở đó sẽ lặng lẽ loại phân bổ tháng 11 khi chốt sau này.
      for (const thang of ["2026-11-01", "2026-12-01"]) {
        const r9 = await loiLa(CHU, e9("SHAREHOLDER", CD1, thang, null, true, "khoa-dau-moc-0"));
        expect(r9, thang).toMatchObject({ code: "22023", message: expect.stringContaining("PROFIT_LEDGER_MARKER_MONTH") });
        expect(JSON.parse(r9!.detail!)).toEqual({ settled_through_month: thang, current_month: "2026-11-01" });
        expect(await loiLa(CHU, e8("SHAREHOLDER", CD1, thang)), thang)
          .toMatchObject({ code: "22023", message: expect.stringContaining("PROFIT_LEDGER_MARKER_MONTH") });
      }
      expect((await loiChu(`SELECT app_private.profit_ledger_tao_set_marker_v1('${ORG_A}','SHAREHOLDER','${CD1}', '2026-11-01',
        'Chuyển đổi số liệu cũ', NULL, true, 'khoa-dau-moc-n', '${CHU}')`))?.message).toContain("PROFIT_LEDGER_MARKER_MONTH");
      // Sang ngày 01/12 thì tháng 11 đã qua ⇒ được; tháng 12 (đang chạy, dù mới ngày đầu) vẫn bị chặn.
      // (Đợt 3 đặt mốc 2026-09 và 2026-05 — đều là tháng đã qua.)
      await db.exec("SELECT set_config('test.today', '2026-12-01', true)");
      expect(await la(CHU, e8("SHAREHOLDER", CD1, "2026-11-01"))).toMatchObject({ balance_after: 0 });
      expect((await loiLa(CHU, e9("SHAREHOLDER", CD1, "2026-12-01", null, true, "khoa-dau-moc-d")))?.message).toContain("PROFIT_LEDGER_MARKER_MONTH");
      await db.exec("SELECT set_config('test.today', '', true)");
      for (const thang of ["2026-07-15", "infinity"]) {
        expect((await loiLa(CHU, e9("SHAREHOLDER", CD1, thang, null, true, "khoa-dau-moc-1")))?.code, thang).toBe("22023");
        expect((await loiLa(CHU, e8("SHAREHOLDER", CD1, thang)))?.code, thang).toBe("22023");
      }
      expect(await la(CHU, e8("SHAREHOLDER", CD1, "2026-10-01"))).toMatchObject({ balance_after: 0 });
      for (const lyDo of ["ngắn", " ".repeat(20), "x".repeat(1001)]) {
        expect((await loiLa(CHU, e9("SHAREHOLDER", CD1, "2026-07-01", null, true, "khoa-dau-moc-2", lyDo)))?.code).toBe("22023");
      }
      expect((await loiLa(CHU, e9("CO_DONG", CD1, "2026-07-01", null, true, "khoa-dau-moc-3")))?.code).toBe("22023");
      expect((await loiLa(CHU, e8("CO_DONG", CD1, "2026-07-01")))?.code).toBe("22023");
      expect(await dem("app_private.profit_ledger_markers")).toBe(0);
    });
  });
  it("cùng khoá ⇒ y hệt; cùng khoá khác tháng / lý do ⇒ 23505", async () => {
    await trongGiaoDich(async () => {
      await datRoute("CANONICAL");
      const a = await la(CHU, e9("SHAREHOLDER", CD1, "2026-07-01", null, false, "khoa-moc-lai-1"));
      expect(await la(CHU, e9("SHAREHOLDER", CD1, "2026-07-01", null, false, "khoa-moc-lai-1"))).toEqual(a);
      expect((await loiLa(CHU, e9("SHAREHOLDER", CD1, "2026-08-01", null, false, "khoa-moc-lai-1")))?.code).toBe("23505");
      expect((await loiLa(CHU, e9("SHAREHOLDER", CD1, "2026-07-01", null, false, "khoa-moc-lai-1", "Lý do khác hẳn")))?.code).toBe("23505");
      expect(await dem("app_private.profit_ledger_markers")).toBe(1);
    });
  });
  it("phiếu lập SAU mốc vẫn bị trừ (thứ tự sổ lớn hơn); phiếu lập trước mốc bị mốc loại", async () => {
    await trongGiaoDich(async () => {
      await datRoute("CANONICAL");
      await la(CHU, e5({ tien: 40, khoa: "khoa-truoc-moc" }));
      const dat = await la<Record<string, unknown>>(CHU, e9("SHAREHOLDER", CD1, "2026-07-01", null, false, "khoa-moc-giua"));
      expect(dat.balance_after).toBe(50);
      await la(CHU, e5({ tien: 30, khoa: "khoa-sau-moc-01" }));
      const sd = await soDu("SHAREHOLDER", CD1);
      expect(sd).toMatchObject({ balance: 20, payouts_pending: 30, excluded_before_marker: { allocated: 100, payouts: 40, salary: 0 } });
    });
  });
  it("phần ghi nội bộ (cho migration chuyển đổi Đợt 3): chủ làm actor ⇒ được; actor không quyền / thiếu ⇒ 42501", async () => {
    await trongGiaoDich(async () => {
      await datRoute("SHADOW");
      const goi = (actor: string | null, khoa: string) => `SELECT app_private.profit_ledger_tao_set_marker_v1('${ORG_A}','SHAREHOLDER','${CD1}', '2026-08-01',
        'Chuyển đổi số liệu cũ', NULL, false, '${khoa}', ${q(actor)}) AS v`;
      expect((await loiChu(goi(KHONG_QUYEN, "khoa-dot3-0001")))?.code).toBe("42501");
      expect((await loiChu(goi(null, "khoa-dot3-0002")))?.code).toBe("42501");
      expect(await mot<Record<string, unknown>>(goi(CHU, "khoa-dot3-0003"))).toMatchObject({ balance_after: 0, balance_before: CD1_GOC });
      expect(await mot("SELECT created_by AS v FROM app_private.profit_ledger_markers")).toBe(CHU);
    });
  });
  it("E8 chạy được trong giao dịch CHỈ ĐỌC dưới vai authenticated", async () => {
    await db.exec("BEGIN READ ONLY");
    try {
      expect(await la(CHU, e8("SHAREHOLDER", CD1, "2026-08-01"))).toMatchObject({ balance_after: 0 });
      expect(await la(CHI_LUONG, e8("MANAGER", QL1, null))).toMatchObject({ balance_after: QL1_GOC });
    } finally { await db.exec("ROLLBACK"); }
  });
});

describe("E8 xem trước == số dư thật sau E9 (kịch bản ngẫu nhiên, mô phỏng nhóm của M1)", () => {
  let hat = 20261116;
  const rnd = () => {
    hat = (hat + 0x6d2b79f5) | 0;
    let t = Math.imul(hat ^ (hat >>> 15), 1 | hat);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const nguyen = (a: number, b: number) => a + Math.floor(rnd() * (b - a + 1));
  const chon = <T,>(ds: readonly T[]): T => ds[Math.floor(rnd() * ds.length)];
  const xs = (p: number) => rnd() < p;
  const THANG = ["2026-01-01", "2026-02-01", "2026-03-01", "2026-04-01", "2026-05-01", "2026-06-01", "2026-09-01", "2026-10-01"];
  const TRANG_THAI_YC = ["PENDING_APPROVAL", "APPROVED", "DENIED", "REJECTED", "CANCELLED", "CHANGES_REQUESTED"];
  const CHU_THE: [string, string][] = [["SHAREHOLDER", CD1], ["SHAREHOLDER", CD_TU], ["MANAGER", QL1]];
  const thongKe = { kichBan: 0, so: 0, xoaDau: 0, loaiPhieu: 0, coMocCu: 0, goMoc: 0 };

  async function kichBan(k: number) {
    let n = 7000;
    const moi = () => id(n++);
    await datRoute(xs(0.5) ? "SHADOW" : "CANONICAL");
    for (const th of THANG) {
      if (xs(0.35)) continue;
      const pm = moi();
      await db.exec(`INSERT INTO public.profit_monthly(id, organization_id, building_id, period_month, status, is_stale)
        VALUES ('${pm}','${ORG_A}','${moi()}','${th}','${xs(0.8) ? "LOCKED" : "DRAFT"}', ${xs(0.3)})`);
      for (const cd of [CD1, CD_TU]) if (xs(0.8)) await db.exec(`INSERT INTO public.profit_allocations(profit_monthly_id, shareholder_id, amount) VALUES ('${pm}','${cd}', ${nguyen(-40, 200)})`);
      if (xs(0.6)) await db.exec(`INSERT INTO public.profit_manager_allocations(profit_monthly_id, manager_id, amount) VALUES ('${pm}','${QL1}', ${nguyen(0, 60)})`);
    }
    const viec = [...Array<string>(nguyen(3, 10)).fill("phieu"), ...Array<string>(nguyen(0, 3)).fill("moc"), ...Array<string>(nguyen(0, 3)).fill("luong")]
      .map((v) => ({ v, r: rnd() })).sort((a, b) => a.r - b.r).map((x) => x.v);
    for (const v of viec) {
      const [loai, chuThe] = chon(CHU_THE);
      if (v === "phieu") {
        const P = moi();
        const tien = nguyen(1, 120);
        await taoPhieu({ id: P, tien, coDong: loai === "SHAREHOLDER" ? chuThe : undefined, quanLy: loai === "MANAGER" ? chuThe : undefined,
          trangThai: chon(["APPROVED", "UNAPPROVED", "UNAPPROVED", "CANCELLED"]) });
        if (xs(0.7)) await ghiDongPhieu(P, loai, chuThe, tien, loai === "SHAREHOLDER" && xs(0.5) ? nguyen(0, tien) : 0);
        for (let i = 0; i < chon([0, 0, 1, 2]); i++) {
          await db.exec(`INSERT INTO public.approval_requests(organization_id, submission_no, subject_type, subject_id, state)
            VALUES ('${ORG_A}', ${i + 1}, 'FINANCIAL_VOUCHER', '${P}', '${i === 0 ? chon(TRANG_THAI_YC.filter((s) => s !== "PENDING_APPROVAL")) : chon(TRANG_THAI_YC)}')`);
        }
      } else if (v === "moc") {
        const cu = await mocHieuLuc(loai, chuThe);
        await la(CHU, e9(loai, chuThe, xs(0.2) ? null : chon(THANG), cu, true, `khoa-nn-${k}-${n++}`));
      } else if (loai === "SHAREHOLDER") {
        const PL = moi();
        await db.exec(`INSERT INTO public.income_expenses(id, user_id, organization_id, type, name, building_id, voucher_date, total_amount, account_id, approval_status)
          VALUES ('${PL}','${CHU}','${ORG_A}','EXPENSE','Lương','${TOA_1}','2026-10-31', 100, '${SO_QUY}', '${chon(["APPROVED", "APPROVED", "CANCELLED"])}');
          INSERT INTO app_private.profit_ledger_salary_settlement_vouchers(organization_id, shareholder_id, staff_id, period_month, salary_voucher_id,
            investment_amount, advance_offset_amount, sheet_status_at_quote, source, state, linked_at)
          VALUES ('${ORG_A}','${chuThe}','${CHU}','${chon(THANG)}','${PL}', ${nguyen(-20, 80)}, ${nguyen(0, 30)}, 'LOCKED','PAYOUT_FALLBACK','LINKED', clock_timestamp())`);
      }
    }
    for (const [loai, chuThe] of CHU_THE) {
      const X = xs(0.15) ? null : chon(THANG);
      const cu = await mocHieuLuc(loai, chuThe);
      if (cu !== null) thongKe.coMocCu++;
      const xem = await la<Record<string, unknown>>(CHU, e8(loai, chuThe, X));
      const dat = await la<Record<string, unknown>>(CHU, e9(loai, chuThe, X, cu, true, `khoa-nn-dat-${k}-${loai}-${chuThe.slice(-3)}`));
      const that = await soDu(loai, chuThe);
      const nhan = `kịch bản ${k} · ${loai} ${chuThe.slice(-3)} · X=${X}`;
      expect(tron(xem.balance_after), nhan).toBe(tron(that.balance));
      expect(Object.fromEntries(Object.entries(xem.excluded as Record<string, number>).map(([a, b]) => [a, tron(b)])), nhan)
        .toEqual(Object.fromEntries(Object.entries(that.excluded_before_marker).map(([a, b]) => [a, tron(b)])));
      expect([tron(dat.balance_before), tron(dat.balance_after), tron(dat.advance_erased)], nhan)
        .toEqual([tron(xem.balance_now), tron(xem.balance_after), tron(xem.advance_erased)]);
      expect(that.marker?.id, nhan).toBe(dat.marker_id);
      thongKe.so++;
      if (Number(xem.advance_erased) > 0) thongKe.xoaDau++;
      if (Number((xem.excluded as { payouts: number }).payouts) !== 0) thongKe.loaiPhieu++;
      if (X === null) thongKe.goMoc++;
    }
    thongKe.kichBan++;
  }

  it("40 kịch bản (phân bổ, phiếu có / không dòng sổ, tạm ứng, yêu cầu duyệt, dòng lương, mốc cũ): xem trước = số dư thật, phần bị loại khớp, E9 báo đúng số xem trước", async () => {
    for (let k = 1; k <= 40; k++) await trongGiaoDich(() => kichBan(k));
    expect(thongKe.kichBan).toBe(40);
    expect(thongKe.so).toBe(120);
    // Chống xanh rỗng: đủ ca mốc có xoá dấu tạm ứng, loại phiếu, đè mốc cũ và gỡ mốc.
    expect(thongKe.xoaDau).toBeGreaterThan(15);
    expect(thongKe.loaiPhieu).toBeGreaterThan(40);
    expect(thongKe.coMocCu).toBeGreaterThan(10);
    expect(thongKe.goMoc).toBeGreaterThan(5);
  }, 240000);
});

describe("chạy như lane: dán thân HAI lần trong MỘT giao dịch (trước đó chưa áp)", () => {
  it("lượt một áp, lượt hai nhận thân của chính nó; ROLLBACK trả nguyên thân cũ", async () => {
    const lan = new PGlite();
    try {
      await dungCoSo(lan);
      await lan.exec(M1);
      const than = MIGRATION.replace(/^BEGIN;\s*$/m, "").replace(/^COMMIT;\s*$/m, "").replace(/^NOTIFY pgrst, 'reload schema';\s*$/m, "");
      expect(than).not.toMatch(/^(BEGIN|COMMIT);/m);
      await lan.exec(`BEGIN; ${than} ${than} ROLLBACK;`);
      const m = (await lan.query<{ v: string }>(`SELECT md5(replace(prosrc, chr(13), '')) AS v FROM pg_proc WHERE oid = 'public.manager_salary_payout_v1(uuid,numeric,uuid,date,text,text)'::regprocedure`)).rows[0].v;
      expect(m).toBe(MD5_CU.e11);
    } finally { await lan.close(); }
  }, 120000);
  it("đè lên bản TRƯỚC đã áp (CAS 40001, như TEST 15/11): khối ghim nhận các thân do bản trước ghi; sau đó E9 ném PT409", async () => {
    const lan = new PGlite();
    try {
      await dungCoSo(lan);
      await lan.exec(M1);
      const banTruoc = MIGRATION.replace("USING ERRCODE = 'PT409',", "USING ERRCODE = '40001',");
      expect(banTruoc).not.toBe(MIGRATION);
      const thanE9 = async () => (await lan.query<{ v: string }>(`SELECT prosrc AS v FROM pg_proc
        WHERE oid = 'app_private.profit_ledger_tao_set_marker_v1(uuid,text,uuid,date,text,uuid,boolean,text,uuid)'::regprocedure`)).rows[0].v;
      await lan.exec(banTruoc);
      expect(await thanE9()).toContain("ERRCODE = '40001'");
      await lan.exec(MIGRATION);
      expect(await thanE9()).toContain("ERRCODE = 'PT409'");
      expect(await thanE9()).not.toContain("ERRCODE = '40001'");
      const md5Lan = async (ham: string) => (await lan.query<{ v: string }>(`SELECT md5(replace(prosrc, chr(13), '')) AS v FROM pg_proc WHERE oid = to_regprocedure('${ham}')`)).rows[0].v;
      expect({
        e11: await md5Lan("public.manager_salary_payout_v1(uuid,numeric,uuid,date,text,text)"),
        f4: await md5Lan("app_private.guard_profit_payout_scope_compat_v1()"),
        ie: await md5Lan("public.ie_compat_insert_v2(jsonb,jsonb)"),
      }).toEqual(MD5_MOI);
    } finally { await lan.close(); }
  }, 120000);
});

describe("[ghim] khối ghim md5: thân lạ ⇒ dừng 55000, không ghi đè", () => {
  const than = MIGRATION.replace(/^BEGIN;\s*$/m, "").replace(/^COMMIT;\s*$/m, "").replace(/^NOTIFY pgrst, 'reload schema';\s*$/m, "");
  const ca: [string, string][] = [
    ["E11", E11_CU.replace("'Writer lương điều hành chưa bật'", "'Writer lương điều hành tắt'").replace("CREATE FUNCTION", "CREATE OR REPLACE FUNCTION")],
    ["F4", F4_CU.replace("'Profit payout requires a real cashbook account'", "'Profit payout requires a cashbook'").replace("CREATE FUNCTION", "CREATE OR REPLACE FUNCTION")],
    ["ie_compat", IE_CU.replace("'active organization membership required'", "'membership required'")],
  ];
  for (const [ten, la_] of ca) {
    it(`[ghim] thân ${ten} lạ ⇒ 55000`, async () => {
      await trongGiaoDich(async () => {
        await db.exec(la_);
        const r = await loiChu(than);
        expect(r?.code).toBe("55000");
        expect(r?.message).toMatch(/đã đổi so với bản đã rà/);
      });
    });
  }
});
