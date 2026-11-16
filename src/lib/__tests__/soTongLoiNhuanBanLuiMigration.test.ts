import { readFileSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildTransaction } from "../../../scripts/apply-reviewed-migration.mjs";

/**
 * Bản lùi Đợt 3 của sổ tổng lợi nhuận (R7a, R7b, R7c, R6, R3, R2, R4, R5, R1) — chạy THẬT trên PostgreSQL nhúng, cùng
 * fixture với soTongLoiNhuanChuyenDoiMigration.test.ts (D3a 20261115113530, D3b 20261115113532, dọn hàm 20261115213226).
 *
 * Bản lùi ở docs/superpowers/runbooks/2026-11-16-so-tong-loi-nhuan-ban-lui-dot3/d3_<bước>.sql (runbook README.md cùng thư
 * mục) — mỗi tệp là NỘI DUNG MIGRATION HOÀN CHỈNH (header + BEGIN/COMMIT), không phải migration: khi dùng thật chỉ còn
 * `node scripts/tao-ten-migration.mjs <slug>` → chép nguyên văn → lane.
 * Thử đúng như lane (buildTransaction của scripts/apply-reviewed-migration.mjs):
 *  - dry-run DÁN HAI LƯỢT trong một giao dịch rồi ROLLBACK, soi riêng từng lượt: lượt hai KHÔNG được ghi thêm gì;
 *  - áp một lượt rồi COMMIT; chuỗi lùi toàn phần R7a→R7b→R7c→R6→R3→R2→R4→R5→R1 phải về ĐÚNG trạng thái trước D3a;
 *  - áp lại D3a (migration mới: tạo lại hàm ghi bù, khoá mốc mới) rồi lùi LẦN HAI cũng phải về đúng trạng thái đó;
 *  - Restore Drill: database dùng một lần (không công ty thật) chạy nguyên văn từng file;
 *  - các ca dừng có chủ đích (thứ tự sai, phiếu kẹt, mốc của chủ, tạm ứng, thiếu chủ, C3 dùng chung / bị thay).
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

const boCot = (o: Record<string, unknown>, cot: string[]) => Object.fromEntries(Object.entries(o).filter(([k]) => !cot.includes(k)));

// ── Bản lùi Đợt 3 (R1–R7c) ──────────────────────────────────────────────────────
// Mỗi bước là NỘI DUNG MIGRATION HOÀN CHỈNH (header + BEGIN/COMMIT). BAN_LUI_DIR đổi thư mục (vd thử bản nháp ngoài repo).
const DIR_LUI = process.env.BAN_LUI_DIR ?? "docs/superpowers/runbooks/2026-11-16-so-tong-loi-nhuan-ban-lui-dot3";
const BUOC = ["R7a", "R7b", "R7c", "R6", "R3", "R2", "R4", "R5", "R1"] as const;
type Buoc = (typeof BUOC)[number];
const LUI = Object.fromEntries(BUOC.map((b) => [b, readFileSync(`${DIR_LUI}/d3_${b}.sql`, "utf8")])) as Record<Buoc, string>;
const KHOA = "shareholder_profit.ledger_payout.v1";
const FILE_DON = `${DIR}/20261115213226_so_tong_loi_nhuan_don_ham_ghi_bu.sql`;
const DON_GOC = readFileSync(FILE_DON, "utf8");
const D3B_FILE = ghim(D3B_KHUON.replace("<<SHA_PRODUCTION_WEB>>", SHA_THU));
const D3A_FILE = ghim(D3A_GOC);
/** Áp lại D3a sau khi lùi: migration mới ⇒ khoá mốc mới. */
const D3A_AP_LAI = D3A_FILE.split("'d3a-20261115113530-moc'").join("'d3a-20261115113530-moc-ap-lai'");
/** Câu lỗi cố định CI ghim cho D3a chạy lại (supabase/migration-policy.json → idempotencyExceptions). */
const PIN_D3A = (JSON.parse(readFileSync("supabase/migration-policy.json", "utf8")).idempotencyExceptions as
  { file: string; expectedMessage: string }[]).find((x) => x.file === "20261115113530_so_tong_loi_nhuan_chuyen_doi.sql")!.expectedMessage;
/** Hàm ghi bù đã bị 20261115213226 dọn: áp lại D3a phải tự tạo lại đúng thân M3. */
const HAM_GHI_BU_M3 = dinhNghiaTruocD3("app_private.profit_ledger_luong_backfill_v1");
const TAO_LAI_HAM_GHI_BU = `${HAM_GHI_BU_M3}
REVOKE ALL ON FUNCTION app_private.profit_ledger_luong_backfill_v1(uuid, numeric, numeric, text, uuid, date) FROM PUBLIC, anon, authenticated, service_role;`;

/** Đúng như lane: dry-run dán HAI lượt trong một giao dịch rồi ROLLBACK; --apply chạy một lượt rồi COMMIT. */
const laneHaiLuot = (sql: string) => buildTransaction(sql, { rollback: true, lanChay: 2 });
const laneAp = (sql: string) => buildTransaction(sql, { rollback: false });
const than = (sql: string) => boGiaoDich(sql);

type Loi2 = { code: string; message: string; detail: string | null };
async function chay(d: PGlite, sql: string, thongBao?: string[]): Promise<Loi2 | null> {
  try {
    await d.exec(sql, { onNotice: (n) => thongBao?.push(String(n.message ?? "")) });
    return null;
  } catch (e) {
    const x = e as { code?: string; message?: string; detail?: string };
    try { await d.exec("ROLLBACK"); } catch { /* không có giao dịch mở */ }
    return { code: x.code ?? "?", message: x.message ?? "", detail: x.detail ?? null };
  }
}
/** Chạy trong giao dịch đang mở, bọc SAVEPOINT; lỗi ⇒ trả lỗi, giao dịch vẫn dùng được. */
async function thu(d: PGlite, sql: string, thongBao?: string[]): Promise<Loi2 | null> {
  await d.exec("SAVEPOINT thu_lui");
  try {
    await d.exec(sql, { onNotice: (n) => thongBao?.push(String(n.message ?? "")) });
    await d.exec("RELEASE SAVEPOINT thu_lui");
    return null;
  } catch (e) {
    await d.exec("ROLLBACK TO SAVEPOINT thu_lui");
    const x = e as { code?: string; message?: string; detail?: string };
    return { code: x.code ?? "?", message: x.message ?? "", detail: x.detail ?? null };
  }
}
const mot2 = async <T>(d: PGlite, sql: string) => (await d.query<{ v: T }>(sql)).rows[0].v;

/** Ảnh "có ghi gì không": md5 toàn bộ nội dung các bảng / catalog mà bản lùi có thể chạm. */
const BANG_ANH = [
  "app_private.server_feature_flags", "app_private.server_feature_flag_events", "app_private.profit_ledger_markers",
  "app_private.canonical_write_operations", "app_private.profit_ledger_salary_settlements",
  "app_private.profit_ledger_salary_settlement_vouchers", "app_private.profit_ledger_events",
  "app_private.profit_ledger_payouts", "public.income_expenses", "public.income_expense_audit_log",
  "app_private.income_expense_audit_chain_heads", "public.salary_monthly",
];
const ANH_SQL = `SELECT jsonb_build_object(${BANG_ANH.map((b) =>
  `'${b}', (SELECT md5(COALESCE(string_agg(x.j, ',' ORDER BY x.j), '')) FROM (SELECT to_jsonb(t)::text AS j FROM ${b} t) x)`).join(",\n")},
  'policy', (SELECT string_agg(polname || ':' || md5(replace(pg_get_expr(polqual, polrelid), 'public.', '')), ',' ORDER BY polname)
               FROM pg_policy WHERE polname IN ('profit_alloc_self_select','bldg_sh_self_select','profit_monthly_self_select')),
  'acl', (SELECT proacl::text FROM pg_proc WHERE oid = to_regprocedure('public.distribute_shareholder_profit_v1(uuid,numeric,uuid,date,text,text)')),
  'trg', (SELECT string_agg(tgrelid::regclass::text || '.' || tgname || ':' || tgenabled::text, ',' ORDER BY 1) FROM pg_trigger WHERE NOT tgisinternal),
  'seq', (SELECT last_value::text || '/' || is_called::text FROM app_private.profit_ledger_seq)) AS v`;
const anh = (d: PGlite) => mot2<Record<string, string>>(d, ANH_SQL).then((x) => JSON.stringify(x));

/** Trạng thái nghiệp vụ để so "về đúng trước D3a". */
const CHU_THE: [string, string][] = [["SHAREHOLDER", SH_J], ["SHAREHOLDER", SH_N], ["SHAREHOLDER", SH_B], ["SHAREHOLDER", SH_X],
  ["MANAGER", QL_1], ["MANAGER", QL_2]];
const TRANG_THAI_SQL = `SELECT jsonb_build_object(
  'mode', (SELECT mode FROM app_private.server_feature_flags WHERE feature_key = '${KHOA}'),
  'freeze', (SELECT force_freeze FROM app_private.server_feature_flags WHERE feature_key = '${KHOA}'),
  'route', app_private.evaluate_feature_route('${KHOA}', '${ORG}'),
  'so_du', jsonb_build_object(${CHU_THE.map(([k, s]) => `'${k}:${s}', (app_private.profit_ledger_balance_v1('${ORG}','${k}','${s}') ->> 'balance')::numeric`).join(",")}),
  'moc', jsonb_build_object(${CHU_THE.map(([k, s]) => `'${k}:${s}', (SELECT settled_through_month FROM app_private.profit_ledger_active_marker_v1('${ORG}','${k}','${s}'))`).join(",")}),
  'c4_linked', (SELECT count(*) FROM app_private.profit_ledger_salary_settlement_vouchers WHERE state = 'LINKED'),
  'c3_frozen', (SELECT count(*) FROM app_private.profit_ledger_salary_settlements WHERE state = 'FROZEN'),
  'x3', (SELECT jsonb_object_agg(id::text, to_jsonb(ie) - 'updated_at') FROM public.income_expenses ie WHERE id IN (${X3.map((x) => `'${x}'`).join(",")})),
  'luong', (SELECT md5(string_agg(j, ',' ORDER BY j)) FROM (SELECT to_jsonb(ie)::text AS j FROM public.income_expenses ie
              WHERE ie.id IN ('${V_N9}','${V_J5}','${V_N5}','${V_J9}') UNION ALL SELECT to_jsonb(sm)::text FROM public.salary_monthly sm) x),
  'dist', jsonb_build_array(
            has_function_privilege('authenticated','public.distribute_shareholder_profit_v1(uuid,numeric,uuid,date,text,text)','EXECUTE'),
            has_function_privilege('anon','public.distribute_shareholder_profit_v1(uuid,numeric,uuid,date,text,text)','EXECUTE')),
  'policy', (SELECT jsonb_object_agg(polname, md5(replace(pg_get_expr(polqual, polrelid), 'public.', '')))
               FROM pg_policy WHERE polname IN ('profit_alloc_self_select','bldg_sh_self_select','profit_monthly_self_select')),
  'trg', (SELECT string_agg(tgname || ':' || tgenabled::text, ',' ORDER BY tgname) FROM pg_trigger
           WHERE tgname IN ('a02_ie_profit_lock_upd','a00_ie_owned_payload_freeze','a00_profit_ledger_salary_lines_guard'))) AS v`;
type TrangThai = Record<string, unknown> & { so_du: Record<string, number>; moc: Record<string, string | null> };
const trangThai = (d: PGlite) => mot2<TrangThai>(d, TRANG_THAI_SQL);

type KetBuoc = { lane: Loi2 | null; e1: Loi2 | null; e2: Loi2 | null; luot1Ghi: boolean; luot2KhongGhi: boolean;
  ap: Loi2 | null; tb1: string[]; tb2: string[]; tt: TrangThai };
/** Một bước như production: dry-run hai lượt của lane → (soi từng lượt trong giao dịch ROLLBACK) → áp. */
async function motBuoc(d: PGlite, sql: string): Promise<KetBuoc> {
  const lane = await chay(d, laneHaiLuot(sql));
  const tb1: string[] = [], tb2: string[] = [];
  await d.exec("BEGIN");
  const a0 = await anh(d);
  const e1 = await thu(d, than(sql), tb1);
  const a1 = await anh(d);
  const e2 = await thu(d, than(sql), tb2);
  const a2 = await anh(d);
  await d.exec("ROLLBACK");
  const ap = await chay(d, laneAp(sql));
  return { lane, e1, e2, luot1Ghi: a1 !== a0, luot2KhongGhi: a2 === a1, ap, tb1, tb2, tt: await trangThai(d) };
}
/** Ghi nhận kết quả để in biên nhận. */
const BIEN_NHAN: string[] = [];
const ghiNhan = (ten: string, k: KetBuoc) => BIEN_NHAN.push(
  `${ten}: lane hai lượt ${k.lane ? `LỖI ${k.lane.code} ${k.lane.message}` : "xanh"} · lượt 1 ${k.e1 ? `LỖI ${k.e1.message}` : k.luot1Ghi ? "có ghi" : "không ghi"}`
  + ` · lượt 2 ${k.e2 ? `LỖI ${k.e2.message}` : k.luot2KhongGhi ? "không ghi gì" : "CÓ GHI THÊM"} · áp ${k.ap ? `LỖI ${k.ap.message}` : "xanh"}`
  + ` · route ${k.tt.route} · lượt 2: ${k.tb2.filter((t) => t.startsWith("R")).join(" | ")}`);

const db = new PGlite();
afterAll(async () => {
  await db.close();
  if (process.env.BAN_LUI_BIEN_NHAN) {
    const { writeFileSync } = await import("node:fs");
    writeFileSync(process.env.BAN_LUI_BIEN_NHAN, BIEN_NHAN.join("\n") + "\n", "utf8");
  }
});

describe("[ghim] văn bản bản lùi", () => {
  it("[ghim] mỗi bước là migration hoàn chỉnh: lane dựng được giao dịch hai lượt và giao dịch áp", () => {
    for (const b of BUOC) {
      expect(() => laneHaiLuot(LUI[b]), b).not.toThrow();
      expect(() => laneAp(LUI[b]), b).not.toThrow();
      expect(LUI[b].match(/^BEGIN;$/gm)?.length, b).toBe(1);
      expect(LUI[b].match(/^COMMIT;$/gm)?.length, b).toBe(1);
    }
  });
  it("[ghim] không số tiền, tên người, uuid ngoài các uuid đã công khai trong D3a; không session_replication_role", () => {
    const UUID_DUOC = new Set([ORG, ...X3]);
    for (const b of BUOC) {
      const khongChuThich = LUI[b].replace(/--[^\n]*/g, "");
      const uuid = khongChuThich.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g) ?? [];
      expect(uuid.filter((u) => !UUID_DUOC.has(u)), b).toEqual([]);
      expect(LUI[b], b).not.toMatch(/JOEY|NATHAN|B\.?\s?Huy|Hiệp|Green|NG T[AÂ]M|Nguyễn Tâm/i);
      expect(LUI[b].replace(/[0-9a-f]{32,64}/g, "").replace(/(?<!\d)20\d{12}(?!\d)/g, ""), b)
        .not.toMatch(/\b\d{1,3}(?:\.\d{3})+\b|(?<![0-9a-f-])\d{7,}(?![0-9a-f-])/);
      expect(khongChuThich, b).not.toMatch(/session_replication_role/i);
    }
  });
  it("[ghim] R2, R4: mỗi DISABLE TRIGGER có ENABLE TRIGGER cùng tên đứng sau nó; không bước nào khác tắt trigger", () => {
    for (const b of BUOC) {
      const tat = [...LUI[b].matchAll(/DISABLE TRIGGER (\w+)/g)];
      expect(tat.map((m) => m[1]).sort(), b).toEqual(
        b === "R2" ? ["a00_profit_ledger_salary_lines_guard"] : b === "R4" ? ["a00_ie_owned_payload_freeze", "a02_ie_profit_lock_upd"] : []);
      for (const m of tat) expect(LUI[b].indexOf(`ENABLE TRIGGER ${m[1]}`, m.index), b).toBeGreaterThan(m.index!);
    }
  });
  it("[ghim] thân hàm ghi bù tạo lại để áp lại D3a = thân M3 (md5 prosrc bỏ CR)", () => {
    expect(md5(thanHam(HAM_GHI_BU_M3))).toBe("7ce5d543f3cb2937a2322fb44d664690");
    expect(LUI.R1).toContain("md5 prosrc bỏ CR 7ce5d543f3cb2937a2322fb44d664690");
  });
  it("[ghim] mỗi tệp ghi đủ cách áp (tao-ten-migration → chép → dry-run hai lượt → --apply), thứ tự lùi và luật R6 trước R1", () => {
    for (const b of BUOC) {
      expect(LUI[b], b).toMatch(/-- {3}1\. node scripts\/tao-ten-migration\.mjs so_tong_loi_nhuan_[a-z_]+ {3}\(chỉ IN ra tên <timestamp>_<slug>\.sql\)\n/);
      expect(LUI[b], b).toContain("2. tạo supabase/migrations/<tên vừa in> chứa NGUYÊN VĂN tệp này → git add <tệp đó> → npm run provenance:generate");
      expect(LUI[b], b).toContain("npm run migrate:forward -- <tệp>            (dry-run: lane dán HAI lượt");
      expect(LUI[b], b).toContain("npm run migrate:forward -- <tệp> --apply");
      expect(LUI[b], b).toContain("-- THỨ TỰ lùi toàn phần: R7a → R7b → R7c → R6 → R3 → R2 → R4 → (R5) → R1; R6 LUÔN trước R1");
      expect(LUI[b], b).toContain("Runbook: docs/superpowers/runbooks/2026-11-16-so-tong-loi-nhuan-ban-lui-dot3/README.md");
    }
    expect(readFileSync(`${DIR_LUI}/README.md`, "utf8")).toContain("**R6 LUÔN trước R1.**");
  });
});

describe("Chuỗi lùi toàn phần R7a→R7b→R7c→R6→R3→R2→R4→R5→R1 (mỗi bước: dry-run hai lượt của lane → áp)", () => {
  const k: Record<string, unknown> = {};
  const kb = {} as Record<Buoc, KetBuoc>;
  const kb2 = {} as Record<Buoc, KetBuoc>;
  beforeAll(async () => {
    await dungCoSo(db);
    k.s0 = await trangThai(db);
    k.d3a = await chay(db, laneAp(D3A_FILE));
    k.sauD3a = await trangThai(db);
    k.d3b = await chay(db, laneAp(D3B_FILE));
    k.don = await chay(db, laneAp(DON_GOC));
    k.sauD3b = await trangThai(db);
    k.mocD3a = await mot2<string[]>(db, `SELECT array_agg(subject_id::text ORDER BY subject_id::text) AS v FROM app_private.canonical_write_operations
      WHERE operation = 'shareholder_profit.ledger_marker.v1' AND idempotency_key = 'd3a-20261115113530-moc'`);
    // Mô phỏng CI: sau MỖI bước đã áp, dán hai lượt (ROLLBACK) mọi bước đã áp và D3a lên đúng trạng thái đó.
    const daAp: Buoc[] = [];
    const ci: string[] = [];
    let soLuotCi = 0;
    for (const b of BUOC) {
      kb[b] = await motBuoc(db, LUI[b]);
      ghiNhan(`lùi lần 1 ${b}`, kb[b]);
      daAp.push(b);
      for (const j of daAp) {
        const e = await chay(db, laneHaiLuot(LUI[j]));
        soLuotCi++;
        if (e) ci.push(`sau ${b}: ${j} ${e.code} ${e.message}`);
      }
      const eD3a = await chay(db, laneHaiLuot(D3A_FILE));
      soLuotCi++;
      if (eD3a?.message !== PIN_D3A) ci.push(`sau ${b}: D3a ${eD3a ? eD3a.message : "KHÔNG NGÃ"}`);
    }
    k.ci = ci;
    BIEN_NHAN.push(`Mô phỏng CI (sau mỗi bước dán hai lượt mọi bước đã áp + D3a): ${soLuotCi} lượt, ${ci.length ? `LỖI ${ci.join(" | ")}` : "không bước nào đỏ, D3a ngã đúng câu đã ghim"}`);
    k.s2 = await trangThai(db);
    k.ev = await mot2<unknown[]>(db, `SELECT jsonb_agg(jsonb_build_object('t', event_type, 'b', before_mode, 'a', after_mode, 'actor', actor,
      'thieu', detail ->> 'actor_missing') ORDER BY id) AS v FROM app_private.server_feature_flag_events`);
    k.mocR3 = await mot2<unknown[]>(db, `SELECT jsonb_agg(jsonb_build_object('key', o.idempotency_key, 'by', m.created_by, 'thang', m.settled_through_month,
      'de', m.supersedes_id, 'erased', m.advance_erased::float) ORDER BY o.idempotency_key) AS v
      FROM app_private.profit_ledger_markers m JOIN app_private.canonical_write_operations o ON o.subject_id = m.id AND o.idempotency_key LIKE 'r3-%'`);
    k.c5 = await mot2<unknown[]>(db, `SELECT jsonb_agg(jsonb_build_object('kind', event_kind, 'by', actor_id, 'src', payload ->> 'source',
      'rb', payload ->> 'rollback') ORDER BY event_kind, line_id) AS v FROM app_private.profit_ledger_events WHERE event_kind = 'SALARY_VOIDED'`);
    k.audit = await mot2<unknown[]>(db, `SELECT jsonb_agg(jsonb_build_object('id', income_expense_id, 'by', actor_id, 'cu', old_status, 'moi', new_status)
      ORDER BY sequence_no) AS v FROM public.income_expense_audit_log WHERE action = 'KQKD_OVERRIDE'`);
    // Áp lại D3a (migration mới: tạo lại hàm ghi bù + khoá mốc mới), rồi lùi LẦN HAI.
    k.taoLaiHam = await chay(db, `BEGIN; ${TAO_LAI_HAM_GHI_BU} COMMIT;`);
    k.d3aCu = await chay(db, laneHaiLuot(D3A_FILE)); // nguyên file cũ, cùng khoá mốc cũ
    k.apLai = await chay(db, laneAp(D3A_AP_LAI));
    k.sauApLai = await trangThai(db);
    k.donLai = await chay(db, laneAp(DON_GOC)); // migration áp lại cũng dọn hàm ghi bù lại
    for (const b of BUOC) { kb2[b] = await motBuoc(db, LUI[b]); ghiNhan(`lùi lần 2 (sau áp lại D3a) ${b}`, kb2[b]); }
    k.s3 = await trangThai(db);
    k.mocR3LanHai = await mot2<number>(db, `SELECT count(*)::int AS v FROM app_private.canonical_write_operations WHERE idempotency_key LIKE 'r3-go-moc-%'`);
  }, 300000);

  it("nền: D3a, D3b, dọn hàm áp xanh; sau D3b route CANONICAL, mốc đặt, lương ghi bù", () => {
    expect([k.d3a, k.d3b, k.don]).toEqual([null, null, null]);
    const t = k.sauD3b as TrangThai;
    expect([t.route, t.c4_linked, t.c3_frozen]).toEqual(["CANONICAL", 3, 2]);
    expect(Object.values(t.moc).filter(Boolean).length).toBe(4);
  });
  for (const b of BUOC) {
    it(`${b}: dry-run hai lượt của lane xanh; lượt một có ghi, lượt hai KHÔNG ghi gì; áp xanh`, () => {
      expect(kb[b].lane).toBeNull();
      expect([kb[b].e1, kb[b].e2]).toEqual([null, null]);
      expect(kb[b].luot1Ghi).toBe(true);
      expect(kb[b].luot2KhongGhi).toBe(true);
      expect(kb[b].ap).toBeNull();
    });
  }
  it("mô phỏng CI: sau MỖI bước, dán hai lượt mọi bước đã áp đều xanh; D3a vẫn ngã đúng câu đã ghim", () => {
    expect(k.ci).toEqual([]);
  });
  it("route theo từng bước: FROZEN → FROZEN → SHADOW … → LEGACY", () => {
    expect(BUOC.map((b) => kb[b].tt.route)).toEqual(["FROZEN", "FROZEN", "SHADOW", "SHADOW", "SHADOW", "SHADOW", "SHADOW", "SHADOW", "LEGACY"]);
  });
  it("lượt hai báo bỏ qua bằng câu cố định (không ném) ở mọi bước dữ liệu / công tắc", () => {
    expect(kb.R7a.tb2.join("|")).toMatch(/R7a: công tắc đã đóng băng — bỏ qua/);
    expect(kb.R7b.tb2.join("|")).toMatch(/R7b: công tắc đã ở SHADOW — bỏ qua/);
    expect(kb.R7c.tb2.join("|")).toMatch(/R7c: công tắc không đóng băng — bỏ qua/);
    expect(kb.R3.tb2.join("|")).toMatch(/R3: không còn mốc Đợt 3a nào phải gỡ/);
    expect(kb.R2.tb2.join("|")).toMatch(/R2: không còn dòng ghi bù LINKED/);
    expect(kb.R4.tb2.join("|")).toMatch(/R4: bốn phiếu đã ở KQKD tự động — bỏ qua/);
    expect(kb.R1.tb2.join("|")).toMatch(/R1: công tắc đã OFF — bỏ qua/);
  });
  it("cuối chuỗi: ĐÚNG trạng thái trước D3a (số dư mọi chủ thể, mốc, dòng lương, 4 phiếu X3 trừ updated_at, lương, ACL, policy, trigger, route)", () => {
    expect(k.s2).toEqual(k.s0);
    expect((k.s0 as TrangThai).route).toBe("LEGACY");
  });
  it("người ghi mọi sự kiện công tắc = chủ kích hoạt sớm nhất (R7a/R7c không còn actor NULL)", () => {
    expect(k.ev).toEqual([
      { t: "ROUTE_CHANGED", b: "OFF", a: "SHADOW", actor: CHU, thieu: null },
      { t: "ROUTE_CHANGED", b: "SHADOW", a: "ON", actor: CHU, thieu: null },
      { t: "FORCE_FREEZE", b: "ON", a: "ON", actor: CHU, thieu: "false" },
      { t: "ROUTE_CHANGED", b: "ON", a: "SHADOW", actor: CHU, thieu: null },
      { t: "FORCE_UNFREEZE", b: "SHADOW", a: "SHADOW", actor: CHU, thieu: null },
      { t: "ROUTE_CHANGED", b: "SHADOW", a: "OFF", actor: CHU, thieu: null },
    ]);
  });
  it("R3: bốn mốc gỡ bằng khoá riêng theo từng mốc Đợt 3a, đè đúng mốc đó, tháng NULL, không xoá dấu tạm ứng", () => {
    const moc = k.mocR3 as { key: string; by: string; thang: string | null; de: string; erased: number }[];
    expect(moc).toHaveLength(4);
    expect(moc.map((m) => m.key).sort()).toEqual((k.mocD3a as string[]).map((x) => `r3-go-moc-${x}`).sort());
    expect(moc.every((m) => m.by === CHU && m.thang === null && m.erased === 0 && m.key === `r3-go-moc-${m.de}`)).toBe(true);
  });
  it("R2: ba dòng ghi bù và hai bản đóng băng của ghi bù VOID; ba dòng nhật ký SALARY_VOIDED của chủ", () => {
    expect(k.c5).toEqual([1, 2, 3].map(() => ({ kind: "SALARY_VOIDED", by: CHU, src: "BACKFILL", rb: "R2" })));
  });
  it("R4: đúng bốn dòng nhật ký KQKD_OVERRIDE ngược của chủ (lượt hai không thêm), cộng bốn dòng của D3a", () => {
    const a = k.audit as { id: string; by: string; cu: string; moi: string }[];
    expect(a).toHaveLength(8);
    expect(a.slice(4).map((x) => [x.by, x.cu, x.moi])).toEqual(X3.map(() => [CHU, "KQKD: không", "KQKD: tự động"]));
    expect(a.slice(4).map((x) => x.id).sort()).toEqual([...X3].sort());
  });
  it("áp lại D3a: nguyên file cũ chạy lại dừng ở mốc (khoá idempotency cũ); file áp lại (khoá mới, tự tạo lại hàm ghi bù) về đúng trạng thái sau D3a", () => {
    expect(k.taoLaiHam).toBeNull();
    expect((k.d3aCu as Loi2 | null)?.message).toMatch(/^D3A_MOC/);
    expect(k.apLai).toBeNull();
    expect(k.donLai).toBeNull();
    const { so_du: a, moc: ma, x3: xa, ...ra } = k.sauApLai as TrangThai;
    const { so_du: b, moc: mb, x3: xb, ...rb } = k.sauD3a as TrangThai;
    expect(a).toEqual(b);
    expect(ma).toEqual(mb);
    expect(ra).toEqual(rb);
    const bo = (x: unknown) => Object.fromEntries(Object.entries(x as Record<string, Record<string, unknown>>).map(([i, o]) => [i, boCot(o, ["updated_at"])]));
    expect(bo(xa)).toEqual(bo(xb));
  });
  for (const b of BUOC) {
    it(`lùi LẦN HAI ${b}: dry-run hai lượt xanh, lượt hai không ghi, áp xanh`, () => {
      expect([kb2[b].lane, kb2[b].e1, kb2[b].e2, kb2[b].ap]).toEqual([null, null, null, null]);
      expect(kb2[b].luot2KhongGhi).toBe(true);
    });
  }
  it("lùi lần hai: R3 thật sự gỡ bốn mốc MỚI (khoá theo từng mốc — không trả kết quả cũ) và về đúng trạng thái trước D3a", () => {
    expect(k.mocR3LanHai).toBe(8);
    expect(kb2.R3.luot1Ghi).toBe(true);
    expect(k.s3).toEqual(k.s0);
  });
});

describe("Database dùng một lần (Restore Drill: baseline rỗng, không có công ty thật)", () => {
  const ket: Record<string, unknown> = {};
  const buoc = {} as Record<Buoc, { lane: Loi2 | null; file: Loi2 | null; doi: boolean; tb: string[] }>;
  beforeAll(async () => {
    const trong = new PGlite();
    try {
      await dungCoSo(trong, false);
      // Như Restore Drill: chạy từng file NGUYÊN VĂN (psql -f; file tự mở / đóng giao dịch).
      for (const f of [D3A_FILE, D3B_FILE, DON_GOC]) {
        const e = await chay(trong, f);
        if (e) throw new Error(e.message);
      }
      for (const b of BUOC) {
        const tb: string[] = [];
        const lane = await chay(trong, laneHaiLuot(LUI[b]));
        const a0 = await anh(trong);
        const file = await chay(trong, LUI[b], tb);
        const a1 = await anh(trong);
        buoc[b] = { lane, file, doi: a0 !== a1, tb };
        BIEN_NHAN.push(`DB rỗng ${b}: lane hai lượt ${lane ? `LỖI ${lane.message}` : "xanh"} · file nguyên văn ${file ? `LỖI ${file.message}` : "xanh"}`
          + ` · ${a0 !== a1 ? "có đổi" : "không đổi"} · ${tb.join(" | ")}`);
      }
      ket.co = await mot2(trong, `SELECT jsonb_build_object('mode', mode, 'freeze', force_freeze, 'ver', config_version) AS v
        FROM app_private.server_feature_flags WHERE feature_key = '${KHOA}'`);
      ket.ev = await mot2(trong, `SELECT count(*)::int AS v FROM app_private.server_feature_flag_events`);
      ket.policy = await mot2(trong, `SELECT count(*)::int AS v FROM pg_policies WHERE qual LIKE '%profit_viewer_can_v1%'`);
      ket.dist = await mot2(trong, `SELECT has_function_privilege('authenticated','public.distribute_shareholder_profit_v1(uuid,numeric,uuid,date,text,text)','EXECUTE') AS v`);
    } finally {
      await trong.close();
    }
  }, 120000);
  for (const b of BUOC) {
    it(`${b}: dry-run hai lượt của lane và file nguyên văn đều chạy được`, () => {
      expect([buoc[b].lane, buoc[b].file]).toEqual([null, null]);
    });
  }
  it("chỉ R6 (policy) và R5 (quyền) đổi gì đó; bước dữ liệu / công tắc báo vắng công ty rồi bỏ qua", () => {
    expect(BUOC.filter((b) => buoc[b].doi)).toEqual(["R6", "R5"]);
    for (const b of ["R7a", "R7b", "R7c", "R3", "R2", "R4", "R1"] as const) {
      expect(buoc[b].tb.join("|"), b).toContain("không có công ty thật (database dùng một lần) — bỏ qua");
    }
  });
  it("công tắc giữ OFF, không đóng băng, không sự kiện; policy về bản cũ; lệnh chi cũ mở lại cho authenticated", () => {
    expect(ket.co).toEqual({ mode: "OFF", freeze: false, ver: 1 });
    expect([ket.ev, ket.policy, ket.dist]).toEqual([0, 0, true]);
  });
});

const ghiNhanCa = (ten: string, e: Loi2 | null) => BIEN_NHAN.push(`Ca dừng — ${ten}: ${e ? `${e.code} ${e.message}` : "KHÔNG DỪNG"}`);

describe("Ca dừng có chủ đích (mỗi ca trong giao dịch ROLLBACK, nền = sau D3a + D3b + dọn hàm)", () => {
  const db2 = new PGlite();
  beforeAll(async () => {
    await dungCoSo(db2);
    for (const f of [D3A_FILE, D3B_FILE, DON_GOC]) {
      const e = await chay(db2, laneAp(f));
      if (e) throw new Error(e.message);
    }
  }, 120000);
  afterAll(() => db2.close());
  async function trongGD<T>(fn: () => Promise<T>): Promise<T> {
    await db2.exec("BEGIN");
    try { return await fn(); } finally { await db2.exec("ROLLBACK"); }
  }
  const buoc2 = (b: Buoc, sql = LUI[b]) => thu(db2, than(sql));
  async function den(...bs: Buoc[]) {
    for (const b of bs) {
      const e = await buoc2(b);
      if (e) throw new Error(`${b}: ${e.message}`);
    }
  }
  const route2 = () => mot2<string>(db2, `SELECT app_private.evaluate_feature_route('${KHOA}','${ORG}') AS v`);
  const BO_CHU = `UPDATE public.role_bindings SET valid_to = now() - interval '1 day' WHERE role_id = '${VAI_CHU}';`;

  it("R1 khi công tắc còn ON ⇒ 55000 R1_CONG_TAC; còn đóng băng ⇒ R1_DONG_BANG", async () => {
    const r = await trongGD(async () => {
      const on = await buoc2("R1");
      await den("R7a", "R7b");
      return { on, dong: await buoc2("R1") };
    });
    ghiNhanCa("R1 khi ON", r.on); ghiNhanCa("R1 khi đóng băng", r.dong);
    expect([r.on?.code, r.dong?.code]).toEqual(["55000", "55000"]);
    expect(r.on?.message).toMatch(/^R1_CONG_TAC: công tắc đang ON/);
    expect(r.dong?.message).toMatch(/^R1_DONG_BANG/);
  });
  it("R1 trước R6 ⇒ R1_R6; trước R3 ⇒ R1_MOC (không về LEGACY khi mốc còn mà hàm đặt mốc sẽ hết chạy)", async () => {
    const r = await trongGD(async () => {
      await den("R7a", "R7b", "R7c");
      const r6 = await buoc2("R1");
      await den("R6");
      return { r6, r3: await buoc2("R1"), route: await route2() };
    });
    ghiNhanCa("R1 trước R6", r.r6); ghiNhanCa("R1 trước R3", r.r3);
    expect(r.r6?.message).toMatch(/^R1_R6/);
    expect(r.r3?.message).toMatch(/^R1_MOC: còn 4 mốc Đợt 3a/);
    expect(r.route).toBe("SHADOW");
  });
  it("R1 khi còn phiếu sổ tổng chờ duyệt / đã duyệt chưa ghi sổ ⇒ R1_PHIEU_KET kèm số phiếu; phiếu đã ghi sổ / huỷ / bị từ chối không tính", async () => {
    const r = await trongGD(async () => {
      await den("R7a", "R7b", "R7c", "R6", "R3");
      await db2.exec(`
        INSERT INTO public.income_expenses(id, user_id, code, type, name, building_id, voucher_date, total_amount, approval_status, posting_status,
            organization_id, account_id, shareholder_id, profit_manager_id, system_source) VALUES
          ('${id(801)}','${CHU}','PC-ST-CHO','EXPENSE','Chi LN','${TOA_AO}','2026-11-14',10,'UNAPPROVED','UNPOSTED','${ORG}','${SO_1}','${SH_B}',NULL,'profit.ledger_payout'),
          ('${id(802)}','${CHU}','PC-ST-DUYET','EXPENSE','Lương ĐH','${TOA_AO}','2026-11-14',10,'APPROVED','UNPOSTED','${ORG}','${SO_1}',NULL,'${QL_1}','profit.manager_salary'),
          ('${id(803)}','${CHU}','PC-ST-XONG','EXPENSE','Chi LN','${TOA_AO}','2026-11-14',10,'APPROVED','POSTED','${ORG}','${SO_1}','${SH_B}',NULL,'profit.ledger_payout'),
          ('${id(804)}','${CHU}','PC-ST-HUY','EXPENSE','Chi LN','${TOA_AO}','2026-11-14',10,'CANCELLED','UNPOSTED','${ORG}','${SO_1}','${SH_B}',NULL,'profit.ledger_payout'),
          ('${id(805)}','${CHU}','PC-ST-TUCHOI','EXPENSE','Chi LN','${TOA_AO}','2026-11-14',10,'UNAPPROVED','UNPOSTED','${ORG}','${SO_1}','${SH_B}',NULL,'profit.ledger_payout');
        INSERT INTO public.approval_requests(organization_id, subject_type, subject_id, state) VALUES
          ('${ORG}','FINANCIAL_VOUCHER','${id(801)}','PENDING_APPROVAL'), ('${ORG}','FINANCIAL_VOUCHER','${id(805)}','REJECTED');`);
      return buoc2("R1");
    });
    ghiNhanCa("R1 còn phiếu kẹt", r);
    expect(r?.code).toBe("55000");
    expect(r?.message).toMatch(/^R1_PHIEU_KET: còn 2 phiếu chi theo sổ tổng chờ duyệt \/ đã duyệt chưa ghi sổ \(PC-ST-CHO, PC-ST-DUYET\)/);
  });
  it("R3 khi đóng băng ⇒ R3_DONG_BANG; ở LEGACY mà còn mốc Đợt 3a ⇒ R3_ROUTE", async () => {
    const r = await trongGD(async () => {
      await den("R7a");
      const dong = await buoc2("R3");
      await db2.exec(`UPDATE app_private.server_feature_flags SET force_freeze = false, mode = 'OFF' WHERE feature_key = '${KHOA}'`);
      return { dong, legacy: await buoc2("R3") };
    });
    ghiNhanCa("R3 khi đóng băng", r.dong); ghiNhanCa("R3 ở LEGACY", r.legacy);
    expect(r.dong?.message).toMatch(/^R3_DONG_BANG/);
    expect(r.legacy?.message).toMatch(/^R3_ROUTE: route đang LEGACY/);
  });
  it("công tắc còn ON (CANONICAL, hoặc ON đang đóng băng sau R7a) ⇒ R3 / R2 dừng, không ghi gì (số dư được phép chi không được nhảy lên)", async () => {
    const r = await trongGD(async () => {
      const route = await route2();
      const a0 = await anh(db2);
      const r3 = await buoc2("R3");
      const r2 = await buoc2("R2");
      const khongGhi = (await anh(db2)) === a0;
      await den("R7a");
      const a1 = await anh(db2);
      const r3Dong = await buoc2("R3");
      const r2Dong = await buoc2("R2");
      return { route, r3, r2, khongGhi, r3Dong, r2Dong, khongGhiDong: (await anh(db2)) === a1 };
    });
    ghiNhanCa("R3 khi còn ON", r.r3); ghiNhanCa("R2 khi còn ON", r.r2); ghiNhanCa("R2 khi ON đang đóng băng", r.r2Dong);
    expect(r.route).toBe("CANONICAL");
    expect(r.r3?.message).toMatch(/^R3_ROUTE: route đang CANONICAL — chạy R7b/);
    expect(r.r2?.message).toMatch(/^R2_ROUTE: công tắc còn ON/);
    expect(r.khongGhi).toBe(true);
    expect(r.r3Dong?.message).toMatch(/^R3_DONG_BANG/);
    expect(r.r2Dong?.message).toMatch(/^R2_ROUTE: công tắc còn ON \(kể cả khi đang đóng băng\)/);
    expect(r.khongGhiDong).toBe(true);
  });
  it("R7b khi còn phiếu sổ tổng chờ duyệt / đã duyệt chưa ghi sổ ⇒ R7B_PHIEU_KET kèm số phiếu (R7a vẫn đóng băng được)", async () => {
    const r = await trongGD(async () => {
      await db2.exec(`
        INSERT INTO public.income_expenses(id, user_id, code, type, name, building_id, voucher_date, total_amount, approval_status, posting_status,
            organization_id, account_id, shareholder_id, profit_manager_id, system_source) VALUES
          ('${id(841)}','${CHU}','PC-ST-CHO2','EXPENSE','Chi LN','${TOA_AO}','2026-11-14',10,'UNAPPROVED','UNPOSTED','${ORG}','${SO_1}','${SH_B}',NULL,'profit.ledger_payout'),
          ('${id(842)}','${CHU}','PC-ST-DUYET2','EXPENSE','Lương ĐH','${TOA_AO}','2026-11-14',10,'APPROVED','UNPOSTED','${ORG}','${SO_1}',NULL,'${QL_1}','profit.manager_salary');
        INSERT INTO public.approval_requests(organization_id, subject_type, subject_id, state) VALUES
          ('${ORG}','FINANCIAL_VOUCHER','${id(841)}','PENDING_APPROVAL');`);
      const r7a = await buoc2("R7a");
      const a0 = await anh(db2);
      const r7b = await buoc2("R7b");
      return { r7a, r7b, khongGhi: (await anh(db2)) === a0, route: await route2() };
    });
    ghiNhanCa("R7b còn phiếu kẹt", r.r7b);
    expect(r.r7a).toBeNull();
    expect(r.r7b?.code).toBe("55000");
    expect(r.r7b?.message).toMatch(/^R7B_PHIEU_KET: còn 2 phiếu chi theo sổ tổng chờ duyệt \/ đã duyệt chưa ghi sổ \(PC-ST-CHO2, PC-ST-DUYET2\)/);
    expect(r.khongGhi).toBe(true);
    expect(r.route).toBe("FROZEN");
  });
  it("R3 chạy lại sau khi chủ đặt mốc mới (sau R3) ⇒ bỏ qua, không dừng giả R3_MOC_KHAC; chủ gỡ mốc Đợt 3a (tháng NULL) trước R3 ⇒ R3 coi là xong", async () => {
    const r = await trongGD(async () => {
      await den("R7a", "R7b", "R7c");
      // Chủ gỡ mốc Đợt 3a của J (tháng NULL) trước R3.
      await db2.exec(`SELECT app_private.profit_ledger_tao_set_marker_v1('${ORG}','SHAREHOLDER','${SH_J}', NULL, 'Chủ gỡ mốc trước bản lùi',
        (SELECT marker_id FROM app_private.profit_ledger_active_marker_v1('${ORG}','SHAREHOLDER','${SH_J}')), false, 'chu-go-moc-0001', '${CHU}')`);
      const tb: string[] = [];
      const r3 = await thu(db2, than(LUI.R3), tb);
      // Sau R3, chủ đặt mốc mới cho N (hợp lệ ở SHADOW) ⇒ chạy lại R3 hai lượt không được dừng.
      await db2.exec(`SELECT app_private.profit_ledger_tao_set_marker_v1('${ORG}','SHAREHOLDER','${SH_N}', DATE '2026-10-01', 'Chủ đặt mốc mới sau bản lùi',
        (SELECT marker_id FROM app_private.profit_ledger_active_marker_v1('${ORG}','SHAREHOLDER','${SH_N}')), false, 'chu-moc-sau-r3-0001', '${CHU}')`);
      const a0 = await anh(db2);
      const lai1 = await buoc2("R3");
      const lai2 = await buoc2("R3");
      return { r3, tb: tb.join("|"), lai1, lai2, khongGhi: (await anh(db2)) === a0,
        go: await mot2<number>(db2, `SELECT count(*)::int AS v FROM app_private.canonical_write_operations WHERE idempotency_key LIKE 'r3-go-moc-%'`),
        r6: await buoc2("R6"), r1: await buoc2("R1") };
    });
    expect(r.r3).toBeNull();
    expect(r.tb).toMatch(/R3: đã gỡ 3 mốc Đợt 3a \(1 chủ thể đã gỡ từ trước\)/);
    expect(r.go).toBe(3);
    expect([r.lai1, r.lai2]).toEqual([null, null]);
    expect(r.khongGhi).toBe(true);
    expect([r.r6, r.r1]).toEqual([null, null]);
  });
  it("R3: chủ đã đặt mốc khác SAU Đợt 3a ⇒ R3_MOC_KHAC, không ghi gì (không gỡ mốc của chủ, không gỡ nửa vời)", async () => {
    const r = await trongGD(async () => {
      await den("R7a", "R7b", "R7c");
      await db2.exec(`SELECT app_private.profit_ledger_tao_set_marker_v1('${ORG}','SHAREHOLDER','${SH_J}', DATE '2026-10-01', 'Chủ đặt mốc mới sau Đợt 3a',
        (SELECT marker_id FROM app_private.profit_ledger_active_marker_v1('${ORG}','SHAREHOLDER','${SH_J}')), false, 'chu-dat-moc-moi-0001', '${CHU}')`);
      const a0 = await anh(db2);
      const e = await buoc2("R3");
      const khongGhi = (await anh(db2)) === a0;
      // Cách gỡ: chủ tự gỡ mốc của mình (tháng NULL) qua E9 rồi chạy lại R3 ⇒ R3 coi J là xong, gỡ ba mốc còn lại.
      await db2.exec(`SELECT app_private.profit_ledger_tao_set_marker_v1('${ORG}','SHAREHOLDER','${SH_J}', NULL, 'Chủ tự gỡ mốc của mình để lùi',
        (SELECT marker_id FROM app_private.profit_ledger_active_marker_v1('${ORG}','SHAREHOLDER','${SH_J}')), false, 'chu-tu-go-moc-0001', '${CHU}')`);
      const tb: string[] = [];
      const lai = await thu(db2, than(LUI.R3), tb);
      return { e, khongGhi, lai, tb: tb.join("|"), r6: await buoc2("R6"), r1: await buoc2("R1") };
    });
    ghiNhanCa("R3 gặp mốc của chủ", r.e);
    expect(r.e?.message).toMatch(/^R3_MOC_KHAC/);
    expect(r.e?.detail).toBe(`SHAREHOLDER:${md5(SH_J)}`);
    expect(r.khongGhi).toBe(true);
    expect(r.lai).toBeNull();
    expect(r.tb).toMatch(/R3: đã gỡ 3 mốc Đợt 3a \(1 chủ thể đã gỡ từ trước\)/);
    expect([r.r6, r.r1]).toEqual([null, null]);
  });
  it("R3: chủ thể đang âm (đã chi tạm ứng sau Đợt 3a) ⇒ R3_TAM_UNG, không ghi gì; chủ đồng ý (hằng = true) ⇒ gỡ được, mốc ghi số xoá dấu", async () => {
    const r = await trongGD(async () => {
      await den("R7a", "R7b", "R7c");
      await db2.exec(`INSERT INTO public.income_expenses(id, user_id, code, type, name, building_id, voucher_date, total_amount, approval_status,
          posting_status, organization_id, account_id, shareholder_id, system_source, created_at)
        VALUES ('${id(821)}','${CHU}','PC-TAM-UNG','EXPENSE','Tạm ứng LN','${TOA_AO}','2026-11-14',50,'APPROVED','POSTED','${ORG}','${SO_1}','${SH_J}',
          'profit.ledger_payout', '2030-01-01')`);
      const soDuJ = await mot2<string>(db2, `SELECT app_private.profit_ledger_balance_v1('${ORG}','SHAREHOLDER','${SH_J}') ->> 'balance' AS v`);
      const a0 = await anh(db2);
      const e = await buoc2("R3");
      const khongGhi = (await anh(db2)) === a0;
      const dongY = await buoc2("R3", LUI.R3.replace("c_xac_nhan_xoa_tam_ung constant boolean := false;", "c_xac_nhan_xoa_tam_ung constant boolean := true;"));
      const xoaDau = await mot2<number>(db2, `SELECT m.advance_erased::float AS v FROM app_private.profit_ledger_markers m
        WHERE m.id = (SELECT marker_id FROM app_private.profit_ledger_active_marker_v1('${ORG}','SHAREHOLDER','${SH_J}'))`);
      return { soDuJ: Number(soDuJ), e, khongGhi, dongY, xoaDau };
    });
    ghiNhanCa("R3 chủ thể đang âm", r.e);
    expect(r.soDuJ).toBe(-50);
    expect(r.e?.message).toMatch(/^R3_TAM_UNG/);
    expect(r.e?.detail).toBe(`SHAREHOLDER:${md5(SH_J)}`);
    expect(r.khongGhi).toBe(true);
    expect(r.dongY).toBeNull();
    expect(r.xoaDau).toBe(50);
  });
  it("không có tài khoản chủ: R7a VẪN đóng băng (actor NULL, actor_missing); R7c / R3 dừng R7C_ACTOR / R3_ACTOR", async () => {
    const r = await trongGD(async () => {
      await db2.exec(BO_CHU);
      const r7a = await buoc2("R7a");
      const route = await route2();
      const ev = await mot2<unknown>(db2, `SELECT jsonb_build_object('t', event_type, 'actor', actor, 'thieu', detail -> 'actor_missing') AS v
        FROM app_private.server_feature_flag_events ORDER BY id DESC LIMIT 1`);
      const r7c = await buoc2("R7c");
      await db2.exec(`UPDATE app_private.server_feature_flags SET force_freeze = false, mode = 'SHADOW' WHERE feature_key = '${KHOA}'`);
      return { r7a, route, ev, r7c, r3: await buoc2("R3") };
    });
    ghiNhanCa("R7c không có chủ", r.r7c); ghiNhanCa("R3 không có chủ", r.r3);
    expect(r.r7a).toBeNull();
    expect(r.route).toBe("FROZEN");
    expect(r.ev).toEqual({ t: "FORCE_FREEZE", actor: null, thieu: true });
    expect(r.r7c?.message).toMatch(/^R7C_ACTOR/);
    expect(r.r3?.message).toMatch(/^R3_ACTOR/);
  });
  it("R2: bản đóng băng của ghi bù đang được dòng phiếu lương khác dùng ⇒ R2_C3_DUNG_CHUNG, không ghi gì", async () => {
    const r = await trongGD(async () => {
      await den("R7a", "R7b", "R7c");
      await db2.exec(`
        INSERT INTO public.income_expenses(id, user_id, code, type, name, building_id, voucher_date, total_amount, approval_status, posting_status,
            salary_staff_id, organization_id, account_id) VALUES
          ('${id(831)}','${CHU}','PC-J5-B','EXPENSE','Lương J T5 bổ sung','${TOA_AO}','2026-11-14',10,'APPROVED','POSTED','${NV_J}','${ORG}','${SO_1}');
        INSERT INTO app_private.profit_ledger_salary_settlement_vouchers(organization_id, shareholder_id, staff_id, period_month, settlement_id,
            salary_voucher_id, investment_amount, sheet_status_at_quote, source, state, linked_at)
          SELECT '${ORG}','${SH_J}','${NV_J}','2026-05-01', c.id, '${id(831)}', 0, 'LOCKED', 'PAYOUT_FALLBACK', 'LINKED', clock_timestamp()
            FROM app_private.profit_ledger_salary_settlements c WHERE c.shareholder_id = '${SH_J}' AND c.state = 'FROZEN';`);
      const a0 = await anh(db2);
      const e = await buoc2("R2");
      return { e, khongGhi: (await anh(db2)) === a0 };
    });
    ghiNhanCa("R2 bản đóng băng dùng chung", r.e);
    expect(r.e?.message).toMatch(/^R2_C3_DUNG_CHUNG/);
    expect(r.khongGhi).toBe(true);
  });
  it("R4: bốn phiếu lẫn lộn trạng thái ⇒ R4_TRANG_THAI; sổ quỹ đã chốt qua ngày phiếu ⇒ R4_DIEU_KIEN", async () => {
    const r = await trongGD(async () => {
      await db2.exec("SAVEPOINT lan");
      await db2.exec(`ALTER TABLE public.income_expenses DISABLE TRIGGER a00_ie_owned_payload_freeze;
        UPDATE public.income_expenses SET business_result_accounting = NULL WHERE id = '${X3_A}';
        ALTER TABLE public.income_expenses ENABLE TRIGGER a00_ie_owned_payload_freeze;`);
      const lan = await buoc2("R4");
      await db2.exec("ROLLBACK TO SAVEPOINT lan");
      await db2.exec(`INSERT INTO app_private.cashbook_closures(organization_id, cashbook_id, closed_through) VALUES ('${ORG}','${SO_3}','2026-06-30')`);
      return { lan, chot: await buoc2("R4") };
    });
    ghiNhanCa("R4 lẫn lộn", r.lan); ghiNhanCa("R4 sổ đã chốt", r.chot);
    expect(r.lan?.message).toMatch(/^R4_TRANG_THAI/);
    expect(r.chot?.message).toMatch(/^R4_DIEU_KIEN/);
  });
  it("R4 với c_han_che_cu rỗng (chủ giữ 'hạn chế') ⇒ hai phiếu 21/05 giữ has_restricted_item = true, hậu kiểm vẫn đạt", async () => {
    const r = await trongGD(async () => {
      const e = await buoc2("R4", LUI.R4.replace(/c_han_che_cu constant uuid\[\] := ARRAY\[[^\]]*\]::uuid\[\];/, "c_han_che_cu constant uuid[] := ARRAY[]::uuid[];"));
      return { e, hc: await mot2<Record<string, boolean>>(db2, `SELECT jsonb_object_agg(id::text, has_restricted_item) AS v FROM public.income_expenses
        WHERE id IN (${X3.map((x) => `'${x}'`).join(",")})`) };
    });
    expect(r.e).toBeNull();
    expect(r.hc).toEqual({ [X3_A]: false, [X3_B]: true, [X3_C]: true, [X3_D]: true });
  });
  it("R6: policy đã bị sửa tay khác cả bản X5 lẫn bản cũ ⇒ R6_X5, không đè", async () => {
    const e = await trongGD(async () => {
      await db2.exec(`ALTER POLICY bldg_sh_self_select ON public.building_shareholders USING (true)`);
      return buoc2("R6");
    });
    ghiNhanCa("R6 policy sửa tay", e);
    expect(e?.message).toMatch(/^R6_X5/);
  });
});

describe("R2: ghi bù đã THAY một bản đóng băng có từ trước ⇒ R2_C3_THAY (không dựng lại được bản cũ)", () => {
  it("dừng, không ghi gì", async () => {
    const d = new PGlite();
    try {
      await dungCoSo(d);
      await d.exec("BEGIN");
      await d.exec(`INSERT INTO app_private.profit_ledger_salary_settlements(organization_id, shareholder_id, staff_id, period_month, investment_month)
        VALUES ('${ORG}','${SH_J}','${NV_J}','2026-05-01', 999)`);
      await d.exec(D3A());
      const thay = await mot2<number>(d, `SELECT count(*)::int AS v FROM app_private.profit_ledger_events
        WHERE event_kind = 'SALARY_FROZEN' AND payload ->> 'voided_settlement_id' IS NOT NULL`);
      const a0 = await anh(d);
      const e = await thu(d, than(LUI.R2));
      const khongGhi = (await anh(d)) === a0;
      await d.exec("ROLLBACK");
      ghiNhanCa("R2 ghi bù đã thay bản cũ", e);
      expect(thay).toBe(1);
      expect(e?.message).toMatch(/^R2_C3_THAY/);
      expect(khongGhi).toBe(true);
    } finally {
      await d.close();
    }
  }, 120000);
});

describe("R3: mốc Đợt 3a đè lên một mốc CÓ THÁNG đặt trước D3a ⇒ R3_MOC_TRUOC_D3A (đặt lại tháng cũ sẽ loại oan phiếu chi)", () => {
  it("dừng, không ghi gì", async () => {
    const d = new PGlite();
    try {
      await dungCoSo(d);
      await d.exec("BEGIN");
      // Công tắc SHADOW và chủ đặt mốc 07/2026 cho J TRƯỚC D3a (production không có: công tắc OFF tới D3a).
      await d.exec(`SELECT app_private.set_feature_route_v1('${KHOA}', 1, 'SHADOW', NULL, NULL, 0, 0, 0, NULL, NULL, NULL, NULL, '${CHU}', 'Thử: SHADOW trước D3a')`);
      await d.exec(`SELECT app_private.profit_ledger_tao_set_marker_v1('${ORG}','SHAREHOLDER','${SH_J}', DATE '2026-07-01', 'Chủ đặt mốc trước Đợt 3a',
        NULL, false, 'chu-moc-truoc-d3a-0001', '${CHU}')`);
      await d.exec(D3A());
      const a0 = await anh(d);
      const e = await thu(d, than(LUI.R3));
      const khongGhi = (await anh(d)) === a0;
      await d.exec("ROLLBACK");
      ghiNhanCa("R3 mốc Đợt 3a đè mốc có tháng trước D3a", e);
      expect(e?.message).toMatch(/^R3_MOC_TRUOC_D3A/);
      expect(e?.detail).toBe(`SHAREHOLDER:${md5(SH_J)}`);
      expect(khongGhi).toBe(true);
    } finally {
      await d.close();
    }
  }, 120000);
});
