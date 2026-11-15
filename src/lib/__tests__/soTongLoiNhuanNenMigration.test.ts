import { readFileSync, readdirSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * Migration 20261115063149 (M1 — phần nền của sổ tổng lợi nhuận cổ đông): ba khoá quyền mới, công tắc
 * đang TẮT, sáu bảng app_private.profit_ledger_* và các hàm lõi (phiếu còn sống, mốc hiệu lực, số dư,
 * khoá sổ, ước tính tháng chưa chốt).
 *
 * Chạy THẬT trên PostgreSQL nhúng:
 *  - app_private.authorized_scope_v3 và app_private.profit_viewer_can_v1 là ĐỊNH NGHĨA SỐNG lấy từ file
 *    migration đã phát hành (không phải stub) — nên ca quyền đo đúng luật thật;
 *  - migration chạy HAI lượt; giữa hai lượt đổi công tắc để chứng minh lượt sau không đặt lại;
 *  - mỗi ca chạy trong một giao dịch rồi ROLLBACK.
 * Ca hai phiên (xếp hàng theo khoá sổ) và ca JWT qua PostgREST không chạy được ở đây (một kết nối).
 */
const DIR = "supabase/migrations";
const FILE = `${DIR}/20261115063149_so_tong_loi_nhuan_nen.sql`;

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const mem = (user: string) => user.replace("4000-8000-0000000000", "4000-8000-1000000000");
const [ORG_A, ORG_B] = [1, 2].map(id);
const [CHU, CHU_HE_THONG, QUAN_LY, PARTNER, TAM_UNG, DA_GO, DENY_GO_ALLOW_SONG, VAI_NGHI, NGOAI, SUPER, HE_THONG_KHAC] =
  [11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21].map(id);
const [VAI_CHU_TU_TAO, VAI_CHU_HE_THONG, VAI_QUAN_LY, VAI_PARTNER, VAI_HE_THONG_KHAC, VAI_CHU_DA_NGHI, VAI_CHU_B, VAI_TEN_GAN_GIONG, VAI_CHU_SO_HUU_TU_TAO] =
  [31, 32, 33, 34, 35, 36, 37, 38, 39].map(id);
const [PHAM_VI_A, PHAM_VI_B] = [41, 42].map(id);
const [TOA_1, TOA_2, TOA_B, SO_QUY] = [51, 52, 53, 54].map(id);
const [CD1, CD2, CD_XOA, CD_B] = [61, 62, 63, 64].map(id);
const [QL1, QL2] = [71, 72].map(id);
const [PM_07, PM_08_STALE, PM_08_AM, PM_09_NHAP, PM_09, PM_B, PM_B_10] = [81, 82, 83, 84, 85, 86, 89].map(id);
const K_TAM_UNG = "shareholder_profit.advance_own_cashbook";
const K_XEM_PT = "shareholder_profit.view_percent";
const K_XEM_TOA = "shareholder_profit.view_building_totals";
const CO = "shareholder_profit.ledger_payout.v1";
const BANG = ["markers", "payouts", "salary_settlements", "salary_settlement_vouchers", "events", "write_contexts"]
  .map((t) => `app_private.profit_ledger_${t}`);
const HAM = [
  "profit_ledger_write_context_v1(uuid)", "profit_ledger_voucher_live_v1(uuid)",
  "profit_ledger_active_marker_v1(uuid,text,uuid)", "profit_ledger_balance_v1(uuid,text,uuid,uuid,date)",
  "profit_ledger_balance_core_v1(uuid,text,uuid,date,bigint,timestamptz,uuid,date)",
  "profit_ledger_lock_key_v1(uuid,text,uuid)", "profit_ledger_lock_v1(uuid,text,uuid)",
  "profit_ledger_lock_held_v1(uuid,text,uuid)", "profit_ledger_open_estimate_v1(uuid,uuid)",
  "guard_profit_ledger_append_only_v1()", "guard_profit_ledger_marker_v1()", "guard_profit_ledger_payout_row_v1()",
  "guard_profit_ledger_salary_settlement_v1()", "guard_profit_ledger_salary_line_v1()", "guard_profit_ledger_write_context_v1()",
].map((f) => `app_private.${f}`);
/** Số dư gốc của dữ liệu nền (xem duLieuSo): CD1 = 100 + 40 (stale) − 15.5 (âm) + 30. */
const CD1_GOC = 154.5;
const QL1_GOC = 18;

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
function dinhNghiaSong(ten: string): string {
  const re = new RegExp(`CREATE\\s+(?:OR\\s+REPLACE\\s+)?FUNCTION\\s+${ten.replace(".", "\\.")}\\s*\\(`, "i");
  let hit: string | null = null;
  for (const f of readdirSync(DIR).filter((x) => x.endsWith(".sql")).sort()) {
    const sql = readFileSync(`${DIR}/${f}`, "utf8");
    if (re.test(sql)) hit = sql;
  }
  if (!hit) throw new Error(`Không tìm thấy định nghĩa nào của ${ten}`);
  return cauLenhTaoHam(hit, ten);
}

const SCOPE_V3 = dinhNghiaSong("app_private.authorized_scope_v3");
// Migration này KHÔNG tạo profit_viewer_can_v1 (chỉ kiểm tồn tại) — lấy định nghĩa sống từ migration đã tạo nó.
const HELPER_QUYEN = dinhNghiaSong("app_private.profit_viewer_can_v1");
const MIGRATION = readFileSync(FILE, "utf8");
/** Thân migration không có BEGIN/COMMIT — để chạy trong một giao dịch do test mở (như lane dán hai lượt). */
const THAN = MIGRATION.replace(/^BEGIN;\s*$/m, "").replace(/^COMMIT;\s*$/m, "");

// Bảng nền: đúng cột và ràng buộc mà migration đụng tới (đối chiếu production 15/11/2026), không hơn.
const NEN = `
  CREATE ROLE authenticated; CREATE ROLE anon; CREATE ROLE service_role;
  CREATE SCHEMA auth; CREATE SCHEMA app_private;
  GRANT USAGE ON SCHEMA public, auth TO authenticated, anon, service_role;
  CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
  CREATE TABLE public.super_admins(user_id uuid PRIMARY KEY);
  CREATE FUNCTION public.is_super_admin() RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER AS $$ SELECT EXISTS(SELECT 1 FROM public.super_admins WHERE user_id = auth.uid()) $$;
  CREATE TABLE public.organizations(id uuid PRIMARY KEY, status text NOT NULL DEFAULT 'ACTIVE');
  CREATE TABLE public.permission_definitions(
    key text PRIMARY KEY, resource text NOT NULL, action text NOT NULL,
    sensitivity text NOT NULL CHECK (sensitivity IN ('VIEW','MANAGE','ELEVATED','PLATFORM')),
    permission_domain text NOT NULL DEFAULT 'TENANT' CHECK (permission_domain IN ('TENANT','PLATFORM')),
    scope_kinds text[] NOT NULL DEFAULT ARRAY['ORGANIZATION'], is_active boolean NOT NULL DEFAULT true,
    scope_match_mode text NOT NULL DEFAULT 'ANY_MATCH' CHECK (scope_match_mode = 'ANY_MATCH'),
    requires_cashbook_possession boolean NOT NULL DEFAULT false,
    accepted_possession_kinds text[] NOT NULL DEFAULT ARRAY[]::text[],
    required_dimensions text[] NOT NULL DEFAULT ARRAY[]::text[] CHECK (required_dimensions <@ ARRAY['BUILDING','CASHBOOK']),
    UNIQUE (resource, action),
    CHECK ((NOT requires_cashbook_possession AND cardinality(accepted_possession_kinds) = 0)
      OR (requires_cashbook_possession AND 'CASHBOOK' = ANY (scope_kinds) AND cardinality(accepted_possession_kinds) > 0)));
  CREATE TABLE public.organization_memberships(id uuid PRIMARY KEY, user_id uuid, organization_id uuid, status text DEFAULT 'ACTIVE',
    revoked_at timestamptz, valid_from timestamptz, valid_to timestamptz);
  CREATE TABLE app_private.tenant_emergency_denies(organization_id uuid, permission_key text, active_from timestamptz, expires_at timestamptz);
  CREATE TABLE public.member_permission_overrides(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid, membership_id uuid,
    permission_key text, effect text, revoked_at timestamptz, expires_at timestamptz);
  CREATE TABLE public.member_override_scopes(organization_id uuid, override_id uuid, scope_id uuid);
  CREATE TABLE public.authorization_scopes(id uuid PRIMARY KEY, organization_id uuid, scope_type text, building_id uuid, cashbook_id uuid, area_id uuid);
  CREATE TABLE public.organization_roles(id uuid PRIMARY KEY, organization_id uuid NOT NULL, name text NOT NULL, is_system boolean NOT NULL DEFAULT false,
    system_key text, status text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','RETIRED')), UNIQUE (organization_id, id),
    CHECK (system_key IS NULL OR (is_system AND system_key ~ '^[A-Z][A-Z0-9_]{2,63}$')));
  CREATE TABLE public.role_permissions(organization_id uuid NOT NULL, role_id uuid NOT NULL,
    permission_key text NOT NULL REFERENCES public.permission_definitions(key),
    effect text NOT NULL DEFAULT 'ALLOW' CHECK (effect IN ('ALLOW','DENY')),
    PRIMARY KEY (organization_id, role_id, permission_key),
    FOREIGN KEY (organization_id, role_id) REFERENCES public.organization_roles(organization_id, id) ON DELETE CASCADE);
  CREATE TABLE public.role_bindings(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid, membership_id uuid, role_id uuid, valid_from timestamptz, valid_to timestamptz);
  CREATE TABLE public.role_binding_scopes(organization_id uuid, role_binding_id uuid, scope_id uuid);
  CREATE TABLE public.area_buildings(organization_id uuid, area_id uuid, building_id uuid);
  CREATE TABLE public.cashbook_possession_bindings(organization_id uuid, membership_id uuid, cashbook_id uuid, possession_kind text, valid_from timestamptz, valid_to timestamptz);
  CREATE TABLE public.buildings(id uuid PRIMARY KEY, organization_id uuid, deleted_at timestamptz);
  CREATE TABLE public.accounts(id uuid PRIMARY KEY, organization_id uuid, deleted_at timestamptz);
  CREATE TABLE app_private.server_feature_flags(feature_key text PRIMARY KEY, domain text NOT NULL,
    risk_class text NOT NULL DEFAULT 'MONEY' CHECK (risk_class IN ('MONEY','NON_MONEY')),
    mode text NOT NULL DEFAULT 'OFF' CHECK (mode IN ('OFF','SHADOW','CANARY','ON')),
    force_freeze boolean NOT NULL DEFAULT false, config_version bigint NOT NULL DEFAULT 1, reason text, updated_by uuid,
    updated_at timestamptz NOT NULL DEFAULT now());
  CREATE FUNCTION app_private.evaluate_feature_route(p_feature_key text, p_organization_id uuid) RETURNS text LANGUAGE sql AS $$ SELECT 'LEGACY'::text $$;
  -- "Hôm nay" của công ty: test tự đặt qua test.today để ca ước tính không phụ thuộc đồng hồ.
  CREATE FUNCTION public.org_today_v1(p_organization_id uuid) RETURNS date LANGUAGE sql STABLE AS $$ SELECT COALESCE(nullif(current_setting('test.today', true), '')::date, DATE '2026-11-15') $$;
  CREATE TABLE public.shareholders(id uuid PRIMARY KEY, organization_id uuid NOT NULL REFERENCES public.organizations(id), auth_user_id uuid, name text NOT NULL, deleted_at timestamptz);
  CREATE UNIQUE INDEX shareholders_id_org_uq ON public.shareholders (id, organization_id);
  CREATE TABLE public.profit_managers(id uuid PRIMARY KEY, organization_id uuid NOT NULL REFERENCES public.organizations(id), auth_user_id uuid, name text NOT NULL, deleted_at timestamptz);
  CREATE TABLE public.profit_monthly(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL, building_id uuid NOT NULL, period_month date NOT NULL,
    status text NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT','LOCKED')), is_stale boolean NOT NULL DEFAULT true, UNIQUE (building_id, period_month));
  CREATE TABLE public.profit_allocations(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    profit_monthly_id uuid NOT NULL REFERENCES public.profit_monthly(id) ON DELETE CASCADE,
    shareholder_id uuid NOT NULL REFERENCES public.shareholders(id) ON DELETE CASCADE,
    amount numeric(15,2) NOT NULL DEFAULT 0, organization_id uuid, UNIQUE (profit_monthly_id, shareholder_id));
  CREATE TABLE public.profit_manager_allocations(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    profit_monthly_id uuid NOT NULL REFERENCES public.profit_monthly(id) ON DELETE CASCADE,
    manager_id uuid NOT NULL REFERENCES public.profit_managers(id) ON DELETE CASCADE,
    amount numeric(15,2) NOT NULL DEFAULT 0, organization_id uuid, UNIQUE (profit_monthly_id, manager_id));
  CREATE TABLE public.income_expenses(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL,
    type text NOT NULL CHECK (type IN ('INCOME','EXPENSE')),
    approval_status text NOT NULL DEFAULT 'APPROVED' CHECK (approval_status IN ('UNAPPROVED','APPROVED','CANCELLED')),
    deleted_at timestamptz, shareholder_id uuid REFERENCES public.shareholders(id) ON DELETE SET NULL,
    profit_manager_id uuid REFERENCES public.profit_managers(id) ON DELETE SET NULL,
    total_amount numeric(15,2) NOT NULL DEFAULT 0, account_id uuid, created_at timestamptz NOT NULL DEFAULT now());
  CREATE TABLE public.approval_requests(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL, submission_no integer NOT NULL DEFAULT 1,
    subject_type text NOT NULL, subject_id uuid NOT NULL,
    state text NOT NULL CHECK (state IN ('PENDING_APPROVAL','POSTED','DENIED','REJECTED','CANCELLED','REVERSED','APPROVED','WITHDRAWN','CHANGES_REQUESTED','DISPUTED')),
    UNIQUE (organization_id, subject_type, subject_id, submission_no));
`;

function duLieuQuyen(): string {
  // [vai, công ty, tên, system_key, trạng thái]
  const vai: [string, string, string, string | null, string][] = [
    [VAI_CHU_TU_TAO, ORG_A, "Chủ công ty", null, "ACTIVE"],
    [VAI_CHU_HE_THONG, ORG_A, "Chủ sở hữu tổ chức", "TENANT_OWNER", "ACTIVE"],
    [VAI_QUAN_LY, ORG_A, "Quản Lý Tòa", null, "ACTIVE"],
    [VAI_PARTNER, ORG_A, "Partner", null, "ACTIVE"],
    // Vai HỆ THỐNG khác khoá nhưng trùng tên vai chủ: không phải vai chủ.
    [VAI_HE_THONG_KHAC, ORG_A, "Chủ công ty", "TENANT_STAFF", "ACTIVE"],
    // Vai chủ tự tạo đã nghỉ: vẫn được gieo (mẫu không lọc trạng thái) nhưng không cấp quyền cho ai.
    [VAI_CHU_DA_NGHI, ORG_A, "Chủ công ty", null, "RETIRED"],
    [VAI_CHU_B, ORG_B, "Chủ công ty", "TENANT_OWNER", "ACTIVE"],
    [VAI_TEN_GAN_GIONG, ORG_A, "chủ công ty", null, "ACTIVE"],
    // Vai tự tạo mang tên còn lại trong hai tên vai chủ.
    [VAI_CHU_SO_HUU_TU_TAO, ORG_B, "Chủ sở hữu tổ chức", null, "ACTIVE"],
  ];
  const gan: [string, string, string, string][] = [
    [ORG_A, CHU, VAI_CHU_TU_TAO, PHAM_VI_A], [ORG_A, CHU_HE_THONG, VAI_CHU_HE_THONG, PHAM_VI_A],
    [ORG_A, QUAN_LY, VAI_QUAN_LY, PHAM_VI_A], [ORG_A, PARTNER, VAI_PARTNER, PHAM_VI_A],
    [ORG_A, VAI_NGHI, VAI_CHU_DA_NGHI, PHAM_VI_A], [ORG_A, HE_THONG_KHAC, VAI_HE_THONG_KHAC, PHAM_VI_A],
    [ORG_A, DA_GO, VAI_TEN_GAN_GIONG, PHAM_VI_A], [ORG_B, NGOAI, VAI_CHU_B, PHAM_VI_B],
  ];
  const thanhVien = [CHU, CHU_HE_THONG, QUAN_LY, PARTNER, TAM_UNG, DA_GO, DENY_GO_ALLOW_SONG, VAI_NGHI, HE_THONG_KHAC]
    .map((u) => `('${mem(u)}','${u}','${ORG_A}')`).concat(`('${mem(NGOAI)}','${NGOAI}','${ORG_B}')`).join(",");
  return `
    INSERT INTO public.organizations(id) VALUES ('${ORG_A}'),('${ORG_B}');
    INSERT INTO public.super_admins VALUES ('${SUPER}');
    INSERT INTO public.permission_definitions(key, resource, action, sensitivity) VALUES
      ('shareholder_profit.distribute','shareholder_profit','distribute','ELEVATED'),
      ('income_expenses.view','income_expenses','view','VIEW');
    INSERT INTO public.organization_memberships(id, user_id, organization_id) VALUES ${thanhVien};
    INSERT INTO public.authorization_scopes(id, organization_id, scope_type) VALUES ('${PHAM_VI_A}','${ORG_A}','ORGANIZATION'),('${PHAM_VI_B}','${ORG_B}','ORGANIZATION');
    INSERT INTO public.organization_roles(id, organization_id, name, is_system, system_key, status) VALUES
      ${vai.map(([r, o, ten, khoa, tt]) => `('${r}','${o}','${ten}',${khoa ? "true" : "false"},${khoa ? `'${khoa}'` : "NULL"},'${tt}')`).join(",")};
    INSERT INTO public.role_permissions(organization_id, role_id, permission_key) VALUES
      ('${ORG_A}','${VAI_QUAN_LY}','income_expenses.view'), ('${ORG_A}','${VAI_CHU_TU_TAO}','shareholder_profit.distribute');
    ${gan.map(([o, u, r, s], i) => `
      INSERT INTO public.role_bindings(id, organization_id, membership_id, role_id) VALUES ('${id(100 + i)}','${o}','${mem(u)}','${r}');
      INSERT INTO public.role_binding_scopes VALUES ('${o}','${id(100 + i)}','${s}');`).join("")}
  `;
}

/** Ngoại lệ thành viên trên khoá MỚI — chèn sau migration, kèm cạnh phạm vi ORGANIZATION như màn Thành viên làm. */
function duLieuNgoaiLe(): string {
  // [người, khoá, effect, đã thu hồi?]
  const ngoaiLe: [string, string, string, boolean][] = [
    [TAM_UNG, K_TAM_UNG, "ALLOW", false],
    [DA_GO, K_TAM_UNG, "ALLOW", true],
    [DENY_GO_ALLOW_SONG, K_XEM_PT, "DENY", true],
    [DENY_GO_ALLOW_SONG, K_XEM_PT, "ALLOW", false],
  ];
  return ngoaiLe.map(([u, k, e, thuHoi], i) => `
    INSERT INTO public.member_permission_overrides(id, organization_id, membership_id, permission_key, effect, revoked_at)
      VALUES ('${id(200 + i)}','${ORG_A}','${mem(u)}','${k}','${e}', ${thuHoi ? "now() - interval '1 day'" : "NULL"});
    INSERT INTO public.member_override_scopes VALUES ('${ORG_A}','${id(200 + i)}','${PHAM_VI_A}');`).join("");
}

function duLieuSo(): string {
  return `
    INSERT INTO public.shareholders(id, organization_id, name, deleted_at) VALUES
      ('${CD1}','${ORG_A}','Cổ đông 1',NULL), ('${CD2}','${ORG_A}','Cổ đông 2',NULL),
      ('${CD_XOA}','${ORG_A}','Cổ đông đã xoá', now()), ('${CD_B}','${ORG_B}','Cổ đông công ty B',NULL);
    INSERT INTO public.profit_managers(id, organization_id, name) VALUES ('${QL1}','${ORG_A}','Quản lý 1'), ('${QL2}','${ORG_A}','Quản lý 2');
    INSERT INTO public.profit_monthly(id, organization_id, building_id, period_month, status, is_stale) VALUES
      ('${PM_07}','${ORG_A}','${TOA_1}','2026-07-01','LOCKED',false),
      ('${PM_08_STALE}','${ORG_A}','${TOA_1}','2026-08-01','LOCKED',true),
      ('${PM_08_AM}','${ORG_A}','${TOA_2}','2026-08-01','LOCKED',false),
      ('${PM_09_NHAP}','${ORG_A}','${TOA_1}','2026-09-01','DRAFT',true),
      ('${PM_09}','${ORG_A}','${TOA_2}','2026-09-01','LOCKED',false),
      ('${PM_B}','${ORG_B}','${TOA_B}','2026-08-01','LOCKED',false),
      -- Công ty B đã chốt tới tháng 10: không được làm "tháng chốt gần nhất" của công ty A.
      ('${PM_B_10}','${ORG_B}','${TOA_B}','2026-10-01','LOCKED',false);
    -- CD1: 100 + 40 (stale) − 15.5 (âm) + 30 (cột organization_id NULL) = 154.5; dòng nháp 999 và dòng thuộc kỳ của công ty B (7777) không tính.
    INSERT INTO public.profit_allocations(profit_monthly_id, shareholder_id, amount, organization_id) VALUES
      ('${PM_07}','${CD1}',100,'${ORG_A}'), ('${PM_08_STALE}','${CD1}',40,'${ORG_A}'), ('${PM_08_AM}','${CD1}',-15.5,'${ORG_A}'),
      ('${PM_09_NHAP}','${CD1}',999,'${ORG_A}'), ('${PM_09}','${CD1}',30,NULL), ('${PM_B}','${CD1}',7777,'${ORG_A}'),
      ('${PM_07}','${CD2}',50,'${ORG_A}'), ('${PM_09}','${CD2}',20,'${ORG_A}'),
      ('${PM_B}','${CD_B}',300,'${ORG_B}');
    -- QL1: 10 + 5 (stale) + 3 = 18; dòng nháp 500 không tính.
    INSERT INTO public.profit_manager_allocations(profit_monthly_id, manager_id, amount, organization_id) VALUES
      ('${PM_07}','${QL1}',10,'${ORG_A}'), ('${PM_08_STALE}','${QL1}',5,NULL), ('${PM_09_NHAP}','${QL1}',500,'${ORG_A}'), ('${PM_09}','${QL1}',3,'${ORG_A}');
  `;
}

type Loai = "SHAREHOLDER" | "MANAGER";
/** Khoá ngoại ON DELETE RESTRICT: PostgreSQL ≤ 17 báo 23503, từ 18 báo 23001 — production và PGlite khác bản. */
const MA_CHAN_XOA = ["23503", "23001"];
interface SoDu {
  allocated: number; payouts_approved: number; payouts_pending: number; salary_investment: number; salary_advance_offset: number;
  balance: number; marker: { id: string; settled_through_month: string | null; ledger_seq: number; created_at: string } | null;
  excluded_before_marker: { allocated: number; payouts: number; salary: number };
  needs_review: { count: number; suggested: number };
}

const db = new PGlite();
const ghi: Record<string, unknown> = {};

async function trongGiaoDich<T>(fn: () => Promise<T>): Promise<T> {
  await db.exec("BEGIN");
  try { return await fn(); } finally { await db.exec("ROLLBACK"); }
}
const mot = async <T>(sql: string, params: unknown[] = []) => (await db.query<{ v: T }>(sql, params)).rows[0].v;
const soDu = (loai: Loai, chuThe: string, them = "", org = ORG_A) =>
  mot<SoDu>(`SELECT app_private.profit_ledger_balance_v1('${org}','${loai}','${chuThe}'${them}) AS v`);
const conSong = (phieu: string | null) =>
  mot<boolean>(`SELECT app_private.profit_ledger_voucher_live_v1(${phieu ? `'${phieu}'` : "NULL"}) AS v`);
/** Quyền của một người theo helper thật (gói 1A) — đo trong giao dịch riêng với auth.uid() = user. */
const coQuyen = (user: string | null, khoa: string, org = ORG_A) => trongGiaoDich(async () => {
  await db.query("SELECT set_config('request.jwt.claim.sub', $1, true)", [user ?? ""]);
  return mot<boolean>(`SELECT app_private.profit_viewer_can_v1('${org}','${khoa}') AS v`);
});

interface Phieu {
  id: string; soTien: number; coDong?: string; quanLy?: string; trangThai?: "UNAPPROVED" | "APPROVED" | "CANCELLED";
  loai?: "EXPENSE" | "INCOME"; daXoa?: boolean; taoLuc?: string; org?: string;
}
async function taoPhieu(p: Phieu) {
  await db.exec(`INSERT INTO public.income_expenses(id, organization_id, type, approval_status, deleted_at, shareholder_id, profit_manager_id, total_amount, account_id, created_at)
    VALUES ('${p.id}','${p.org ?? ORG_A}','${p.loai ?? "EXPENSE"}','${p.trangThai ?? "APPROVED"}', ${p.daXoa ? "now()" : "NULL"},
      ${p.coDong ? `'${p.coDong}'` : "NULL"}, ${p.quanLy ? `'${p.quanLy}'` : "NULL"}, ${p.soTien}, '${SO_QUY}', ${p.taoLuc ?? "now()"})`);
}
async function taoYeuCau(phieu: string, trangThai: string, lan = 1, o: { org?: string; loai?: string } = {}) {
  await db.exec(`INSERT INTO public.approval_requests(organization_id, submission_no, subject_type, subject_id, state)
    VALUES ('${o.org ?? ORG_A}', ${lan}, '${o.loai ?? "FINANCIAL_VOUCHER"}', '${phieu}', '${trangThai}')`);
}
const cot = (loai: Loai, chuThe: string) => loai === "SHAREHOLDER" ? `'${chuThe}', NULL` : `NULL, '${chuThe}'`;
/** Dòng profit_ledger_payouts theo ĐÚNG nghi thức của lệnh lập: ngữ cảnh CREATE → khoá sổ → nextval → chèn → xoá ngữ cảnh. */
async function ghiDongPhieu(phieu: string, loai: Loai, chuThe: string, soTien: number, o: { tamUng?: number; them?: string; giaTri?: string } = {}) {
  const tamUng = o.tamUng ?? 0;
  await db.exec(`
    INSERT INTO app_private.profit_ledger_write_contexts(income_expense_id, purpose) VALUES ('${phieu}', 'CREATE');
    SELECT app_private.profit_ledger_lock_v1('${ORG_A}', '${loai}', '${chuThe}');
    INSERT INTO app_private.profit_ledger_payouts(voucher_id, organization_id, subject_kind, shareholder_id, manager_id, account_id, amount,
      balance_before, within_amount, advance_amount, maker_user_id, maker_membership_id, maker_kind, payee_is_maker, payee_user_id, ledger_seq${o.them ? `, ${o.them}` : ""})
    VALUES ('${phieu}','${ORG_A}','${loai}', ${cot(loai, chuThe)}, '${SO_QUY}', ${soTien}, 0, ${soTien - tamUng}, ${tamUng},
      '${CHU}','${mem(CHU)}','OWNER', false, NULL, nextval('app_private.profit_ledger_seq')${o.giaTri ? `, ${o.giaTri}` : ""});
    DELETE FROM app_private.profit_ledger_write_contexts WHERE income_expense_id = '${phieu}';
  `);
}
/** Đặt mốc theo đúng nghi thức: khoá sổ → nextval → chèn. thang = null là gỡ mốc. Trả id dòng mốc. */
async function datMoc(loai: Loai, chuThe: string, thang: string | null, de: string | null = null): Promise<string> {
  await db.exec(`SELECT app_private.profit_ledger_lock_v1('${ORG_A}', '${loai}', '${chuThe}')`);
  return mot<string>(`INSERT INTO app_private.profit_ledger_markers(organization_id, subject_kind, shareholder_id, manager_id, settled_through_month, reason, supersedes_id, ledger_seq, created_by)
    VALUES ('${ORG_A}','${loai}', ${cot(loai, chuThe)}, ${thang ? `'${thang}'` : "NULL"}, 'Lý do đặt mốc đủ dài', ${de ? `'${de}'` : "NULL"},
      nextval('app_private.profit_ledger_seq'), '${CHU}') RETURNING id AS v`);
}
interface DongLuong { phieuLuong?: string | null; thang: string; y: number; d?: number; trangThai: "QUOTED" | "LINKED" | "NEEDS_REVIEW"; goiY?: number; coDong?: string; nhanVien?: string }
async function taoDongLuong(o: DongLuong): Promise<string> {
  const quoted = o.trangThai === "QUOTED";
  return mot<string>(`INSERT INTO app_private.profit_ledger_salary_settlement_vouchers(organization_id, shareholder_id, staff_id, period_month, salary_voucher_id,
      payout_request_key, investment_amount, advance_offset_amount, suggested_investment, sheet_status_at_quote, source, state, linked_at)
    VALUES ('${ORG_A}','${o.coDong ?? CD1}','${o.nhanVien ?? CHU}','${o.thang}', ${o.phieuLuong ? `'${o.phieuLuong}'` : "NULL"},
      ${quoted ? "'khoa-tra-luong-0001'" : "NULL"}, ${o.y}, ${o.d ?? 0}, ${o.goiY ?? "NULL"}, 'DRAFT', '${quoted ? "UI_QUOTE" : "PAYOUT_FALLBACK"}', '${o.trangThai}',
      ${o.trangThai === "LINKED" ? "clock_timestamp()" : "NULL"}) RETURNING id AS v`);
}
async function taoDongBang(o: { thang: string; y: number; d: number; coDong?: string }): Promise<string> {
  return mot<string>(`INSERT INTO app_private.profit_ledger_salary_settlements(organization_id, shareholder_id, staff_id, period_month, investment_month, advance_offset_month)
    VALUES ('${ORG_A}','${o.coDong ?? CD1}','${CHU}','${o.thang}', ${o.y}, ${o.d}) RETURNING id AS v`);
}
/** Chạy một câu trong SAVEPOINT; trả mã lỗi (hoặc null nếu chạy được) mà không làm hỏng giao dịch của ca. */
async function maLoi(sql: string): Promise<string | null> {
  await db.exec("SAVEPOINT thu");
  try { await db.exec(sql); await db.exec("RELEASE SAVEPOINT thu"); return null; } catch (e) {
    await db.exec("ROLLBACK TO SAVEPOINT thu");
    return (e as { code?: string }).code ?? "?";
  }
}
async function thongBaoLoi(sql: string): Promise<string> {
  await db.exec("SAVEPOINT thu");
  try { await db.exec(sql); await db.exec("RELEASE SAVEPOINT thu"); return ""; } catch (e) {
    await db.exec("ROLLBACK TO SAVEPOINT thu");
    return `${(e as { code?: string }).code}: ${(e as Error).message}`;
  }
}
const quyenVai = async (khoa: string) => (await db.query<{ role_id: string }>(
  "SELECT role_id FROM public.role_permissions WHERE permission_key = $1 AND effect = 'ALLOW' ORDER BY role_id", [khoa])).rows.map((r) => r.role_id);

beforeAll(async () => {
  await db.exec(NEN);
  await db.exec(SCOPE_V3);
  await db.exec(HELPER_QUYEN);
  await db.exec(duLieuQuyen());
  await db.exec(duLieuSo());

  await db.exec(MIGRATION);
  ghi.cheDoLuot1 = await mot<string>(`SELECT mode AS v FROM app_private.server_feature_flags WHERE feature_key = '${CO}'`);
  ghi.soQuyenLuot1 = await mot<number>("SELECT count(*)::int AS v FROM public.role_permissions");
  await db.exec(`UPDATE app_private.server_feature_flags SET mode = 'SHADOW' WHERE feature_key = '${CO}'`);
  await db.exec(MIGRATION);
  ghi.cheDoLuot2 = await mot<string>(`SELECT mode AS v FROM app_private.server_feature_flags WHERE feature_key = '${CO}'`);
  ghi.soQuyenLuot2 = await mot<number>("SELECT count(*)::int AS v FROM public.role_permissions");

  await db.exec(duLieuNgoaiLe());
}, 120000);
afterAll(() => db.close());

describe("ba khoá quyền mới và công tắc", () => {
  it("đủ ba khoá, đúng hình dạng của họ shareholder_profit.* (phạm vi ORGANIZATION, không chiều, không giữ sổ)", async () => {
    const r = (await db.query<Record<string, unknown>>(
      "SELECT key, resource, action, sensitivity, permission_domain, scope_kinds, is_active, scope_match_mode, requires_cashbook_possession, accepted_possession_kinds, required_dimensions FROM public.permission_definitions WHERE key = ANY($1) ORDER BY key",
      [[K_TAM_UNG, K_XEM_PT, K_XEM_TOA]])).rows;
    const chung = { resource: "shareholder_profit", permission_domain: "TENANT", scope_kinds: ["ORGANIZATION"], is_active: true,
      scope_match_mode: "ANY_MATCH", requires_cashbook_possession: false, accepted_possession_kinds: [], required_dimensions: [] };
    expect(r).toEqual([
      { ...chung, key: K_TAM_UNG, action: "advance_own_cashbook", sensitivity: "ELEVATED" },
      { ...chung, key: K_XEM_TOA, action: "view_building_totals", sensitivity: "MANAGE" },
      { ...chung, key: K_XEM_PT, action: "view_percent", sensitivity: "MANAGE" },
    ]);
  });
  it("hai quyền xem chỉ gieo cho vai chủ: TENANT_OWNER, hoặc vai tự tạo đúng tên 'Chủ công ty' / 'Chủ sở hữu tổ chức'", async () => {
    const mongDoi = [VAI_CHU_TU_TAO, VAI_CHU_HE_THONG, VAI_CHU_DA_NGHI, VAI_CHU_B, VAI_CHU_SO_HUU_TU_TAO].sort();
    expect(await quyenVai(K_XEM_PT)).toEqual(mongDoi);
    expect(await quyenVai(K_XEM_TOA)).toEqual(mongDoi);
  });
  it("vai Quản Lý Tòa, Partner, vai hệ thống khác trùng tên, vai tên gần giống: không có quyền xem", async () => {
    const co = new Set([...(await quyenVai(K_XEM_PT)), ...(await quyenVai(K_XEM_TOA))]);
    for (const v of [VAI_QUAN_LY, VAI_PARTNER, VAI_HE_THONG_KHAC, VAI_TEN_GAN_GIONG]) expect(co.has(v)).toBe(false);
  });
  it("không vai nào được gieo quyền tạm ứng từ sổ mình giữ", async () => {
    expect(await mot<number>(`SELECT count(*)::int AS v FROM public.role_permissions WHERE permission_key = '${K_TAM_UNG}'`)).toBe(0);
  });
  it("quyền hiệu lực theo helper thật: chủ (vai tự tạo và vai hệ thống) xem được; quản lý, partner, vai đã nghỉ, công ty khác thì không", async () => {
    for (const k of [K_XEM_PT, K_XEM_TOA]) {
      expect(await coQuyen(CHU, k)).toBe(true);
      expect(await coQuyen(CHU_HE_THONG, k)).toBe(true);
      expect(await coQuyen(QUAN_LY, k)).toBe(false);
      expect(await coQuyen(PARTNER, k)).toBe(false);
      expect(await coQuyen(HE_THONG_KHAC, k)).toBe(false);
      expect(await coQuyen(VAI_NGHI, k)).toBe(false);
      expect(await coQuyen(NGOAI, k)).toBe(false);
      expect(await coQuyen(NGOAI, k, ORG_B)).toBe(true);
      expect(await coQuyen(null, k)).toBe(false);
    }
  });
  it("quyền tạm ứng chỉ có khi chủ cấp ngoại lệ còn sống; ngoại lệ đã thu hồi thì mất; chủ công ty cũng không tự có", async () => {
    expect(await coQuyen(TAM_UNG, K_TAM_UNG)).toBe(true);
    expect(await coQuyen(DA_GO, K_TAM_UNG)).toBe(false);
    expect(await coQuyen(CHU, K_TAM_UNG)).toBe(false);
    expect(await coQuyen(CHU_HE_THONG, K_TAM_UNG)).toBe(false);
    expect(await coQuyen(SUPER, K_TAM_UNG)).toBe(true);
  });
  it("DENY đã thu hồi + ALLOW còn sống ⇒ có quyền", async () => {
    expect(await coQuyen(DENY_GO_ALLOW_SONG, K_XEM_PT)).toBe(true);
    expect(await coQuyen(DENY_GO_ALLOW_SONG, K_XEM_TOA)).toBe(false);
  });
  it("chạy lại M1 trên dữ liệu đã có (giao dịch khác): chủ đã gỡ view_percent khỏi vai chủ ⇒ KHÔNG gieo lại; hình dạng / trạng thái khoá đã đổi không bị ghi đè; không lỗi", async () => {
    await trongGiaoDich(async () => {
      await db.exec(`DELETE FROM public.role_permissions WHERE permission_key = '${K_XEM_PT}';
        UPDATE public.permission_definitions SET sensitivity = 'ELEVATED' WHERE key = '${K_XEM_TOA}';
        UPDATE public.permission_definitions SET is_active = false WHERE key = '${K_TAM_UNG}';
        INSERT INTO public.role_permissions(organization_id, role_id, permission_key) VALUES ('${ORG_A}','${VAI_QUAN_LY}','${K_TAM_UNG}');`);
      await db.exec(THAN);
      expect(await quyenVai(K_XEM_PT)).toEqual([]);
      expect(await quyenVai(K_XEM_TOA)).toEqual([VAI_CHU_TU_TAO, VAI_CHU_HE_THONG, VAI_CHU_DA_NGHI, VAI_CHU_B, VAI_CHU_SO_HUU_TU_TAO].sort());
      expect(await quyenVai(K_TAM_UNG)).toEqual([VAI_QUAN_LY]);
      expect((await db.query("SELECT key, sensitivity, is_active FROM public.permission_definitions WHERE key = ANY($1) ORDER BY key",
        [[K_TAM_UNG, K_XEM_PT, K_XEM_TOA]])).rows).toEqual([
        { key: K_TAM_UNG, sensitivity: "ELEVATED", is_active: false },
        { key: K_XEM_TOA, sensitivity: "ELEVATED", is_active: true },
        { key: K_XEM_PT, sensitivity: "MANAGE", is_active: true },
      ]);
    });
  });
  it("công tắc sinh ra ở OFF; lượt chạy lại KHÔNG đặt lại chế độ; quyền không bị gieo trùng", async () => {
    expect(ghi.cheDoLuot1).toBe("OFF");
    expect(ghi.cheDoLuot2).toBe("SHADOW");
    expect(ghi.soQuyenLuot2).toBe(ghi.soQuyenLuot1);
    const co = (await db.query<{ domain: string; risk_class: string }>(
      `SELECT domain, risk_class FROM app_private.server_feature_flags WHERE feature_key = '${CO}'`)).rows;
    expect(co).toEqual([{ domain: "profit", risk_class: "MONEY" }]);
  });
});

describe("bảng và hàm: không ai ngoài chủ bảng chạm được", () => {
  it("sáu bảng bật RLS, không policy, không ACL cho vai nào; sequence cũng vậy", async () => {
    const r = (await db.query<{ ten: string; rls: boolean; policy: number; acl_la: number }>(`
      SELECT c.oid::regclass::text AS ten, c.relrowsecurity AS rls,
             (SELECT count(*)::int FROM pg_policy p WHERE p.polrelid = c.oid) AS policy,
             (SELECT count(*)::int FROM aclexplode(c.relacl) a WHERE a.grantee <> c.relowner) AS acl_la
        FROM pg_class c WHERE c.oid = ANY($1::regclass[]) ORDER BY 1`, [[...BANG, "app_private.profit_ledger_seq"]])).rows;
    expect(r).toHaveLength(7);
    for (const b of r) expect(b).toMatchObject({ policy: 0, acl_la: 0 });
    for (const b of r.filter((x) => x.ten !== "app_private.profit_ledger_seq")) expect(b.rls).toBe(true);
  });
  it("authenticated / anon / service_role không đọc, không ghi được bảng nào kể cả khi có USAGE trên schema", async () => {
    for (const vai of ["authenticated", "anon", "service_role"]) {
      await trongGiaoDich(async () => {
        await db.exec(`GRANT USAGE ON SCHEMA app_private TO ${vai}; SET LOCAL ROLE ${vai}`);
        for (const b of BANG) {
          expect(await maLoi(`SELECT 1 FROM ${b} LIMIT 1`)).toBe("42501");
          expect(await maLoi(`DELETE FROM ${b}`)).toBe("42501");
        }
        expect(await maLoi("SELECT nextval('app_private.profit_ledger_seq')")).toBe("42501");
      });
    }
  });
  it("mọi hàm: ghim search_path, không EXECUTE cho PUBLIC hay vai nào; gọi bằng authenticated bị 42501", async () => {
    const r = (await db.query<{ ten: string; cfg: string[] | null; acl_la: number; acl_null: boolean }>(`
      SELECT p.oid::regprocedure::text AS ten, p.proconfig AS cfg, p.proacl IS NULL AS acl_null,
             (SELECT count(*)::int FROM aclexplode(p.proacl) a WHERE a.grantee <> p.proowner) AS acl_la
        FROM pg_proc p WHERE p.oid = ANY($1::regprocedure[])`, [HAM])).rows;
    expect(r).toHaveLength(HAM.length);
    for (const f of r) {
      expect(f.acl_null, f.ten).toBe(false);
      expect(f.acl_la, f.ten).toBe(0);
      expect((f.cfg ?? []).some((c) => c.startsWith("search_path=")), f.ten).toBe(true);
    }
    await trongGiaoDich(async () => {
      await db.exec("GRANT USAGE ON SCHEMA app_private TO authenticated; SET LOCAL ROLE authenticated");
      expect(await maLoi(`SELECT app_private.profit_ledger_balance_v1('${ORG_A}','SHAREHOLDER','${CD1}')`)).toBe("42501");
      expect(await maLoi(`SELECT app_private.profit_ledger_voucher_live_v1('${CD1}')`)).toBe("42501");
      expect(await maLoi(`SELECT app_private.profit_ledger_lock_v1('${ORG_A}','SHAREHOLDER','${CD1}')`)).toBe("42501");
      expect(await maLoi(`SELECT app_private.profit_ledger_open_estimate_v1('${ORG_A}','${CD1}')`)).toBe("42501");
    });
  });
  it("hàm đọc là STABLE + DEFINER (gọi được trong giao dịch chỉ đọc); hàm giữ khoá là VOLATILE", async () => {
    const r = (await db.query<{ ten: string; v: string; d: boolean }>(
      "SELECT p.proname AS ten, p.provolatile AS v, p.prosecdef AS d FROM pg_proc p WHERE p.oid = ANY($1::regprocedure[])", [HAM])).rows;
    const theo = Object.fromEntries(r.map((x) => [x.ten, x]));
    for (const ten of ["profit_ledger_voucher_live_v1", "profit_ledger_active_marker_v1", "profit_ledger_balance_v1", "profit_ledger_balance_core_v1", "profit_ledger_open_estimate_v1", "profit_ledger_write_context_v1"]) {
      expect(theo[ten], ten).toMatchObject({ v: "s", d: true });
    }
    expect(theo.profit_ledger_lock_v1).toMatchObject({ v: "v", d: true });
    await db.exec("BEGIN READ ONLY");
    try {
      expect((await soDu("SHAREHOLDER", CD1)).balance).toBe(CD1_GOC);
      expect(await mot<number>(`SELECT app_private.profit_ledger_open_estimate_v1('${ORG_A}','${CD1}') AS v`)).not.toBeNull();
    } finally { await db.exec("ROLLBACK"); }
  });
  it("không hàm nào của sổ mang mẫu khoá dòng mà gate stable-fn-locks dò (RPC đọc STABLE sẽ gọi các hàm này)", async () => {
    // Cùng hai biểu thức hạt giống và cách bỏ chú thích của scripts/check-stable-fn-locks.mjs: một hàm khớp hạt giống,
    // hoặc gọi tên một hàm khớp hạt giống, sẽ kéo mọi RPC STABLE gọi nó vào diện đỏ (25006 qua PostgREST).
    const r = (await db.query<{ nm: string }>(String.raw`
      WITH fns AS (
        SELECT p.proname AS nm,
               regexp_replace(regexp_replace(pg_get_functiondef(p.oid), '/\*.*?\*/', ' ', 'gs'), '--[^' || chr(10) || ']*', ' ', 'g') AS def
          FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE p.prokind IN ('f', 'p') AND n.nspname IN ('public', 'app_private')),
      seed AS (
        SELECT nm FROM fns
         WHERE def ~* '\mfor\s+(share|update|no key update|key share)\M' OR def ~* '\mlock\s+(table\s+)?[a-z_.]')
      SELECT f.nm FROM fns f
       WHERE f.nm LIKE '%profit_ledger%'
         AND (f.nm IN (SELECT nm FROM seed) OR EXISTS (SELECT 1 FROM seed s WHERE f.def ~ ('\m' || s.nm || '\s*\(')))`)).rows;
    expect(r).toEqual([]);
    expect(await mot<number>("SELECT count(*)::int AS v FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'app_private' AND p.proname LIKE '%profit_ledger%'")).toBe(HAM.length);
  });
  it("lượt chạy lại không nhân đôi trigger; profit_managers có unique (id, organization_id)", async () => {
    const r = (await db.query<{ ten: string; n: number }>(`
      SELECT c.relname AS ten, count(*)::int AS n FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
       WHERE NOT t.tgisinternal AND c.oid = ANY($1::regclass[]) GROUP BY 1`, [BANG])).rows;
    expect(Object.fromEntries(r.map((x) => [x.ten, x.n]))).toEqual({
      profit_ledger_markers: 3, profit_ledger_payouts: 3, profit_ledger_salary_settlements: 3,
      profit_ledger_salary_settlement_vouchers: 3, profit_ledger_events: 2, profit_ledger_write_contexts: 1,
    });
    expect(await mot<boolean>("SELECT (i.indisunique AND i.indisvalid) AS v FROM pg_index i WHERE i.indexrelid = 'public.profit_managers_id_org_uq'::regclass")).toBe(true);
  });
});

describe("phiếu còn sống (profit_ledger_voucher_live_v1)", () => {
  const P = id(1001);
  // [mô tả, trạng thái phiếu, các yêu cầu duyệt theo thứ tự lần gửi, kết quả]
  const ca: [string, Phieu["trangThai"], string[], boolean][] = [
    ["đã duyệt, không có yêu cầu", "APPROVED", [], true],
    ["đã duyệt dù yêu cầu mới nhất REJECTED", "APPROVED", ["REJECTED"], true],
    ["chưa duyệt, không có yêu cầu", "UNAPPROVED", [], true],
    ["chưa duyệt, đang chờ duyệt", "UNAPPROVED", ["PENDING_APPROVAL"], true],
    ["chưa duyệt, yêu cầu sửa", "UNAPPROVED", ["CHANGES_REQUESTED"], true],
    ["chưa duyệt, đang tranh chấp", "UNAPPROVED", ["DISPUTED"], true],
    ["chưa duyệt, yêu cầu ở APPROVED (vừa huỷ duyệt)", "UNAPPROVED", ["APPROVED"], true],
    ["chưa duyệt, yêu cầu ở POSTED", "UNAPPROVED", ["POSTED"], true],
    ["chưa duyệt, bị từ chối", "UNAPPROVED", ["REJECTED"], false],
    ["chưa duyệt, luật DENY", "UNAPPROVED", ["DENIED"], false],
    ["chưa duyệt, người lập rút yêu cầu", "UNAPPROVED", ["CANCELLED"], false],
    ["chưa duyệt, WITHDRAWN", "UNAPPROVED", ["WITHDRAWN"], false],
    ["chưa duyệt, REVERSED", "UNAPPROVED", ["REVERSED"], false],
    ["bị từ chối rồi gửi lại: lần mới nhất quyết định", "UNAPPROVED", ["REJECTED", "PENDING_APPROVAL"], true],
    ["đang chờ rồi bị rút: lần mới nhất quyết định", "UNAPPROVED", ["PENDING_APPROVAL", "CANCELLED"], false],
    ["phiếu đã huỷ", "CANCELLED", ["PENDING_APPROVAL"], false],
  ];
  it.each(ca)("%s", async (_ten, trangThai, yeuCau, mongDoi) => {
    await trongGiaoDich(async () => {
      await taoPhieu({ id: P, soTien: 10, coDong: CD1, trangThai });
      for (const [i, s] of yeuCau.entries()) await taoYeuCau(P, s, i + 1);
      expect(await conSong(P)).toBe(mongDoi);
    });
  });
  it("phiếu đã xoá, phiếu THU, id không tồn tại, id NULL ⇒ không sống", async () => {
    await trongGiaoDich(async () => {
      await taoPhieu({ id: P, soTien: 10, coDong: CD1, daXoa: true });
      await taoPhieu({ id: id(1002), soTien: 10, coDong: CD1, loai: "INCOME" });
      expect(await conSong(P)).toBe(false);
      expect(await conSong(id(1002))).toBe(false);
      expect(await conSong(id(1003))).toBe(false);
      expect(await conSong(null)).toBe(false);
    });
  });
  it("chỉ xét yêu cầu duyệt của ĐÚNG phiếu, đúng loại FINANCIAL_VOUCHER, đúng công ty", async () => {
    await trongGiaoDich(async () => {
      await taoPhieu({ id: P, soTien: 10, coDong: CD1, trangThai: "UNAPPROVED" });
      await taoYeuCau(P, "REJECTED", 1, { loai: "LOAI_KHAC" });
      await taoYeuCau(P, "REJECTED", 2, { org: ORG_B });
      await taoYeuCau(id(1002), "REJECTED");
      expect(await conSong(P)).toBe(true);
    });
  });
});

describe("số dư: phân bổ các tháng đã chốt", () => {
  it("cộng dòng LOCKED kể cả stale và âm; dòng DRAFT và dòng thuộc kỳ của công ty khác không cộng; chưa có gì khác thì các phần còn lại bằng 0", async () => {
    expect(await soDu("SHAREHOLDER", CD1)).toEqual({
      allocated: CD1_GOC, payouts_approved: 0, payouts_pending: 0, salary_investment: 0, salary_advance_offset: 0,
      balance: CD1_GOC, marker: null, excluded_before_marker: { allocated: 0, payouts: 0, salary: 0 }, needs_review: { count: 0, suggested: 0 },
    });
    expect((await soDu("SHAREHOLDER", CD2)).balance).toBe(70);
    expect((await soDu("SHAREHOLDER", CD_XOA)).balance).toBe(0);
  });
  it("dòng stale: đổi cờ is_stale không đổi số dư (cả hai chiều)", async () => {
    await trongGiaoDich(async () => {
      await db.exec(`UPDATE public.profit_monthly SET is_stale = false WHERE id = '${PM_08_STALE}'`);
      expect((await soDu("SHAREHOLDER", CD1)).allocated).toBe(CD1_GOC);
      await db.exec("UPDATE public.profit_monthly SET is_stale = true");
      expect((await soDu("SHAREHOLDER", CD1)).allocated).toBe(CD1_GOC);
    });
  });
  it("bỏ dòng stale đi thì số dư giảm đúng 40 — tức dòng stale ĐANG được cộng", async () => {
    await trongGiaoDich(async () => {
      await db.exec(`DELETE FROM public.profit_allocations WHERE profit_monthly_id = '${PM_08_STALE}' AND shareholder_id = '${CD1}'`);
      expect((await soDu("SHAREHOLDER", CD1)).allocated).toBe(CD1_GOC - 40);
    });
  });
  it("dòng âm: bỏ đi thì số dư tăng đúng 15.5", async () => {
    await trongGiaoDich(async () => {
      await db.exec(`DELETE FROM public.profit_allocations WHERE profit_monthly_id = '${PM_08_AM}' AND shareholder_id = '${CD1}'`);
      expect((await soDu("SHAREHOLDER", CD1)).allocated).toBe(CD1_GOC + 15.5);
    });
  });
  it("tháng DRAFT chỉ tính sau khi chốt", async () => {
    await trongGiaoDich(async () => {
      await db.exec(`UPDATE public.profit_monthly SET status = 'LOCKED' WHERE id = '${PM_09_NHAP}'`);
      expect((await soDu("SHAREHOLDER", CD1)).allocated).toBe(CD1_GOC + 999);
    });
  });
  it("lọc công ty theo profit_monthly: kỳ của công ty B không vào sổ công ty A dù cột organization_id của dòng phân bổ ghi A; dòng có cột đó NULL vẫn tính", async () => {
    expect((await soDu("SHAREHOLDER", CD_B, "", ORG_B)).balance).toBe(300);
    await trongGiaoDich(async () => {
      await db.exec(`UPDATE public.profit_allocations SET organization_id = NULL WHERE shareholder_id = '${CD1}'`);
      expect((await soDu("SHAREHOLDER", CD1)).allocated).toBe(CD1_GOC);
    });
  });
  it("mở chốt (xoá phân bổ, kỳ về DRAFT) làm số dư giảm, không lỗi khoá ngoại dù sổ đã có mốc, phiếu, dòng lương, nhật ký; chốt lại với id mới thì về như cũ", async () => {
    await trongGiaoDich(async () => {
      const moc = await datMoc("SHAREHOLDER", CD1, "2026-07-01");
      await taoPhieu({ id: id(1001), soTien: 5, coDong: CD1, trangThai: "UNAPPROVED" });
      await ghiDongPhieu(id(1001), "SHAREHOLDER", CD1, 5);
      await taoPhieu({ id: id(1002), soTien: 50 });
      const dongBang = await taoDongBang({ thang: "2026-09-01", y: 8, d: 0 });
      await taoDongLuong({ phieuLuong: id(1002), thang: "2026-09-01", y: 8, trangThai: "LINKED" });
      await db.exec(`INSERT INTO app_private.profit_ledger_events(organization_id, event_kind, subject_kind, shareholder_id, marker_id, settlement_id)
        VALUES ('${ORG_A}','MARKER_SET','SHAREHOLDER','${CD1}','${moc}','${dongBang}')`);
      const truoc = await soDu("SHAREHOLDER", CD1);
      expect(truoc.balance).toBe(40 - 15.5 + 30 - 5 - 8);

      await db.exec(`DELETE FROM public.profit_allocations WHERE profit_monthly_id = '${PM_09}';
        UPDATE public.profit_monthly SET status = 'DRAFT', is_stale = true WHERE id = '${PM_09}'`);
      expect((await soDu("SHAREHOLDER", CD1)).balance).toBe(truoc.balance - 30);

      await db.exec(`UPDATE public.profit_monthly SET status = 'LOCKED' WHERE id = '${PM_09}';
        INSERT INTO public.profit_allocations(profit_monthly_id, shareholder_id, amount) VALUES ('${PM_09}','${CD1}',30)`);
      expect(await soDu("SHAREHOLDER", CD1)).toEqual(truoc);

      await db.exec(`DELETE FROM public.profit_monthly WHERE id = '${PM_09}'`);
      expect((await soDu("SHAREHOLDER", CD1)).balance).toBe(truoc.balance - 30);
    });
  });
});

describe("số dư: phiếu chi", () => {
  it("phiếu đã duyệt và phiếu chờ duyệt đều trừ, tách hai cột; phiếu bị từ chối / đã huỷ / đã xoá không trừ", async () => {
    await trongGiaoDich(async () => {
      await taoPhieu({ id: id(1001), soTien: 30, coDong: CD1, trangThai: "APPROVED" });
      await taoPhieu({ id: id(1002), soTien: 20, coDong: CD1, trangThai: "UNAPPROVED" });
      await taoYeuCau(id(1002), "PENDING_APPROVAL");
      await taoPhieu({ id: id(1003), soTien: 7, coDong: CD1, trangThai: "UNAPPROVED" });
      await taoYeuCau(id(1003), "REJECTED");
      await taoPhieu({ id: id(1004), soTien: 9, coDong: CD1, trangThai: "CANCELLED" });
      await taoPhieu({ id: id(1005), soTien: 11, coDong: CD1, daXoa: true });
      expect(await soDu("SHAREHOLDER", CD1)).toMatchObject({ payouts_approved: 30, payouts_pending: 20, balance: CD1_GOC - 50 });
    });
  });
  it("phiếu chờ duyệt bị từ chối thì số dư hồi lại; gửi lại thì trừ lại", async () => {
    await trongGiaoDich(async () => {
      await taoPhieu({ id: id(1001), soTien: 20, coDong: CD1, trangThai: "UNAPPROVED" });
      await taoYeuCau(id(1001), "PENDING_APPROVAL", 1);
      expect((await soDu("SHAREHOLDER", CD1)).balance).toBe(CD1_GOC - 20);
      await db.exec(`UPDATE public.approval_requests SET state = 'REJECTED' WHERE subject_id = '${id(1001)}'`);
      expect((await soDu("SHAREHOLDER", CD1)).balance).toBe(CD1_GOC);
      await taoYeuCau(id(1001), "PENDING_APPROVAL", 2);
      expect((await soDu("SHAREHOLDER", CD1)).balance).toBe(CD1_GOC - 20);
    });
  });
  it("phiếu của người khác, của công ty khác, phiếu THU không vào sổ; số âm là đang tạm ứng", async () => {
    await trongGiaoDich(async () => {
      await taoPhieu({ id: id(1001), soTien: 5, coDong: CD2 });
      await taoPhieu({ id: id(1002), soTien: 6, quanLy: QL1 });
      await taoPhieu({ id: id(1003), soTien: 7, coDong: CD1, loai: "INCOME" });
      await taoPhieu({ id: id(1004), soTien: 8 });
      expect((await soDu("SHAREHOLDER", CD1)).balance).toBe(CD1_GOC);
      await taoPhieu({ id: id(1005), soTien: 200, coDong: CD1 });
      expect((await soDu("SHAREHOLDER", CD1)).balance).toBe(CD1_GOC - 200);
    });
  });
  it("p_exclude_voucher bỏ đúng một phiếu khỏi phép tính (dùng khi duyệt chính phiếu đó)", async () => {
    await trongGiaoDich(async () => {
      await taoPhieu({ id: id(1001), soTien: 30, coDong: CD1 });
      await taoPhieu({ id: id(1002), soTien: 20, coDong: CD1, trangThai: "UNAPPROVED" });
      expect(await soDu("SHAREHOLDER", CD1, `, '${id(1002)}'`)).toMatchObject({ payouts_approved: 30, payouts_pending: 0, balance: CD1_GOC - 30 });
      expect((await soDu("SHAREHOLDER", CD1, `, '${id(1001)}'`)).balance).toBe(CD1_GOC - 20);
    });
  });
});

describe("số dư: mốc 'đã trả đủ đến hết tháng X'", () => {
  it("mốc loại phân bổ của tháng ≤ X và báo phần bị loại; cổ đông khác không bị ảnh hưởng", async () => {
    await trongGiaoDich(async () => {
      const moc = await datMoc("SHAREHOLDER", CD1, "2026-08-01");
      const s = await soDu("SHAREHOLDER", CD1);
      expect(s).toMatchObject({ allocated: 30, balance: 30, excluded_before_marker: { allocated: 124.5, payouts: 0, salary: 0 } });
      expect(s.marker).toMatchObject({ id: moc, settled_through_month: "2026-08-01" });
      expect((await soDu("SHAREHOLDER", CD2)).balance).toBe(70);
    });
  });
  it("mốc đúng tháng X thì tháng X bị loại, tháng X+1 còn (so sánh > chứ không ≥)", async () => {
    await trongGiaoDich(async () => {
      await datMoc("SHAREHOLDER", CD1, "2026-07-01");
      expect((await soDu("SHAREHOLDER", CD1)).allocated).toBe(40 - 15.5 + 30);
    });
  });
  it("phiếu vào sổ TRƯỚC mốc (ledger_seq nhỏ hơn) bị loại; phiếu vào sổ SAU mốc vẫn trừ — dù giờ tạo phiếu nói ngược lại", async () => {
    await trongGiaoDich(async () => {
      // Phiếu trước mốc cố ý ghi giờ tạo ở TƯƠNG LAI, phiếu sau mốc ghi giờ tạo ở QUÁ KHỨ: thứ tự thật là ledger_seq.
      await taoPhieu({ id: id(1001), soTien: 11, coDong: CD1, taoLuc: "now() + interval '1 day'" });
      await ghiDongPhieu(id(1001), "SHAREHOLDER", CD1, 11);
      await datMoc("SHAREHOLDER", CD1, "2026-08-01");
      await taoPhieu({ id: id(1002), soTien: 4, coDong: CD1, trangThai: "UNAPPROVED", taoLuc: "now() - interval '1 day'" });
      await ghiDongPhieu(id(1002), "SHAREHOLDER", CD1, 4);
      expect(await soDu("SHAREHOLDER", CD1)).toMatchObject({
        allocated: 30, payouts_approved: 0, payouts_pending: 4, balance: 26,
        excluded_before_marker: { allocated: 124.5, payouts: 11, salary: 0 },
      });
    });
  });
  it("phiếu cũ không có dòng sổ: so giờ tạo với giờ đặt mốc", async () => {
    await trongGiaoDich(async () => {
      await taoPhieu({ id: id(1001), soTien: 11, coDong: CD1, taoLuc: "clock_timestamp() - interval '1 hour'" });
      await datMoc("SHAREHOLDER", CD1, "2026-08-01");
      await taoPhieu({ id: id(1002), soTien: 4, coDong: CD1, taoLuc: "clock_timestamp() + interval '1 hour'" });
      expect(await soDu("SHAREHOLDER", CD1)).toMatchObject({ payouts_approved: 4, balance: 26, excluded_before_marker: { payouts: 11 } });
    });
  });
  it("dòng lương của kỳ ≤ X bị loại, kỳ > X vẫn trừ", async () => {
    await trongGiaoDich(async () => {
      await taoPhieu({ id: id(1001), soTien: 50 });
      await taoPhieu({ id: id(1002), soTien: 50 });
      await taoDongLuong({ phieuLuong: id(1001), thang: "2026-08-01", y: 9, d: 2, trangThai: "LINKED" });
      await taoDongLuong({ phieuLuong: id(1002), thang: "2026-09-01", y: 6, d: 1, trangThai: "LINKED" });
      await datMoc("SHAREHOLDER", CD1, "2026-08-01");
      expect(await soDu("SHAREHOLDER", CD1)).toMatchObject({
        allocated: 30, salary_investment: 6, salary_advance_offset: 1, balance: 30 - 5,
        excluded_before_marker: { allocated: 124.5, payouts: 0, salary: 7 },
      });
    });
  });
  it("gỡ mốc (dòng tháng NULL) trả số dư về ĐÚNG như chưa từng có mốc, kể cả khi đã có phiếu trước và sau mốc", async () => {
    await trongGiaoDich(async () => {
      await taoPhieu({ id: id(1001), soTien: 11, coDong: CD1 });
      await ghiDongPhieu(id(1001), "SHAREHOLDER", CD1, 11);
      await taoPhieu({ id: id(1002), soTien: 3, coDong: CD1, taoLuc: "clock_timestamp() - interval '1 hour'" });
      await taoPhieu({ id: id(1003), soTien: 50 });
      await taoDongLuong({ phieuLuong: id(1003), thang: "2026-08-01", y: 9, d: 2, trangThai: "LINKED" });
      const chuaCoMoc = await soDu("SHAREHOLDER", CD1);
      expect(chuaCoMoc.balance).toBe(CD1_GOC - 11 - 3 - 7);

      const moc = await datMoc("SHAREHOLDER", CD1, "2026-08-01");
      await taoPhieu({ id: id(1004), soTien: 4, coDong: CD1, trangThai: "UNAPPROVED" });
      await ghiDongPhieu(id(1004), "SHAREHOLDER", CD1, 4);
      expect((await soDu("SHAREHOLDER", CD1)).balance).toBe(30 - 4);

      const go = await datMoc("SHAREHOLDER", CD1, null, moc);
      const sauGo = await soDu("SHAREHOLDER", CD1);
      expect(sauGo).toMatchObject({
        allocated: CD1_GOC, payouts_approved: 14, payouts_pending: 4, salary_investment: 9, salary_advance_offset: 2,
        balance: chuaCoMoc.balance - 4, excluded_before_marker: { allocated: 0, payouts: 0, salary: 0 },
      });
      // Dòng gỡ mốc vẫn là dòng hiệu lực (để lệnh đặt mốc sau so khớp), chỉ là không còn tháng.
      expect(sauGo.marker).toMatchObject({ id: go, settled_through_month: null });

      await datMoc("SHAREHOLDER", CD1, "2026-07-01", go);
      expect(await soDu("SHAREHOLDER", CD1)).toMatchObject({ allocated: 54.5, payouts_approved: 0, payouts_pending: 0, salary_investment: 9 });
    });
  });
  it("mốc hiệu lực là dòng ledger_seq lớn nhất; hàm trả 0 dòng khi chưa có mốc", async () => {
    await trongGiaoDich(async () => {
      const hieuLuc = () => db.query<{ marker_id: string; settled_through_month: string | null }>(
        `SELECT marker_id, settled_through_month::text FROM app_private.profit_ledger_active_marker_v1('${ORG_A}','SHAREHOLDER','${CD1}')`);
      expect((await hieuLuc()).rows).toEqual([]);
      const m1 = await datMoc("SHAREHOLDER", CD1, "2026-07-01");
      const m2 = await datMoc("SHAREHOLDER", CD1, "2026-08-01", m1);
      await datMoc("SHAREHOLDER", CD2, "2026-09-01");
      await datMoc("MANAGER", QL1, "2026-09-01");
      expect((await hieuLuc()).rows).toEqual([{ marker_id: m2, settled_through_month: "2026-08-01" }]);
    });
  });
});

describe("số dư: phần lợi nhuận đã trả qua lương", () => {
  it("chỉ dòng LINKED có phiếu lương còn sống mới trừ; trừ (phần lợi nhuận − phần trừ tạm ứng)", async () => {
    await trongGiaoDich(async () => {
      await taoPhieu({ id: id(1001), soTien: 50 });
      await taoDongLuong({ phieuLuong: id(1001), thang: "2026-09-01", y: 40, d: 10, trangThai: "LINKED" });
      expect(await soDu("SHAREHOLDER", CD1)).toMatchObject({ salary_investment: 40, salary_advance_offset: 10, balance: CD1_GOC - 30 });
      expect((await soDu("SHAREHOLDER", CD2)).balance).toBe(70);
    });
  });
  it("phiếu lương bị huỷ / bị từ chối thì dòng LINKED tự hết hiệu lực", async () => {
    await trongGiaoDich(async () => {
      await taoPhieu({ id: id(1001), soTien: 50, trangThai: "UNAPPROVED" });
      await taoYeuCau(id(1001), "PENDING_APPROVAL");
      await taoDongLuong({ phieuLuong: id(1001), thang: "2026-09-01", y: 40, d: 10, trangThai: "LINKED" });
      expect((await soDu("SHAREHOLDER", CD1)).balance).toBe(CD1_GOC - 30);
      await db.exec(`UPDATE public.approval_requests SET state = 'REJECTED' WHERE subject_id = '${id(1001)}'`);
      expect(await soDu("SHAREHOLDER", CD1)).toMatchObject({ salary_investment: 0, salary_advance_offset: 0, balance: CD1_GOC });
      await db.exec(`UPDATE public.approval_requests SET state = 'PENDING_APPROVAL' WHERE subject_id = '${id(1001)}';
        UPDATE public.income_expenses SET approval_status = 'CANCELLED' WHERE id = '${id(1001)}'`);
      expect((await soDu("SHAREHOLDER", CD1)).balance).toBe(CD1_GOC);
    });
  });
  it("dòng NEEDS_REVIEW không trừ dù có số, nhưng hiện ở needs_review; dòng QUOTED không trừ", async () => {
    await trongGiaoDich(async () => {
      await taoPhieu({ id: id(1001), soTien: 50 });
      await taoPhieu({ id: id(1002), soTien: 50, trangThai: "CANCELLED" });
      await taoDongLuong({ phieuLuong: id(1001), thang: "2026-09-01", y: 25, d: 5, trangThai: "NEEDS_REVIEW", goiY: 25 });
      await taoDongLuong({ phieuLuong: id(1002), thang: "2026-08-01", y: 0, trangThai: "NEEDS_REVIEW", goiY: 13 });
      await taoDongLuong({ thang: "2026-07-01", y: 33, trangThai: "QUOTED" });
      expect(await soDu("SHAREHOLDER", CD1)).toMatchObject({
        salary_investment: 0, salary_advance_offset: 0, balance: CD1_GOC, needs_review: { count: 1, suggested: 25 },
      });
    });
  });
  it("tháng lỗ (phần lợi nhuận âm) làm số dư tăng; trừ tạm ứng nhiều hơn phần lợi nhuận cũng làm số dư tăng", async () => {
    await trongGiaoDich(async () => {
      await taoPhieu({ id: id(1001), soTien: 50 });
      await taoPhieu({ id: id(1002), soTien: 50 });
      await taoDongLuong({ phieuLuong: id(1001), thang: "2026-08-01", y: -8, trangThai: "LINKED" });
      await taoDongLuong({ phieuLuong: id(1002), thang: "2026-09-01", y: 0, d: 10, trangThai: "LINKED" });
      expect(await soDu("SHAREHOLDER", CD1)).toMatchObject({ salary_investment: -8, salary_advance_offset: 10, balance: CD1_GOC + 18 });
    });
  });
  it("p_exclude_salary_period bỏ đúng kỳ lương đó; kỳ không phải ngày đầu tháng bị từ chối 22023", async () => {
    await trongGiaoDich(async () => {
      await taoPhieu({ id: id(1001), soTien: 50 });
      await taoPhieu({ id: id(1002), soTien: 50 });
      await taoDongLuong({ phieuLuong: id(1001), thang: "2026-08-01", y: 9, trangThai: "LINKED" });
      await taoDongLuong({ phieuLuong: id(1002), thang: "2026-09-01", y: 6, trangThai: "LINKED" });
      expect((await soDu("SHAREHOLDER", CD1)).balance).toBe(CD1_GOC - 15);
      expect((await soDu("SHAREHOLDER", CD1, ", NULL, '2026-09-01'")).balance).toBe(CD1_GOC - 9);
      expect((await soDu("SHAREHOLDER", CD1, ", p_exclude_salary_period => '2026-08-01'")).balance).toBe(CD1_GOC - 6);
      expect(await maLoi(`SELECT app_private.profit_ledger_balance_v1('${ORG_A}','SHAREHOLDER','${CD1}', NULL, '2026-09-15')`)).toBe("22023");
    });
  });
});

describe("số dư: lương điều hành (MANAGER)", () => {
  it("được nhận − đã trả = còn lại; dùng profit_manager_allocations, không có phần lương", async () => {
    expect(await soDu("MANAGER", QL1)).toMatchObject({ allocated: QL1_GOC, balance: QL1_GOC, salary_investment: 0, needs_review: { count: 0, suggested: 0 } });
    expect((await soDu("MANAGER", QL2)).balance).toBe(0);
    await trongGiaoDich(async () => {
      await taoPhieu({ id: id(1001), soTien: 6, quanLy: QL1 });
      await taoPhieu({ id: id(1002), soTien: 4, quanLy: QL1, trangThai: "UNAPPROVED" });
      await taoPhieu({ id: id(1003), soTien: 9, quanLy: QL1, trangThai: "UNAPPROVED" });
      await taoYeuCau(id(1003), "CANCELLED");
      await taoPhieu({ id: id(1004), soTien: 100, coDong: CD1 });
      await taoPhieu({ id: id(1005), soTien: 100, quanLy: QL2 });
      expect(await soDu("MANAGER", QL1)).toMatchObject({ payouts_approved: 6, payouts_pending: 4, balance: 8 });
      expect((await soDu("SHAREHOLDER", CD1)).balance).toBe(CD1_GOC - 100);
    });
  });
  it("mốc của lương điều hành: loại tháng ≤ X và phiếu vào sổ trước mốc", async () => {
    await trongGiaoDich(async () => {
      await taoPhieu({ id: id(1001), soTien: 6, quanLy: QL1 });
      await ghiDongPhieu(id(1001), "MANAGER", QL1, 6);
      await datMoc("MANAGER", QL1, "2026-07-01");
      await taoPhieu({ id: id(1002), soTien: 2, quanLy: QL1 });
      await ghiDongPhieu(id(1002), "MANAGER", QL1, 2);
      expect(await soDu("MANAGER", QL1)).toMatchObject({ allocated: 8, payouts_approved: 2, balance: 6, excluded_before_marker: { allocated: 10, payouts: 6, salary: 0 } });
      expect((await soDu("SHAREHOLDER", CD1)).balance).toBe(CD1_GOC);
    });
  });
});

describe("số dư: tham số sai thì dừng, không trả số 0 giả", () => {
  it("thiếu tham số / loại chủ thể lạ ⇒ 22023; chủ thể không thuộc công ty ⇒ P0002", async () => {
    await trongGiaoDich(async () => {
      expect(await maLoi(`SELECT app_private.profit_ledger_balance_v1(NULL,'SHAREHOLDER','${CD1}')`)).toBe("22023");
      expect(await maLoi(`SELECT app_private.profit_ledger_balance_v1('${ORG_A}','SHAREHOLDER',NULL)`)).toBe("22023");
      expect(await maLoi(`SELECT app_private.profit_ledger_balance_v1('${ORG_A}','KHAC','${CD1}')`)).toBe("22023");
      expect(await maLoi(`SELECT app_private.profit_ledger_balance_v1('${ORG_B}','SHAREHOLDER','${CD1}')`)).toBe("P0002");
      expect(await maLoi(`SELECT app_private.profit_ledger_balance_v1('${ORG_A}','MANAGER','${CD1}')`)).toBe("P0002");
      expect(await maLoi(`SELECT app_private.profit_ledger_balance_v1('${ORG_A}','SHAREHOLDER','${QL1}')`)).toBe("P0002");
    });
  });
});

describe("lõi số dư theo mốc truyền vào (profit_ledger_balance_core_v1)", () => {
  const MAX_SEQ = "9223372036854775807";
  const loi = (thang: string | null, seq: string | null, luc: string | null, them = "", chuThe = CD1, loai: Loai = "SHAREHOLDER") =>
    mot<SoDu>(`SELECT app_private.profit_ledger_balance_core_v1('${ORG_A}','${loai}','${chuThe}',
      ${thang ? `'${thang}'` : "NULL"}::date, ${seq ?? "NULL"}::bigint, ${luc ? `'${luc}'` : "NULL"}::timestamptz${them}) AS v`);
  const boMarker = (s: SoDu) => { const { marker: _bo, ...con } = s; return con; };

  it("chữ ký: balance_v1 giữ nguyên 5 tham số; lõi đúng 8 tham số theo thứ tự đã chốt", async () => {
    const r = (await db.query<{ v1: string; loi: string }>(`
      SELECT pg_get_function_arguments('app_private.profit_ledger_balance_v1(uuid,text,uuid,uuid,date)'::regprocedure) AS v1,
             pg_get_function_arguments('app_private.profit_ledger_balance_core_v1(uuid,text,uuid,date,bigint,timestamptz,uuid,date)'::regprocedure) AS loi`)).rows[0];
    expect(r.v1).toBe("p_org uuid, p_kind text, p_subject uuid, p_exclude_voucher uuid DEFAULT NULL::uuid, p_exclude_salary_period date DEFAULT NULL::date");
    expect(r.loi).toBe("p_org uuid, p_kind text, p_subject uuid, p_marker_month date, p_marker_seq bigint, p_marker_created_at timestamp with time zone, "
      + "p_exclude_voucher uuid DEFAULT NULL::uuid, p_exclude_salary_period date DEFAULT NULL::date");
  });
  it("COMMENT của lõi ghi quy ước mốc giả định 'đặt ngay bây giờ'", async () => {
    const c = await mot<string>("SELECT obj_description('app_private.profit_ledger_balance_core_v1(uuid,text,uuid,date,bigint,timestamptz,uuid,date)'::regprocedure, 'pg_proc') AS v");
    expect(c).toContain("9223372036854775807");
    expect(c).toContain("'infinity'");
  });
  it("balance_v1 không có công thức riêng: lúc chạy nó đi qua lõi với đúng mốc hiệu lực và hai tham số loại trừ", async () => {
    await trongGiaoDich(async () => {
      const m = await datMoc("SHAREHOLDER", CD1, "2026-08-01");
      await db.exec(`CREATE OR REPLACE FUNCTION app_private.profit_ledger_balance_core_v1(p_org uuid, p_kind text, p_subject uuid,
          p_marker_month date, p_marker_seq bigint, p_marker_created_at timestamptz, p_exclude_voucher uuid DEFAULT NULL, p_exclude_salary_period date DEFAULT NULL)
        RETURNS jsonb LANGUAGE sql AS $$ SELECT jsonb_build_object('balance', 424242, 'thang', p_marker_month, 'seq', p_marker_seq::text,
          'bo_phieu', p_exclude_voucher, 'bo_ky', p_exclude_salary_period, 'marker', 'của lõi') $$`);
      const v = await mot<Record<string, unknown>>(`SELECT app_private.profit_ledger_balance_v1('${ORG_A}','SHAREHOLDER','${CD1}', '${id(1001)}', '2026-09-01') AS v`);
      const seq = await mot<string>(`SELECT ledger_seq::text AS v FROM app_private.profit_ledger_markers WHERE id = '${m}'`);
      expect(v).toMatchObject({ balance: 424242, thang: "2026-08-01", seq, bo_phieu: id(1001), bo_ky: "2026-09-01" });
      expect(v.marker).toMatchObject({ id: m, settled_through_month: "2026-08-01" });
    });
    const than = await mot<string>("SELECT prosrc AS v FROM pg_proc WHERE oid = 'app_private.profit_ledger_balance_v1(uuid,text,uuid,uuid,date)'::regprocedure");
    expect(than).toContain("app_private.profit_ledger_balance_core_v1(");
    for (const bang of ["profit_allocations", "profit_manager_allocations", "income_expenses", "profit_ledger_payouts", "profit_ledger_salary_settlement_vouchers"]) {
      expect(than, bang).not.toContain(bang);
    }
  });
  it("tháng mốc NULL = không có mốc: thứ tự sổ và giờ truyền vào bị bỏ qua; trường marker null", async () => {
    await trongGiaoDich(async () => {
      await taoPhieu({ id: id(1001), soTien: 11, coDong: CD1 });
      await ghiDongPhieu(id(1001), "SHAREHOLDER", CD1, 11);
      await taoPhieu({ id: id(1002), soTien: 3, coDong: CD1, taoLuc: "'2020-01-01'" });
      const khongMoc = await soDu("SHAREHOLDER", CD1);
      expect(khongMoc.balance).toBe(CD1_GOC - 14);
      for (const [seq, luc] of [[null, null], [MAX_SEQ, "infinity"], ["1", "2000-01-01"], ["0", "2099-01-01"]] as const) {
        const s = await loi(null, seq, luc);
        expect(s).toEqual(khongMoc);
        expect(s.marker).toBeNull();
      }
    });
  });
  it("mốc giả định 'đặt ngay bây giờ' loại mọi phiếu hiện có — có dòng sổ hay không, kể cả phiếu lập trong cùng giao dịch — và trùng số dư thật sau khi đặt mốc", async () => {
    await trongGiaoDich(async () => {
      await taoPhieu({ id: id(1001), soTien: 11, coDong: CD1 });
      await ghiDongPhieu(id(1001), "SHAREHOLDER", CD1, 11);
      await taoPhieu({ id: id(1002), soTien: 3, coDong: CD1, trangThai: "UNAPPROVED", taoLuc: "'2020-01-01'" });
      await taoPhieu({ id: id(1003), soTien: 5, coDong: CD1 });
      await taoPhieu({ id: id(1004), soTien: 50 });
      await taoPhieu({ id: id(1005), soTien: 50 });
      await taoDongLuong({ phieuLuong: id(1004), thang: "2026-08-01", y: 9, d: 2, trangThai: "LINKED" });
      await taoDongLuong({ phieuLuong: id(1005), thang: "2026-09-01", y: 6, d: 1, trangThai: "LINKED" });
      const giaDinh = await loi("2026-08-01", MAX_SEQ, "infinity");
      expect(giaDinh).toMatchObject({
        allocated: 30, payouts_approved: 0, payouts_pending: 0, salary_investment: 6, salary_advance_offset: 1, balance: 30 - 5,
        excluded_before_marker: { allocated: 124.5, payouts: 19, salary: 7 },
      });
      expect(giaDinh.marker).toMatchObject({ id: null, settled_through_month: "2026-08-01", created_at: "infinity" });
      expect(await mot<string>(`SELECT (app_private.profit_ledger_balance_core_v1('${ORG_A}','SHAREHOLDER','${CD1}', '2026-08-01', ${MAX_SEQ}, 'infinity') -> 'marker' ->> 'ledger_seq') AS v`)).toBe(MAX_SEQ);

      await datMoc("SHAREHOLDER", CD1, "2026-08-01");
      expect(boMarker(await soDu("SHAREHOLDER", CD1))).toEqual(boMarker(giaDinh));
      // Phiếu lập SAU mốc (seq lớn hơn) thì tính, dù mốc giả định trước đó đã loại mọi phiếu có lúc ấy.
      await taoPhieu({ id: id(1006), soTien: 4, coDong: CD1, trangThai: "UNAPPROVED" });
      await ghiDongPhieu(id(1006), "SHAREHOLDER", CD1, 4);
      expect((await soDu("SHAREHOLDER", CD1)).balance).toBe(30 - 5 - 4);
    });
  });
  it("lương điều hành: mốc giả định trùng mốc thật", async () => {
    await trongGiaoDich(async () => {
      await taoPhieu({ id: id(1001), soTien: 6, quanLy: QL1 });
      await ghiDongPhieu(id(1001), "MANAGER", QL1, 6);
      await taoPhieu({ id: id(1002), soTien: 2, quanLy: QL1, taoLuc: "'2020-01-01'" });
      const giaDinh = await loi("2026-07-01", MAX_SEQ, "infinity", "", QL1, "MANAGER");
      expect(giaDinh).toMatchObject({ allocated: 8, payouts_approved: 0, balance: 8, excluded_before_marker: { allocated: 10, payouts: 8, salary: 0 } });
      await datMoc("MANAGER", QL1, "2026-07-01");
      expect(boMarker(await soDu("MANAGER", QL1))).toEqual(boMarker(giaDinh));
    });
  });
  it("tham số mốc không hợp lệ ⇒ 22023 (không trả số sai): tháng không phải ngày 1 / vô cực, có tháng mà thiếu thứ tự sổ hoặc giờ", async () => {
    await trongGiaoDich(async () => {
      const goi = (thang: string, seq: string, luc: string) =>
        maLoi(`SELECT app_private.profit_ledger_balance_core_v1('${ORG_A}','SHAREHOLDER','${CD1}', ${thang}, ${seq}, ${luc})`);
      expect(await goi("'2026-08-15'", MAX_SEQ, "'infinity'")).toBe("22023");
      expect(await goi("'infinity'::date", MAX_SEQ, "'infinity'")).toBe("22023");
      expect(await goi("'2026-08-01'", "NULL", "'infinity'")).toBe("22023");
      expect(await goi("'2026-08-01'", MAX_SEQ, "NULL")).toBe("22023");
      expect(await goi("'2026-08-01'", MAX_SEQ, "'infinity'")).toBeNull();
      expect(await maLoi(`SELECT app_private.profit_ledger_balance_core_v1('${ORG_B}','SHAREHOLDER','${CD1}', NULL, NULL, NULL)`)).toBe("P0002");
      expect(await maLoi(`SELECT app_private.profit_ledger_balance_core_v1('${ORG_A}','KHAC','${CD1}', NULL, NULL, NULL)`)).toBe("22023");
    });
  });
});

describe("số dư: đối chứng ngẫu nhiên với mô hình viết độc lập", () => {
  // Bộ sinh số giả ngẫu nhiên có hạt giống cố định ⇒ mọi lần chạy sinh đúng cùng các kịch bản.
  let hat = 20261115;
  const rnd = () => {
    hat = (hat + 0x6d2b79f5) | 0;
    let t = Math.imul(hat ^ (hat >>> 15), 1 | hat);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const nguyen = (a: number, b: number) => a + Math.floor(rnd() * (b - a + 1));
  const chon = <T,>(ds: readonly T[]): T => ds[Math.floor(rnd() * ds.length)];
  const xs = (p: number) => rnd() < p;
  const tron = (x: number) => Math.round(x * 100) / 100 + 0;
  const THANG = ["2026-01-01", "2026-02-01", "2026-03-01", "2026-04-01", "2026-05-01", "2026-06-01", "2026-07-01", "2026-08-01"];
  const TRANG_THAI_YC = ["PENDING_APPROVAL", "POSTED", "DENIED", "REJECTED", "CANCELLED", "REVERSED", "APPROVED", "WITHDRAWN", "CHANGES_REQUESTED", "DISPUTED"];
  const CHET = new Set(["DENIED", "REJECTED", "CANCELLED", "WITHDRAWN", "REVERSED"]);
  interface PhieuNN { id: string; loai: Loai | null; chuThe: string | null; tien: number; tt: "APPROVED" | "UNAPPROVED" | "CANCELLED"; xoa: boolean; thu: boolean; yc: string[]; seq: number | null; sauMoc: boolean }
  interface MocNN { id: string; loai: Loai; chuThe: string; thang: string | null; seq: number }
  interface LuongNN { coDong: string; thang: string; tt: DongLuong["trangThai"]; y: number; d: number; goiY: number | null; phieu: PhieuNN | null }
  interface PhanBoNN { loai: Loai; chuThe: string; org: string; thang: string; khoa: boolean; tien: number }
  const CHU_THE: [Loai, string[]][] = [["SHAREHOLDER", [CD1, CD2]], ["MANAGER", [QL1, QL2]]];

  /** Mô hình: viết thẳng theo hợp đồng, không dùng lại câu SQL nào của hàm. */
  const song = (p: PhieuNN) => !p.xoa && !p.thu && (p.tt === "APPROVED" || (p.tt === "UNAPPROVED" && (p.yc.length === 0 || !CHET.has(p.yc[p.yc.length - 1]))));
  function moHinh(pb: PhanBoNN[], phieu: PhieuNN[], moc: MocNN[], luong: LuongNN[], loai: Loai, chuThe: string, boPhieu: string | null, boKy: string | null) {
    const hieuLuc = moc.filter((m) => m.loai === loai && m.chuThe === chuThe).sort((a, b) => b.seq - a.seq)[0] ?? null;
    const moc_ = hieuLuc !== null && hieuLuc.thang !== null ? { thang: hieuLuc.thang, seq: hieuLuc.seq } : null;
    const r = { allocated: 0, payouts_approved: 0, payouts_pending: 0, salary_investment: 0, salary_advance_offset: 0, balance: 0,
      ex_allocated: 0, ex_payouts: 0, ex_salary: 0, nr_count: 0, nr_suggested: 0, marker: hieuLuc?.id ?? null, marker_thang: hieuLuc?.thang ?? null };
    for (const a of pb) {
      if (a.loai !== loai || a.chuThe !== chuThe || a.org !== ORG_A || !a.khoa) continue;
      if (moc_ === null || a.thang > moc_.thang) r.allocated += a.tien; else r.ex_allocated += a.tien;
    }
    for (const p of phieu) {
      if (p.loai !== loai || p.chuThe !== chuThe || p.id === boPhieu || !song(p)) continue;
      const tinh = moc_ === null || (p.seq !== null ? p.seq > moc_.seq : p.sauMoc);
      if (!tinh) r.ex_payouts += p.tien; else if (p.tt === "APPROVED") r.payouts_approved += p.tien; else r.payouts_pending += p.tien;
    }
    if (loai === "SHAREHOLDER") for (const d of luong) {
      if (d.coDong !== chuThe || d.phieu === null || !song(d.phieu)) continue;
      if (d.tt === "NEEDS_REVIEW") { r.nr_count += 1; r.nr_suggested += d.goiY ?? 0; }
      if (d.tt !== "LINKED" || d.thang === boKy) continue;
      if (moc_ === null || d.thang > moc_.thang) { r.salary_investment += d.y; r.salary_advance_offset += d.d; } else r.ex_salary += d.y - d.d;
    }
    r.balance = r.allocated - r.payouts_approved - r.payouts_pending - (r.salary_investment - r.salary_advance_offset);
    return r;
  }

  async function kichBan(k: number) {
    let n = 5000;
    const moi = () => id(n++);
    const pb: PhanBoNN[] = [], phieu: PhieuNN[] = [], moc: MocNN[] = [], luong: LuongNN[] = [];
    await db.exec("DELETE FROM public.profit_monthly");
    for (const [org, thangs] of [[ORG_A, THANG], [ORG_B, THANG.slice(0, 3)]] as const) for (const th of thangs) for (let toa = 0; toa < 2; toa++) {
      if (xs(0.15)) continue;
      const pm = moi(), khoa = xs(0.75);
      await db.exec(`INSERT INTO public.profit_monthly(id, organization_id, building_id, period_month, status, is_stale) VALUES ('${pm}','${org}','${moi()}','${th}','${khoa ? "LOCKED" : "DRAFT"}',${xs(0.3)})`);
      for (const s of [CD1, CD2]) if (xs(0.8)) {
        const tien = nguyen(-60, 300) + (xs(0.3) ? 0.5 : 0);
        pb.push({ loai: "SHAREHOLDER", chuThe: s, org, thang: th, khoa, tien });
        await db.exec(`INSERT INTO public.profit_allocations(profit_monthly_id, shareholder_id, amount, organization_id) VALUES ('${pm}','${s}',${tien}, ${xs(0.5) ? `'${ORG_A}'` : "NULL"})`);
      }
      for (const m of [QL1, QL2]) if (xs(0.5)) {
        const tien = nguyen(0, 60);
        pb.push({ loai: "MANAGER", chuThe: m, org, thang: th, khoa, tien });
        await db.exec(`INSERT INTO public.profit_manager_allocations(profit_monthly_id, manager_id, amount, organization_id) VALUES ('${pm}','${m}',${tien}, ${xs(0.5) ? `'${ORG_A}'` : "NULL"})`);
      }
    }
    const taoPhieuNN = async (loai: Loai | null, chuThe: string | null): Promise<PhieuNN> => {
      const p: PhieuNN = { id: moi(), loai, chuThe, tien: nguyen(1, 120), tt: chon(["APPROVED", "APPROVED", "UNAPPROVED", "UNAPPROVED", "CANCELLED"] as const),
        xoa: xs(0.1), thu: xs(0.1), yc: Array.from({ length: chon([0, 0, 1, 1, 2]) }, () => chon(TRANG_THAI_YC)), seq: null, sauMoc: xs(0.5) };
      await taoPhieu({ id: p.id, soTien: p.tien, coDong: loai === "SHAREHOLDER" ? chuThe ?? undefined : undefined, quanLy: loai === "MANAGER" ? chuThe ?? undefined : undefined,
        trangThai: p.tt, loai: p.thu ? "INCOME" : "EXPENSE", daXoa: p.xoa, taoLuc: p.sauMoc ? "'2099-01-01'" : "'2020-01-01'" });
      for (const [i, s] of p.yc.entries()) await taoYeuCau(p.id, s, i + 1);
      // Nhiễu: yêu cầu của loại khác / công ty khác không được ảnh hưởng tới phiếu.
      if (xs(0.2)) { await taoYeuCau(p.id, "REJECTED", 9, { loai: "LOAI_KHAC" }); await taoYeuCau(p.id, "REJECTED", 9, { org: ORG_B }); }
      return p;
    };
    const viec = [...Array<string>(nguyen(4, 12)).fill("phieu"), ...Array<string>(nguyen(0, 4)).fill("moc"), ...Array<string>(nguyen(0, 5)).fill("luong")]
      .map((v) => ({ v, r: rnd() })).sort((a, b) => a.r - b.r).map((x) => x.v);
    for (const v of viec) {
      if (v === "phieu") {
        const loai = chon<Loai | null>(["SHAREHOLDER", "SHAREHOLDER", "MANAGER", null]);
        const chuThe = loai === "SHAREHOLDER" ? chon([CD1, CD2]) : loai === "MANAGER" ? chon([QL1, QL2]) : null;
        const p = await taoPhieuNN(loai, chuThe);
        if (loai !== null && chuThe !== null && !p.xoa && !p.thu && xs(0.65)) {
          await ghiDongPhieu(p.id, loai, chuThe, p.tien);
          p.seq = Number(await mot<string>(`SELECT ledger_seq::text AS v FROM app_private.profit_ledger_payouts WHERE voucher_id = '${p.id}'`));
          // Phiếu đã vào sổ về sau có thể bị huỷ hoặc xoá (bảng giả không có chốt chặn của phiếu).
          if (xs(0.2)) { p.tt = "CANCELLED"; await db.exec(`UPDATE public.income_expenses SET approval_status = 'CANCELLED' WHERE id = '${p.id}'`); }
          else if (xs(0.1)) { p.xoa = true; await db.exec(`UPDATE public.income_expenses SET deleted_at = now() WHERE id = '${p.id}'`); }
        }
        phieu.push(p);
      } else if (v === "moc") {
        const loai = chon<Loai>(["SHAREHOLDER", "SHAREHOLDER", "MANAGER"]);
        const chuThe = loai === "SHAREHOLDER" ? chon([CD1, CD2]) : chon([QL1, QL2]);
        const truoc = moc.filter((m) => m.loai === loai && m.chuThe === chuThe).sort((a, b) => b.seq - a.seq)[0];
        const thang = xs(0.25) ? null : chon(THANG);
        const idMoc = await datMoc(loai, chuThe, thang, truoc?.id ?? null);
        moc.push({ id: idMoc, loai, chuThe, thang, seq: Number(await mot<string>(`SELECT ledger_seq::text AS v FROM app_private.profit_ledger_markers WHERE id = '${idMoc}'`)) });
      } else {
        const tt = chon<DongLuong["trangThai"]>(["LINKED", "LINKED", "LINKED", "NEEDS_REVIEW", "QUOTED"]);
        const d: LuongNN = { coDong: chon([CD1, CD2]), thang: chon(THANG), tt, y: nguyen(-20, 80), d: nguyen(0, 30), goiY: tt === "NEEDS_REVIEW" && xs(0.8) ? nguyen(0, 50) : null, phieu: null };
        if (tt === "QUOTED" && luong.some((x) => x.tt === "QUOTED" && x.thang === d.thang)) continue;
        if (tt !== "QUOTED") d.phieu = await taoPhieuNN(null, null);
        await taoDongLuong({ phieuLuong: d.phieu?.id ?? null, thang: d.thang, y: d.y, d: d.d, trangThai: tt, goiY: d.goiY ?? undefined, coDong: d.coDong });
        luong.push(d);
      }
    }

    for (const [loai, ds] of CHU_THE) for (const chuThe of ds) {
      const cuaToi = phieu.filter((p) => p.loai === loai && p.chuThe === chuThe);
      const bo: [string | null, string | null][] = [[null, null], [cuaToi.length ? chon(cuaToi).id : null, null], [null, chon(THANG)], [cuaToi.length ? chon(cuaToi).id : null, chon(THANG)]];
      for (const [boPhieu, boKy] of bo) {
        const ham = await soDu(loai, chuThe, `, ${boPhieu ? `'${boPhieu}'` : "NULL"}, ${boKy ? `'${boKy}'` : "NULL"}`);
        const m = moHinh(pb, phieu, moc, luong, loai, chuThe, boPhieu, boKy);
        expect({
          allocated: tron(ham.allocated), payouts_approved: tron(ham.payouts_approved), payouts_pending: tron(ham.payouts_pending),
          salary_investment: tron(ham.salary_investment), salary_advance_offset: tron(ham.salary_advance_offset), balance: tron(ham.balance),
          ex_allocated: tron(ham.excluded_before_marker.allocated), ex_payouts: tron(ham.excluded_before_marker.payouts), ex_salary: tron(ham.excluded_before_marker.salary),
          nr_count: ham.needs_review.count, nr_suggested: tron(ham.needs_review.suggested),
          marker: ham.marker?.id ?? null, marker_thang: ham.marker?.settled_through_month ?? null,
        }, `kịch bản ${k} · ${loai} · bỏ phiếu ${boPhieu !== null} · bỏ kỳ ${boKy}`).toEqual({ ...m,
          allocated: tron(m.allocated), payouts_approved: tron(m.payouts_approved), payouts_pending: tron(m.payouts_pending),
          salary_investment: tron(m.salary_investment), salary_advance_offset: tron(m.salary_advance_offset), balance: tron(m.balance),
          ex_allocated: tron(m.ex_allocated), ex_payouts: tron(m.ex_payouts), ex_salary: tron(m.ex_salary), nr_suggested: tron(m.nr_suggested) });

        // Lõi gọi với CHÍNH mốc hiệu lực phải ra đúng balance_v1 (trừ trường marker: lõi không biết id dòng mốc).
        const doi = (await db.query<{ loi: Record<string, unknown>; ban: Record<string, unknown>; loi_moc: { id: string | null; settled_through_month: string } | null }>(`
          SELECT app_private.profit_ledger_balance_core_v1('${ORG_A}','${loai}','${chuThe}', mk.thang, mk.seq, mk.luc, ${thamSo(boPhieu, boKy)}) - 'marker' AS loi,
                 app_private.profit_ledger_balance_v1('${ORG_A}','${loai}','${chuThe}', ${thamSo(boPhieu, boKy)}) - 'marker' AS ban,
                 app_private.profit_ledger_balance_core_v1('${ORG_A}','${loai}','${chuThe}', mk.thang, mk.seq, mk.luc, ${thamSo(boPhieu, boKy)}) -> 'marker' AS loi_moc
            FROM (SELECT max(h.settled_through_month) AS thang, max(h.ledger_seq) AS seq, max(h.created_at) AS luc
                    FROM app_private.profit_ledger_active_marker_v1('${ORG_A}','${loai}','${chuThe}') h) mk`)).rows[0];
        expect(doi.loi, `lõi ≠ balance_v1 · kịch bản ${k} · ${loai}`).toEqual(doi.ban);
        expect(doi.loi_moc?.settled_through_month ?? null).toBe(m.marker_thang);
        expect(doi.loi_moc?.id ?? null).toBeNull();
      }

      // Mốc GIẢ ĐỊNH "đặt ngay bây giờ" (seq lớn nhất, giờ vô cực) == số dư thật sau khi đặt đúng mốc đó.
      // Điều kiện của quy ước: mọi phiếu hiện có được tạo TRƯỚC lúc đặt mốc. Bộ sinh cố ý có phiếu "giờ tạo ở
      // tương lai" (để thử nhánh so giờ của mốc cũ) ⇒ kéo chúng về quá khứ trước khi so.
      const X = xs(0.25) ? null : chon(THANG);
      const hieuLuc = moc.filter((x) => x.loai === loai && x.chuThe === chuThe).sort((a, b) => b.seq - a.seq)[0] ?? null;
      await db.exec("SAVEPOINT gia_dinh");
      try {
        await db.exec("UPDATE public.income_expenses SET created_at = '2020-01-01' WHERE created_at > clock_timestamp()");
        const giaDinh: Record<string, unknown>[] = [];
        for (const [boPhieu, boKy] of bo) {
          giaDinh.push(await mot<Record<string, unknown>>(`SELECT app_private.profit_ledger_balance_core_v1('${ORG_A}','${loai}','${chuThe}',
            ${X ? `'${X}'` : "NULL"}, 9223372036854775807, 'infinity', ${thamSo(boPhieu, boKy)}) - 'marker' AS v`));
        }
        await datMoc(loai, chuThe, X, hieuLuc?.id ?? null);
        for (const [i, [boPhieu, boKy]] of bo.entries()) {
          const that = await mot<Record<string, unknown>>(`SELECT app_private.profit_ledger_balance_v1('${ORG_A}','${loai}','${chuThe}', ${thamSo(boPhieu, boKy)}) - 'marker' AS v`);
          expect(giaDinh[i], `mốc giả định ${X} ≠ mốc thật · kịch bản ${k} · ${loai}`).toEqual(that);
          const ex = giaDinh[i].excluded_before_marker as { payouts: number };
          if (X !== null && Number(ex.payouts) !== 0) soGiaDinhLoaiPhieu++;
        }
        soGiaDinh++;
      } finally {
        await db.exec("ROLLBACK TO SAVEPOINT gia_dinh");
      }
    }
    return { coMoc: moc.some((m) => m.thang !== null), goMoc: moc.some((m) => m.thang === null), soPhieu: phieu.length, soLuong: luong.length };
  }
  const thamSo = (boPhieu: string | null, boKy: string | null) => `${boPhieu ? `'${boPhieu}'` : "NULL"}, ${boKy ? `'${boKy}'` : "NULL"}`;
  let soGiaDinh = 0;
  let soGiaDinhLoaiPhieu = 0;

  it("60 kịch bản ngẫu nhiên (phân bổ, phiếu, yêu cầu duyệt, dòng sổ, mốc, gỡ mốc, dòng lương): hàm khớp mô hình; lõi với mốc hiệu lực khớp balance_v1; mốc giả định khớp mốc thật", async () => {
    const tong = { coMoc: 0, goMoc: 0, soPhieu: 0, soLuong: 0 };
    for (let k = 1; k <= 60; k++) {
      const r = await trongGiaoDich(() => kichBan(k));
      tong.coMoc += r.coMoc ? 1 : 0; tong.goMoc += r.goMoc ? 1 : 0; tong.soPhieu += r.soPhieu; tong.soLuong += r.soLuong;
    }
    // Chống xanh rỗng: bộ sinh phải thật sự tạo ra đủ các loại tình huống.
    expect(tong.coMoc).toBeGreaterThan(20);
    expect(tong.goMoc).toBeGreaterThan(5);
    expect(tong.soPhieu).toBeGreaterThan(300);
    expect(tong.soLuong).toBeGreaterThan(60);
    expect(soGiaDinh).toBe(60 * 4);
    // Có đủ ca mốc giả định thật sự loại phiếu (nhánh ledger_seq / giờ tạo có việc để làm).
    expect(soGiaDinhLoaiPhieu).toBeGreaterThan(40);
  }, 180000);
});

describe("khoá sổ", () => {
  const khoaDangGiu = () => mot<number>("SELECT count(*)::int AS v FROM pg_locks WHERE locktype = 'advisory' AND pid = pg_backend_pid()");
  it("giữ đúng khoá tư vấn 'profit-ledger:<loại>:<công ty>:<chủ thể>' tới hết giao dịch", async () => {
    await trongGiaoDich(async () => {
      expect(await khoaDangGiu()).toBe(0);
      await db.exec(`SELECT app_private.profit_ledger_lock_v1('${ORG_A}','SHAREHOLDER','${CD1}')`);
      expect(await mot<boolean>(`SELECT EXISTS (SELECT 1 FROM pg_locks l WHERE l.locktype = 'advisory' AND l.pid = pg_backend_pid() AND l.granted
        AND ((l.classid::bigint << 32) | l.objid::bigint) = hashtextextended('profit-ledger:SHAREHOLDER:${ORG_A}:${CD1}', 0)) AS v`)).toBe(true);
      expect(await mot<boolean>(`SELECT app_private.profit_ledger_lock_held_v1('${ORG_A}','SHAREHOLDER','${CD1}') AS v`)).toBe(true);
      expect(await mot<boolean>(`SELECT app_private.profit_ledger_lock_held_v1('${ORG_A}','SHAREHOLDER','${CD2}') AS v`)).toBe(false);
      expect(await mot<boolean>(`SELECT app_private.profit_ledger_lock_held_v1('${ORG_A}','MANAGER','${CD1}') AS v`)).toBe(false);
    });
    expect(await khoaDangGiu()).toBe(0);
  });
  it("thiếu tham số hoặc loại lạ ⇒ 22023 (khoá với khoá NULL là không khoá gì)", async () => {
    await trongGiaoDich(async () => {
      expect(await maLoi(`SELECT app_private.profit_ledger_lock_v1(NULL,'SHAREHOLDER','${CD1}')`)).toBe("22023");
      expect(await maLoi(`SELECT app_private.profit_ledger_lock_v1('${ORG_A}',NULL,'${CD1}')`)).toBe("22023");
      expect(await maLoi(`SELECT app_private.profit_ledger_lock_v1('${ORG_A}','SHAREHOLDER',NULL)`)).toBe("22023");
      expect(await maLoi(`SELECT app_private.profit_ledger_lock_v1('${ORG_A}','KHAC','${CD1}')`)).toBe("22023");
      expect(await khoaDangGiu()).toBe(0);
    });
  });
});

describe("C1 — mốc: chỉ ghi thêm, một chuỗi thẳng cho mỗi chủ thể", () => {
  const chen = (o: { de?: string | null; seq?: string; thang?: string; lyDo?: string; cols?: string }) =>
    `INSERT INTO app_private.profit_ledger_markers(organization_id, subject_kind, shareholder_id, manager_id, settled_through_month, reason, supersedes_id, ledger_seq, created_by)
     VALUES ('${ORG_A}', ${o.cols ?? `'SHAREHOLDER','${CD1}',NULL`}, '${o.thang ?? "2026-08-01"}', '${o.lyDo ?? "Lý do đặt mốc đủ dài"}', ${o.de ? `'${o.de}'` : "NULL"}, ${o.seq ?? "nextval('app_private.profit_ledger_seq')"}, '${CHU}')`;
  it("không sửa, không xoá, không TRUNCATE", async () => {
    await trongGiaoDich(async () => {
      const m = await datMoc("SHAREHOLDER", CD1, "2026-08-01");
      expect(await maLoi(`UPDATE app_private.profit_ledger_markers SET settled_through_month = '2026-09-01' WHERE id = '${m}'`)).toBe("55000");
      expect(await maLoi(`UPDATE app_private.profit_ledger_markers SET reason = reason WHERE id = '${m}'`)).toBe("55000");
      expect(await maLoi(`DELETE FROM app_private.profit_ledger_markers WHERE id = '${m}'`)).toBe("55000");
      expect(await maLoi("TRUNCATE app_private.profit_ledger_markers CASCADE")).toBe("55000");
      expect(await mot<number>("SELECT count(*)::int AS v FROM app_private.profit_ledger_markers")).toBe(1);
    });
  });
  it("phải giữ khoá sổ của ĐÚNG chủ thể và dùng số thứ tự vừa lấy trong phiên", async () => {
    await trongGiaoDich(async () => {
      expect(await thongBaoLoi(chen({}))).toContain("PROFIT_LEDGER_NOT_SERIALIZED");
      await db.exec(`SELECT app_private.profit_ledger_lock_v1('${ORG_A}','SHAREHOLDER','${CD2}')`);
      expect(await thongBaoLoi(chen({}))).toContain("PROFIT_LEDGER_NOT_SERIALIZED");
      await db.exec(`SELECT app_private.profit_ledger_lock_v1('${ORG_A}','SHAREHOLDER','${CD1}')`);
      expect(await thongBaoLoi(chen({ seq: "1" }))).toContain("PROFIT_LEDGER_SEQ");
      expect(await thongBaoLoi(chen({ seq: "currval('app_private.profit_ledger_seq') + 1" }))).toContain("PROFIT_LEDGER_SEQ");
      expect(await maLoi(chen({}))).toBeNull();
    });
  });
  it("mốc thứ hai phải đè lên mốc cuối của chính chủ thể đó: không đè ⇒ 23505, đè mốc đã bị đè ⇒ 23505, đè mốc của người khác ⇒ 23503", async () => {
    await trongGiaoDich(async () => {
      const m1 = await datMoc("SHAREHOLDER", CD1, "2026-07-01");
      expect(await maLoi(chen({}))).toBe("23505");
      const m2 = await datMoc("SHAREHOLDER", CD1, "2026-08-01", m1);
      expect(await maLoi(chen({ de: m1 }))).toBe("23505");
      const cuaNguoiKhac = await datMoc("SHAREHOLDER", CD2, "2026-07-01");
      expect(await maLoi(chen({ de: cuaNguoiKhac }))).toBe("23503");
      expect(await maLoi(chen({ de: m2 }))).toBeNull();
    });
  });
  it("giờ tạo do máy chủ đặt, không nhận giá trị truyền vào", async () => {
    await trongGiaoDich(async () => {
      await db.exec(`SELECT app_private.profit_ledger_lock_v1('${ORG_A}','SHAREHOLDER','${CD1}')`);
      const lech = await mot<number>(`INSERT INTO app_private.profit_ledger_markers(organization_id, subject_kind, shareholder_id, settled_through_month, reason, ledger_seq, created_by, created_at)
        VALUES ('${ORG_A}','SHAREHOLDER','${CD1}','2026-08-01','Lý do đặt mốc đủ dài', nextval('app_private.profit_ledger_seq'), '${CHU}', '2020-01-01')
        RETURNING abs(extract(epoch FROM clock_timestamp() - created_at))::float8 AS v`);
      expect(lech).toBeLessThan(60);
    });
  });
  it("ràng buộc dòng: đúng một chủ thể khớp loại, tháng là ngày 1, lý do 8..1000 ký tự, chủ thể phải thuộc công ty", async () => {
    await trongGiaoDich(async () => {
      await db.exec(`SELECT app_private.profit_ledger_lock_v1('${ORG_A}','SHAREHOLDER','${CD1}'); SELECT app_private.profit_ledger_lock_v1('${ORG_A}','MANAGER','${QL1}');
        SELECT app_private.profit_ledger_lock_v1('${ORG_A}','SHAREHOLDER','${CD_B}'); SELECT app_private.profit_ledger_lock_v1('${ORG_A}','SHAREHOLDER','${QL1}')`);
      expect(await maLoi(chen({ cols: `'SHAREHOLDER','${CD1}','${QL1}'` }))).toBe("23514");
      expect(await maLoi(chen({ cols: `'MANAGER','${QL1}',NULL` }))).toBe("23514");
      expect(await maLoi(chen({ thang: "2026-08-15" }))).toBe("23514");
      expect(await maLoi(chen({ lyDo: "ngắn" }))).toBe("23514");
      expect(await maLoi(chen({ lyDo: "x".repeat(1001) }))).toBe("23514");
      expect(await maLoi(chen({ cols: `'SHAREHOLDER','${CD_B}',NULL` }))).toBe("23503");
      expect(await maLoi(chen({ cols: `'SHAREHOLDER','${QL1}',NULL` }))).toBe("23503");
      expect(await maLoi(chen({ cols: `'MANAGER',NULL,'${QL1}'` }))).toBeNull();
    });
  });
});

describe("thứ tự sổ: không dòng nào dùng lại số đã có của chủ thể (C1 ∪ C2)", () => {
  const DUNG_LAI = "không dùng lại số cũ";
  const chenPhieu = (phieu: string, loai: Loai, chuThe: string, soTien: number, seq: string) =>
    thongBaoLoi(`INSERT INTO app_private.profit_ledger_payouts(voucher_id, organization_id, subject_kind, shareholder_id, manager_id, account_id, amount,
        balance_before, within_amount, advance_amount, maker_user_id, maker_membership_id, maker_kind, payee_is_maker, ledger_seq)
      VALUES ('${phieu}','${ORG_A}','${loai}', ${cot(loai, chuThe)}, '${SO_QUY}', ${soTien}, 0, ${soTien}, 0, '${CHU}','${mem(CHU)}','OWNER', false, ${seq})`);
  const chenMoc = (loai: Loai, chuThe: string, de: string | null, seq: string) =>
    thongBaoLoi(`INSERT INTO app_private.profit_ledger_markers(organization_id, subject_kind, shareholder_id, manager_id, settled_through_month, reason, supersedes_id, ledger_seq, created_by)
      VALUES ('${ORG_A}','${loai}', ${cot(loai, chuThe)}, '2026-09-01', 'Lý do đặt mốc đủ dài', ${de ? `'${de}'` : "NULL"}, ${seq}, '${CHU}')`);
  const CURRVAL = "currval('app_private.profit_ledger_seq')";
  const NEXTVAL = "nextval('app_private.profit_ledger_seq')";

  it("phiếu chi mang lại currval của mốc vừa đặt ⇒ 55000 (nếu lọt, phiếu lập SAU mốc bị coi là trước mốc và không trừ)", async () => {
    await trongGiaoDich(async () => {
      await taoPhieu({ id: id(1001), soTien: 10, coDong: CD1, trangThai: "UNAPPROVED" });
      await db.exec(`INSERT INTO app_private.profit_ledger_write_contexts(income_expense_id, purpose) VALUES ('${id(1001)}', 'CREATE')`);
      await datMoc("SHAREHOLDER", CD1, "2026-08-01");
      expect(await chenPhieu(id(1001), "SHAREHOLDER", CD1, 10, CURRVAL)).toContain(DUNG_LAI);
      expect(await chenPhieu(id(1001), "SHAREHOLDER", CD1, 10, NEXTVAL)).toBe("");
      expect(await soDu("SHAREHOLDER", CD1)).toMatchObject({ payouts_pending: 10, balance: 30 - 10 });
    });
  });
  it("mốc mang lại currval của phiếu chi vừa ghi ⇒ 55000 (cổ đông và lương điều hành)", async () => {
    await trongGiaoDich(async () => {
      await taoPhieu({ id: id(1001), soTien: 10, coDong: CD1, trangThai: "UNAPPROVED" });
      await ghiDongPhieu(id(1001), "SHAREHOLDER", CD1, 10);
      expect(await chenMoc("SHAREHOLDER", CD1, null, CURRVAL)).toContain(DUNG_LAI);
      expect(await chenMoc("SHAREHOLDER", CD1, null, NEXTVAL)).toBe("");

      await taoPhieu({ id: id(1002), soTien: 6, quanLy: QL1 });
      await ghiDongPhieu(id(1002), "MANAGER", QL1, 6);
      expect(await chenMoc("MANAGER", QL1, null, CURRVAL)).toContain(DUNG_LAI);
      expect(await chenMoc("MANAGER", QL1, null, NEXTVAL)).toBe("");
    });
  });
  it("số vừa lấy NHỎ hơn số đã có của chủ thể (phiên khác ghi sau khi phiên này lấy số — sai nghi thức khoá) ⇒ 55000; chủ thể khác không bị ràng buộc", async () => {
    await trongGiaoDich(async () => {
      await taoPhieu({ id: id(1001), soTien: 5, coDong: CD1, trangThai: "UNAPPROVED" });
      await db.exec(`INSERT INTO app_private.profit_ledger_write_contexts(income_expense_id, purpose) VALUES ('${id(1001)}', 'CREATE')`);
      const n = Number(await mot<string>(`SELECT ${NEXTVAL}::text AS v`));
      // Giả lập dòng mốc của phiên khác mang số lớn hơn (tắt trigger bằng vai chủ bảng, chỉ trong giao dịch này).
      await db.exec(`ALTER TABLE app_private.profit_ledger_markers DISABLE TRIGGER a00_profit_ledger_markers_guard;
        INSERT INTO app_private.profit_ledger_markers(organization_id, subject_kind, shareholder_id, settled_through_month, reason, ledger_seq, created_by)
          VALUES ('${ORG_A}','SHAREHOLDER','${CD1}','2026-07-01','Mốc do phiên khác đặt', ${n + 1000}, '${CHU}');
        ALTER TABLE app_private.profit_ledger_markers ENABLE TRIGGER a00_profit_ledger_markers_guard;
        SELECT app_private.profit_ledger_lock_v1('${ORG_A}','SHAREHOLDER','${CD1}');
        SELECT app_private.profit_ledger_lock_v1('${ORG_A}','SHAREHOLDER','${CD2}');`);
      expect(await chenPhieu(id(1001), "SHAREHOLDER", CD1, 5, CURRVAL)).toContain(DUNG_LAI);
      // CD2 không có dòng nào: mốc của CD2 dùng số thấp hơn mốc của CD1 vẫn được (thứ tự chỉ so trong một chủ thể).
      expect(await chenMoc("SHAREHOLDER", CD2, null, CURRVAL)).toBe("");
    });
  });
});

describe("C2 — dòng phiếu chi: chỉ lệnh lập ghi được, sau đó bất biến", () => {
  const P = id(1001);
  const chen = (o: { phieu?: string; soTien?: number; trong?: number; tamUng?: number; loai?: string; nguoiLap?: string; nhanLaLap?: boolean; nguoiNhan?: string | null; chuThe?: string; soQuy?: string } = {}) =>
    `INSERT INTO app_private.profit_ledger_payouts(voucher_id, organization_id, subject_kind, shareholder_id, manager_id, account_id, amount, balance_before, within_amount, advance_amount,
       maker_user_id, maker_membership_id, maker_kind, payee_is_maker, payee_user_id, ledger_seq)
     VALUES ('${o.phieu ?? P}','${ORG_A}', ${o.chuThe ?? `'SHAREHOLDER','${CD1}',NULL`}, '${o.soQuy ?? SO_QUY}', ${o.soTien ?? 10}, 0, ${o.trong ?? 10}, ${o.tamUng ?? 0},
       '${CHU}','${mem(CHU)}','${o.loai ?? "OWNER"}', ${o.nhanLaLap ?? false}, ${o.nguoiNhan ? `'${o.nguoiNhan}'` : "NULL"}, nextval('app_private.profit_ledger_seq'))`;
  const moNguCanh = (phieu = P, mucDich = "CREATE") =>
    db.exec(`INSERT INTO app_private.profit_ledger_write_contexts(income_expense_id, purpose) VALUES ('${phieu}', '${mucDich}')`);
  const khoa = (loai: Loai = "SHAREHOLDER", chuThe = CD1) => db.exec(`SELECT app_private.profit_ledger_lock_v1('${ORG_A}','${loai}','${chuThe}')`);

  it("thiếu ngữ cảnh lập, ngữ cảnh là CANCEL, hoặc chưa giữ khoá sổ ⇒ 55000", async () => {
    await trongGiaoDich(async () => {
      await taoPhieu({ id: P, soTien: 10, coDong: CD1, trangThai: "UNAPPROVED" });
      expect(await thongBaoLoi(chen())).toContain("PROFIT_LEDGER_NOT_SERIALIZED");
      await khoa();
      expect(await thongBaoLoi(chen())).toContain("PROFIT_LEDGER_CONTEXT");
      await moNguCanh(P, "CANCEL");
      expect(await thongBaoLoi(chen())).toContain("PROFIT_LEDGER_CONTEXT");
      await db.exec("DELETE FROM app_private.profit_ledger_write_contexts");
      await moNguCanh(id(1002));
      expect(await thongBaoLoi(chen())).toContain("PROFIT_LEDGER_CONTEXT");
      await moNguCanh(P);
      expect(await maLoi(chen())).toBeNull();
    });
  });
  it("dòng sổ phải khớp phiếu thật: người nhận, số tiền, sổ quỹ, loại phiếu, chưa xoá", async () => {
    await trongGiaoDich(async () => {
      await taoPhieu({ id: P, soTien: 10, coDong: CD1, trangThai: "UNAPPROVED" });
      await taoPhieu({ id: id(1002), soTien: 10, coDong: CD1, loai: "INCOME" });
      await taoPhieu({ id: id(1003), soTien: 10, coDong: CD1, daXoa: true });
      await taoPhieu({ id: id(1004), soTien: 10, coDong: CD2 });
      for (const p of [P, id(1002), id(1003), id(1004)]) await moNguCanh(p);
      await khoa();
      const loi = "PROFIT_LEDGER_VOUCHER_MISMATCH";
      expect(await thongBaoLoi(chen({ soTien: 9, trong: 9 }))).toContain(loi);
      expect(await thongBaoLoi(chen({ soQuy: id(999) }))).toContain(loi);
      expect(await thongBaoLoi(chen({ phieu: id(1002) }))).toContain(loi);
      expect(await thongBaoLoi(chen({ phieu: id(1003) }))).toContain(loi);
      expect(await thongBaoLoi(chen({ phieu: id(1004) }))).toContain(loi);
      await khoa("MANAGER", QL1);
      expect(await thongBaoLoi(chen({ chuThe: `'MANAGER',NULL,'${QL1}'` }))).toContain(loi);
      expect(await maLoi(chen())).toBeNull();
    });
  });
  it("ràng buộc tiền và người: trong + tạm ứng = số tiền; lương điều hành không tạm ứng; người giữ sổ chỉ chi cho chính mình; cờ người-nhận-là-người-lập phải đúng", async () => {
    await trongGiaoDich(async () => {
      await taoPhieu({ id: P, soTien: 10, coDong: CD1, trangThai: "UNAPPROVED" });
      await taoPhieu({ id: id(1002), soTien: 10, quanLy: QL1, trangThai: "UNAPPROVED" });
      await moNguCanh(P); await moNguCanh(id(1002)); await khoa(); await khoa("MANAGER", QL1);
      expect(await maLoi(chen({ trong: 6, tamUng: 3 }))).toBe("23514");
      expect(await maLoi(chen({ trong: 11, tamUng: -1 }))).toBe("23514");
      expect(await maLoi(chen({ phieu: id(1002), chuThe: `'MANAGER',NULL,'${QL1}'`, trong: 6, tamUng: 4 }))).toBe("23514");
      expect(await maLoi(chen({ loai: "CUSTODIAN_ADVANCE" }))).toBe("23514");
      expect(await maLoi(chen({ nhanLaLap: true }))).toBe("23514");
      expect(await maLoi(chen({ nhanLaLap: true, nguoiNhan: QUAN_LY }))).toBe("23514");
      expect(await maLoi(chen({ nhanLaLap: false, nguoiNhan: CHU }))).toBe("23514");
      expect(await maLoi(chen({ loai: "KHAC" }))).toBe("23514");
      expect(await maLoi(chen({ phieu: id(1002), chuThe: `'MANAGER',NULL,'${QL1}'`, loai: "CUSTODIAN_ADVANCE", nhanLaLap: true, nguoiNhan: CHU }))).toBe("23514");
      expect(await maLoi(chen({ loai: "CUSTODIAN_ADVANCE", nhanLaLap: true, nguoiNhan: CHU, trong: 4, tamUng: 6 }))).toBeNull();
      expect(await maLoi(chen({ phieu: id(1002), chuThe: `'MANAGER',NULL,'${QL1}'` }))).toBeNull();
    });
  });
  it("sau khi chèn: chỉ điền approval_request_id đúng MỘT lần, trong ngữ cảnh lập, bằng yêu cầu duyệt của chính phiếu đó", async () => {
    await trongGiaoDich(async () => {
      await taoPhieu({ id: P, soTien: 10, coDong: CD1, trangThai: "UNAPPROVED" });
      await taoPhieu({ id: id(1002), soTien: 10, coDong: CD1, trangThai: "UNAPPROVED" });
      await db.exec(`INSERT INTO public.approval_requests(id, organization_id, subject_type, subject_id, state) VALUES
        ('${id(2001)}','${ORG_A}','FINANCIAL_VOUCHER','${P}','PENDING_APPROVAL'), ('${id(2002)}','${ORG_A}','FINANCIAL_VOUCHER','${id(1002)}','PENDING_APPROVAL')`);
      await moNguCanh(); await khoa();
      await db.exec(chen());
      const dien = (yc: string, them = "") => `UPDATE app_private.profit_ledger_payouts SET approval_request_id = '${yc}'${them} WHERE voucher_id = '${P}'`;
      expect(await maLoi(dien(id(2002)))).toBe("55000");
      expect(await maLoi(dien(id(2001), ", amount = 9, within_amount = 9"))).toBe("55000");
      expect(await maLoi(dien(id(2001), ", payee_user_id = maker_user_id, payee_is_maker = true"))).toBe("55000");
      await db.exec("DELETE FROM app_private.profit_ledger_write_contexts");
      expect(await maLoi(dien(id(2001)))).toBe("55000");
      await moNguCanh(P, "CANCEL");
      expect(await maLoi(dien(id(2001)))).toBe("55000");
      await db.exec("DELETE FROM app_private.profit_ledger_write_contexts");
      await moNguCanh();
      expect(await maLoi(dien(id(2001)))).toBeNull();
      expect(await maLoi(dien(id(2001)))).toBe("55000");
      expect(await maLoi(`UPDATE app_private.profit_ledger_payouts SET approval_request_id = NULL WHERE voucher_id = '${P}'`)).toBe("55000");
      expect(await maLoi(`DELETE FROM app_private.profit_ledger_payouts WHERE voucher_id = '${P}'`)).toBe("55000");
      expect(await maLoi("TRUNCATE app_private.profit_ledger_payouts")).toBe("55000");
    });
  });
  it("phiếu đã có dòng sổ thì không xoá cứng được (khoá ngoại RESTRICT)", async () => {
    await trongGiaoDich(async () => {
      await taoPhieu({ id: P, soTien: 10, coDong: CD1, trangThai: "UNAPPROVED" });
      await ghiDongPhieu(P, "SHAREHOLDER", CD1, 10);
      expect(MA_CHAN_XOA).toContain(await maLoi(`DELETE FROM public.income_expenses WHERE id = '${P}'`));
    });
  });
});

describe("C6 — ngữ cảnh ghi theo giao dịch", () => {
  const P = id(1001);
  const nguCanh = () => mot<string | null>(`SELECT app_private.profit_ledger_write_context_v1('${P}') AS v`);
  it("chỉ thấy ngữ cảnh do CHÍNH giao dịch này mở; giá trị giao dịch / phiên truyền vào bị ghi đè", async () => {
    await trongGiaoDich(async () => {
      expect(await nguCanh()).toBeNull();
      await db.exec(`INSERT INTO app_private.profit_ledger_write_contexts(income_expense_id, purpose, xid, backend_pid) VALUES ('${P}', 'CANCEL', '1'::xid8, 1)`);
      expect(await nguCanh()).toBe("CANCEL");
      expect(await maLoi(`INSERT INTO app_private.profit_ledger_write_contexts(income_expense_id, purpose) VALUES ('${P}', 'CREATE')`)).toBe("23505");
      expect(await maLoi(`UPDATE app_private.profit_ledger_write_contexts SET purpose = 'CREATE'`)).toBe("55000");
      expect(await maLoi(`INSERT INTO app_private.profit_ledger_write_contexts(income_expense_id, purpose) VALUES ('${id(1002)}', 'KHAC')`)).toBe("23514");
      await db.exec("DELETE FROM app_private.profit_ledger_write_contexts");
      expect(await nguCanh()).toBeNull();
    });
  });
  it("dòng ngữ cảnh sót lại của giao dịch KHÁC không có hiệu lực", async () => {
    await db.exec(`INSERT INTO app_private.profit_ledger_write_contexts(income_expense_id, purpose) VALUES ('${P}', 'CREATE')`);
    try {
      expect(await nguCanh()).toBeNull();
      await trongGiaoDich(async () => {
        await taoPhieu({ id: P, soTien: 10, coDong: CD1 });
        expect(await nguCanh()).toBeNull();
      });
    } finally { await db.exec("DELETE FROM app_private.profit_ledger_write_contexts"); }
  });
});

describe("C3 — phần lợi nhuận trong lương tháng: bất biến, chỉ FROZEN → VOID", () => {
  it("sinh ra ở FROZEN; mỗi (công ty, cổ đông, tháng) chỉ một bản FROZEN; huỷ rồi mới tạo lại được", async () => {
    await trongGiaoDich(async () => {
      const a = await taoDongBang({ thang: "2026-09-01", y: 30, d: 10 });
      expect(await maLoi(`INSERT INTO app_private.profit_ledger_salary_settlements(organization_id, shareholder_id, staff_id, period_month, investment_month) VALUES ('${ORG_A}','${CD1}','${CHU}','2026-09-01', 5)`)).toBe("23505");
      expect(await maLoi(`INSERT INTO app_private.profit_ledger_salary_settlements(organization_id, shareholder_id, staff_id, period_month, investment_month, state, voided_at, void_reason) VALUES ('${ORG_A}','${CD1}','${CHU}','2026-08-01', 5, 'VOID', now(), 'x')`)).toBe("55000");
      expect(await maLoi(`UPDATE app_private.profit_ledger_salary_settlements SET state = 'VOID', voided_at = now(), void_reason = 'chốt lại' WHERE id = '${a}'`)).toBeNull();
      expect(await taoDongBang({ thang: "2026-09-01", y: 31, d: 0 })).not.toBe(a);
    });
  });
  it("không sửa số, không huỷ kèm sửa số, không quay lại FROZEN, không xoá, không TRUNCATE", async () => {
    await trongGiaoDich(async () => {
      const a = await taoDongBang({ thang: "2026-09-01", y: 30, d: 10 });
      const sua = (set: string) => maLoi(`UPDATE app_private.profit_ledger_salary_settlements SET ${set} WHERE id = '${a}'`);
      expect(await sua("investment_month = 99")).toBe("55000");
      expect(await sua("advance_offset_month = 0")).toBe("55000");
      expect(await sua("state = 'VOID', voided_at = now(), void_reason = 'x', investment_month = 99")).toBe("55000");
      expect(await sua("state = 'VOID', voided_at = now(), void_reason = 'x', allocation_snapshot = '[1]'")).toBe("55000");
      expect(await sua("state = 'VOID'")).toBe("23514");
      expect(await sua("state = 'VOID', voided_at = now(), void_reason = 'chốt lại'")).toBeNull();
      expect(await sua("state = 'FROZEN', voided_at = NULL, void_reason = NULL")).toBe("55000");
      expect(await sua("void_reason = 'đổi lý do'")).toBe("55000");
      expect(await maLoi(`DELETE FROM app_private.profit_ledger_salary_settlements WHERE id = '${a}'`)).toBe("55000");
      expect(await maLoi("TRUNCATE app_private.profit_ledger_salary_settlements CASCADE")).toBe("55000");
    });
  });
  it("phần trừ tạm ứng của tháng: không âm, không vượt phần lợi nhuận của tháng; tháng lỗ thì không được trừ", async () => {
    await trongGiaoDich(async () => {
      const chen = (y: number, d: number, thang = "2026-09-01") => maLoi(`INSERT INTO app_private.profit_ledger_salary_settlements(organization_id, shareholder_id, staff_id, period_month, investment_month, advance_offset_month)
        VALUES ('${ORG_A}','${CD1}','${CHU}','${thang}', ${y}, ${d})`);
      expect(await chen(30, 31)).toBe("23514");
      expect(await chen(30, -1)).toBe("23514");
      expect(await chen(-5, 1)).toBe("23514");
      expect(await chen(30, 30, "2026-09-15")).toBe("23514");
      expect(await chen(-5, 0, "2026-08-01")).toBeNull();
      expect(await chen(30, 30)).toBeNull();
    });
  });

  // Đóng băng lại một tháng mà lương đã trả CÓ trừ tạm ứng: D_m phải bằng được phần đã trừ thật,
  // nếu không việc đóng băng lại (và chốt lương) bị chặn.
  const chenBang = (y: number, d: number, them = "", thang = "2026-09-01", coDong = CD1) =>
    maLoi(`INSERT INTO app_private.profit_ledger_salary_settlements(organization_id, shareholder_id, staff_id, period_month, investment_month, advance_offset_month${them ? ", applied_offset_at_freeze" : ""})
      VALUES ('${ORG_A}','${coDong}','${CHU}','${thang}', ${y}, ${d}${them ? `, ${them}` : ""})`);
  const huyBang = () => db.exec(`UPDATE app_private.profit_ledger_salary_settlements SET state = 'VOID', voided_at = now(), void_reason = 'đóng băng lại'
    WHERE state = 'FROZEN' AND organization_id = '${ORG_A}' AND shareholder_id = '${CD1}' AND period_month = '2026-09-01'`);
  const daTru = () => mot<number>(`SELECT applied_offset_at_freeze::float8 AS v FROM app_private.profit_ledger_salary_settlements
    WHERE state = 'FROZEN' AND organization_id = '${ORG_A}' AND shareholder_id = '${CD1}' AND period_month = '2026-09-01'`);

  it("lương đã trả có trừ tạm ứng, sau đó lợi nhuận tháng chốt lại THẤP hơn (kể cả lỗ): đóng băng lại với D_m = phần đã trừ thật vẫn được", async () => {
    await trongGiaoDich(async () => {
      await taoPhieu({ id: id(1001), soTien: 50 });
      await taoPhieu({ id: id(1002), soTien: 50 });
      expect(await chenBang(30, 12)).toBeNull();
      await taoDongLuong({ phieuLuong: id(1001), thang: "2026-09-01", y: 20, d: 8, trangThai: "LINKED" });
      await taoDongLuong({ phieuLuong: id(1002), thang: "2026-09-01", y: 10, d: 4, trangThai: "LINKED" });
      // Mở chốt rồi chốt lại: phần lợi nhuận của tháng chỉ còn 4 (rồi -5), nhưng hai phiếu lương đã trừ 12.
      await huyBang();
      expect(await chenBang(4, 12)).toBeNull();
      expect(await daTru()).toBe(12);
      await huyBang();
      expect(await chenBang(-5, 12)).toBeNull();
      expect(await daTru()).toBe(12);
      await huyBang();
      expect(await chenBang(4, 4)).toBeNull();
    });
  });
  it("vượt CẢ HAI trần (phần lợi nhuận tháng và phần đã trừ thật) ⇒ 23514", async () => {
    await trongGiaoDich(async () => {
      await taoPhieu({ id: id(1001), soTien: 50 });
      await taoDongLuong({ phieuLuong: id(1001), thang: "2026-09-01", y: 20, d: 12, trangThai: "LINKED" });
      expect(await chenBang(4, 13)).toBe("23514");
      expect(await chenBang(-5, 13)).toBe("23514");
      expect(await chenBang(20, 21)).toBe("23514");
      expect(await chenBang(20, -1)).toBe("23514");
      expect(await chenBang(20, 20)).toBeNull();
    });
  });
  it("phần đã trừ do máy chủ tính, không nhận giá trị truyền vào: chỉ dòng LINKED có phiếu lương còn sống, đúng cổ đông, đúng tháng", async () => {
    await trongGiaoDich(async () => {
      for (let i = 1; i <= 5; i++) await taoPhieu({ id: id(1000 + i), soTien: 50 });
      await taoPhieu({ id: id(1006), soTien: 50, trangThai: "CANCELLED" });
      await taoDongLuong({ phieuLuong: id(1001), thang: "2026-09-01", y: 20, d: 12, trangThai: "LINKED" });
      await taoDongLuong({ phieuLuong: id(1006), thang: "2026-09-01", y: 20, d: 5, trangThai: "LINKED" });
      await taoDongLuong({ phieuLuong: id(1002), thang: "2026-09-01", y: 0, d: 7, trangThai: "NEEDS_REVIEW" });
      await taoDongLuong({ phieuLuong: id(1003), thang: "2026-08-01", y: 9, d: 3, trangThai: "LINKED" });
      await taoDongLuong({ phieuLuong: id(1004), thang: "2026-09-01", y: 9, d: 4, trangThai: "LINKED", coDong: CD2 });
      await taoDongLuong({ thang: "2026-09-01", y: 9, d: 6, trangThai: "QUOTED" });
      // Khai 999 để nới trần: bị bỏ qua, máy chủ tính 12.
      expect(await chenBang(4, 13, "999")).toBe("23514");
      expect(await chenBang(4, 12, "999")).toBeNull();
      expect(await daTru()).toBe(12);
      // Khai thấp hơn thực tế cũng bị bỏ qua (không làm trần hẹp sai).
      await huyBang();
      expect(await chenBang(4, 12, "0")).toBeNull();
      expect(await daTru()).toBe(12);
      // Phiếu lương thứ hai bị huỷ ⇒ phần đã trừ của nó không còn tính.
      await huyBang();
      await db.exec(`UPDATE public.income_expenses SET approval_status = 'CANCELLED' WHERE id = '${id(1001)}'`);
      expect(await chenBang(4, 5)).toBe("23514");
      expect(await chenBang(4, 4)).toBeNull();
      expect(await daTru()).toBe(0);
    });
  });
  it("huỷ bản đóng băng không đổi được phần đã trừ", async () => {
    await trongGiaoDich(async () => {
      await taoPhieu({ id: id(1001), soTien: 50 });
      await taoDongLuong({ phieuLuong: id(1001), thang: "2026-09-01", y: 20, d: 12, trangThai: "LINKED" });
      expect(await chenBang(4, 12)).toBeNull();
      expect(await maLoi(`UPDATE app_private.profit_ledger_salary_settlements SET state = 'VOID', voided_at = now(), void_reason = 'x', applied_offset_at_freeze = 0
        WHERE organization_id = '${ORG_A}' AND period_month = '2026-09-01'`)).toBe("55000");
      expect(await maLoi(`UPDATE app_private.profit_ledger_salary_settlements SET applied_offset_at_freeze = 50
        WHERE organization_id = '${ORG_A}' AND period_month = '2026-09-01'`)).toBe("55000");
    });
  });
});

describe("C4 — phần lợi nhuận trong từng phiếu lương: máy trạng thái", () => {
  const sua = (dong: string, set: string) => maLoi(`UPDATE app_private.profit_ledger_salary_settlement_vouchers SET ${set} WHERE id = '${dong}'`);
  it("QUOTED → LINKED gắn phiếu lương và chốt lại số; LINKED rồi thì không đổi gì nữa", async () => {
    await trongGiaoDich(async () => {
      await taoPhieu({ id: id(1001), soTien: 50 });
      const q = await taoDongLuong({ thang: "2026-09-01", y: 33, d: 3, trangThai: "QUOTED" });
      expect(await sua(q, "state = 'LINKED', linked_at = now()")).toBe("23514");
      expect(await sua(q, `state = 'LINKED', linked_at = now(), salary_voucher_id = '${id(1001)}', period_month = '2026-08-01'`)).toBe("55000");
      expect(await sua(q, `state = 'LINKED', linked_at = now(), salary_voucher_id = '${id(1001)}', shareholder_id = '${CD2}'`)).toBe("55000");
      expect(await sua(q, `state = 'LINKED', linked_at = now(), salary_voucher_id = '${id(1001)}', source = 'BACKFILL'`)).toBe("55000");
      expect(await sua(q, `state = 'LINKED', linked_at = now(), salary_voucher_id = '${id(1001)}', investment_amount = 30, advance_offset_amount = 2`)).toBeNull();
      expect((await soDu("SHAREHOLDER", CD1)).balance).toBe(CD1_GOC - 28);
      expect(await sua(q, "investment_amount = 0")).toBe("55000");
      expect(await sua(q, "state = 'VOID', voided_at = now(), void_reason = 'x', salary_voucher_id = NULL, linked_at = NULL")).toBe("55000");
      expect(await sua(q, "state = 'NEEDS_REVIEW', linked_at = NULL")).toBe("55000");
      expect(await maLoi(`DELETE FROM app_private.profit_ledger_salary_settlement_vouchers WHERE id = '${q}'`)).toBe("55000");
      expect(await maLoi("TRUNCATE app_private.profit_ledger_salary_settlement_vouchers")).toBe("55000");
    });
  });
  it("QUOTED → VOID chỉ đổi ba cột huỷ; VOID rồi không sống lại; mỗi (nhân viên, tháng) chỉ một báo giá đang chờ", async () => {
    await trongGiaoDich(async () => {
      const q = await taoDongLuong({ thang: "2026-09-01", y: 33, trangThai: "QUOTED" });
      expect(await thongBaoLoi(`INSERT INTO app_private.profit_ledger_salary_settlement_vouchers(organization_id, shareholder_id, staff_id, period_month, payout_request_key, sheet_status_at_quote, source, state)
        VALUES ('${ORG_A}','${CD1}','${CHU}','2026-09-01','khoa-tra-luong-0002','DRAFT','UI_QUOTE','QUOTED')`)).toContain("23505");
      expect(await sua(q, "state = 'VOID', voided_at = now(), void_reason = 'x', investment_amount = 0")).toBe("55000");
      expect(await sua(q, "state = 'VOID', voided_at = now()")).toBe("23514");
      expect(await sua(q, "investment_amount = 1")).toBe("55000");
      expect(await sua(q, "state = 'VOID', voided_at = now(), void_reason = 'có báo giá mới'")).toBeNull();
      expect(await sua(q, "state = 'QUOTED', voided_at = NULL, void_reason = NULL")).toBe("55000");
      expect(await taoDongLuong({ thang: "2026-09-01", y: 20, trangThai: "QUOTED" })).not.toBe(q);
    });
  });
  it("NEEDS_REVIEW → LINKED chỉ khi chủ xác nhận (OWNER_RESOLVE, có người, giờ, lý do 8..1000); không đổi được phiếu lương", async () => {
    await trongGiaoDich(async () => {
      await taoPhieu({ id: id(1001), soTien: 50 });
      await taoPhieu({ id: id(1002), soTien: 50 });
      const n = await taoDongLuong({ phieuLuong: id(1001), thang: "2026-09-01", y: 0, trangThai: "NEEDS_REVIEW", goiY: 12 });
      const xacNhan = "state = 'LINKED', linked_at = now(), investment_amount = 12, advance_offset_amount = 2";
      expect(await sua(n, xacNhan)).toBe("55000");
      expect(await sua(n, `${xacNhan}, source = 'OWNER_RESOLVE'`)).toBe("23514");
      expect(await sua(n, `${xacNhan}, source = 'OWNER_RESOLVE', resolved_by = '${CHU}', resolved_at = now(), resolve_reason = 'ngắn'`)).toBe("23514");
      expect(await sua(n, `${xacNhan}, source = 'OWNER_RESOLVE', resolved_by = '${CHU}', resolved_at = now(), resolve_reason = 'Chủ đã đối chiếu bảng lương', salary_voucher_id = '${id(1002)}'`)).toBe("55000");
      expect(await sua(n, "state = 'VOID', voided_at = now(), void_reason = 'x', salary_voucher_id = NULL")).toBe("55000");
      expect((await soDu("SHAREHOLDER", CD1)).needs_review).toEqual({ count: 1, suggested: 12 });
      expect(await sua(n, `${xacNhan}, source = 'OWNER_RESOLVE', resolved_by = '${CHU}', resolved_at = now(), resolve_reason = 'Chủ đã đối chiếu bảng lương'`)).toBeNull();
      expect(await soDu("SHAREHOLDER", CD1)).toMatchObject({ balance: CD1_GOC - 10, needs_review: { count: 0, suggested: 0 } });
    });
  });
  it("chèn: không sinh ra ở VOID hay từ OWNER_RESOLVE; LINKED / NEEDS_REVIEW phải có phiếu lương; một phiếu lương chỉ một dòng; phần trừ tạm ứng không âm", async () => {
    await trongGiaoDich(async () => {
      await taoPhieu({ id: id(1001), soTien: 50 });
      const chen = (cols: string, vals: string) => maLoi(`INSERT INTO app_private.profit_ledger_salary_settlement_vouchers(organization_id, shareholder_id, staff_id, period_month, sheet_status_at_quote, ${cols})
        VALUES ('${ORG_A}','${CD1}','${CHU}','2026-09-01','LOCKED', ${vals})`);
      expect(await chen("source, state, voided_at, void_reason", "'PAYOUT_FALLBACK','VOID', now(), 'x'")).toBe("55000");
      expect(await chen("source, state, salary_voucher_id, linked_at, resolved_by, resolved_at, resolve_reason", `'OWNER_RESOLVE','LINKED','${id(1001)}', now(), '${CHU}', now(), 'Chủ đã đối chiếu bảng lương'`)).toBe("55000");
      expect(await chen("source, state, linked_at", "'PAYOUT_FALLBACK','LINKED', now()")).toBe("23514");
      expect(await chen("source, state", "'PAYOUT_FALLBACK','NEEDS_REVIEW'")).toBe("23514");
      expect(await chen("source, state, payout_request_key, salary_voucher_id", `'UI_QUOTE','QUOTED','khoa-tra-luong-0003','${id(1001)}'`)).toBe("23514");
      expect(await chen("source, state, salary_voucher_id, linked_at, advance_offset_amount", `'BACKFILL','LINKED','${id(1001)}', now(), -1`)).toBe("23514");
      expect(await chen("source, state, salary_voucher_id, linked_at, investment_amount", `'BACKFILL','LINKED','${id(1001)}', now(), -4`)).toBeNull();
      expect(await chen("source, state, salary_voucher_id", `'PAYOUT_FALLBACK','NEEDS_REVIEW','${id(1001)}'`)).toBe("23505");
      expect(MA_CHAN_XOA).toContain(await maLoi(`DELETE FROM public.income_expenses WHERE id = '${id(1001)}'`));
    });
  });
  it("dòng phiếu chỉ gắn được vào bản đóng băng của đúng cổ đông và đúng tháng", async () => {
    await trongGiaoDich(async () => {
      await taoPhieu({ id: id(1001), soTien: 50 });
      await taoPhieu({ id: id(1002), soTien: 50 });
      const dung = await taoDongBang({ thang: "2026-09-01", y: 30, d: 0 });
      const thangKhac = await taoDongBang({ thang: "2026-08-01", y: 30, d: 0 });
      const nguoiKhac = await taoDongBang({ thang: "2026-09-01", y: 30, d: 0, coDong: CD2 });
      const chen = (dongBang: string, phieu: string) => maLoi(`INSERT INTO app_private.profit_ledger_salary_settlement_vouchers(organization_id, shareholder_id, staff_id, period_month, sheet_status_at_quote, source, state, salary_voucher_id, linked_at, settlement_id)
        VALUES ('${ORG_A}','${CD1}','${CHU}','2026-09-01','LOCKED','PAYOUT_FALLBACK','LINKED','${phieu}', now(), '${dongBang}')`);
      expect(await chen(thangKhac, id(1001))).toBe("23503");
      expect(await chen(nguoiKhac, id(1001))).toBe("23503");
      expect(await chen(dung, id(1001))).toBeNull();
    });
  });
});

describe("C5 — nhật ký: chỉ ghi thêm", () => {
  const chen = (loai: string, cols = `'SHAREHOLDER','${CD1}',NULL`) =>
    `INSERT INTO app_private.profit_ledger_events(organization_id, event_kind, subject_kind, shareholder_id, manager_id) VALUES ('${ORG_A}','${loai}', ${cols})`;
  it("nhận đủ 12 loại sự kiện (có PAYOUT_POSTED, PAYOUT_REJECTED); loại lạ bị từ chối", async () => {
    await trongGiaoDich(async () => {
      for (const k of ["PAYOUT_CREATED", "PAYOUT_APPROVED", "PAYOUT_POSTED", "PAYOUT_REJECTED", "PAYOUT_CANCELLED", "MARKER_SET",
        "SALARY_FROZEN", "SALARY_QUOTED", "SALARY_LINKED", "SALARY_NEEDS_REVIEW", "SALARY_RESOLVED", "SALARY_VOIDED"]) {
        expect(await maLoi(chen(k)), k).toBeNull();
      }
      expect(await maLoi(chen("PAYOUT_EDITED"))).toBe("23514");
      expect(await maLoi(chen("MARKER_SET", `'MANAGER','${CD1}',NULL`))).toBe("23514");
      expect(await maLoi(chen("MARKER_SET", `'MANAGER',NULL,'${QL1}'`))).toBeNull();
    });
  });
  it("không sửa, không xoá, không TRUNCATE", async () => {
    await trongGiaoDich(async () => {
      await db.exec(chen("PAYOUT_CREATED"));
      expect(await maLoi("UPDATE app_private.profit_ledger_events SET reason = 'sửa'")).toBe("55000");
      expect(await maLoi("DELETE FROM app_private.profit_ledger_events")).toBe("55000");
      expect(await maLoi("TRUNCATE app_private.profit_ledger_events")).toBe("55000");
      expect(await mot<number>("SELECT count(*)::int AS v FROM app_private.profit_ledger_events")).toBe(1);
    });
  });
});

describe("ước tính lợi nhuận các tháng chưa chốt", () => {
  const uocTinh = (homNay: string, coDong = CD1, org = ORG_A) => trongGiaoDich(async () => {
    await db.query("SELECT set_config('test.today', $1, true)", [homNay]);
    return Number(await mot<string>(`SELECT app_private.profit_ledger_open_estimate_v1('${org}','${coDong}') AS v`));
  });
  // Ba tháng đã chốt gần nhất của công ty A: 07 (100), 08 (40 − 15.5 = 24.5), 09 (30) ⇒ trung bình 51.5.
  it("trung bình 3 tháng đã chốt gần nhất × số tháng TRỌN VẸN chưa chốt (không tính tháng đang chạy)", async () => {
    expect(await uocTinh("2026-11-15")).toBe(51.5);
    expect(await uocTinh("2026-11-01")).toBe(51.5);
    expect(await uocTinh("2026-12-31")).toBe(103);
    expect(await uocTinh("2027-02-10")).toBe(206);
  });
  it("chưa có tháng trọn vẹn nào chưa chốt ⇒ 0", async () => {
    expect(await uocTinh("2026-10-20")).toBe(0);
    expect(await uocTinh("2026-09-20")).toBe(0);
    expect(await uocTinh("2026-06-01")).toBe(0);
  });
  it("tháng cổ đông không có phần vẫn tính là 0 trong trung bình; công ty chưa chốt tháng nào ⇒ 0", async () => {
    // CD2: 07 = 50, 08 = 0, 09 = 20 ⇒ trung bình 70/3.
    expect(await uocTinh("2026-11-15", CD2)).toBe(23.33);
    expect(await uocTinh("2026-11-15", CD_XOA)).toBe(0);
    await trongGiaoDich(async () => {
      await db.exec(`UPDATE public.profit_monthly SET status = 'DRAFT' WHERE organization_id = '${ORG_A}'`);
      expect(Number(await mot<string>(`SELECT app_private.profit_ledger_open_estimate_v1('${ORG_A}','${CD1}') AS v`))).toBe(0);
    });
  });
  it("chỉ lấy 3 tháng gần nhất và chỉ tháng đã chốt", async () => {
    await trongGiaoDich(async () => {
      await db.query("SELECT set_config('test.today', $1, true)", ["2026-12-15"]);
      // Chốt thêm tháng 10 (phần CD1 = 60): ba tháng gần nhất thành 08, 09, 10 ⇒ (24.5 + 30 + 60) / 3, còn 1 tháng trọn vẹn chưa chốt (tháng 11).
      // Tháng 11 mới ở dạng NHÁP (phần 500): không được coi là tháng đã chốt gần nhất, cũng không vào trung bình.
      await db.exec(`INSERT INTO public.profit_monthly(id, organization_id, building_id, period_month, status, is_stale) VALUES
          ('${id(87)}','${ORG_A}','${TOA_1}','2026-10-01','LOCKED',false), ('${id(88)}','${ORG_A}','${TOA_1}','2026-11-01','DRAFT',true);
        INSERT INTO public.profit_allocations(profit_monthly_id, shareholder_id, amount) VALUES ('${id(87)}','${CD1}',60), ('${id(88)}','${CD1}',500)`);
      expect(Number(await mot<string>(`SELECT app_private.profit_ledger_open_estimate_v1('${ORG_A}','${CD1}') AS v`))).toBe(38.17);
    });
  });
  it("thiếu tham số ⇒ 22023; cổ đông không thuộc công ty ⇒ P0002", async () => {
    await trongGiaoDich(async () => {
      expect(await maLoi(`SELECT app_private.profit_ledger_open_estimate_v1(NULL,'${CD1}')`)).toBe("22023");
      expect(await maLoi(`SELECT app_private.profit_ledger_open_estimate_v1('${ORG_A}',NULL)`)).toBe("22023");
      expect(await maLoi(`SELECT app_private.profit_ledger_open_estimate_v1('${ORG_B}','${CD1}')`)).toBe("P0002");
    });
  });
});

describe("tiền kiểm và hậu kiểm của migration", () => {
  async function dung(sua: (nen: string) => string, truocMigration = ""): Promise<{ loi: string; coBang: boolean }> {
    const la = new PGlite();
    try {
      await la.exec(sua(NEN));
      await la.exec(SCOPE_V3);
      await la.exec(duLieuQuyen());
      if (truocMigration) await la.exec(truocMigration);
      let loi = "";
      try { await la.exec(MIGRATION); } catch (e) { loi = `${(e as { code?: string }).code}: ${(e as Error).message}`; await la.exec("ROLLBACK"); }
      const coBang = (await la.query<{ v: boolean }>("SELECT to_regclass('app_private.profit_ledger_markers') IS NOT NULL AS v")).rows[0].v;
      return { loi, coBang };
    } finally { await la.close(); }
  }
  it("thiếu app_private.profit_viewer_can_v1 (gói 1A chưa áp) ⇒ dừng 55000, không tạo gì", async () => {
    const r = await dung((nen) => nen);
    expect(r.loi).toContain("55000");
    expect(r.loi).toContain("profit_viewer_can_v1");
    expect(r.coBang).toBe(false);
  }, 60000);
  it("thiếu cột nền (income_expenses.account_id) hoặc thiếu unique (id, organization_id) của shareholders ⇒ dừng 55000", async () => {
    const thieuCot = await dung((nen) => nen.replace("total_amount numeric(15,2) NOT NULL DEFAULT 0, account_id uuid,", "total_amount numeric(15,2) NOT NULL DEFAULT 0,"), HELPER_QUYEN);
    expect(thieuCot.loi).toContain("55000");
    expect(thieuCot.loi).toContain("public.income_expenses.account_id");
    const thieuIndex = await dung((nen) => nen.replace("CREATE UNIQUE INDEX shareholders_id_org_uq ON public.shareholders (id, organization_id);", ""), HELPER_QUYEN);
    expect(thieuIndex.loi).toContain("55000");
    expect(thieuIndex.loi).toContain("public.shareholders");
    expect(thieuIndex.coBang).toBe(false);
  }, 60000);
  it("bảng C3 còn hình dạng cũ (thiếu cột phần đã trừ, CHECK trần cũ) từ một lượt áp bản nháp ⇒ hậu kiểm dừng 55000", async () => {
    // Dựng đúng bảng C3 của bản nháp: lấy câu CREATE TABLE hiện tại, bỏ cột mới và trả CHECK về trần cũ.
    const cau = /CREATE TABLE IF NOT EXISTS app_private\.profit_ledger_salary_settlements \([\s\S]*?\n\);/.exec(MIGRATION)?.[0];
    expect(cau).toBeTruthy();
    const cu = cau!
      .replace(/\n {2}applied_offset_at_freeze [^\n]*/, "")
      .replace("GREATEST(investment_month, 0, applied_offset_at_freeze)", "GREATEST(investment_month, 0)");
    expect(cu).not.toContain("applied_offset_at_freeze numeric");
    const r = await dung((nen) => nen, `${HELPER_QUYEN}; CREATE SCHEMA IF NOT EXISTS app_private; ${cu}`);
    expect(r.loi).toContain("55000");
    expect(r.loi).toContain("applied_offset_at_freeze");
  }, 60000);
  it("khoá vừa tạo mà vai không phải chủ nhận được ngay trong giao dịch (vd trigger tự cấp quyền mới) ⇒ hậu kiểm dừng 55000, hoàn tác cả migration", async () => {
    const tuCap = (vai: string, khoa: string) => `${HELPER_QUYEN};
      CREATE FUNCTION public.tu_cap_quyen_moi() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
        IF NEW.key = '${khoa}' THEN
          INSERT INTO public.role_permissions(organization_id, role_id, permission_key) VALUES ('${ORG_A}', '${vai}', NEW.key);
        END IF;
        RETURN NULL;
      END $$;
      CREATE TRIGGER tu_cap AFTER INSERT ON public.permission_definitions FOR EACH ROW EXECUTE FUNCTION public.tu_cap_quyen_moi();`;
    const tamUng = await dung((nen) => nen, tuCap(VAI_QUAN_LY, K_TAM_UNG));
    expect(tamUng.loi).toContain("55000");
    expect(tamUng.loi).toContain("advance_own_cashbook");
    expect(tamUng.coBang).toBe(false);
    const xem = await dung((nen) => nen, tuCap(VAI_PARTNER, K_XEM_PT));
    expect(xem.loi).toContain("55000");
    expect(xem.loi).toContain("không phải chủ công ty");
    expect(xem.coBang).toBe(false);
  }, 60000);
});

describe("chạy lại M1: ba khoá chỉ được tạo, không ghi đè, không gieo lại; hai lượt trong một giao dịch", () => {
  async function csdlMoi(): Promise<PGlite> {
    const la = new PGlite();
    await la.exec(NEN);
    await la.exec(SCOPE_V3);
    await la.exec(HELPER_QUYEN);
    await la.exec(duLieuQuyen());
    return la;
  }
  const VAI_CHU_TAT_CA = [VAI_CHU_TU_TAO, VAI_CHU_HE_THONG, VAI_CHU_DA_NGHI, VAI_CHU_B, VAI_CHU_SO_HUU_TU_TAO].sort();
  const vaiCo = async (la: PGlite, k: string) => (await la.query<{ role_id: string }>(
    "SELECT role_id FROM public.role_permissions WHERE permission_key = $1 ORDER BY role_id", [k])).rows.map((r) => r.role_id);

  it("khoá có sẵn từ trước (lượt áp trước / migration khác): không ghi đè, không gieo, không khẳng định về vai ⇒ chạy qua; khoá còn thiếu thì tạo, gieo và khẳng định như thường", async () => {
    const la = await csdlMoi();
    try {
      // advance_own_cashbook và view_percent có sẵn, khác hình dạng / trạng thái, đã nằm ở vai không phải chủ; view_building_totals chưa có.
      await la.exec(`INSERT INTO public.permission_definitions(key, resource, action, sensitivity, is_active) VALUES
          ('${K_TAM_UNG}','shareholder_profit','advance_own_cashbook','MANAGE', false),
          ('${K_XEM_PT}','shareholder_profit','view_percent','ELEVATED', true);
        INSERT INTO public.role_permissions(organization_id, role_id, permission_key) VALUES
          ('${ORG_A}','${VAI_QUAN_LY}','${K_TAM_UNG}'), ('${ORG_A}','${VAI_PARTNER}','${K_XEM_PT}');`);
      await la.exec(MIGRATION);
      expect((await la.query("SELECT key, sensitivity, is_active FROM public.permission_definitions WHERE key = ANY($1) ORDER BY key",
        [[K_TAM_UNG, K_XEM_PT, K_XEM_TOA]])).rows).toEqual([
        { key: K_TAM_UNG, sensitivity: "MANAGE", is_active: false },
        { key: K_XEM_TOA, sensitivity: "MANAGE", is_active: true },
        { key: K_XEM_PT, sensitivity: "ELEVATED", is_active: true },
      ]);
      expect(await vaiCo(la, K_TAM_UNG)).toEqual([VAI_QUAN_LY]);
      expect(await vaiCo(la, K_XEM_PT)).toEqual([VAI_PARTNER]);
      expect(await vaiCo(la, K_XEM_TOA)).toEqual(VAI_CHU_TAT_CA);
    } finally { await la.close(); }
  }, 60000);
  it("hai lượt trong CÙNG một giao dịch (như lane / kiểm idempotent): lượt một tạo và gieo; lượt hai không gieo thêm; khoá vẫn là 'vừa tạo' nên hậu kiểm lượt hai vẫn khẳng định về vai", async () => {
    const la = await csdlMoi();
    try {
      const soGieo = async () => (await la.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM public.role_permissions WHERE permission_key IN ('${K_XEM_PT}','${K_XEM_TOA}')`)).rows[0].n;
      await la.exec(`BEGIN; ${THAN}`);
      expect(await soGieo()).toBe(10);
      expect((await la.query<{ v: string }>("SELECT current_setting('ihomecrm.m1_khoa_moi', true) AS v")).rows[0].v)
        .toBe([K_TAM_UNG, K_XEM_TOA, K_XEM_PT].join(","));
      await la.exec(THAN);
      expect(await soGieo()).toBe(10);
      // Giữa hai lượt có vai không phải chủ được gán quyền xem ⇒ lượt sau dừng 55000 (khẳng định vẫn chạy cho khoá vừa tạo).
      await la.exec(`INSERT INTO public.role_permissions(organization_id, role_id, permission_key) VALUES ('${ORG_A}','${VAI_PARTNER}','${K_XEM_PT}')`);
      await expect(la.exec(THAN)).rejects.toMatchObject({ code: "55000" });
      await la.exec("ROLLBACK");
    } finally { await la.close(); }
  }, 60000);
});
