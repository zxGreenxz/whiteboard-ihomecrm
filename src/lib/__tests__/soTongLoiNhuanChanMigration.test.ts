import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * Migration 20261115084015 (M2-chặn của sổ tổng lợi nhuận): F1 chốt phiếu chi theo sổ tổng trên
 * income_expenses, F2 chốt dòng hạng mục, F5 chốt yêu cầu duyệt, E6 lệnh huỷ có lý do.
 *
 * Chạy THẬT trên PostgreSQL nhúng:
 *  - các RPC vòng đời V2 mà màn Chờ duyệt dùng (approve_income_expense_v2, post_approved_income_expense_v2,
 *    approve_and_post_income_expense_v2) cùng các RPC "đường vòng" (unapprove_voucher, restore_income_expense,
 *    request_income_expense_changes_v2, mark_income_expense_disputed_v2, withdraw_income_expense_v2,
 *    reject_invalid_income_expense_v2, withdraw_financial_request_v1, decide_financial_request_v2) và mọi hàm
 *    chúng gọi (authorize_tenant_action_v3, assert_cashbook_access_v2, finance_v2_post_manual_voucher, trigger
 *    a75/a86/a87…) là THÂN PRODUCTION lấy từ file đã phát hành trong repo — mỗi thân được chọn theo md5 đo trên
 *    TEST (bản sao production) và đo lại sau khi nạp;
 *  - nền M1 (20261115063149) nạp trước, rồi file này HAI lượt;
 *  - mỗi ca chạy trong một giao dịch rồi ROLLBACK (riêng ca khoá sổ COMMIT một phiếu của chủ thể chỉ dùng ở ca đó,
 *    để đo khoá sổ do bước duyệt lấy ở giao dịch sau).
 * Thay bằng bản giả (không phải đối tượng đang kiểm): submit_financial_request_v1 (máy luật duyệt — ở đây chỉ tạo
 * yêu cầu + bước + ứng viên), evaluate_feature_route (đọc bảng test_route), append_income_expense_event_v1,
 * finance_v2_log_event, org_today_v1. Ranh giới "lập ở giao dịch trước" của assert_committed_birth_boundary_v2
 * được giả lập bằng birth_txid giả đặt trong ngữ cảnh LẬP.
 * reverse_posted_income_expense_v2, create_cash_handover, verify / annotate: dùng đúng câu UPDATE của thân
 * production (vỏ của chúng kéo theo cả bộ hoa hồng / hồ sơ); RPC thật của các đường đó chạy trên TEST.
 * Ca hai phiên (duyệt vs huỷ, 40P01) không chạy được ở đây (một kết nối): ca "duyệt thắng khoá hàng rồi lệnh huỷ mới
 * đọc phiếu" được dựng tuần tự (duyệt xong mới huỷ với trạng thái kỳ vọng cũ) — đúng cái lệnh huỷ thấy sau khi chờ khoá.
 * Trước lượt đầu dựng bản E6 cũ 3 tham số như TEST đang có, để chứng minh migration đè lên được.
 */
const DIR = "supabase/migrations";
const FILE = `${DIR}/20261115084015_so_tong_loi_nhuan_chan.sql`;
const FILE_M1 = `${DIR}/20261115063149_so_tong_loi_nhuan_nen.sql`;
const FILE_VA_GHI_SO = `${DIR}/20261018031847_commission_canonical_post_cashbook.sql`;
const BASELINE = "supabase/baseline/schema.sql";
const CO = "shareholder_profit.ledger_payout.v1";

/** md5(thân, bỏ CR) của production — đo trên TEST (bản sao production) 15/11/2026. */
const MD5_PROD: Record<string, string> = {
  "public.approve_income_expense_v2": "f22c6db558d841e8ab4f28a8a971dc17",
  "public.post_approved_income_expense_v2": "6e25865cd1aec905360b2ef3b67186c3",
  "public.approve_and_post_income_expense_v2": "20fe3cb99668dc5f283ec4a3a5018996",
  "public.withdraw_financial_request_v1": "e017dc822074b30cb800645d8dadeb48",
  "public.decide_financial_request_v2": "de18b25abe4d72a7de5eb9ff6b79e461",
  "public.unapprove_voucher": "abfd2a6a428aed3b643a7324eec67676",
  "public.restore_income_expense": "9f79d45d428515a1fbfadde654cd4f4a",
  "public.request_income_expense_changes_v2": "0cb30e2b755d50d81e8fbb09c7e3f743",
  "public.mark_income_expense_disputed_v2": "d5c8f77bc9a2862e2f1855efb0f4faa7",
  "public.withdraw_income_expense_v2": "ffc990af93f62496baeea41ed8de13cc",
  "public.reject_invalid_income_expense_v2": "c7e2d1c2d54a79599470bcbcdc829c34",
  "public.auto_calc_item_amount": "037af4afc27073c58aa025e3ffa6aaeb",
  "public.auto_recalc_total_amount": "6da3f0015db0aea9ec2751856d376cfa",
  "app_private.decide_financial_request_v1": "ca1ae67c8107bcb850aaf38b2fd2bd99",
  "app_private.is_eligible_current_candidate_v1": "5ab02d8a3f8034e618c43e51d304ca3d",
  "app_private.finance_v2_begin_canonical_op": "dced2c2d3dd2bc274c032bc707edbb95",
  "app_private.finance_v2_finish_canonical_op": "956db4e8b59eec2b68e6725fc1e8da47",
  "app_private.resolve_finance_actor_v2": "a6c972512f070ad0152962ec1761fd51",
  "app_private.current_uid_v1": "729cca15204558de823547e7e1854dea",
  "app_private.assert_income_expense_flow_owner_v2": "87b5e2ec735805f66e80e1765218eda4",
  "app_private.assert_committed_birth_boundary_v2": "532dc8daa6e2a9a3decaa94672a6f5a1",
  "app_private.finance_v2_post_manual_voucher": "c516d30bef09cc9ee2c04ace60fb37bd",
  "app_private.finance_v2_register_birth_v1": "0a60733f7616517419f12a789e436cd3",
  "app_private.finance_v2_birth_provenance_bridge": "e40537e161e3de038b62a141c143f384",
  "app_private.ie_normalize_lifecycle_columns": "623b03cc3df7ae66b134ca2f0b108cdf",
  "app_private.ie_cancel_close_request_v1": "25f3eebcbe2915a8ab87dc81203382b1",
  "app_private.finance_v2_auto_posting_bridge": "f3f413879dc796051bad0deb3f407184",
  "app_private.finance_v2_close_request_on_voucher_change": "ba9cd61006654b4841658832e493a90f",
  "app_private.authorize_tenant_action_v3": "9612dead197e08a5276650fbf69d0f99",
  "app_private.authorized_scope_v3": "af15b5b6607ed762a093f4706c9c2dd5",
  "app_private.profit_viewer_can_v1": "b7d03558d50e7bac488f5a90cb62fc9c",
  "app_private.raise_malformed_override": "a9b0c6f100cec28030f700ec7746c31e",
  "app_private.lock_org_for_decision_v1": "cd59b90fbbd143dab9cf0b21bf5d685d",
  "app_private.assert_cashbook_access_v2": "f2b4db2b384b7fabecb40f507eceb242",
  "app_private.finance_v2_has_covering_deny": "411e577c0858d32791e55715cd5f9c62",
  "app_private.finance_v2_is_cashbook_period_open": "d2a56d58d816bd14dd05c80331e27b24",
  "app_private.assert_no_engine_request_v1": "89fc62b2f92fe7cbe8e35b58dfedabe4",
  "app_private.begin_accounting_chain_write_v1": "e71c30556c14518edd6d9adc8cc13746",
  "app_private.end_accounting_chain_write_v1": "5c0875f0af4d403124955e01d3d193fe",
  "app_private.assert_period_open_for_edit_v1": "550afabb6b9683021cd95c17354e4156",
  "app_private.assert_profit_month_open_v2": "b38b980e15217fd633299979a64e7815",
  "app_private.profit_month_locked_v1": "5afe2d067b4e98a98ebeffa668269d3b",
  "app_private.cashbook_closed_through_v1": "b0acca4f91a7f7511f977c78567a16e7",
};
/** Hai RPC ghi sổ trên production = thân baseline + bản vá động 20261018031847 (không file nào chứa nguyên văn). */
const MD5_TRUOC_VA: Record<string, string> = {
  "public.post_approved_income_expense_v2": "9cb352aa4f544ccc850e663a4f2fb3b9",
  "public.approve_and_post_income_expense_v2": "0483bd6410ca6537ff3114731a50cde8",
};

const md5 = (s: string) => createHash("md5").update(s.replace(/\r/g, "")).digest("hex");
type ThanHam = { stmt: string; body: string };
/** Mọi câu CREATE FUNCTION trong migration (theo thứ tự tên) + baseline, gom theo tên hàm. */
function gomDinhNghia(): Map<string, ThanHam[]> {
  const out = new Map<string, ThanHam[]>();
  const nguon = readdirSync(DIR).filter((f) => f.endsWith(".sql")).sort().map((f) => readFileSync(`${DIR}/${f}`, "utf8"));
  nguon.push(readFileSync(BASELINE, "utf8"));
  const re = /CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+([a-z_]+\.[a-z_0-9]+)\s*\(/gi;
  for (const sql of nguon) {
    let m: RegExpExecArray | null;
    while ((m = re.exec(sql))) {
      const sau = sql.slice(m.index);
      const the = /\bAS\s+(\$[a-z_]*\$)/i.exec(sau);
      if (!the) continue;
      const batDau = the.index + the[0].length;
      const dong = sau.indexOf(the[1], batDau);
      if (dong < 0) continue;
      const stmt = sau.slice(0, sau.indexOf(";", dong) + 1);
      const ten = m[1].toLowerCase();
      out.set(ten, [...(out.get(ten) ?? []), { stmt, body: sau.slice(batDau, dong) }]);
    }
  }
  return out;
}
const DINH_NGHIA = gomDinhNghia();
/** Câu tạo hàm có thân trùng md5 production (bản cuối cùng khớp). Không có ⇒ ném lỗi (thân trong repo đã lệch). */
function thanTheoMd5(ten: string, ma: string): string {
  const hit = (DINH_NGHIA.get(ten) ?? []).filter((d) => md5(d.body) === ma).at(-1);
  if (!hit) throw new Error(`Không có định nghĩa nào của ${ten} khớp md5 ${ma}`);
  return hit.stmt;
}
const VA_GHI_SO = (() => {
  const sql = readFileSync(FILE_VA_GHI_SO, "utf8");
  const a = sql.indexOf("DO $patch$");
  return sql.slice(a, sql.indexOf("$patch$;", a + 10) + "$patch$;".length);
})();
const MIGRATION = readFileSync(FILE, "utf8");
const MIGRATION_M1 = readFileSync(FILE_M1, "utf8");

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const mem = (user: string) => user.replace("4000-8000-0000000000", "4000-8000-1000000000");
const [ORG_A, ORG_B] = [1, 2].map(id);
// CHU_A, CHU_B: chủ (chi lợi nhuận, trả lương điều hành, duyệt thu chi). GIU_SO: giữ sổ SO_A, là cổ đông CD1, không quyền chi.
// DUYET: chỉ có quyền duyệt thu chi. NGOAI: thành viên công ty khác. SUPER: super admin (không là thành viên).
const [CHU_A, CHU_B, GIU_SO, DUYET, NGOAI, SUPER] = [11, 12, 13, 14, 15, 16].map(id);
const [VAI_CHU, VAI_DUYET, VAI_CHU_B] = [31, 32, 33].map(id);
const [PHAM_VI_A, PHAM_VI_B] = [41, 42].map(id);
// SO_D: sổ chỉ GIU_SO giữ (ca hệ quả fail-closed của lệnh huỷ phiếu đã chi).
const [TOA_AO, TOA_THUONG, TOA_B, SO_A, SO_B, SO_C, SO_D] = [51, 52, 53, 54, 55, 56, 57].map(id);
// CD_KHOA: chỉ dùng cho ca khoá sổ (phiếu của nó được COMMIT để khoá sổ lúc duyệt đo được ở giao dịch sau).
const [CD1, CD2, CD_CHU_B, CD_KHOA, QL1] = [61, 62, 63, 64, 71].map(id);
const [PM_07, PM_08] = [81, 82].map(id);
const LOAI_CLN = id(91);
const NGAY = "2026-11-10";

const NEN = String.raw`
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
  CREATE TABLE public.organization_memberships(id uuid PRIMARY KEY, user_id uuid, organization_id uuid, status text DEFAULT 'ACTIVE',
    revoked_at timestamptz, valid_from timestamptz, valid_to timestamptz);
  CREATE TABLE app_private.tenant_emergency_denies(organization_id uuid, permission_key text, active_from timestamptz, expires_at timestamptz);
  CREATE TABLE public.member_permission_overrides(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid, membership_id uuid,
    permission_key text, effect text, revoked_at timestamptz, expires_at timestamptz, scope_mode text NOT NULL DEFAULT 'ORGANIZATION');
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
  CREATE TABLE public.cashbook_possession_bindings(organization_id uuid, membership_id uuid, cashbook_id uuid, possession_kind text, valid_from timestamptz, valid_to timestamptz);
  CREATE TABLE public.buildings(id uuid PRIMARY KEY, organization_id uuid, user_id uuid, name text, deleted_at timestamptz, is_virtual boolean NOT NULL DEFAULT false);
  CREATE TABLE public.accounts(id uuid PRIMARY KEY, organization_id uuid, user_id uuid, name text, deleted_at timestamptz,
    is_virtual boolean NOT NULL DEFAULT false, lock_date date);
  CREATE TABLE app_private.server_feature_flags(feature_key text PRIMARY KEY, domain text NOT NULL,
    risk_class text NOT NULL DEFAULT 'MONEY', mode text NOT NULL DEFAULT 'OFF', force_freeze boolean NOT NULL DEFAULT false,
    config_version bigint NOT NULL DEFAULT 1, reason text, updated_by uuid, updated_at timestamptz NOT NULL DEFAULT now());
  -- Route của cờ do test đặt (bảng test_route); khoá khác coi như CANONICAL.
  CREATE TABLE public.test_route(feature_key text PRIMARY KEY, route text NOT NULL);
  CREATE FUNCTION app_private.evaluate_feature_route(p_feature_key text, p_organization_id uuid) RETURNS text LANGUAGE sql AS
    $$ SELECT COALESCE((SELECT r.route FROM public.test_route r WHERE r.feature_key = p_feature_key), 'CANONICAL') $$;
  CREATE FUNCTION public.org_today_v1(p_organization_id uuid DEFAULT NULL) RETURNS date LANGUAGE sql STABLE AS $$ SELECT DATE '2026-11-15' $$;
  CREATE TABLE public.shareholders(id uuid PRIMARY KEY, organization_id uuid NOT NULL REFERENCES public.organizations(id), auth_user_id uuid,
    name text NOT NULL, is_active boolean NOT NULL DEFAULT true, deleted_at timestamptz);
  CREATE UNIQUE INDEX shareholders_id_org_uq ON public.shareholders (id, organization_id);
  CREATE TABLE public.profit_managers(id uuid PRIMARY KEY, organization_id uuid NOT NULL REFERENCES public.organizations(id), auth_user_id uuid,
    name text NOT NULL, is_active boolean NOT NULL DEFAULT true, deleted_at timestamptz);
  CREATE TABLE public.profit_monthly(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL, building_id uuid NOT NULL,
    period_month date NOT NULL, status text NOT NULL DEFAULT 'DRAFT', is_stale boolean NOT NULL DEFAULT false, locked_at timestamptz,
    UNIQUE (building_id, period_month));
  CREATE TABLE public.profit_allocations(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    profit_monthly_id uuid NOT NULL REFERENCES public.profit_monthly(id) ON DELETE CASCADE,
    shareholder_id uuid NOT NULL REFERENCES public.shareholders(id) ON DELETE CASCADE,
    amount numeric(15,2) NOT NULL DEFAULT 0, organization_id uuid, UNIQUE (profit_monthly_id, shareholder_id));
  CREATE TABLE public.profit_manager_allocations(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    profit_monthly_id uuid NOT NULL REFERENCES public.profit_monthly(id) ON DELETE CASCADE,
    manager_id uuid NOT NULL REFERENCES public.profit_managers(id) ON DELETE CASCADE,
    amount numeric(15,2) NOT NULL DEFAULT 0, organization_id uuid, UNIQUE (profit_monthly_id, manager_id));
  CREATE TABLE public.income_expenses(
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL, user_id uuid, code text,
    type text NOT NULL CHECK (type IN ('INCOME','EXPENSE')), name text NOT NULL DEFAULT 'Phiếu', building_id uuid, room_id uuid,
    voucher_date date, total_amount numeric(15,2) NOT NULL DEFAULT 0,
    approval_status text NOT NULL DEFAULT 'APPROVED' CHECK (approval_status IN ('UNAPPROVED','APPROVED','CANCELLED')),
    approved_by uuid, approved_at timestamptz, notes text, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
    deleted_at timestamptz, account_id uuid, contract_id uuid, attachments jsonb NOT NULL DEFAULT '[]', business_result_accounting boolean,
    invoice_id uuid, payment_id uuid, change_amount numeric(15,2) NOT NULL DEFAULT 0, change_account_id uuid,
    rounding_amount numeric(15,2) DEFAULT 0, rounding_account_id uuid,
    verified_at timestamptz, verified_by uuid, verified_by_name text, verified_note text,
    counts_in_business_result boolean NOT NULL DEFAULT true,
    shareholder_id uuid REFERENCES public.shareholders(id) ON DELETE SET NULL, handover_id uuid,
    has_restricted_item boolean NOT NULL DEFAULT false, handover_transfer_id uuid, salary_staff_id uuid, salary_role text,
    profit_manager_id uuid REFERENCES public.profit_managers(id) ON DELETE SET NULL,
    kqkd_amount numeric(15,2) NOT NULL DEFAULT 0, system_source text, commission_kind text,
    approval_request_id uuid, posting_id uuid, posted_at_v2 timestamptz, idempotency_key text, reversed_by_posting_id uuid,
    source_payload_hash text, posting_mode text, posting_status text, active_posting_id_v2 uuid, recognition_date date,
    review_state text, review_owner_membership_id uuid, review_reason text, review_deadline timestamptz, change_field_mask jsonb,
    review_version bigint NOT NULL DEFAULT 1, approval_version bigint NOT NULL DEFAULT 1, posting_version bigint NOT NULL DEFAULT 1,
    cancellation_kind text, maker_user_id uuid, maker_membership_id uuid, birth_operation_id uuid, birth_txid xid8,
    CONSTRAINT ie_unapproved_review_state_ck CHECK ((deleted_at IS NOT NULL) OR (approval_status IS DISTINCT FROM 'UNAPPROVED')
      OR (review_state = ANY (ARRAY['PENDING','CHANGES_REQUESTED','DISPUTED']))));
  CREATE TABLE public.income_expense_items(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    income_expense_id uuid NOT NULL REFERENCES public.income_expenses(id) ON DELETE CASCADE, income_expense_type_id uuid NOT NULL,
    description text, quantity numeric(15,4) NOT NULL DEFAULT 1, unit_price numeric(15,2) NOT NULL DEFAULT 0, amount numeric(15,2),
    organization_id uuid, accounting_class text NOT NULL DEFAULT 'INTERNAL');
  CREATE TABLE public.approval_requests(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL, submission_no integer NOT NULL DEFAULT 1,
    subject_type text NOT NULL, subject_id uuid NOT NULL,
    state text NOT NULL CHECK (state IN ('PENDING_APPROVAL','POSTED','DENIED','REJECTED','CANCELLED','REVERSED','APPROVED','WITHDRAWN','CHANGES_REQUESTED','DISPUTED')),
    maker_membership_id uuid NOT NULL, maker_user_id uuid NOT NULL, payload_hash text, amount numeric(18,2), system_source text,
    submitted_at timestamptz DEFAULT now(), posted_at timestamptz, version bigint NOT NULL DEFAULT 1,
    outcome_kind text, outcome_reason text, closed_by_membership_id uuid, closed_at timestamptz,
    UNIQUE (organization_id, subject_type, subject_id, submission_no));
  CREATE UNIQUE INDEX approval_requests_one_open_subject ON public.approval_requests (organization_id, subject_type, subject_id) WHERE state = 'PENDING_APPROVAL';
  CREATE TABLE public.approval_request_steps(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL, request_id uuid NOT NULL,
    step_no integer NOT NULL, status text NOT NULL, mode text NOT NULL, min_approvals integer NOT NULL, current_generation integer NOT NULL DEFAULT 1);
  CREATE TABLE public.approval_request_step_candidates(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL,
    request_step_id uuid NOT NULL, membership_id uuid NOT NULL, generation integer NOT NULL, valid_to timestamptz);
  CREATE TABLE public.approval_decisions(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL, request_id uuid NOT NULL,
    request_step_id uuid NOT NULL, actor_membership_id uuid NOT NULL, actor_user_id uuid NOT NULL, decision text NOT NULL, reason text,
    decided_at timestamptz NOT NULL DEFAULT now(), request_version bigint NOT NULL);
  CREATE TABLE app_private.canonical_write_operations(organization_id uuid NOT NULL, operation text NOT NULL, subject_scope text NOT NULL,
    actor_id uuid NOT NULL, idempotency_key text NOT NULL CHECK (idempotency_key ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{7,199}$'),
    payload_hash text NOT NULL CHECK (char_length(payload_hash) = 32), subject_id uuid, response_payload jsonb,
    created_at timestamptz NOT NULL DEFAULT now(), completed_at timestamptz, actor_membership_id uuid, transaction_id xid8,
    expected_review_version bigint, expected_approval_version bigint, expected_posting_version bigint,
    resulting_review_version bigint, resulting_approval_version bigint, resulting_posting_version bigint, outcome_kind text,
    PRIMARY KEY (organization_id, operation, subject_scope, actor_id, idempotency_key),
    CHECK (((completed_at IS NULL) = (response_payload IS NULL)) AND ((completed_at IS NULL) = (subject_id IS NULL))));
  CREATE TABLE app_private.ie_transition_authorization(income_expense_id uuid PRIMARY KEY, xid xid8 NOT NULL, purpose text NOT NULL,
    granted_at timestamptz NOT NULL DEFAULT clock_timestamp());
  CREATE TABLE app_private.income_expense_flow_ownership(income_expense_id uuid PRIMARY KEY, organization_id uuid, flow_kind text NOT NULL);
  CREATE TABLE app_private.termination_forfeit_authorizations(revenue_voucher_id uuid, offset_voucher_id uuid);
  CREATE TABLE app_private.commission_reason_contexts(context_id uuid);
  CREATE FUNCTION app_private.is_commission_voucher_v1(p_voucher uuid) RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT false $$;
  CREATE FUNCTION app_private.finance_v2_log_event(p_org uuid, p_event_kind text, p_voucher uuid, p_actor uuid, p_trace text) RETURNS void LANGUAGE sql AS $$ SELECT $$;
  CREATE FUNCTION app_private.finance_v2_is_recognition_period_open(p_org uuid, p_date date) RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT true $$;
  CREATE FUNCTION public.can_do_on_building(p_resource text, p_action text, p_building uuid) RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT true $$;
  CREATE TABLE public.income_expense_postings(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL, voucher_id uuid,
    posting_subject_kind text NOT NULL DEFAULT 'VOUCHER', posting_subject_id uuid NOT NULL, direction text NOT NULL CHECK (direction IN ('INCOME','EXPENSE')),
    account_id uuid NOT NULL, gross_amount numeric(18,2) NOT NULL CHECK (gross_amount > 0), voucher_amount_snapshot numeric(18,2) NOT NULL,
    amount_basis text NOT NULL, net_cash_effect numeric(18,2) NOT NULL, posted_on date NOT NULL, posted_by_membership_id uuid NOT NULL,
    posted_by_user_id uuid NOT NULL, approval_request_id uuid, approval_version bigint NOT NULL, event_kind text NOT NULL CHECK (event_kind IN ('POSTING','REVERSAL')),
    idempotency_key text NOT NULL, source_kind text NOT NULL, posting_generation bigint NOT NULL, replaces_posting_id uuid, reversal_of_id uuid,
    created_at timestamptz NOT NULL DEFAULT now(), reversal_reason text, UNIQUE (organization_id, idempotency_key));
  CREATE TABLE public.income_expense_posting_lines(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL, posting_id uuid NOT NULL,
    account_id uuid NOT NULL, line_kind text NOT NULL, signed_amount numeric(18,2) NOT NULL CHECK (signed_amount <> 0), created_at timestamptz NOT NULL DEFAULT now());
  CREATE TABLE public.finance_evidence_objects(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL, state text NOT NULL);
  CREATE TABLE public.income_expense_posting_evidence(id uuid PRIMARY KEY, organization_id uuid NOT NULL, posting_id uuid NOT NULL, evidence_id uuid NOT NULL,
    relation_kind text NOT NULL, created_at timestamptz NOT NULL DEFAULT now());
  CREATE TABLE app_private.income_expense_cancellations(income_expense_id uuid PRIMARY KEY REFERENCES public.income_expenses(id) ON DELETE CASCADE,
    organization_id uuid NOT NULL, cancelled_at timestamptz NOT NULL DEFAULT now(), cancelled_by uuid, cancel_reason text NOT NULL,
    cancellation_kind text NOT NULL, created_at_snap timestamptz, approved_at_snap timestamptz, amount_snap numeric(15,2), cashbook_snap uuid);
  CREATE TABLE app_private.accounting_chain_writer_xids(transaction_id bigint NOT NULL, backend_pid integer NOT NULL,
    opened_at timestamptz NOT NULL DEFAULT clock_timestamp(), PRIMARY KEY (transaction_id, backend_pid));
  CREATE TABLE app_private.cashbook_closures(id bigserial PRIMARY KEY, cashbook_id uuid, closed_through date);
  CREATE TABLE app_private.cashbook_reopenings(cashbook_id uuid, last_closure_id bigint);
  CREATE TABLE public.cash_handovers(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), code text, status text NOT NULL DEFAULT 'PENDING');
  CREATE TABLE app_private.income_expense_v2_backfill_exceptions(organization_id uuid, voucher_id uuid, reason_code text, detail jsonb);
  CREATE TABLE public.invoices(id uuid PRIMARY KEY, billing_month text, building_id uuid);
  CREATE TABLE public.profiles(id uuid PRIMARY KEY, full_name text, email text);
  -- Nhật ký sự kiện phiếu: bản giả ghi lại lời gọi để ca huỷ kiểm.
  CREATE TABLE public.test_events(organization_id uuid, voucher_id uuid, action text, actor_id uuid, old_status text, new_status text, note text);
  CREATE FUNCTION app_private.append_income_expense_event_v1(p_organization_id uuid, p_income_expense_id uuid, p_action text, p_actor_id uuid,
    p_actor_name text, p_old_status text, p_new_status text, p_note text) RETURNS uuid LANGUAGE sql AS $$
    INSERT INTO public.test_events VALUES (p_organization_id, p_income_expense_id, p_action, p_actor_id, p_old_status, p_new_status, p_note);
    SELECT gen_random_uuid() $$;
`;

/** Thân production nạp nguyên văn (chọn theo md5). */
const HAM_PROD = Object.keys(MD5_PROD).filter((t) => !(t in MD5_TRUOC_VA));

const TRIGGER_NEN = `
  CREATE TRIGGER a001_ie_lifecycle_normalize BEFORE INSERT ON public.income_expenses FOR EACH ROW EXECUTE FUNCTION app_private.ie_normalize_lifecycle_columns();
  CREATE TRIGGER a75_ie_cancel_close_request AFTER UPDATE OF approval_status ON public.income_expenses FOR EACH ROW
    WHEN (((new.approval_status = 'CANCELLED'::text) AND (old.approval_status IS DISTINCT FROM 'CANCELLED'::text))) EXECUTE FUNCTION app_private.ie_cancel_close_request_v1();
  CREATE TRIGGER a85_finance_v2_auto_posting_bridge BEFORE INSERT OR UPDATE OF approval_status, account_id, total_amount, deleted_at
    ON public.income_expenses FOR EACH ROW EXECUTE FUNCTION app_private.finance_v2_auto_posting_bridge();
  CREATE TRIGGER a86_finance_v2_birth_provenance BEFORE INSERT OR UPDATE ON public.income_expenses FOR EACH ROW
    WHEN (((new.approval_status = 'UNAPPROVED'::text) AND (new.birth_operation_id IS NULL))) EXECUTE FUNCTION app_private.finance_v2_birth_provenance_bridge();
  CREATE TRIGGER a87_finance_v2_request_close_sync AFTER UPDATE OF approval_status, posting_status ON public.income_expenses FOR EACH ROW
    EXECUTE FUNCTION app_private.finance_v2_close_request_on_voucher_change();
  CREATE TRIGGER trigger_auto_calc_item_amount BEFORE INSERT OR UPDATE ON public.income_expense_items FOR EACH ROW EXECUTE FUNCTION auto_calc_item_amount();
  CREATE TRIGGER trigger_auto_recalc_total_amount AFTER INSERT OR DELETE OR UPDATE ON public.income_expense_items FOR EACH ROW EXECUTE FUNCTION auto_recalc_total_amount();
`;

function duLieu(): string {
  const thanhVien = [CHU_A, CHU_B, GIU_SO, DUYET].map((u) => `('${mem(u)}','${u}','${ORG_A}', now() - interval '1 year')`)
    .concat(`('${mem(NGOAI)}','${NGOAI}','${ORG_B}', now() - interval '1 year')`).join(",");
  const gan: [string, string, string, string][] = [
    [ORG_A, CHU_A, VAI_CHU, PHAM_VI_A], [ORG_A, CHU_B, VAI_CHU, PHAM_VI_A], [ORG_A, DUYET, VAI_DUYET, PHAM_VI_A], [ORG_B, NGOAI, VAI_CHU_B, PHAM_VI_B]];
  const quyen: [string, string, string][] = [
    [ORG_A, VAI_CHU, "shareholder_profit.distribute"], [ORG_A, VAI_CHU, "shareholder_profit.pay_manager"], [ORG_A, VAI_CHU, "income_expenses.approve"],
    [ORG_A, VAI_DUYET, "income_expenses.approve"],
    [ORG_B, VAI_CHU_B, "shareholder_profit.distribute"], [ORG_B, VAI_CHU_B, "income_expenses.approve"]];
  const giuSo: [string, string][] = [[CHU_A, SO_A], [GIU_SO, SO_A], [CHU_B, SO_B], [CHU_A, SO_C], [GIU_SO, SO_D]];
  return `
    INSERT INTO public.organizations(id) VALUES ('${ORG_A}'),('${ORG_B}');
    INSERT INTO public.super_admins VALUES ('${SUPER}');
    INSERT INTO public.permission_definitions(key, resource, action, sensitivity) VALUES
      ('shareholder_profit.distribute','shareholder_profit','distribute','ELEVATED'),
      ('shareholder_profit.pay_manager','shareholder_profit','pay_manager','ELEVATED'),
      ('income_expenses.approve','income_expenses','approve','MANAGE');
    INSERT INTO public.organization_memberships(id, user_id, organization_id, valid_from) VALUES ${thanhVien};
    INSERT INTO public.authorization_scopes(id, organization_id, scope_type) VALUES ('${PHAM_VI_A}','${ORG_A}','ORGANIZATION'),('${PHAM_VI_B}','${ORG_B}','ORGANIZATION');
    INSERT INTO public.organization_roles(id, organization_id, name, is_system, system_key) VALUES
      ('${VAI_CHU}','${ORG_A}','Chủ sở hữu tổ chức',true,'TENANT_OWNER'), ('${VAI_DUYET}','${ORG_A}','Kế toán duyệt',false,NULL),
      ('${VAI_CHU_B}','${ORG_B}','Chủ sở hữu tổ chức',true,'TENANT_OWNER');
    INSERT INTO public.role_permissions(organization_id, role_id, permission_key) VALUES
      ${quyen.map(([o, r, k]) => `('${o}','${r}','${k}')`).join(",")};
    ${gan.map(([o, u, r, s], i) => `
      INSERT INTO public.role_bindings(id, organization_id, membership_id, role_id) VALUES ('${id(100 + i)}','${o}','${mem(u)}','${r}');
      INSERT INTO public.role_binding_scopes VALUES ('${o}','${id(100 + i)}','${s}');`).join("")}
    INSERT INTO public.buildings(id, organization_id, user_id, name, is_virtual) VALUES
      ('${TOA_AO}','${ORG_A}','${CHU_A}','Kho văn phòng',true), ('${TOA_THUONG}','${ORG_A}','${CHU_A}','Toà thường',false),
      ('${TOA_B}','${ORG_B}','${NGOAI}','Toà B',false);
    INSERT INTO public.accounts(id, organization_id, user_id, name) VALUES
      ('${SO_A}','${ORG_A}','${GIU_SO}','Sổ A'), ('${SO_B}','${ORG_A}','${CHU_B}','Sổ B'), ('${SO_C}','${ORG_A}','${CHU_A}','Sổ C'),
      ('${SO_D}','${ORG_A}','${GIU_SO}','Sổ D');
    INSERT INTO public.cashbook_possession_bindings(organization_id, membership_id, cashbook_id, possession_kind, valid_from) VALUES
      ${giuSo.map(([u, s]) => `('${ORG_A}','${mem(u)}','${s}','CUSTODIAN', now() - interval '1 day')`).join(",")};
    INSERT INTO public.shareholders(id, organization_id, auth_user_id, name) VALUES
      ('${CD1}','${ORG_A}','${GIU_SO}','Cổ đông giữ sổ'), ('${CD2}','${ORG_A}',NULL,'Cổ đông không đăng nhập'),
      ('${CD_CHU_B}','${ORG_A}','${CHU_B}','Cổ đông là chủ B'), ('${CD_KHOA}','${ORG_A}',NULL,'Cổ đông cho ca khoá sổ');
    INSERT INTO public.profit_managers(id, organization_id, auth_user_id, name) VALUES ('${QL1}','${ORG_A}','${CHU_A}','Quản lý là chủ A');
    INSERT INTO public.profit_monthly(id, organization_id, building_id, period_month, status, locked_at) VALUES
      ('${PM_07}','${ORG_A}','${TOA_THUONG}','2026-07-01','LOCKED', now()), ('${PM_08}','${ORG_A}','${TOA_THUONG}','2026-08-01','LOCKED', now());
    INSERT INTO public.profit_allocations(profit_monthly_id, shareholder_id, amount, organization_id) VALUES
      ('${PM_07}','${CD1}',600,'${ORG_A}'), ('${PM_08}','${CD1}',400,'${ORG_A}'), ('${PM_07}','${CD2}',500,'${ORG_A}'), ('${PM_07}','${CD_CHU_B}',200,'${ORG_A}'),
      ('${PM_07}','${CD_KHOA}',100,'${ORG_A}');
    INSERT INTO public.profit_manager_allocations(profit_monthly_id, manager_id, amount, organization_id) VALUES ('${PM_07}','${QL1}',300,'${ORG_A}');
    INSERT INTO public.test_route VALUES ('${CO}', 'CANONICAL');
  `;
}

/**
 * Lập phiếu sổ tổng theo ĐÚNG nghi thức của M1/E5: khoá sổ → nextval → đọc số dư → C6 'CREATE' → mở capability chuỗi kế toán
 * → INSERT phiếu + dòng hạng mục → C2 → nộp yêu cầu duyệt → điền approval_request_id → xoá C6 → đóng capability.
 * Yêu cầu duyệt do bản giả của submit_financial_request_v1 tạo (một bước, ứng viên = hai chủ trừ người lập).
 */
const HAM_TEST = String.raw`
  CREATE FUNCTION public.test_submit(p_voucher uuid, p_mem uuid, p_user uuid) RETURNS uuid LANGUAGE plpgsql AS $$
  DECLARE v_req uuid; v_step uuid; v_ie public.income_expenses;
  BEGIN
    SELECT * INTO v_ie FROM public.income_expenses WHERE id = p_voucher FOR UPDATE;
    INSERT INTO public.approval_requests(organization_id, submission_no, subject_type, subject_id, state, maker_membership_id, maker_user_id,
      payload_hash, amount, system_source)
    SELECT v_ie.organization_id, COALESCE((SELECT max(submission_no) FROM public.approval_requests WHERE subject_id = p_voucher), 0) + 1,
      'FINANCIAL_VOUCHER', p_voucher, 'PENDING_APPROVAL', p_mem, p_user, v_ie.source_payload_hash, v_ie.total_amount, v_ie.system_source
    RETURNING id INTO v_req;
    INSERT INTO public.approval_request_steps(organization_id, request_id, step_no, status, mode, min_approvals)
    VALUES (v_ie.organization_id, v_req, 1, 'PENDING', 'ANY', 1) RETURNING id INTO v_step;
    INSERT INTO public.approval_request_step_candidates(organization_id, request_step_id, membership_id, generation)
    SELECT v_ie.organization_id, v_step, m.id, 1 FROM public.organization_memberships m
     WHERE m.organization_id = v_ie.organization_id AND m.user_id IN ('${CHU_A}', '${CHU_B}') AND m.user_id <> p_user;
    RETURN v_req;
  END $$;

  CREATE FUNCTION public.test_lap_phieu(p_id uuid, p_kind text, p_subject uuid, p_amount numeric, p_account uuid, p_maker uuid,
    p_payee uuid, p_maker_kind text DEFAULT 'OWNER', p_date date DEFAULT '${NGAY}', p_source text DEFAULT NULL) RETURNS uuid LANGUAGE plpgsql AS $$
  DECLARE v_bal numeric; v_within numeric; v_req uuid; v_seq bigint;
  BEGIN
    -- Thứ tự của writer (mẫu M1 mục 6): khoá sổ → nextval → đọc số dư → ngữ cảnh LẬP → phiếu + dòng → C2.
    PERFORM app_private.profit_ledger_lock_v1('${ORG_A}', p_kind, p_subject);
    v_seq := nextval('app_private.profit_ledger_seq');
    v_bal := (app_private.profit_ledger_balance_v1('${ORG_A}', p_kind, p_subject) ->> 'balance')::numeric;
    v_within := LEAST(p_amount, GREATEST(v_bal, 0));
    INSERT INTO app_private.profit_ledger_write_contexts(income_expense_id, purpose) VALUES (p_id, 'CREATE');
    PERFORM app_private.begin_accounting_chain_write_v1();
    INSERT INTO public.income_expenses(id, organization_id, user_id, type, name, building_id, voucher_date, approval_status, account_id,
      shareholder_id, profit_manager_id, system_source, source_payload_hash, business_result_accounting, maker_user_id, maker_membership_id)
    VALUES (p_id, '${ORG_A}', '${CHU_A}', 'EXPENSE', 'Chi lợi nhuận', '${TOA_AO}', p_date, 'UNAPPROVED', p_account,
      CASE WHEN p_kind = 'SHAREHOLDER' THEN p_subject END, CASE WHEN p_kind = 'MANAGER' THEN p_subject END,
      COALESCE(p_source, CASE WHEN p_kind = 'SHAREHOLDER' THEN 'profit.ledger_payout' ELSE 'profit.manager_salary' END),
      md5('phieu:' || p_id::text), false, p_maker, replace(p_maker::text, '4000-8000-0000000000', '4000-8000-1000000000')::uuid);
    INSERT INTO public.income_expense_items(income_expense_id, income_expense_type_id, quantity, unit_price, organization_id)
    VALUES (p_id, '${LOAI_CLN}', 1, p_amount, '${ORG_A}');
    -- Ranh giới "lập ở giao dịch trước" (assert_committed_birth_boundary_v2): birth_txid giả, đặt trong ngữ cảnh LẬP.
    UPDATE public.income_expenses SET birth_txid = '1'::xid8 WHERE id = p_id;
    INSERT INTO app_private.profit_ledger_payouts(voucher_id, organization_id, subject_kind, shareholder_id, manager_id, account_id, amount,
      balance_before, within_amount, advance_amount, maker_user_id, maker_membership_id, maker_kind, payee_is_maker, payee_user_id, ledger_seq)
    VALUES (p_id, '${ORG_A}', p_kind, CASE WHEN p_kind = 'SHAREHOLDER' THEN p_subject END, CASE WHEN p_kind = 'MANAGER' THEN p_subject END,
      p_account, p_amount, v_bal, CASE WHEN p_kind = 'MANAGER' THEN p_amount ELSE v_within END,
      CASE WHEN p_kind = 'MANAGER' THEN 0 ELSE p_amount - v_within END,
      p_maker, replace(p_maker::text, '4000-8000-0000000000', '4000-8000-1000000000')::uuid, p_maker_kind,
      COALESCE(p_payee = p_maker, false), p_payee, v_seq);
    v_req := public.test_submit(p_id, replace(p_maker::text, '4000-8000-0000000000', '4000-8000-1000000000')::uuid, p_maker);
    UPDATE app_private.profit_ledger_payouts SET approval_request_id = v_req WHERE voucher_id = p_id;
    DELETE FROM app_private.profit_ledger_write_contexts WHERE income_expense_id = p_id;
    PERFORM app_private.end_accounting_chain_write_v1();
    RETURN v_req;
  END $$;

  -- Phiếu THƯỜNG (không system_source) chờ duyệt, cùng cách giả lập ranh giới lập.
  CREATE FUNCTION public.test_lap_phieu_thuong(p_id uuid, p_amount numeric, p_account uuid, p_maker uuid) RETURNS uuid LANGUAGE plpgsql AS $$
  BEGIN
    INSERT INTO public.income_expenses(id, organization_id, user_id, type, name, building_id, voucher_date, approval_status, account_id,
      source_payload_hash, maker_user_id, maker_membership_id)
    VALUES (p_id, '${ORG_A}', p_maker, 'EXPENSE', 'Chi thường', '${TOA_THUONG}', '${NGAY}', 'UNAPPROVED', p_account, md5('phieu:' || p_id::text),
      p_maker, replace(p_maker::text, '4000-8000-0000000000', '4000-8000-1000000000')::uuid);
    INSERT INTO public.income_expense_items(income_expense_id, income_expense_type_id, quantity, unit_price, organization_id)
    VALUES (p_id, '${LOAI_CLN}', 1, p_amount, '${ORG_A}');
    UPDATE public.income_expenses SET birth_txid = '1'::xid8 WHERE id = p_id;
    RETURN public.test_submit(p_id, replace(p_maker::text, '4000-8000-0000000000', '4000-8000-1000000000')::uuid, p_maker);
  END $$;

  CREATE FUNCTION public.test_chung_tu() RETURNS uuid LANGUAGE sql AS
    $$ INSERT INTO public.finance_evidence_objects(organization_id, state) VALUES ('${ORG_A}', 'FINALIZED') RETURNING id $$;
`;

const db = new PGlite();
const ghi: Record<string, unknown> = {};
let soKhoaPhieu = 0;
const khoa = (tien = "k") => `${tien}-${String(++soKhoaPhieu).padStart(6, "0")}`;

async function giaoDich<T>(fn: () => Promise<T>): Promise<T> {
  await db.exec("BEGIN");
  try { return await fn(); } finally { await db.exec("ROLLBACK"); }
}
const mot = async <T>(sql: string) => (await db.query<{ v: T }>(sql)).rows[0]?.v as T;
async function la(user: string | null) {
  await db.query("SELECT set_config('request.jwt.claim.sub', $1, true)", [user ?? ""]);
}
async function route(r: string) {
  await db.query("UPDATE public.test_route SET route = $1 WHERE feature_key = $2", [r, CO]);
}
interface Loi { code: string; message: string; detail?: string }
/** Chạy trong SAVEPOINT; trả lỗi (mã + thông điệp) hoặc null nếu chạy được — không làm hỏng giao dịch của ca. */
async function loi(sql: string): Promise<Loi | null> {
  await db.exec("SAVEPOINT thu");
  try { await db.exec(sql); await db.exec("RELEASE SAVEPOINT thu"); return null; } catch (e) {
    await db.exec("ROLLBACK TO SAVEPOINT thu");
    const x = e as { code?: string; message: string; detail?: string };
    return { code: x.code ?? "?", message: x.message, detail: x.detail };
  }
}
/** Lỗi phải có đúng SQLSTATE và mã máy đọc được trong MESSAGE. */
async function chan(sql: string, code: string, ma: string) {
  const l = await loi(sql);
  expect(l, `phải chặn: ${ma}`).not.toBeNull();
  expect(`${l?.code} ${l?.message}`).toContain(`${code} ${ma}`);
  return l as Loi;
}
type Kind = "SHAREHOLDER" | "MANAGER";
async function lap(p: string, o: { kind?: Kind; subject?: string; amount?: number; so?: string; maker?: string; payee?: string | null;
  makerKind?: string; ngay?: string; nguon?: string } = {}): Promise<string> {
  const kind = o.kind ?? "SHAREHOLDER";
  const payee = o.payee === undefined ? GIU_SO : o.payee;
  return mot<string>(`SELECT public.test_lap_phieu('${p}', '${kind}', '${o.subject ?? CD1}', ${o.amount ?? 100}, '${o.so ?? SO_A}',
    '${o.maker ?? CHU_A}', ${payee ? `'${payee}'` : "NULL"}, '${o.makerKind ?? "OWNER"}', '${o.ngay ?? NGAY}', ${o.nguon ? `'${o.nguon}'` : "NULL"}) AS v`);
}
const sqlDuyet = (p: string) =>
  `SELECT public.approve_income_expense_v2('${p}', (SELECT approval_version FROM public.income_expenses WHERE id = '${p}'), '${khoa("duyet")}')`;
const sqlGhiSo = (p: string, so = SO_A) => `SELECT public.post_approved_income_expense_v2(jsonb_build_object(
  'subjectId', '${p}', 'cashbookId', '${so}', 'postedOn', '2026-11-12', 'idempotencyKey', '${khoa("ghiso")}',
  'expectedApprovalVersion', (SELECT approval_version FROM public.income_expenses WHERE id = '${p}'),
  'expectedPostingVersion', (SELECT posting_version FROM public.income_expenses WHERE id = '${p}'),
  'evidenceIds', jsonb_build_array(public.test_chung_tu())))`;
const sqlDuyetVaChi = (p: string, so = SO_A) => `SELECT public.approve_and_post_income_expense_v2(jsonb_build_object(
  'subjectId', '${p}', 'cashbookId', '${so}', 'postedOn', '2026-11-12', 'idempotencyKey', '${khoa("duyetchi")}',
  'expectedApprovalVersion', (SELECT approval_version FROM public.income_expenses WHERE id = '${p}'),
  'expectedPostingVersion', (SELECT posting_version FROM public.income_expenses WHERE id = '${p}'),
  'evidenceIds', jsonb_build_array(public.test_chung_tu())))`;
/** ky: bỏ trống ⇒ lời gọi 3 tham số cũ; có (kể cả null) ⇒ truyền p_expected_state. */
const sqlHuy = (p: string, lyDo = "Lý do huỷ đủ tám ký tự", k = khoa("huy"), ky?: string | null) =>
  `SELECT public.profit_ledger_payout_cancel_v1('${p}', '${lyDo}', '${k}'${ky === undefined ? "" : `, ${ky === null ? "NULL" : `'${ky}'`}`})`;
const huy = (p: string, lyDo?: string, k?: string, ky?: string | null) => mot<Record<string, unknown>>(`${sqlHuy(p, lyDo, k, ky)} AS v`);
/** Bản E6 cũ (3 tham số) mà TEST đang có từ lần áp trước — chỉ cần đúng chữ ký và ACL. */
const BAN_CU_E6 = `
  CREATE FUNCTION public.profit_ledger_payout_cancel_v1(p_voucher_id uuid, p_reason text, p_idempotency_key text) RETURNS jsonb
    LANGUAGE sql SECURITY DEFINER SET search_path TO 'pg_catalog' AS $$ SELECT '{"ban_cu": true}'::jsonb $$;
  REVOKE ALL ON FUNCTION public.profit_ledger_payout_cancel_v1(uuid, text, text) FROM PUBLIC, anon;
  GRANT EXECUTE ON FUNCTION public.profit_ledger_payout_cancel_v1(uuid, text, text) TO authenticated;`;
const SQL_BAN_E6 = `SELECT COALESCE(array_agg(pg_get_function_arguments(p.oid) ORDER BY p.oid), '{}') AS v FROM pg_proc p
  WHERE p.pronamespace = 'public'::regnamespace AND p.proname = 'profit_ledger_payout_cancel_v1'`;
const phieu = (p: string) => db.query<Record<string, unknown>>(`SELECT * FROM public.income_expenses WHERE id = '${p}'`).then((r) => r.rows[0]);
const yeuCau = (p: string) => mot<string>(`SELECT state AS v FROM public.approval_requests WHERE subject_id = '${p}' ORDER BY submission_no DESC LIMIT 1`);
const soDu = async (kind: Kind, subject: string) =>
  Number(await mot<string>(`SELECT app_private.profit_ledger_balance_v1('${ORG_A}', '${kind}', '${subject}') ->> 'balance' AS v`));
const nhatKy = (p: string) => db.query<{ event_kind: string; amount: string; balance_before: string | null; balance_after: string | null;
  actor_id: string | null; reason: string | null; payload: Record<string, unknown> }>(
  `SELECT event_kind, amount, balance_before, balance_after, actor_id, reason, payload FROM app_private.profit_ledger_events
    WHERE voucher_id = '${p}' ORDER BY created_at, event_kind`).then((r) => r.rows);
const tonSo = async (so: string) => Number(await mot<string>(
  `SELECT COALESCE(sum(l.signed_amount), 0)::text AS v FROM public.income_expense_posting_lines l WHERE l.account_id = '${so}'`));
const tongButToanPhieu = async (p: string) => Number(await mot<string>(`SELECT COALESCE(sum(l.signed_amount), 0)::text AS v
  FROM public.income_expense_posting_lines l JOIN public.income_expense_postings x ON x.id = l.posting_id
  WHERE x.posting_subject_kind = 'VOUCHER' AND x.posting_subject_id = '${p}'`));
/** UPDATE trực tiếp dưới vai chủ bảng như RPC V2 làm (có token vòng đời của giao dịch). */
const coToken = (p: string) => `INSERT INTO app_private.ie_transition_authorization(income_expense_id, xid, purpose)
  VALUES ('${p}', pg_current_xact_id(), 'FINANCE_V2_LIFECYCLE') ON CONFLICT (income_expense_id) DO UPDATE SET xid = EXCLUDED.xid, purpose = EXCLUDED.purpose`;

beforeAll(async () => {
  await db.exec(NEN);
  await db.exec("SET check_function_bodies = off");
  for (const ten of HAM_PROD) await db.exec(thanTheoMd5(ten, MD5_PROD[ten]));
  for (const [ten, ma] of Object.entries(MD5_TRUOC_VA)) await db.exec(thanTheoMd5(ten, ma));
  await db.exec(VA_GHI_SO);
  await db.exec(HAM_TEST);
  await db.exec("SET check_function_bodies = on");
  await db.exec(TRIGGER_NEN);
  await db.exec(duLieu());

  await db.exec(MIGRATION_M1);
  const demTrigger = "SELECT count(*)::int AS v FROM pg_trigger WHERE tgname LIKE 'a06\\_profit\\_ledger%' OR tgname = 'a85z_profit_ledger_post_guard'";
  await db.exec(BAN_CU_E6);
  ghi.e6Truoc = await mot<string[]>(SQL_BAN_E6);
  await db.exec(MIGRATION);
  ghi.triggerLuot1 = await mot<number>(demTrigger);
  ghi.e6Luot1 = await mot<string[]>(SQL_BAN_E6);
  await db.exec(MIGRATION);
  ghi.triggerLuot2 = await mot<number>(demTrigger);
  ghi.e6Luot2 = await mot<string[]>(SQL_BAN_E6);
}, 180000);
afterAll(() => db.close());

describe("khung thử: thân production và hai lượt migration", () => {
  it("mọi RPC/hàm vòng đời V2 nạp vào đúng thân production (md5 đo trên bản sao production), kể cả hai RPC ghi sổ sau bản vá động", async () => {
    const r = (await db.query<{ ten: string; m: string }>(`
      SELECT n.nspname || '.' || p.proname AS ten, md5(replace(p.prosrc, chr(13), '')) AS m
        FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname || '.' || p.proname = ANY($1)`, [Object.keys(MD5_PROD)])).rows;
    expect(Object.fromEntries(r.map((x) => [x.ten, x.m]))).toEqual(MD5_PROD);
  });
  it("chạy lại migration không nhân đôi trigger; bốn trigger đúng chỗ (a06 sau a05 / trước a85; a85z ngay sau a85)", async () => {
    expect(ghi.triggerLuot1).toBe(4);
    expect(ghi.triggerLuot2).toBe(4);
    const r = (await db.query<{ ten: string; bang: string; def: string }>(`
      SELECT t.tgname AS ten, t.tgrelid::regclass::text AS bang, pg_get_triggerdef(t.oid) AS def FROM pg_trigger t
       WHERE t.tgname LIKE 'a06%' OR t.tgname = 'a85z_profit_ledger_post_guard' ORDER BY 1`)).rows;
    expect(r.map((x) => [x.ten, x.bang])).toEqual([
      ["a06_profit_ledger_payout_guard", "income_expenses"],
      ["a06_profit_ledger_payout_item_guard", "income_expense_items"],
      ["a06_profit_ledger_request_guard", "approval_requests"],
      ["a85z_profit_ledger_post_guard", "income_expenses"]]);
    expect(r[0].def).toContain("BEFORE DELETE OR UPDATE ON public.income_expenses FOR EACH ROW WHEN");
    expect(r[1].def).toContain("BEFORE INSERT OR DELETE OR UPDATE ON public.income_expense_items FOR EACH ROW EXECUTE");
    expect(r[2].def).toContain("BEFORE UPDATE OF state ON public.approval_requests FOR EACH ROW WHEN");
    expect(r[3].def).toContain("BEFORE UPDATE ON public.income_expenses FOR EACH ROW WHEN");
    // Chuỗi BEFORE UPDATE theo tên (byte): … a06 … a85 (cầu ghi sổ) → a85z → a86 …
    const thuTu = (await db.query<{ ten: string }>(`
      SELECT t.tgname AS ten FROM pg_trigger t
       WHERE t.tgrelid = 'public.income_expenses'::regclass AND NOT t.tgisinternal AND (t.tgtype & 2) = 2 AND (t.tgtype & 16) = 16
       ORDER BY t.tgname::text COLLATE "C"`)).rows.map((x) => x.ten);
    expect(thuTu).toEqual(["a06_profit_ledger_payout_guard", "a85_finance_v2_auto_posting_bridge", "a85z_profit_ledger_post_guard",
      "a86_finance_v2_birth_provenance"]);
  });
  it("bản E6 cũ 3 tham số (như TEST đang có) bị thay ở lượt đầu; hai lượt đều chỉ còn MỘT bản: 4 tham số, tham số cuối DEFAULT NULL", async () => {
    expect(ghi.e6Truoc).toEqual(["p_voucher_id uuid, p_reason text, p_idempotency_key text"]);
    const moi = ["p_voucher_id uuid, p_reason text, p_idempotency_key text, p_expected_state text DEFAULT NULL::text"];
    expect(ghi.e6Luot1).toEqual(moi);
    expect(ghi.e6Luot2).toEqual(moi);
  });
});

describe("quyền gọi", () => {
  it("lệnh huỷ: authenticated gọi được, anon / PUBLIC thì không (anon bị chặn ở quyền EXECUTE, chưa vào thân hàm); hàm trigger và hàm phụ không ai ngoài chủ hàm", async () => {
    const quyen = (vai: string, ham: string) => mot<boolean>(`SELECT has_function_privilege('${vai}', '${ham}', 'EXECUTE') AS v`);
    const e6 = "public.profit_ledger_payout_cancel_v1(uuid,text,text,text)";
    expect(await quyen("authenticated", e6)).toBe(true);
    expect(await quyen("anon", e6)).toBe(false);
    expect(await quyen("public", e6)).toBe(false);
    expect(await mot<string | null>("SELECT to_regprocedure('public.profit_ledger_payout_cancel_v1(uuid,text,text)')::text AS v")).toBeNull();
    for (const ky of [undefined, "PENDING"]) {
      await giaoDich(async () => {
        await db.exec("SET LOCAL ROLE anon");
        const l = await loi(sqlHuy(id(1999), undefined, undefined, ky));
        expect(l?.code).toBe("42501");
        expect(l?.message).toContain("permission denied for function profit_ledger_payout_cancel_v1");
      });
    }
    for (const h of ["app_private.guard_profit_ledger_payout_v1()", "app_private.guard_profit_ledger_post_v1()",
      "app_private.guard_profit_ledger_payout_item_v1()",
      "app_private.guard_profit_ledger_request_v1()", "app_private.profit_ledger_chan_changed_columns_v1(jsonb,jsonb,text[])",
      "app_private.profit_ledger_chan_assert_route_v1(uuid,text)"]) {
      for (const vai of ["authenticated", "anon", "service_role"]) expect(await quyen(vai, h), `${vai} ${h}`).toBe(false);
    }
    expect(await mot<string>(`SELECT provolatile::text AS v FROM pg_proc WHERE oid = '${e6}'::regprocedure`)).toBe("v");
  });
});

describe("F1 — bước DUYỆT qua RPC thật approve_income_expense_v2", () => {
  it("chủ B duyệt phiếu do chủ A lập (CANONICAL): APPROVED + chưa ghi sổ, yêu cầu đóng APPROVED, nhật ký PAYOUT_APPROVED", async () => {
    await giaoDich(async () => {
      const p = id(1001);
      await lap(p, { amount: 300 });
      const truoc = await soDu("SHAREHOLDER", CD1);
      await la(CHU_B);
      expect(await loi(sqlDuyet(p))).toBeNull();
      expect(await phieu(p)).toMatchObject({ approval_status: "APPROVED", posting_status: "UNPOSTED", review_state: "RESOLVED", approved_by: CHU_B });
      expect(await yeuCau(p)).toBe("APPROVED");
      expect(await soDu("SHAREHOLDER", CD1)).toBe(truoc);
      const nk = await nhatKy(p);
      expect(nk.map((x) => x.event_kind)).toEqual(["PAYOUT_APPROVED"]);
      expect(nk[0]).toMatchObject({ actor_id: CHU_B, amount: "300.00", balance_before: "1000.00", balance_after: "700.00" });
      expect(nk[0].payload).toMatchObject({ within_amount: 300, advance_amount: 0, at_create: { within_amount: 300, advance_amount: 0 } });
    });
  });
  it("người lập tự duyệt ⇒ 42501 PROFIT_LEDGER_MAKER_SELF_APPROVE (RPC V2 không tự kiểm người lập)", async () => {
    await giaoDich(async () => {
      const p = id(1002);
      await lap(p);
      await la(CHU_A);
      await chan(sqlDuyet(p), "42501", "PROFIT_LEDGER_MAKER_SELF_APPROVE");
      expect(await phieu(p)).toMatchObject({ approval_status: "UNAPPROVED" });
    });
  });
  it("người nhận duyệt ⇒ 42501 PROFIT_LEDGER_PAYEE_SELF_APPROVE (cổ đông là chủ B; lương điều hành của chủ A)", async () => {
    await giaoDich(async () => {
      const p = id(1003);
      await lap(p, { subject: CD_CHU_B, payee: CHU_B, amount: 50 });
      await la(CHU_B);
      await chan(sqlDuyet(p), "42501", "PROFIT_LEDGER_PAYEE_SELF_APPROVE");
      const q = id(1004);
      await lap(q, { kind: "MANAGER", subject: QL1, maker: CHU_B, payee: CHU_A, amount: 50 });
      await la(CHU_A);
      await chan(sqlDuyet(q), "42501", "PROFIT_LEDGER_PAYEE_SELF_APPROVE");
      await la(CHU_B);
      await chan(sqlDuyet(q), "42501", "PROFIT_LEDGER_MAKER_SELF_APPROVE");
    });
  });
  it("người chỉ có quyền duyệt thu chi, không có quyền chi lợi nhuận ⇒ 42501 PROFIT_LEDGER_APPROVE_FORBIDDEN", async () => {
    await giaoDich(async () => {
      const p = id(1005);
      await lap(p);
      await la(DUYET);
      const l = await chan(sqlDuyet(p), "42501", "PROFIT_LEDGER_APPROVE_FORBIDDEN");
      expect(JSON.parse(l.detail ?? "{}")).toEqual({ permission: "shareholder_profit.distribute" });
      const q = id(1006);
      await lap(q, { kind: "MANAGER", subject: QL1, maker: CHU_A, payee: CHU_A, amount: 10 });
      await chan(sqlDuyet(q), "42501", "PROFIT_LEDGER_APPROVE_FORBIDDEN");
    });
  });
  it("route LEGACY / SHADOW ⇒ 55000 PROFIT_LEDGER_ROUTE_OFF; FROZEN ⇒ 55000 PROFIT_LEDGER_FROZEN", async () => {
    await giaoDich(async () => {
      const p = id(1007);
      await lap(p);
      await la(CHU_B);
      for (const [r, ma] of [["LEGACY", "PROFIT_LEDGER_ROUTE_OFF"], ["SHADOW", "PROFIT_LEDGER_ROUTE_OFF"], ["FROZEN", "PROFIT_LEDGER_FROZEN"]]) {
        await route(r);
        const l = await chan(sqlDuyet(p), "55000", ma);
        expect(JSON.parse(l.detail ?? "{}")).toEqual({ route: r });
      }
      await route("CANONICAL");
      expect(await loi(sqlDuyet(p))).toBeNull();
    });
  });
  it("phiếu đã bị TỪ CHỐI (decide_financial_request_v2 thật): yêu cầu REJECTED, nhật ký PAYOUT_REJECTED có lý do; duyệt lại ⇒ 55000 PROFIT_LEDGER_VOUCHER_DEAD", async () => {
    await giaoDich(async () => {
      const p = id(1008);
      const req = await lap(p, { amount: 200 });
      expect(await soDu("SHAREHOLDER", CD1)).toBe(800);
      await la(CHU_B);
      expect(await loi(`SELECT public.decide_financial_request_v2('${req}', 'REJECT', 'Sai số tiền cần lập lại')`)).toBeNull();
      expect(await yeuCau(p)).toBe("REJECTED");
      expect(await soDu("SHAREHOLDER", CD1)).toBe(1000);
      const nk = await nhatKy(p);
      expect(nk.map((x) => [x.event_kind, x.actor_id, x.reason])).toEqual([["PAYOUT_REJECTED", CHU_B, "Sai số tiền cần lập lại"]]);
      await chan(sqlDuyet(p), "55000", "PROFIT_LEDGER_VOUCHER_DEAD");
      // Nút Duyệt ở Thu chi mở lại khi yêu cầu không còn chờ: UPDATE của approve_voucher cũng bị chặn.
      await chan(`${coToken(p)}; UPDATE public.income_expenses SET approval_status = 'APPROVED', approved_by = '${CHU_B}', approved_at = now() WHERE id = '${p}'`,
        "55000", "PROFIT_LEDGER_VOUCHER_DEAD");
    });
  });
  it("chỉ đường RPC vòng đời V2: UPDATE duyệt không token ⇒ 55000 PROFIT_LEDGER_V2_ONLY; có token mà người lập ⇒ 42501", async () => {
    await giaoDich(async () => {
      const p = id(1009);
      await lap(p);
      await la(CHU_B);
      const duyetTrucTiep = `UPDATE public.income_expenses SET approval_status = 'APPROVED', approved_by = auth.uid(), approved_at = now() WHERE id = '${p}'`;
      await chan(duyetTrucTiep, "55000", "PROFIT_LEDGER_V2_ONLY");
      // Cầu a85 không chạy (cờ ghi sổ V2 không CANONICAL) ⇒ chỉ còn F1 chặn duyệt không token (F1b không có bút toán để thấy).
      await db.exec("INSERT INTO public.test_route VALUES ('income_expense.posting.v2', 'LEGACY')");
      const l = await chan(duyetTrucTiep, "55000", "PROFIT_LEDGER_V2_ONLY");
      expect(l.message).toContain("chỉ duyệt / ghi sổ ở màn Chờ duyệt");
      expect(await phieu(p)).toMatchObject({ approval_status: "UNAPPROVED", posting_status: "UNPOSTED" });
      await db.exec("DELETE FROM public.test_route WHERE feature_key = 'income_expense.posting.v2'");
      await la(CHU_A);
      await chan(`${coToken(p)}; ${duyetTrucTiep}`, "42501", "PROFIT_LEDGER_MAKER_SELF_APPROVE");
      await la(null);
      await chan(`${coToken(p)}; ${duyetTrucTiep}`, "42501", "PROFIT_LEDGER_ACTOR_REQUIRED");
    });
  });
  it("mở chốt giữa lúc lập và lúc duyệt: tạm ứng tính lại lúc duyệt > 0, ghi trong nhật ký (lúc lập 0)", async () => {
    await giaoDich(async () => {
      const p = id(1010);
      await lap(p, { amount: 900 });
      await db.exec(`UPDATE public.profit_monthly SET status = 'DRAFT' WHERE id = '${PM_08}'`);
      await la(CHU_B);
      expect(await loi(sqlDuyet(p))).toBeNull();
      const nk = await nhatKy(p);
      expect(nk[0].payload).toMatchObject({ within_amount: 600, advance_amount: 300, at_create: { within_amount: 900, advance_amount: 0 } });
      expect(nk[0]).toMatchObject({ balance_before: "600.00", balance_after: "-300.00" });
    });
  });
  it("lương điều hành vượt số còn lại lúc duyệt ⇒ 22023 PROFIT_MANAGER_LEDGER_OVERDRAW (DETAIL có số)", async () => {
    await giaoDich(async () => {
      const q = id(1011);
      await lap(q, { kind: "MANAGER", subject: QL1, maker: CHU_A, payee: CHU_A, amount: 300 });
      await db.exec(`UPDATE public.profit_manager_allocations SET amount = 250 WHERE manager_id = '${QL1}'`);
      await la(CHU_B);
      const l = await chan(sqlDuyet(q), "22023", "PROFIT_MANAGER_LEDGER_OVERDRAW");
      expect(JSON.parse(l.detail ?? "{}")).toEqual({ balance: 250, amount: 300, over: 50 });
      await db.exec(`UPDATE public.profit_manager_allocations SET amount = 300 WHERE manager_id = '${QL1}'`);
      expect(await loi(sqlDuyet(q))).toBeNull();
    });
  });
  it("duyệt giữ khoá sổ của chủ thể tới hết giao dịch (phiếu lập ở giao dịch trước; trước khi duyệt chưa giữ)", async () => {
    const p = id(1013);
    // Phiếu được COMMIT (chủ thể CD_KHOA chỉ dùng ở ca này) để khoá sổ lúc lập không còn trong giao dịch duyệt.
    await db.exec("BEGIN");
    await lap(p, { subject: CD_KHOA, payee: null, amount: 40 });
    await db.exec("COMMIT");
    await giaoDich(async () => {
      const giu = () => mot<boolean>(`SELECT app_private.profit_ledger_lock_held_v1('${ORG_A}', 'SHAREHOLDER', '${CD_KHOA}') AS v`);
      expect(await giu()).toBe(false);
      await la(CHU_B);
      expect(await loi(sqlDuyet(p))).toBeNull();
      expect(await giu()).toBe(true);
    });
  });
  it("người nhận được gắn đăng nhập SAU khi lập: tự duyệt ⇒ PAYEE_SELF_APPROVE, tự ghi sổ ⇒ PAYEE_SELF_POST (so cả đăng nhập hiện tại)", async () => {
    await giaoDich(async () => {
      // Lập lúc cổ đông CD2 chưa có đăng nhập (C2.payee_user_id NULL), rồi gắn đăng nhập của chủ B.
      const p = id(1014);
      await lap(p, { subject: CD2, payee: null, so: SO_B, amount: 60 });
      const q = id(1015);
      await lap(q, { subject: CD2, payee: null, so: SO_B, amount: 70 });
      await la(CHU_B);
      expect(await loi(sqlDuyet(q))).toBeNull();
      await db.exec(`UPDATE public.shareholders SET auth_user_id = '${CHU_B}' WHERE id = '${CD2}'`);
      await chan(sqlDuyet(p), "42501", "PROFIT_LEDGER_PAYEE_SELF_APPROVE");
      await chan(sqlGhiSo(q, SO_B), "42501", "PROFIT_LEDGER_PAYEE_SELF_POST");
      // Phiếu tạm ứng: chỉ CHÍNH người giữ sổ đã lập được tự ghi sổ; người được gắn làm người nhận về sau thì không.
      const t = id(1019);
      await lap(t, { maker: GIU_SO, payee: GIU_SO, makerKind: "CUSTODIAN_ADVANCE", amount: 20 });
      expect(await loi(sqlDuyet(t))).toBeNull();
      await db.exec(`UPDATE public.shareholders SET auth_user_id = '${CHU_A}' WHERE id = '${CD1}'`);
      await la(CHU_A);
      await chan(sqlGhiSo(t), "42501", "PROFIT_LEDGER_PAYEE_SELF_POST");
      await la(GIU_SO);
      expect(await loi(sqlGhiSo(t))).toBeNull();
      await la(CHU_B);
      // Người nhận lương điều hành gắn đăng nhập sau: cùng luật.
      const m = id(1016);
      await db.exec(`UPDATE public.profit_managers SET auth_user_id = NULL WHERE id = '${QL1}'`);
      await lap(m, { kind: "MANAGER", subject: QL1, maker: CHU_A, payee: null, amount: 10 });
      await db.exec(`UPDATE public.profit_managers SET auth_user_id = '${CHU_B}' WHERE id = '${QL1}'`);
      await chan(sqlDuyet(m), "42501", "PROFIT_LEDGER_PAYEE_SELF_APPROVE");
    });
  });
  it("cổ đông còn phiếu lương cần chủ xem lại (C4 NEEDS_REVIEW, phiếu lương sống) ⇒ 55000 PROFIT_LEDGER_SALARY_REVIEW_PENDING; phiếu lương chết thì duyệt được", async () => {
    await giaoDich(async () => {
      const luong = id(1017);
      await db.exec(`INSERT INTO public.income_expenses(id, organization_id, user_id, type, name, building_id, voucher_date, approval_status, account_id, total_amount)
          VALUES ('${luong}', '${ORG_A}', '${CHU_A}', 'EXPENSE', 'Phiếu lương', '${TOA_THUONG}', '${NGAY}', 'APPROVED', '${SO_B}', 500);
        INSERT INTO app_private.profit_ledger_salary_settlement_vouchers(organization_id, shareholder_id, staff_id, period_month, salary_voucher_id,
          investment_amount, advance_offset_amount, suggested_investment, sheet_status_at_quote, source, state)
        VALUES ('${ORG_A}', '${CD1}', '${GIU_SO}', '2026-10-01', '${luong}', 0, 0, 120, 'DRAFT', 'PAYOUT_FALLBACK', 'NEEDS_REVIEW')`);
      const p = id(1018);
      await lap(p);
      await la(CHU_B);
      const l = await chan(sqlDuyet(p), "55000", "PROFIT_LEDGER_SALARY_REVIEW_PENDING");
      expect(JSON.parse(l.detail ?? "{}")).toEqual({ count: 1, suggested: 120 });
      await db.exec(`UPDATE public.income_expenses SET approval_status = 'CANCELLED' WHERE id = '${luong}'`);
      expect(await loi(sqlDuyet(p))).toBeNull();
    });
  });
  it("cổ đông đã xoá / ngưng sau khi lập ⇒ 55000 PROFIT_LEDGER_SUBJECT_GONE", async () => {
    await giaoDich(async () => {
      const p = id(1012);
      await lap(p, { subject: CD2, payee: null });
      await db.exec(`UPDATE public.shareholders SET is_active = false WHERE id = '${CD2}'`);
      await la(CHU_B);
      await chan(sqlDuyet(p), "55000", "PROFIT_LEDGER_SUBJECT_GONE");
    });
  });
});

describe("F1 — bước GHI SỔ qua RPC thật post_approved / approve_and_post", () => {
  it("chủ A (giữ sổ A) ghi sổ phiếu chủ B đã duyệt: POSTED, bút toán trên đúng sổ A, sổ giảm đúng số, nhật ký PAYOUT_POSTED", async () => {
    await giaoDich(async () => {
      const p = id(1101);
      await lap(p, { amount: 250 });
      await la(CHU_B);
      expect(await loi(sqlDuyet(p))).toBeNull();
      const truoc = await tonSo(SO_A);
      await la(CHU_A);
      expect(await loi(sqlGhiSo(p))).toBeNull();
      const v = await phieu(p);
      expect(v).toMatchObject({ approval_status: "APPROVED", posting_status: "POSTED", account_id: SO_A });
      expect(await tonSo(SO_A)).toBe(truoc - 250);
      expect(await tongButToanPhieu(p)).toBe(-250);
      const nk = await nhatKy(p);
      expect(nk.map((x) => x.event_kind)).toEqual(["PAYOUT_APPROVED", "PAYOUT_POSTED"]);
      expect(nk[1]).toMatchObject({ actor_id: CHU_A, amount: "250.00", balance_before: null });
      expect(nk[1].payload).toMatchObject({ posting_id: v.active_posting_id_v2, account_id: SO_A, maker_kind: "OWNER" });
    });
  });
  it("người nhận (đang giữ sổ) tự ghi sổ phiếu chủ lập ⇒ 42501 PROFIT_LEDGER_PAYEE_SELF_POST", async () => {
    await giaoDich(async () => {
      const p = id(1102);
      await lap(p);
      await la(CHU_B);
      expect(await loi(sqlDuyet(p))).toBeNull();
      await la(GIU_SO);
      await chan(sqlGhiSo(p), "42501", "PROFIT_LEDGER_PAYEE_SELF_POST");
      expect(await phieu(p)).toMatchObject({ posting_status: "UNPOSTED" });
    });
  });
  it("ghi sổ bằng sổ quỹ khác sổ lúc lập ⇒ 55000 PROFIT_LEDGER_ACCOUNT_LOCKED, không còn bút toán nào", async () => {
    await giaoDich(async () => {
      const p = id(1103);
      await lap(p);
      await la(CHU_B);
      expect(await loi(sqlDuyet(p))).toBeNull();
      await la(CHU_A);
      await chan(sqlGhiSo(p, SO_C), "55000", "PROFIT_LEDGER_ACCOUNT_LOCKED");
      expect(await mot<number>(`SELECT count(*)::int AS v FROM public.income_expense_postings WHERE voucher_id = '${p}'`)).toBe(0);
    });
  });
  it("ghi sổ khi cờ ở SHADOW / FROZEN ⇒ 55000 (phiếu đã duyệt không ra tiền ngoài CANONICAL)", async () => {
    await giaoDich(async () => {
      const p = id(1104);
      await lap(p);
      await la(CHU_B);
      expect(await loi(sqlDuyet(p))).toBeNull();
      await la(CHU_A);
      await route("SHADOW");
      await chan(sqlGhiSo(p), "55000", "PROFIT_LEDGER_ROUTE_OFF");
      await route("FROZEN");
      await chan(sqlGhiSo(p), "55000", "PROFIT_LEDGER_FROZEN");
      await route("CANONICAL");
      expect(await loi(sqlGhiSo(p))).toBeNull();
    });
  });
  it("tạm ứng từ sổ mình giữ: chủ duyệt, chính người giữ sổ (người nhận) ghi sổ được", async () => {
    await giaoDich(async () => {
      const p = id(1105);
      await lap(p, { maker: GIU_SO, payee: GIU_SO, makerKind: "CUSTODIAN_ADVANCE", amount: 1200 });
      await la(CHU_B);
      expect(await loi(sqlDuyet(p))).toBeNull();
      await la(GIU_SO);
      expect(await loi(sqlGhiSo(p))).toBeNull();
      expect(await phieu(p)).toMatchObject({ posting_status: "POSTED" });
      expect((await nhatKy(p))[0].payload).toMatchObject({ within_amount: 1000, advance_amount: 200 });
    });
  });
  it("Duyệt và Chi một lần (approve_and_post_income_expense_v2): hai bước đều qua chốt, hai dòng nhật ký", async () => {
    await giaoDich(async () => {
      const p = id(1106);
      await lap(p, { maker: CHU_B, subject: CD2, payee: null, amount: 120 });
      await la(CHU_A);
      expect(await loi(sqlDuyetVaChi(p))).toBeNull();
      expect(await phieu(p)).toMatchObject({ approval_status: "APPROVED", posting_status: "POSTED", approved_by: CHU_A });
      expect((await nhatKy(p)).map((x) => x.event_kind)).toEqual(["PAYOUT_APPROVED", "PAYOUT_POSTED"]);
      const q = id(1107);
      await lap(q, { maker: CHU_A, subject: CD2, payee: null });
      await chan(sqlDuyetVaChi(q), "42501", "PROFIT_LEDGER_MAKER_SELF_APPROVE");
    });
  });
});

describe("F1 — đường vòng bị chặn, cột lúc nào cũng cho", () => {
  it("Huỷ duyệt (unapprove_voucher thật) ⇒ 55000 PROFIT_LEDGER_CANCEL_ONLY", async () => {
    await giaoDich(async () => {
      const p = id(1201);
      await lap(p);
      await la(CHU_B);
      expect(await loi(sqlDuyet(p))).toBeNull();
      await chan(`SELECT public.unapprove_voucher('${p}', NULL)`, "55000", "PROFIT_LEDGER_CANCEL_ONLY");
      // Huỷ duyệt kiểu cũ (approve_voucher ngược / post_financial_request): chỉ đổi trạng thái duyệt, không đụng review_state.
      await chan(`UPDATE public.income_expenses SET approval_status = 'UNAPPROVED', approved_by = NULL, approved_at = NULL WHERE id = '${p}'`,
        "55000", "PROFIT_LEDGER_CANCEL_ONLY");
    });
  });
  it("Yêu cầu sửa / Tranh chấp / Người lập rút phiếu / Từ chối vì sai (RPC V2 thật) ⇒ 55000 PROFIT_LEDGER_CANCEL_ONLY", async () => {
    await giaoDich(async () => {
      const p = id(1202);
      await lap(p);
      await la(CHU_B);
      await chan(`SELECT public.request_income_expense_changes_v2('${p}', 1, 'Sửa lại số tiền', '[]'::jsonb, '${khoa("sua")}')`,
        "55000", "PROFIT_LEDGER_CANCEL_ONLY");
      await chan(`SELECT public.mark_income_expense_disputed_v2('${p}', 1, '${mem(CHU_B)}', 'Đang tranh chấp', now() + interval '1 day', '${khoa("tc")}')`,
        "55000", "PROFIT_LEDGER_CANCEL_ONLY");
      await chan(`SELECT public.reject_invalid_income_expense_v2('${p}', 1, 'Phiếu sai', '${khoa("tcsai")}')`, "55000", "PROFIT_LEDGER_CANCEL_ONLY");
      await la(CHU_A);
      await chan(`SELECT public.withdraw_income_expense_v2('${p}', 1, 1, '${khoa("rut")}')`, "55000", "PROFIT_LEDGER_CANCEL_ONLY");
      expect(await phieu(p)).toMatchObject({ approval_status: "UNAPPROVED", review_state: "PENDING" });
    });
  });
  it("Hoàn tác bút toán (câu UPDATE của reverse_posted_income_expense_v2) ⇒ 55000 PROFIT_LEDGER_CANCEL_ONLY", async () => {
    await giaoDich(async () => {
      const p = id(1203);
      await lap(p);
      await la(CHU_B);
      expect(await loi(sqlDuyet(p))).toBeNull();
      await la(CHU_A);
      expect(await loi(sqlGhiSo(p))).toBeNull();
      await chan(`${coToken(p)}; UPDATE public.income_expenses SET active_posting_id_v2 = NULL, posting_status = 'REVERSED',
        reversed_by_posting_id = gen_random_uuid(), posting_version = posting_version + 1, updated_at = now() WHERE id = '${p}'`,
        "55000", "PROFIT_LEDGER_CANCEL_ONLY");
      // Chỉ đổi cờ ghi sổ sang REVERSED (kiểu cầu a85), không đổi con trỏ đảo: vẫn chặn đúng mã.
      await chan(`${coToken(p)}; UPDATE public.income_expenses SET posting_status = 'REVERSED', active_posting_id_v2 = NULL WHERE id = '${p}'`,
        "55000", "PROFIT_LEDGER_CANCEL_ONLY");
    });
  });
  it("Khôi phục phiếu đã huỷ (restore_income_expense thật, super admin) ⇒ 55000 PROFIT_LEDGER_CANCEL_ONLY", async () => {
    await giaoDich(async () => {
      const p = id(1204);
      await lap(p);
      await la(CHU_A);
      expect((await huy(p)).changed).toBe(true);
      await la(SUPER);
      await chan(`SELECT public.restore_income_expense('${p}')`, "55000", "PROFIT_LEDGER_CANCEL_ONLY");
    });
  });
  it("UPDATE trực tiếp (vai chủ bảng): số tiền / người nhận ⇒ PROFIT_LEDGER_LOCKED; sổ quỹ ⇒ PROFIT_LEDGER_ACCOUNT_LOCKED; xoá mềm ⇒ CANCEL_ONLY; DELETE ⇒ NO_DELETE", async () => {
    await giaoDich(async () => {
      const p = id(1205);
      await lap(p);
      const l = await chan(`UPDATE public.income_expenses SET total_amount = 1 WHERE id = '${p}'`, "55000", "PROFIT_LEDGER_LOCKED");
      expect(JSON.parse(l.detail ?? "{}")).toMatchObject({ columns: ["total_amount"] });
      await chan(`UPDATE public.income_expenses SET shareholder_id = '${CD2}' WHERE id = '${p}'`, "55000", "PROFIT_LEDGER_LOCKED");
      await chan(`UPDATE public.income_expenses SET system_source = NULL WHERE id = '${p}'`, "55000", "PROFIT_LEDGER_LOCKED");
      await chan(`UPDATE public.income_expenses SET account_id = '${SO_B}' WHERE id = '${p}'`, "55000", "PROFIT_LEDGER_ACCOUNT_LOCKED");
      await chan(`UPDATE public.income_expenses SET deleted_at = now() WHERE id = '${p}'`, "55000", "PROFIT_LEDGER_CANCEL_ONLY");
      await chan(`UPDATE public.income_expenses SET approval_status = 'CANCELLED', review_state = 'RESOLVED' WHERE id = '${p}'`,
        "55000", "PROFIT_LEDGER_CANCEL_ONLY");
      await chan(`DELETE FROM public.income_expenses WHERE id = '${p}'`, "55000", "PROFIT_LEDGER_NO_DELETE");
      // Xoá cứng cổ đông kéo ON DELETE SET NULL lên phiếu: cũng bị chặn.
      await chan(`DELETE FROM public.profit_allocations WHERE shareholder_id = '${CD1}'; DELETE FROM public.shareholders WHERE id = '${CD1}'`,
        "55000", "PROFIT_LEDGER_LOCKED");
    });
  });
  it("đánh dấu đã kiểm, gắn ảnh / ghi chú, bàn giao tiền mặt, cột máy tính ⇒ qua ở mọi trạng thái; sổ quỹ có mặt mà không đổi ⇒ qua", async () => {
    await giaoDich(async () => {
      const p = id(1206);
      await lap(p);
      const coi = [
        `UPDATE public.income_expenses SET verified_at = now(), verified_by = '${CHU_A}', verified_by_name = 'Chủ A', verified_note = 'đã xem' WHERE id = '${p}'`,
        `UPDATE public.income_expenses SET attachments = '[{"url":"a"}]', notes = 'ghi chú', updated_at = now() WHERE id = '${p}'`,
        `UPDATE public.income_expenses SET has_restricted_item = true, kqkd_amount = 0, counts_in_business_result = false WHERE id = '${p}'`,
        `UPDATE public.income_expenses SET account_id = account_id WHERE id = '${p}'`];
      for (const s of coi) expect(await loi(s), s).toBeNull();
      await la(CHU_B);
      expect(await loi(sqlDuyet(p))).toBeNull();
      await la(CHU_A);
      expect(await loi(sqlGhiSo(p))).toBeNull();
      // create_cash_handover: UPDATE income_expenses SET handover_id = <phiên> (phiếu đã duyệt / đã ghi sổ).
      expect(await loi(`UPDATE public.income_expenses SET handover_id = gen_random_uuid() WHERE id = '${p}'`)).toBeNull();
      for (const s of coi) expect(await loi(s), s).toBeNull();
    });
  });
  it("trong ngữ cảnh LẬP: đổi mọi cột được nhưng không rời trạng thái chờ duyệt ⇒ 55000 PROFIT_LEDGER_CONTEXT", async () => {
    await giaoDich(async () => {
      const p = id(1207);
      await lap(p);
      await db.exec(`INSERT INTO app_private.profit_ledger_write_contexts(income_expense_id, purpose) VALUES ('${p}', 'CREATE')`);
      expect(await loi(`UPDATE public.income_expenses SET notes = 'x', name = 'Đổi tên' WHERE id = '${p}'`)).toBeNull();
      await chan(`UPDATE public.income_expenses SET approval_status = 'APPROVED' WHERE id = '${p}'`, "55000", "PROFIT_LEDGER_CONTEXT");
      await chan(`DELETE FROM public.income_expenses WHERE id = '${p}'`, "55000", "PROFIT_LEDGER_NO_DELETE");
    });
  });
  it("trong ngữ cảnh HUỶ: chỉ sang Đã huỷ với cột huỷ / đảo; kèm đổi số tiền ⇒ PROFIT_LEDGER_LOCKED; không sang Đã huỷ ⇒ PROFIT_LEDGER_CONTEXT", async () => {
    await giaoDich(async () => {
      const p = id(1209);
      await lap(p);
      await db.exec(`INSERT INTO app_private.profit_ledger_write_contexts(income_expense_id, purpose) VALUES ('${p}', 'CANCEL')`);
      const l = await chan(`UPDATE public.income_expenses SET approval_status = 'CANCELLED', review_state = 'RESOLVED', total_amount = 1 WHERE id = '${p}'`,
        "55000", "PROFIT_LEDGER_LOCKED");
      expect(JSON.parse(l.detail ?? "{}")).toEqual({ columns: ["total_amount"] });
      await chan(`UPDATE public.income_expenses SET notes = 'x' WHERE id = '${p}'`, "55000", "PROFIT_LEDGER_CONTEXT");
      expect(await loi(`UPDATE public.income_expenses SET approval_status = 'CANCELLED', review_state = 'RESOLVED',
        cancellation_kind = 'CANCELLED_UNPOSTED' WHERE id = '${p}'`)).toBeNull();
    });
  });
  it("phiếu KHÔNG phải sổ tổng: duyệt / ghi sổ / huỷ duyệt / sửa tiền chạy như trước (F1 không bắn)", async () => {
    await giaoDich(async () => {
      const p = id(1208);
      await db.exec(`SELECT public.test_lap_phieu_thuong('${p}', 77, '${SO_A}', '${CHU_A}')`);
      await la(CHU_A);
      expect(await loi(sqlDuyet(p))).toBeNull();
      expect(await loi(sqlGhiSo(p))).toBeNull();
      expect(await phieu(p)).toMatchObject({ approval_status: "APPROVED", posting_status: "POSTED" });
      expect(await loi(`UPDATE public.income_expenses SET account_id = '${SO_C}', notes = 'đổi sổ' WHERE id = '${p}'`)).toBeNull();
      expect(await loi(`DELETE FROM public.income_expense_items WHERE income_expense_id = '${p}'`)).toBeNull();
      expect(await mot<number>(`SELECT count(*)::int AS v FROM app_private.profit_ledger_events WHERE voucher_id = '${p}'`)).toBe(0);
    });
  });
});

describe("F1b — chốt sau cầu a85 (cầu ghi sổ tự động thật nạp theo md5)", () => {
  const demButToan = (p: string) => mot<number>(
    `SELECT count(*)::int AS v FROM public.income_expense_postings WHERE voucher_id = '${p}' AND event_kind = 'POSTING'`);
  it("UPDATE không token chạm cột kích a85 (không đổi giá trị) trên phiếu đã duyệt chưa ghi sổ ⇒ 55000 PROFIT_LEDGER_V2_ONLY, không sinh bút toán; Ghi sổ V2 vẫn qua", async () => {
    await giaoDich(async () => {
      const p = id(1601);
      await lap(p, { amount: 250 });
      await la(CHU_B);
      expect(await loi(sqlDuyet(p))).toBeNull();
      // Câu UPDATE về sau thuộc giao dịch khác: không còn token của lần duyệt.
      await db.exec(`DELETE FROM app_private.ie_transition_authorization WHERE income_expense_id = '${p}'`);
      await la(CHU_A);
      for (const s of [
        `UPDATE public.income_expenses SET account_id = account_id, notes = 'ghi chú' WHERE id = '${p}'`,
        `UPDATE public.income_expenses SET total_amount = total_amount WHERE id = '${p}'`,
        `UPDATE public.income_expenses SET approval_status = approval_status, verified_note = 'đã xem' WHERE id = '${p}'`,
        `UPDATE public.income_expenses SET deleted_at = deleted_at, attachments = '[{"url":"b"}]' WHERE id = '${p}'`]) {
        const l = await chan(s, "55000", "PROFIT_LEDGER_V2_ONLY");
        expect(JSON.parse(l.detail ?? "{}")).toMatchObject({ posting_status: "POSTED" });
      }
      expect(await phieu(p)).toMatchObject({ approval_status: "APPROVED", posting_status: "UNPOSTED", active_posting_id_v2: null });
      expect(await demButToan(p)).toBe(0);
      expect(await nhatKy(p).then((x) => x.map((e) => e.event_kind))).toEqual(["PAYOUT_APPROVED"]);
      // Không chạm cột của a85 ⇒ qua như cũ.
      expect(await loi(`UPDATE public.income_expenses SET notes = 'ghi chú', verified_note = 'đã xem' WHERE id = '${p}'`)).toBeNull();
      // Đường V2 (có token) qua nguyên vẹn: đúng một bút toán, của RPC chứ không phải của cầu.
      expect(await loi(sqlGhiSo(p))).toBeNull();
      expect(await phieu(p)).toMatchObject({ posting_status: "POSTED" });
      expect(await demButToan(p)).toBe(1);
      expect(await mot<string>(`SELECT source_kind AS v FROM public.income_expense_postings WHERE voucher_id = '${p}'`)).toBe("MANUAL");
    });
  });
  it("nhánh ĐẢO của cầu a85 (sổ quỹ bị xoá mềm / thành sổ ảo) khi UPDATE không token chạm approval_status ⇒ 55000 PROFIT_LEDGER_V2_ONLY, phiếu vẫn POSTED, không bút toán đảo", async () => {
    await giaoDich(async () => {
      const p = id(1604);
      await lap(p, { amount: 80 });
      await la(CHU_B);
      expect(await loi(sqlDuyet(p))).toBeNull();
      await la(CHU_A);
      expect(await loi(sqlGhiSo(p))).toBeNull();
      await db.exec(`DELETE FROM app_private.ie_transition_authorization WHERE income_expense_id = '${p}'`);
      for (const doiSo of [`UPDATE public.accounts SET deleted_at = now() WHERE id = '${SO_A}'`,
        `UPDATE public.accounts SET deleted_at = NULL, is_virtual = true WHERE id = '${SO_A}'`]) {
        await db.exec(doiSo);
        const l = await chan(`UPDATE public.income_expenses SET approval_status = approval_status WHERE id = '${p}'`, "55000", "PROFIT_LEDGER_V2_ONLY");
        expect(JSON.parse(l.detail ?? "{}")).toMatchObject({ posting_status: "REVERSED", posting_status_before: "POSTED", active_posting_id_v2: null });
        expect(await phieu(p)).toMatchObject({ posting_status: "POSTED" });
        expect(await mot<number>(`SELECT count(*)::int AS v FROM public.income_expense_postings WHERE voucher_id = '${p}' AND event_kind = 'REVERSAL'`)).toBe(0);
      }
    });
  });
  it("lệnh huỷ (ngữ cảnh HUỶ) và Duyệt và Chi không bị ảnh hưởng; phiếu thường vẫn được cầu a85 tự ghi sổ như cũ", async () => {
    await giaoDich(async () => {
      const p = id(1602);
      await lap(p, { maker: CHU_B, subject: CD2, payee: null, amount: 70 });
      await la(CHU_A);
      expect(await loi(sqlDuyetVaChi(p))).toBeNull();
      expect(await demButToan(p)).toBe(1);
      await db.exec(`DELETE FROM app_private.ie_transition_authorization WHERE income_expense_id = '${p}'`);
      expect((await huy(p)).cancellation_kind).toBe("CANCELLED_AFTER_POSTING");
      expect(await tongButToanPhieu(p)).toBe(0);
      const q = id(1603);
      await db.exec(`SELECT public.test_lap_phieu_thuong('${q}', 33, '${SO_A}', '${CHU_A}')`);
      expect(await loi(`UPDATE public.income_expenses SET approval_status = 'APPROVED', approved_by = '${CHU_A}', approved_at = now(),
        review_state = 'RESOLVED' WHERE id = '${q}'`)).toBeNull();
      expect(await phieu(q)).toMatchObject({ approval_status: "APPROVED", posting_status: "POSTED" });
      expect(await mot<string>(`SELECT source_kind AS v FROM public.income_expense_postings WHERE voucher_id = '${q}'`)).toBe("LEGACY_BRIDGE");
    });
  });
});

describe("F2 — dòng hạng mục", () => {
  it("thêm / sửa / xoá dòng của phiếu sổ tổng ⇒ 55000 PROFIT_LEDGER_ITEMS_LOCKED; UPDATE không đổi gì thì qua", async () => {
    await giaoDich(async () => {
      const p = id(1301);
      await lap(p);
      await chan(`UPDATE public.income_expense_items SET unit_price = 1 WHERE income_expense_id = '${p}'`, "55000", "PROFIT_LEDGER_ITEMS_LOCKED");
      await chan(`INSERT INTO public.income_expense_items(income_expense_id, income_expense_type_id, unit_price) VALUES ('${p}', '${LOAI_CLN}', 5)`,
        "55000", "PROFIT_LEDGER_ITEMS_LOCKED");
      await chan(`DELETE FROM public.income_expense_items WHERE income_expense_id = '${p}'`, "55000", "PROFIT_LEDGER_ITEMS_LOCKED");
      await chan(`UPDATE public.income_expense_items SET income_expense_type_id = gen_random_uuid() WHERE income_expense_id = '${p}'`,
        "55000", "PROFIT_LEDGER_ITEMS_LOCKED");
      const q = id(1302);
      await db.exec(`SELECT public.test_lap_phieu_thuong('${q}', 10, '${SO_A}', '${CHU_A}')`);
      await chan(`UPDATE public.income_expense_items SET income_expense_id = '${p}' WHERE income_expense_id = '${q}'`, "55000", "PROFIT_LEDGER_ITEMS_LOCKED");
      expect(await loi(`UPDATE public.income_expense_items SET description = description WHERE income_expense_id = '${p}'`)).toBeNull();
      expect(await mot<string>(`SELECT total_amount::text AS v FROM public.income_expenses WHERE id = '${p}'`)).toBe("100.00");
    });
  });
});

describe("F5 — yêu cầu duyệt", () => {
  it("người lập rút yêu cầu duyệt (withdraw_financial_request_v1 thật) ⇒ 55000 PROFIT_LEDGER_CANCEL_ONLY; yêu cầu vẫn chờ, số dư vẫn trừ", async () => {
    await giaoDich(async () => {
      const p = id(1401);
      const req = await lap(p, { amount: 400 });
      await la(CHU_A);
      await chan(`SELECT public.withdraw_financial_request_v1('${req}', 'rút')`, "55000", "PROFIT_LEDGER_CANCEL_ONLY");
      expect(await yeuCau(p)).toBe("PENDING_APPROVAL");
      expect(await soDu("SHAREHOLDER", CD1)).toBe(600);
      await chan(`UPDATE public.approval_requests SET state = 'WITHDRAWN' WHERE id = '${req}'`, "55000", "PROFIT_LEDGER_CANCEL_ONLY");
    });
  });
  it("yêu cầu của phiếu thường rút được như cũ", async () => {
    await giaoDich(async () => {
      const p = id(1402);
      const req = await mot<string>(`SELECT public.test_lap_phieu_thuong('${p}', 10, '${SO_A}', '${CHU_A}') AS v`);
      await la(CHU_A);
      expect(await loi(`SELECT public.withdraw_financial_request_v1('${req}', 'rút')`)).toBeNull();
      expect(await yeuCau(p)).toBe("CANCELLED");
    });
  });
});

describe("E6 — profit_ledger_payout_cancel_v1", () => {
  it("huỷ phiếu CHỜ DUYỆT: CANCELLED_UNPOSTED, yêu cầu đóng CANCELLED (a75), số dư hồi, ghi huỷ + sự kiện + nhật ký", async () => {
    await giaoDich(async () => {
      const p = id(1501);
      await lap(p, { amount: 300 });
      expect(await soDu("SHAREHOLDER", CD1)).toBe(700);
      await la(CHU_B);
      const r = await huy(p, "Lập nhầm người nhận");
      expect(r).toEqual({ voucher_id: p, changed: true, cancellation_kind: "CANCELLED_UNPOSTED", reversal_posting_id: null, balance_after: 1000 });
      expect(await phieu(p)).toMatchObject({ approval_status: "CANCELLED", review_state: "RESOLVED", posting_status: "UNPOSTED",
        cancellation_kind: "CANCELLED_UNPOSTED", account_id: SO_A, shareholder_id: CD1 });
      expect(await yeuCau(p)).toBe("CANCELLED");
      expect(await mot<string>(`SELECT cancel_reason AS v FROM app_private.income_expense_cancellations WHERE income_expense_id = '${p}'`))
        .toBe("Lập nhầm người nhận");
      expect(await mot<string>(`SELECT action || ':' || old_status || '>' || new_status AS v FROM public.test_events WHERE voucher_id = '${p}'`))
        .toBe("CANCELLED:UNAPPROVED>CANCELLED");
      const nk = await nhatKy(p);
      expect(nk.map((x) => [x.event_kind, x.balance_before, x.balance_after, x.reason])).toEqual([
        ["PAYOUT_CANCELLED", "700.00", "1000.00", "Lập nhầm người nhận"]]);
      expect(await mot<number>(`SELECT count(*)::int AS v FROM app_private.profit_ledger_write_contexts`)).toBe(0);
      expect(await mot<number>(`SELECT count(*)::int AS v FROM app_private.ie_transition_authorization WHERE xid = pg_current_xact_id()`)).toBe(0);
    });
  });
  it("huỷ phiếu ĐÃ DUYỆT chưa ghi sổ: CANCELLED_UNPOSTED, yêu cầu giữ APPROVED", async () => {
    await giaoDich(async () => {
      const p = id(1502);
      await lap(p);
      await la(CHU_B);
      expect(await loi(sqlDuyet(p))).toBeNull();
      expect((await huy(p)).cancellation_kind).toBe("CANCELLED_UNPOSTED");
      expect(await yeuCau(p)).toBe("APPROVED");
      expect(await soDu("SHAREHOLDER", CD1)).toBe(1000);
    });
  });
  it("huỷ phiếu ĐÃ GHI SỔ: bút toán đảo, tổng bút toán của phiếu = 0, sổ quỹ về như trước, REVERSED", async () => {
    await giaoDich(async () => {
      const p = id(1503);
      await lap(p, { amount: 250 });
      const truoc = await tonSo(SO_A);
      await la(CHU_B);
      expect(await loi(sqlDuyet(p))).toBeNull();
      await la(CHU_A);
      expect(await loi(sqlGhiSo(p))).toBeNull();
      expect(await tonSo(SO_A)).toBe(truoc - 250);
      // Chủ B không giữ sổ A ⇒ không được đảo tiền về sổ đó; chủ A (giữ sổ A, không phải người nhận) huỷ được.
      await la(CHU_B);
      const lb = await chan(sqlHuy(p), "42501", "PROFIT_LEDGER_CANCEL_CUSTODIAN");
      expect(JSON.parse(lb.detail ?? "{}")).toEqual({ account_id: SO_A });
      await la(CHU_A);
      const r = await huy(p);
      expect(r).toMatchObject({ changed: true, cancellation_kind: "CANCELLED_AFTER_POSTING", balance_after: 1000 });
      expect(r.reversal_posting_id).toBeTruthy();
      expect(await tongButToanPhieu(p)).toBe(0);
      expect(await tonSo(SO_A)).toBe(truoc);
      expect(await phieu(p)).toMatchObject({ posting_status: "REVERSED", active_posting_id_v2: null, reversed_by_posting_id: r.reversal_posting_id });
      expect(await mot<string>(`SELECT idempotency_key || '|' || posted_on::text || '|' || posted_by_user_id::text AS v
        FROM public.income_expense_postings WHERE id = '${r.reversal_posting_id}'`)).toMatch(new RegExp(`^ledgercancel:.+\\|2026-11-15\\|${CHU_A}$`));
    });
  });
  it("lý do < 8 hoặc > 1000 ký tự ⇒ 22023; khoá chống gửi trùng sai dạng ⇒ 22023; phiếu thường ⇒ 22023", async () => {
    await giaoDich(async () => {
      const p = id(1504);
      await lap(p);
      await la(CHU_B);
      await chan(sqlHuy(p, "  ngắn  "), "22023", "PROFIT_LEDGER_CANCEL_REASON");
      await chan(sqlHuy(p, "x".repeat(1001)), "22023", "PROFIT_LEDGER_CANCEL_REASON");
      await chan(sqlHuy(p, "Lý do đủ dài ở đây", "ngan"), "22023", "PROFIT_LEDGER_IDEMPOTENCY_KEY");
      const q = id(1505);
      await db.exec(`SELECT public.test_lap_phieu_thuong('${q}', 10, '${SO_A}', '${CHU_A}')`);
      await chan(sqlHuy(q), "22023", "PROFIT_LEDGER_NOT_LEDGER_VOUCHER");
    });
  });
  it("không quyền chi ⇒ 42501; người ngoài công ty ⇒ 42501; người lập (không quyền chi) huỷ phiếu chờ của mình ⇒ qua, phiếu đã duyệt của mình ⇒ 42501", async () => {
    await giaoDich(async () => {
      const p = id(1506);
      await lap(p);
      await la(DUYET);
      await chan(sqlHuy(p), "42501", "PROFIT_LEDGER_CANCEL_FORBIDDEN");
      await la(NGOAI);
      await chan(sqlHuy(p), "42501", "PROFIT_LEDGER_NOT_MEMBER");
      await la(GIU_SO);
      await chan(sqlHuy(p), "42501", "PROFIT_LEDGER_CANCEL_FORBIDDEN");
      const q = id(1507);
      await lap(q, { maker: GIU_SO, payee: GIU_SO, makerKind: "CUSTODIAN_ADVANCE" });
      expect((await huy(q)).changed).toBe(true);
      const t = id(1508);
      await lap(t, { maker: GIU_SO, payee: GIU_SO, makerKind: "CUSTODIAN_ADVANCE" });
      await la(CHU_B);
      expect(await loi(sqlDuyet(t))).toBeNull();
      await la(GIU_SO);
      await chan(sqlHuy(t), "42501", "PROFIT_LEDGER_CANCEL_FORBIDDEN");
      await la(null);
      await chan(sqlHuy(t), "42501", "PROFIT_LEDGER_ACTOR_REQUIRED");
    });
  });
  it("huỷ hai lần ⇒ lần sau changed=false; cùng khoá ⇒ trả y hệt; cùng khoá khác lý do ⇒ 23505", async () => {
    await giaoDich(async () => {
      const p = id(1509);
      await lap(p);
      await la(CHU_B);
      const k = khoa("huy");
      const r1 = await huy(p, "Lý do huỷ lần một", k);
      expect(await huy(p, "Lý do huỷ lần một", k)).toEqual(r1);
      const r2 = await huy(p, "Lý do huỷ lần hai");
      expect(r2).toEqual({ voucher_id: p, changed: false, cancellation_kind: "CANCELLED_UNPOSTED", reversal_posting_id: null, balance_after: 1000 });
      await chan(sqlHuy(p, "Lý do khác hẳn đi", k), "23505", "PROFIT_LEDGER_IDEMPOTENCY_REUSED");
      expect(await mot<number>(`SELECT count(*)::int AS v FROM app_private.profit_ledger_events WHERE voucher_id = '${p}' AND event_kind = 'PAYOUT_CANCELLED'`)).toBe(1);
      expect(await mot<number>(`SELECT count(*)::int AS v FROM app_private.canonical_write_operations
        WHERE operation = 'shareholder_profit.ledger_cancel.v1' AND subject_id = '${p}' AND completed_at IS NOT NULL`)).toBe(2);
    });
  });
  it("cờ FROZEN / LEGACY ⇒ lệnh huỷ vẫn chạy (cả phiếu đã ghi sổ)", async () => {
    await giaoDich(async () => {
      const p = id(1510);
      await lap(p);
      await la(CHU_B);
      expect(await loi(sqlDuyet(p))).toBeNull();
      await la(CHU_A);
      expect(await loi(sqlGhiSo(p))).toBeNull();
      await route("FROZEN");
      expect((await huy(p)).cancellation_kind).toBe("CANCELLED_AFTER_POSTING");
      const q = id(1511);
      await lap(q);
      await route("LEGACY");
      expect((await huy(q)).changed).toBe(true);
    });
  });
  it("phiếu trong bàn giao ⇒ 55000 PROFIT_LEDGER_IN_HANDOVER; sổ quỹ đã chốt ⇒ P0001 [CASHBOOK_CLOSED]; tháng LN toà ảo đã chốt ⇒ P0001 [PROFIT_LOCKED]", async () => {
    await giaoDich(async () => {
      const p = id(1512);
      await lap(p);
      await la(CHU_B);
      expect(await loi(sqlDuyet(p))).toBeNull();
      await db.exec(`UPDATE public.income_expenses SET handover_id = gen_random_uuid() WHERE id = '${p}'`);
      await chan(sqlHuy(p), "55000", "PROFIT_LEDGER_IN_HANDOVER");
      const q = id(1513);
      await lap(q);
      await db.exec(`UPDATE public.accounts SET lock_date = '${NGAY}' WHERE id = '${SO_A}'`);
      await chan(sqlHuy(q), "P0001", "[CASHBOOK_CLOSED]");
      await db.exec(`UPDATE public.accounts SET lock_date = NULL WHERE id = '${SO_A}';
        INSERT INTO public.profit_monthly(organization_id, building_id, period_month, status, locked_at)
        VALUES ('${ORG_A}', '${TOA_AO}', '2026-11-01', 'LOCKED', now())`);
      await chan(sqlHuy(q), "P0001", "[PROFIT_LOCKED]");
    });
  });
  it("hậu kiểm tổng bút toán = 0: phiếu còn bút toán gốc lạc (không phải bút toán đang trỏ) ⇒ 55000 PROFIT_LEDGER_REVERSAL_UNBALANCED", async () => {
    await giaoDich(async () => {
      const p = id(1514);
      await lap(p, { amount: 90 });
      await la(CHU_B);
      expect(await loi(sqlDuyet(p))).toBeNull();
      await la(CHU_A);
      expect(await loi(sqlGhiSo(p))).toBeNull();
      await db.exec(`INSERT INTO public.income_expense_postings(organization_id, voucher_id, posting_subject_id, direction, account_id, gross_amount,
          voucher_amount_snapshot, amount_basis, net_cash_effect, posted_on, posted_by_membership_id, posted_by_user_id, approval_version,
          event_kind, idempotency_key, source_kind, posting_generation)
        VALUES ('${ORG_A}', '${p}', '${p}', 'EXPENSE', '${SO_A}', 90, 90, 'VOUCHER_TOTAL', -90, '2026-11-12', '${mem(CHU_A)}', '${CHU_A}', 1,
          'POSTING', 'lac-${p}', 'LEGACY_BRIDGE', 9);
        INSERT INTO public.income_expense_posting_lines(organization_id, posting_id, account_id, line_kind, signed_amount)
        SELECT '${ORG_A}', id, '${SO_A}', 'MAIN', -90 FROM public.income_expense_postings WHERE idempotency_key = 'lac-${p}'`);
      const l = await chan(sqlHuy(p), "55000", "PROFIT_LEDGER_REVERSAL_UNBALANCED");
      expect(JSON.parse(l.detail ?? "{}")).toEqual({ remaining: -90 });
      expect(await phieu(p)).toMatchObject({ approval_status: "APPROVED", posting_status: "POSTED" });
    });
  });
  it("người nhận không tự huỷ phiếu đã duyệt / đã chi (so cả đăng nhập lúc lập lẫn hiện tại) ⇒ 42501 PROFIT_LEDGER_CANCEL_PAYEE; phiếu chờ duyệt thì người nhận-người lập vẫn tự huỷ được", async () => {
    await giaoDich(async () => {
      // Cổ đông là chủ B (có quyền chi): phiếu do người giữ sổ lập trên sổ C, chủ A duyệt và ghi sổ.
      const p = id(1516);
      await lap(p, { subject: CD_CHU_B, payee: CHU_B, maker: GIU_SO, so: SO_C, amount: 50 });
      await la(CHU_A);
      expect(await loi(sqlDuyet(p))).toBeNull();
      await la(CHU_B);
      await chan(sqlHuy(p), "42501", "PROFIT_LEDGER_CANCEL_PAYEE");
      await la(CHU_A);
      expect(await loi(sqlGhiSo(p, SO_C))).toBeNull();
      const truoc = await tonSo(SO_C);
      await la(CHU_B);
      await chan(sqlHuy(p), "42501", "PROFIT_LEDGER_CANCEL_PAYEE");
      expect(await tonSo(SO_C)).toBe(truoc);
      expect(await phieu(p)).toMatchObject({ approval_status: "APPROVED", posting_status: "POSTED" });
      await la(CHU_A);
      expect((await huy(p)).cancellation_kind).toBe("CANCELLED_AFTER_POSTING");
      // Người nhận được gắn đăng nhập sau khi lập.
      const q = id(1517);
      await lap(q, { subject: CD2, payee: null, so: SO_C, amount: 40 });
      await la(CHU_B);
      expect(await loi(sqlDuyet(q))).toBeNull();
      await db.exec(`UPDATE public.shareholders SET auth_user_id = '${CHU_B}' WHERE id = '${CD2}'`);
      await chan(sqlHuy(q), "42501", "PROFIT_LEDGER_CANCEL_PAYEE");
      // Người nhận lúc lập (C2) bị gỡ đăng nhập về sau: vẫn là người nhận.
      const r = id(1520);
      await lap(r, { subject: CD_CHU_B, payee: CHU_B, maker: GIU_SO, so: SO_C, amount: 35 });
      await la(CHU_A);
      expect(await loi(sqlDuyet(r))).toBeNull();
      await db.exec(`UPDATE public.shareholders SET auth_user_id = NULL WHERE id = '${CD_CHU_B}'`);
      await la(CHU_B);
      await chan(sqlHuy(r), "42501", "PROFIT_LEDGER_CANCEL_PAYEE");
      // Phiếu CHỜ DUYỆT: người nhận đồng thời là người lập (tạm ứng) tự huỷ được.
      const t = id(1518);
      await lap(t, { maker: GIU_SO, payee: GIU_SO, makerKind: "CUSTODIAN_ADVANCE" });
      await la(GIU_SO);
      expect((await huy(t)).changed).toBe(true);
    });
  });
  it("hệ quả fail-closed: phiếu tạm ứng đã chi từ sổ chỉ chính người nhận giữ thì không ai huỷ được (người khác không giữ sổ ⇒ PROFIT_LEDGER_CANCEL_CUSTODIAN)", async () => {
    await giaoDich(async () => {
      const p = id(1519);
      await lap(p, { maker: GIU_SO, payee: GIU_SO, makerKind: "CUSTODIAN_ADVANCE", so: SO_D, amount: 30 });
      await la(CHU_B);
      expect(await loi(sqlDuyet(p))).toBeNull();
      await la(GIU_SO);
      expect(await loi(sqlGhiSo(p, SO_D))).toBeNull();
      for (const u of [CHU_A, CHU_B]) {
        await la(u);
        await chan(sqlHuy(p), "42501", "PROFIT_LEDGER_CANCEL_CUSTODIAN");
      }
      await la(GIU_SO);
      await chan(sqlHuy(p), "42501", "PROFIT_LEDGER_CANCEL_FORBIDDEN");
      expect(await phieu(p)).toMatchObject({ approval_status: "APPROVED", posting_status: "POSTED" });
    });
  });
  it("lệnh huỷ không đổi cột nào ngoài cột huỷ / đảo (sổ quỹ, người nhận, nguồn, công ty giữ nguyên)", async () => {
    await giaoDich(async () => {
      const p = id(1515);
      await lap(p);
      const truoc = await phieu(p);
      await la(CHU_A);
      await huy(p);
      const sau = await phieu(p);
      // updated_at = now() trùng giờ bắt đầu giao dịch của ca nên không hiện là "đổi".
      const doi = Object.keys(sau).filter((k) => JSON.stringify(sau[k]) !== JSON.stringify(truoc[k])).sort();
      expect(doi).toEqual(["approval_status", "approval_version", "cancellation_kind", "review_state"]);
    });
  });
});

describe("E6 — so trạng thái người huỷ đã thấy (p_expected_state; duyệt ‖ huỷ cùng một phiếu)", () => {
  /** Gọi theo TÊN tham số như PostgREST. */
  const sqlHuyTheoTen = (p: string, ky?: string) => `SELECT public.profit_ledger_payout_cancel_v1(p_voucher_id => '${p}',
    p_reason => 'Lý do huỷ đủ tám ký tự', p_idempotency_key => '${khoa("huy")}'${ky === undefined ? "" : `, p_expected_state => '${ky}'`}) AS v`;
  const dauVet = async (p: string) => ({
    huy: await mot<number>(`SELECT count(*)::int AS v FROM app_private.income_expense_cancellations WHERE income_expense_id = '${p}'`),
    nhatKy: (await nhatKy(p)).map((x) => x.event_kind),
    lenh: await mot<number>(`SELECT count(*)::int AS v FROM app_private.canonical_write_operations
      WHERE operation = 'shareholder_profit.ledger_cancel.v1' AND subject_scope = '${p}'`),
  });

  it("thấy CHỜ DUYỆT nhưng phiếu vừa được duyệt (duyệt thắng khoá hàng) ⇒ PT409 {expected, actual}; phiếu, yêu cầu, số dư, nhật ký không đổi, không để lại dòng chống gửi trùng", async () => {
    await giaoDich(async () => {
      const p = id(1521);
      await lap(p);
      await la(CHU_B);
      expect(await loi(sqlDuyet(p))).toBeNull();
      const truoc = await phieu(p);
      await la(CHU_A);
      const k = khoa("huy");
      const l = await chan(sqlHuy(p, undefined, k, "PENDING"), "PT409", "PROFIT_LEDGER_CANCEL_STATE_CHANGED");
      expect(JSON.parse(l.detail ?? "{}")).toEqual({ expected: "PENDING", actual: "APPROVED_UNPOSTED" });
      expect(await phieu(p)).toEqual(truoc);
      expect(await yeuCau(p)).toBe("APPROVED");
      expect(await soDu("SHAREHOLDER", CD1)).toBe(900);
      expect(await dauVet(p)).toEqual({ huy: 0, nhatKy: ["PAYOUT_APPROVED"], lenh: 0 });
      // Tải lại, thấy ĐÃ DUYỆT, vẫn quyết huỷ: lần trước cuộn lại hết nên cùng khoá vẫn dùng được.
      expect(await huy(p, undefined, k, "APPROVED_UNPOSTED")).toMatchObject({ changed: true, cancellation_kind: "CANCELLED_UNPOSTED" });
    });
  });
  it("thấy ĐÃ DUYỆT CHƯA CHI nhưng phiếu vừa ghi sổ ⇒ PT409, tiền không bị đảo; thấy ĐÃ CHI ⇒ huỷ và đảo về sổ", async () => {
    await giaoDich(async () => {
      const p = id(1522);
      await lap(p, { amount: 70 });
      await la(CHU_B);
      expect(await loi(sqlDuyet(p))).toBeNull();
      await la(CHU_A);
      expect(await loi(sqlGhiSo(p))).toBeNull();
      const so = await tonSo(SO_A);
      const l = await chan(sqlHuy(p, undefined, undefined, "APPROVED_UNPOSTED"), "PT409", "PROFIT_LEDGER_CANCEL_STATE_CHANGED");
      expect(JSON.parse(l.detail ?? "{}")).toEqual({ expected: "APPROVED_UNPOSTED", actual: "POSTED" });
      const l2 = await chan(sqlHuy(p, undefined, undefined, "PENDING"), "PT409", "PROFIT_LEDGER_CANCEL_STATE_CHANGED");
      expect(JSON.parse(l2.detail ?? "{}")).toEqual({ expected: "PENDING", actual: "POSTED" });
      expect(await tonSo(SO_A)).toBe(so);
      expect(await phieu(p)).toMatchObject({ approval_status: "APPROVED", posting_status: "POSTED", reversed_by_posting_id: null });
      expect((await dauVet(p)).huy).toBe(0);
      expect(await huy(p, undefined, undefined, "POSTED")).toMatchObject({ changed: true, cancellation_kind: "CANCELLED_AFTER_POSTING" });
      expect(await tonSo(SO_A)).toBe(so + 70);
    });
  });
  it("thấy đúng trạng thái ⇒ huỷ như cũ; gọi theo tên tham số như PostgREST, có hay không p_expected_state đều chạy (không mơ hồ)", async () => {
    await giaoDich(async () => {
      const p = id(1523);
      await lap(p);
      await la(CHU_B);
      expect(await huy(p, undefined, undefined, "PENDING")).toMatchObject({ changed: true, cancellation_kind: "CANCELLED_UNPOSTED" });
      const q = id(1524);
      await lap(q);
      expect(await loi(sqlDuyet(q))).toBeNull();
      expect(await mot<Record<string, unknown>>(sqlHuyTheoTen(q, "APPROVED_UNPOSTED"))).toMatchObject({ changed: true });
      const t = id(1525);
      await lap(t);
      expect(await mot<Record<string, unknown>>(sqlHuyTheoTen(t))).toMatchObject({ changed: true });
      // Truyền NULL tường minh (4 tham số) = không so trạng thái: phiếu đã huỷ ⇒ changed=false.
      expect(await huy(t, undefined, undefined, null)).toMatchObject({ changed: false });
    });
  });
  it("phiếu đã huỷ: có kỳ vọng ⇒ PT409 actual CANCELLED, không kỳ vọng ⇒ changed=false như cũ; gửi lại CÙNG khoá + cùng kỳ vọng sau khi đã huỷ ⇒ trả y hệt (phát lại đứng trước so trạng thái)", async () => {
    await giaoDich(async () => {
      const p = id(1526);
      await lap(p);
      await la(CHU_B);
      const k = khoa("huy");
      const r1 = await huy(p, undefined, k, "PENDING");
      expect(r1).toMatchObject({ changed: true });
      expect(await huy(p, undefined, k, "PENDING")).toEqual(r1);
      const l = await chan(sqlHuy(p, undefined, undefined, "PENDING"), "PT409", "PROFIT_LEDGER_CANCEL_STATE_CHANGED");
      expect(JSON.parse(l.detail ?? "{}")).toEqual({ expected: "PENDING", actual: "CANCELLED" });
      expect(await huy(p)).toMatchObject({ changed: false });
      expect((await dauVet(p)).nhatKy).toEqual(["PAYOUT_CANCELLED"]);
    });
  });
  it("cùng khoá mà khác kỳ vọng (kể cả có ↔ không) ⇒ 23505; không kỳ vọng thì băm y như bản cũ; kỳ vọng ngoài PENDING / APPROVED_UNPOSTED / POSTED ⇒ 22023", async () => {
    await giaoDich(async () => {
      const lyDo = "Lý do cố định tám";
      const p = id(1527);
      await lap(p);
      await la(CHU_B);
      const k = khoa("huy");
      expect((await huy(p, lyDo, k, "PENDING")).changed).toBe(true);
      await chan(sqlHuy(p, lyDo, k, "APPROVED_UNPOSTED"), "23505", "PROFIT_LEDGER_IDEMPOTENCY_REUSED");
      await chan(sqlHuy(p, lyDo, k), "23505", "PROFIT_LEDGER_IDEMPOTENCY_REUSED");
      const q = id(1528);
      await lap(q);
      const k2 = khoa("huy");
      expect((await huy(q, lyDo, k2)).changed).toBe(true);
      await chan(sqlHuy(q, lyDo, k2, "PENDING"), "23505", "PROFIT_LEDGER_IDEMPOTENCY_REUSED");
      expect(await mot<string>(`SELECT payload_hash AS v FROM app_private.canonical_write_operations
        WHERE operation = 'shareholder_profit.ledger_cancel.v1' AND idempotency_key = '${k2}'`))
        .toBe(await mot<string>(`SELECT md5(jsonb_build_object('voucher_id', '${q}'::uuid, 'reason', '${lyDo}')::text) AS v`));
      for (const sai of ["pending", "CANCELLED", "APPROVED", ""]) {
        const l = await chan(sqlHuy(q, undefined, undefined, sai), "22023", "PROFIT_LEDGER_BAD_INPUT");
        expect(JSON.parse(l.detail ?? "{}")).toEqual({ expected_state: sai });
      }
    });
  });
});
