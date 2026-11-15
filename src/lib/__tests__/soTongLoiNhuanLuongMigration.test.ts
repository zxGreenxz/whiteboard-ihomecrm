import { createHash, randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { SalManager } from "@/lib/managerSalary";
import { applySalaryExtras, parseOverrideRows } from "@/lib/salaryOverrides";

/**
 * Migration 20261115083422 (M3 — phần LƯƠNG của sổ tổng lợi nhuận cổ đông): hai hàm nội bộ
 * (dòng đầu tư của lương tháng, trần D của tháng), E12–E16, trigger F3 trên salary_monthly và hàm
 * ghi bù cho Đợt 3.
 *
 * Chạy THẬT trên PostgreSQL nhúng, nạp M1 (20261115063149) trước rồi file M3 HAI lượt. Thân THẬT (không
 * stub) của: đường trả lương (vỏ public.salary_payout_v1 của cầu 20260930112705 + thân gốc
 * rent_support_salary_payout_before_v1 lấy từ baseline — đo md5 khớp production 15/11/2026), trigger
 * duyệt a70 accrue_salary_paid_on_approve, authorize_tenant_action_v3, authorized_scope_v3,
 * salary_is_admin_v1, salary_staff_org_v1, lock_org_for_decision_v1, salary_line_override_list_v1,
 * hai trigger tính tổng dòng hạng mục, guard canonical_write_operations. Stub: bộ máy duyệt
 * (submit_financial_request_v1 mở một yêu cầu PENDING), công tắc (evaluate_feature_route đọc bảng thử).
 * Mỗi ca chạy trong một giao dịch rồi ROLLBACK. Ca hai phiên và PostgREST chạy trên TEST.
 */
const DIR = "supabase/migrations";
const FILE_M1 = `${DIR}/20261115063149_so_tong_loi_nhuan_nen.sql`;
const FILE = `${DIR}/20261115083422_so_tong_loi_nhuan_luong.sql`;
const BASELINE = readFileSync("supabase/baseline/schema.sql", "utf8");
const MIGRATION = readFileSync(FILE, "utf8");
const NHOM_KIEM_MIGRATION = "tiền kiểm và hậu kiểm của migration";

// md5(prosrc) production đo 15/11/2026 (hồ sơ audit B) — chứng minh test chạy đúng thân đang chạy thật.
const MD5_PROD = {
  before: "bbd45b218fbae248f7e49d42660825a0",
  vo: "c30be8b3cd4811bea3622ffa7eebbfd1",
  accrue: "667cd45efb64fa01cab25038ad777dd0",
};

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const mem = (user: string, org = 0) => user.replace("4000-8000-0000000000", `4000-8000-${org ? "2" : "1"}000000000`);
const [ORG_A, ORG_B] = [1, 2].map(id);
const [CHU, CHU2, NV_CD, NV_THUONG, NV_LO, CHU_B, NV_B, CHU_HAI, SUPER] = [11, 12, 13, 14, 15, 16, 17, 18, 19].map(id);
const [VAI_CHU_A, VAI_NV_A, VAI_CHU_B, VAI_NV_B] = [31, 32, 33, 34].map(id);
const [PV_A, PV_B] = [41, 42].map(id);
const [TOA_AO, TOA_1, TOA_2, TOA_3, TOA_4, TOA_5, TOA_AO_B, TOA_B1] = [51, 52, 53, 54, 55, 56, 57, 58].map(id);
const [SO_QUY, SO_QUY_B] = [59, 60].map(id);
const [CD_NV, CD_LO, CD_KHAC, CD_B] = [61, 62, 63, 64].map(id);
const [PM_10_1, PM_10_2, PM_10_3, PM_10_4, PM_10_5, PM_09_1, PM_05_1, PM_B_10] = [81, 82, 83, 84, 85, 86, 87, 88].map(id);
const [PC_TAM_UNG, V_OLD9, V_OLD5, V_THUONG_OLD, V_KHONG_KY] = [91, 92, 93, 94, 95].map(id);
const P10 = "2026-10-01";
const P9 = "2026-09-01";
const P5 = "2026-05-01";
const CO_SO_TONG = "shareholder_profit.ledger_payout.v1";
const CO_TRA_LUONG = "salary.payout.v1";
const QUYEN_CHU = ["salary.lock", "salary.manage_salary", "salary.distribute", "salary.view",
  "shareholder_profit.distribute", "shareholder_profit.lock", "shareholder_profit.unlock"];
/** Số dư gốc của CD_NV: phân bổ đã chốt 500 (T5) + 120 (T9) + 300 + 200 + 100 (T10) − phiếu chi 1000. */
const CD_NV_GOC = 220;

/** Cắt nguyên câu CREATE [OR REPLACE] FUNCTION <tên>( … ) … AS $tag$ … $tag$; */
function cauLenhTaoHam(sql: string, ten: string): string {
  const mo = new RegExp(`CREATE\\s+(?:OR\\s+REPLACE\\s+)?FUNCTION\\s+${ten.replace(".", "\\.")}\\s*\\(`, "i").exec(sql);
  if (!mo) throw new Error(`Không thấy câu tạo hàm ${ten}`);
  const sau = sql.slice(mo.index);
  const the = /\bAS\s+(\$[a-z_]*\$)/i.exec(sau);
  if (!the) throw new Error(`Không thấy dollar-quote của ${ten}`);
  const dong = sau.indexOf(the[1], the.index + the[0].length);
  return sau.slice(0, sau.indexOf(";", dong) + 1);
}
/** Thân giữa hai dollar-quote (bỏ CR) — để đo md5 như md5(prosrc). */
function thanHam(cau: string): string {
  const the = /\bAS\s+(\$[a-z_]*\$)/i.exec(cau)!;
  const mo = the.index + the[0].length;
  return cau.slice(mo, cau.indexOf(the[1], mo)).replace(/\r/g, "");
}
/** Định nghĩa SỐNG: câu CREATE cuối cùng trong thư mục migration; không có thì lấy từ baseline. */
function dinhNghiaSong(ten: string): string {
  const re = new RegExp(`CREATE\\s+(?:OR\\s+REPLACE\\s+)?FUNCTION\\s+${ten.replace(".", "\\.")}\\s*\\(`, "i");
  let hit: string | null = null;
  for (const f of readdirSync(DIR).filter((x) => x.endsWith(".sql")).sort()) {
    const sql = readFileSync(`${DIR}/${f}`, "utf8");
    if (re.test(sql)) hit = sql;
  }
  return cauLenhTaoHam(hit ?? BASELINE, ten);
}
const md5 = (s: string) => createHash("md5").update(s).digest("hex");

// Thân gốc của lệnh trả lương (baseline) — production đổi tên thành app_private.rent_support_salary_payout_before_v1.
const THAN_GOC_TRA_LUONG = cauLenhTaoHam(BASELINE, "public.salary_payout_v1")
  .replace(/^CREATE\s+FUNCTION\s+public\.salary_payout_v1\(/i, "CREATE FUNCTION app_private.rent_support_salary_payout_before_v1(");
const VO_TRA_LUONG = dinhNghiaSong("public.salary_payout_v1");
const ACCRUE = dinhNghiaSong("app_private.accrue_salary_paid_on_approve");

const NEN = `
  CREATE ROLE authenticated; CREATE ROLE anon; CREATE ROLE service_role;
  CREATE SCHEMA auth; CREATE SCHEMA app_private;
  GRANT USAGE ON SCHEMA public, auth TO authenticated, anon, service_role;
  CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
  CREATE FUNCTION auth.role() RETURNS text LANGUAGE sql STABLE AS $$ SELECT 'authenticated'::text $$;
  CREATE TABLE public.super_admins(user_id uuid PRIMARY KEY);
  CREATE FUNCTION public.is_super_admin() RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER AS $$ SELECT EXISTS(SELECT 1 FROM public.super_admins WHERE user_id = auth.uid()) $$;
  CREATE TABLE public.organizations(id uuid PRIMARY KEY, status text NOT NULL DEFAULT 'ACTIVE', authorization_version bigint NOT NULL DEFAULT 1);
  CREATE TABLE public.permission_definitions(
    key text PRIMARY KEY, resource text NOT NULL, action text NOT NULL,
    sensitivity text NOT NULL CHECK (sensitivity IN ('VIEW','MANAGE','ELEVATED','PLATFORM')),
    permission_domain text NOT NULL DEFAULT 'TENANT' CHECK (permission_domain IN ('TENANT','PLATFORM')),
    scope_kinds text[] NOT NULL DEFAULT ARRAY['ORGANIZATION'], is_active boolean NOT NULL DEFAULT true,
    scope_match_mode text NOT NULL DEFAULT 'ANY_MATCH' CHECK (scope_match_mode = 'ANY_MATCH'),
    requires_cashbook_possession boolean NOT NULL DEFAULT false,
    accepted_possession_kinds text[] NOT NULL DEFAULT ARRAY[]::text[],
    required_dimensions text[] NOT NULL DEFAULT ARRAY[]::text[] CHECK (required_dimensions <@ ARRAY['BUILDING','CASHBOOK']),
    UNIQUE (resource, action));
  CREATE TABLE public.organization_memberships(id uuid PRIMARY KEY, user_id uuid, organization_id uuid, status text DEFAULT 'ACTIVE',
    revoked_at timestamptz, valid_from timestamptz, valid_to timestamptz);
  CREATE TABLE app_private.tenant_emergency_denies(organization_id uuid, permission_key text, active_from timestamptz, expires_at timestamptz);
  CREATE TABLE public.member_permission_overrides(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid, membership_id uuid,
    permission_key text, effect text, scope_mode text, revoked_at timestamptz, expires_at timestamptz);
  CREATE TABLE public.member_override_scopes(organization_id uuid, override_id uuid, scope_id uuid);
  CREATE TABLE public.authorization_scopes(id uuid PRIMARY KEY, organization_id uuid, scope_type text, building_id uuid, cashbook_id uuid, area_id uuid);
  CREATE TABLE public.organization_roles(id uuid PRIMARY KEY, organization_id uuid NOT NULL, name text NOT NULL, is_system boolean NOT NULL DEFAULT false,
    system_key text, status text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','RETIRED')), UNIQUE (organization_id, id));
  CREATE TABLE public.role_permissions(organization_id uuid NOT NULL, role_id uuid NOT NULL,
    permission_key text NOT NULL REFERENCES public.permission_definitions(key),
    effect text NOT NULL DEFAULT 'ALLOW' CHECK (effect IN ('ALLOW','DENY')),
    PRIMARY KEY (organization_id, role_id, permission_key),
    FOREIGN KEY (organization_id, role_id) REFERENCES public.organization_roles(organization_id, id) ON DELETE CASCADE);
  CREATE TABLE public.role_bindings(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid, membership_id uuid, role_id uuid, valid_from timestamptz, valid_to timestamptz);
  CREATE TABLE public.role_binding_scopes(organization_id uuid, role_binding_id uuid, scope_id uuid);
  CREATE TABLE public.area_buildings(organization_id uuid, area_id uuid, building_id uuid);
  CREATE TABLE public.cashbook_possession_bindings(organization_id uuid, membership_id uuid, cashbook_id uuid, possession_kind text, valid_from timestamptz, valid_to timestamptz);
  CREATE FUNCTION app_private.raise_malformed_override(uuid, text) RETURNS integer LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'malformed override' USING ERRCODE = '55000'; END $$;
  CREATE TABLE public.buildings(id uuid PRIMARY KEY, organization_id uuid, deleted_at timestamptz, code text, name text,
    is_virtual boolean NOT NULL DEFAULT false, created_at timestamptz NOT NULL DEFAULT now());
  CREATE TABLE public.accounts(id uuid PRIMARY KEY, organization_id uuid, deleted_at timestamptz);
  CREATE TABLE app_private.server_feature_flags(feature_key text PRIMARY KEY, domain text NOT NULL,
    risk_class text NOT NULL DEFAULT 'MONEY' CHECK (risk_class IN ('MONEY','NON_MONEY')),
    mode text NOT NULL DEFAULT 'OFF' CHECK (mode IN ('OFF','SHADOW','CANARY','ON')),
    force_freeze boolean NOT NULL DEFAULT false, config_version bigint NOT NULL DEFAULT 1, reason text, updated_by uuid,
    updated_at timestamptz NOT NULL DEFAULT now());
  -- Công tắc: test tự đặt route từng khoá (thân thật chỉ là phép đọc bảng cờ).
  CREATE TABLE app_private.test_route(feature_key text PRIMARY KEY, route text NOT NULL);
  CREATE FUNCTION app_private.evaluate_feature_route(p_feature_key text, p_organization_id uuid) RETURNS text LANGUAGE sql STABLE AS
    $$ SELECT COALESCE((SELECT r.route FROM app_private.test_route r WHERE r.feature_key = p_feature_key), 'LEGACY') $$;
  CREATE TABLE app_private.test_claims(feature_key text, subject_scope text, amount numeric);
  CREATE FUNCTION app_private.claim_feature_operation_v1(p_feature_key text, p_organization_id uuid, p_subject_scope text, p_actor_id uuid,
    p_idempotency_key text, p_amount_vnd numeric) RETURNS void LANGUAGE plpgsql AS $$
  BEGIN
    IF app_private.evaluate_feature_route(p_feature_key, p_organization_id) <> 'CANONICAL' THEN
      RAISE EXCEPTION 'Canonical writer is disabled or frozen for this organization' USING ERRCODE = '55000';
    END IF;
    INSERT INTO app_private.test_claims VALUES (p_feature_key, p_subject_scope, p_amount_vnd);
  END $$;
  CREATE FUNCTION public.org_today_v1(p_organization_id uuid) RETURNS date LANGUAGE sql STABLE AS $$ SELECT DATE '2026-11-15' $$;
  CREATE TABLE public.shareholders(id uuid PRIMARY KEY, organization_id uuid NOT NULL REFERENCES public.organizations(id),
    auth_user_id uuid UNIQUE, name text NOT NULL, deleted_at timestamptz);
  CREATE UNIQUE INDEX shareholders_id_org_uq ON public.shareholders (id, organization_id);
  CREATE TABLE public.profit_managers(id uuid PRIMARY KEY, organization_id uuid NOT NULL REFERENCES public.organizations(id), auth_user_id uuid, name text NOT NULL, deleted_at timestamptz);
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
  CREATE TABLE public.income_expenses(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL,
    type text NOT NULL CHECK (type IN ('INCOME','EXPENSE')),
    approval_status text NOT NULL DEFAULT 'APPROVED' CHECK (approval_status IN ('UNAPPROVED','APPROVED','CANCELLED')),
    deleted_at timestamptz, shareholder_id uuid REFERENCES public.shareholders(id) ON DELETE SET NULL,
    profit_manager_id uuid REFERENCES public.profit_managers(id) ON DELETE SET NULL,
    total_amount numeric(15,2) NOT NULL DEFAULT 0, account_id uuid, created_at timestamptz NOT NULL DEFAULT now(),
    user_id uuid, name text, building_id uuid, salary_staff_id uuid, salary_role text, voucher_date date,
    business_result_accounting boolean, notes text, source_payload_hash text, code text, posting_status text DEFAULT 'UNPOSTED');
  CREATE TABLE public.income_expense_types(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid, name text, type text);
  CREATE TABLE public.income_expense_items(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    income_expense_id uuid NOT NULL REFERENCES public.income_expenses(id) ON DELETE CASCADE, organization_id uuid,
    income_expense_type_id uuid, description text, quantity numeric(15,4) NOT NULL DEFAULT 1,
    unit_price numeric(15,2) NOT NULL DEFAULT 0, amount numeric(15,2) NOT NULL DEFAULT 0);
  CREATE TABLE public.approval_requests(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL, submission_no integer NOT NULL DEFAULT 1,
    subject_type text NOT NULL, subject_id uuid NOT NULL,
    state text NOT NULL CHECK (state IN ('PENDING_APPROVAL','POSTED','DENIED','REJECTED','CANCELLED','REVERSED','APPROVED','WITHDRAWN','CHANGES_REQUESTED','DISPUTED')),
    UNIQUE (organization_id, subject_type, subject_id, submission_no));
  CREATE TABLE public.manager_salary_config(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), staff_id uuid NOT NULL, organization_id uuid,
    is_active boolean NOT NULL DEFAULT true, created_at timestamptz NOT NULL DEFAULT now());
  CREATE TABLE public.salary_monthly(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid, staff_id uuid NOT NULL, period_month date NOT NULL,
    status text NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT','LOCKED')),
    investment_profit numeric(15,2) NOT NULL DEFAULT 0, advances_total numeric(15,2) NOT NULL DEFAULT 0,
    take_home numeric(15,2) NOT NULL DEFAULT 0, paid numeric(15,2) NOT NULL DEFAULT 0,
    payout_voucher_id uuid REFERENCES public.income_expenses(id) ON DELETE SET NULL,
    locked_at timestamptz, locked_by uuid, organization_id uuid, created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now(),
    UNIQUE (staff_id, period_month));
  -- Đường client cũ (useManagerSalary) cập nhật thẳng salary_monthly qua PostgREST.
  GRANT SELECT, INSERT, UPDATE ON public.salary_monthly TO authenticated;
  CREATE TABLE app_private.salary_line_overrides(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), seq bigint GENERATED ALWAYS AS IDENTITY,
    organization_id uuid NOT NULL, staff_id uuid NOT NULL, period_month date NOT NULL CHECK (period_month = date_trunc('month', period_month)::date),
    line_key text NOT NULL CHECK (line_key ~ '^(base|streak|ot|contract|job:.{1,200}|rec:[0-9a-f-]{36}|sale:[0-9a-f-]{36}|dh:.{1,200})$'),
    line_label text NOT NULL, computed_amount numeric(14,2) NOT NULL, amount numeric(14,2) CHECK (amount IS NULL OR amount = round(amount)),
    reason text NOT NULL, request_key text NOT NULL, request_hash text NOT NULL, created_by uuid NOT NULL,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp());
  CREATE TABLE app_private.canonical_write_operations(organization_id uuid NOT NULL, operation text NOT NULL, subject_scope text NOT NULL,
    actor_id uuid NOT NULL, idempotency_key text NOT NULL, payload_hash text NOT NULL, subject_id uuid, response_payload jsonb,
    created_at timestamptz DEFAULT now() NOT NULL, completed_at timestamptz, actor_membership_id uuid, transaction_id xid8,
    CONSTRAINT canonical_write_operations_completion_check CHECK ((((completed_at IS NULL) = (response_payload IS NULL)) AND ((completed_at IS NULL) = (subject_id IS NULL)))),
    CONSTRAINT canonical_write_operations_idempotency_key_check CHECK (idempotency_key ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{7,199}$'),
    CONSTRAINT canonical_write_operations_payload_hash_check CHECK ((char_length(payload_hash) = 32)),
    PRIMARY KEY (organization_id, operation, subject_scope, actor_id, idempotency_key));
  CREATE TABLE public.profiles(id uuid PRIMARY KEY, full_name text);
  CREATE FUNCTION app_private.salary_amount_editor_ok_v1(p_org uuid, p_actor uuid) RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT true $$;
  CREATE FUNCTION app_private.v5_can_view_salary_v1(p_target uuid) RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT true $$;
  -- Cầu hỗ trợ tiền thuê (20260930112705): không có phần nào ⇒ vỏ trả lương gọi thẳng thân gốc.
  CREATE TABLE app_private.rent_support_salary_parts(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid, staff_id uuid,
    period_month date, salary_monthly_id uuid, source_id uuid, voucher_id uuid, proof_hash text);
  CREATE TABLE app_private.rent_support_payout_sources(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid, contract_id uuid);
  CREATE TABLE app_private.rent_support_salary_payments(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid, salary_monthly_id uuid,
    actor_id uuid, request_key text, intent_hash text, requested_cash numeric, salary_voucher_id uuid, result jsonb, snapshot_hash text);
  CREATE FUNCTION app_private.rent_support_salary_lock_v1(uuid, uuid) RETURNS void LANGUAGE plpgsql AS $$ BEGIN RETURN; END $$;
  CREATE FUNCTION app_private.rent_support_salary_has_source_v1(uuid, uuid, date) RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT false $$;
  -- Bộ máy duyệt: lệnh lập phiếu chỉ cần một yêu cầu PENDING (thân thật chạy trên TEST).
  CREATE FUNCTION app_private.submit_financial_request_v1(p_subject_id uuid, p_actor_membership uuid, p_actor_user uuid, p_idempotency_key text)
  RETURNS uuid LANGUAGE plpgsql AS $$
  DECLARE v uuid;
  BEGIN
    INSERT INTO public.approval_requests(organization_id, subject_type, subject_id, state)
    SELECT ie.organization_id, 'FINANCIAL_VOUCHER', ie.id, 'PENDING_APPROVAL' FROM public.income_expenses ie WHERE ie.id = p_subject_id
    RETURNING id INTO v;
    RETURN v;
  END $$;
`;

/** Hàm/trigger thật (định nghĩa sống) nạp sau bảng nền. */
function hamThat(): string {
  return [
    dinhNghiaSong("app_private.authorized_scope_v3"),
    dinhNghiaSong("app_private.profit_viewer_can_v1"),
    dinhNghiaSong("public.my_org_ids"),
    dinhNghiaSong("public.salary_is_admin_v1"),
    dinhNghiaSong("app_private.salary_staff_org_v1"),
    dinhNghiaSong("app_private.lock_org_for_decision_v1"),
    dinhNghiaSong("app_private.authorize_tenant_action_v3"),
    dinhNghiaSong("app_private.guard_canonical_write_operation"),
    "CREATE TRIGGER canonical_write_operations_immutable BEFORE DELETE OR UPDATE ON app_private.canonical_write_operations FOR EACH ROW EXECUTE FUNCTION app_private.guard_canonical_write_operation();",
    dinhNghiaSong("public.auto_calc_item_amount"),
    dinhNghiaSong("public.auto_recalc_total_amount"),
    "CREATE TRIGGER trigger_auto_calc_item_amount BEFORE INSERT OR UPDATE ON public.income_expense_items FOR EACH ROW EXECUTE FUNCTION public.auto_calc_item_amount();",
    "CREATE TRIGGER trigger_auto_recalc_total_amount AFTER INSERT OR DELETE OR UPDATE ON public.income_expense_items FOR EACH ROW EXECUTE FUNCTION public.auto_recalc_total_amount();",
    ACCRUE,
    "CREATE TRIGGER a70_salary_paid_accrual AFTER UPDATE ON public.income_expenses FOR EACH ROW WHEN ((new.salary_staff_id IS NOT NULL)) EXECUTE FUNCTION app_private.accrue_salary_paid_on_approve();",
    THAN_GOC_TRA_LUONG,
    VO_TRA_LUONG,
    dinhNghiaSong("public.salary_line_override_list_v1"),
  ].join("\n");
}

function duLieu(): string {
  const thanhVien: [string, string][] = [[CHU, ORG_A], [CHU2, ORG_A], [NV_CD, ORG_A], [NV_THUONG, ORG_A], [NV_LO, ORG_A],
    [CHU_B, ORG_B], [NV_B, ORG_B], [CHU_HAI, ORG_A], [CHU_HAI, ORG_B]];
  const gan: [string, string, string, string][] = [[CHU, ORG_A, VAI_CHU_A, PV_A], [CHU2, ORG_A, VAI_CHU_A, PV_A], [NV_CD, ORG_A, VAI_NV_A, PV_A],
    [NV_THUONG, ORG_A, VAI_NV_A, PV_A], [NV_LO, ORG_A, VAI_NV_A, PV_A], [CHU_B, ORG_B, VAI_CHU_B, PV_B], [NV_B, ORG_B, VAI_NV_B, PV_B],
    [CHU_HAI, ORG_A, VAI_CHU_A, PV_A], [CHU_HAI, ORG_B, VAI_CHU_B, PV_B]];
  const quyen = [...new Set([...QUYEN_CHU, "shareholder_profit.view", "shareholder_profit.manage_shareholders"])];
  return `
    INSERT INTO public.organizations(id) VALUES ('${ORG_A}'),('${ORG_B}');
    INSERT INTO public.super_admins VALUES ('${SUPER}');
    INSERT INTO public.permission_definitions(key, resource, action, sensitivity) VALUES
      ${quyen.map((k) => `('${k}','${k.split(".")[0]}','${k.split(".")[1]}','MANAGE')`).join(",")};
    INSERT INTO public.organization_memberships(id, user_id, organization_id) VALUES
      ${thanhVien.map(([u, o]) => `('${mem(u, o === ORG_B ? 1 : 0)}','${u}','${o}')`).join(",")};
    INSERT INTO public.authorization_scopes(id, organization_id, scope_type) VALUES ('${PV_A}','${ORG_A}','ORGANIZATION'),('${PV_B}','${ORG_B}','ORGANIZATION');
    INSERT INTO public.organization_roles(id, organization_id, name, is_system, system_key) VALUES
      ('${VAI_CHU_A}','${ORG_A}','Chủ sở hữu tổ chức',true,'TENANT_OWNER'), ('${VAI_NV_A}','${ORG_A}','Nhân viên',false,NULL),
      ('${VAI_CHU_B}','${ORG_B}','Chủ sở hữu tổ chức',true,'TENANT_OWNER'), ('${VAI_NV_B}','${ORG_B}','Nhân viên',false,NULL);
    INSERT INTO public.role_permissions(organization_id, role_id, permission_key)
      SELECT o, r, k FROM (VALUES ('${ORG_A}'::uuid,'${VAI_CHU_A}'::uuid),('${ORG_B}'::uuid,'${VAI_CHU_B}'::uuid)) v(o, r)
      CROSS JOIN unnest(ARRAY[${QUYEN_CHU.map((k) => `'${k}'`).join(",")}]) k;
    INSERT INTO public.role_permissions(organization_id, role_id, permission_key) VALUES
      ('${ORG_A}','${VAI_NV_A}','salary.view'), ('${ORG_B}','${VAI_NV_B}','salary.view');
    ${gan.map(([u, o, r, s], i) => `
      INSERT INTO public.role_bindings(id, organization_id, membership_id, role_id) VALUES ('${id(100 + i)}','${o}','${mem(u, o === ORG_B ? 1 : 0)}','${r}');
      INSERT INTO public.role_binding_scopes VALUES ('${o}','${id(100 + i)}','${s}');`).join("")}
    INSERT INTO public.buildings(id, organization_id, code, name, is_virtual, created_at) VALUES
      ('${TOA_AO}','${ORG_A}','CHUNG','Chung',true,'2026-01-01'), ('${TOA_1}','${ORG_A}','44TL','Toà 44',false,'2026-01-02'),
      ('${TOA_2}','${ORG_A}','','Toà Hai',false,'2026-01-03'), ('${TOA_3}','${ORG_A}',NULL,'44TL',false,'2026-01-04'),
      ('${TOA_4}','${ORG_A}','B4','Toà B4',false,'2026-01-05'), ('${TOA_5}','${ORG_A}','C5','Toà C5',false,'2026-01-06'),
      ('${TOA_AO_B}','${ORG_B}','CHUNGB','Chung B',true,'2026-01-01'), ('${TOA_B1}','${ORG_B}','B1','Toà B1',false,'2026-01-02');
    INSERT INTO public.accounts(id, organization_id) VALUES ('${SO_QUY}','${ORG_A}'), ('${SO_QUY_B}','${ORG_B}');
    INSERT INTO public.manager_salary_config(staff_id, organization_id) VALUES
      ('${NV_CD}','${ORG_A}'), ('${NV_THUONG}','${ORG_A}'), ('${NV_LO}','${ORG_A}'), ('${NV_B}','${ORG_B}');
    INSERT INTO app_private.test_route VALUES ('${CO_TRA_LUONG}','CANONICAL');
    INSERT INTO public.shareholders(id, organization_id, auth_user_id, name) VALUES
      ('${CD_NV}','${ORG_A}','${NV_CD}','Cổ đông nhân viên'), ('${CD_LO}','${ORG_A}','${NV_LO}','Cổ đông tháng lỗ'),
      ('${CD_KHAC}','${ORG_A}',NULL,'Cổ đông ngoài'), ('${CD_B}','${ORG_B}','${NV_B}','Cổ đông công ty B');
    INSERT INTO public.profit_monthly(id, organization_id, building_id, period_month, status, is_stale, locked_at) VALUES
      ('${PM_10_1}','${ORG_A}','${TOA_1}','${P10}','LOCKED',false,'2026-11-03 00:00:00+00'),
      ('${PM_10_2}','${ORG_A}','${TOA_2}','${P10}','LOCKED',false,'2026-11-03 00:00:00+00'),
      ('${PM_10_3}','${ORG_A}','${TOA_3}','${P10}','LOCKED',true,'2026-11-04 00:00:00+00'),
      ('${PM_10_4}','${ORG_A}','${TOA_4}','${P10}','DRAFT',false,NULL),
      ('${PM_10_5}','${ORG_A}','${TOA_5}','${P10}','DRAFT',false,NULL),
      ('${PM_09_1}','${ORG_A}','${TOA_1}','${P9}','LOCKED',false,'2026-10-03 00:00:00+00'),
      ('${PM_05_1}','${ORG_A}','${TOA_1}','${P5}','LOCKED',false,'2026-06-03 00:00:00+00'),
      ('${PM_B_10}','${ORG_B}','${TOA_B1}','${P10}','LOCKED',false,'2026-11-03 00:00:00+00');
    INSERT INTO public.profit_allocations(profit_monthly_id, shareholder_id, amount, organization_id) VALUES
      ('${PM_10_1}','${CD_NV}',300,'${ORG_A}'), ('${PM_10_1}','${CD_KHAC}',1000,'${ORG_A}'), ('${PM_10_1}','${CD_LO}',50,'${ORG_A}'),
      ('${PM_10_2}','${CD_NV}',200,'${ORG_A}'), ('${PM_10_2}','${CD_LO}',-300,'${ORG_A}'),
      ('${PM_10_3}','${CD_NV}',100,NULL), ('${PM_10_4}','${CD_NV}',999,'${ORG_A}'), ('${PM_10_5}','${CD_NV}',150,'${ORG_A}'),
      ('${PM_09_1}','${CD_NV}',120,'${ORG_A}'), ('${PM_05_1}','${CD_NV}',500,'${ORG_A}'), ('${PM_B_10}','${CD_B}',700,'${ORG_B}');
    -- Phiếu chi lợi nhuận cũ (không qua sổ tổng): làm CD_NV đang tạm ứng trước kỳ 10.
    INSERT INTO public.income_expenses(id, organization_id, type, approval_status, shareholder_id, total_amount, account_id, created_at)
      VALUES ('${PC_TAM_UNG}','${ORG_A}','EXPENSE','APPROVED','${CD_NV}',1000,'${SO_QUY}','2026-08-01');
    -- Phiếu lương lập TRƯỚC M3 (không dòng sổ): T9 nháp còn chờ duyệt, T5 đã chốt + đã duyệt, phiếu không dấu kỳ.
    INSERT INTO public.income_expenses(id, organization_id, type, approval_status, salary_staff_id, total_amount, account_id, building_id, voucher_date, created_at) VALUES
      ('${V_OLD9}','${ORG_A}','EXPENSE','UNAPPROVED','${NV_CD}',2000,'${SO_QUY}','${TOA_AO}','2026-10-30','2026-10-30'),
      ('${V_OLD5}','${ORG_A}','EXPENSE','APPROVED','${NV_CD}',5000,'${SO_QUY}','${TOA_AO}','2026-07-01','2026-07-01'),
      ('${V_THUONG_OLD}','${ORG_A}','EXPENSE','UNAPPROVED','${NV_THUONG}',3000,'${SO_QUY}','${TOA_AO}','2026-10-30','2026-10-30'),
      ('${V_KHONG_KY}','${ORG_A}','EXPENSE','APPROVED','${NV_CD}',800,'${SO_QUY}','${TOA_AO}','2026-08-15','2026-08-15');
    INSERT INTO public.approval_requests(organization_id, subject_type, subject_id, state) VALUES
      ('${ORG_A}','FINANCIAL_VOUCHER','${V_OLD9}','PENDING_APPROVAL'), ('${ORG_A}','FINANCIAL_VOUCHER','${V_THUONG_OLD}','PENDING_APPROVAL');
    INSERT INTO public.salary_monthly(user_id, staff_id, period_month, status, investment_profit, advances_total, take_home, paid, payout_voucher_id, locked_at, organization_id) VALUES
      ('${CHU}','${NV_CD}','${P9}','DRAFT',0,0,0,0,'${V_OLD9}',NULL,'${ORG_A}'),
      ('${CHU}','${NV_CD}','${P5}','LOCKED',500,0,5000,5000,'${V_OLD5}','2026-06-05','${ORG_A}'),
      ('${CHU}','${NV_THUONG}','${P9}','DRAFT',0,0,0,0,'${V_THUONG_OLD}',NULL,'${ORG_A}');
  `;
}

const db = new PGlite();
const ghiChu: Record<string, unknown> = {};

async function trongGiaoDich<T>(fn: () => Promise<T>): Promise<T> {
  await db.exec("BEGIN");
  try { return await fn(); } finally { await db.exec("ROLLBACK"); }
}
const mot = async <T>(sql: string, params: unknown[] = []) => (await db.query<{ v: T }>(sql, params)).rows[0].v;
const khoa = () => `k-${randomUUID()}`;

interface KetQua<T> { ok: boolean; v?: T; code?: string; message?: string; detail?: string }
/** Gọi một câu như người dùng đăng nhập qua PostgREST (vai authenticated + JWT), trong SAVEPOINT. */
async function thu<T>(user: string | null, sql: string, params: unknown[] = []): Promise<KetQua<T>> {
  await db.exec("SAVEPOINT thu");
  try {
    await db.query("SELECT set_config('request.jwt.claim.sub', $1, true)", [user ?? ""]);
    await db.exec("SET LOCAL ROLE authenticated");
    const r = await db.query<{ v: T }>(sql, params);
    await db.exec("RESET ROLE");
    await db.exec("RELEASE SAVEPOINT thu");
    return { ok: true, v: r.rows[0]?.v };
  } catch (e) {
    await db.exec("ROLLBACK TO SAVEPOINT thu");
    const err = e as { code?: string; message?: string; detail?: string };
    return { ok: false, code: err.code, message: err.message, detail: err.detail };
  }
}
async function phai<T>(user: string | null, sql: string, params: unknown[] = []): Promise<T> {
  const r = await thu<T>(user, sql, params);
  if (!r.ok) throw new Error(`${r.code}: ${r.message}`);
  return r.v as T;
}
/** Chạy câu dưới vai chủ bảng trong SAVEPOINT; trả mã lỗi hoặc null. */
async function maLoi(sql: string, params: unknown[] = []): Promise<string | null> {
  await db.exec("SAVEPOINT ml");
  try {
    if (params.length) await db.query(sql, params); else await db.exec(sql);
    await db.exec("RELEASE SAVEPOINT ml");
    return null;
  } catch (e) {
    await db.exec("ROLLBACK TO SAVEPOINT ml");
    return (e as { code?: string }).code ?? "?";
  }
}

type J = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const inputs = (user: string, staff: string[], period = P10) =>
  thu<J>(user, "SELECT public.salary_profit_inputs_v1($1, $2) AS v", [period, staff]);
const dongBang = (user: string, staff: string, period: string, expected: number, maxOff: number | null, takeHome: number | null, key = khoa()) =>
  thu<J>(user, "SELECT public.salary_profit_settlement_freeze_v1($1,$2,$3,$4,$5,$6) AS v", [staff, period, expected, maxOff, takeHome, key]);
const baoGia = (user: string, staff: string, period: string, sel: number, off: number, amount: number, payoutKey: string, key = khoa()) =>
  thu<J>(user, "SELECT public.salary_profit_payout_quote_v1($1,$2,$3,$4,$5,$6,$7) AS v", [staff, period, sel, off, amount, payoutKey, key]);
const traLuong = (user: string, staff: string, period: string, takeHome: number, key: string) =>
  thu<J>(user, "SELECT public.salary_payout_v1($1,$2,$3,$4,$5,$6,$7)::jsonb AS v", [staff, period, takeHome, SO_QUY, "2026-11-05", "Lương tháng", key]);
const xacNhan = (user: string, line: string, y: number, d: number, reason = "Chủ xác nhận số phiếu lương", key = khoa()) =>
  thu<J>(user, "SELECT public.profit_ledger_salary_resolve_v1($1,$2,$3,$4,$5) AS v", [line, y, d, reason, key]);
const anhHuong = (user: string, org: string, period: string, buildings: string[] | null = null) =>
  thu<J>(user, "SELECT public.profit_unlock_salary_impact_v1($1,$2,$3) AS v", [org, period, buildings]);
const ghiBu = (voucher: string, y: number, d: number, period: string | null = null, reason = "Ghi bù phiếu lương đã trả") =>
  mot<J>("SELECT app_private.profit_ledger_luong_backfill_v1($1,$2,$3,$4,$5,$6) AS v", [voucher, y, d, reason, CHU, period]);
const soDu = async (sh = CD_NV, org = ORG_A) =>
  Number(await mot<string>("SELECT (app_private.profit_ledger_balance_v1($1,'SHAREHOLDER',$2)->>'balance') AS v", [org, sh]));
const dauTu = (staff: string, period = P10, org = ORG_A, before: string | null = null) =>
  mot<J>("SELECT app_private.salary_investment_profit_v1($1,$2,$3,$4) AS v", [org, staff, period, before]);
const tran = (staff = NV_CD, sh = CD_NV, period = P10, org = ORG_A) =>
  mot<J>("SELECT app_private.salary_profit_month_caps_v1($1,$2,$3,$4) AS v", [org, sh, staff, period]);
const dongSo = (voucher: string) =>
  db.query<J>(`SELECT id, state, source, period_month::text AS period_month, investment_amount::float8 AS y, advance_offset_amount::float8 AS d,
    suggested_investment::float8 AS goi_y, settlement_id, payout_request_key FROM app_private.profit_ledger_salary_settlement_vouchers
    WHERE salary_voucher_id = $1`, [voucher]).then((r) => r.rows);
const demDong = async (sh = CD_NV) =>
  Number(await mot<string>("SELECT count(*)::text AS v FROM app_private.profit_ledger_salary_settlement_vouchers WHERE shareholder_id = $1 AND salary_voucher_id IS NOT NULL", [sh]));
const suKien = async (kind: string, sh = CD_NV) =>
  Number(await mot<string>("SELECT count(*)::text AS v FROM app_private.profit_ledger_events WHERE event_kind = $1 AND shareholder_id = $2", [kind, sh]));
/** Mốc "đã trả đủ đến hết tháng X" theo nghi thức của M1 (khoá sổ → nextval → chèn). */
async function datMoc(thang: string | null, sh = CD_NV) {
  await db.exec(`SELECT app_private.profit_ledger_lock_v1('${ORG_A}', 'SHAREHOLDER', '${sh}')`);
  const de = await db.query<{ v: string }>("SELECT marker_id AS v FROM app_private.profit_ledger_active_marker_v1($1,'SHAREHOLDER',$2)", [ORG_A, sh]);
  await db.query(`INSERT INTO app_private.profit_ledger_markers(organization_id, subject_kind, shareholder_id, settled_through_month, reason, supersedes_id, ledger_seq, created_by)
    VALUES ($1,'SHAREHOLDER',$2,$3,'Lý do đặt mốc đủ dài',$4,nextval('app_private.profit_ledger_seq'),$5)`, [ORG_A, sh, thang, de.rows[0]?.v ?? null, CHU]);
}
/** Chốt bảng lương (thay lock_salary_month_v2: ghi đúng số client gửi). */
async function chotBang(staff: string, period: string, o: { y: number; adv: number; take: number }) {
  await db.query(`INSERT INTO public.salary_monthly(user_id, staff_id, period_month, status, investment_profit, advances_total, take_home, locked_at, organization_id)
    VALUES ($1,$2,$3,'LOCKED',$4,$5,$6,clock_timestamp(),$7)
    ON CONFLICT (staff_id, period_month) DO UPDATE SET status = 'LOCKED', investment_profit = EXCLUDED.investment_profit,
      advances_total = EXCLUDED.advances_total, take_home = EXCLUDED.take_home, locked_at = EXCLUDED.locked_at`,
  [CHU, staff, period, o.y, o.adv, o.take, ORG_A]);
}
async function ghiDe(staff: string, period: string, nhan: string, amount: number | null, org = ORG_A) {
  await db.query(`INSERT INTO app_private.salary_line_overrides(organization_id, staff_id, period_month, line_key, line_label, computed_amount, amount, reason, request_key, request_hash, created_by)
    VALUES ($1,$2,$3,$4,$5,0,$6,'Chủ sửa số',$7,'h',$8)`, [org, staff, period, `dh:${nhan}`, nhan, amount, khoa(), CHU]);
}
/** Lùi giờ tạo của một dòng (chỉ làm được dưới vai chủ bảng, tắt máy trạng thái trong giao dịch). */
async function luiGio(line: string, phut: number) {
  await db.exec("ALTER TABLE app_private.profit_ledger_salary_settlement_vouchers DISABLE TRIGGER a00_profit_ledger_salary_lines_guard");
  await db.query(`UPDATE app_private.profit_ledger_salary_settlement_vouchers SET created_at = created_at - make_interval(mins => $2) WHERE id = $1`, [line, phut]);
  await db.exec("ALTER TABLE app_private.profit_ledger_salary_settlement_vouchers ENABLE TRIGGER a00_profit_ledger_salary_lines_guard");
}
const duyet = (voucher: string) => db.query("UPDATE public.income_expenses SET approval_status = 'APPROVED' WHERE id = $1", [voucher]);

beforeAll(async () => {
  await db.exec(NEN);
  await db.exec(hamThat());
  await db.exec(duLieu());
  ghiChu.md5 = (await db.query<{ ten: string; m: string }>(`SELECT p.proname AS ten, md5(p.prosrc) AS m FROM pg_proc p
     WHERE p.oid IN ('app_private.rent_support_salary_payout_before_v1(uuid,date,numeric,uuid,date,text,text,uuid,numeric)'::regprocedure,
                     'public.salary_payout_v1(uuid,date,numeric,uuid,date,text,text,uuid,numeric)'::regprocedure,
                     'app_private.accrue_salary_paid_on_approve()'::regprocedure)`)).rows;
  await db.exec(readFileSync(FILE_M1, "utf8"));
  await db.exec(MIGRATION);
  await db.exec(MIGRATION);
}, 180000);
afterAll(() => db.close());

describe(NHOM_KIEM_MIGRATION, () => {
  it("test dùng ĐÚNG thân production của đường trả lương và trigger duyệt (md5 khớp số đo 15/11/2026)", () => {
    expect(md5(thanHam(THAN_GOC_TRA_LUONG))).toBe(MD5_PROD.before);
    expect(md5(thanHam(VO_TRA_LUONG))).toBe(MD5_PROD.vo);
    expect(md5(thanHam(ACCRUE))).toBe(MD5_PROD.accrue);
    const m = Object.fromEntries((ghiChu.md5 as { ten: string; m: string }[]).map((r) => [r.ten, r.m]));
    expect(m).toEqual({ rent_support_salary_payout_before_v1: MD5_PROD.before, salary_payout_v1: MD5_PROD.vo, accrue_salary_paid_on_approve: MD5_PROD.accrue });
  });

  it("lane: dán thân HAI lần trong MỘT giao dịch vẫn chạy (idempotent), không ghi dữ liệu nào", async () => {
    const than = MIGRATION.replace(/^BEGIN;\s*$/m, "").replace(/^COMMIT;\s*$/m, "").replace(/^NOTIFY pgrst.*$/m, "");
    await trongGiaoDich(async () => {
      const truoc = await mot<string>("SELECT (SELECT count(*) FROM app_private.profit_ledger_salary_settlement_vouchers) + (SELECT count(*) FROM app_private.profit_ledger_events) AS v");
      await db.exec(than);
      await db.exec(than);
      expect(await mot<string>("SELECT (SELECT count(*) FROM app_private.profit_ledger_salary_settlement_vouchers) + (SELECT count(*) FROM app_private.profit_ledger_events) AS v")).toBe(truoc);
    });
  });

  it("tiền kiểm: thiếu nền M1 (lõi số dư) ⇒ dừng 55000", async () => {
    const than = MIGRATION.replace(/^BEGIN;\s*$/m, "").replace(/^COMMIT;\s*$/m, "").replace(/^NOTIFY pgrst.*$/m, "");
    await trongGiaoDich(async () => {
      await db.exec("ALTER FUNCTION app_private.profit_ledger_balance_v1(uuid,text,uuid,uuid,date) RENAME TO profit_ledger_balance_v1_tam");
      expect(await maLoi(than)).toBe("55000");
    });
    await trongGiaoDich(async () => {
      await db.exec("ALTER TABLE public.shareholders DROP CONSTRAINT shareholders_auth_user_id_key");
      expect(await maLoi(than)).toBe("55000");
    });
  });

});

describe("hình dạng: quyền gọi, volatility, trigger", () => {
  it("ACL: năm RPC chỉ authenticated gọi được (anon, PUBLIC không); hàm nội bộ không vai nào gọi được", async () => {
    const rpc = ["public.salary_profit_inputs_v1(date,uuid[])", "public.salary_profit_settlement_freeze_v1(uuid,date,numeric,numeric,numeric,text)",
      "public.profit_unlock_salary_impact_v1(uuid,date,uuid[])", "public.salary_profit_payout_quote_v1(uuid,date,numeric,numeric,numeric,text,text)",
      "public.profit_ledger_salary_resolve_v1(uuid,numeric,numeric,text,text)"];
    for (const f of rpc) {
      expect(await mot<boolean>(`SELECT has_function_privilege('authenticated', '${f}', 'EXECUTE') AS v`)).toBe(true);
      expect(await mot<boolean>(`SELECT has_function_privilege('anon', '${f}', 'EXECUTE') AS v`)).toBe(false);
      expect(await mot<number>(`SELECT count(*)::int AS v FROM pg_proc p, aclexplode(p.proacl) a WHERE p.oid = '${f}'::regprocedure AND a.grantee = 0`)).toBe(0);
    }
    const noiBo = ["app_private.salary_investment_profit_v1(uuid,uuid,date,timestamptz)", "app_private.salary_profit_month_caps_v1(uuid,uuid,uuid,date)",
      "app_private.profit_ledger_salary_link_v1()", "app_private.profit_ledger_luong_backfill_v1(uuid,numeric,numeric,text,uuid,date)",
      "app_private.profit_ledger_luong_co_dong_v1(uuid,uuid)"];
    for (const f of noiBo) for (const vai of ["authenticated", "anon", "service_role"]) {
      expect(await mot<boolean>(`SELECT has_function_privilege('${vai}', '${f}', 'EXECUTE') AS v`)).toBe(false);
    }
  });

  it("hàm đọc STABLE + DEFINER; hàm ghi VOLATILE; mọi hàm ghim search_path", async () => {
    const r = (await db.query<{ ten: string; vol: string; def: boolean; sp: boolean }>(`
      SELECT p.proname AS ten, p.provolatile AS vol, p.prosecdef AS def,
             EXISTS (SELECT 1 FROM unnest(p.proconfig) c WHERE c LIKE 'search_path=%') AS sp
        FROM pg_proc p WHERE p.proname IN ('salary_profit_inputs_v1','profit_unlock_salary_impact_v1','salary_investment_profit_v1',
          'salary_profit_month_caps_v1','salary_profit_settlement_freeze_v1','salary_profit_payout_quote_v1','profit_ledger_salary_resolve_v1',
          'profit_ledger_salary_link_v1','profit_ledger_luong_backfill_v1') ORDER BY 1`)).rows;
    const vol = Object.fromEntries(r.map((x) => [x.ten, x.vol]));
    expect(vol).toEqual({ profit_ledger_luong_backfill_v1: "v", profit_ledger_salary_link_v1: "v", profit_ledger_salary_resolve_v1: "v",
      profit_unlock_salary_impact_v1: "s", salary_investment_profit_v1: "s", salary_profit_inputs_v1: "s", salary_profit_month_caps_v1: "s",
      salary_profit_payout_quote_v1: "v", salary_profit_settlement_freeze_v1: "v" });
    for (const x of r) expect(x).toMatchObject({ def: true, sp: true });
  });

  it("hàm đọc và mọi hàm chúng gọi không có mẫu khoá dòng mà gate stable-fn-locks soi (đã bỏ chú thích)", async () => {
    const r = (await db.query<{ ten: string; src: string }>(`SELECT p.proname AS ten, p.prosrc AS src FROM pg_proc p
      WHERE p.proname IN ('salary_profit_inputs_v1','profit_unlock_salary_impact_v1','salary_investment_profit_v1','salary_profit_month_caps_v1',
        'profit_ledger_luong_co_dong_v1','profit_ledger_balance_v1','profit_ledger_balance_core_v1','profit_ledger_active_marker_v1',
        'profit_ledger_voucher_live_v1','salary_staff_org_v1','salary_is_admin_v1','profit_viewer_can_v1')`)).rows;
    expect(r.length).toBe(12);
    for (const x of r) {
      const src = x.src.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/--[^\n]*/g, " ");
      expect([x.ten, /\bfor\s+(share|update|no key update|key share)\b/i.test(src)]).toEqual([x.ten, false]);
      expect([x.ten, /(^|[^a-z0-9_])lock\s+(table\s+)?[a-z_.]/i.test(src)]).toEqual([x.ten, false]);
    }
  });

  it("hai trigger F3: AFTER, theo dòng, chỉ khi dấu phiếu được đặt / đổi sang phiếu khác", async () => {
    const r = (await db.query<{ ten: string; def: string; bat: string }>(`SELECT tgname AS ten, pg_get_triggerdef(oid) AS def, tgenabled::text AS bat
      FROM pg_trigger WHERE tgrelid = 'public.salary_monthly'::regclass AND tgname LIKE 'z50%' ORDER BY 1`)).rows;
    expect(r.map((x) => x.ten)).toEqual(["z50_profit_ledger_salary_link_ins", "z50_profit_ledger_salary_link_upd"]);
    expect(r[0].def).toMatch(/AFTER INSERT ON public\.salary_monthly FOR EACH ROW WHEN \(\(new\.payout_voucher_id IS NOT NULL\)\)/);
    expect(r[1].def).toMatch(/AFTER UPDATE OF payout_voucher_id ON public\.salary_monthly FOR EACH ROW WHEN \(\(\(new\.payout_voucher_id IS NOT NULL\) AND \(old\.payout_voucher_id IS DISTINCT FROM new\.payout_voucher_id\)\)\)/);
    for (const x of r) expect(x.bat).toBe("O");
  });
});

describe("dòng 'Lợi nhuận đầu tư' của lương tháng (salary_investment_profit_v1)", () => {
  it("bảng nháp: phân bổ toà ĐÃ CHỐT gộp theo nhãn toà (code, rỗng thì tên); toà nháp và công ty khác không tính; stale vẫn tính", async () => {
    const r = await dauTu(NV_CD);
    expect(r).toMatchObject({ shareholder_id: CD_NV, sheet_status: "NONE", allocated_total: 600, investment_live: 600, investment: 600 });
    expect(r.by_building.map((b: J) => [b.label, b.allocated, b.override_amount, b.amount])).toEqual([["44TL", 400, null, 400], ["Toà Hai", 200, null, 200]]);
    expect([...r.by_building[0].building_ids].sort()).toEqual([TOA_1, TOA_3].sort());
  });

  it("ghi đè mới nhất theo seq thay phân bổ; dòng mới nhất amount NULL = đã gỡ; ghi đè của nhãn không có phân bổ bị bỏ qua; ghi đè âm được", async () => {
    await trongGiaoDich(async () => {
      await ghiDe(NV_CD, P10, "44TL", 700);
      await ghiDe(NV_CD, P10, "44TL", 650);
      await ghiDe(NV_CD, P10, "Toà Hai", -20);
      await ghiDe(NV_CD, P10, "KHONG_CO", 9999);
      const r = await dauTu(NV_CD);
      expect(r).toMatchObject({ allocated_total: 600, investment_live: 630, investment: 630 });
      expect(r.by_building.map((b: J) => [b.label, b.allocated, b.override_amount, b.amount]))
        .toEqual([["44TL", 400, 650, 650], ["Toà Hai", 200, -20, -20]]);
      await ghiDe(NV_CD, P10, "44TL", null);
      expect(await dauTu(NV_CD)).toMatchObject({ allocated_total: 600, investment: 380 });
    });
  });

  it("bảng LOCKED: số đóng băng investment_profit; ghi đè tạo SAU giờ chốt không áp vào phần chi tiết", async () => {
    await trongGiaoDich(async () => {
      await chotBang(NV_CD, P10, { y: 777, adv: 0, take: 5000 });
      await ghiDe(NV_CD, P10, "44TL", 1);
      // Hai lần clock_timestamp() liền nhau trong PGlite (WASM) có thể trùng giá trị trên máy CI,
      // khiến ghi đè bị coi là "tạo lúc chốt" (luật `<=`) — ca này đã đỏ ngẫu nhiên trên CI.
      // Đặt tường minh giờ tạo SAU giờ chốt 1 giây để đo đúng ý ca kiểm.
      await db.query(`UPDATE app_private.salary_line_overrides o SET created_at = sm.locked_at + interval '1 second'
        FROM public.salary_monthly sm WHERE sm.staff_id = $1 AND sm.period_month = $2
          AND o.staff_id = sm.staff_id AND o.period_month = sm.period_month AND o.line_key = 'dh:44TL' AND o.amount = 1`, [NV_CD, P10]);
      const r = await dauTu(NV_CD);
      expect(r).toMatchObject({ sheet_status: "LOCKED", investment: 777, investment_live: 600, allocated_total: 600 });
    });
  });

  it("p_locked_before: chỉ tính toà chốt trước mốc giờ đó; nhân viên không là cổ đông ⇒ shareholder_id null, 0", async () => {
    expect(await dauTu(NV_CD, P10, ORG_A, "2026-11-03T12:00:00Z")).toMatchObject({ allocated_total: 500, investment: 500 });
    expect(await dauTu(NV_THUONG)).toMatchObject({ shareholder_id: null, allocated_total: 0, investment: 0, by_building: [] });
  });
});

describe("một công thức D (salary_profit_month_caps_v1)", () => {
  it("D_m = least(greatest(0, A_m − L*), greatest(Y_m, 0)) — tạm ứng còn treo trước lương kỳ, không vượt phần lợi nhuận", async () => {
    // L* = 220 (không có dòng lương kỳ 10) ⇒ tạm ứng trước kỳ = 600 − 220 = 380.
    expect(await tran()).toMatchObject({ sheet_status: "NONE", investment_month: 600, investment_cap: 600, allocated_total: 600,
      ledger_balance_excluding_period: CD_NV_GOC, advance_open: 380, advance_offset_month: 380, paid_investment: 0, paid_offset: 0,
      remaining_offset: 380, settled_by_marker: false, settlement_id: null });
  });

  it("ghi đè TĂNG không bị trừ ngược: adv_m dùng A_m trước ghi đè (Y_m sau ghi đè chỉ làm trần)", async () => {
    await trongGiaoDich(async () => {
      // Tạm ứng trước kỳ 10 chỉ còn 100: phân bổ T5 = 780 ⇒ L* = 780 + 120 + 600 − 1000 = 500 = A_10 − 100.
      await db.query("UPDATE public.profit_allocations SET amount = 780 WHERE profit_monthly_id = $1 AND shareholder_id = $2", [PM_05_1, CD_NV]);
      await ghiDe(NV_CD, P10, "44TL", 700);
      // Y_10 = 700 + 200 = 900. Công thức cũ (theo Y_m sau ghi đè) ra least(900 − 500, 900) = 400.
      expect(await tran()).toMatchObject({ allocated_total: 600, investment_month: 900, ledger_balance_excluding_period: 500,
        advance_open: 100, advance_offset_month: 100 });
    });
  });

  it("ghi đè TĂNG khi tạm ứng lớn hơn cả lợi nhuận tháng: D chỉ lấy trong phần lợi nhuận của tháng (A_m), phần tăng trả bằng tiền", async () => {
    await trongGiaoDich(async () => {
      // Tạm ứng trước kỳ 10 = 1380 (> A_10 = 600): phiếu chi lợi nhuận cũ 2000 thay 1000.
      await db.query("UPDATE public.income_expenses SET total_amount = 2000 WHERE id = $1", [PC_TAM_UNG]);
      await ghiDe(NV_CD, P10, "44TL", 700);
      // Y_10 = 900; công thức theo Y_m ra least(1380, 900) = 900 (ăn luôn 300 ghi đè tăng).
      expect(await tran()).toMatchObject({ allocated_total: 600, investment_month: 900, advance_open: 1380, advance_offset_month: 600 });
    });
  });

  it("tháng lỗ: Y_m âm ⇒ D_m = 0, trần phần đầu tư âm", async () => {
    expect(await tran(NV_LO, CD_LO)).toMatchObject({ investment_month: -250, investment_cap: -250, advance_open: 0, advance_offset_month: 0 });
  });

  it("kỳ ≤ mốc 'đã trả đủ': phần trả qua lương = 0 và D_m = 0; gỡ mốc ⇒ về như cũ", async () => {
    await trongGiaoDich(async () => {
      await datMoc(P10);
      expect(await tran()).toMatchObject({ investment_month: 600, investment_cap: 0, advance_offset_month: 0, settled_by_marker: true, marker_through: P10 });
      await datMoc(null);
      expect(await tran()).toMatchObject({ investment_cap: 600, advance_offset_month: 380, settled_by_marker: false, marker_through: null });
    });
  });

  it("bảng LOCKED không có bản đóng băng ⇒ D_m = 0, Y_m = số đóng băng", async () => {
    await trongGiaoDich(async () => {
      await chotBang(NV_CD, P10, { y: 600, adv: 380, take: 5000 });
      expect(await tran()).toMatchObject({ sheet_status: "LOCKED", investment_month: 600, advance_offset_month: 0, settlement_id: null });
    });
  });

  it("bảng LOCKED có bản đóng băng KHỚP ⇒ D_m của bản đó; không khớp (Y, ứng, thực nhận) ⇒ D_m = 0", async () => {
    for (const [bang, dMong] of [[{ y: 600, adv: 380, take: 7000 }, 380], [{ y: 590, adv: 380, take: 7000 }, 0],
      [{ y: 600, adv: 300, take: 7000 }, 0], [{ y: 600, adv: 380, take: 6900 }, 0]] as const) {
      await trongGiaoDich(async () => {
        const f = await dongBang(CHU, NV_CD, P10, 600, null, 7000);
        expect(f.ok).toBe(true);
        await chotBang(NV_CD, P10, bang);
        const t = await tran();
        expect([bang, t.advance_offset_month, t.settlement_id === f.v!.settlement_id]).toEqual([bang, dMong, dMong > 0]);
      });
    }
  });

  it("cổ đông không khớp nhân viên ⇒ 22023", async () => {
    await trongGiaoDich(async () => {
      expect(await maLoi("SELECT app_private.salary_profit_month_caps_v1($1,$2,$3,$4)", [ORG_A, CD_KHAC, NV_CD, P10])).toBe("22023");
    });
  });
});

describe("E12 salary_profit_inputs_v1", () => {
  it("chủ đọc được: cổ đông có đủ phân bổ (kể cả toà nháp), Y_m, D_m gợi ý; nhân viên thường trả shareholder_id null — trong giao dịch CHỈ ĐỌC", async () => {
    await db.exec("BEGIN READ ONLY");
    try {
      const r = await phai<J>(CHU, "SELECT public.salary_profit_inputs_v1($1, $2) AS v", [P10, [NV_CD, NV_THUONG, NV_CD]]);
      expect(r.staff.map((s: J) => s.staff_id)).toEqual([NV_CD, NV_THUONG]);
      const [a, b] = r.staff;
      expect(a).toMatchObject({ organization_id: ORG_A, shareholder_id: CD_NV, sheet_status: "NONE", profit_draft: true, allocated_total: 600,
        investment_month: 600, advance_offset_month: 380, suggested_advance_offset: 380, settlement: null, paid_lines: [], needs_review: { count: 0 } });
      expect(a.allocations.map((x: J) => [x.building_label, x.amount, x.status])).toEqual([
        ["44TL", 300, "LOCKED"], ["44TL", 100, "LOCKED"], ["B4", 999, "DRAFT"], ["C5", 150, "DRAFT"], ["Toà Hai", 200, "LOCKED"]]);
      expect(b).toMatchObject({ shareholder_id: null, organization_id: ORG_A, investment_month: 0, suggested_advance_offset: 0, paid_lines: [] });
    } finally { await db.exec("ROLLBACK"); }
  });

  it("nhân viên tự xem được của mình; xem người khác (kể cả lẫn trong danh sách) ⇒ 42501 cho CẢ lệnh", async () => {
    await trongGiaoDich(async () => {
      expect((await inputs(NV_CD, [NV_CD])).ok).toBe(true);
      const r = await inputs(NV_CD, [NV_CD, NV_THUONG]);
      expect([r.ok, r.code]).toEqual([false, "42501"]);
      expect((await inputs(NV_THUONG, [NV_CD])).code).toBe("42501");
    });
  });

  it("chủ của CẢ hai công ty đọc được nhân viên hai công ty; chủ một công ty đọc nhân viên công ty kia ⇒ 42501", async () => {
    await trongGiaoDich(async () => {
      const r = await inputs(CHU_HAI, [NV_CD, NV_B]);
      expect(r.ok).toBe(true);
      expect(r.v!.staff.map((s: J) => [s.organization_id, s.shareholder_id, s.allocated_total])).toEqual([[ORG_A, CD_NV, 600], [ORG_B, CD_B, 700]]);
      expect((await inputs(CHU, [NV_CD, NV_B])).code).toBe("42501");
      expect((await inputs(CHU_B, [NV_CD])).code).toBe("42501");
    });
  });

  it("chưa đăng nhập ⇒ 42501; kỳ không phải ngày đầu tháng / danh sách có NULL ⇒ 22023", async () => {
    await trongGiaoDich(async () => {
      expect((await inputs(null as unknown as string, [NV_CD])).code).toBe("42501");
      expect((await inputs(CHU, [NV_CD], "2026-10-02")).code).toBe("22023");
      expect((await thu(CHU, "SELECT public.salary_profit_inputs_v1($1, ARRAY[NULL]::uuid[]) AS v", [P10])).code).toBe("22023");
    });
  });
});

describe("E13 salary_profit_settlement_freeze_v1", () => {
  it("đóng băng Y_m, D_m theo công thức (p_max_offset làm trần), lưu thực nhận dự kiến; ghi C5 SALARY_FROZEN; phát lại cùng khoá trả y nguyên", async () => {
    await trongGiaoDich(async () => {
      const key = khoa();
      const r = await dongBang(CHU, NV_CD, P10, 600, 250, 7000, key);
      expect(r.ok).toBe(true);
      expect(r.v).toMatchObject({ already_locked: false, shareholder_id: CD_NV, investment_month: 600, advance_offset_month: 250,
        paid_investment: 0, paid_offset: 0, unpaid_investment: 600, settled_by_marker: false });
      const c3 = await mot<J>("SELECT to_jsonb(c) AS v FROM app_private.profit_ledger_salary_settlements c WHERE c.id = $1", [r.v!.settlement_id]);
      expect(c3).toMatchObject({ state: "FROZEN", investment_month: 600, advance_offset_month: 250, expected_take_home: 7000, created_by: CHU });
      expect(c3.allocation_snapshot.length).toBe(3);
      expect(await suKien("SALARY_FROZEN")).toBe(1);
      expect((await dongBang(CHU, NV_CD, P10, 600, 250, 7000, key)).v).toEqual(r.v);
      expect((await dongBang(CHU, NV_CD, P10, 600, 100, 7000, key)).code).toBe("23505");
      expect(await suKien("SALARY_FROZEN")).toBe(1);
    });
  });

  it("số đầu tư client gửi lệch máy chủ ⇒ PT409 SALARY_PROFIT_QUOTE_CHANGED, DETAIL có server_investment; không ghi gì", async () => {
    await trongGiaoDich(async () => {
      const r = await dongBang(CHU, NV_CD, P10, 599, null, 7000);
      expect([r.code, r.message?.startsWith("SALARY_PROFIT_QUOTE_CHANGED")]).toEqual(["PT409", true]);
      expect(JSON.parse(r.detail!)).toMatchObject({ server_investment: 600, expected_investment: 599 });
      expect(await mot<number>("SELECT count(*)::int AS v FROM app_private.profit_ledger_salary_settlements")).toBe(0);
    });
  });

  it("đóng băng lại: huỷ bản cũ (bất biến) rồi tạo bản mới", async () => {
    await trongGiaoDich(async () => {
      const a = await dongBang(CHU, NV_CD, P10, 600, null, 7000);
      const b = await dongBang(CHU, NV_CD, P10, 600, 100, 6800);
      expect(b.v).toMatchObject({ advance_offset_month: 100, voided_settlement_id: a.v!.settlement_id });
      expect((await db.query<J>("SELECT state FROM app_private.profit_ledger_salary_settlements ORDER BY created_at")).rows.map((x) => x.state)).toEqual(["VOID", "FROZEN"]);
    });
  });

  it("đã trả lương (có trừ tạm ứng) rồi lợi nhuận tháng GIẢM ⇒ E13 vẫn chốt được, D_m = phần đã trừ thật", async () => {
    await trongGiaoDich(async () => {
      const pk = khoa();
      expect((await baoGia(CHU, NV_CD, P10, 600, 380, 5000, pk)).ok).toBe(true);
      expect((await traLuong(CHU, NV_CD, P10, 5000, pk)).ok).toBe(true);
      // Mở chốt rồi chốt lại tháng lợi nhuận thấp hơn, thành lỗ: Y_now = 100 (44TL) − 150 (Toà Hai) = −50.
      await db.query("UPDATE public.profit_allocations SET amount = 0 WHERE profit_monthly_id = $1 AND shareholder_id = $2", [PM_10_1, CD_NV]);
      await db.query("UPDATE public.profit_allocations SET amount = -150 WHERE profit_monthly_id = $1 AND shareholder_id = $2", [PM_10_2, CD_NV]);
      // D gợi ý (E12, E15, E13 cùng một số) không nhỏ hơn phần đã trừ: client phải giữ khoản đã trừ.
      expect(await tran()).toMatchObject({ investment_month: -50, advance_offset_month: 380, paid_offset: 380, offset_conflict: false });
      expect((await inputs(CHU, [NV_CD])).v!.staff[0]).toMatchObject({ suggested_advance_offset: 380, paid_offset: 380, offset_conflict: false });
      const r = await dongBang(CHU, NV_CD, P10, -50, null, 7000);
      expect(r.ok).toBe(true);
      expect(r.v).toMatchObject({ investment_month: -50, advance_offset_month: 380, paid_investment: 600, paid_offset: 380, unpaid_investment: -650 });
      expect(await mot<J>("SELECT to_jsonb(c) AS v FROM app_private.profit_ledger_salary_settlements c WHERE c.id = $1", [r.v!.settlement_id]))
        .toMatchObject({ investment_month: -50, advance_offset_month: 380, applied_offset_at_freeze: 380 });
    });
  });

  it("p_max_offset NHỎ HƠN phần đã trừ ⇒ D_m vẫn bằng phần đã trừ (không đóng băng ít hơn khoản đã thu hồi — D2.10)", async () => {
    await trongGiaoDich(async () => {
      const pk = khoa();
      await baoGia(CHU, NV_CD, P10, 600, 380, 5000, pk);
      await traLuong(CHU, NV_CD, P10, 5000, pk);
      const r = await dongBang(CHU, NV_CD, P10, 600, 100, 7000);
      expect(r.v).toMatchObject({ advance_offset_month: 380, paid_offset: 380 });
      expect(await mot<J>("SELECT to_jsonb(c) AS v FROM app_private.profit_ledger_salary_settlements c WHERE c.id = $1", [r.v!.settlement_id]))
        .toMatchObject({ advance_offset_month: 380, applied_offset_at_freeze: 380 });
    });
  });

  it("bảng đã LOCKED ⇒ không ghi gì, trả already_locked; kỳ ≤ mốc ⇒ D_m = 0; nhân viên thường ⇒ shareholder_id null", async () => {
    await trongGiaoDich(async () => {
      await chotBang(NV_CD, P10, { y: 600, adv: 0, take: 5000 });
      const r = await dongBang(CHU, NV_CD, P10, 600, null, 5000);
      expect(r.v).toMatchObject({ already_locked: true, settlement_id: null, investment_month: 600, advance_offset_month: 0 });
      expect(await mot<number>("SELECT count(*)::int AS v FROM app_private.profit_ledger_salary_settlements")).toBe(0);
    });
    await trongGiaoDich(async () => {
      await datMoc(P10);
      expect((await dongBang(CHU, NV_CD, P10, 600, null, 5000)).v).toMatchObject({ advance_offset_month: 0, settled_by_marker: true });
      expect((await dongBang(CHU, NV_THUONG, P10, 0, null, 5000)).v).toMatchObject({ shareholder_id: null, settlement_id: null });
    });
    await trongGiaoDich(async () => {
      // Đã trả có trừ tạm ứng, sau đó mốc phủ kỳ ⇒ D_m = 0 (không có cận dưới ở kỳ ≤ mốc).
      const pk = khoa();
      await baoGia(CHU, NV_CD, P10, 600, 380, 5000, pk);
      await traLuong(CHU, NV_CD, P10, 5000, pk);
      await datMoc(P10);
      expect((await dongBang(CHU, NV_CD, P10, 600, null, 5000)).v).toMatchObject({ advance_offset_month: 0, paid_offset: 380, settled_by_marker: true });
    });
  });

  it("chỉ quản trị lương của đúng công ty: nhân viên tự chốt ⇒ 42501; chủ công ty khác ⇒ 42501; thực nhận dự kiến bắt buộc", async () => {
    await trongGiaoDich(async () => {
      expect((await dongBang(NV_CD, NV_CD, P10, 600, null, 5000)).code).toBe("42501");
      expect((await dongBang(CHU_B, NV_CD, P10, 600, null, 5000)).code).toBe("42501");
      expect((await dongBang(CHU, NV_CD, P10, 600, -1, 5000)).code).toBe("22023");
      const r = await dongBang(CHU, NV_CD, P10, 600, null, null);
      expect([r.code, r.message?.split(":")[0]]).toEqual(["22023", "SALARY_PROFIT_BAD_INPUT"]);
      expect(await mot<number>("SELECT count(*)::int AS v FROM app_private.profit_ledger_salary_settlements")).toBe(0);
    });
  });
});

describe("E15 báo giá → salary_payout_v1 THẬT → F3", () => {
  it("báo giá rồi trả lương ⇒ đúng MỘT dòng LINKED với Y_i/D_i báo giá; sổ trừ Y − D; nhật ký QUOTED + LINKED", async () => {
    await trongGiaoDich(async () => {
      const pk = khoa();
      const q = await baoGia(CHU, NV_CD, P10, 600, 380, 5000, pk);
      expect(q.v).toMatchObject({ investment_amount: 600, advance_offset_amount: 380, investment_month: 600, advance_offset_month: 380, payout_request_key: pk });
      const p = await traLuong(CHU, NV_CD, P10, 5000, pk);
      expect(p.ok).toBe(true);
      const d = await dongSo(p.v!.salary_voucher_id);
      expect(d).toEqual([expect.objectContaining({ id: q.v!.quote_id, state: "LINKED", source: "UI_QUOTE", period_month: P10, y: 600, d: 380 })]);
      expect(await soDu()).toBe(CD_NV_GOC - (600 - 380));
      expect([await suKien("SALARY_QUOTED"), await suKien("SALARY_LINKED")]).toEqual([1, 1]);
    });
  });

  it("bỏ chọn dòng đầu tư ⇒ Y_i = 0 (vẫn một dòng LINKED); trừ tạm ứng chỉ trong phần đã chọn của tháng", async () => {
    await trongGiaoDich(async () => {
      const pk = khoa();
      expect((await baoGia(CHU, NV_CD, P10, 0, 0, 5000, pk)).v).toMatchObject({ investment_amount: 0, advance_offset_amount: 0 });
      const p = await traLuong(CHU, NV_CD, P10, 5000, pk);
      expect(await dongSo(p.v!.salary_voucher_id)).toEqual([expect.objectContaining({ state: "LINKED", y: 0, d: 0 })]);
      expect(await soDu()).toBe(CD_NV_GOC);
    });
  });

  it("trả 2 phiếu trong tháng, giữa hai lần chốt thêm toà ⇒ 2 dòng, ΣY_i = Y mới, ΣD_i = D_m, không trùng; số chọn là LUỸ KẾ", async () => {
    await trongGiaoDich(async () => {
      const k1 = khoa();
      expect((await baoGia(CHU, NV_CD, P10, 600, 200, 3000, k1)).v).toMatchObject({ investment_amount: 600, advance_offset_amount: 200 });
      const p1 = await traLuong(CHU, NV_CD, P10, 3000, k1);
      await db.query("UPDATE public.profit_monthly SET status = 'LOCKED', locked_at = clock_timestamp() WHERE id = $1", [PM_10_5]);
      // Lũy kế 650 / 300 sau khi đã trả 600 / 200 ⇒ phiếu này chỉ 50 / 100.
      expect((await baoGia(CHU, NV_CD, P10, 650, 300, 1000, khoa())).v).toMatchObject({ investment_amount: 50, advance_offset_amount: 100 });
      const k2 = khoa();
      const q2 = await baoGia(CHU, NV_CD, P10, 750, 380, 1000, k2);
      expect(q2.v).toMatchObject({ investment_month: 750, advance_offset_month: 380, paid_investment: 600, paid_offset: 200,
        investment_amount: 150, advance_offset_amount: 180 });
      const p2 = await traLuong(CHU, NV_CD, P10, 1000, k2);
      const [a] = await dongSo(p1.v!.salary_voucher_id);
      const [b] = await dongSo(p2.v!.salary_voucher_id);
      expect([a.y + b.y, a.d + b.d, await demDong()]).toEqual([750, 380, 2]);
      expect(await soDu()).toBe(0);
    });
  });

  it("Y_i − D_i không vượt số tiền phiếu cam kết (báo giá kẹp, lúc gắn kẹp lại)", async () => {
    await trongGiaoDich(async () => {
      const pk = khoa();
      expect((await baoGia(CHU, NV_CD, P10, 600, 0, 500, pk)).v).toMatchObject({ investment_amount: 500, advance_offset_amount: 0 });
      const p = await traLuong(CHU, NV_CD, P10, 500, pk);
      expect(await dongSo(p.v!.salary_voucher_id)).toEqual([expect.objectContaining({ state: "LINKED", y: 500, d: 0 })]);
    });
  });

  it("phiếu lương bị từ chối ⇒ phần đã trả của tháng trở lại (dòng LINKED của phiếu chết không còn tính)", async () => {
    await trongGiaoDich(async () => {
      const pk = khoa();
      await baoGia(CHU, NV_CD, P10, 600, 380, 5000, pk);
      const p = await traLuong(CHU, NV_CD, P10, 5000, pk);
      expect(await tran()).toMatchObject({ paid_investment: 600, paid_offset: 380 });
      await db.query("UPDATE public.approval_requests SET state = 'REJECTED' WHERE subject_id = $1", [p.v!.salary_voucher_id]);
      expect(await tran()).toMatchObject({ paid_investment: 0, paid_offset: 0, remaining_offset: 380 });
      expect(await soDu()).toBe(CD_NV_GOC);
      expect((await baoGia(CHU, NV_CD, P10, 600, 380, 5000, khoa())).v).toMatchObject({ investment_amount: 600, advance_offset_amount: 380 });
    });
  });

  it("báo giá chỉ khớp người đã báo giá: người khác trả bằng CÙNG khoá ⇒ dự phòng, báo giá vẫn treo", async () => {
    await trongGiaoDich(async () => {
      const pk = khoa();
      const q = await baoGia(CHU, NV_CD, P10, 600, 380, 5000, pk);
      const p = await traLuong(CHU2, NV_CD, P10, 5000, pk);
      expect(await dongSo(p.v!.salary_voucher_id)).toEqual([expect.objectContaining({ state: "NEEDS_REVIEW", source: "PAYOUT_FALLBACK" })]);
      expect(await mot<string>("SELECT state AS v FROM app_private.profit_ledger_salary_settlement_vouchers WHERE id = $1", [q.v!.quote_id])).toBe("QUOTED");
    });
  });

  it("chốt lại tháng lợi nhuận sau khi trả ⇒ số dư phản ánh phần chênh; phiếu sau chỉ trả phần chênh", async () => {
    await trongGiaoDich(async () => {
      const k1 = khoa();
      await baoGia(CHU, NV_CD, P10, 600, 380, 3000, k1);
      await traLuong(CHU, NV_CD, P10, 3000, k1);
      const sau1 = await soDu();
      await db.query("UPDATE public.profit_allocations SET amount = 400 WHERE profit_monthly_id = $1 AND shareholder_id = $2", [PM_10_1, CD_NV]);
      expect(await soDu()).toBe(sau1 + 100);
      const q = await baoGia(CHU, NV_CD, P10, 700, 380, 1000, khoa());
      expect(q.v).toMatchObject({ investment_amount: 100, advance_offset_amount: 0 });
    });
  });

  it("lệch trần: chọn quá Y_m hoặc trừ quá D_m ⇒ PT409 (DETAIL có trần); kỳ ≤ mốc mà chọn > 0 ⇒ 22023", async () => {
    await trongGiaoDich(async () => {
      const a = await baoGia(CHU, NV_CD, P10, 601, 0, 5000, khoa());
      expect([a.code, JSON.parse(a.detail!).investment_month]).toEqual(["PT409", 600]);
      expect((await baoGia(CHU, NV_CD, P10, 600, 381, 5000, khoa())).code).toBe("PT409");
      await datMoc(P10);
      const b = await baoGia(CHU, NV_CD, P10, 1, 0, 5000, khoa());
      expect([b.code, b.message?.startsWith("SALARY_PROFIT_SETTLED_BY_MARKER")]).toEqual(["22023", true]);
    });
  });

  it("báo giá mới huỷ báo giá cũ của MỌI người gọi; người khác trả bằng khoá cũ ⇒ không khớp, không đếm đôi", async () => {
    await trongGiaoDich(async () => {
      const kA = khoa();
      const kB = khoa();
      const qA = await baoGia(CHU, NV_CD, P10, 600, 380, 5000, kA);
      const qB = await baoGia(CHU2, NV_CD, P10, 600, 380, 5000, kB);
      expect(qB.v!.voided_quote_ids).toEqual([qA.v!.quote_id]);
      const pA = await traLuong(CHU, NV_CD, P10, 5000, kA);
      expect(await dongSo(pA.v!.salary_voucher_id)).toEqual([expect.objectContaining({ state: "NEEDS_REVIEW", source: "PAYOUT_FALLBACK" })]);
      const pB = await traLuong(CHU2, NV_CD, P10, 5000, kB);
      expect(await dongSo(pB.v!.salary_voucher_id)).toEqual([expect.objectContaining({ id: qB.v!.quote_id, state: "LINKED", y: 600 })]);
      expect(await soDu()).toBe(CD_NV_GOC - 220);
    });
  });

  it("KẸP LẠI lúc gắn: phiếu khác đã LINKED phần của tháng sau khi báo giá ⇒ kẹp làm đổi số ⇒ NEEDS_REVIEW kèm số báo giá và số kẹp, không đếm đôi", async () => {
    await trongGiaoDich(async () => {
      await dongBang(CHU, NV_CD, P10, 600, null, 9000);
      await chotBang(NV_CD, P10, { y: 600, adv: 380, take: 9000 });
      const kB = khoa();
      const qB = await baoGia(CHU2, NV_CD, P10, 600, 380, 5000, kB);
      expect(qB.v).toMatchObject({ investment_amount: 600, advance_offset_amount: 380, needs_review_reason: null });
      // Người khác trả không qua báo giá (bảng LOCKED có bản đóng băng khớp ⇒ dự phòng LINKED đủ phần còn lại).
      const pA = await traLuong(CHU, NV_CD, P10, 4000, khoa());
      expect(await dongSo(pA.v!.salary_voucher_id)).toEqual([expect.objectContaining({ state: "LINKED", y: 600, d: 380 })]);
      const pB = await traLuong(CHU2, NV_CD, P10, 5000, kB);
      const [l] = await dongSo(pB.v!.salary_voucher_id);
      expect(l).toMatchObject({ state: "NEEDS_REVIEW", y: 0, d: 0, goi_y: 0 });
      expect(await mot<string>("SELECT state AS v FROM app_private.profit_ledger_salary_settlement_vouchers WHERE id = $1", [qB.v!.quote_id])).toBe("VOID");
      const ev = await mot<J>(`SELECT jsonb_build_object('reason', reason, 'p', payload) AS v FROM app_private.profit_ledger_events
        WHERE line_id = $1 AND event_kind = 'SALARY_NEEDS_REVIEW'`, [l.id]);
      expect(ev).toMatchObject({ reason: "QUOTE_RECLAMPED", p: { quoted_investment: 600, quoted_offset: 380, clamped_investment: 0, clamped_offset: 0 } });
      expect(await soDu()).toBe(CD_NV_GOC - 220);
    });
  });

  it("số chọn luỹ kế TRÁI DẤU phần còn lại (tháng trộn dấu / chọn ít hơn phần đã trả) ⇒ báo trước + NEEDS_REVIEW, không ghi Y = 0 im lặng", async () => {
    await trongGiaoDich(async () => {
      const k1 = khoa();
      await baoGia(CHU, NV_CD, P10, 300, 0, 3000, k1);
      await traLuong(CHU, NV_CD, P10, 3000, k1);
      // Đã trả 300 trong 600; phiếu sau gửi luỹ kế 200 (< 300 đã trả) ⇒ trái dấu với phần còn lại 300.
      const k2 = khoa();
      const q = await baoGia(CHU, NV_CD, P10, 200, 0, 2000, k2);
      expect(q.v).toMatchObject({ investment_amount: 0, needs_review_reason: "MIXED_SIGN_SELECTION" });
      const p = await traLuong(CHU, NV_CD, P10, 2000, k2);
      const [l] = await dongSo(p.v!.salary_voucher_id);
      expect(l).toMatchObject({ state: "NEEDS_REVIEW", y: 0 });
      expect(await mot<string>("SELECT reason AS v FROM app_private.profit_ledger_events WHERE line_id = $1 AND event_kind = 'SALARY_NEEDS_REVIEW'", [l.id]))
        .toBe("MIXED_SIGN_SELECTION");
    });
  });

  it("kỳ lương không phải ngày 1 ⇒ NEEDS_REVIEW ở tháng chứa ngày đó (kèm lý do), không bỏ qua im lặng", async () => {
    await trongGiaoDich(async () => {
      const p = await traLuong(CHU, NV_CD, "2026-10-15", 4000, khoa());
      expect(p.ok).toBe(true);
      const [l] = await dongSo(p.v!.salary_voucher_id);
      expect(l).toMatchObject({ state: "NEEDS_REVIEW", period_month: P10, y: 0, d: 0 });
      const ev = await mot<J>(`SELECT jsonb_build_object('reason', reason, 'p', payload) AS v FROM app_private.profit_ledger_events
        WHERE line_id = $1 AND event_kind = 'SALARY_NEEDS_REVIEW'`, [l.id]);
      expect(ev).toMatchObject({ reason: "PERIOD_NOT_FIRST_DAY", p: { period_raw: "2026-10-15", period_month: P10 } });
    });
  });

  it("báo giá chỉ khớp lệnh trả lương mang ĐÚNG khoá đã báo: cùng người nhưng khoá khác ⇒ dự phòng, báo giá vẫn treo", async () => {
    await trongGiaoDich(async () => {
      const q = await baoGia(CHU, NV_CD, P10, 600, 380, 5000, khoa());
      const p = await traLuong(CHU, NV_CD, P10, 5000, khoa());
      expect(await dongSo(p.v!.salary_voucher_id)).toEqual([expect.objectContaining({ state: "NEEDS_REVIEW", source: "PAYOUT_FALLBACK" })]);
      expect(await mot<string>("SELECT state AS v FROM app_private.profit_ledger_salary_settlement_vouchers WHERE id = $1", [q.v!.quote_id])).toBe("QUOTED");
      expect(await soDu()).toBe(CD_NV_GOC);
    });
  });

  it("tổng tiền phiếu ≠ số báo giá cam kết ⇒ huỷ báo giá + NEEDS_REVIEW (không trừ sổ), lương vẫn trả được", async () => {
    await trongGiaoDich(async () => {
      const pk = khoa();
      const q = await baoGia(CHU, NV_CD, P10, 600, 380, 5000, pk);
      const p = await traLuong(CHU, NV_CD, P10, 4999, pk);
      expect(p.ok).toBe(true);
      expect(await dongSo(p.v!.salary_voucher_id)).toEqual([expect.objectContaining({ state: "NEEDS_REVIEW", y: 0, d: 0, goi_y: 600 })]);
      expect(await mot<string>("SELECT state AS v FROM app_private.profit_ledger_salary_settlement_vouchers WHERE id = $1", [q.v!.quote_id])).toBe("VOID");
      expect(await soDu()).toBe(CD_NV_GOC);
    });
  });

  it("báo giá quá 30 phút ⇒ NEEDS_REVIEW; 29 phút ⇒ vẫn LINKED", async () => {
    for (const [phut, mong] of [[31, "NEEDS_REVIEW"], [29, "LINKED"]] as const) {
      await trongGiaoDich(async () => {
        const pk = khoa();
        const q = await baoGia(CHU, NV_CD, P10, 600, 380, 5000, pk);
        await luiGio(q.v!.quote_id, phut);
        const p = await traLuong(CHU, NV_CD, P10, 5000, pk);
        expect([phut, (await dongSo(p.v!.salary_voucher_id))[0].state]).toEqual([phut, mong]);
      });
    }
  });

  it("trả không báo giá, bảng nháp ⇒ NEEDS_REVIEW + gợi ý; sổ báo needs_review (chặn chi lợi nhuận); E16 xác nhận ⇒ LINKED", async () => {
    await trongGiaoDich(async () => {
      const p = await traLuong(CHU, NV_CD, P10, 4000, khoa());
      expect(p.ok).toBe(true);
      const [l] = await dongSo(p.v!.salary_voucher_id);
      expect(l).toMatchObject({ state: "NEEDS_REVIEW", source: "PAYOUT_FALLBACK", y: 0, d: 0, goi_y: 600 });
      expect(await mot<J>("SELECT app_private.profit_ledger_balance_v1($1,'SHAREHOLDER',$2)->'needs_review' AS v", [ORG_A, CD_NV])).toEqual({ count: 1, suggested: 600 });
      expect(await soDu()).toBe(CD_NV_GOC);
      await db.query("INSERT INTO app_private.test_route VALUES ($1,'SHADOW')", [CO_SO_TONG]);
      const r = await xacNhan(CHU2, l.id, 600, 380);
      expect(r.v).toMatchObject({ line_id: l.id, investment_amount: 600, advance_offset_amount: 380, balance_before: CD_NV_GOC, balance_after: 0 });
      expect((await dongSo(p.v!.salary_voucher_id))[0]).toMatchObject({ state: "LINKED", source: "OWNER_RESOLVE" });
    });
  });

  it("trả không báo giá, bảng LOCKED: không bản đóng băng ⇒ LINKED Y = phần còn lại, D = 0; có bản khớp ⇒ D = D_m − ΣD trước; tiền phiếu nhỏ ⇒ Y kẹp theo tiền phiếu + D", async () => {
    await trongGiaoDich(async () => {
      await chotBang(NV_CD, P10, { y: 600, adv: 0, take: 5000 });
      const p = await traLuong(CHU, NV_CD, P10, 5000, khoa());
      expect(await dongSo(p.v!.salary_voucher_id)).toEqual([expect.objectContaining({ state: "LINKED", source: "PAYOUT_FALLBACK", y: 600, d: 0, settlement_id: null })]);
      const p2 = await traLuong(CHU, NV_CD, P10, 100, khoa());
      expect(await dongSo(p2.v!.salary_voucher_id)).toEqual([expect.objectContaining({ state: "LINKED", y: 0, d: 0 })]);
    });
    await trongGiaoDich(async () => {
      const f = await dongBang(CHU, NV_CD, P10, 600, null, 9000);
      await chotBang(NV_CD, P10, { y: 600, adv: 380, take: 9000 });
      const p = await traLuong(CHU, NV_CD, P10, 100, khoa());
      expect(await dongSo(p.v!.salary_voucher_id)).toEqual([expect.objectContaining({ state: "LINKED", y: 480, d: 380, settlement_id: f.v!.settlement_id })]);
      const p2 = await traLuong(CHU, NV_CD, P10, 5000, khoa());
      expect(await dongSo(p2.v!.salary_voucher_id)).toEqual([expect.objectContaining({ state: "LINKED", y: 120, d: 0 })]);
    });
  });

  it("kỳ ≤ mốc: trả không báo giá ⇒ LINKED 0/0; báo giá với 0 vẫn được", async () => {
    await trongGiaoDich(async () => {
      await datMoc(P10);
      const p = await traLuong(CHU, NV_CD, P10, 4000, khoa());
      expect(await dongSo(p.v!.salary_voucher_id)).toEqual([expect.objectContaining({ state: "LINKED", y: 0, d: 0 })]);
      const pk = khoa();
      expect((await baoGia(CHU, NV_CD, P10, 0, 0, 3000, pk)).v).toMatchObject({ investment_amount: 0, settled_by_marker: true });
      const p2 = await traLuong(CHU, NV_CD, P10, 3000, pk);
      expect(await dongSo(p2.v!.salary_voucher_id)).toEqual([expect.objectContaining({ state: "LINKED", source: "UI_QUOTE", y: 0, d: 0 })]);
    });
  });

  it("tháng lỗ (Y_i âm) không làm hỏng trả lương: báo giá và dự phòng LOCKED đều LINKED số âm, sổ đúng", async () => {
    await trongGiaoDich(async () => {
      const pk = khoa();
      expect((await baoGia(CHU, NV_LO, P10, -250, 0, 2000, pk)).v).toMatchObject({ investment_amount: -250, advance_offset_amount: 0 });
      const p = await traLuong(CHU, NV_LO, P10, 2000, pk);
      expect(await dongSo(p.v!.salary_voucher_id)).toEqual([expect.objectContaining({ state: "LINKED", y: -250, d: 0 })]);
      expect(await soDu(CD_LO)).toBe(0);
    });
    await trongGiaoDich(async () => {
      await chotBang(NV_LO, P10, { y: -250, adv: 0, take: 2000 });
      const p = await traLuong(CHU, NV_LO, P10, 2000, khoa());
      expect(await dongSo(p.v!.salary_voucher_id)).toEqual([expect.objectContaining({ state: "LINKED", y: -250, d: 0 })]);
    });
  });

  it("nhân viên không phải cổ đông: báo giá trả quote_id null, trả lương chạy như cũ, không dòng sổ nào", async () => {
    await trongGiaoDich(async () => {
      expect((await baoGia(CHU, NV_THUONG, P10, 0, 0, 3000, khoa())).v).toMatchObject({ quote_id: null, shareholder_id: null });
      const p = await traLuong(CHU, NV_THUONG, P10, 3000, khoa());
      expect(p.v).toMatchObject({ state: "PENDING_APPROVAL" });
      expect(await mot<number>("SELECT count(*)::int AS v FROM app_private.profit_ledger_salary_settlement_vouchers")).toBe(0);
      expect(await mot<number>("SELECT count(*)::int AS v FROM app_private.profit_ledger_events")).toBe(0);
    });
  });

  it("duyệt phiếu lương sau khi LINKED (trigger a70 đặt lại dấu) ⇒ duyệt chạy, vẫn một dòng, một sự kiện; phát lại lệnh trả lương không ghi thêm", async () => {
    await trongGiaoDich(async () => {
      const pk = khoa();
      await baoGia(CHU, NV_CD, P10, 600, 380, 5000, pk);
      const p = await traLuong(CHU, NV_CD, P10, 5000, pk);
      await duyet(p.v!.salary_voucher_id);
      expect(await mot<string>("SELECT paid::text AS v FROM public.salary_monthly WHERE staff_id = $1 AND period_month = $2", [NV_CD, P10])).toBe("5000.00");
      expect((await traLuong(CHU, NV_CD, P10, 5000, pk)).v).toEqual(p.v);
      expect([await demDong(), await suKien("SALARY_LINKED")]).toEqual([1, 1]);
    });
  });

  it("phiếu lương lập TRƯỚC M3 được duyệt sau M3 (dấu không đổi) ⇒ F3 không chạy, không có dòng sổ", async () => {
    await trongGiaoDich(async () => {
      await duyet(V_OLD9);
      expect(await mot<string>("SELECT paid::text AS v FROM public.salary_monthly WHERE staff_id = $1 AND period_month = $2", [NV_CD, P9])).toBe("2000.00");
      expect(await dongSo(V_OLD9)).toEqual([]);
      await db.query("UPDATE public.salary_monthly SET payout_voucher_id = payout_voucher_id, paid = paid + 1 WHERE staff_id = $1 AND period_month = $2", [NV_CD, P9]);
      expect(await dongSo(V_OLD9)).toEqual([]);
    });
  });

  it("kỳ của dòng sổ: lệnh trả lương đã xong (subject_id = phiếu) thắng dòng bảng lương bị đóng dấu nhầm kỳ; không có thì theo bảng", async () => {
    await trongGiaoDich(async () => {
      await db.query(`INSERT INTO app_private.canonical_write_operations(organization_id, operation, subject_scope, actor_id, idempotency_key, payload_hash, subject_id, response_payload, completed_at)
        VALUES ($1,'salary.payout.v1',$2,$3,'khoa-cu-0001',md5('x'),$4,'{}'::jsonb,now())`, [ORG_A, `${NV_CD}|${P9}`, CHU, V_KHONG_KY]);
      await db.query("INSERT INTO public.salary_monthly(user_id, staff_id, period_month, payout_voucher_id, organization_id) VALUES ($1,$2,'2026-11-01',$3,$4)", [CHU, NV_CD, V_KHONG_KY, ORG_A]);
      expect(await dongSo(V_KHONG_KY)).toEqual([expect.objectContaining({ period_month: P9, state: "NEEDS_REVIEW" })]);
    });
    await trongGiaoDich(async () => {
      await db.query("INSERT INTO public.salary_monthly(user_id, staff_id, period_month, payout_voucher_id, organization_id) VALUES ($1,$2,'2026-11-01',$3,$4)", [CHU, NV_CD, V_KHONG_KY, ORG_A]);
      expect(await dongSo(V_KHONG_KY)).toEqual([expect.objectContaining({ period_month: "2026-11-01" })]);
    });
  });

  it("đường client cũ (cập nhật thẳng salary_monthly bằng vai authenticated) cũng bị bắt; phiếu ứng lương / phiếu người khác / phiếu đã xoá thì bỏ qua", async () => {
    await trongGiaoDich(async () => {
      const r = await thu(CHU, "UPDATE public.salary_monthly SET payout_voucher_id = $1 WHERE staff_id = $2 AND period_month = $3 RETURNING 1 AS v", [V_KHONG_KY, NV_CD, P9]);
      expect(r.ok).toBe(true);
      expect(await dongSo(V_KHONG_KY)).toEqual([expect.objectContaining({ period_month: P9, state: "NEEDS_REVIEW" })]);
    });
    await trongGiaoDich(async () => {
      await db.query("UPDATE public.income_expenses SET salary_role = 'ADVANCE' WHERE id = $1", [V_KHONG_KY]);
      await db.query("UPDATE public.salary_monthly SET payout_voucher_id = $1 WHERE staff_id = $2 AND period_month = $3", [V_KHONG_KY, NV_CD, P9]);
      await db.query("UPDATE public.salary_monthly SET payout_voucher_id = $1 WHERE staff_id = $2 AND period_month = $3", [V_THUONG_OLD, NV_CD, P5]);
      await db.query("UPDATE public.income_expenses SET deleted_at = now(), salary_role = NULL WHERE id = $1", [V_KHONG_KY]);
      await db.query("INSERT INTO public.salary_monthly(user_id, staff_id, period_month, payout_voucher_id, organization_id) VALUES ($1,$2,'2026-12-01',$3,$4)", [CHU, NV_CD, V_KHONG_KY, ORG_A]);
      expect(await mot<number>("SELECT count(*)::int AS v FROM app_private.profit_ledger_salary_settlement_vouchers")).toBe(0);
    });
  });

  it("phiếu đã gắn sổ của cổ đông KHÁC (vi phạm toàn vẹn) ⇒ 55000", async () => {
    await trongGiaoDich(async () => {
      await db.query("UPDATE public.salary_monthly SET payout_voucher_id = $1 WHERE staff_id = $2 AND period_month = $3", [V_KHONG_KY, NV_CD, P9]);
      expect((await dongSo(V_KHONG_KY)).length).toBe(1);
      await db.query("UPDATE public.shareholders SET auth_user_id = NULL WHERE id = $1", [CD_NV]);
      await db.query("UPDATE public.shareholders SET auth_user_id = $1 WHERE id = $2", [NV_CD, CD_KHAC]);
      expect(await maLoi("UPDATE public.salary_monthly SET payout_voucher_id = $1 WHERE staff_id = $2 AND period_month = $3", [V_KHONG_KY, NV_CD, P5])).toBe("55000");
    });
  });

  it("E15: không đăng nhập / không phải quản trị lương ⇒ 42501; khoá sai ⇒ 22023; số tiền phiếu ≤ 0 ⇒ 22023", async () => {
    await trongGiaoDich(async () => {
      expect((await baoGia(NV_CD, NV_CD, P10, 0, 0, 100, khoa())).code).toBe("42501");
      expect((await baoGia(CHU_B, NV_CD, P10, 0, 0, 100, khoa())).code).toBe("42501");
      expect((await baoGia(CHU, NV_CD, P10, 0, 0, 100, "ngan")).code).toBe("22023");
      expect((await baoGia(CHU, NV_CD, P10, 0, 0, 0, khoa())).code).toBe("22023");
      expect((await baoGia(CHU, NV_CD, P10, 0, -1, 100, khoa())).code).toBe("22023");
    });
  });
});

describe("xung đột phần trừ tạm ứng: bảng chốt không gồm khoản đã trừ ở phiếu trước", () => {
  it("trả bảng nháp có trừ D rồi chốt bảng KHÔNG qua E13 (advances_total = 0) ⇒ E12/E14 báo offset_conflict; phiếu sau (dự phòng hay báo giá) ⇒ NEEDS_REVIEW, sổ không ghi thêm", async () => {
    await trongGiaoDich(async () => {
      const k1 = khoa();
      await baoGia(CHU, NV_CD, P10, 600, 380, 5000, k1);
      await traLuong(CHU, NV_CD, P10, 5000, k1);
      const sau1 = await soDu();
      await chotBang(NV_CD, P10, { y: 600, adv: 0, take: 5600 });
      expect(await tran()).toMatchObject({ sheet_status: "LOCKED", advance_offset_month: 0, paid_offset: 380, offset_conflict: true, settlement_id: null });
      expect((await inputs(CHU, [NV_CD])).v!.staff[0]).toMatchObject({ offset_conflict: true, paid_offset: 380, advance_offset_month: 0 });
      const e14 = await phai<J>(CHU, "SELECT public.profit_unlock_salary_impact_v1($1,$2,$3) AS v", [ORG_A, P10, null]);
      expect(e14.paid_via_salary).toEqual([expect.objectContaining({ shareholder_id: CD_NV, offset_conflict: true, paid_offset: 380, advance_offset_month: 0 })]);
      // Phiếu dự phòng (không báo giá) trên bảng LOCKED xung đột: không LINKED.
      const p2 = await traLuong(CHU, NV_CD, P10, 1000, khoa());
      const [l2] = await dongSo(p2.v!.salary_voucher_id);
      expect(l2).toMatchObject({ state: "NEEDS_REVIEW", y: 0, d: 0 });
      expect(await mot<string>("SELECT reason AS v FROM app_private.profit_ledger_events WHERE line_id = $1 AND event_kind = 'SALARY_NEEDS_REVIEW'", [l2.id]))
        .toBe("OFFSET_CONFLICT");
      // Có báo giá cũng vậy; báo giá báo trước lý do.
      const k3 = khoa();
      const q3 = await baoGia(CHU, NV_CD, P10, 600, 0, 1000, k3);
      expect(q3.v).toMatchObject({ offset_conflict: true, needs_review_reason: "OFFSET_CONFLICT" });
      const p3 = await traLuong(CHU, NV_CD, P10, 1000, k3);
      expect(await dongSo(p3.v!.salary_voucher_id)).toEqual([expect.objectContaining({ state: "NEEDS_REVIEW" })]);
      expect(await soDu()).toBe(sau1);
    });
  });

  it("bản đóng băng chỉ 'khớp bảng' khi advances_total phủ cả phần đã trừ (không chỉ D của bản đóng băng)", async () => {
    await trongGiaoDich(async () => {
      // Đóng băng với trần trừ 100, rồi trả bảng nháp trừ đủ 380, rồi chốt bảng chỉ gồm 100.
      const f = await dongBang(CHU, NV_CD, P10, 600, 100, 7000);
      expect(f.v).toMatchObject({ advance_offset_month: 100 });
      const k = khoa();
      await baoGia(CHU, NV_CD, P10, 600, 380, 5000, k);
      await traLuong(CHU, NV_CD, P10, 5000, k);
      await chotBang(NV_CD, P10, { y: 600, adv: 100, take: 7000 });
      expect(await tran()).toMatchObject({ sheet_status: "LOCKED", settlement_id: null, advance_offset_month: 0, paid_offset: 380, offset_conflict: true });
      // Bảng gồm đủ phần đã trừ ⇒ bản đóng băng khớp lại (D_m = 100 của bản đó); bản đó trừ ít hơn phần
      // đã trừ nên vẫn xung đột cho tới khi E13 lại trước khi chốt.
      await db.query("UPDATE public.salary_monthly SET advances_total = 380 WHERE staff_id = $1 AND period_month = $2", [NV_CD, P10]);
      const t = await tran();
      expect([t.settlement_id === f.v!.settlement_id, t.advance_offset_month, t.offset_conflict]).toEqual([true, 100, true]);
    });
  });
});

describe("E16 profit_ledger_salary_resolve_v1", () => {
  it("người nhận lương / cổ đông của dòng không tự xác nhận (42501 PROFIT_LEDGER_SALARY_SELF_RESOLVE), kể cả khi có quyền chia LN", async () => {
    await trongGiaoDich(async () => {
      await db.query("INSERT INTO app_private.test_route VALUES ($1,'SHADOW')", [CO_SO_TONG]);
      const p = await traLuong(CHU, NV_CD, P10, 4000, khoa());
      const [l] = await dongSo(p.v!.salary_voucher_id);
      // Cho nhân viên-cổ đông vai chủ (có shareholder_profit.distribute).
      await db.query("INSERT INTO public.role_bindings(id, organization_id, membership_id, role_id) VALUES ($1,$2,$3,$4)", [id(190), ORG_A, mem(NV_CD), VAI_CHU_A]);
      await db.query("INSERT INTO public.role_binding_scopes VALUES ($1,$2,$3)", [ORG_A, id(190), PV_A]);
      const r = await xacNhan(NV_CD, l.id, 600, 0);
      expect([r.code, r.message?.split(":")[0]]).toEqual(["42501", "PROFIT_LEDGER_SALARY_SELF_RESOLVE"]);
      expect((await dongSo(p.v!.salary_voucher_id))[0].state).toBe("NEEDS_REVIEW");
      expect((await xacNhan(CHU, l.id, 600, 0)).ok).toBe(true);
    });
  });

  async function dongCanXem(): Promise<{ line: string; voucher: string }> {
    const p = await traLuong(CHU, NV_CD, P10, 4000, khoa());
    const [l] = await dongSo(p.v!.salary_voucher_id);
    return { line: l.id, voucher: p.v!.salary_voucher_id };
  }
  it("chỉ chạy khi sổ tổng ở SHADOW/CANONICAL; LEGACY ⇒ 55000 ROUTE_OFF, FROZEN ⇒ 55000 FROZEN; CANONICAL ghi nhận lượt", async () => {
    await trongGiaoDich(async () => {
      const { line } = await dongCanXem();
      const a = await xacNhan(CHU, line, 600, 0);
      expect([a.code, a.message?.startsWith("PROFIT_LEDGER_ROUTE_OFF")]).toEqual(["55000", true]);
      await db.query("INSERT INTO app_private.test_route VALUES ($1,'FROZEN')", [CO_SO_TONG]);
      const b = await xacNhan(CHU, line, 600, 0);
      expect([b.code, b.message?.startsWith("PROFIT_LEDGER_FROZEN")]).toEqual(["55000", true]);
      await db.query("UPDATE app_private.test_route SET route = 'CANONICAL' WHERE feature_key = $1", [CO_SO_TONG]);
      expect((await xacNhan(CHU, line, 600, 0)).ok).toBe(true);
      expect(await mot<number>("SELECT count(*)::int AS v FROM app_private.test_claims")).toBe(1);
    });
  });

  it("ngoài trần ⇒ 22023 (DETAIL có trần); Y − D vượt tiền phiếu ⇒ 22023; không có quyền chia LN ⇒ 42501; lý do ngắn ⇒ 22023", async () => {
    await trongGiaoDich(async () => {
      await db.query("INSERT INTO app_private.test_route VALUES ($1,'SHADOW')", [CO_SO_TONG]);
      const { line } = await dongCanXem();
      const a = await xacNhan(CHU, line, 601, 0);
      expect([a.code, JSON.parse(a.detail!)]).toEqual(["22023", { min_investment: 0, max_investment: 600, max_offset: 380, voucher_amount: 4000 }]);
      expect((await xacNhan(CHU, line, 600, 381)).code).toBe("22023");
      expect((await xacNhan(CHU, line, -1, 0)).code).toBe("22023");
      const khongQuyen = await xacNhan(NV_THUONG, line, 600, 0);
      expect([khongQuyen.code, khongQuyen.message?.split(":")[0]]).toEqual(["42501", "SALARY_PROFIT_DENIED"]);
      expect((await xacNhan(CHU_B, line, 600, 0)).code).toBe("42501");
      expect((await xacNhan(CHU, line, 600, 0, "ngắn")).code).toBe("22023");
      await db.query("UPDATE public.income_expense_items SET unit_price = 100 WHERE income_expense_id = (SELECT salary_voucher_id FROM app_private.profit_ledger_salary_settlement_vouchers WHERE id = $1)", [line]);
      expect((await xacNhan(CHU, line, 600, 380)).code).toBe("22023");
      expect((await xacNhan(CHU, line, 480, 380)).ok).toBe(true);
    });
  });

  it("dòng không ở NEEDS_REVIEW ⇒ 55000; phiếu lương đã chết ⇒ 55000; phát lại cùng khoá trả y nguyên, khác nội dung ⇒ 23505", async () => {
    await trongGiaoDich(async () => {
      await db.query("INSERT INTO app_private.test_route VALUES ($1,'SHADOW')", [CO_SO_TONG]);
      const { line, voucher } = await dongCanXem();
      const key = khoa();
      const a = await xacNhan(CHU, line, 300, 0, "Chủ xác nhận số phiếu lương", key);
      expect(a.ok).toBe(true);
      expect((await xacNhan(CHU, line, 300, 0, "Chủ xác nhận số phiếu lương", key)).v).toEqual(a.v);
      expect((await xacNhan(CHU, line, 200, 0, "Chủ xác nhận số phiếu lương", key)).code).toBe("23505");
      const c = await xacNhan(CHU, line, 300, 0);
      expect([c.code, c.message?.split(":")[0]]).toEqual(["55000", "PROFIT_LEDGER_SALARY_LINE_STATE"]);
      const b = await dongCanXem();
      await db.query("UPDATE public.approval_requests SET state = 'REJECTED' WHERE subject_id = $1", [b.voucher]);
      const d = await xacNhan(CHU, b.line, 0, 0);
      expect([d.code, d.message?.split(":")[0]]).toEqual(["55000", "PROFIT_LEDGER_SALARY_VOUCHER_DEAD"]);
      expect(voucher).not.toBe(b.voucher);
      const e = await xacNhan(CHU, id(9999), 0, 0);
      expect([e.code, e.message?.split(":")[0]]).toEqual(["P0002", "PROFIT_LEDGER_SALARY_LINE_NOT_FOUND"]);
    });
  });
});

describe("E14 profit_unlock_salary_impact_v1", () => {
  it("liệt kê phần đã trả qua lương và số dư sau khi mở khoá; balance_after = số dư thật sau khi bỏ phân bổ (đo trong giao dịch)", async () => {
    await trongGiaoDich(async () => {
      const pk = khoa();
      await baoGia(CHU, NV_CD, P10, 600, 380, 5000, pk);
      const p = await traLuong(CHU, NV_CD, P10, 5000, pk);
      const r = await phai<J>(CHU, "SELECT public.profit_unlock_salary_impact_v1($1,$2,$3) AS v", [ORG_A, P10, null]);
      expect(r.paid_via_salary).toEqual([expect.objectContaining({ shareholder_id: CD_NV, staff_id: NV_CD, investment: 600, advance_offset: 380,
        salary_voucher_ids: [p.v!.salary_voucher_id], needs_review_count: 0 })]);
      const hieu = Object.fromEntries(r.ledger_effects.map((e: J) => [e.shareholder_id, e]));
      expect(Object.keys(hieu).sort()).toEqual([CD_KHAC, CD_LO, CD_NV].sort());
      expect(hieu[CD_NV]).toMatchObject({ balance_now: 0, allocations_removed: 600, balance_after: -600, becomes_advance: true });
      for (const sh of [CD_NV, CD_KHAC, CD_LO]) {
        const truoc = await soDu(sh);
        expect(hieu[sh].balance_now).toBe(truoc);
      }
      await db.query("UPDATE public.profit_monthly SET status = 'DRAFT' WHERE organization_id = $1 AND period_month = $2", [ORG_A, P10]);
      for (const sh of [CD_NV, CD_KHAC, CD_LO]) expect([sh, await soDu(sh)]).toEqual([sh, hieu[sh].balance_after]);
    });
  });

  it("lọc theo toà; kỳ ≤ mốc ⇒ allocations_removed = 0", async () => {
    await trongGiaoDich(async () => {
      const r = await phai<J>(CHU, "SELECT public.profit_unlock_salary_impact_v1($1,$2,$3) AS v", [ORG_A, P10, [TOA_2]]);
      const hieu = Object.fromEntries(r.ledger_effects.map((e: J) => [e.shareholder_id, e.allocations_removed]));
      expect(hieu).toEqual({ [CD_NV]: 200, [CD_LO]: -300 });
      await datMoc(P10);
      const r2 = await phai<J>(CHU, "SELECT public.profit_unlock_salary_impact_v1($1,$2,$3) AS v", [ORG_A, P10, null]);
      const nv = r2.ledger_effects.find((e: J) => e.shareholder_id === CD_NV);
      expect(nv).toMatchObject({ allocations_removed: 0, settled_by_marker: true });
      expect(nv.balance_after).toBe(nv.balance_now);
    });
  });

  it("chạy được trong giao dịch CHỈ ĐỌC (PostgREST gọi hàm STABLE như vậy)", async () => {
    await db.exec("BEGIN READ ONLY");
    try {
      const r = await anhHuong(CHU, ORG_A, P10);
      expect([r.ok, r.code]).toEqual([true, undefined]);
    } finally { await db.exec("ROLLBACK"); }
  });

  it("quyền: người không có chốt/mở chốt LN ⇒ 42501; chủ công ty khác ⇒ 42501; chưa đăng nhập ⇒ 42501", async () => {
    await trongGiaoDich(async () => {
      expect((await anhHuong(NV_CD, ORG_A, P10)).code).toBe("42501");
      expect((await anhHuong(CHU_B, ORG_A, P10)).code).toBe("42501");
      expect((await anhHuong(null as unknown as string, ORG_A, P10)).code).toBe("42501");
      expect((await anhHuong(SUPER, ORG_A, P10)).ok).toBe(true);
    });
  });
});

describe("ghi bù phiếu lương cũ (profit_ledger_luong_backfill_v1)", () => {
  it("bảng nháp: dòng LINKED nguồn BACKFILL, kỳ lấy từ dấu bảng lương, số dư giảm đúng Y − D; chạy lại cùng số ⇒ không ghi thêm", async () => {
    await trongGiaoDich(async () => {
      const truoc = await soDu();
      const r = await ghiBu(V_OLD9, 120, 0);
      expect(r).toMatchObject({ period_month: P9, investment_amount: 120, advance_offset_amount: 0, settlement_id: null, already: false, balance_before: truoc, balance_after: truoc - 120 });
      expect(await soDu()).toBe(truoc - 120);
      expect(await dongSo(V_OLD9)).toEqual([expect.objectContaining({ state: "LINKED", source: "BACKFILL", y: 120 })]);
      expect(await ghiBu(V_OLD9, 120, 0)).toMatchObject({ line_id: r.line_id, already: true });
      expect(await maLoi("SELECT app_private.profit_ledger_luong_backfill_v1($1,100,0,'Ghi bù phiếu lương đã trả',$2,NULL)", [V_OLD9, CHU])).toBe("55000");
      expect(await suKien("SALARY_LINKED")).toBe(1);
    });
  });

  it("bảng LOCKED: tạo bản đóng băng khớp bảng (D = 0) và gắn dòng vào đó; sau đó caps nhận bản đóng băng", async () => {
    await trongGiaoDich(async () => {
      const r = await ghiBu(V_OLD5, 500, 0);
      expect(r).toMatchObject({ period_month: P5, investment_amount: 500 });
      expect(r.settlement_id).not.toBeNull();
      expect(await mot<J>("SELECT to_jsonb(c) AS v FROM app_private.profit_ledger_salary_settlements c WHERE c.id = $1", [r.settlement_id]))
        .toMatchObject({ state: "FROZEN", investment_month: 500, advance_offset_month: 0, expected_take_home: 5000 });
      expect(await tran(NV_CD, CD_NV, P5)).toMatchObject({ settlement_id: r.settlement_id, paid_investment: 500, remaining_investment: 0 });
    });
  });

  it("từ chối: không phải phiếu lương / phiếu đã chết / nhân viên không là cổ đông / ngoài phần còn lại / không suy được kỳ (truyền kỳ thì được) / kỳ truyền lệch dấu", async () => {
    const loi = async (voucher: string, y: number, period: string | null = null, d = 0) => {
      await db.exec("SAVEPOINT gb");
      try {
        await ghiBu(voucher, y, d, period);
        await db.exec("RELEASE SAVEPOINT gb");
        return "ok";
      } catch (e) {
        await db.exec("ROLLBACK TO SAVEPOINT gb");
        return `${(e as { code?: string }).code} ${(e as Error).message.split(":")[0]}`;
      }
    };
    await trongGiaoDich(async () => {
      expect(await loi(PC_TAM_UNG, 0)).toBe("22023 PROFIT_LEDGER_BACKFILL_NOT_SALARY_VOUCHER");
      expect(await loi(V_THUONG_OLD, 0)).toBe("22023 PROFIT_LEDGER_BACKFILL_NOT_SHAREHOLDER");
      expect(await loi(V_OLD9, 121)).toBe("22023 PROFIT_LEDGER_BACKFILL_RANGE");
      // Kỳ 9 không có tạm ứng treo (D_m = 0) ⇒ không ghi bù phần trừ tạm ứng được.
      expect(await loi(V_OLD9, 120, null, 1)).toBe("22023 PROFIT_LEDGER_BACKFILL_RANGE");
      // Y − D không vượt tiền phiếu: phiếu 100 không chứa nổi 120.
      await db.query("UPDATE public.income_expenses SET total_amount = 100 WHERE id = $1", [V_OLD9]);
      expect(await loi(V_OLD9, 120)).toBe("22023 PROFIT_LEDGER_BACKFILL_RANGE");
      expect(await loi(V_OLD9, 100)).toBe("ok");
      // Bảng LOCKED: phần trừ tạm ứng không vượt advances_total đã chốt (= 0).
      expect(await loi(V_OLD5, 500, null, 1)).toBe("22023 PROFIT_LEDGER_BACKFILL_RANGE");
      expect(await loi(V_KHONG_KY, 0)).toBe("22023 PROFIT_LEDGER_BACKFILL_PERIOD_UNKNOWN");
      expect(await loi(V_OLD9, 0, P10)).toBe("22023 PROFIT_LEDGER_BACKFILL_PERIOD_CONFLICT");
      expect(await ghiBu(V_KHONG_KY, 0, 0, "2026-08-01")).toMatchObject({ period_month: "2026-08-01", already: false });
      await db.query("UPDATE public.approval_requests SET state = 'REJECTED' WHERE subject_id = $1", [V_OLD9]);
      expect(await loi(V_OLD9, 120)).toBe("22023 PROFIT_LEDGER_BACKFILL_NOT_SALARY_VOUCHER");
    });
  });
});

describe("so với client: Y máy chủ = applySalaryExtras/investmentByBuilding trên cùng dữ liệu", () => {
  function sinh(seed: number) {
    let s = seed >>> 0;
    return () => { s = (s + 0x6d2b79f5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  }
  const nhanCode = ["X1", "X2", "", null, "44TL"];
  const nhanTen = ["Toà X", "X1", "", null, "Toà Hai"];
  const KY = "2027-01-01";
  it.each([1, 2, 3, 4, 5, 6, 7, 8])("kịch bản ngẫu nhiên #%i", async (seed) => {
    const r = sinh(seed * 7919);
    const chon = <T>(a: T[]) => a[Math.floor(r() * a.length)];
    await trongGiaoDich(async () => {
      const soToa = 2 + Math.floor(r() * 5);
      for (let i = 0; i < soToa; i++) {
        const b = randomUUID();
        await db.query("INSERT INTO public.buildings(id, organization_id, code, name) VALUES ($1,$2,$3,$4)", [b, ORG_A, chon(nhanCode), chon(nhanTen)]);
        const pm = randomUUID();
        await db.query("INSERT INTO public.profit_monthly(id, organization_id, building_id, period_month, status, is_stale, locked_at) VALUES ($1,$2,$3,$4,$5,$6,'2027-02-01 00:00:00+00')",
          [pm, ORG_A, b, KY, r() < 0.7 ? "LOCKED" : "DRAFT", r() < 0.3]);
        await db.query("INSERT INTO public.profit_allocations(profit_monthly_id, shareholder_id, amount, organization_id) VALUES ($1,$2,$3,$4)",
          [pm, CD_NV, Math.round(r() * 2000) - 500, ORG_A]);
      }
      const nhan = ["X1", "Toà X", "Toà Hai", "44TL", "—", "KHONG_CO"];
      for (let i = 0, n = Math.floor(r() * 6); i < n; i++) await ghiDe(NV_CD, KY, chon(nhan), r() < 0.25 ? null : Math.round(r() * 3000) - 800);

      const sv = await dauTu(NV_CD, KY);
      await db.query("SELECT set_config('request.jwt.claim.sub', $1, true)", [CHU]);
      // Client: đúng các bước của useManagerSalary (đọc phân bổ theo cổ đông, lọc kỳ + LOCKED, nhãn code || name || "—")
      // rồi applySalaryExtras với số ghi đè đọc qua salary_line_override_list_v1 THẬT.
      const alloc = (await db.query<{ amount: string; period_month: string; building_id: string; status: string }>(
        `SELECT a.amount::text AS amount, pm.period_month::text AS period_month, pm.building_id, pm.status FROM public.profit_allocations a
           JOIN public.profit_monthly pm ON pm.id = a.profit_monthly_id WHERE a.shareholder_id = $1`, [CD_NV])).rows
        .filter((a) => a.period_month === KY && a.status === "LOCKED");
      const bld = new Map((await db.query<{ id: string; name: string | null; code: string | null }>("SELECT id, name, code FROM public.buildings")).rows
        .map((b) => [b.id, b.code || b.name]));
      const investmentBy = alloc.map((a) => ({ b: bld.get(a.building_id) || "—", amount: Number(a.amount) }));
      const raw = (await db.query<Record<string, unknown>>("SELECT * FROM public.salary_line_override_list_v1($1,$2)", [ORG_A, KY])).rows
        .map((o) => ({ ...o, created_at: String(o.created_at), computed_amount: String(o.computed_amount), amount: String(o.amount) }));
      const m0 = { id: NV_CD, status: "DRAFT", base: 0, bonusAuto: [], adjustments: [], commissionItems: [], commission: 0,
        investmentBy, investment: investmentBy.reduce((s, a) => s + a.amount, 0) } as unknown as SalManager;
      const m = applySalaryExtras(m0, [], parseOverrideRows(raw));
      expect(sv.investment).toBe(m.investment);
      const tuClient = Object.fromEntries(m.investmentBy.map((a) => [a.b, a.amount]));
      const tuMay = Object.fromEntries(sv.by_building.map((b: J) => [b.label, b.amount]));
      expect(tuMay).toEqual(tuClient);
    });
  });
});
