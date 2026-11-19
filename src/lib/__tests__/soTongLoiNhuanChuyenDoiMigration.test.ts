import { readFileSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * Đợt 3 của sổ tổng lợi nhuận: 20261115113530 (D3a — chuyển đổi) và 20261115113532 (D3b — siết đọc thẳng + bật).
 *
 * Chạy THẬT trên PostgreSQL nhúng:
 *  - M1 (20261115063149) nguyên file; các hàm Đợt 1 mà D3 gọi (ghi bù lương của M3, đặt mốc của M2-tạo) và các hàm
 *    nền (quyền v3, khoá công ty, công tắc, KQKD, nhật ký phiếu) là ĐỊNH NGHĨA MỚI NHẤT trước D3a trong
 *    supabase/migrations (không có thì baseline) — tức đúng thân sẽ chạy trên production;
 *  - hai khoá chặn sửa phiếu (a02_ie_profit_lock_upd, a00_ie_owned_payload_freeze) là bản giả cùng TÊN, cùng chỗ
 *    chặn (tháng đã chốt / phiếu canonical); trigger ie_business_result là thân thật;
 *  - các hằng ghim của file (dấu vân tay, md5 id chủ thể) là số của production, nên test thay bằng số của dữ liệu
 *    giả (tính độc lập bằng JS), UUID phiếu thì dùng lại nguyên UUID ghim.
 * Ca có dữ liệu thật (số dư từng người, engine duyệt thật, JWT/RLS 4 tổ hợp, bản lùi R1–R7) chạy trên TEST bằng
 * test-env:thu-sql (thư mục hồ sơ, d3_*).
 * Ca có tên mở đầu "[ghim]" chỉ đo văn bản / md5 — script đột biến cần ít nhất một ca KHÁC đỏ.
 */
const DIR = "supabase/migrations";
const FILE_D3A = `${DIR}/20261115113530_so_tong_loi_nhuan_chuyen_doi.sql`;
const FILE_D3B = `${DIR}/20261115113532_so_tong_loi_nhuan_bat.sql`;
const FILE_M1 = `${DIR}/20261115063149_so_tong_loi_nhuan_nen.sql`;
const FILE_M2_TAO = `${DIR}/20261115084108_so_tong_loi_nhuan_tao.sql`;
const BASELINE = "supabase/baseline/schema.sql";
const MOC_BASELINE = "20260805120000";
const MOC_D3A = "20261115113530";

const md5 = (s: string) => createHash("md5").update(s.replace(/\r/g, ""), "utf8").digest("hex");
function cauLenhTaoHam(sql: string, ten: string): string {
  const mo = new RegExp(`CREATE\\s+(?:OR\\s+REPLACE\\s+)?FUNCTION\\s+${ten.replace(".", "\\.")}\\s*\\(`, "i").exec(sql);
  if (!mo) throw new Error(`Không thấy câu tạo hàm ${ten}`);
  const sau = sql.slice(mo.index);
  const the = /\bAS\s+(\$[a-z_]*\$)/i.exec(sau);
  if (!the) throw new Error(`Không thấy dollar-quote của ${ten}`);
  const dong = sau.indexOf(the[1], the.index + the[0].length);
  return sau.slice(0, sau.indexOf(";", dong) + 1);
}
function thanHam(cau: string): string {
  const the = /\bAS\s+(\$[a-z_]*\$)/i.exec(cau)!;
  const bd = the.index + the[0].length;
  return cau.slice(bd, cau.indexOf(the[1], bd)).replace(/\r/g, "");
}
const BASE_SQL = readFileSync(BASELINE, "utf8");
/** Định nghĩa mới nhất TRƯỚC D3a (migration sau mốc baseline), không có thì baseline. */
function dinhNghiaTruocD3(ten: string): string {
  const re = new RegExp(`CREATE\\s+(?:OR\\s+REPLACE\\s+)?FUNCTION\\s+${ten.replace(".", "\\.")}\\s*\\(`, "i");
  let hit: string | null = null;
  for (const f of readdirSync(DIR).filter((x) => x.endsWith(".sql") && x > MOC_BASELINE && x < MOC_D3A).sort()) {
    const sql = readFileSync(`${DIR}/${f}`, "utf8");
    if (re.test(sql)) hit = sql;
  }
  return cauLenhTaoHam(hit ?? BASE_SQL, ten);
}
const boGiaoDich = (sql: string) => sql.replace(/^\s*BEGIN;\s*$/m, "").replace(/^\s*COMMIT;\s*$/m, "");

const HAM_NEN = [
  "app_private.authorized_scope_v3", "app_private.profit_viewer_can_v1", "app_private.raise_malformed_override",
  "app_private.authorize_tenant_action_v3", "app_private.lock_org_for_decision_v1", "app_private.finance_v2_has_covering_deny",
  "app_private.evaluate_feature_route", "app_private.set_feature_route_v1", "app_private.claim_feature_operation_v1",
  "app_private.cashbook_closed_through_v1", "public.recompute_ie_business_result", "public.trg_ie_recompute_business_result",
  "app_private.append_income_expense_event_v1", "public.current_shareholder_id",
].map(dinhNghiaTruocD3);
/** Hàm Đợt 1 (sau M1) mà D3 gọi hoặc ghim md5. */
const HAM_DOT1 = [
  "app_private.profit_ledger_luong_co_dong_v1", "app_private.profit_ledger_luong_so_v1", "app_private.salary_investment_profit_v1",
  "app_private.salary_profit_month_caps_v1", "app_private.profit_ledger_luong_backfill_v1",
  "app_private.profit_ledger_tao_check_month_v1", "app_private.profit_ledger_tao_assert_route_v1",
  "app_private.profit_ledger_tao_advance_erased_v1", "app_private.profit_ledger_tao_set_marker_v1",
  "public.shareholder_profit_ledger_payout_v1", "app_private.guard_profit_ledger_payout_v1",
].map(dinhNghiaTruocD3);
const M1 = readFileSync(FILE_M1, "utf8");
const D3A_GOC = readFileSync(FILE_D3A, "utf8");
const D3B_GOC = readFileSync(FILE_D3B, "utf8");
/** Lệnh set_config mang S2: còn chuỗi giữ chỗ (trước khi điền) hoặc 40 hex (đã điền). Test luôn dựng từ dạng khuôn. */
const DONG_S2 = /SELECT set_config\('ihomecrm\.d3b_commit_sha', '([^']*)', true\);/;
const D3B_KHUON = D3B_GOC.replace(DONG_S2, "SELECT set_config('ihomecrm.d3b_commit_sha', '<<SHA_PRODUCTION_WEB>>', true);");

// ── Dữ liệu giả ────────────────────────────────────────────────────────────────
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const mem = (u: string) => u.replace("4000-8000-0000000000", "4000-8000-1000000000");
const ORG = "aaaa0000-0000-4000-8000-000000000001"; // D3 ghim cứng công ty thật — fixture dùng đúng id này
const ORG_B = id(2);
const [CHU, CHU2, NV_J, NV_N, NV_B, NGOAI] = [11, 12, 13, 14, 15, 16].map(id);
const [VAI_CHU, VAI_NV, VAI_B] = [31, 32, 33].map(id);
const [PV, PV_B] = [41, 42].map(id);
const [TOA_AO, TOA_1, TOA_2] = [51, 52, 53].map(id);
const [SO_1, SO_2, SO_3] = [54, 55, 56].map(id);
const [SH_J, SH_N, SH_B, SH_X] = ["0a", "0b", "0c", "0d"].map((x) => `00000000-0000-4000-8000-0000000061${x}`);
const [QL_1, QL_2] = [71, 72].map(id);
const [LOAI_LUONG, LOAI_CLN, LOAI_KHAC] = [91, 92, 93].map(id);
// Phiếu: dùng lại nguyên UUID ghim trong D3a.
const V_N9 = "05ac6ab0-c040-4b07-bcc3-a71b33487620";
const V_J5 = "3190c381-3105-47a9-8909-0e9ad8eac7db";
const V_N5 = "9368677b-2f85-4afe-8954-ff9b440c805b";
const V_J9 = "212c16f8-67b3-49a9-b2d3-094d509328a3";
const X3_A = "2488536d-1a38-4f8e-840e-d27cb690629c"; // canonical, hạng mục không hạn chế
const X3_B = "33c8b388-079a-48d7-a7a7-ab0141b26eb8"; // canonical, hạng mục hạn chế
const X3_C = "d66ba7f7-a7d9-4123-8ed0-4e3e53b6cd45"; // tháng 5 đã chốt, hạng mục hạn chế, cờ đang lệch false
const X3_D = "e6bff80c-ec79-4073-9a8a-b7bb4256adba"; // như C
const X3 = [X3_A, X3_B, X3_C, X3_D];
const BUT_TOAN: Record<string, string> = { [X3_A]: id(301), [X3_B]: id(302), [X3_C]: id(303), [X3_D]: id(304) };
const SO_X3: Record<string, string> = { [X3_A]: SO_1, [X3_B]: SO_2, [X3_C]: SO_3, [X3_D]: SO_3 };
const TIEN_X3: Record<string, number> = { [X3_A]: 650, [X3_B]: 900, [X3_C]: 446, [X3_D]: 401 };
const NGAY_X3: Record<string, string> = { [X3_A]: "2026-10-30", [X3_B]: "2026-07-28", [X3_C]: "2026-05-21", [X3_D]: "2026-05-21" };
const MA_X3: Record<string, string> = { [X3_A]: "PC-X3A", [X3_B]: "PC-X3B", [X3_C]: "PC-X3C", [X3_D]: "PC-X3D" };
const SHA_THU = "0123456789abcdef0123456789abcdef01234567";

// Phân bổ đã chốt: [chủ thể, toà, tháng, số].
const PHAN_BO: [string, string, string, number][] = [
  [SH_J, TOA_1, "2026-05-01", 100], [SH_J, TOA_1, "2026-07-01", 50], [SH_J, TOA_1, "2026-08-01", 40], [SH_J, TOA_1, "2026-09-01", 30],
  [SH_N, TOA_1, "2026-05-01", 200], [SH_N, TOA_1, "2026-07-01", 60], [SH_N, TOA_1, "2026-08-01", 50], [SH_N, TOA_1, "2026-09-01", 70],
  [SH_N, TOA_2, "2026-09-01", 25], // toà 2 chốt SAU giờ lập phiếu lương T9 ⇒ không thuộc phần đầu tư của phiếu đó
  [SH_B, TOA_1, "2026-05-01", 1000], [SH_B, TOA_1, "2026-09-01", -20],
];
const PHAN_BO_QL: [string, number][] = [[QL_1, 300], [QL_2, 500]];

/** md5 dấu vân tay đầu vào số dư (cùng công thức D3a): kind|id|phân bổ|phiếu duyệt|phiếu chờ. */
function vanTayDauVao(them: [string, number][] = []): string {
  const alloc = new Map<string, number>();
  for (const [s, , , t] of PHAN_BO) alloc.set(s, (alloc.get(s) ?? 0) + t);
  for (const [s, t] of them) alloc.set(s, (alloc.get(s) ?? 0) + t);
  const dong = [
    ...[QL_1, QL_2].map((q) => ({ k: "MANAGER", id: q, a: PHAN_BO_QL.find(([x]) => x === q)![1] })),
    ...[SH_J, SH_N, SH_B, SH_X].map((s) => ({ k: "SHAREHOLDER", id: s, a: alloc.get(s) ?? 0 })),
  ].sort((x, y) => (x.k === y.k ? (x.id < y.id ? -1 : 1) : x.k < y.k ? -1 : 1));
  return md5(dong.map((d) => `${d.k}|${d.id}|${d.a.toFixed(2)}|0.00|0.00`).join(","));
}
const VAN_TAY_X2 = md5([
  `${V_N9}|${SH_N}|2026-09-01|3000.00|70.00`,
  `${V_J5}|${SH_J}|2026-05-01|1000.00|100.00`,
  `${V_N5}|${SH_N}|2026-05-01|2000.00|200.00`,
].join(","));
const VAN_TAY_X3 = md5([...X3].sort().map((x) =>
  `${x}|${MA_X3[x]}|${TIEN_X3[x].toFixed(2)}|APPROVED|POSTED|${TOA_AO}|${SO_X3[x]}|${BUT_TOAN[x]}|null`).join(","));

/** Thay hằng ghim của production bằng số của dữ liệu giả. */
const GHIM_PROD = {
  dauVao: "b723ab755df14f7d124c0339dccf7b2d", x2: "60d7896b431a2bd36c10b83d27a0c0e3", x3: "134f6ac23c77677bbb901cc1c8100a00",
  shJ: "0568d869494cff82b3723d08ce7a7f93", shN: "7583daba684a285cf80f34d83f8f578c",
  qlXoa: "8ed6564e0e6a931a1b17829ebc824f7e", ql: "faa25320f50b68402328d2ea2fffca9a",
};
const thayHet = (s: string, cu: string, moi: string) => s.split(cu).join(moi);
function ghim(sql: string, o: { dauVao?: string; x2?: string; x3?: string } = {}): string {
  let s = sql;
  for (const [cu, moi] of [
    [GHIM_PROD.dauVao, o.dauVao ?? vanTayDauVao()], [GHIM_PROD.x2, o.x2 ?? VAN_TAY_X2], [GHIM_PROD.x3, o.x3 ?? VAN_TAY_X3],
    [GHIM_PROD.shJ, md5(SH_J)], [GHIM_PROD.shN, md5(SH_N)], [GHIM_PROD.qlXoa, md5(QL_2)], [GHIM_PROD.ql, md5(QL_1)],
  ]) s = thayHet(s, cu, moi);
  return s;
}
const D3A = (o?: Parameters<typeof ghim>[1]) => boGiaoDich(ghim(D3A_GOC, o));
const D3B = (sha: string | null = SHA_THU) =>
  boGiaoDich(ghim(sha === null ? D3B_KHUON : D3B_KHUON.replace("<<SHA_PRODUCTION_WEB>>", sha)));

const NEN = `
  CREATE ROLE authenticated; CREATE ROLE anon; CREATE ROLE service_role;
  CREATE SCHEMA auth; CREATE SCHEMA app_private;
  GRANT USAGE ON SCHEMA public, auth, app_private TO authenticated, anon, service_role;
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
    status text NOT NULL DEFAULT 'ACTIVE', revoked_at timestamptz, valid_from timestamptz NOT NULL DEFAULT '2020-01-01', valid_to timestamptz,
    activated_at timestamptz);
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
    code text, is_virtual boolean NOT NULL DEFAULT false, deleted_at timestamptz, created_at timestamptz NOT NULL DEFAULT now());
  CREATE TABLE public.accounts(id uuid PRIMARY KEY, organization_id uuid NOT NULL, name text NOT NULL DEFAULT 'Sổ quỹ',
    is_virtual boolean NOT NULL DEFAULT false, lock_date date, deleted_at timestamptz);
  CREATE TABLE app_private.server_feature_flags(feature_key text PRIMARY KEY, domain text NOT NULL,
    risk_class text NOT NULL DEFAULT 'MONEY', mode text NOT NULL DEFAULT 'OFF' CHECK (mode IN ('OFF','SHADOW','CANARY','ON')),
    force_freeze boolean NOT NULL DEFAULT false, config_version bigint NOT NULL DEFAULT 1, starts_at timestamptz, ends_at timestamptz,
    max_operation_count integer, max_single_amount_vnd numeric(15,2), max_total_amount_vnd numeric(15,2),
    commit_sha text, migration_sha256 text, maintenance_window_id text, approval_reference text,
    reason text, updated_by uuid, updated_at timestamptz NOT NULL DEFAULT now());
  CREATE TABLE app_private.server_feature_flag_events(id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, feature_key text NOT NULL,
    event_type text NOT NULL, before_mode text, after_mode text, before_version bigint, after_version bigint, detail jsonb, actor uuid,
    created_at timestamptz NOT NULL DEFAULT now());
  CREATE TABLE app_private.server_feature_flag_canary_orgs(feature_key text NOT NULL, organization_id uuid NOT NULL);
  CREATE TABLE app_private.server_feature_flag_operations(id bigserial PRIMARY KEY, feature_key text NOT NULL, config_version bigint NOT NULL,
    operation_key text NOT NULL, organization_id uuid NOT NULL, amount_vnd numeric(15,2) NOT NULL DEFAULT 0);
  CREATE FUNCTION public.org_today_v1(p_organization_id uuid DEFAULT NULL) RETURNS date LANGUAGE sql STABLE
    AS $$ SELECT DATE '2026-11-15' $$;
  CREATE TABLE public.shareholders(id uuid PRIMARY KEY, organization_id uuid NOT NULL REFERENCES public.organizations(id), user_id uuid,
    auth_user_id uuid UNIQUE, name text NOT NULL, is_active boolean NOT NULL DEFAULT true, deleted_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now());
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
  CREATE TABLE public.building_shareholders(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid, building_id uuid NOT NULL,
    shareholder_id uuid NOT NULL, percent numeric(5,2) NOT NULL DEFAULT 0, organization_id uuid);
  CREATE TABLE public.income_expense_types(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name text NOT NULL,
    type text NOT NULL CHECK (type IN ('income','expense')), user_id uuid NOT NULL, category text,
    is_restricted boolean NOT NULL DEFAULT false, organization_id uuid NOT NULL, force_approval boolean NOT NULL DEFAULT false,
    system_only boolean NOT NULL DEFAULT false, rule_key text, manual_hidden boolean NOT NULL DEFAULT false,
    quick_entry_hidden boolean NOT NULL DEFAULT false, internal_transfer boolean NOT NULL DEFAULT false);
  CREATE TABLE public.income_expenses(
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL, code text, type text NOT NULL CHECK (type IN ('INCOME','EXPENSE')),
    name text NOT NULL, building_id uuid NOT NULL, voucher_date date NOT NULL,
    total_amount numeric(15,2) NOT NULL DEFAULT 0 CHECK (total_amount >= 0),
    approval_status text NOT NULL DEFAULT 'APPROVED' CHECK (approval_status IN ('UNAPPROVED','APPROVED','CANCELLED')),
    notes text, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
    deleted_at timestamptz, account_id uuid, business_result_accounting boolean, counts_in_business_result boolean NOT NULL DEFAULT true,
    shareholder_id uuid REFERENCES public.shareholders(id) ON DELETE SET NULL, handover_id uuid, has_restricted_item boolean NOT NULL DEFAULT false,
    salary_staff_id uuid, salary_role text, profit_manager_id uuid REFERENCES public.profit_managers(id) ON DELETE SET NULL,
    kqkd_amount numeric(15,2) NOT NULL DEFAULT 0, system_source text, organization_id uuid NOT NULL, approval_request_id uuid,
    posting_status text, active_posting_id_v2 uuid, idempotency_key text, source_payload_hash text);
  CREATE TABLE public.income_expense_items(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    income_expense_id uuid NOT NULL REFERENCES public.income_expenses(id) ON DELETE CASCADE,
    income_expense_type_id uuid NOT NULL, quantity numeric(15,4) NOT NULL DEFAULT 1, unit_price numeric(15,2) NOT NULL DEFAULT 0,
    amount numeric(15,2), organization_id uuid,
    accounting_class text NOT NULL DEFAULT 'PNL' CHECK (accounting_class IN ('PNL','DEPOSIT','CUSTOMER_CREDIT','INTERNAL')));
  CREATE TABLE public.income_expense_postings(id uuid PRIMARY KEY, organization_id uuid NOT NULL, voucher_id uuid);
  CREATE TABLE public.income_expense_posting_lines(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL,
    posting_id uuid NOT NULL, account_id uuid NOT NULL, signed_amount numeric(18,2) NOT NULL);
  CREATE TABLE app_private.income_expense_flow_ownership(income_expense_id uuid PRIMARY KEY, organization_id uuid NOT NULL);
  CREATE TABLE public.income_expense_audit_log(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), income_expense_id uuid NOT NULL, action text NOT NULL,
    actor_id uuid, actor_name text, old_status text, new_status text, note text, created_at timestamptz NOT NULL DEFAULT now(),
    organization_id uuid NOT NULL, sequence_no bigint, prev_event_hash text, event_hash text, hash_scheme text);
  CREATE TABLE app_private.income_expense_audit_chain_heads(organization_id uuid PRIMARY KEY, last_sequence_no bigint NOT NULL DEFAULT 0,
    last_event_hash text NOT NULL DEFAULT repeat('0', 64), updated_at timestamptz NOT NULL DEFAULT clock_timestamp());
  CREATE TABLE public.approval_requests(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL,
    submission_no integer NOT NULL DEFAULT 1, subject_type text NOT NULL, subject_id uuid NOT NULL, state text NOT NULL, system_source text);
  CREATE TABLE public.profit_payout_reservations(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid, payout_voucher_id uuid,
    shareholder_id uuid, amount numeric(15,2));
  CREATE TABLE app_private.canonical_write_operations(organization_id uuid NOT NULL, operation text NOT NULL, subject_scope text NOT NULL,
    actor_id uuid NOT NULL, idempotency_key text NOT NULL, payload_hash text NOT NULL, subject_id uuid, response_payload jsonb,
    created_at timestamptz NOT NULL DEFAULT now(), completed_at timestamptz, actor_membership_id uuid, transaction_id xid8,
    PRIMARY KEY (organization_id, operation, subject_scope, actor_id, idempotency_key),
    CHECK (((completed_at IS NULL) = (response_payload IS NULL)) AND ((completed_at IS NULL) = (subject_id IS NULL))),
    CHECK (idempotency_key ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{7,199}$'), CHECK (char_length(payload_hash) = 32));
  CREATE TABLE app_private.cashbook_closures(id bigserial PRIMARY KEY, organization_id uuid, cashbook_id uuid NOT NULL, closed_through date NOT NULL);
  CREATE TABLE app_private.cashbook_reopenings(id bigserial PRIMARY KEY, cashbook_id uuid NOT NULL, last_closure_id bigint);
  CREATE TABLE public.salary_monthly(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid, staff_id uuid NOT NULL, period_month date NOT NULL,
    status text NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT','LOCKED')),
    investment_profit numeric(15,2) NOT NULL DEFAULT 0, advances_total numeric(15,2) NOT NULL DEFAULT 0,
    take_home numeric(15,2) NOT NULL DEFAULT 0, paid numeric(15,2) NOT NULL DEFAULT 0,
    payout_voucher_id uuid REFERENCES public.income_expenses(id) ON DELETE SET NULL,
    locked_at timestamptz, organization_id uuid, updated_at timestamptz DEFAULT now(), UNIQUE (staff_id, period_month));
  CREATE TABLE app_private.salary_line_overrides(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), seq bigint GENERATED ALWAYS AS IDENTITY,
    organization_id uuid NOT NULL, staff_id uuid NOT NULL, period_month date NOT NULL, line_key text NOT NULL, amount numeric(14,2),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp());
  -- Lệnh chi lợi nhuận cũ: vỏ cùng chữ ký (X4 chỉ thu quyền). Cửa lập tay compat đã thu ở Đợt 1 (D1.8).
  CREATE FUNCTION public.distribute_shareholder_profit_v1(uuid, numeric, uuid, date, text, text) RETURNS jsonb
    LANGUAGE sql SECURITY DEFINER AS $$ SELECT '{}'::jsonb $$;
  REVOKE ALL ON FUNCTION public.distribute_shareholder_profit_v1(uuid, numeric, uuid, date, text, text) FROM PUBLIC;
  GRANT EXECUTE ON FUNCTION public.distribute_shareholder_profit_v1(uuid, numeric, uuid, date, text, text) TO authenticated;
  CREATE FUNCTION public.create_profit_payout_compat_v1(text, uuid, numeric, uuid, date, text, text) RETURNS jsonb
    LANGUAGE sql SECURITY DEFINER AS $$ SELECT '{}'::jsonb $$;
  REVOKE ALL ON FUNCTION public.create_profit_payout_compat_v1(text, uuid, numeric, uuid, date, text, text) FROM PUBLIC;
  -- Hai khoá chặn sửa phiếu: bản giả cùng TÊN trigger, cùng chỗ chặn.
  CREATE TABLE public.test_thang_da_chot(building_id uuid, thang date);
  CREATE FUNCTION public.test_a02_khoa_thang() RETURNS trigger LANGUAGE plpgsql AS $$
  BEGIN
    IF EXISTS (SELECT 1 FROM public.test_thang_da_chot k WHERE k.building_id = OLD.building_id AND k.thang = date_trunc('month', OLD.voucher_date)::date) THEN
      RAISE EXCEPTION 'TEST_A02: tháng đã chốt lợi nhuận' USING ERRCODE = 'P0001';
    END IF;
    RETURN NEW;
  END $$;
  CREATE FUNCTION public.test_a00_niem_phong() RETURNS trigger LANGUAGE plpgsql AS $$
  BEGIN
    IF EXISTS (SELECT 1 FROM app_private.income_expense_flow_ownership o WHERE o.income_expense_id = OLD.id) THEN
      RAISE EXCEPTION 'TEST_A00: phiếu canonical niêm phong' USING ERRCODE = '55000';
    END IF;
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  END $$;
`;

const TRIGGER_VA_POLICY = `
  CREATE TRIGGER a02_ie_profit_lock_upd BEFORE UPDATE ON public.income_expenses FOR EACH ROW EXECUTE FUNCTION public.test_a02_khoa_thang();
  CREATE TRIGGER a00_ie_owned_payload_freeze BEFORE DELETE OR UPDATE ON public.income_expenses FOR EACH ROW EXECUTE FUNCTION public.test_a00_niem_phong();
  CREATE TRIGGER ie_business_result AFTER INSERT OR UPDATE OF business_result_accounting, total_amount ON public.income_expenses
    FOR EACH ROW EXECUTE FUNCTION public.trg_ie_recompute_business_result();
  REVOKE ALL ON FUNCTION app_private.profit_viewer_can_v1(uuid, text) FROM PUBLIC, anon;
  GRANT EXECUTE ON FUNCTION app_private.profit_viewer_can_v1(uuid, text) TO authenticated;
  GRANT EXECUTE ON FUNCTION public.current_shareholder_id() TO authenticated;
  ALTER TABLE public.profit_allocations ENABLE ROW LEVEL SECURITY;
  ALTER TABLE public.building_shareholders ENABLE ROW LEVEL SECURITY;
  ALTER TABLE public.profit_monthly ENABLE ROW LEVEL SECURITY;
  CREATE POLICY profit_alloc_self_select ON public.profit_allocations FOR SELECT TO authenticated USING ((shareholder_id = public.current_shareholder_id()));
  CREATE POLICY bldg_sh_self_select ON public.building_shareholders FOR SELECT TO authenticated USING ((shareholder_id = public.current_shareholder_id()));
  CREATE POLICY profit_monthly_self_select ON public.profit_monthly FOR SELECT TO authenticated USING ((EXISTS ( SELECT 1
     FROM public.profit_allocations pa
    WHERE ((pa.profit_monthly_id = profit_monthly.id) AND (pa.shareholder_id = public.current_shareholder_id())))));
  GRANT SELECT ON public.profit_allocations, public.building_shareholders, public.profit_monthly TO authenticated;
`;

function duLieu(): string {
  const thanhVien: [string, string, string | null][] = [
    [CHU, ORG, "2026-07-01"], [CHU2, ORG, null], [NV_J, ORG, "2026-07-02"], [NV_N, ORG, "2026-07-02"], [NV_B, ORG, "2026-07-02"],
    [NGOAI, ORG_B, "2026-07-01"]];
  const thang = [...new Set(PHAN_BO.map(([, b, t]) => `${b}|${t}`))];
  const khoaLuc = (b: string, t: string) => (b === TOA_2 ? "2026-11-05" : t === "2026-09-01" ? "2026-10-28" : `${t.slice(0, 8)}28`);
  const pm = (b: string, t: string) => id(1000 + thang.indexOf(`${b}|${t}`));
  return `
    INSERT INTO public.organizations(id) VALUES ('${ORG}'), ('${ORG_B}');
    INSERT INTO public.permission_definitions(key, resource, action, sensitivity) VALUES
      ('shareholder_profit.distribute','shareholder_profit','distribute','ELEVATED'),
      ('shareholder_profit.pay_manager','shareholder_profit','pay_manager','ELEVATED');
    INSERT INTO public.organization_memberships(id, user_id, organization_id, activated_at) VALUES
      ${thanhVien.map(([u, o, a]) => `('${mem(u)}','${u}','${o}', ${a ? `'${a}'` : "NULL"})`).join(",")};
    INSERT INTO public.authorization_scopes(id, organization_id, scope_type) VALUES ('${PV}','${ORG}','ORGANIZATION'), ('${PV_B}','${ORG_B}','ORGANIZATION');
    INSERT INTO public.organization_roles(id, organization_id, name, is_system, system_key) VALUES
      ('${VAI_CHU}','${ORG}','Chủ sở hữu tổ chức',true,'TENANT_OWNER'), ('${VAI_NV}','${ORG}','Nhân viên',false,NULL),
      ('${VAI_B}','${ORG_B}','Chủ sở hữu tổ chức',true,'TENANT_OWNER');
    INSERT INTO public.role_permissions(organization_id, role_id, permission_key) VALUES
      ('${ORG}','${VAI_CHU}','shareholder_profit.distribute'), ('${ORG}','${VAI_CHU}','shareholder_profit.pay_manager'),
      ('${ORG_B}','${VAI_B}','shareholder_profit.distribute');
    INSERT INTO public.role_bindings(id, organization_id, membership_id, role_id, valid_from) VALUES
      ('${id(101)}','${ORG}','${mem(CHU)}','${VAI_CHU}','2026-07-01'), ('${id(102)}','${ORG}','${mem(CHU2)}','${VAI_CHU}','2026-08-01'),
      ('${id(103)}','${ORG}','${mem(NV_B)}','${VAI_NV}','2026-07-02'), ('${id(104)}','${ORG_B}','${mem(NGOAI)}','${VAI_B}','2026-07-01');
    INSERT INTO public.role_binding_scopes VALUES ('${ORG}','${id(101)}','${PV}'), ('${ORG}','${id(102)}','${PV}'), ('${ORG}','${id(103)}','${PV}'),
      ('${ORG_B}','${id(104)}','${PV_B}');
    INSERT INTO public.buildings(id, organization_id, user_id, name, code, is_virtual) VALUES
      ('${TOA_AO}','${ORG}','${CHU}','Kho chung','KHO',true), ('${TOA_1}','${ORG}','${CHU}','Toà 1','T1',false), ('${TOA_2}','${ORG}','${CHU}','Toà 2','T2',false);
    INSERT INTO public.accounts(id, organization_id, name) VALUES ('${SO_1}','${ORG}','Sổ 1'), ('${SO_2}','${ORG}','Sổ 2'), ('${SO_3}','${ORG}','Sổ 3');
    INSERT INTO public.shareholders(id, organization_id, auth_user_id, name, deleted_at) VALUES
      ('${SH_J}','${ORG}','${NV_J}','Cổ đông J',NULL), ('${SH_N}','${ORG}','${NV_N}','Cổ đông N',NULL),
      ('${SH_B}','${ORG}','${NV_B}','Cổ đông B',NULL), ('${SH_X}','${ORG}',NULL,'Cổ đông đã xoá', '2026-06-03');
    INSERT INTO public.profit_managers(id, organization_id, auth_user_id, name, deleted_at) VALUES
      ('${QL_1}','${ORG}','${CHU}','Quản lý 1',NULL), ('${QL_2}','${ORG}',NULL,'Quản lý đã xoá','2026-07-20');
    INSERT INTO public.profit_monthly(id, organization_id, building_id, period_month, status, locked_at) VALUES
      ${thang.map((k) => { const [b, t] = k.split("|"); return `('${pm(b, t)}','${ORG}','${b}','${t}','LOCKED','${khoaLuc(b, t)}')`; }).join(",")};
    INSERT INTO public.profit_allocations(profit_monthly_id, shareholder_id, amount, organization_id) VALUES
      ${PHAN_BO.map(([s, b, t, a]) => `('${pm(b, t)}','${s}',${a},'${ORG}')`).join(",")};
    INSERT INTO public.profit_manager_allocations(profit_monthly_id, manager_id, amount, organization_id) VALUES
      ${PHAN_BO_QL.map(([q, a]) => `('${pm(TOA_1, "2026-05-01")}','${q}',${a},'${ORG}')`).join(",")};
    INSERT INTO public.building_shareholders(building_id, shareholder_id, percent, organization_id) VALUES
      ('${TOA_1}','${SH_B}',40,'${ORG}'), ('${TOA_1}','${SH_J}',10,'${ORG}');
    INSERT INTO public.income_expense_types(id, name, type, user_id, organization_id, category, is_restricted, rule_key) VALUES
      ('${LOAI_LUONG}','Lương quản lý','expense','${CHU}','${ORG}','Nhân sự – sale',false,NULL),
      ('${LOAI_CLN}','Chia lợi nhuận cổ đông','expense','${CHU}','${ORG}','Chia lợi nhuận',true,'chia_loi_nhuan'),
      ('${LOAI_KHAC}','Chi khác','expense','${CHU}','${ORG}','Khác',false,NULL);
    -- Phiếu lương: J tháng 5 (bảng chốt), N tháng 5 (bảng chốt), N tháng 9 (bảng nháp, đã duyệt), J tháng 9 (chờ duyệt).
    INSERT INTO public.income_expenses(id, user_id, code, type, name, building_id, voucher_date, total_amount, approval_status, posting_status,
        salary_staff_id, organization_id, account_id, created_at) VALUES
      ('${V_J5}','${CHU}','PC-J5','EXPENSE','Lương J T5','${TOA_AO}','2026-07-01',1000,'APPROVED','POSTED','${NV_J}','${ORG}','${SO_1}','2026-07-01 08:00+00'),
      ('${V_N5}','${CHU}','PC-N5','EXPENSE','Lương N T5','${TOA_AO}','2026-07-01',2000,'APPROVED','POSTED','${NV_N}','${ORG}','${SO_1}','2026-07-01 09:00+00'),
      ('${V_N9}','${CHU}','PC-N9','EXPENSE','Lương N T9','${TOA_AO}','2026-10-30',3000,'APPROVED','POSTED','${NV_N}','${ORG}','${SO_1}','2026-10-30 05:26+00'),
      ('${V_J9}','${CHU}','PC-J9','EXPENSE','Lương J T9','${TOA_AO}','2026-10-30',1500,'UNAPPROVED','UNPOSTED','${NV_J}','${ORG}','${SO_1}','2026-10-30 05:38+00');
    INSERT INTO public.approval_requests(organization_id, subject_type, subject_id, state) VALUES ('${ORG}','FINANCIAL_VOUCHER','${V_J9}','PENDING_APPROVAL');
    INSERT INTO public.salary_monthly(staff_id, period_month, status, investment_profit, advances_total, take_home, paid, payout_voucher_id, locked_at, organization_id) VALUES
      ('${NV_J}','2026-05-01','LOCKED',100,0,900,1000,'${V_J5}','2026-06-30','${ORG}'),
      ('${NV_N}','2026-05-01','LOCKED',200,0,1900,2000,'${V_N5}','2026-06-30','${ORG}'),
      ('${NV_N}','2026-09-01','DRAFT',0,0,0,3000,'${V_N9}',NULL,'${ORG}'),
      ('${NV_J}','2026-09-01','DRAFT',0,0,0,0,'${V_J9}',NULL,'${ORG}');
    INSERT INTO app_private.canonical_write_operations(organization_id, operation, subject_scope, actor_id, idempotency_key, payload_hash,
        subject_id, response_payload, completed_at) VALUES
      ('${ORG}','salary.payout.v1','${NV_N}|2026-09-01','${CHU}','khoa-luong-n9-0001','${"a".repeat(32)}','${V_N9}','{}','2026-10-30 05:26+00'),
      ('${ORG}','salary.payout.v1','${NV_J}|2026-09-01','${CHU}','khoa-luong-j9-0001','${"b".repeat(32)}','${V_J9}','{}','2026-10-30 05:38+00');
    -- Bốn phiếu chia lợi nhuận cũ ở toà ảo.
    INSERT INTO public.income_expenses(id, user_id, code, type, name, building_id, voucher_date, total_amount, approval_status, posting_status,
        organization_id, account_id, active_posting_id_v2, kqkd_amount, counts_in_business_result, has_restricted_item) VALUES
      ${X3.map((x) => `('${x}','${CHU}','${MA_X3[x]}','EXPENSE','Chia lợi nhuận cũ','${TOA_AO}','${NGAY_X3[x]}',${TIEN_X3[x]},'APPROVED','POSTED',
        '${ORG}','${SO_X3[x]}','${BUT_TOAN[x]}',${TIEN_X3[x]},true,${x === X3_B})`).join(",")};
    INSERT INTO public.income_expense_items(income_expense_id, income_expense_type_id, quantity, unit_price, amount, organization_id) VALUES
      ${X3.map((x) => `('${x}','${x === X3_A ? LOAI_KHAC : LOAI_CLN}',1,${TIEN_X3[x]},${TIEN_X3[x]},'${ORG}')`).join(",")};
    INSERT INTO public.income_expense_postings(id, organization_id, voucher_id) VALUES ${X3.map((x) => `('${BUT_TOAN[x]}','${ORG}','${x}')`).join(",")};
    INSERT INTO public.income_expense_posting_lines(organization_id, posting_id, account_id, signed_amount) VALUES
      ${X3.map((x) => `('${ORG}','${BUT_TOAN[x]}','${SO_X3[x]}',${-TIEN_X3[x]})`).join(",")};
    INSERT INTO app_private.income_expense_flow_ownership(income_expense_id, organization_id) VALUES ('${X3_A}','${ORG}'), ('${X3_B}','${ORG}');
    INSERT INTO public.test_thang_da_chot VALUES ('${TOA_AO}','2026-05-01');
  `;
}

async function dungCoSo(d: PGlite, coDuLieu = true) {
  await d.exec(NEN);
  for (const f of HAM_NEN) await d.exec(f);
  await d.exec(M1);
  for (const f of HAM_DOT1) await d.exec(f);
  if (coDuLieu) await d.exec(duLieu());
  await d.exec(TRIGGER_VA_POLICY);
}

const db = new PGlite();
type Loi = { code: string; message: string; detail: string | null };
const mot = async <T>(sql: string) => (await db.query<{ v: T }>(sql)).rows[0].v;
const dem = (bang: string, dk = "true") => mot<number>(`SELECT count(*)::int AS v FROM ${bang} WHERE ${dk}`);
async function trongGiaoDich<T>(fn: () => Promise<T>, d: PGlite = db): Promise<T> {
  await d.exec("BEGIN");
  try { return await fn(); } finally { await d.exec("ROLLBACK"); }
}
/** Chạy câu dưới vai chủ bảng trong SAVEPOINT; trả lỗi (null nếu chạy được). */
async function loi(sql: string, d: PGlite = db): Promise<Loi | null> {
  await d.exec("SAVEPOINT thu");
  try { await d.exec(sql); await d.exec("RELEASE SAVEPOINT thu"); return null; } catch (e) {
    await d.exec("ROLLBACK TO SAVEPOINT thu");
    const x = e as { code?: string; message?: string; detail?: string };
    return { code: x.code ?? "?", message: x.message ?? "", detail: x.detail ?? null };
  }
}
async function la<T>(user: string, sql: string): Promise<T> {
  await db.query("SELECT set_config('request.jwt.claim.sub', $1, true)", [user]);
  await db.exec("SET LOCAL ROLE authenticated");
  try { return (await db.query<{ v: T }>(sql)).rows[0].v; } finally { await db.exec("RESET ROLE"); }
}
const soDu = (loai: string, chuThe: string) =>
  mot<{ balance: string; allocated: string; marker: { settled_through_month: string | null } | null }>(
    `SELECT app_private.profit_ledger_balance_v1('${ORG}','${loai}','${chuThe}') AS v`);
const soDuSo = async (loai: string, chuThe: string) => Number((await soDu(loai, chuThe)).balance);
const route = () => mot<string>(`SELECT app_private.evaluate_feature_route('shareholder_profit.ledger_payout.v1','${ORG}') AS v`);
const demTatCa = async () => ({
  c1: await dem("app_private.profit_ledger_markers"), c3: await dem("app_private.profit_ledger_salary_settlements"),
  c4: await dem("app_private.profit_ledger_salary_settlement_vouchers"), c5: await dem("app_private.profit_ledger_events"),
  audit: await dem("public.income_expense_audit_log"), ev: await dem("app_private.server_feature_flag_events"),
  ops: await dem("app_private.canonical_write_operations"),
});
const anhX3 = () => mot<Record<string, Record<string, unknown>>>(
  `SELECT jsonb_object_agg(id::text, to_jsonb(ie)) AS v FROM public.income_expenses ie WHERE id IN (${X3.map((x) => `'${x}'`).join(",")})`);
const boCot = (o: Record<string, unknown>, cot: string[]) => Object.fromEntries(Object.entries(o).filter(([k]) => !cot.includes(k)));

beforeAll(async () => {
  await dungCoSo(db);
}, 180000);
afterAll(() => db.close());

describe("[ghim] văn bản hai migration", () => {
  const TIEN = /\b\d{1,3}(?:\.\d{3})+\b|(?<![0-9a-f-])\d{7,}(?![0-9a-f-])/;
  const TEN = /JOEY|NATHAN|B\.?\s?Huy|Hiệp|Green|NG T[AÂ]M|Nguyễn Tâm/i;
  const UUID_DUOC = new Set([ORG, "dddd0000-0000-4000-8000-000000000001", V_N9, V_J5, V_N5, V_J9, ...X3]);
  for (const [ten, sql] of [["D3a", D3A_GOC], ["D3b", D3B_GOC]] as const) {
    it(`[ghim] ${ten}: không số tiền, không tên người, chỉ UUID phiếu ghim / công ty`, () => {
      const khongChuThich = sql.replace(/--[^\n]*/g, "");
      // Bỏ md5/sha (32–64 hex) và tên migration (14 chữ số) trước khi dò số tiền.
      expect(sql.replace(/[0-9a-f]{32,64}/g, "").replace(/(?<!\d)20\d{12}(?!\d)/g, "").match(TIEN)).toBeNull();
      expect(sql.match(TEN)).toBeNull();
      const uuids = [...khongChuThich.matchAll(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g)].map((m) => m[0]);
      expect(uuids.filter((u) => !UUID_DUOC.has(u))).toEqual([]);
    });
    it(`[ghim] ${ten}: đúng một BEGIN / COMMIT, không session_replication_role`, () => {
      expect(sql.match(/^BEGIN;$/gm)).toHaveLength(1);
      expect(sql.match(/^COMMIT;$/gm)).toHaveLength(1);
      expect(sql.replace(/--[^\n]*/g, "")).not.toMatch(/session_replication_role/i);
    });
  }
  it("[ghim] D3a: mỗi DISABLE TRIGGER có ENABLE TRIGGER cùng tên đứng sau nó", () => {
    const tat = [...D3A_GOC.matchAll(/DISABLE TRIGGER (\w+)/g)];
    expect(tat.map((m) => m[1]).sort()).toEqual(["a00_ie_owned_payload_freeze", "a02_ie_profit_lock_upd"]);
    for (const m of tat) {
      const bat = D3A_GOC.indexOf(`ENABLE TRIGGER ${m[1]}`, m.index);
      expect(bat).toBeGreaterThan(m.index!);
    }
  });
  it("[ghim] D3b: S2 nằm ở đúng một lệnh set_config — còn giữ chỗ hoặc đã điền 40 hex; danh tính phát hành đúng định dạng", () => {
    const s2 = DONG_S2.exec(D3B_GOC)?.[1];
    expect(s2 === "<<SHA_PRODUCTION_WEB>>" || /^[0-9a-f]{40}$/.test(s2 ?? "")).toBe(true);
    expect(D3B_GOC.split("<<SHA_PRODUCTION_WEB>>").length).toBeLessThanOrEqual(2);
    expect(D3B_GOC.match(/set_config\('ihomecrm\.d3b_commit_sha'/g)).toHaveLength(1);
    expect(D3B_GOC).toContain("!~ '^[0-9a-f]{40}$'");
    expect(D3B_GOC).toContain("c_duyet   constant text := 'chủ uỷ quyền 15/11/2026'");
    expect(D3B_GOC).not.toMatch(/'CANARY'/);
  });
  it("[ghim] D3b: migration_sha256 = sha256 nội dung file M2-tạo (LF), trùng provenance", () => {
    const sha = createHash("sha256").update(readFileSync(FILE_M2_TAO, "utf8").replace(/\r\n/g, "\n"), "utf8").digest("hex");
    expect(D3B_GOC).toContain(`c_m2_sha256 constant text := '${sha}'`);
    const prov = JSON.parse(readFileSync("supabase/migration-provenance.json", "utf8")) as { entries?: { path: string; sha256: string }[]; migrations?: { path: string; sha256: string }[] };
    const dong = (prov.entries ?? prov.migrations ?? []).find((e) => e.path === FILE_M2_TAO);
    expect(dong?.sha256).toBe(sha);
  });
  it("[ghim] md5 thân hàm Đợt 1 mà D3 ghim = md5 định nghĩa trong repo", () => {
    const ghimMd5 = (ten: string) => md5(thanHam(dinhNghiaTruocD3(ten)));
    expect(D3A_GOC).toContain(ghimMd5("app_private.profit_ledger_luong_backfill_v1"));
    expect(D3A_GOC).toContain(ghimMd5("app_private.profit_ledger_tao_set_marker_v1"));
    expect(D3B_GOC).toContain(ghimMd5("app_private.guard_profit_ledger_payout_v1"));
    expect(D3B_GOC).toContain(ghimMd5("public.shareholder_profit_ledger_payout_v1"));
    expect(D3B_GOC).toContain(ghimMd5("app_private.profit_ledger_tao_set_marker_v1"));
  });
});

describe("D3a — chuyển đổi (dán hai lượt trong một giao dịch như lane)", () => {
  let kq: Record<string, unknown>;
  beforeAll(async () => {
    kq = await trongGiaoDich(async () => {
      const truoc = { sd: { J: await soDuSo("SHAREHOLDER", SH_J), N: await soDuSo("SHAREHOLDER", SH_N), B: await soDuSo("SHAREHOLDER", SH_B),
        X: await soDuSo("SHAREHOLDER", SH_X), Q1: await soDuSo("MANAGER", QL_1), Q2: await soDuSo("MANAGER", QL_2) }, x3: await anhX3() };
      const loi1 = await loi(D3A());
      const dem1 = await demTatCa();
      const loi2 = await loi(D3A());
      const dem2 = await demTatCa();
      const sau = {
        route: await route(),
        sd: { J: await soDuSo("SHAREHOLDER", SH_J), N: await soDuSo("SHAREHOLDER", SH_N), B: await soDuSo("SHAREHOLDER", SH_B),
          X: await soDuSo("SHAREHOLDER", SH_X), Q1: await soDuSo("MANAGER", QL_1), Q2: await soDuSo("MANAGER", QL_2) },
        tho: { J: Number(await mot<string>(`SELECT app_private.profit_ledger_balance_core_v1('${ORG}','SHAREHOLDER','${SH_J}',NULL,NULL,NULL) ->> 'balance' AS v`)),
          N: Number(await mot<string>(`SELECT app_private.profit_ledger_balance_core_v1('${ORG}','SHAREHOLDER','${SH_N}',NULL,NULL,NULL) ->> 'balance' AS v`)) },
        c4: await mot<unknown[]>(`SELECT COALESCE(jsonb_agg(jsonb_build_object('v', salary_voucher_id, 'y', investment_amount::float, 'd', advance_offset_amount::float,
          'ky', period_month, 'state', state, 'src', source, 'sheet', sheet_status_at_quote, 'c3', settlement_id IS NOT NULL, 'by', created_by) ORDER BY salary_voucher_id), '[]') AS v
          FROM app_private.profit_ledger_salary_settlement_vouchers`),
        c3: await mot<unknown[]>(`SELECT COALESCE(jsonb_agg(jsonb_build_object('sh', shareholder_id, 'ky', period_month, 'y', investment_month::float, 'state', state) ORDER BY shareholder_id), '[]') AS v
          FROM app_private.profit_ledger_salary_settlements`),
        x3: await anhX3(),
        trg: await mot<string>(`SELECT string_agg(tgname || ':' || tgenabled::text, ',' ORDER BY tgname) AS v FROM pg_trigger WHERE tgrelid = 'public.income_expenses'::regclass
          AND tgname IN ('a02_ie_profit_lock_upd','a00_ie_owned_payload_freeze')`),
        auditX3: await dem("public.income_expense_audit_log", `action = 'KQKD_OVERRIDE' AND actor_id = '${CHU}'`),
        distAuth: await mot<boolean>(`SELECT has_function_privilege('authenticated','public.distribute_shareholder_profit_v1(uuid,numeric,uuid,date,text,text)','EXECUTE') AS v`),
        distAnon: await mot<boolean>(`SELECT has_function_privilege('anon','public.distribute_shareholder_profit_v1(uuid,numeric,uuid,date,text,text)','EXECUTE') AS v`),
        moc: await mot<unknown[]>(`SELECT jsonb_agg(jsonb_build_object('chu_the', COALESCE(shareholder_id, manager_id), 'thang', settled_through_month, 'by', created_by,
          'ly_do', reason, 'erased', advance_erased::float) ORDER BY ledger_seq) AS v FROM app_private.profit_ledger_markers`),
        ev: await mot<unknown[]>(`SELECT jsonb_agg(jsonb_build_object('t', event_type, 'b', before_mode, 'a', after_mode, 'actor', actor) ORDER BY id) AS v
          FROM app_private.server_feature_flag_events`),
      };
      return { truoc, loi1, loi2, dem1, dem2, sau };
    });
  }, 60000);
  const k = () => kq as { truoc: { sd: Record<string, number>; x3: Record<string, Record<string, unknown>> }; loi1: Loi | null; loi2: Loi | null;
    dem1: Record<string, number>; dem2: Record<string, number>; sau: Record<string, unknown> & { sd: Record<string, number>; tho: Record<string, number>;
      x3: Record<string, Record<string, unknown>> } };

  it("hai lượt đều chạy hết, lượt hai không ghi thêm gì", () => {
    expect(k().loi1).toBeNull();
    expect(k().loi2).toBeNull();
    expect(k().dem2).toEqual(k().dem1);
  });
  it("X1: công tắc SHADOW, đúng một sự kiện OFF→SHADOW, người ghi = chủ kích hoạt sớm nhất", () => {
    expect(k().sau.route).toBe("SHADOW");
    expect(k().sau.ev).toEqual([{ t: "ROUTE_CHANGED", b: "OFF", a: "SHADOW", actor: CHU }]);
  });
  it("X2: ghi bù đúng ba phiếu lương đã duyệt, số lấy từ phiếu (bảng chốt / toà chốt trước giờ lập phiếu)", () => {
    expect(k().sau.c4).toEqual([
      { v: V_N9, y: 70, d: 0, ky: "2026-09-01", state: "LINKED", src: "BACKFILL", sheet: "DRAFT", c3: false, by: CHU },
      { v: V_J5, y: 100, d: 0, ky: "2026-05-01", state: "LINKED", src: "BACKFILL", sheet: "LOCKED", c3: true, by: CHU },
      { v: V_N5, y: 200, d: 0, ky: "2026-05-01", state: "LINKED", src: "BACKFILL", sheet: "LOCKED", c3: true, by: CHU },
    ]);
    expect(k().sau.c3).toEqual([
      { sh: SH_J, ky: "2026-05-01", y: 100, state: "FROZEN" }, { sh: SH_N, ky: "2026-05-01", y: 200, state: "FROZEN" }]);
    // Sau ghi bù, trước mốc: phần đầu tư đã trả qua lương trừ khỏi số dư (J chỉ tháng 5: phiếu tháng 9 còn chờ duyệt).
    expect(k().sau.tho).toEqual({ J: 220 - 100, N: 405 - 200 - 70 });
  });
  it("X3: bốn phiếu ra khỏi KQKD, chỉ đổi cột cho phép, has_restricted_item theo hạng mục, hai khoá bật lại, bốn dòng nhật ký", () => {
    const cot = ["business_result_accounting", "kqkd_amount", "counts_in_business_result", "updated_at", "has_restricted_item"];
    for (const x of X3) {
      const t = k().truoc.x3[x], s = k().sau.x3[x];
      expect(boCot(s, cot)).toEqual(boCot(t, cot));
      expect([s.business_result_accounting, Number(s.kqkd_amount), s.counts_in_business_result]).toEqual([false, 0, false]);
      expect(s.has_restricted_item).toBe(x !== X3_A);
    }
    expect(k().truoc.x3[X3_C].has_restricted_item).toBe(false);
    expect(k().sau.trg).toBe("a00_ie_owned_payload_freeze:O,a02_ie_profit_lock_upd:O");
    expect(k().sau.auditX3).toBe(4);
  });
  it("X4: lệnh chi lợi nhuận cũ không còn gọi được từ web", () => {
    expect([k().sau.distAuth, k().sau.distAnon]).toEqual([false, false]);
  });
  it("mốc: hai cổ đông qua 09/2026, hai người nhận lương điều hành qua 05/2026; số dư về 0; người không mốc không đổi", () => {
    const moc = k().sau.moc as { chu_the: string; thang: string; by: string; ly_do: string; erased: number }[];
    expect(moc.map((m) => [m.chu_the, m.thang, m.by, m.erased]).sort()).toEqual([
      [SH_J, "2026-09-01", CHU, 0], [SH_N, "2026-09-01", CHU, 0], [QL_1, "2026-05-01", CHU, 0], [QL_2, "2026-05-01", CHU, 0]].sort());
    expect(moc.find((m) => m.chu_the === SH_N)!.ly_do).toContain("162NVK");
    expect(moc.find((m) => m.chu_the === SH_J)!.ly_do).not.toContain("162NVK");
    expect(moc.every((m) => m.ly_do.includes("20261115113530") && m.ly_do.includes("14/11/2026"))).toBe(true);
    expect(k().truoc.sd).toEqual({ J: 220, N: 405, B: 980, X: 0, Q1: 300, Q2: 500 });
    expect(k().sau.sd).toEqual({ J: 0, N: 0, B: 980, X: 0, Q1: 0, Q2: 0 });
  });
});

describe("D3a — người ghi và điều kiện vào", () => {
  it("người ghi: binding vai chủ của người sớm nhất hết hạn ⇒ chủ kế tiếp; chủ chưa kích hoạt không được chọn", async () => {
    const r = await trongGiaoDich(async () => {
      await db.exec(`UPDATE public.role_bindings SET valid_to = now() - interval '1 day' WHERE id = '${id(101)}';`);
      const chuaKichHoat = await loi(D3A());
      await db.exec(`UPDATE public.organization_memberships SET activated_at = '2026-08-01' WHERE id = '${mem(CHU2)}';`);
      const e = await loi(D3A());
      return { chuaKichHoat, e, actor: await mot<string>(`SELECT actor::text AS v FROM app_private.server_feature_flag_events ORDER BY id DESC LIMIT 1`) };
    });
    expect(r.chuaKichHoat?.message).toMatch(/^D3A_ACTOR/);
    expect(r.e).toBeNull();
    expect(r.actor).toBe(CHU2);
  });
  it("người ghi không có quyền lương điều hành ⇒ 55000 D3A_ACTOR, không ghi gì", async () => {
    const r = await trongGiaoDich(async () => {
      await db.exec(`DELETE FROM public.role_permissions WHERE role_id = '${VAI_CHU}' AND permission_key = 'shareholder_profit.pay_manager'`);
      return { e: await loi(D3A()), route: await route() };
    });
    expect(r.e?.code).toBe("55000");
    expect(r.e?.message).toMatch(/^D3A_ACTOR/);
    expect(r.route).toBe("LEGACY");
  });
  it("công tắc đã ON / đang đóng băng ⇒ 55000 D3A_X1 (dừng ở tiền kiểm, trước khi gọi set_feature_route_v1)", async () => {
    for (const [set, ma] of [
      ["mode = 'ON', commit_sha = repeat('a', 40), migration_sha256 = repeat('b', 64), maintenance_window_id = 'mw', approval_reference = 'r'",
        /^D3A_X1: công tắc đang ON/],
      ["force_freeze = true", /^D3A_X1: công tắc đang đóng băng/]] as const) {
      const e = await trongGiaoDich(async () => {
        await db.exec(`UPDATE app_private.server_feature_flags SET ${set} WHERE feature_key = 'shareholder_profit.ledger_payout.v1'`);
        return loi(D3A());
      });
      expect(e?.code).toBe("55000");
      expect(e?.message).toMatch(ma);
    }
  });
  it("hai chủ cùng hợp lệ ⇒ người kích hoạt SỚM NHẤT ghi", async () => {
    const actor = await trongGiaoDich(async () => {
      await db.exec(`UPDATE public.organization_memberships SET activated_at = '2026-08-01' WHERE id = '${mem(CHU2)}';`);
      expect(await loi(D3A())).toBeNull();
      return mot<string>(`SELECT actor::text AS v FROM app_private.server_feature_flag_events ORDER BY id DESC LIMIT 1`);
    });
    expect(actor).toBe(CHU);
  });
  it("đường chi cũ đã để lại phiếu mang cổ đông ⇒ 55000 D3A_X4", async () => {
    const e = await trongGiaoDich(async () => {
      await db.exec(`INSERT INTO public.income_expenses(user_id, type, name, building_id, voucher_date, total_amount, approval_status, organization_id,
          account_id, shareholder_id, system_source) VALUES ('${CHU}','EXPENSE','Chi LN cũ','${TOA_AO}','2026-11-10',10,'CANCELLED','${ORG}','${SO_1}','${SH_B}','profit.distribution')`);
      return loi(D3A());
    });
    expect(e?.code).toBe("55000");
    expect(e?.message).toMatch(/^D3A_X4/);
  });
  it("thiếu công tắc (Đợt 1 chưa áp) ⇒ 55000 D3A_NEN", async () => {
    const e = await trongGiaoDich(async () => {
      await db.exec(`DELETE FROM app_private.server_feature_flags WHERE feature_key = 'shareholder_profit.ledger_payout.v1'`);
      return loi(D3A());
    });
    expect(e?.message).toMatch(/^D3A_NEN/);
  });
  it("hàm ghi bù lương của Đợt 1 khác bản đã rà ⇒ 55000 D3A_NEN", async () => {
    const e = await trongGiaoDich(async () => {
      await db.exec(dinhNghiaTruocD3("app_private.profit_ledger_luong_backfill_v1").replace("v_y          numeric := round(p_investment, 2);", "v_y          numeric := round(p_investment, 0);"));
      return loi(D3A());
    });
    expect(e?.message).toMatch(/^D3A_NEN/);
  });
  it("đã có phiếu chi theo sổ tổng còn sống trước chuyển đổi ⇒ 55000 D3A_X1", async () => {
    const e = await trongGiaoDich(async () => {
      const p = id(401);
      await db.exec(`
        INSERT INTO public.income_expenses(id, user_id, type, name, building_id, voucher_date, total_amount, approval_status, organization_id,
          account_id, shareholder_id, system_source) VALUES ('${p}','${CHU}','EXPENSE','Chi LN','${TOA_AO}','2026-11-10',10,'UNAPPROVED','${ORG}','${SO_1}','${SH_B}','profit.ledger_payout');
        INSERT INTO app_private.profit_ledger_write_contexts(income_expense_id, purpose) VALUES ('${p}', 'CREATE');
        SELECT app_private.profit_ledger_lock_v1('${ORG}', 'SHAREHOLDER', '${SH_B}');
        INSERT INTO app_private.profit_ledger_payouts(voucher_id, organization_id, subject_kind, shareholder_id, account_id, amount, balance_before,
          within_amount, advance_amount, maker_user_id, maker_membership_id, maker_kind, payee_is_maker, payee_user_id, ledger_seq)
        VALUES ('${p}','${ORG}','SHAREHOLDER','${SH_B}','${SO_1}',10,980,10,0,'${CHU}','${mem(CHU)}','OWNER',false,NULL,nextval('app_private.profit_ledger_seq'));
        DELETE FROM app_private.profit_ledger_write_contexts WHERE income_expense_id = '${p}';`);
      return loi(D3A({ dauVao: vanTayDauVaoPhieuCho() }));
    });
    expect(e?.code).toBe("55000");
    expect(e?.message).toMatch(/^D3A_X1/);
  });
});
/** Đầu vào số dư khi cổ đông B có một phiếu chi 10 đang chờ (ca "phiếu sổ tổng còn sống"). */
function vanTayDauVaoPhieuCho(): string {
  const alloc = new Map<string, number>();
  for (const [s, , , t] of PHAN_BO) alloc.set(s, (alloc.get(s) ?? 0) + t);
  const dong = [
    ...[QL_1, QL_2].map((q) => ({ k: "MANAGER", id: q, a: PHAN_BO_QL.find(([x]) => x === q)![1], pp: 0 })),
    ...[SH_J, SH_N, SH_B, SH_X].map((s) => ({ k: "SHAREHOLDER", id: s, a: alloc.get(s) ?? 0, pp: s === SH_B ? 10 : 0 })),
  ].sort((x, y) => (x.k === y.k ? (x.id < y.id ? -1 : 1) : x.k < y.k ? -1 : 1));
  return md5(dong.map((d) => `${d.k}|${d.id}|${d.a.toFixed(2)}|0.00|${d.pp.toFixed(2)}`).join(","));
}

describe("D3a — dấu vân tay: dữ liệu khác lúc đo ⇒ dừng 55000, không ghi gì", () => {
  const caLech: [string, string, RegExp][] = [
    ["tổng phiếu lương đã đổi", `UPDATE public.income_expenses SET total_amount = 1001 WHERE id = '${V_J5}'`, /^D3A_VAN_TAY_X2/],
    ["bảng lương tháng 5 chốt số đầu tư khác", `UPDATE public.salary_monthly SET investment_profit = 99 WHERE payout_voucher_id = '${V_J5}'`, /^D3A_VAN_TAY_X2/],
    ["phiếu lương chờ duyệt đã được duyệt", `UPDATE public.income_expenses SET approval_status = 'APPROVED' WHERE id = '${V_J9}'`, /^D3A_VAN_TAY_X2/],
    ["thêm một phiếu lương chờ duyệt", `INSERT INTO public.income_expenses(user_id, type, name, building_id, voucher_date, total_amount, approval_status,
       salary_staff_id, organization_id) VALUES ('${CHU}','EXPENSE','Lương N T10','${TOA_AO}','2026-11-05',500,'UNAPPROVED','${NV_N}','${ORG}')`, /^D3A_VAN_TAY_X2/],
    ["thêm một phiếu lương đã duyệt (không suy được kỳ)", `INSERT INTO public.income_expenses(user_id, type, name, building_id, voucher_date, total_amount, approval_status,
       salary_staff_id, organization_id) VALUES ('${CHU}','EXPENSE','Lương N T10','${TOA_AO}','2026-11-05',500,'APPROVED','${NV_N}','${ORG}')`, /^D3A_X2: không suy được kỳ/],
    ["thêm một phiếu lương đã duyệt (có lệnh trả lương kỳ 10)", `INSERT INTO public.income_expenses(id, user_id, type, name, building_id, voucher_date, total_amount, approval_status,
       salary_staff_id, organization_id) VALUES ('${id(410)}','${CHU}','EXPENSE','Lương N T10','${TOA_AO}','2026-11-05',500,'APPROVED','${NV_N}','${ORG}');
       INSERT INTO app_private.canonical_write_operations(organization_id, operation, subject_scope, actor_id, idempotency_key, payload_hash,
         subject_id, response_payload, completed_at) VALUES ('${ORG}','salary.payout.v1','${NV_N}|2026-10-01','${CHU}','khoa-luong-n10-0001',
         '${"c".repeat(32)}','${id(410)}','{}',now())`, /^D3A_VAN_TAY_X2/],
    ["hai nguồn kỳ của một phiếu lệch nhau", `UPDATE app_private.canonical_write_operations SET subject_scope = '${NV_N}|2026-08-01'
       WHERE subject_id = '${V_N9}'`, /^D3A_X2: không suy được kỳ/],
    ["một toà vừa chốt thêm phân bổ", `INSERT INTO public.profit_monthly(id, organization_id, building_id, period_month, status, locked_at)
       VALUES ('${id(1500)}','${ORG}','${TOA_2}','2026-10-01','LOCKED',now());
       INSERT INTO public.profit_allocations(profit_monthly_id, shareholder_id, amount, organization_id) VALUES ('${id(1500)}','${SH_B}',5,'${ORG}')`, /^D3A_VAN_TAY_SO_DU/],
    ["một phiếu cũ đổi tổng tiền", `UPDATE public.income_expenses SET total_amount = 651, kqkd_amount = 651 WHERE id = '${X3_A}'`, /^D3A_VAN_TAY_X3/],
  ];
  for (const [ten, sua, ma] of caLech) {
    it(ten, async () => {
      const r = await trongGiaoDich(async () => {
        await db.exec(`ALTER TABLE public.income_expenses DISABLE TRIGGER a02_ie_profit_lock_upd;
          ALTER TABLE public.income_expenses DISABLE TRIGGER a00_ie_owned_payload_freeze; ${sua};
          ALTER TABLE public.income_expenses ENABLE TRIGGER a02_ie_profit_lock_upd;
          ALTER TABLE public.income_expenses ENABLE TRIGGER a00_ie_owned_payload_freeze;`);
        return { e: await loi(D3A()), c4: await dem("app_private.profit_ledger_salary_settlement_vouchers"), route: await route(),
          x3: await dem("public.income_expenses", "business_result_accounting IS FALSE") };
      });
      expect(r.e?.code).toBe("55000");
      expect(r.e?.message).toMatch(ma);
      expect([r.c4, r.route, r.x3]).toEqual([0, "LEGACY", 0]);
    });
  }
});

/** md5 dấu vân tay X2 cho các dòng [phiếu, cổ đông, kỳ, tổng phiếu, phần đầu tư] (sắp theo phiếu). */
const vanTayX2 = (dong: [string, string, string, number, number][]) =>
  md5([...dong].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([v, s, k2, t, y]) => `${v}|${s}|${k2}|${t.toFixed(2)}|${y.toFixed(2)}`).join(","));
const DONG_X2: [string, string, string, number, number][] = [
  [V_N9, SH_N, "2026-09-01", 3000, 70], [V_J5, SH_J, "2026-05-01", 1000, 100], [V_N5, SH_N, "2026-05-01", 2000, 200]];
/** D3a với tập phiếu ghi bù khác (ghim lại danh sách phiếu + dấu vân tay). */
function d3aVoiPhieu(dong: [string, string, string, number, number][], dauVao?: string) {
  const ids = [...dong.map((d) => d[0])].sort();
  return D3A({ x2: vanTayX2(dong), dauVao }).replace(
    /c_phieu {6}constant uuid\[\] := ARRAY\['05ac6ab0[^;]*;/,
    `c_phieu      constant uuid[] := ARRAY[${ids.map((x) => `'${x}'`).join(", ")}]::uuid[];`);
}
const yCua = (v: string) => mot<number>(`SELECT investment_amount::float AS v FROM app_private.profit_ledger_salary_settlement_vouchers WHERE salary_voucher_id = '${v}'`);

describe("D3a — X2 số ghi bù", () => {
  it("phiếu lương nhỏ hơn phần đầu tư ⇒ ghi đúng bằng tiền phiếu (tiền thực nhận = tổng phiếu)", async () => {
    const r = await trongGiaoDich(async () => {
      await db.exec(`UPDATE public.income_expenses SET total_amount = 150 WHERE id = '${V_N5}'`);
      const dong = DONG_X2.map((d): [string, string, string, number, number] => (d[0] === V_N5 ? [V_N5, SH_N, "2026-05-01", 150, 150] : d));
      return { e: await loi(d3aVoiPhieu(dong)), y: await yCua(V_N5) };
    });
    expect(r.e).toBeNull();
    expect(r.y).toBe(150);
  });
  it("hai phiếu lương cùng tháng ⇒ phiếu sau chỉ ghi phần còn lại sau phiếu trước", async () => {
    const V2 = id(420);
    const r = await trongGiaoDich(async () => {
      await db.exec(`INSERT INTO public.income_expenses(id, user_id, type, name, building_id, voucher_date, total_amount, approval_status, posting_status,
          salary_staff_id, organization_id, account_id, created_at) VALUES ('${V2}','${CHU}','EXPENSE','Lương N T5 bù','${TOA_AO}','2026-07-05',50,'APPROVED','POSTED',
          '${NV_N}','${ORG}','${SO_1}','2026-07-05 08:00+00');
        INSERT INTO app_private.canonical_write_operations(organization_id, operation, subject_scope, actor_id, idempotency_key, payload_hash,
          subject_id, response_payload, completed_at) VALUES ('${ORG}','salary.payout.v1','${NV_N}|2026-05-01','${CHU}','khoa-luong-n5-bu-01',
          '${"d".repeat(32)}','${V2}','{}','2026-07-05 08:00+00');`);
      const e = await loi(d3aVoiPhieu([...DONG_X2, [V2, SH_N, "2026-05-01", 50, 0]]));
      return { e, y1: await yCua(V_N5), y2: await yCua(V2) };
    });
    expect(r.e).toBeNull();
    expect([r.y1, r.y2]).toEqual([200, 0]);
  });
  it("ghi bù làm đổi bảng lương (trigger lạ trên dòng sổ) ⇒ 55000 D3A_X2", async () => {
    const e = await trongGiaoDich(async () => {
      await db.exec(`CREATE FUNCTION public.test_cham_bang_luong() RETURNS trigger LANGUAGE plpgsql AS $$
          BEGIN UPDATE public.salary_monthly SET paid = paid + 1 WHERE payout_voucher_id = NEW.salary_voucher_id; RETURN NEW; END $$;
        CREATE TRIGGER zz_test_cham_bang_luong AFTER INSERT ON app_private.profit_ledger_salary_settlement_vouchers
          FOR EACH ROW EXECUTE FUNCTION public.test_cham_bang_luong();`);
      return loi(D3A());
    });
    expect(e?.code).toBe("55000");
    expect(e?.message).toMatch(/^D3A_X2: ghi bù đã làm đổi/);
  });
  it("cổ đông KHÔNG có mốc bị đổi số dư (có phiếu lương được ghi bù) ⇒ 55000 D3A_SAU", async () => {
    const VB = id(430);
    const e = await trongGiaoDich(async () => {
      await db.exec(`INSERT INTO public.income_expenses(id, user_id, type, name, building_id, voucher_date, total_amount, approval_status, posting_status,
          salary_staff_id, organization_id, account_id, created_at) VALUES ('${VB}','${CHU}','EXPENSE','Lương B T5','${TOA_AO}','2026-07-01',500,'APPROVED','POSTED',
          '${NV_B}','${ORG}','${SO_1}','2026-07-01 10:00+00');
        INSERT INTO public.salary_monthly(staff_id, period_month, status, investment_profit, take_home, paid, payout_voucher_id, locked_at, organization_id)
          VALUES ('${NV_B}','2026-05-01','LOCKED',40,460,500,'${VB}','2026-06-30','${ORG}');`);
      return loi(d3aVoiPhieu([...DONG_X2, [VB, SH_B, "2026-05-01", 500, 40]]));
    });
    expect(e?.code).toBe("55000");
    expect(e?.message).toMatch(/^D3A_SAU/);
  });
});

describe("D3a — X3 hậu kiểm và trạng thái dở dang", () => {
  it("bút toán sổ quỹ đổi trong lúc sửa phiếu (trigger lạ) ⇒ 55000 D3A_X3", async () => {
    const e = await trongGiaoDich(async () => {
      await db.exec(`CREATE FUNCTION public.test_but_toan() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
          IF NEW.business_result_accounting IS FALSE AND OLD.business_result_accounting IS NULL THEN
            INSERT INTO public.income_expense_posting_lines(organization_id, posting_id, account_id, signed_amount)
            VALUES (NEW.organization_id, NEW.active_posting_id_v2, NEW.account_id, 1);
          END IF; RETURN NEW; END $$;
        CREATE TRIGGER zz_test_but_toan AFTER UPDATE ON public.income_expenses FOR EACH ROW EXECUTE FUNCTION public.test_but_toan();`);
      return loi(D3A());
    });
    expect(e?.code).toBe("55000");
    expect(e?.message).toMatch(/^D3A_X3: bút toán/);
  });
  it("một trigger khác đổi thêm cột của phiếu ⇒ 55000 D3A_X3; hai khoá vẫn bật (giao dịch cuộn lại)", async () => {
    const r = await trongGiaoDich(async () => {
      await db.exec(`CREATE FUNCTION public.test_doi_them() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN NEW.notes := 'đổi lén'; RETURN NEW; END $$;
        CREATE TRIGGER zz_test_doi_them BEFORE UPDATE OF business_result_accounting ON public.income_expenses FOR EACH ROW EXECUTE FUNCTION public.test_doi_them();`);
      const e = await loi(D3A());
      return { e, trg: await mot<string>(`SELECT string_agg(tgenabled::text, '') AS v FROM pg_trigger WHERE tgname IN ('a02_ie_profit_lock_upd','a00_ie_owned_payload_freeze')`) };
    });
    expect(r.e?.code).toBe("55000");
    expect(r.e?.message).toMatch(/^D3A_X3/);
    expect(r.trg).toBe("OO");
  });
  it("has_restricted_item bị đổi sang giá trị KHÁC giá trị tính lại ⇒ 55000 D3A_X3", async () => {
    const e = await trongGiaoDich(async () => {
      await db.exec(`CREATE FUNCTION public.test_han_che() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
          IF NEW.business_result_accounting IS FALSE AND NEW.id = '${X3_A}' THEN NEW.has_restricted_item := true; END IF; RETURN NEW; END $$;
        CREATE TRIGGER zz_test_han_che BEFORE UPDATE ON public.income_expenses FOR EACH ROW EXECUTE FUNCTION public.test_han_che();`);
      return loi(D3A());
    });
    expect(e?.message).toMatch(/^D3A_X3/);
  });
  it("hai trong bốn phiếu đã ra khỏi KQKD ⇒ 55000 (không làm nửa vời)", async () => {
    const e = await trongGiaoDich(async () => {
      await db.exec(`ALTER TABLE public.income_expenses DISABLE TRIGGER a02_ie_profit_lock_upd;
        UPDATE public.income_expenses SET business_result_accounting = false WHERE id IN ('${X3_C}','${X3_D}');
        ALTER TABLE public.income_expenses ENABLE TRIGGER a02_ie_profit_lock_upd;`);
      return loi(D3A());
    });
    expect(e?.code).toBe("55000");
    expect(e?.message).toMatch(/^D3A_X3: bốn phiếu không cùng trạng thái/);
  });
  it("sổ quỹ của phiếu đã chốt qua ngày phiếu ⇒ 55000 D3A_X3", async () => {
    const e = await trongGiaoDich(async () => {
      await db.exec(`INSERT INTO app_private.cashbook_closures(organization_id, cashbook_id, closed_through) VALUES ('${ORG}','${SO_3}','2026-06-30')`);
      return loi(D3A());
    });
    expect(e?.message).toMatch(/^D3A_X3/);
  });
  it("không tắt hai khoá thì hai trigger thật (bản giả) chặn đúng bốn phiếu", async () => {
    const r = await trongGiaoDich(async () => ({
      thang: await loi(`UPDATE public.income_expenses SET business_result_accounting = false WHERE id = '${X3_C}'`),
      niemPhong: await loi(`UPDATE public.income_expenses SET business_result_accounting = false WHERE id = '${X3_A}'`),
    }));
    expect(r.thang?.message).toMatch(/^TEST_A02/);
    expect(r.niemPhong?.message).toMatch(/^TEST_A00/);
  });
});

describe("D3a — chủ thể có mốc phải chỉ còn phần sau mốc", () => {
  it("phiếu lương tháng 10 đã gắn sổ (sau mốc) ⇒ 55000 D3A_MOC, không ghi gì", async () => {
    const V10 = id(440);
    const r = await trongGiaoDich(async () => {
      await db.exec(`INSERT INTO public.income_expenses(id, user_id, type, name, building_id, voucher_date, total_amount, approval_status, posting_status,
          salary_staff_id, organization_id, account_id, created_at) VALUES ('${V10}','${CHU}','EXPENSE','Lương J T10','${TOA_AO}','2026-11-05',800,'APPROVED','POSTED',
          '${NV_J}','${ORG}','${SO_1}','2026-11-05 08:00+00');
        INSERT INTO app_private.profit_ledger_salary_settlement_vouchers(organization_id, shareholder_id, staff_id, period_month, salary_voucher_id,
          investment_amount, advance_offset_amount, sheet_status_at_quote, source, state, linked_at)
        VALUES ('${ORG}','${SH_J}','${NV_J}','2026-10-01','${V10}',5,0,'DRAFT','PAYOUT_FALLBACK','LINKED',now());`);
      return { e: await loi(D3A()), c1: await dem("app_private.profit_ledger_markers") };
    });
    expect(r.e?.code).toBe("55000");
    expect(r.e?.message).toMatch(/^D3A_MOC: số dư sau mốc/);
    expect(r.c1).toBe(0);
  });
});

describe("D3a — mốc xoá dấu tạm ứng ⇒ dừng (không tự xác nhận)", () => {
  it("số dư âm trước mốc ⇒ 22023 PROFIT_LEDGER_MARKER_ERASES_ADVANCE, không ghi gì", async () => {
    const r = await trongGiaoDich(async () => {
      await db.exec(`INSERT INTO public.profit_allocations(profit_monthly_id, shareholder_id, amount, organization_id)
        SELECT id, '${SH_J}', -1000, '${ORG}' FROM public.profit_monthly WHERE building_id = '${TOA_2}' AND period_month = '2026-09-01'`);
      return { e: await loi(D3A({ dauVao: vanTayDauVao([[SH_J, -1000]]) })), c1: await dem("app_private.profit_ledger_markers") };
    });
    expect(r.e?.code).toBe("22023");
    expect(r.e?.message).toMatch(/^PROFIT_LEDGER_MARKER_ERASES_ADVANCE/);
    expect(r.c1).toBe(0);
  });
});

describe("D3a — công ty thật vắng (database dùng một lần)", () => {
  it("chỉ thu quyền lệnh chi cũ; công tắc, sổ, phiếu không đổi", async () => {
    const trong = new PGlite();
    try {
      await dungCoSo(trong, false);
      await trong.exec("BEGIN");
      await trong.exec(D3A());
      await trong.exec(D3A());
      const v = (await trong.query<{ m: string; q: boolean; c: number }>(`SELECT
          (SELECT mode FROM app_private.server_feature_flags WHERE feature_key = 'shareholder_profit.ledger_payout.v1') AS m,
          has_function_privilege('authenticated','public.distribute_shareholder_profit_v1(uuid,numeric,uuid,date,text,text)','EXECUTE') AS q,
          (SELECT count(*)::int FROM app_private.server_feature_flag_events) AS c`)).rows[0];
      await trong.exec("ROLLBACK");
      expect(v).toEqual({ m: "OFF", q: false, c: 0 });
    } finally {
      await trong.close();
    }
  }, 120000);
});

describe("D3b — siết đọc thẳng (X5) và bật (X6)", () => {
  const policy = () => mot<Record<string, string>>(`SELECT jsonb_object_agg(polname, md5(replace(pg_get_expr(polqual, polrelid), 'public.', ''))) AS v
    FROM pg_policy WHERE polname IN ('profit_alloc_self_select','bldg_sh_self_select','profit_monthly_self_select')`);
  it("chưa điền S2 ⇒ 55000 D3B_CHUA_DIEN_SHA, không đổi policy hay công tắc", async () => {
    const r = await trongGiaoDich(async () => {
      await db.exec(D3A());
      const truoc = await policy();
      return { e: await loi(D3B(null)), truoc, sau: await policy(), route: await route() };
    });
    expect(r.e?.code).toBe("55000");
    expect(r.e?.message).toMatch(/^D3B_CHUA_DIEN_SHA/);
    expect(r.sau).toEqual(r.truoc);
    expect(r.route).toBe("SHADOW");
  });
  it("chưa áp D3a ⇒ 55000 D3B_D3A", async () => {
    const e = await trongGiaoDich(() => loi(D3B()));
    expect(e?.code).toBe("55000");
    expect(e?.message).toMatch(/^D3B_D3A/);
  });
  it("mốc của Đợt 3a đã bị gỡ trước khi bật ⇒ 55000 D3B_D3A thiếu mốc, không bật", async () => {
    const r = await trongGiaoDich(async () => {
      await db.exec(D3A());
      await db.exec(`SELECT app_private.profit_ledger_tao_set_marker_v1('${ORG}','SHAREHOLDER','${SH_J}', NULL, 'Gỡ mốc để thử D3b',
        (SELECT marker_id FROM app_private.profit_ledger_active_marker_v1('${ORG}','SHAREHOLDER','${SH_J}')), false, 'thu-go-moc-d3b', '${CHU}')`);
      return { e: await loi(D3B()), route: await route() };
    });
    expect(r.e?.code).toBe("55000");
    expect(r.e?.message).toMatch(/^D3B_D3A: thiếu mốc/);
    expect(r.route).toBe("SHADOW");
  });
  it("D3a rồi D3b hai lượt: policy mới, ON với đủ danh tính, CANONICAL, đúng một sự kiện SHADOW→ON", async () => {
    const r = await trongGiaoDich(async () => {
      await db.exec(D3A());
      // Chủ thứ hai cũng đã kích hoạt (muộn hơn): người bật vẫn phải là người kích hoạt sớm nhất.
      await db.exec(`UPDATE public.organization_memberships SET activated_at = '2026-08-01' WHERE id = '${mem(CHU2)}'`);
      const truoc = await policy();
      const e1 = await loi(D3B());
      const ev1 = await dem("app_private.server_feature_flag_events");
      const e2 = await loi(D3B());
      return {
        e1, e2, truoc, sau: await policy(), ev1, ev2: await dem("app_private.server_feature_flag_events"), route: await route(),
        co: await mot<Record<string, unknown>>(`SELECT to_jsonb(f) - ARRAY['updated_at','reason'] AS v FROM app_private.server_feature_flags f
          WHERE feature_key = 'shareholder_profit.ledger_payout.v1'`),
        ev: await mot<unknown>(`SELECT jsonb_build_object('t', event_type, 'b', before_mode, 'a', after_mode, 'actor', actor) AS v
          FROM app_private.server_feature_flag_events ORDER BY id DESC LIMIT 1`),
      };
    });
    expect([r.e1, r.e2]).toEqual([null, null]);
    expect(r.ev2).toBe(r.ev1);
    expect(r.truoc).toEqual({ bldg_sh_self_select: "994851d13a12894dc95535a6980dda25", profit_alloc_self_select: "994851d13a12894dc95535a6980dda25",
      profit_monthly_self_select: "bd85d18a46e55d64a6acc38720db3851" });
    expect(r.sau).toEqual({ bldg_sh_self_select: "0f054bd4aff0f0f2e82da2f6758713d8", profit_alloc_self_select: "0f054bd4aff0f0f2e82da2f6758713d8",
      profit_monthly_self_select: "06593fc2ad8e42337a6ac9a1237e3c52" });
    expect(r.route).toBe("CANONICAL");
    expect(r.co).toMatchObject({ mode: "ON", force_freeze: false, config_version: 3, commit_sha: SHA_THU,
      migration_sha256: "b3bd97e7b47a58eb396bd95a3d5caa447e9fb0f6e8c1a343b5f547d1468b4a67", approval_reference: "chủ uỷ quyền 15/11/2026", updated_by: CHU });
    expect(String(r.co.maintenance_window_id)).toMatch(/^MW-\d{4}-\d{2}-\d{2}T\d{2}:\d{2}-so-tong-loi-nhuan-bat$/);
    expect(r.ev).toEqual({ t: "ROUTE_CHANGED", b: "SHADOW", a: "ON", actor: CHU });
  });
  it("X5: cổ đông chỉ đọc thẳng % khi có view_percent; số liệu toà cần cả view_building_totals (4 tổ hợp)", async () => {
    const r = await trongGiaoDich(async () => {
      await db.exec(D3A());
      const doc = async () => ({
        a: await la<number>(NV_B, `SELECT count(*)::int AS v FROM public.profit_allocations`),
        b: await la<number>(NV_B, `SELECT count(*)::int AS v FROM public.building_shareholders`),
        m: await la<number>(NV_B, `SELECT count(*)::int AS v FROM public.profit_monthly`),
      });
      const truocX5 = await doc();
      await db.exec(D3B());
      const kq: Record<string, unknown> = { truocX5 };
      for (const [ten, khoa] of [["--", []], ["P-", ["view_percent"]], ["-B", ["view_building_totals"]], ["PB", ["view_percent", "view_building_totals"]]] as const) {
        await db.exec("SAVEPOINT to_hop");
        for (const [i, k2] of khoa.entries()) {
          await db.exec(`INSERT INTO public.member_permission_overrides(id, organization_id, membership_id, permission_key, effect)
              VALUES ('${id(600 + i)}','${ORG}','${mem(NV_B)}','shareholder_profit.${k2}','ALLOW');
            INSERT INTO public.member_override_scopes VALUES ('${ORG}','${id(600 + i)}','${PV}');`);
        }
        kq[ten] = await doc();
        await db.exec("ROLLBACK TO SAVEPOINT to_hop");
      }
      return kq;
    });
    expect(r).toEqual({ truocX5: { a: 2, b: 1, m: 2 }, "--": { a: 0, b: 0, m: 0 }, "P-": { a: 2, b: 1, m: 0 },
      "-B": { a: 0, b: 0, m: 0 }, PB: { a: 2, b: 1, m: 2 } });
  });
  it("policy đã bị đổi khác cả bản cũ lẫn bản mới ⇒ 55000 D3B_X5", async () => {
    const e = await trongGiaoDich(async () => {
      await db.exec(D3A());
      await db.exec(`ALTER POLICY bldg_sh_self_select ON public.building_shareholders USING (true)`);
      return loi(D3B());
    });
    expect(e?.message).toMatch(/^D3B_X5/);
  });
  it("F1 của Đợt 1 khác bản đã rà ⇒ 55000 D3B_NEN", async () => {
    const e = await trongGiaoDich(async () => {
      await db.exec(D3A());
      await db.exec(dinhNghiaTruocD3("app_private.guard_profit_ledger_payout_v1").replace(/RETURN NEW;/, "RETURN NEW; -- sửa"));
      return loi(D3B());
    });
    expect(e?.message).toMatch(/^D3B_NEN/);
  });
  it("đang đóng băng ⇒ 55000, không bật", async () => {
    const r = await trongGiaoDich(async () => {
      await db.exec(D3A());
      await db.exec(`UPDATE app_private.server_feature_flags SET force_freeze = true WHERE feature_key = 'shareholder_profit.ledger_payout.v1'`);
      return { e: await loi(D3B()), mode: await mot<string>(`SELECT mode AS v FROM app_private.server_feature_flags WHERE feature_key = 'shareholder_profit.ledger_payout.v1'`) };
    });
    expect(r.e?.code).toBe("55000");
    expect(r.e?.message).toMatch(/^D3B_D3A: công tắc phải ở SHADOW/);
    expect(r.mode).toBe("SHADOW");
  });
  it("công ty thật vắng: X5 vẫn áp, X6 bỏ qua (công tắc giữ OFF)", async () => {
    const trong = new PGlite();
    try {
      await dungCoSo(trong, false);
      await trong.exec("BEGIN");
      await trong.exec(D3A());
      await trong.exec(D3B());
      const v = (await trong.query<{ m: string; p: number }>(`SELECT
          (SELECT mode FROM app_private.server_feature_flags WHERE feature_key = 'shareholder_profit.ledger_payout.v1') AS m,
          (SELECT count(*)::int FROM pg_policies WHERE qual LIKE '%profit_viewer_can_v1%') AS p`)).rows[0];
      await trong.exec("ROLLBACK");
      expect(v).toEqual({ m: "OFF", p: 3 });
    } finally {
      await trong.close();
    }
  }, 120000);
});

describe("Dọn hàm ghi bù một lần (20261115213226) — D3a chạy lại dừng ở câu cố định đã ghim", () => {
  const FILE_DON = `${DIR}/20261115213226_so_tong_loi_nhuan_don_ham_ghi_bu.sql`;
  const DON = boGiaoDich(readFileSync(FILE_DON, "utf8"));
  const HAM_GHI_BU = "app_private.profit_ledger_luong_backfill_v1(uuid,numeric,numeric,text,uuid,date)";
  it("D3a → D3b → dọn (hai lượt): hàm ghi bù mất; chạy lại D3a ⇒ đúng SQLSTATE + câu của ngoại lệ pinned, không ghi gì", async () => {
    const pin = (JSON.parse(readFileSync("supabase/migration-policy.json", "utf8")).idempotencyExceptions as
      { file: string; expectedSqlState: string; expectedMessage: string; supersededBy?: { file: string } }[])
      .find((x) => x.file === "20261115113530_so_tong_loi_nhuan_chuyen_doi.sql");
    const r = await trongGiaoDich(async () => {
      await db.exec(D3A());
      await db.exec(D3B());
      await db.exec(DON);
      await db.exec(DON);
      const truoc = await demTatCa();
      const e = await loi(D3A());
      return { con: await mot<boolean>(`SELECT to_regprocedure('${HAM_GHI_BU}') IS NOT NULL AS v`), e, truoc, sau: await demTatCa(),
        route: await route() };
    });
    expect(r.con).toBe(false);
    expect(pin?.supersededBy?.file).toBe("20261115213226_so_tong_loi_nhuan_don_ham_ghi_bu.sql");
    expect(r.e?.code).toBe(pin?.expectedSqlState);
    expect(r.e?.message).toBe(pin?.expectedMessage);
    expect(r.e?.message).toBe(`D3A_NEN: thiếu nền Đợt 1 — áp đủ năm migration Đợt 1 trước: ${HAM_GHI_BU}`);
    expect(r.sau).toEqual(r.truoc);
    expect(r.route).toBe("CANONICAL");
  });
  it("database dùng một lần (không công ty thật): D3a, D3b rồi dọn chạy được", async () => {
    const trong = new PGlite();
    try {
      await dungCoSo(trong, false);
      await trong.exec("BEGIN");
      await trong.exec(D3A());
      await trong.exec(D3B());
      await trong.exec(DON);
      const v = (await trong.query<{ c: boolean }>(`SELECT to_regprocedure('${HAM_GHI_BU}') IS NOT NULL AS c`)).rows[0];
      await trong.exec("ROLLBACK");
      expect(v).toEqual({ c: false });
    } finally {
      await trong.close();
    }
  }, 120000);
});
