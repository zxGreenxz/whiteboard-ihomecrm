import { readFileSync, readdirSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * Migration 20261115083533 (M2-đọc của sổ tổng lợi nhuận): năm RPC đọc
 *   E1 shareholder_profit_ledger_v1, E2 shareholder_profit_ledger_entries_v1, E3 shareholder_profit_my_ledger_v1,
 *   E7 profit_ledger_payout_detail_v1, E10 profit_manager_ledger_v1 và các hàm phụ app_private.profit_ledger_doc_*.
 *
 * Chạy THẬT trên PostgreSQL nhúng, theo thứ tự: bảng nền → authorized_scope_v3 + profit_viewer_can_v1 là ĐỊNH NGHĨA
 * SỐNG (bản mới nhất trong supabase/migrations) → M1 (20261115063149) → file này HAI lượt.
 * Người gọi giả lập bằng request.jwt.claim.sub + SET LOCAL ROLE authenticated; mỗi lời gọi chạy trong SAVEPOINT rồi
 * hoàn tác. Route của cờ sổ tổng giả lập qua test.route (evaluate_feature_route là stub).
 * Ca hai phiên và JWT qua PostgREST không chạy được ở đây (một kết nối) — chạy trên TEST.
 */
const DIR = "supabase/migrations";
const FILE_M1 = `${DIR}/20261115063149_so_tong_loi_nhuan_nen.sql`;
const FILE = `${DIR}/20261115083533_so_tong_loi_nhuan_doc.sql`;

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
/** Thành viên của người dùng (chỉ dùng cho id người < 100). */
const mem = (user: string) => user.replace("4000-8000-0000000000", "4000-8000-1000000000");
const [ORG_A, ORG_B] = [1, 2].map(id);
// Người dùng
const [CHU, KHOA, MO_KHOA, QL_CHI, QL_CD, NGUOI_LA, NGUOI_XEM, CD_BAOCAO, CD_GO_PT, CD_TAMUNG, CD_KHONG, CD_DU, CD_XOA_USER, CD_HAI, NGOAI, SUPER] =
  [11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26].map(id);
// Vai, phạm vi
const [VAI_CHU, VAI_KHOA, VAI_MO_KHOA, VAI_QL_CHI, VAI_QL_CD, VAI_XEM, VAI_CHU_B] = [31, 32, 33, 34, 35, 36, 37].map(id);
const [PHAM_VI_A, PHAM_VI_B] = [41, 42].map(id);
// Toà, sổ quỹ
const [TOA_1, TOA_2, TOA_AO, TOA_XOA, TOA_B, SO_QUY, SO_QUY_B] = [51, 52, 53, 54, 55, 56, 57].map(id);
// Cổ đông
const [CD1, CD2, CD3, CD4, CD5, CD_XOA, CD_XOA0, CD_XOA_CHO, CD6, CD7, CD_NOLOGIN, CD_B] =
  [61, 62, 63, 64, 65, 66, 67, 68, 69, 70, 71, 72].map(id);
// Người nhận lương điều hành
const [QL1, QL2, QL_XOA, QL_XOA0, QL_B] = [81, 82, 83, 84, 85].map(id);
// Kỳ lợi nhuận
const [PM_07, PM_08_1, PM_08_2, PM_09_NHAP, PM_09_2, PM_B] = [91, 92, 93, 94, 95, 96].map(id);
// Phiếu
const [P_CD1_CU, P_CD1_OK, P_CD1_CHO, P_CD1_TUCHOI, P_QL1, P_KHAC, P_B, P_XOA0, P_XOA_CHO, SV1, SV2, P_CD4, P_QL_VUOT] =
  [101, 102, 103, 104, 105, 106, 107, 108, 109, 110, 111, 112, 113].map(id);
const [L1, L2] = [121, 122].map(id);

const K_PD = "reports_finance.profit_distribution";
const K_TAM_UNG = "shareholder_profit.advance_own_cashbook";
const K_XEM_PT = "shareholder_profit.view_percent";
const K_XEM_TOA = "shareholder_profit.view_building_totals";
const RPC = [
  "public.shareholder_profit_ledger_v1(uuid)", "public.shareholder_profit_ledger_entries_v1(uuid,uuid)",
  "public.shareholder_profit_my_ledger_v1(uuid)", "public.profit_ledger_payout_detail_v1(uuid)",
  "public.profit_manager_ledger_v1(uuid)",
];
const PHU = [
  "app_private.profit_ledger_doc_can_v1(uuid,text[])", "app_private.profit_ledger_doc_status_v1(numeric)",
  "app_private.profit_ledger_doc_marker_v1(jsonb)", "app_private.profit_ledger_doc_shareholder_v1(uuid,uuid)",
];
/** Khoá không bao giờ được có trong E3 ngoài percent_rows / building_totals. */
const khoaCam = (k: string) =>
  ["percent", "computed_profit", "adjusted_profit", "management_salary", "shareholder_percent_total"].includes(k) || k.startsWith("source_");

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
const HELPER_QUYEN = dinhNghiaSong("app_private.profit_viewer_can_v1");
const MIGRATION_M1 = readFileSync(FILE_M1, "utf8");
const MIGRATION = readFileSync(FILE, "utf8");

// Bảng nền: cột/ràng buộc mà M1 và file này đụng tới (đối chiếu production 15/11/2026), cộng vài cột "nhạy cảm"
// (percent, computed_profit, management_salary…) để ca quét khoá cấm có cái mà bắt nếu hàm lỡ trả nguyên dòng.
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
  CREATE TABLE public.buildings(id uuid PRIMARY KEY, organization_id uuid, name text NOT NULL DEFAULT 'Toà', deleted_at timestamptz);
  CREATE TABLE public.accounts(id uuid PRIMARY KEY, organization_id uuid, name text NOT NULL DEFAULT 'Sổ', deleted_at timestamptz);
  CREATE TABLE app_private.server_feature_flags(feature_key text PRIMARY KEY, domain text NOT NULL,
    risk_class text NOT NULL DEFAULT 'MONEY' CHECK (risk_class IN ('MONEY','NON_MONEY')),
    mode text NOT NULL DEFAULT 'OFF' CHECK (mode IN ('OFF','SHADOW','CANARY','ON')),
    force_freeze boolean NOT NULL DEFAULT false, config_version bigint NOT NULL DEFAULT 1, reason text, updated_by uuid,
    updated_at timestamptz NOT NULL DEFAULT now());
  -- Route của cờ: test tự đặt qua test.route (thân thật chỉ SELECT và là VOLATILE — stub cũng VOLATILE).
  CREATE FUNCTION app_private.evaluate_feature_route(p_feature_key text, p_organization_id uuid) RETURNS text LANGUAGE sql
    AS $$ SELECT COALESCE(nullif(current_setting('test.route', true), ''), 'LEGACY') $$;
  CREATE FUNCTION public.org_today_v1(p_organization_id uuid) RETURNS date LANGUAGE sql STABLE AS $$ SELECT DATE '2026-11-15' $$;
  CREATE TABLE public.shareholders(id uuid PRIMARY KEY, organization_id uuid NOT NULL REFERENCES public.organizations(id), auth_user_id uuid,
    name text NOT NULL, is_active boolean NOT NULL DEFAULT true, deleted_at timestamptz);
  CREATE UNIQUE INDEX shareholders_id_org_uq ON public.shareholders (id, organization_id);
  CREATE TABLE public.profit_managers(id uuid PRIMARY KEY, organization_id uuid NOT NULL REFERENCES public.organizations(id), auth_user_id uuid,
    name text NOT NULL, is_active boolean NOT NULL DEFAULT true, deleted_at timestamptz);
  CREATE TABLE public.building_shareholders(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), building_id uuid NOT NULL, shareholder_id uuid NOT NULL,
    percent numeric(5,2) NOT NULL DEFAULT 0, organization_id uuid);
  CREATE TABLE public.profit_monthly(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL, building_id uuid NOT NULL, period_month date NOT NULL,
    status text NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT','LOCKED')), is_stale boolean NOT NULL DEFAULT true, locked_at timestamptz,
    computed_profit numeric(15,2) NOT NULL DEFAULT 0, adjusted_profit numeric(15,2) NOT NULL DEFAULT 0, management_salary numeric(15,2) NOT NULL DEFAULT 0,
    source_revenue numeric(15,2), source_expense numeric(15,2), source_net_profit numeric(15,2), shareholder_percent_total numeric(9,4) NOT NULL DEFAULT 0,
    UNIQUE (building_id, period_month));
  CREATE TABLE public.profit_allocations(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    profit_monthly_id uuid NOT NULL REFERENCES public.profit_monthly(id) ON DELETE CASCADE,
    shareholder_id uuid NOT NULL REFERENCES public.shareholders(id) ON DELETE CASCADE,
    percent numeric(5,2) NOT NULL DEFAULT 0, amount numeric(15,2) NOT NULL DEFAULT 0, organization_id uuid,
    created_at timestamptz NOT NULL DEFAULT now(), UNIQUE (profit_monthly_id, shareholder_id));
  CREATE TABLE public.profit_manager_allocations(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    profit_monthly_id uuid NOT NULL REFERENCES public.profit_monthly(id) ON DELETE CASCADE,
    manager_id uuid NOT NULL REFERENCES public.profit_managers(id) ON DELETE CASCADE,
    amount numeric(15,2) NOT NULL DEFAULT 0, organization_id uuid, UNIQUE (profit_monthly_id, manager_id));
  CREATE TABLE public.income_expenses(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL,
    type text NOT NULL CHECK (type IN ('INCOME','EXPENSE')),
    approval_status text NOT NULL DEFAULT 'APPROVED' CHECK (approval_status IN ('UNAPPROVED','APPROVED','CANCELLED')),
    deleted_at timestamptz, shareholder_id uuid REFERENCES public.shareholders(id) ON DELETE SET NULL,
    profit_manager_id uuid REFERENCES public.profit_managers(id) ON DELETE SET NULL,
    total_amount numeric(15,2) NOT NULL DEFAULT 0, account_id uuid, created_at timestamptz NOT NULL DEFAULT now(),
    code text, voucher_date date NOT NULL DEFAULT DATE '2026-11-01', building_id uuid, posting_status text, system_source text);
  CREATE TABLE public.approval_requests(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL, submission_no integer NOT NULL DEFAULT 1,
    subject_type text NOT NULL, subject_id uuid NOT NULL,
    state text NOT NULL CHECK (state IN ('PENDING_APPROVAL','POSTED','DENIED','REJECTED','CANCELLED','REVERSED','APPROVED','WITHDRAWN','CHANGES_REQUESTED','DISPUTED')),
    UNIQUE (organization_id, subject_type, subject_id, submission_no));
`;

function duLieuQuyen(): string {
  const khoa: [string, string, string][] = [
    ["shareholder_profit.distribute", "distribute", "ELEVATED"], ["shareholder_profit.lock", "lock", "ELEVATED"],
    ["shareholder_profit.unlock", "unlock", "ELEVATED"], ["shareholder_profit.manage_shareholders", "manage_shareholders", "ELEVATED"],
    ["shareholder_profit.pay_manager", "pay_manager", "ELEVATED"], ["shareholder_profit.view", "view", "VIEW"],
  ];
  const quanLyLn = ["shareholder_profit.distribute", "shareholder_profit.lock", "shareholder_profit.unlock",
    "shareholder_profit.manage_shareholders", "shareholder_profit.pay_manager", "shareholder_profit.view", K_PD];
  // [vai, công ty, tên, system_key, các khoá]
  const vai: [string, string, string, string | null, string[]][] = [
    [VAI_CHU, ORG_A, "Chủ công ty", null, quanLyLn],
    [VAI_KHOA, ORG_A, "Kế toán chốt lợi nhuận", null, ["shareholder_profit.lock"]],
    [VAI_MO_KHOA, ORG_A, "Mở chốt lợi nhuận", null, ["shareholder_profit.unlock"]],
    [VAI_QL_CHI, ORG_A, "Chi lương điều hành", null, ["shareholder_profit.pay_manager"]],
    [VAI_QL_CD, ORG_A, "Quản lý cổ đông", null, ["shareholder_profit.manage_shareholders"]],
    [VAI_XEM, ORG_A, "Cổ đông xem", null, ["shareholder_profit.view"]],
    [VAI_CHU_B, ORG_B, "Chủ công ty", "TENANT_OWNER", quanLyLn],
  ];
  const gan: [string, string, string][] = [
    [CHU, VAI_CHU, ORG_A], [KHOA, VAI_KHOA, ORG_A], [MO_KHOA, VAI_MO_KHOA, ORG_A], [QL_CHI, VAI_QL_CHI, ORG_A],
    [QL_CD, VAI_QL_CD, ORG_A], [NGUOI_XEM, VAI_XEM, ORG_A], [NGOAI, VAI_CHU_B, ORG_B],
  ];
  const thanhVienA = [CHU, KHOA, MO_KHOA, QL_CHI, QL_CD, NGUOI_LA, NGUOI_XEM, CD_BAOCAO, CD_GO_PT, CD_TAMUNG, CD_KHONG, CD_DU, CD_XOA_USER, CD_HAI];
  return `
    INSERT INTO public.organizations(id) VALUES ('${ORG_A}'),('${ORG_B}');
    INSERT INTO public.super_admins VALUES ('${SUPER}');
    INSERT INTO public.permission_definitions(key, resource, action, sensitivity) VALUES
      ${khoa.map(([k, a, s]) => `('${k}','shareholder_profit','${a}','${s}')`).join(",")},
      ('${K_PD}','reports_finance','profit_distribution','MANAGE');
    INSERT INTO public.organization_memberships(id, user_id, organization_id) VALUES
      ${thanhVienA.map((u) => `('${mem(u)}','${u}','${ORG_A}')`).concat(`('${mem(NGOAI)}','${NGOAI}','${ORG_B}')`).join(",")};
    INSERT INTO public.authorization_scopes(id, organization_id, scope_type) VALUES ('${PHAM_VI_A}','${ORG_A}','ORGANIZATION'),('${PHAM_VI_B}','${ORG_B}','ORGANIZATION');
    INSERT INTO public.organization_roles(id, organization_id, name, is_system, system_key) VALUES
      ${vai.map(([r, o, ten, k]) => `('${r}','${o}','${ten}',${k ? "true" : "false"},${k ? `'${k}'` : "NULL"})`).join(",")};
    INSERT INTO public.role_permissions(organization_id, role_id, permission_key) VALUES
      ${vai.flatMap(([r, o, , , ks]) => ks.map((k) => `('${o}','${r}','${k}')`)).join(",")};
    ${gan.map(([u, r, o], i) => `
      INSERT INTO public.role_bindings(id, organization_id, membership_id, role_id) VALUES ('${id(300 + i)}','${o}','${mem(u)}','${r}');
      INSERT INTO public.role_binding_scopes VALUES ('${o}','${id(300 + i)}','${o === ORG_A ? PHAM_VI_A : PHAM_VI_B}');`).join("")}
  `;
}

function duLieuSo(): string {
  return `
    INSERT INTO public.buildings(id, organization_id, name, deleted_at) VALUES
      ('${TOA_1}','${ORG_A}','Toà Một',NULL), ('${TOA_2}','${ORG_A}','Toà Hai',NULL), ('${TOA_AO}','${ORG_A}','Toà ảo',NULL),
      ('${TOA_XOA}','${ORG_A}','Toà đã xoá', now()), ('${TOA_B}','${ORG_B}','Toà B',NULL);
    INSERT INTO public.accounts(id, organization_id, name) VALUES ('${SO_QUY}','${ORG_A}','Quỹ tiền mặt'), ('${SO_QUY_B}','${ORG_B}','Quỹ B');
    INSERT INTO public.shareholders(id, organization_id, auth_user_id, name, is_active, deleted_at) VALUES
      ('${CD1}','${ORG_A}','${CD_BAOCAO}','Cổ đông 1',true,NULL), ('${CD2}','${ORG_A}','${CD_GO_PT}','Cổ đông 2',true,NULL),
      ('${CD3}','${ORG_A}','${CD_TAMUNG}','Cổ đông 3',false,NULL), ('${CD4}','${ORG_A}','${CD_KHONG}','Cổ đông 4',true,NULL),
      ('${CD5}','${ORG_A}','${CD_DU}','Cổ đông 5',true,NULL),
      ('${CD_XOA}','${ORG_A}','${CD_XOA_USER}','Cổ đông đã xoá còn số',true, now()),
      ('${CD_XOA0}','${ORG_A}',NULL,'Cổ đông đã xoá hết số',true, now()),
      ('${CD_XOA_CHO}','${ORG_A}',NULL,'Cổ đông đã xoá còn phiếu chờ',true, now()),
      ('${CD6}','${ORG_A}','${CD_HAI}','Cổ đông 6',true,NULL), ('${CD7}','${ORG_A}','${CD_HAI}','Cổ đông 7',true,NULL),
      ('${CD_NOLOGIN}','${ORG_A}',NULL,'Cổ đông chưa có tài khoản',true,NULL),
      ('${CD_B}','${ORG_B}','${NGOAI}','Cổ đông công ty B',true,NULL);
    INSERT INTO public.profit_managers(id, organization_id, name, deleted_at) VALUES
      ('${QL1}','${ORG_A}','Quản lý 1',NULL), ('${QL2}','${ORG_A}','Quản lý 2',NULL),
      ('${QL_XOA}','${ORG_A}','Quản lý đã nghỉ còn số', now()), ('${QL_XOA0}','${ORG_A}','Quản lý đã nghỉ hết số', now()),
      ('${QL_B}','${ORG_B}','Quản lý công ty B',NULL);
    INSERT INTO public.building_shareholders(building_id, shareholder_id, percent, organization_id) VALUES
      ('${TOA_1}','${CD1}',40,'${ORG_A}'), ('${TOA_2}','${CD1}',30,'${ORG_A}'), ('${TOA_1}','${CD2}',15,'${ORG_A}'),
      ('${TOA_1}','${CD5}',20,'${ORG_A}'), ('${TOA_XOA}','${CD5}',10,'${ORG_A}'), ('${TOA_B}','${CD5}',5,'${ORG_B}'),
      ('${TOA_B}','${CD_B}',100,'${ORG_B}');
    INSERT INTO public.profit_monthly(id, organization_id, building_id, period_month, status, is_stale, locked_at,
        source_revenue, source_expense, source_net_profit, computed_profit, adjusted_profit, management_salary, shareholder_percent_total) VALUES
      ('${PM_07}','${ORG_A}','${TOA_1}','2026-07-01','LOCKED',false,'2026-08-02 10:00:00+00', 1000, 400, 600, 600, 600, 50, 85.5),
      ('${PM_08_1}','${ORG_A}','${TOA_1}','2026-08-01','LOCKED',true,'2026-09-03 10:00:00+00', 800, 500, 300, 300, 300, 0, 70),
      ('${PM_08_2}','${ORG_A}','${TOA_2}','2026-08-01','LOCKED',false,'2026-09-03 10:00:00+00', 100, 150, -50, -50, -50, 0, 31),
      ('${PM_09_NHAP}','${ORG_A}','${TOA_1}','2026-09-01','DRAFT',true,NULL, NULL, NULL, NULL, 0, 0, 0, 0),
      ('${PM_09_2}','${ORG_A}','${TOA_2}','2026-09-01','LOCKED',false,'2026-10-04 10:00:00+00', 700, 300, 400, 400, 400, 0, 50),
      ('${PM_B}','${ORG_B}','${TOA_B}','2026-08-01','LOCKED',false,'2026-09-03 10:00:00+00', 900, 100, 800, 800, 800, 0, 100);
    -- CD1: 100 + 40 (stale) − 15.5 (âm) + 30 = 154.5; dòng nháp 999 không tính.
    INSERT INTO public.profit_allocations(profit_monthly_id, shareholder_id, percent, amount, organization_id) VALUES
      ('${PM_07}','${CD1}',16.67,100,'${ORG_A}'), ('${PM_08_1}','${CD1}',13.33,40,'${ORG_A}'), ('${PM_08_2}','${CD1}',31,-15.5,'${ORG_A}'),
      ('${PM_09_NHAP}','${CD1}',40,999,'${ORG_A}'), ('${PM_09_2}','${CD1}',7.5,30,NULL),
      ('${PM_07}','${CD2}',8.33,50,'${ORG_A}'), ('${PM_09_2}','${CD2}',5,20,'${ORG_A}'),
      ('${PM_07}','${CD3}',1.67,10,'${ORG_A}'), ('${PM_07}','${CD4}',0.83,5,'${ORG_A}'),
      ('${PM_07}','${CD5}',10,60,'${ORG_A}'), ('${PM_08_1}','${CD5}',8.33,25,'${ORG_A}'), ('${PM_09_NHAP}','${CD5}',5,77,'${ORG_A}'),
      ('${PM_07}','${CD_XOA}',5.5,33,'${ORG_A}'), ('${PM_07}','${CD_XOA0}',1.67,10,'${ORG_A}'), ('${PM_07}','${CD_XOA_CHO}',1.67,10,'${ORG_A}'),
      ('${PM_07}','${CD6}',0.17,1,'${ORG_A}'), ('${PM_07}','${CD7}',0.33,2,'${ORG_A}'),
      ('${PM_B}','${CD_B}',37.5,300,'${ORG_B}');
    INSERT INTO public.profit_manager_allocations(profit_monthly_id, manager_id, amount, organization_id) VALUES
      ('${PM_07}','${QL1}',10,'${ORG_A}'), ('${PM_08_1}','${QL1}',5,NULL), ('${PM_09_2}','${QL2}',4,'${ORG_A}'),
      ('${PM_07}','${QL_XOA}',7,'${ORG_A}'), ('${PM_B}','${QL_B}',9,'${ORG_B}');
    INSERT INTO public.income_expenses(id, organization_id, type, approval_status, shareholder_id, profit_manager_id, total_amount, account_id,
        created_at, code, voucher_date, building_id, posting_status, system_source) VALUES
      ('${P_CD1_CU}','${ORG_A}','EXPENSE','APPROVED','${CD1}',NULL,10,'${SO_QUY}','2026-07-15 09:00:00+00','PC-CU','2026-07-15','${TOA_AO}','POSTED',NULL),
      ('${P_CD1_OK}','${ORG_A}','EXPENSE','APPROVED','${CD1}',NULL,20,'${SO_QUY}','2026-08-10 09:00:00+00','PC-OK','2026-08-10','${TOA_AO}','POSTED','profit.ledger_payout'),
      ('${P_CD1_CHO}','${ORG_A}','EXPENSE','UNAPPROVED','${CD1}',NULL,30,'${SO_QUY}','2026-10-10 09:00:00+00','PC-CHO','2026-10-10','${TOA_AO}','UNPOSTED','profit.ledger_payout'),
      ('${P_CD1_TUCHOI}','${ORG_A}','EXPENSE','UNAPPROVED','${CD1}',NULL,40,'${SO_QUY}','2026-10-11 09:00:00+00','PC-TC','2026-10-11','${TOA_AO}','UNPOSTED','profit.ledger_payout'),
      ('${P_QL1}','${ORG_A}','EXPENSE','UNAPPROVED',NULL,'${QL1}',8,'${SO_QUY}','2026-10-20 09:00:00+00','PC-QL1','2026-10-20','${TOA_AO}','UNPOSTED','profit.manager_salary'),
      ('${P_QL_VUOT}','${ORG_A}','EXPENSE','UNAPPROVED',NULL,'${QL2}',10,'${SO_QUY}','2026-10-21 09:00:00+00','PC-QL2','2026-10-21','${TOA_AO}','UNPOSTED',NULL),
      ('${P_KHAC}','${ORG_A}','EXPENSE','APPROVED',NULL,NULL,99,'${SO_QUY}','2026-10-01 09:00:00+00','PC-KHAC','2026-10-01','${TOA_1}','POSTED',NULL),
      ('${P_B}','${ORG_B}','EXPENSE','APPROVED','${CD_B}',NULL,50,'${SO_QUY_B}','2026-10-01 09:00:00+00','PC-B','2026-10-01','${TOA_B}','POSTED',NULL),
      ('${P_XOA0}','${ORG_A}','EXPENSE','APPROVED','${CD_XOA0}',NULL,10,'${SO_QUY}','2026-09-01 09:00:00+00','PC-X0','2026-09-01','${TOA_AO}','POSTED',NULL),
      ('${P_XOA_CHO}','${ORG_A}','EXPENSE','UNAPPROVED','${CD_XOA_CHO}',NULL,10,'${SO_QUY}','2026-09-02 09:00:00+00','PC-XC','2026-09-02','${TOA_AO}','UNPOSTED',NULL),
      ('${P_CD4}','${ORG_A}','EXPENSE','APPROVED','${CD4}',NULL,8,'${SO_QUY}','2026-09-03 09:00:00+00','PC-CD4','2026-09-03','${TOA_AO}','POSTED',NULL),
      ('${SV1}','${ORG_A}','EXPENSE','APPROVED',NULL,NULL,500,'${SO_QUY}','2026-09-05 09:00:00+00','PL-08','2026-09-05','${TOA_1}','POSTED',NULL),
      ('${SV2}','${ORG_A}','EXPENSE','APPROVED',NULL,NULL,400,'${SO_QUY}','2026-10-12 09:00:00+00','PL-09','2026-10-12','${TOA_1}','POSTED',NULL);
    INSERT INTO public.approval_requests(organization_id, subject_type, subject_id, state) VALUES
      ('${ORG_A}','FINANCIAL_VOUCHER','${P_CD1_CHO}','PENDING_APPROVAL'), ('${ORG_A}','FINANCIAL_VOUCHER','${P_CD1_TUCHOI}','REJECTED'),
      ('${ORG_A}','FINANCIAL_VOUCHER','${P_QL1}','PENDING_APPROVAL'), ('${ORG_A}','FINANCIAL_VOUCHER','${P_QL_VUOT}','PENDING_APPROVAL'),
      ('${ORG_A}','FINANCIAL_VOUCHER','${P_XOA_CHO}','PENDING_APPROVAL');
  `;
}

/** Ngoại lệ thành viên (kèm cạnh phạm vi ORGANIZATION như màn Thành viên làm). [người, khoá, đã thu hồi?] */
function duLieuNgoaiLe(): string {
  const ngoaiLe: [string, string, boolean][] = [
    [CD_BAOCAO, K_PD, false],
    [CD_GO_PT, K_PD, false], [CD_GO_PT, K_XEM_PT, true],
    [CD_TAMUNG, K_TAM_UNG, false],
    [CD_DU, K_PD, false], [CD_DU, K_XEM_PT, false], [CD_DU, K_XEM_TOA, false],
    [CD_XOA_USER, K_PD, false],
    [CD_HAI, K_PD, false],
  ];
  return ngoaiLe.map(([u, k, thuHoi], i) => ngoaiLeSql(id(200 + i), u, k, thuHoi)).join("");
}
const ngoaiLeSql = (oid: string, u: string, k: string, thuHoi: boolean) => `
  INSERT INTO public.member_permission_overrides(id, organization_id, membership_id, permission_key, effect, revoked_at)
    VALUES ('${oid}','${ORG_A}','${mem(u)}','${k}','ALLOW', ${thuHoi ? "now() - interval '1 day'" : "NULL"});
  INSERT INTO public.member_override_scopes VALUES ('${ORG_A}','${oid}','${PHAM_VI_A}');`;

type Loai = "SHAREHOLDER" | "MANAGER";
const cot = (loai: Loai, chuThe: string) => loai === "SHAREHOLDER" ? `'${chuThe}', NULL` : `NULL, '${chuThe}'`;

const db = new PGlite();

/** Dòng phiếu chi trong sổ theo đúng nghi thức của lệnh lập (ngữ cảnh CREATE → khoá sổ → nextval → chèn → xoá ngữ cảnh). */
async function ghiDongPhieuDayDu(o: {
  phieu: string; loai: Loai; chuThe: string; soTien: number; tamUng?: number; nguoiLap?: string; kieu?: "OWNER" | "CUSTODIAN_ADVANCE";
  nguoiNhan?: string | null; soDuTruoc?: number; canhBao?: string; luc?: string;
}) {
  const nguoiLap = o.nguoiLap ?? CHU;
  const tamUng = o.tamUng ?? 0;
  const nguoiNhan = o.nguoiNhan ?? null;
  await db.exec(`
    INSERT INTO app_private.profit_ledger_write_contexts(income_expense_id, purpose) VALUES ('${o.phieu}', 'CREATE');
    SELECT app_private.profit_ledger_lock_v1('${ORG_A}', '${o.loai}', '${o.chuThe}');
    INSERT INTO app_private.profit_ledger_payouts(voucher_id, organization_id, subject_kind, shareholder_id, manager_id, account_id, amount,
      balance_before, within_amount, advance_amount, warnings, maker_user_id, maker_membership_id, maker_kind, payee_is_maker, payee_user_id,
      ledger_seq, created_at)
    VALUES ('${o.phieu}','${ORG_A}','${o.loai}', ${cot(o.loai, o.chuThe)}, '${SO_QUY}', ${o.soTien}, ${o.soDuTruoc ?? 0}, ${o.soTien - tamUng}, ${tamUng},
      '${o.canhBao ?? "[]"}'::jsonb, '${nguoiLap}', '${mem(nguoiLap)}', '${o.kieu ?? "OWNER"}', ${nguoiNhan !== null && nguoiNhan === nguoiLap},
      ${nguoiNhan ? `'${nguoiNhan}'` : "NULL"}, nextval('app_private.profit_ledger_seq'), ${o.luc ? `'${o.luc}'` : "clock_timestamp()"});
    DELETE FROM app_private.profit_ledger_write_contexts WHERE income_expense_id = '${o.phieu}';
  `);
}

// ── Bộ trợ giúp như của M1 (dùng cho nhóm kịch bản ngẫu nhiên chép từ test M1) ──
const mot = async <T>(sql: string, params: unknown[] = []) => (await db.query<{ v: T }>(sql, params)).rows[0].v;
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
async function ghiDongPhieu(phieu: string, loai: Loai, chuThe: string, soTien: number) {
  await ghiDongPhieuDayDu({ phieu, loai, chuThe, soTien });
}
/** Đặt mốc theo đúng nghi thức: khoá sổ → nextval → chèn. thang = null là gỡ mốc. Trả id dòng mốc. */
async function datMoc(loai: Loai, chuThe: string, thang: string | null, de: string | null = null): Promise<string> {
  await db.exec(`SELECT app_private.profit_ledger_lock_v1('${ORG_A}', '${loai}', '${chuThe}')`);
  return mot<string>(`INSERT INTO app_private.profit_ledger_markers(organization_id, subject_kind, shareholder_id, manager_id, settled_through_month, reason, supersedes_id, ledger_seq, created_by)
    VALUES ('${ORG_A}','${loai}', ${cot(loai, chuThe)}, ${thang ? `'${thang}'` : "NULL"}, 'Lý do đặt mốc đủ dài', ${de ? `'${de}'` : "NULL"},
      nextval('app_private.profit_ledger_seq'), '${CHU}') RETURNING id AS v`);
}
interface DongLuong {
  id?: string; phieuLuong?: string | null; thang: string; y: number; d?: number; trangThai: "QUOTED" | "LINKED" | "NEEDS_REVIEW";
  goiY?: number; coDong?: string; nhanVien?: string; luc?: string;
}
async function taoDongLuong(o: DongLuong): Promise<string> {
  const quoted = o.trangThai === "QUOTED";
  const luc = o.luc ? `'${o.luc}'` : "clock_timestamp()";
  return mot<string>(`INSERT INTO app_private.profit_ledger_salary_settlement_vouchers(id, organization_id, shareholder_id, staff_id, period_month, salary_voucher_id,
      payout_request_key, investment_amount, advance_offset_amount, suggested_investment, sheet_status_at_quote, source, state, linked_at, created_at)
    VALUES (${o.id ? `'${o.id}'` : "gen_random_uuid()"}, '${ORG_A}','${o.coDong ?? CD1}','${o.nhanVien ?? CHU}','${o.thang}', ${o.phieuLuong ? `'${o.phieuLuong}'` : "NULL"},
      ${quoted ? "'khoa-tra-luong-0001'" : "NULL"}, ${o.y}, ${o.d ?? 0}, ${o.goiY ?? "NULL"}, 'DRAFT', '${quoted ? "UI_QUOTE" : "PAYOUT_FALLBACK"}', '${o.trangThai}',
      ${o.trangThai === "LINKED" ? luc : "NULL"}, ${luc}) RETURNING id AS v`);
}

async function duLieuSau() {
  await db.exec("BEGIN");
  await db.exec(duLieuNgoaiLe());
  await ghiDongPhieuDayDu({ phieu: P_CD1_OK, loai: "SHAREHOLDER", chuThe: CD1, soTien: 20, soDuTruoc: 90, luc: "2026-08-10 09:00:01+00" });
  await ghiDongPhieuDayDu({
    phieu: P_CD1_CHO, loai: "SHAREHOLDER", chuThe: CD1, soTien: 30, tamUng: 5, nguoiLap: CD_BAOCAO, kieu: "CUSTODIAN_ADVANCE",
    nguoiNhan: CD_BAOCAO, soDuTruoc: 25, canhBao: '[{"code":"ADVANCE"}]', luc: "2026-10-10 09:00:01+00",
  });
  await ghiDongPhieuDayDu({ phieu: P_QL1, loai: "MANAGER", chuThe: QL1, soTien: 8, soDuTruoc: 15, luc: "2026-10-20 09:00:01+00" });
  await taoDongLuong({ id: L1, phieuLuong: SV1, thang: "2026-08-01", y: 12, d: 4, trangThai: "LINKED", nhanVien: CD_BAOCAO, luc: "2026-09-05 10:00:00+00" });
  await taoDongLuong({ id: L2, phieuLuong: SV2, thang: "2026-09-01", y: 0, trangThai: "NEEDS_REVIEW", goiY: 7, nhanVien: CD_BAOCAO, luc: "2026-10-12 10:00:00+00" });
  await db.exec("COMMIT");
}

// ── Gọi RPC như một người dùng ───────────────────────────────────────────────
interface KetQua<T> { v?: T; code?: string; msg?: string; detail?: string }
let trongTx = false;
async function trongGiaoDich<T>(fn: () => Promise<T>, chiDoc = false): Promise<T> {
  await db.exec(chiDoc ? "BEGIN READ ONLY" : "BEGIN");
  trongTx = true;
  try { return await fn(); } finally { trongTx = false; await db.exec("ROLLBACK"); }
}
/** Gọi `sql` (một câu, cột v) với auth.uid() = user, vai authenticated (mặc định), route = o.route; luôn hoàn tác. */
async function goi<T>(user: string | null, sql: string, o: { route?: string; vai?: string | null; chiDoc?: boolean } = {}): Promise<KetQua<T>> {
  if (!trongTx) return trongGiaoDich(() => goi<T>(user, sql, o), o.chiDoc);
  await db.exec("SAVEPOINT goi");
  try {
    await db.query("SELECT set_config('request.jwt.claim.sub', $1, true), set_config('test.route', $2, true)", [user ?? "", o.route ?? ""]);
    if (o.vai !== null) await db.exec(`SET LOCAL ROLE ${o.vai ?? "authenticated"}`);
    try {
      return { v: (await db.query<{ v: T }>(sql)).rows[0].v };
    } catch (e) {
      const x = e as { code?: string; message?: string; detail?: string };
      return { code: x.code, msg: x.message, detail: x.detail };
    }
  } finally {
    await db.exec("ROLLBACK TO SAVEPOINT goi");
    await db.exec("RELEASE SAVEPOINT goi");
  }
}
const E1 = (org = ORG_A) => `SELECT public.shareholder_profit_ledger_v1('${org}') AS v`;
const E2 = (cd: string, org = ORG_A) => `SELECT public.shareholder_profit_ledger_entries_v1('${org}','${cd}') AS v`;
const E3 = (org = ORG_A) => `SELECT public.shareholder_profit_my_ledger_v1('${org}') AS v`;
const E7 = (phieu: string) => `SELECT public.profit_ledger_payout_detail_v1('${phieu}') AS v`;
const E10 = (org = ORG_A) => `SELECT public.profit_manager_ledger_v1('${org}') AS v`;
async function lay<T>(user: string | null, sql: string, o: { route?: string } = {}): Promise<T> {
  const r = await goi<T>(user, sql, o);
  if (r.code) throw new Error(`${r.code}: ${r.msg}`);
  return r.v as T;
}
const soDu = (loai: Loai, chuThe: string, org = ORG_A) =>
  mot<SoDu>(`SELECT app_private.profit_ledger_balance_v1('${org}','${loai}','${chuThe}') AS v`);

interface SoDu {
  allocated: number; payouts_approved: number; payouts_pending: number; salary_investment: number; salary_advance_offset: number;
  balance: number; marker: { id: string; settled_through_month: string | null; ledger_seq: number; created_at: string } | null;
  excluded_before_marker: { allocated: number; payouts: number; salary: number };
  needs_review: { count: number; suggested: number };
}
interface Moc { id: string; settled_through_month: string | null; ledger_seq: number }
interface DongE1 {
  shareholder_id: string; name: string; is_active: boolean; is_deleted: boolean; has_login: boolean; marker: Moc | null;
  allocated: number; payouts_approved: number; payouts_pending: number; salary_investment: number; salary_advance_offset: number;
  balance: number; status: string; open_advance: number; needs_review_count: number;
}
interface KqE1 { organization_id: string; route: string; as_of: string; shareholders: DongE1[] }
interface DongE2 {
  kind: string; line_id: string | null; period_month: string | null; building_id: string | null; building_name: string | null;
  amount: number; suggested: number | null; voucher_id: string | null; voucher_code: string | null; voucher_date: string | null;
  voucher_status: string | null; posting_status: string | null; account_name: string | null; maker_user_id: string | null;
  is_mine: boolean; is_advance: boolean; created_at: string; excluded_by_marker: boolean; running_balance: number;
}
interface KqE2 {
  organization_id: string; shareholder: { shareholder_id: string; name: string; is_active: boolean; is_deleted: boolean; has_login: boolean };
  marker: Moc | null; totals: Omit<SoDu, "marker"> & { status: string }; entries: DongE2[];
}
interface KqE3 {
  organization_id: string; route: string; ready: boolean; shareholder: { id: string; name: string }; balance: number; status: string;
  allocated: number; paid: number; paid_pending: number; paid_via_salary: number; advance_recovered: number;
  marker: { settled_through_month: string } | null;
  months: { period_month: string; amount: number; excluded_by_marker: boolean; buildings: { building_id: string; building_name: string; amount: number }[] }[];
  payouts: { voucher_id: string; voucher_code: string | null; voucher_date: string; amount: number; status: string; posting_status: string | null;
    is_advance: boolean; is_mine: boolean; is_mine_pending: boolean; excluded_by_marker: boolean }[];
  salary: { period_month: string; investment: number; advance_offset: number; excluded_by_marker: boolean }[];
  percent_rows?: { building_id: string; building_name: string; percent: number }[];
  building_totals?: { period_month: string; building_id: string; building_name: string; revenue: number; expense: number; profit: number }[];
}
interface DongE10 {
  manager_id: string; name: string; is_active: boolean; is_deleted: boolean; has_login: boolean; marker: Moc | null;
  allocated: number; payouts_approved: number; payouts_pending: number; balance: number; status: string;
}
interface KqE7 {
  organization_id: string; route: string;
  voucher: { id: string; code: string | null; voucher_date: string; amount: number; approval_status: string; posting_status: string | null;
    system_source: string | null; account_id: string | null; account_name: string | null; is_live: boolean; created_at: string };
  subject: { kind: Loai; id: string; name: string; is_deleted: boolean; has_login: boolean };
  at_create: { balance_before: number; within: number; advance: number; warnings: unknown[]; maker_kind: string; payee_is_maker: boolean } | null;
  now: { balance_excluding_this: number; within: number; advance: number };
}

const tron = (x: number) => Math.round(x * 100) / 100 + 0;
const tong = <T,>(ds: T[], f: (x: T) => number) => tron(ds.reduce((s, x) => s + f(x), 0));
/** Mọi đường dẫn khoá cấm trong JSON (đệ quy), bỏ qua hai mảng được phép. */
function quetKhoaCam(v: unknown, duong = "$"): string[] {
  if (Array.isArray(v)) return v.flatMap((x, i) => quetKhoaCam(x, `${duong}[${i}]`));
  if (v === null || typeof v !== "object") return [];
  return Object.entries(v as Record<string, unknown>).flatMap(([k, x]) =>
    duong === "$" && (k === "percent_rows" || k === "building_totals") ? [] : [...(khoaCam(k) ? [`${duong}.${k}`] : []), ...quetKhoaCam(x, `${duong}.${k}`)]);
}
/** Mọi khoá ở mọi tầng. */
function moiKhoa(v: unknown): string[] {
  if (Array.isArray(v)) return v.flatMap(moiKhoa);
  if (v === null || typeof v !== "object") return [];
  return Object.entries(v as Record<string, unknown>).flatMap(([k, x]) => [k, ...moiKhoa(x)]);
}
/** Bất biến của sổ chi tiết so với balance_v1 (dùng cho cả ca cố định lẫn ca ngẫu nhiên). */
function kiemBatBienE2(e2: KqE2, bd: SoDu, nhan: string) {
  const dong = e2.entries;
  // Số dư chạy: dòng bị mốc loại không đổi số dư; dòng còn lại cộng đúng số tiền của nó.
  let chay = 0;
  for (const [i, d] of dong.entries()) {
    if (!d.excluded_by_marker) chay = tron(chay + d.amount);
    expect(tron(d.running_balance), `${nhan} · dòng ${i} (${d.kind})`).toBe(chay);
  }
  expect(dong.length ? tron(dong[dong.length - 1].running_balance) : 0, `${nhan} · dòng cuối = số dư`).toBe(tron(bd.balance));
  // Thời điểm vào sổ không giảm.
  for (let i = 1; i < dong.length; i++) {
    expect(Date.parse(dong[i].created_at) >= Date.parse(dong[i - 1].created_at), `${nhan} · thứ tự ${i}`).toBe(true);
  }
  const s = (f: (d: DongE2) => boolean, g: (d: DongE2) => number = (d) => d.amount) => tong(dong.filter(f), g);
  expect({
    allocated: s((d) => d.kind === "ALLOCATION" && !d.excluded_by_marker),
    payouts_approved: -s((d) => d.kind === "PAYOUT" && !d.excluded_by_marker && d.voucher_status === "APPROVED") + 0,
    payouts_pending: -s((d) => d.kind === "PAYOUT" && !d.excluded_by_marker && d.voucher_status !== "APPROVED") + 0,
    salary_investment: -s((d) => d.kind === "SALARY" && !d.excluded_by_marker) + 0,
    salary_advance_offset: s((d) => d.kind === "SALARY_OFFSET" && !d.excluded_by_marker),
    ex_allocated: s((d) => d.kind === "ALLOCATION" && d.excluded_by_marker),
    ex_payouts: -s((d) => d.kind === "PAYOUT" && d.excluded_by_marker) + 0,
    ex_salary: -s((d) => (d.kind === "SALARY" || d.kind === "SALARY_OFFSET") && d.excluded_by_marker) + 0,
    nr_count: dong.filter((d) => d.kind === "SALARY_REVIEW").length,
    nr_suggested: s((d) => d.kind === "SALARY_REVIEW", (d) => d.suggested ?? 0),
  }, `${nhan} · tổng theo loại`).toEqual({
    allocated: tron(bd.allocated), payouts_approved: tron(bd.payouts_approved), payouts_pending: tron(bd.payouts_pending),
    salary_investment: tron(bd.salary_investment), salary_advance_offset: tron(bd.salary_advance_offset),
    ex_allocated: tron(bd.excluded_before_marker.allocated), ex_payouts: tron(bd.excluded_before_marker.payouts),
    ex_salary: tron(bd.excluded_before_marker.salary), nr_count: bd.needs_review.count, nr_suggested: tron(bd.needs_review.suggested),
  });
  const { marker, ...conLai } = bd;
  expect(e2.totals, `${nhan} · totals = balance_v1`).toEqual({ ...conLai, status: bd.balance > 0 ? "OWED" : bd.balance < 0 ? "ADVANCE" : "SETTLED" });
  expect(e2.marker, `${nhan} · marker`).toEqual(marker ? { id: marker.id, settled_through_month: marker.settled_through_month, ledger_seq: marker.ledger_seq } : null);
}
/** E3 phải ra đúng số của balance_v1 và các mảng phải cộng ra đúng các số đó. */
function kiemBatBienE3(e3: KqE3, bd: SoDu, nhan: string) {
  expect({
    balance: e3.balance, allocated: e3.allocated, paid: e3.paid, paid_pending: e3.paid_pending,
    paid_via_salary: e3.paid_via_salary, advance_recovered: e3.advance_recovered,
  }, `${nhan} · số E3 = balance_v1`).toEqual({
    balance: bd.balance, allocated: bd.allocated, paid: bd.payouts_approved, paid_pending: bd.payouts_pending,
    paid_via_salary: bd.salary_investment, advance_recovered: bd.salary_advance_offset,
  });
  const songThang = e3.months.filter((m) => !m.excluded_by_marker);
  expect(tong(songThang, (m) => m.amount), `${nhan} · Σ months`).toBe(tron(bd.allocated));
  for (const m of e3.months) expect(tong(m.buildings, (b) => b.amount), `${nhan} · Σ toà tháng ${m.period_month}`).toBe(tron(m.amount));
  expect(tong(e3.payouts.filter((p) => !p.excluded_by_marker), (p) => p.amount), `${nhan} · Σ payouts`).toBe(tron(bd.payouts_approved + bd.payouts_pending));
  expect(tong(e3.salary.filter((x) => !x.excluded_by_marker), (x) => x.investment), `${nhan} · Σ lương`).toBe(tron(bd.salary_investment));
  expect(tong(e3.salary.filter((x) => !x.excluded_by_marker), (x) => x.advance_offset), `${nhan} · Σ trừ tạm ứng`).toBe(tron(bd.salary_advance_offset));
  expect(e3.marker, `${nhan} · marker`).toEqual(bd.marker?.settled_through_month ? { settled_through_month: bd.marker.settled_through_month } : null);
  expect(quetKhoaCam(e3), `${nhan} · khoá cấm`).toEqual([]);
}

beforeAll(async () => {
  await db.exec(NEN);
  await db.exec(SCOPE_V3);
  await db.exec(HELPER_QUYEN);
  await db.exec(duLieuQuyen());
  await db.exec(duLieuSo());
  await db.exec(MIGRATION_M1);
  await db.exec(MIGRATION);
  await db.exec(MIGRATION); // lượt hai: phải chạy lại được y nguyên
  await duLieuSau();
}, 120000);
afterAll(() => db.close());

describe("hình dạng và quyền gọi của các hàm", () => {
  it("năm RPC: STABLE + SECURITY DEFINER, ghim search_path, trả jsonb; chỉ authenticated có EXECUTE (không PUBLIC, anon, service_role)", async () => {
    const r = (await db.query<{ ten: string; v: string; d: boolean; cfg: string[] | null; ret: string; pub: boolean; au: boolean; an: boolean; sr: boolean }>(`
      SELECT p.oid::regprocedure::text AS ten, p.provolatile AS v, p.prosecdef AS d, p.proconfig AS cfg, p.prorettype::regtype::text AS ret,
             EXISTS (SELECT 1 FROM aclexplode(p.proacl) a WHERE a.grantee = 0) AS pub,
             has_function_privilege('authenticated', p.oid, 'EXECUTE') AS au, has_function_privilege('anon', p.oid, 'EXECUTE') AS an,
             has_function_privilege('service_role', p.oid, 'EXECUTE') AS sr
        FROM pg_proc p WHERE p.oid = ANY($1::regprocedure[]) ORDER BY 1`, [RPC])).rows;
    expect(r).toHaveLength(5);
    for (const f of r) {
      expect(f, f.ten).toMatchObject({ v: "s", d: true, ret: "jsonb", pub: false, au: true, an: false, sr: false });
      expect((f.cfg ?? []).some((c) => c.startsWith("search_path=")), f.ten).toBe(true);
    }
  });
  it("hàm phụ app_private: không ai ngoài chủ hàm có EXECUTE, ghim search_path, không VOLATILE; gọi bằng authenticated bị 42501", async () => {
    const r = (await db.query<{ ten: string; v: string; acl_la: number; acl_null: boolean; cfg: string[] | null }>(`
      SELECT p.oid::regprocedure::text AS ten, p.provolatile AS v, p.proacl IS NULL AS acl_null, p.proconfig AS cfg,
             (SELECT count(*)::int FROM aclexplode(p.proacl) a WHERE a.grantee <> p.proowner) AS acl_la
        FROM pg_proc p WHERE p.oid = ANY($1::regprocedure[])`, [PHU])).rows;
    expect(r).toHaveLength(PHU.length);
    for (const f of r) {
      expect(f, f.ten).toMatchObject({ acl_null: false, acl_la: 0 });
      expect(f.v, f.ten).not.toBe("v");
      expect((f.cfg ?? []).some((c) => c.startsWith("search_path=")), f.ten).toBe(true);
    }
    await trongGiaoDich(async () => {
      await db.exec("GRANT USAGE ON SCHEMA app_private TO authenticated");
      const a = await goi(CHU, `SELECT app_private.profit_ledger_doc_shareholder_v1('${ORG_A}','${CD1}') AS v`);
      expect(a.code).toBe("42501");
      const b = await goi(CHU, `SELECT app_private.profit_ledger_doc_can_v1('${ORG_A}', ARRAY['shareholder_profit.lock']) AS v`);
      expect(b.code).toBe("42501");
    });
  });
  it("anon và service_role không gọi được RPC nào (thiếu EXECUTE ⇒ 42501)", async () => {
    for (const vai of ["anon", "service_role"]) {
      for (const sql of [E1(), E2(CD1), E3(), E7(P_CD1_CHO), E10()]) {
        expect((await goi(CHU, sql, { vai })).code, `${vai} · ${sql}`).toBe("42501");
      }
    }
  });
  it("lượt chạy lại không tạo hàm trùng: đúng 9 hàm, một bản mỗi tên", async () => {
    const r = (await db.query<{ ten: string; n: number }>(`
      SELECT p.proname AS ten, count(*)::int AS n FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE (n.nspname = 'public' AND p.proname IN ('shareholder_profit_ledger_v1','shareholder_profit_ledger_entries_v1','shareholder_profit_my_ledger_v1',
                                                     'profit_ledger_payout_detail_v1','profit_manager_ledger_v1'))
          OR (n.nspname = 'app_private' AND p.proname LIKE 'profit_ledger_doc_%')
       GROUP BY 1`)).rows;
    expect(r).toHaveLength(9);
    for (const f of r) expect(f.n, f.ten).toBe(1);
  });
  it("không hàm nào mang mẫu khoá dòng mà gate stable-fn-locks dò, không gọi hàm nào có mẫu đó; thân RPC có primitive auth.uid() cho gate definer-body-authz", async () => {
    // Cùng hai biểu thức hạt giống và cách bỏ chú thích của scripts/check-stable-fn-locks.mjs (bao đóng theo tên, sâu 4).
    const r = (await db.query<{ nm: string }>(String.raw`
      WITH RECURSIVE fns AS (
        SELECT p.oid, p.proname AS nm,
               regexp_replace(regexp_replace(pg_get_functiondef(p.oid), '/\*.*?\*/', ' ', 'gs'), '--[^' || chr(10) || ']*', ' ', 'g') AS def
          FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE p.prokind IN ('f', 'p') AND n.nspname IN ('public', 'app_private')),
      seed AS (
        SELECT oid, nm, 0 AS depth FROM fns
         WHERE def ~* '\mfor\s+(share|update|no key update|key share)\M' OR def ~* '\mlock\s+(table\s+)?[a-z_.]'),
      closure AS (
        SELECT oid, nm, depth FROM seed
        UNION
        SELECT f.oid, f.nm, c.depth + 1 FROM fns f JOIN closure c ON c.depth < 4 AND f.oid <> c.oid AND f.def ~ ('\m' || c.nm || '\s*\('))
      SELECT DISTINCT c.nm FROM closure c
       WHERE c.nm LIKE 'profit_ledger_doc_%' OR c.nm IN ('shareholder_profit_ledger_v1','shareholder_profit_ledger_entries_v1',
             'shareholder_profit_my_ledger_v1','profit_ledger_payout_detail_v1','profit_manager_ledger_v1')`)).rows;
    expect(r).toEqual([]);
    for (const ten of RPC) {
      const than = await mot<string>(`SELECT p.prosrc AS v FROM pg_proc p WHERE p.oid = '${ten}'::regprocedure`);
      expect(than, ten).toContain("auth.uid()");
    }
  });
  it("mọi RPC chạy được trong giao dịch CHỈ ĐỌC với vai authenticated (PostgREST gọi hàm STABLE như vậy — không 25006)", async () => {
    await trongGiaoDich(async () => {
      for (const [user, sql] of [[CHU, E1()], [CHU, E2(CD1)], [CD_BAOCAO, E3()], [CD_DU, E3()], [CHU, E7(P_CD1_CHO)], [CHU, E7(P_CD1_CU)], [CHU, E10()]] as const) {
        const r = await goi(user, sql);
        expect(r.code, `${sql}: ${r.msg}`).toBeUndefined();
      }
      expect(await mot<string>("SELECT current_setting('transaction_read_only') AS v")).toBe("on");
    }, true);
  });
});

describe("ma trận quyền", () => {
  // [tên, người, E1, E2(CD1), E3, E7 phiếu cổ đông, E7 phiếu lương điều hành, E10] — "OK" hoặc mã lỗi.
  const ma: [string, string | null, string, string, string, string, string, string][] = [
    ["chủ công ty (đủ quyền lợi nhuận, không phải cổ đông)", CHU, "OK", "OK", "42501", "OK", "OK", "OK"],
    ["chỉ quyền chốt LN (lock)", KHOA, "OK", "OK", "42501", "OK", "OK", "OK"],
    ["chỉ quyền mở chốt (unlock): không xem sổ lương điều hành", MO_KHOA, "OK", "OK", "42501", "OK", "OK", "42501"],
    ["chỉ quyền quản lý cổ đông", QL_CD, "OK", "OK", "42501", "OK", "OK", "OK"],
    ["chỉ quyền chi lương điều hành (pay_manager)", QL_CHI, "42501", "42501", "42501", "42501", "OK", "OK"],
    ["chỉ quyền shareholder_profit.view (không đủ cho sổ tổng)", NGUOI_XEM, "42501", "42501", "42501", "42501", "42501", "42501"],
    ["cổ đông chỉ có reports_finance.profit_distribution", CD_BAOCAO, "42501", "42501", "OK", "42501", "42501", "42501"],
    ["cổ đông có profit_distribution, view_percent đã GỠ", CD_GO_PT, "42501", "42501", "OK", "42501", "42501", "42501"],
    ["cổ đông chỉ có quyền tạm ứng từ sổ mình giữ", CD_TAMUNG, "42501", "42501", "OK", "42501", "42501", "42501"],
    ["cổ đông không có quyền nào", CD_KHONG, "42501", "42501", "42501", "42501", "42501", "42501"],
    ["cổ đông có đủ ba quyền xem", CD_DU, "42501", "42501", "OK", "42501", "42501", "42501"],
    ["cổ đông ĐÃ XOÁ còn đăng nhập + profit_distribution", CD_XOA_USER, "42501", "42501", "42501", "42501", "42501", "42501"],
    ["tài khoản gắn hai cổ đông chưa xoá", CD_HAI, "42501", "42501", "55000", "42501", "42501", "42501"],
    ["thành viên không có quyền nào", NGUOI_LA, "42501", "42501", "42501", "42501", "42501", "42501"],
    ["chủ công ty KHÁC", NGOAI, "42501", "42501", "42501", "42501", "42501", "42501"],
    ["super admin (không phải cổ đông)", SUPER, "OK", "OK", "42501", "OK", "OK", "OK"],
    ["chưa đăng nhập", null, "42501", "42501", "42501", "42501", "42501", "42501"],
  ];
  it.each(ma)("%s", async (_ten, user, e1, e2, e3, e7cd, e7ql, e10) => {
    const ket = async (sql: string) => { const r = await goi(user, sql); return r.code ?? "OK"; };
    expect({
      e1: await ket(E1()), e2: await ket(E2(CD1)), e3: await ket(E3()), e7cd: await ket(E7(P_CD1_CHO)), e7ql: await ket(E7(P_QL1)), e10: await ket(E10()),
    }).toEqual({ e1, e2, e3, e7cd, e7ql, e10 });
  });
  it("chủ công ty B xem được sổ của công ty B (kể cả E3 vì là cổ đông ở đó), không xem được công ty A", async () => {
    const e1 = await lay<KqE1>(NGOAI, E1(ORG_B));
    expect(e1.shareholders.map((s) => s.shareholder_id)).toEqual([CD_B]);
    expect((await lay<KqE3>(NGOAI, E3(ORG_B))).shareholder.id).toBe(CD_B);
    expect((await lay<KqE7>(NGOAI, E7(P_B))).subject.id).toBe(CD_B);
    expect((await lay<{ managers: DongE10[] }>(NGOAI, E10(ORG_B))).managers.map((m) => m.manager_id)).toEqual([QL_B]);
    expect((await goi(NGOAI, E2(CD1, ORG_B))).code).toBe("42501");
  });
  it("'không có' và 'không được xem' trả CÙNG mã và CÙNG câu (không lộ cổ đông / phiếu của công ty khác)", async () => {
    const loi = async (user: string, sql: string) => { const r = await goi(user, sql); return `${r.code}|${r.msg}`; };
    // E2: cổ đông công ty khác, id không tồn tại, người không có quyền.
    const e2 = [await loi(CHU, E2(CD_B)), await loi(CHU, E2(id(9999))), await loi(NGUOI_LA, E2(CD1)), await loi(NGOAI, E2(CD1))];
    expect(new Set(e2).size, e2.join("\n")).toBe(1);
    expect(e2[0]).toMatch(/^42501\|PROFIT_LEDGER_FORBIDDEN: /);
    // E7: phiếu công ty khác, phiếu không phải phiếu chi lợi nhuận, id không tồn tại, người không có quyền.
    const e7 = [await loi(CHU, E7(P_B)), await loi(CHU, E7(P_KHAC)), await loi(CHU, E7(SV1)), await loi(CHU, E7(id(9999))), await loi(NGUOI_LA, E7(P_CD1_CHO))];
    expect(new Set(e7).size, e7.join("\n")).toBe(1);
    expect(e7[0]).toMatch(/^42501\|PROFIT_LEDGER_FORBIDDEN: /);
    // E3: không phải cổ đông, cổ đông không có quyền, cổ đông đã xoá, công ty khác.
    const e3 = [await loi(CHU, E3()), await loi(CD_KHONG, E3()), await loi(CD_XOA_USER, E3()), await loi(CD_BAOCAO, E3(ORG_B)), await loi(NGUOI_LA, E3())];
    expect(new Set(e3).size, e3.join("\n")).toBe(1);
    // E1 / E10: công ty không tồn tại và công ty không có quyền.
    const e1 = [await loi(CHU, E1(id(9998))), await loi(CHU, E1(ORG_B)), await loi(NGUOI_LA, E1())];
    expect(new Set(e1).size, e1.join("\n")).toBe(1);
    const e10 = [await loi(CHU, E10(id(9998))), await loi(CHU, E10(ORG_B)), await loi(NGUOI_LA, E10())];
    expect(new Set(e10).size, e10.join("\n")).toBe(1);
  });
  it("thiếu tham số ⇒ 22023 (sau khi đã đăng nhập); chưa đăng nhập luôn là 42501", async () => {
    for (const sql of [
      "SELECT public.shareholder_profit_ledger_v1(NULL) AS v", "SELECT public.shareholder_profit_my_ledger_v1(NULL) AS v",
      `SELECT public.shareholder_profit_ledger_entries_v1('${ORG_A}', NULL) AS v`, "SELECT public.profit_ledger_payout_detail_v1(NULL) AS v",
      "SELECT public.profit_manager_ledger_v1(NULL) AS v",
    ]) {
      expect((await goi(SUPER, sql)).code, sql).toBe("22023");
      expect((await goi(null, sql)).code, sql).toBe("42501");
    }
  });
  it("gỡ quyền là mất ngay: ngoại lệ ALLOW còn sống ⇒ xem được; thu hồi ⇒ 42501 (E1) / mất percent_rows (E3)", async () => {
    await trongGiaoDich(async () => {
      await db.exec(ngoaiLeSql(id(250), NGUOI_LA, "shareholder_profit.distribute", false));
      expect((await goi(NGUOI_LA, E1())).code).toBeUndefined();
      await db.exec(`UPDATE public.member_permission_overrides SET revoked_at = now() WHERE id = '${id(250)}'`);
      expect((await goi(NGUOI_LA, E1())).code).toBe("42501");

      await db.exec(ngoaiLeSql(id(251), CD_GO_PT, K_XEM_PT, false));
      expect((await lay<KqE3>(CD_GO_PT, E3())).percent_rows).toEqual([{ building_id: TOA_1, building_name: "Toà Một", percent: 15 }]);
      await db.exec(`UPDATE public.member_permission_overrides SET revoked_at = now() WHERE id = '${id(251)}'`);
      const sau = await lay<KqE3>(CD_GO_PT, E3());
      expect(moiKhoa(sau)).not.toContain("percent_rows");
      expect(quetKhoaCam(sau)).toEqual([]);
    });
  });
});

describe("E1 — chủ xem sổ tổng mọi cổ đông", () => {
  it("cổ đông chưa xoá + cổ đông đã xoá còn số dư / còn phiếu chờ duyệt; đã xoá mà hết số thì không có; công ty khác không có", async () => {
    const r = await lay<KqE1>(CHU, E1());
    const mongDoi = (await db.query<{ id: string }>(`SELECT s.id FROM public.shareholders s WHERE s.id = ANY($1::uuid[])
      ORDER BY s.deleted_at IS NOT NULL, s.name, s.id`, [[CD1, CD2, CD3, CD4, CD5, CD6, CD7, CD_NOLOGIN, CD_XOA, CD_XOA_CHO]])).rows.map((x) => x.id);
    expect(r.shareholders.map((s) => s.shareholder_id)).toEqual(mongDoi);
    expect(r.shareholders.map((s) => s.shareholder_id)).not.toContain(CD_XOA0);
    expect(r).toMatchObject({ organization_id: ORG_A, route: "LEGACY" });
    expect(Number.isNaN(Date.parse(r.as_of))).toBe(false);
  });
  it("mọi con số = balance_v1; status / open_advance / needs_review_count / cờ của từng cổ đông", async () => {
    const r = await lay<KqE1>(CHU, E1());
    for (const s of r.shareholders) {
      const bd = await soDu("SHAREHOLDER", s.shareholder_id);
      expect({ ...s }, s.name).toMatchObject({
        allocated: bd.allocated, payouts_approved: bd.payouts_approved, payouts_pending: bd.payouts_pending,
        salary_investment: bd.salary_investment, salary_advance_offset: bd.salary_advance_offset, balance: bd.balance,
        needs_review_count: bd.needs_review.count, open_advance: Math.max(-bd.balance, 0),
        status: bd.balance > 0 ? "OWED" : bd.balance < 0 ? "ADVANCE" : "SETTLED", marker: null,
      });
    }
    const theo = Object.fromEntries(r.shareholders.map((s) => [s.shareholder_id, s]));
    expect(theo[CD1]).toEqual({
      shareholder_id: CD1, name: "Cổ đông 1", is_active: true, is_deleted: false, has_login: true, marker: null,
      allocated: 154.5, payouts_approved: 30, payouts_pending: 30, salary_investment: 12, salary_advance_offset: 4,
      balance: 86.5, status: "OWED", open_advance: 0, needs_review_count: 1,
    });
    expect(theo[CD4]).toMatchObject({ balance: -3, status: "ADVANCE", open_advance: 3 });
    expect(theo[CD3]).toMatchObject({ is_active: false, is_deleted: false });
    expect(theo[CD_NOLOGIN]).toMatchObject({ has_login: false, balance: 0, status: "SETTLED" });
    expect(theo[CD_XOA]).toMatchObject({ is_deleted: true, balance: 33 });
    expect(theo[CD_XOA_CHO]).toMatchObject({ is_deleted: true, balance: 0, payouts_pending: 10 });
  });
  it("marker = {id, settled_through_month, ledger_seq} của dòng mốc hiệu lực; dòng gỡ mốc vẫn trả id (tháng null) để so khi đặt mốc mới", async () => {
    await trongGiaoDich(async () => {
      const m1 = await datMoc("SHAREHOLDER", CD2, "2026-07-01");
      const seq = Number(await mot<string>(`SELECT ledger_seq::text AS v FROM app_private.profit_ledger_markers WHERE id = '${m1}'`));
      let cd2 = (await lay<KqE1>(CHU, E1())).shareholders.find((s) => s.shareholder_id === CD2)!;
      expect(cd2.marker).toEqual({ id: m1, settled_through_month: "2026-07-01", ledger_seq: seq });
      expect(cd2).toMatchObject({ allocated: 20, balance: 20 });
      const m2 = await datMoc("SHAREHOLDER", CD2, null, m1);
      cd2 = (await lay<KqE1>(CHU, E1())).shareholders.find((s) => s.shareholder_id === CD2)!;
      expect(cd2.marker).toMatchObject({ id: m2, settled_through_month: null });
      expect(cd2).toMatchObject({ allocated: 70, balance: 70 });
    });
  });
  it("route lấy từ cờ sổ tổng (mọi route đều trả dữ liệu)", async () => {
    for (const route of ["LEGACY", "SHADOW", "CANONICAL", "FROZEN"]) {
      const r = await lay<KqE1>(CHU, E1(), { route });
      expect(r.route).toBe(route);
      expect(r.shareholders.length).toBeGreaterThan(0);
    }
  });
});

describe("E2 — sổ chi tiết một cổ đông", () => {
  it("đủ dòng, đúng thứ tự vào sổ, đúng dấu; số dư chạy kết thúc ở đúng số dư (86.5)", async () => {
    const r = await lay<KqE2>(CHU, E2(CD1));
    expect(r.shareholder).toEqual({ shareholder_id: CD1, name: "Cổ đông 1", is_active: true, is_deleted: false, has_login: true });
    expect(r.entries.map((d) => [d.kind, d.voucher_id ?? d.line_id, d.amount, d.running_balance])).toEqual([
      ["PAYOUT", P_CD1_CU, -10, -10],
      ["ALLOCATION", r.entries[1].line_id, 100, 90],
      ["PAYOUT", P_CD1_OK, -20, 70],
      ["ALLOCATION", r.entries[3].line_id, -15.5, 54.5],
      ["ALLOCATION", r.entries[4].line_id, 40, 94.5],
      ["SALARY", SV1, -12, 82.5],
      ["SALARY_OFFSET", SV1, 4, 86.5],
      ["ALLOCATION", r.entries[7].line_id, 30, 116.5],
      ["PAYOUT", P_CD1_CHO, -30, 86.5],
      ["SALARY_REVIEW", SV2, 0, 86.5],
    ]);
    expect(r.entries.filter((d) => d.kind === "ALLOCATION").map((d) => [d.period_month, d.building_id, d.building_name])).toEqual([
      ["2026-07-01", TOA_1, "Toà Một"], ["2026-08-01", TOA_2, "Toà Hai"], ["2026-08-01", TOA_1, "Toà Một"], ["2026-09-01", TOA_2, "Toà Hai"],
    ]);
    // Phiếu bị từ chối và kỳ chưa chốt không có trong sổ.
    expect(r.entries.map((d) => d.voucher_id)).not.toContain(P_CD1_TUCHOI);
    expect(r.entries.some((d) => d.amount === 999)).toBe(false);
    kiemBatBienE2(r, await soDu("SHAREHOLDER", CD1), "cố định");
  });
  it("dòng PAYOUT có posting_status, account_name, maker_user_id, is_mine (người gọi là người lập), is_advance", async () => {
    const r = await lay<KqE2>(CHU, E2(CD1));
    const p = Object.fromEntries(r.entries.filter((d) => d.kind === "PAYOUT").map((d) => [d.voucher_id, d]));
    expect(p[P_CD1_OK]).toMatchObject({
      voucher_code: "PC-OK", voucher_date: "2026-08-10", voucher_status: "APPROVED", posting_status: "POSTED", account_name: "Quỹ tiền mặt",
      maker_user_id: CHU, is_mine: true, is_advance: false, building_id: TOA_AO, building_name: "Toà ảo", excluded_by_marker: false,
    });
    expect(Date.parse(p[P_CD1_OK].created_at)).toBe(Date.parse("2026-08-10T09:00:01Z"));
    expect(p[P_CD1_CHO]).toMatchObject({ voucher_status: "UNAPPROVED", posting_status: "UNPOSTED", maker_user_id: CD_BAOCAO, is_mine: false, is_advance: true });
    // Phiếu cũ không có dòng sổ: không biết người lập.
    expect(p[P_CD1_CU]).toMatchObject({ maker_user_id: null, is_mine: false, is_advance: false });
    // Người khác gọi thì không có dòng nào "của mình".
    expect((await lay<KqE2>(KHOA, E2(CD1))).entries.some((d) => d.is_mine)).toBe(false);
    const l = r.entries.filter((d) => d.kind.startsWith("SALARY"));
    expect(l.map((d) => [d.kind, d.line_id, d.period_month, d.voucher_code, d.voucher_status, d.suggested, d.posting_status, d.maker_user_id])).toEqual([
      ["SALARY", L1, "2026-08-01", "PL-08", "APPROVED", null, null, null],
      ["SALARY_OFFSET", L1, "2026-08-01", "PL-08", "APPROVED", null, null, null],
      ["SALARY_REVIEW", L2, "2026-09-01", "PL-09", "APPROVED", 7, null, null],
    ]);
  });
  it("mốc 'đã trả đủ hết tháng 8': dòng trước mốc mờ (không đổi số dư chạy), dòng sau mốc cộng tiếp; gỡ mốc ⇒ như cũ", async () => {
    await trongGiaoDich(async () => {
      const moc = await datMoc("SHAREHOLDER", CD1, "2026-08-01");
      let r = await lay<KqE2>(CHU, E2(CD1));
      expect(r.entries.map((d) => [d.kind, d.excluded_by_marker, d.running_balance])).toEqual([
        ["PAYOUT", true, 0], ["ALLOCATION", true, 0], ["PAYOUT", true, 0], ["ALLOCATION", true, 0], ["ALLOCATION", true, 0],
        ["SALARY", true, 0], ["SALARY_OFFSET", true, 0], ["ALLOCATION", false, 30], ["PAYOUT", true, 30], ["SALARY_REVIEW", false, 30],
      ]);
      expect(r.marker).toMatchObject({ id: moc, settled_through_month: "2026-08-01" });
      kiemBatBienE2(r, await soDu("SHAREHOLDER", CD1), "có mốc");
      // Phiếu lập SAU mốc (thứ tự sổ lớn hơn) vẫn trừ.
      await taoPhieu({ id: id(140), soTien: 5, coDong: CD1, trangThai: "UNAPPROVED" });
      await ghiDongPhieu(id(140), "SHAREHOLDER", CD1, 5);
      r = await lay<KqE2>(CHU, E2(CD1));
      expect(r.entries.at(-1)).toMatchObject({ kind: "PAYOUT", voucher_id: id(140), excluded_by_marker: false, running_balance: 25 });
      kiemBatBienE2(r, await soDu("SHAREHOLDER", CD1), "phiếu sau mốc");
      await datMoc("SHAREHOLDER", CD1, null, moc);
      r = await lay<KqE2>(CHU, E2(CD1));
      expect(r.entries.every((d) => !d.excluded_by_marker)).toBe(true);
      expect(r.entries.at(-1)?.running_balance).toBe(81.5);
      expect(r.marker).toMatchObject({ settled_through_month: null });
      kiemBatBienE2(r, await soDu("SHAREHOLDER", CD1), "gỡ mốc");
    });
  });
  it("cổ đông đã xoá vẫn xem được sổ; cổ đông không có dòng nào ⇒ entries rỗng, số dư 0", async () => {
    const xoa = await lay<KqE2>(CHU, E2(CD_XOA));
    expect(xoa.shareholder).toMatchObject({ is_deleted: true });
    expect(xoa.entries.at(-1)?.running_balance).toBe(33);
    const rong = await lay<KqE2>(CHU, E2(CD_NOLOGIN));
    expect(rong.entries).toEqual([]);
    expect(rong.totals).toMatchObject({ balance: 0, status: "SETTLED" });
  });
  it("phiếu sổ tổng bị từ chối / huỷ / xoá rơi khỏi sổ; phiếu lương bị huỷ kéo dòng lương ra theo", async () => {
    await trongGiaoDich(async () => {
      await taoYeuCau(P_CD1_CHO, "REJECTED", 2);
      await db.exec(`UPDATE public.income_expenses SET approval_status = 'CANCELLED' WHERE id = '${SV1}'`);
      const r = await lay<KqE2>(CHU, E2(CD1));
      expect(r.entries.map((d) => d.voucher_id)).not.toContain(P_CD1_CHO);
      expect(r.entries.some((d) => d.kind === "SALARY" || d.kind === "SALARY_OFFSET")).toBe(false);
      kiemBatBienE2(r, await soDu("SHAREHOLDER", CD1), "từ chối + huỷ phiếu lương");
      expect(r.totals.balance).toBe(124.5);
    });
  });
});

describe("E3 — cổ đông tự xem tiền của mình", () => {
  it("đúng số của chính mình, không % và không số toà khi thiếu hai quyền xem", async () => {
    const r = await lay<KqE3>(CD_BAOCAO, E3());
    expect(r).toEqual({
      organization_id: ORG_A, route: "LEGACY", ready: false, shareholder: { id: CD1, name: "Cổ đông 1" },
      balance: 86.5, status: "OWED", allocated: 154.5, paid: 30, paid_pending: 30, paid_via_salary: 12, advance_recovered: 4, marker: null,
      months: [
        { period_month: "2026-07-01", amount: 100, excluded_by_marker: false, buildings: [{ building_id: TOA_1, building_name: "Toà Một", amount: 100 }] },
        { period_month: "2026-08-01", amount: 24.5, excluded_by_marker: false, buildings: [
          { building_id: TOA_2, building_name: "Toà Hai", amount: -15.5 }, { building_id: TOA_1, building_name: "Toà Một", amount: 40 }] },
        { period_month: "2026-09-01", amount: 30, excluded_by_marker: false, buildings: [{ building_id: TOA_2, building_name: "Toà Hai", amount: 30 }] },
      ],
      payouts: [
        { voucher_id: P_CD1_CU, voucher_code: "PC-CU", voucher_date: "2026-07-15", amount: 10, status: "APPROVED", posting_status: "POSTED",
          is_advance: false, is_mine: false, is_mine_pending: false, excluded_by_marker: false },
        { voucher_id: P_CD1_OK, voucher_code: "PC-OK", voucher_date: "2026-08-10", amount: 20, status: "APPROVED", posting_status: "POSTED",
          is_advance: false, is_mine: false, is_mine_pending: false, excluded_by_marker: false },
        { voucher_id: P_CD1_CHO, voucher_code: "PC-CHO", voucher_date: "2026-10-10", amount: 30, status: "UNAPPROVED", posting_status: "UNPOSTED",
          is_advance: true, is_mine: true, is_mine_pending: true, excluded_by_marker: false },
      ],
      salary: [{ period_month: "2026-08-01", investment: 12, advance_offset: 4, excluded_by_marker: false }],
    });
    kiemBatBienE3(r, await soDu("SHAREHOLDER", CD1), "cố định");
  });
  it("quét đệ quy: thiếu quyền xem thì KHÔNG có percent / computed_profit / adjusted_profit / source_* / management_salary / shareholder_percent_total ở bất kỳ tầng nào", async () => {
    for (const user of [CD_BAOCAO, CD_GO_PT, CD_TAMUNG]) {
      for (const route of ["LEGACY", "SHADOW", "CANONICAL", "FROZEN"]) {
        const r = await lay<KqE3>(user, E3(), { route });
        const khoa = moiKhoa(r);
        expect(khoa.filter(khoaCam), `${user} · ${route}`).toEqual([]);
        expect(khoa, `${user} · ${route}`).not.toContain("percent_rows");
        expect(khoa, `${user} · ${route}`).not.toContain("building_totals");
      }
    }
  });
  it("chỉ tiền của chính mình: không có id cổ đông, phiếu, người nhận lương điều hành nào khác trong kết quả", async () => {
    const chuoi = JSON.stringify(await lay<KqE3>(CD_BAOCAO, E3()));
    for (const la of [CD2, CD3, CD4, CD5, CD_XOA, CD_XOA0, CD_XOA_CHO, CD6, CD7, CD_NOLOGIN, CD_B, QL1, QL2, P_CD4, P_XOA0, P_XOA_CHO, P_QL1, P_KHAC, P_B, PM_07]) {
      expect(chuoi).not.toContain(la);
    }
    // Không có người lập / người nhận của phiếu (chỉ cờ is_mine).
    expect(chuoi).not.toContain(CHU);
  });
  it("người chỉ có quyền tạm ứng nhận CÙNG hình dạng (tiền của chính mình), không %", async () => {
    const r = await lay<KqE3>(CD_TAMUNG, E3());
    expect(r).toMatchObject({ shareholder: { id: CD3 }, allocated: 10, balance: 10, paid: 0, months: [{ period_month: "2026-07-01", amount: 10 }] });
    const chuan = await lay<KqE3>(CD_BAOCAO, E3());
    expect(Object.keys(r).sort()).toEqual(Object.keys(chuan).sort());
  });
  it("đủ view_percent + view_building_totals: percent_rows (cấu hình hiện hành của chính mình, toà còn, đúng công ty) và building_totals (toà/tháng mình có phân bổ)", async () => {
    const r = await lay<KqE3>(CD_DU, E3());
    expect(r.percent_rows).toEqual([{ building_id: TOA_1, building_name: "Toà Một", percent: 20 }]);
    expect(r.building_totals).toEqual([
      { period_month: "2026-07-01", building_id: TOA_1, building_name: "Toà Một", revenue: 1000, expense: 400, profit: 600 },
      { period_month: "2026-08-01", building_id: TOA_1, building_name: "Toà Một", revenue: 800, expense: 500, profit: 300 },
    ]);
    // Ngoài hai mảng vẫn không có khoá cấm; trong hai mảng chỉ có đúng các khoá đã hẹn.
    expect(quetKhoaCam(r)).toEqual([]);
    expect(Object.keys(r.percent_rows![0]).sort()).toEqual(["building_id", "building_name", "percent"]);
    expect(Object.keys(r.building_totals![0]).sort()).toEqual(["building_id", "building_name", "expense", "period_month", "profit", "revenue"]);
    kiemBatBienE3(r, await soDu("SHAREHOLDER", CD5), "đủ quyền");
  });
  it("ready = route khác LEGACY; mọi route đều trả dữ liệu", async () => {
    for (const [route, ready] of [["LEGACY", false], ["SHADOW", true], ["CANONICAL", true], ["FROZEN", true]] as const) {
      const r = await lay<KqE3>(CD_BAOCAO, E3(), { route });
      expect({ route: r.route, ready: r.ready, balance: r.balance }).toEqual({ route, ready, balance: 86.5 });
    }
  });
  it("mốc: marker chỉ có tháng {settled_through_month}; tháng / phiếu / lương trước mốc mang excluded_by_marker", async () => {
    await trongGiaoDich(async () => {
      await datMoc("SHAREHOLDER", CD1, "2026-08-01");
      const r = await lay<KqE3>(CD_BAOCAO, E3());
      expect(r.marker).toEqual({ settled_through_month: "2026-08-01" });
      expect(r.months.map((m) => [m.period_month, m.excluded_by_marker])).toEqual([["2026-07-01", true], ["2026-08-01", true], ["2026-09-01", false]]);
      expect(r.payouts.every((p) => p.excluded_by_marker)).toBe(true);
      expect(r.salary).toEqual([{ period_month: "2026-08-01", investment: 12, advance_offset: 4, excluded_by_marker: true }]);
      expect(r).toMatchObject({ balance: 30, allocated: 30, paid: 0, paid_pending: 0, paid_via_salary: 0, advance_recovered: 0 });
      kiemBatBienE3(r, await soDu("SHAREHOLDER", CD1), "có mốc");
    });
  });
  it("is_mine_pending chỉ khi phiếu do CHÍNH mình lập VÀ còn chờ duyệt", async () => {
    await trongGiaoDich(async () => {
      await taoPhieu({ id: id(142), soTien: 3, coDong: CD1, trangThai: "APPROVED" });
      await ghiDongPhieuDayDu({ phieu: id(142), loai: "SHAREHOLDER", chuThe: CD1, soTien: 3, tamUng: 3, nguoiLap: CD_BAOCAO, kieu: "CUSTODIAN_ADVANCE", nguoiNhan: CD_BAOCAO });
      const ds = (await lay<KqE3>(CD_BAOCAO, E3())).payouts;
      expect(ds.find((x) => x.voucher_id === id(142))).toMatchObject({ is_mine: true, is_mine_pending: false, is_advance: true, status: "APPROVED" });
      expect(ds.find((x) => x.voucher_id === P_CD1_CHO)).toMatchObject({ is_mine: true, is_mine_pending: true });
      expect(ds.find((x) => x.voucher_id === P_CD1_OK)).toMatchObject({ is_mine: false, is_mine_pending: false });
    });
  });
  it("tài khoản gắn hai cổ đông chưa xoá ⇒ 55000 PROFIT_LEDGER_SHAREHOLDER_AMBIGUOUS (không đoán cổ đông nào)", async () => {
    const r = await goi(CD_HAI, E3());
    expect(r.code).toBe("55000");
    expect(r.msg).toMatch(/^PROFIT_LEDGER_SHAREHOLDER_AMBIGUOUS: /);
  });
});

describe("E7 — chi tiết phiếu chi để duyệt", () => {
  it("phiếu tạm ứng của người giữ sổ: lúc lập (dòng sổ) và bây giờ (số dư nếu bỏ chính phiếu này)", async () => {
    const r = await lay<KqE7>(CHU, E7(P_CD1_CHO), { route: "CANONICAL" });
    expect(r).toMatchObject({
      organization_id: ORG_A, route: "CANONICAL",
      voucher: { id: P_CD1_CHO, code: "PC-CHO", voucher_date: "2026-10-10", amount: 30, approval_status: "UNAPPROVED", posting_status: "UNPOSTED",
        system_source: "profit.ledger_payout", account_id: SO_QUY, account_name: "Quỹ tiền mặt", is_live: true },
      subject: { kind: "SHAREHOLDER", id: CD1, name: "Cổ đông 1", is_deleted: false, has_login: true },
      at_create: { balance_before: 25, within: 25, advance: 5, warnings: [{ code: "ADVANCE" }], maker_kind: "CUSTODIAN_ADVANCE", payee_is_maker: true },
      now: { balance_excluding_this: 116.5, within: 30, advance: 0 },
    });
    const bd = await mot<SoDu>(`SELECT app_private.profit_ledger_balance_v1('${ORG_A}','SHAREHOLDER','${CD1}','${P_CD1_CHO}') AS v`);
    expect(r.now.balance_excluding_this).toBe(bd.balance);
  });
  it("phiếu cũ không có dòng sổ ⇒ at_create null; phiếu đã bị từ chối ⇒ is_live false", async () => {
    expect((await lay<KqE7>(CHU, E7(P_CD1_CU))).at_create).toBeNull();
    const tc = await lay<KqE7>(CHU, E7(P_CD1_TUCHOI));
    expect(tc.voucher.is_live).toBe(false);
    expect(tc.now).toEqual({ balance_excluding_this: 86.5, within: 40, advance: 0 });
  });
  it("lương điều hành: người chỉ có pay_manager xem được; vượt số còn lại ⇒ now.advance > 0 (duyệt sẽ bị từ chối)", async () => {
    const ok = await lay<KqE7>(QL_CHI, E7(P_QL1));
    expect(ok).toMatchObject({
      subject: { kind: "MANAGER", id: QL1, name: "Quản lý 1" },
      at_create: { balance_before: 15, within: 8, advance: 0, warnings: [], maker_kind: "OWNER", payee_is_maker: false },
      now: { balance_excluding_this: 15, within: 8, advance: 0 },
    });
    const vuot = await lay<KqE7>(QL_CHI, E7(P_QL_VUOT));
    expect(vuot).toMatchObject({ at_create: null, now: { balance_excluding_this: 4, within: 4, advance: 6 } });
  });
  it("số dư âm: toàn bộ phiếu là tạm ứng", async () => {
    await trongGiaoDich(async () => {
      await taoPhieu({ id: id(141), soTien: 7, coDong: CD4, trangThai: "UNAPPROVED" });
      expect((await lay<KqE7>(CHU, E7(id(141)))).now).toEqual({ balance_excluding_this: -3, within: 0, advance: 7 });
    });
  });
});

describe("E10 — sổ lương điều hành", () => {
  it("người nhận chưa xoá + đã nghỉ còn số; số = balance_v1; đã nghỉ hết số và công ty khác không có", async () => {
    const r = await lay<{ organization_id: string; route: string; as_of: string; managers: DongE10[] }>(QL_CHI, E10(), { route: "SHADOW" });
    expect(r).toMatchObject({ organization_id: ORG_A, route: "SHADOW" });
    expect(r.managers.map((m) => m.manager_id)).toEqual([QL1, QL2, QL_XOA]);
    expect(r.managers[0]).toEqual({
      manager_id: QL1, name: "Quản lý 1", is_active: true, is_deleted: false, has_login: false, marker: null,
      allocated: 15, payouts_approved: 0, payouts_pending: 8, balance: 7, status: "OWED",
    });
    expect(r.managers[1]).toMatchObject({ balance: -6, status: "ADVANCE" });
    expect(r.managers[2]).toMatchObject({ is_deleted: true, balance: 7 });
    for (const m of r.managers) {
      const bd = await soDu("MANAGER", m.manager_id);
      expect(m, m.name).toMatchObject({ allocated: bd.allocated, payouts_approved: bd.payouts_approved, payouts_pending: bd.payouts_pending, balance: bd.balance });
    }
  });
});

describe("đối chiếu với số dư sổ tổng: lệch là dừng", () => {
  /** Thay tạm balance_v1 bằng bản "sai" (trong giao dịch, hoàn tác sau). */
  async function thayBalance(bieuThuc: string) {
    await db.exec(`CREATE OR REPLACE FUNCTION app_private.profit_ledger_balance_v1(p_org uuid, p_kind text, p_subject uuid,
        p_exclude_voucher uuid DEFAULT NULL, p_exclude_salary_period date DEFAULT NULL) RETURNS jsonb
      LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'pg_catalog', 'app_private', 'public'
      AS $f$ SELECT ${bieuThuc} FROM (SELECT app_private.profit_ledger_balance_core_v1(p_org, p_kind, p_subject, NULL, NULL, NULL,
        p_exclude_voucher, p_exclude_salary_period) AS b) x $f$`);
  }
  it("số dư sổ tổng lệch tổng các dòng ⇒ E2 và E3 dừng XX000 PROFIT_LEDGER_ENTRIES_DRIFT (kèm DETAIL), không trả sổ sai", async () => {
    await trongGiaoDich(async () => {
      await thayBalance(`x.b || jsonb_build_object('allocated', (x.b->>'allocated')::numeric + 1, 'balance', (x.b->>'balance')::numeric + 1)`);
      for (const [user, sql] of [[CHU, E2(CD1)], [CD_BAOCAO, E3()]] as const) {
        const r = await goi(user, sql);
        expect(r.code, sql).toBe("XX000");
        expect(r.msg).toMatch(/^PROFIT_LEDGER_ENTRIES_DRIFT: /);
        expect(JSON.parse(r.detail ?? "{}")).toMatchObject({ balance: { allocated: 155.5, balance: 87.5 }, entries: { allocated: 154.5, balance: 86.5 } });
      }
    });
  });
  it("tổng số dư khớp nhưng tách đã duyệt / chờ duyệt lệch ⇒ vẫn dừng (đối chiếu từng phần, không chỉ số cuối)", async () => {
    await trongGiaoDich(async () => {
      await thayBalance(`x.b || jsonb_build_object('payouts_approved', x.b->'payouts_pending', 'payouts_pending', x.b->'payouts_approved')`);
      await db.exec(`UPDATE public.income_expenses SET total_amount = 31 WHERE id = '${P_CD1_CU}'`);
      expect((await goi(CHU, E2(CD1))).code).toBe("XX000");
    });
  });
});

describe("đối chứng ngẫu nhiên trên nhóm kịch bản của M1", () => {
  // Chép bộ sinh của soTongLoiNhuanNenMigration.test.ts (cùng hạt giống, cùng thứ tự rút số) ⇒ cùng 60 kịch bản dữ liệu.
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
  const THANG = ["2026-01-01", "2026-02-01", "2026-03-01", "2026-04-01", "2026-05-01", "2026-06-01", "2026-07-01", "2026-08-01"];
  const TRANG_THAI_YC = ["PENDING_APPROVAL", "POSTED", "DENIED", "REJECTED", "CANCELLED", "REVERSED", "APPROVED", "WITHDRAWN", "CHANGES_REQUESTED", "DISPUTED"];
  interface PhieuNN { id: string; loai: Loai | null; chuThe: string | null; tien: number; tt: "APPROVED" | "UNAPPROVED" | "CANCELLED"; xoa: boolean; thu: boolean; yc: string[]; seq: number | null; sauMoc: boolean }
  interface MocNN { id: string; loai: Loai; chuThe: string; thang: string | null; seq: number }
  const CHU_THE: [Loai, string[]][] = [["SHAREHOLDER", [CD1, CD2]], ["MANAGER", [QL1, QL2]]];
  const DANG_NHAP: Record<string, string> = { [CD1]: CD_BAOCAO, [CD2]: CD_GO_PT };
  const dem = { soSo: 0, coMoc: 0, coLoaiTru: 0, coLuong: 0, coReview: 0, soDong: 0 };

  async function kichBan(k: number) {
    let n = 5000;
    const moi = () => id(n++);
    const phieu: PhieuNN[] = [], moc: MocNN[] = [];
    await db.exec("DELETE FROM public.profit_monthly");
    for (const [org, thangs] of [[ORG_A, THANG], [ORG_B, THANG.slice(0, 3)]] as const) for (const th of thangs) for (let toa = 0; toa < 2; toa++) {
      if (xs(0.15)) continue;
      const pm = moi(), khoa = xs(0.75);
      await db.exec(`INSERT INTO public.profit_monthly(id, organization_id, building_id, period_month, status, is_stale) VALUES ('${pm}','${org}','${moi()}','${th}','${khoa ? "LOCKED" : "DRAFT"}',${xs(0.3)})`);
      for (const s of [CD1, CD2]) if (xs(0.8)) {
        const tien = nguyen(-60, 300) + (xs(0.3) ? 0.5 : 0);
        await db.exec(`INSERT INTO public.profit_allocations(profit_monthly_id, shareholder_id, amount, organization_id) VALUES ('${pm}','${s}',${tien}, ${xs(0.5) ? `'${ORG_A}'` : "NULL"})`);
      }
      for (const m of [QL1, QL2]) if (xs(0.5)) {
        const tien = nguyen(0, 60);
        await db.exec(`INSERT INTO public.profit_manager_allocations(profit_monthly_id, manager_id, amount, organization_id) VALUES ('${pm}','${m}',${tien}, ${xs(0.5) ? `'${ORG_A}'` : "NULL"})`);
      }
    }
    const taoPhieuNN = async (loai: Loai | null, chuThe: string | null): Promise<PhieuNN> => {
      const p: PhieuNN = { id: moi(), loai, chuThe, tien: nguyen(1, 120), tt: chon(["APPROVED", "APPROVED", "UNAPPROVED", "UNAPPROVED", "CANCELLED"] as const),
        xoa: xs(0.1), thu: xs(0.1), yc: Array.from({ length: chon([0, 0, 1, 1, 2]) }, () => chon(TRANG_THAI_YC)), seq: null, sauMoc: xs(0.5) };
      await taoPhieu({ id: p.id, soTien: p.tien, coDong: loai === "SHAREHOLDER" ? chuThe ?? undefined : undefined, quanLy: loai === "MANAGER" ? chuThe ?? undefined : undefined,
        trangThai: p.tt, loai: p.thu ? "INCOME" : "EXPENSE", daXoa: p.xoa, taoLuc: p.sauMoc ? "'2099-01-01'" : "'2020-01-01'" });
      for (const [i, s] of p.yc.entries()) await taoYeuCau(p.id, s, i + 1);
      if (xs(0.2)) { await taoYeuCau(p.id, "REJECTED", 9, { loai: "LOAI_KHAC" }); await taoYeuCau(p.id, "REJECTED", 9, { org: ORG_B }); }
      return p;
    };
    const viec = [...Array<string>(nguyen(4, 12)).fill("phieu"), ...Array<string>(nguyen(0, 4)).fill("moc"), ...Array<string>(nguyen(0, 5)).fill("luong")]
      .map((v) => ({ v, r: rnd() })).sort((a, b) => a.r - b.r).map((x) => x.v);
    const luongQuoted = new Set<string>();
    for (const v of viec) {
      if (v === "phieu") {
        const loai = chon<Loai | null>(["SHAREHOLDER", "SHAREHOLDER", "MANAGER", null]);
        const chuThe = loai === "SHAREHOLDER" ? chon([CD1, CD2]) : loai === "MANAGER" ? chon([QL1, QL2]) : null;
        const p = await taoPhieuNN(loai, chuThe);
        if (loai !== null && chuThe !== null && !p.xoa && !p.thu && xs(0.65)) {
          await ghiDongPhieu(p.id, loai, chuThe, p.tien);
          p.seq = 1;
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
        const d = { coDong: chon([CD1, CD2]), thang: chon(THANG), tt, y: nguyen(-20, 80), d: nguyen(0, 30), goiY: tt === "NEEDS_REVIEW" && xs(0.8) ? nguyen(0, 50) : null };
        if (tt === "QUOTED" && luongQuoted.has(d.thang)) continue;
        if (tt === "QUOTED") luongQuoted.add(d.thang);
        const phieuLuong = tt !== "QUOTED" ? (await taoPhieuNN(null, null)).id : null;
        await taoDongLuong({ phieuLuong, thang: d.thang, y: d.y, d: d.d, trangThai: tt, goiY: d.goiY ?? undefined, coDong: d.coDong });
      }
    }

    // Kiểm của M2-đọc trên đúng dữ liệu kịch bản này.
    const e1 = await lay<KqE1>(CHU, E1());
    const e10 = await lay<{ managers: DongE10[] }>(CHU, E10());
    for (const [loai, ds] of CHU_THE) for (const chuThe of ds) {
      const bd = await soDu(loai, chuThe);
      if (loai === "SHAREHOLDER") {
        const e2 = await lay<KqE2>(CHU, E2(chuThe));
        kiemBatBienE2(e2, bd, `kịch bản ${k} · E2 · ${chuThe}`);
        const e3 = await lay<KqE3>(DANG_NHAP[chuThe], E3());
        kiemBatBienE3(e3, bd, `kịch bản ${k} · E3 · ${chuThe}`);
        const dongE1 = e1.shareholders.find((s) => s.shareholder_id === chuThe);
        expect(dongE1, `kịch bản ${k} · E1 · ${chuThe}`).toMatchObject({
          allocated: bd.allocated, payouts_approved: bd.payouts_approved, payouts_pending: bd.payouts_pending,
          salary_investment: bd.salary_investment, salary_advance_offset: bd.salary_advance_offset, balance: bd.balance,
          needs_review_count: bd.needs_review.count,
          marker: bd.marker ? { id: bd.marker.id, settled_through_month: bd.marker.settled_through_month, ledger_seq: bd.marker.ledger_seq } : null,
        });
        dem.soSo++; dem.soDong += e2.entries.length;
        if (bd.marker?.settled_through_month) dem.coMoc++;
        if (e2.entries.some((d) => d.excluded_by_marker && d.amount !== 0)) dem.coLoaiTru++;
        // Chỉ đếm dòng lương do kịch bản sinh (bỏ hai dòng cố định L1, L2 của CD1).
        if (e2.entries.some((d) => d.kind === "SALARY" && d.line_id !== L1)) dem.coLuong++;
        if (e2.entries.some((d) => d.kind === "SALARY_REVIEW" && d.line_id !== L2)) dem.coReview++;
      } else {
        const dongE10 = e10.managers.find((m) => m.manager_id === chuThe);
        expect(dongE10, `kịch bản ${k} · E10 · ${chuThe}`).toMatchObject({
          allocated: bd.allocated, payouts_approved: bd.payouts_approved, payouts_pending: bd.payouts_pending, balance: bd.balance,
          marker: bd.marker ? { id: bd.marker.id, settled_through_month: bd.marker.settled_through_month, ledger_seq: bd.marker.ledger_seq } : null,
        });
      }
      // Rút số đúng như test M1 làm sau mỗi chủ thể (các phép loại trừ + mốc giả định) để kịch bản sau trùng kịch bản của M1.
      const cuaToi = phieu.filter((p) => p.loai === loai && p.chuThe === chuThe);
      if (cuaToi.length) chon(cuaToi);
      chon(THANG);
      if (cuaToi.length) chon(cuaToi);
      chon(THANG);
      if (!xs(0.25)) chon(THANG);
    }
  }

  it("60 kịch bản: E2 (số dư chạy, tổng theo loại, totals, marker) = balance_v1; E3 và E1/E10 = balance_v1; không bao giờ lệch", async () => {
    for (let k = 1; k <= 60; k++) await trongGiaoDich(() => kichBan(k));
    // Chống xanh rỗng: các nhánh mốc / loại trừ / lương / chờ xem lại đều có việc để làm.
    expect(dem.soSo).toBe(120);
    expect(dem.coMoc).toBeGreaterThan(20);
    expect(dem.coLoaiTru).toBeGreaterThan(15);
    expect(dem.coLuong).toBeGreaterThan(20);
    expect(dem.coReview).toBeGreaterThan(5);
    expect(dem.soDong).toBeGreaterThan(1500);
  }, 240000);
});

describe("tiền kiểm và hậu kiểm của migration", () => {
  async function dung(o: { coM1?: boolean; suaNen?: (s: string) => string; suaMigration?: (s: string) => string }): Promise<{ loi: string; coHam: boolean }> {
    const la = new PGlite();
    try {
      await la.exec((o.suaNen ?? ((s: string) => s))(NEN));
      await la.exec(SCOPE_V3);
      await la.exec(HELPER_QUYEN);
      await la.exec(duLieuQuyen());
      if (o.coM1 !== false) await la.exec(MIGRATION_M1);
      let loi = "";
      try { await la.exec((o.suaMigration ?? ((s: string) => s))(MIGRATION)); } catch (e) {
        loi = `${(e as { code?: string }).code}: ${(e as Error).message}`;
        await la.exec("ROLLBACK");
      }
      const coHam = (await la.query<{ v: boolean }>("SELECT to_regprocedure('public.shareholder_profit_ledger_v1(uuid)') IS NOT NULL AS v")).rows[0].v;
      return { loi, coHam };
    } finally { await la.close(); }
  }
  it("chưa áp M1 ⇒ dừng 55000, không tạo hàm nào", async () => {
    const r = await dung({ coM1: false });
    expect(r.loi).toContain("55000");
    expect(r.loi).toContain("profit_ledger_balance_v1");
    expect(r.coHam).toBe(false);
  }, 60000);
  it("thiếu cột nền (profit_monthly.locked_at) ⇒ dừng 55000", async () => {
    const r = await dung({ suaNen: (s) => s.replace("is_stale boolean NOT NULL DEFAULT true, locked_at timestamptz,", "is_stale boolean NOT NULL DEFAULT true,") });
    expect(r.loi).toContain("55000");
    expect(r.loi).toContain("public.profit_monthly.locked_at");
    expect(r.coHam).toBe(false);
  }, 60000);
  it("quên REVOKE một RPC (PUBLIC còn EXECUTE) ⇒ hậu kiểm dừng 55000 và hoàn tác cả migration", async () => {
    const r = await dung({ suaMigration: (s) => s.replace("REVOKE ALL ON FUNCTION public.shareholder_profit_my_ledger_v1(uuid) FROM PUBLIC, anon, authenticated, service_role;\n", "") });
    expect(r.loi).toContain("55000");
    expect(r.loi).toContain("shareholder_profit_my_ledger_v1");
    expect(r.coHam).toBe(false);
  }, 60000);
});
