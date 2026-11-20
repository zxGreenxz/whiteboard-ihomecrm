import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * Migration 20261118041911 — tạm ứng cổ đông + chi lợi nhuận chốt theo tháng (phần máy chủ):
 * bản ghi chốt (app_private.profit_ledger_payout_settlements), vị thế A / B trên số dư ròng, lệnh lập phiếu tạm ứng
 * ở Thu chi, lệnh chốt chi lợi nhuận đến hết tháng N, huỷ bản ghi chốt không có phiếu tiền, hạng mục "Tạm Ứng".
 *
 * Chạy THẬT trên PostgreSQL nhúng, trên ĐỦ nền Đợt 1 theo đúng thứ tự phát hành:
 *  - M1 (20261115063149) → đọc (…083533) → chặn (…084015) → tạo (…084108) → migration này HAI lượt;
 *  - RPC vòng đời V2 của màn Chờ duyệt (approve / post / approve_and_post / decide_financial_request_v2), cầu a85 và
 *    mọi hàm chúng gọi là THÂN PRODUCTION chọn theo md5 (cùng bảng md5 với soTongLoiNhuanChanMigration.test.ts);
 *    hàm quyền v3, khoá công ty, công tắc, giữ sổ, khoá ngày là định nghĩa đang chạy trước M1;
 *  - phiếu tạm ứng / phiếu tiền của lần chốt do CHÍNH lệnh của migration lập, rồi duyệt / ghi sổ / từ chối / huỷ bằng
 *    RPC thật (F1, F1b, F2, F4, F5, E6 của Đợt 1 đều đang gắn).
 * Thay bằng bản giả (không phải đối tượng đang kiểm): submit_financial_request_v1 (máy luật duyệt — tạo yêu cầu + bước +
 * ứng viên là các chủ trừ người lập; chế độ DENY), append_income_expense_event_v1, finance_v2_log_event, org_today_v1.
 * Ranh giới "lập ở giao dịch trước" của assert_committed_birth_boundary_v2 được giả lập bằng birth_txid giả đặt trong
 * ngữ cảnh LẬP (như test phần chặn), vì mỗi ca chạy trong MỘT giao dịch rồi ROLLBACK.
 * Ca hai phiên thật không chạy được ở đây (một kết nối): ca "số liệu đổi giữa xem trước và chốt" dựng tuần tự.
 * Ca có tên mở đầu "[ghim]" chỉ đo văn bản / md5 — script đột biến cần ít nhất một ca KHÁC đỏ.
 *
 * Migration sau 20261118143113 (E6 không trả số dư của chủ thể cho người lập hộ) nạp ngay sau migration tạm ứng, HAI
 * lượt, trước mọi ca: mọi ca của file chạy trên E6 đã che. Ca riêng của nó ở hai describe "20261118143113 — …".
 *
 * Migration dọn dẹp 20261118171708 nạp tiếp theo, HAI lượt, trước mọi ca: thu EXECUTE của authenticated trên E4 / E5
 * (lệnh cũ chi theo số nhập tay), E6 bỏ vế "đăng nhập lúc lập" khi trả số dư, R4 bỏ DETAIL của lỗi DRIFT với người không
 * được thấy số. Từ đó ca nào cần phiếu E5 "cũ" (lập trước khi thu quyền) gọi E5 bằng vai chủ hàm (e5Cu) — thân E5 không
 * đổi. Ca riêng của nó ở các describe "20261118171708 — …".
 */
const DIR = "supabase/migrations";
const FILE = "supabase/migrations/20261118041911_tam_ung_co_dong_va_chot_chi_loi_nhuan.sql";
const FILE_M1 = `${DIR}/20261115063149_so_tong_loi_nhuan_nen.sql`;
const FILE_DOC = `${DIR}/20261115083533_so_tong_loi_nhuan_doc.sql`;
const FILE_CHAN = `${DIR}/20261115084015_so_tong_loi_nhuan_chan.sql`;
const FILE_TAO = `${DIR}/20261115084108_so_tong_loi_nhuan_tao.sql`;
const FILE_IE_COMPAT_CU = "20261030100148_khoa_cot_hoa_hong_ie_compat.sql";
const FILE_VA_GHI_SO = `${DIR}/20261018031847_commission_canonical_post_cashbook.sql`;
const FILE_DONG_TIEN = `${DIR}/20261115145954_dong_tien_tach_chi_chia_loi_nhuan.sql`;
const TEN_HUY_CHE = "20261118143113_so_tong_loi_nhuan_huy_che_so_du.sql";
const FILE_HUY_CHE = `${DIR}/${TEN_HUY_CHE}`;
const BASELINE = "supabase/baseline/schema.sql";
const TEN_BASELINE = "~baseline";
const MOC_BASELINE = "20260805120000";
const MOC_M1 = "20261115063149";
const CO = "shareholder_profit.ledger_payout.v1";
/** md5 thân E5 (shareholder_profit_ledger_payout_v1) mà lệnh lập tạm ứng dựng từ đó — E5 đổi thì phải rà lại lệnh tạm ứng. */
const MD5_E5_GOC = "106a24c9450641f073f0be317fdab3bf";

/** md5(thân, bỏ CR) của production — đo trên TEST (bản sao production) 15/11/2026; cùng bảng với test phần chặn. */
const MD5_PROD: Record<string, string> = {
  "public.approve_income_expense_v2": "f22c6db558d841e8ab4f28a8a971dc17",
  "public.post_approved_income_expense_v2": "6e25865cd1aec905360b2ef3b67186c3",
  "public.approve_and_post_income_expense_v2": "20fe3cb99668dc5f283ec4a3a5018996",
  "public.decide_financial_request_v2": "de18b25abe4d72a7de5eb9ff6b79e461",
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

const md5 = (s: string) => createHash("md5").update(s.replace(/\r/g, ""), "utf8").digest("hex");
type DinhNghia = { stmt: string; body: string; file: string };
/** Mọi câu CREATE FUNCTION trong migration (theo thứ tự tên file) rồi baseline, gom theo tên hàm. */
function gomDinhNghia(): Map<string, DinhNghia[]> {
  const out = new Map<string, DinhNghia[]>();
  const nguon: [string, string][] = readdirSync(DIR).filter((f) => f.endsWith(".sql")).sort().map((f) => [f, readFileSync(`${DIR}/${f}`, "utf8")]);
  nguon.push([TEN_BASELINE, readFileSync(BASELINE, "utf8")]);
  const re = /CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+([a-z_]+\.[a-z_0-9]+)\s*\(/gi;
  for (const [file, sql] of nguon) {
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
      out.set(ten, [...(out.get(ten) ?? []), { stmt, body: sau.slice(batDau, dong), file }]);
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
/** Định nghĩa đang chạy TRƯỚC M1: file migration sau mốc baseline và trước M1; không có thì baseline. */
function dinhNghiaTruocM1(ten: string): string {
  const ds = DINH_NGHIA.get(ten) ?? [];
  const hit = ds.filter((d) => d.file !== TEN_BASELINE && d.file > MOC_BASELINE && d.file < MOC_M1).at(-1) ?? ds.filter((d) => d.file === TEN_BASELINE).at(-1);
  if (!hit) throw new Error(`Không thấy định nghĩa của ${ten} trước M1`);
  return hit.stmt;
}
function dinhNghiaTrong(ten: string, file: string): DinhNghia {
  const hit = (DINH_NGHIA.get(ten) ?? []).filter((d) => d.file === file).at(-1);
  if (!hit) throw new Error(`Không thấy định nghĩa của ${ten} trong ${file}`);
  return hit;
}
/** Định nghĩa CUỐI CÙNG của một hàm trong thư mục migration (bản đang chạy sau khi áp hết). */
function dinhNghiaCuoi(ten: string): DinhNghia {
  const hit = (DINH_NGHIA.get(ten) ?? []).filter((d) => d.file !== TEN_BASELINE).at(-1);
  if (!hit) throw new Error(`Không thấy định nghĩa của ${ten} trong migrations`);
  return hit;
}
const VA_GHI_SO = (() => {
  const sql = readFileSync(FILE_VA_GHI_SO, "utf8");
  const a = sql.indexOf("DO $patch$");
  return sql.slice(a, sql.indexOf("$patch$;", a + 10) + "$patch$;".length);
})();
/** Hàm nền ngoài bảng md5: bản đang chạy trước M1 (công tắc, nhận lượt, lập tay, chuẩn hoá tên hạng mục). */
const HAM_THEM = [
  "app_private.evaluate_feature_route", "app_private.claim_feature_operation_v1", "app_private.ie_compat_actor_v2",
  "public.set_ie_item_accounting_class", "public.nrm_vn", "public.normalize_income_expense_type_name",
  "public.create_profit_payout_compat_v1",
].map(dinhNghiaTruocM1);
/** Ba thân mà migration phần tạo ghim md5 trước khi thay. */
const THAN_CU_CUA_TAO = [
  dinhNghiaTrong("public.manager_salary_payout_v1", TEN_BASELINE).stmt,
  dinhNghiaTrong("app_private.guard_profit_payout_scope_compat_v1", TEN_BASELINE).stmt,
  dinhNghiaTrong("public.ie_compat_insert_v2", FILE_IE_COMPAT_CU).stmt,
];
const MIGRATION = readFileSync(FILE, "utf8");
const M1 = readFileSync(FILE_M1, "utf8");
const DOC = readFileSync(FILE_DOC, "utf8");
const CHAN = readFileSync(FILE_CHAN, "utf8");
const TAO = readFileSync(FILE_TAO, "utf8");
/** Thân migration không có BEGIN / COMMIT / NOTIFY của chính file — để dán vào một giao dịch (như lane). */
const THAN = MIGRATION.replace(/^BEGIN;\s*$/m, "").replace(/^COMMIT;\s*$/m, "").replace(/^NOTIFY pgrst, 'reload schema';\s*$/m, "");
/** Migration 20261118143113 (E6 che balance_after) — cả file và thân không BEGIN / COMMIT (để dán như lane). */
const HUY_CHE = readFileSync(FILE_HUY_CHE, "utf8");
const THAN_HUY_CHE = HUY_CHE.replace(/^BEGIN;\s*$/m, "").replace(/^COMMIT;\s*$/m, "");
const E6 = "public.profit_ledger_payout_cancel_v1";
const E6_SIG = "public.profit_ledger_payout_cancel_v1(p_voucher_id uuid, p_reason text, p_idempotency_key text, p_expected_state text)";
/** md5 thân E6 (bỏ CR): bản production = thân 20261115084015 (đo trên production 18/11/2026), và bản che của 20261118143113. */
const MD5_E6_PROD = "6aa543506cb425c33c9963789aa0365a";
const MD5_E6_CHE = "7b3e96d1d8cfec6d91d1c65ca7c810b1";
const E6_CHAN = dinhNghiaTrong(E6, FILE_CHAN.slice(DIR.length + 1));
const E6_HUY_CHE = dinhNghiaTrong(E6, TEN_HUY_CHE);
/** Migration dọn dẹp 20261118171708: thu quyền E4 / E5 của authenticated, E6 bỏ vế "đăng nhập lúc lập", R4 che DETAIL của DRIFT. */
const FILE_DON_DEP = "supabase/migrations/20261118171708_so_tong_loi_nhuan_don_dep_sau_tam_ung.sql";
const TEN_DON_DEP = FILE_DON_DEP.slice(DIR.length + 1);
const TEN_SO_QUY = "20261120040424_so_du_dau_ky_va_phan_phoi_quy_co_dong.sql";
const DON_DEP = readFileSync(FILE_DON_DEP, "utf8");
const THAN_DON_DEP = DON_DEP.replace(/^BEGIN;\s*$/m, "").replace(/^COMMIT;\s*$/m, "").replace(/^NOTIFY pgrst, 'reload schema';\s*$/m, "");
const R4 = "public.shareholder_profit_advance_preview_v1";
const R4_SIG = "public.shareholder_profit_advance_preview_v1(p_shareholder_id uuid, p_amount numeric, p_account_id uuid)";
const E4_REGPROC = "public.shareholder_profit_payout_preview_v1(uuid,numeric,uuid)";
const E5_REGPROC = "public.shareholder_profit_ledger_payout_v1(uuid,numeric,uuid,date,text,boolean,text)";
/** md5 thân R4 (bỏ CR) của 20261118041911 = production (đo 18/11/2026). */
const MD5_R4_PROD = "d1c1212f15b45b896187b601a28155b3";
const R4_TAM_UNG = dinhNghiaTrong(R4, FILE.slice(DIR.length + 1));
const E6_DON_DEP = dinhNghiaTrong(E6, TEN_DON_DEP);
const R4_DON_DEP = dinhNghiaTrong(R4, TEN_DON_DEP);
/** Câu của lỗi lệch bất biến mà app_private.profit_ledger_position_v1 ném (XX000). */
const CAU_DRIFT = "PROFIT_LEDGER_POSITION_DRIFT: lợi nhuận chưa chi và tạm ứng không cộng ra đúng số dư sổ tổng — báo bộ phận kỹ thuật";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const mem = (user: string) => user.replace("4000-8000-0000000000", "4000-8000-1000000000");
const [ORG_A, ORG_B, ORG_C] = [1, 2, 3].map(id);
// CHU / CHU2 / CHU3: chủ (chi lợi nhuận + duyệt thu chi). CHU và CHU2 cùng giữ SO_QUY; CHU còn là cổ đông CD_CHU có quyền tạm ứng.
// GIU_SO: người giữ SO_GIU, không là cổ đông, không quyền gì khác. TU_UNG: cổ đông CD_TU, giữ SO_TU, có quyền tạm ứng.
// U_CD1: cổ đông CD1 có quyền tạm ứng, không giữ sổ. U_CD2: cổ đông CD2 KHÔNG có quyền tạm ứng. U_GO: quyền đã thu hồi.
// U_XEM: cổ đông CD_XEM chỉ có quyền xem phân chia lợi nhuận. KHONG_GIU: thành viên không giữ sổ nào.
// QUAN_LY: chỉ có quyền quản lý cổ đông. NGOAI: chủ công ty khác. SUPER: super admin, không là thành viên.
const [CHU, CHU2, CHU3, GIU_SO, U_CD1, U_CD2, KHONG_GIU, TU_UNG, U_GO, U_XEM, QUAN_LY] = [11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 27].map(id);
const [NGOAI, SUPER, U_R1, U_R2, U_R3] = [21, 22, 23, 24, 25].map(id);
const [VAI_CHU_A, VAI_CHU_B, VAI_XEM, VAI_QUAN_LY] = [31, 32, 33, 34].map(id);
const [PHAM_VI_A, PHAM_VI_B] = [41, 42].map(id);
const [TOA_AO, TOA_1, TOA_2, TOA_AO_B] = [51, 52, 53, 54].map(id);
const [SO_QUY, SO_GIU, SO_TU, SO_AO, SO_B] = [55, 56, 57, 58, 59].map(id);
const [CD1, CD2, CD3, CD_CHU, CD_TU, CD_NGHI, CD_XOA, CD_B, CD_GO, CD_XEM, CD_R1, CD_R2, CD_R3] = [61, 62, 63, 64, 65, 66, 67, 68, 69, 70, 71, 72, 73].map(id);
const [LOAI_CLN_A, LOAI_VP_A, LOAI_CLN_B, LOAI_VP_C] = [91, 93, 94, 96].map(id);
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
  CREATE TABLE public.buildings(id uuid PRIMARY KEY, organization_id uuid NOT NULL, user_id uuid NOT NULL, name text NOT NULL DEFAULT 'Toà',
    deleted_at timestamptz, is_virtual boolean NOT NULL DEFAULT false, created_at timestamptz NOT NULL DEFAULT now());
  CREATE TABLE public.accounts(id uuid PRIMARY KEY, organization_id uuid NOT NULL, user_id uuid, name text NOT NULL DEFAULT 'Sổ quỹ', deleted_at timestamptz,
    is_virtual boolean NOT NULL DEFAULT false, lock_date date);
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
  CREATE TABLE public.shareholders(id uuid PRIMARY KEY, organization_id uuid NOT NULL REFERENCES public.organizations(id), auth_user_id uuid UNIQUE,
    name text NOT NULL, is_active boolean NOT NULL DEFAULT true, deleted_at timestamptz);
  CREATE UNIQUE INDEX shareholders_id_org_uq ON public.shareholders (id, organization_id);
  CREATE TABLE public.profit_managers(id uuid PRIMARY KEY, organization_id uuid NOT NULL REFERENCES public.organizations(id), auth_user_id uuid,
    name text NOT NULL, is_active boolean NOT NULL DEFAULT true, deleted_at timestamptz);
  CREATE TABLE public.profit_monthly(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL, building_id uuid NOT NULL,
    period_month date NOT NULL, status text NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT','LOCKED')), is_stale boolean NOT NULL DEFAULT false,
    locked_at timestamptz, source_revenue numeric(15,2), source_expense numeric(15,2), adjusted_profit numeric(15,2),
    UNIQUE (building_id, period_month));
  CREATE TABLE public.profit_allocations(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    profit_monthly_id uuid NOT NULL REFERENCES public.profit_monthly(id) ON DELETE CASCADE,
    shareholder_id uuid NOT NULL REFERENCES public.shareholders(id) ON DELETE CASCADE,
    amount numeric(15,2) NOT NULL DEFAULT 0, organization_id uuid, created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (profit_monthly_id, shareholder_id));
  CREATE TABLE public.profit_manager_allocations(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    profit_monthly_id uuid NOT NULL REFERENCES public.profit_monthly(id) ON DELETE CASCADE,
    manager_id uuid NOT NULL REFERENCES public.profit_managers(id) ON DELETE CASCADE,
    amount numeric(15,2) NOT NULL DEFAULT 0, organization_id uuid, UNIQUE (profit_monthly_id, manager_id));
  CREATE TABLE public.building_shareholders(building_id uuid, shareholder_id uuid, percent numeric, organization_id uuid);
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
  CREATE TABLE public.approval_requests(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL, submission_no integer NOT NULL DEFAULT 1,
    subject_type text NOT NULL, subject_id uuid NOT NULL,
    state text NOT NULL CHECK (state IN ('PENDING_APPROVAL','POSTED','DENIED','REJECTED','CANCELLED','REVERSED','APPROVED','WITHDRAWN','CHANGES_REQUESTED','DISPUTED')),
    maker_membership_id uuid NOT NULL, maker_user_id uuid NOT NULL, rule_effect text, payload_hash text, amount numeric(18,2), cashbook_id uuid,
    building_id uuid, system_source text, submitted_at timestamptz DEFAULT now(), posted_at timestamptz, version bigint NOT NULL DEFAULT 1,
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
  CREATE TABLE public.profit_payout_reservations(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid, payout_voucher_id uuid,
    shareholder_id uuid, amount numeric(15,2));
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
  CREATE TABLE app_private.cashbook_closures(id bigserial PRIMARY KEY, organization_id uuid, cashbook_id uuid NOT NULL, closed_through date NOT NULL);
  CREATE TABLE app_private.cashbook_reopenings(id bigserial PRIMARY KEY, cashbook_id uuid NOT NULL, last_closure_id bigint);
  CREATE TABLE app_private.finance_v2_semantic_event_log(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid, event_kind text NOT NULL,
    source_table text, source_id uuid, source_kind text NOT NULL, actor uuid, txid xid8, created_at timestamptz NOT NULL DEFAULT now());
  CREATE TABLE public.cash_handovers(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), code text, status text NOT NULL DEFAULT 'PENDING');
  CREATE TABLE app_private.income_expense_v2_backfill_exceptions(organization_id uuid, voucher_id uuid, reason_code text, detail jsonb);
  CREATE TABLE public.invoices(id uuid PRIMARY KEY, billing_month text, building_id uuid);
  CREATE TABLE public.test_events(organization_id uuid, voucher_id uuid, action text, actor_id uuid, old_status text, new_status text, note text);
  CREATE FUNCTION app_private.append_income_expense_event_v1(p_organization_id uuid, p_income_expense_id uuid, p_action text, p_actor_id uuid,
    p_actor_name text, p_old_status text, p_new_status text, p_note text) RETURNS uuid LANGUAGE sql AS $$
    INSERT INTO public.test_events VALUES (p_organization_id, p_income_expense_id, p_action, p_actor_id, p_old_status, p_new_status, p_note);
    SELECT gen_random_uuid() $$;
`;

/**
 * Máy luật duyệt giả: một yêu cầu mở cho mỗi phiếu, MỘT bước, ứng viên = mọi thành viên mang vai chủ của công ty trừ
 * người lập. test.submit = 'DENY' ⇒ yêu cầu DENIED (không raise), như engine thật khi luật từ chối.
 */
const HAM_TEST = String.raw`
  CREATE FUNCTION app_private.submit_financial_request_v1(p_subject_id uuid, p_actor_membership uuid, p_actor_user uuid, p_idempotency_key text)
  RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'pg_catalog', 'app_private', 'public' AS $$
  DECLARE
    v_ie public.income_expenses; v_che_do text := COALESCE(nullif(current_setting('test.submit', true), ''), 'REQUIRE_APPROVAL');
    v_yc uuid; v_step uuid; v_lan int;
  BEGIN
    SELECT * INTO v_ie FROM public.income_expenses WHERE id = p_subject_id AND deleted_at IS NULL FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'subject not found' USING ERRCODE = 'P0002'; END IF;
    SELECT id INTO v_yc FROM public.approval_requests WHERE organization_id = v_ie.organization_id AND subject_type = 'FINANCIAL_VOUCHER'
      AND subject_id = p_subject_id AND state = 'PENDING_APPROVAL';
    IF v_yc IS NOT NULL THEN RETURN v_yc; END IF;
    SELECT COALESCE(max(submission_no), 0) + 1 INTO v_lan FROM public.approval_requests
     WHERE organization_id = v_ie.organization_id AND subject_type = 'FINANCIAL_VOUCHER' AND subject_id = p_subject_id;
    INSERT INTO public.approval_requests(organization_id, submission_no, subject_type, subject_id, state, maker_membership_id, maker_user_id,
        rule_effect, payload_hash, amount, cashbook_id, building_id, system_source)
      VALUES (v_ie.organization_id, v_lan, 'FINANCIAL_VOUCHER', p_subject_id,
        CASE v_che_do WHEN 'DENY' THEN 'DENIED' ELSE 'PENDING_APPROVAL' END,
        p_actor_membership, p_actor_user, CASE v_che_do WHEN 'DENY' THEN 'DENY' ELSE 'REQUIRE_APPROVAL' END,
        COALESCE(v_ie.source_payload_hash, md5(p_subject_id::text)), v_ie.total_amount, v_ie.account_id, v_ie.building_id, v_ie.system_source)
      RETURNING id INTO v_yc;
    IF v_che_do <> 'DENY' THEN
      INSERT INTO public.approval_request_steps(organization_id, request_id, step_no, status, mode, min_approvals)
      VALUES (v_ie.organization_id, v_yc, 1, 'PENDING', 'ANY', 1) RETURNING id INTO v_step;
      INSERT INTO public.approval_request_step_candidates(organization_id, request_step_id, membership_id, generation)
      SELECT v_ie.organization_id, v_step, rb.membership_id, 1
        FROM public.role_bindings rb JOIN public.organization_roles r ON r.id = rb.role_id AND r.system_key = 'TENANT_OWNER'
       WHERE rb.organization_id = v_ie.organization_id AND rb.membership_id <> p_actor_membership;
    END IF;
    RETURN v_yc;
  END $$;
  CREATE FUNCTION public.test_chung_tu(p_org uuid) RETURNS uuid LANGUAGE sql AS
    $$ INSERT INTO public.finance_evidence_objects(organization_id, state) VALUES (p_org, 'FINALIZED') RETURNING id $$;
`;

const TRIGGER_NEN = `
  CREATE UNIQUE INDEX income_expense_types_org_side_normalized_name_uq ON public.income_expense_types
    (organization_id, lower(btrim(type)), public.normalize_income_expense_type_name(name));
  CREATE TRIGGER a001_ie_lifecycle_normalize BEFORE INSERT ON public.income_expenses FOR EACH ROW EXECUTE FUNCTION app_private.ie_normalize_lifecycle_columns();
  CREATE TRIGGER a00_00_profit_payout_account_guard BEFORE INSERT OR UPDATE OF shareholder_id, profit_manager_id, account_id, organization_id, system_source
    ON public.income_expenses FOR EACH ROW EXECUTE FUNCTION app_private.guard_profit_payout_scope_compat_v1();
  CREATE TRIGGER a75_ie_cancel_close_request AFTER UPDATE OF approval_status ON public.income_expenses FOR EACH ROW
    WHEN (((new.approval_status = 'CANCELLED'::text) AND (old.approval_status IS DISTINCT FROM 'CANCELLED'::text))) EXECUTE FUNCTION app_private.ie_cancel_close_request_v1();
  CREATE TRIGGER a85_finance_v2_auto_posting_bridge BEFORE INSERT OR UPDATE OF approval_status, account_id, total_amount, deleted_at
    ON public.income_expenses FOR EACH ROW EXECUTE FUNCTION app_private.finance_v2_auto_posting_bridge();
  CREATE TRIGGER a86_finance_v2_birth_provenance BEFORE INSERT OR UPDATE ON public.income_expenses FOR EACH ROW
    WHEN (((new.approval_status = 'UNAPPROVED'::text) AND (new.birth_operation_id IS NULL))) EXECUTE FUNCTION app_private.finance_v2_birth_provenance_bridge();
  CREATE TRIGGER a87_finance_v2_request_close_sync AFTER UPDATE OF approval_status, posting_status ON public.income_expenses FOR EACH ROW
    EXECUTE FUNCTION app_private.finance_v2_close_request_on_voucher_change();
  CREATE TRIGGER set_ie_item_accounting_class BEFORE INSERT OR UPDATE OF income_expense_type_id, accounting_class ON public.income_expense_items
    FOR EACH ROW EXECUTE FUNCTION public.set_ie_item_accounting_class();
  CREATE TRIGGER trigger_auto_calc_item_amount BEFORE INSERT OR UPDATE ON public.income_expense_items FOR EACH ROW EXECUTE FUNCTION auto_calc_item_amount();
  CREATE TRIGGER trigger_auto_recalc_total_amount AFTER INSERT OR DELETE OR UPDATE ON public.income_expense_items FOR EACH ROW EXECUTE FUNCTION auto_recalc_total_amount();
  REVOKE ALL ON FUNCTION public.manager_salary_payout_v1(uuid, numeric, uuid, date, text, text) FROM PUBLIC;
  GRANT EXECUTE ON FUNCTION public.manager_salary_payout_v1(uuid, numeric, uuid, date, text, text) TO authenticated, service_role;
  REVOKE ALL ON FUNCTION public.ie_compat_insert_v2(jsonb, jsonb) FROM PUBLIC;
  GRANT EXECUTE ON FUNCTION public.ie_compat_insert_v2(jsonb, jsonb) TO authenticated;
  REVOKE ALL ON FUNCTION public.create_profit_payout_compat_v1(text, uuid, numeric, uuid, date, text, text) FROM PUBLIC;
  GRANT EXECUTE ON FUNCTION public.create_profit_payout_compat_v1(text, uuid, numeric, uuid, date, text, text) TO authenticated;
  REVOKE ALL ON FUNCTION app_private.guard_profit_payout_scope_compat_v1() FROM PUBLIC;
`;

function duLieu(): string {
  const tvA = [CHU, CHU2, CHU3, GIU_SO, U_CD1, U_CD2, KHONG_GIU, TU_UNG, U_GO, U_XEM, QUAN_LY, U_R1, U_R2, U_R3];
  const ganVai: [string, string, string, string][] = [
    [ORG_A, CHU, VAI_CHU_A, PHAM_VI_A], [ORG_A, CHU2, VAI_CHU_A, PHAM_VI_A], [ORG_A, CHU3, VAI_CHU_A, PHAM_VI_A],
    [ORG_A, U_XEM, VAI_XEM, PHAM_VI_A], [ORG_A, QUAN_LY, VAI_QUAN_LY, PHAM_VI_A], [ORG_B, NGOAI, VAI_CHU_B, PHAM_VI_B]];
  const quyenChu = ["shareholder_profit.distribute", "shareholder_profit.pay_manager", "shareholder_profit.lock", "shareholder_profit.unlock",
    "shareholder_profit.manage_shareholders", "income_expenses.approve"];
  const giuSo: [string, string, string][] = [[CHU, SO_QUY, "CUSTODIAN"], [CHU2, SO_QUY, "CUSTODIAN"], [GIU_SO, SO_GIU, "CUSTODIAN"],
    [TU_UNG, SO_TU, "CUSTODIAN"], [GIU_SO, SO_TU, "KNOWER"]];
  const coDong: [string, string, string | null, string, boolean, boolean][] = [
    [CD1, ORG_A, U_CD1, "Cổ đông 1", true, false], [CD2, ORG_A, U_CD2, "Cổ đông 2", true, false], [CD3, ORG_A, null, "Cổ đông 3", true, false],
    [CD_CHU, ORG_A, CHU, "Cổ đông là chủ", true, false], [CD_TU, ORG_A, TU_UNG, "Cổ đông giữ sổ", true, false],
    [CD_NGHI, ORG_A, null, "Cổ đông nghỉ", false, false], [CD_XOA, ORG_A, null, "Cổ đông đã xoá", true, true],
    [CD_B, ORG_B, NGOAI, "Cổ đông B", true, false], [CD_GO, ORG_A, U_GO, "Cổ đông bị gỡ quyền", true, false],
    [CD_XEM, ORG_A, U_XEM, "Cổ đông chỉ xem", true, false],
    [CD_R1, ORG_A, U_R1, "Cổ đông R1", true, false], [CD_R2, ORG_A, U_R2, "Cổ đông R2", true, false], [CD_R3, ORG_A, U_R3, "Cổ đông R3", true, false]];
  return `
    INSERT INTO public.organizations(id) VALUES ('${ORG_A}'),('${ORG_B}'),('${ORG_C}');
    INSERT INTO public.super_admins VALUES ('${SUPER}');
    INSERT INTO public.profiles(id, full_name) VALUES ('${CHU}','Chủ A'),('${GIU_SO}','Người giữ sổ'),('${NGOAI}','Chủ B');
    INSERT INTO public.permission_definitions(key, resource, action, sensitivity) VALUES
      ('shareholder_profit.distribute','shareholder_profit','distribute','ELEVATED'),
      ('shareholder_profit.pay_manager','shareholder_profit','pay_manager','ELEVATED'),
      ('shareholder_profit.lock','shareholder_profit','lock','ELEVATED'),
      ('shareholder_profit.unlock','shareholder_profit','unlock','ELEVATED'),
      ('shareholder_profit.manage_shareholders','shareholder_profit','manage_shareholders','MANAGE'),
      ('reports_finance.profit_distribution','reports_finance','profit_distribution','VIEW'),
      ('income_expenses.approve','income_expenses','approve','MANAGE');
    INSERT INTO public.organization_memberships(id, user_id, organization_id, valid_from) VALUES
      ${tvA.map((u) => `('${mem(u)}','${u}','${ORG_A}', now() - interval '1 year')`).join(",")},
      ('${mem(NGOAI)}','${NGOAI}','${ORG_B}', now() - interval '1 year');
    INSERT INTO public.authorization_scopes(id, organization_id, scope_type) VALUES ('${PHAM_VI_A}','${ORG_A}','ORGANIZATION'),('${PHAM_VI_B}','${ORG_B}','ORGANIZATION');
    INSERT INTO public.organization_roles(id, organization_id, name, is_system, system_key) VALUES
      ('${VAI_CHU_A}','${ORG_A}','Chủ sở hữu tổ chức',true,'TENANT_OWNER'), ('${VAI_CHU_B}','${ORG_B}','Chủ công ty',true,'TENANT_OWNER'),
      ('${VAI_XEM}','${ORG_A}','Cổ đông xem',false,NULL), ('${VAI_QUAN_LY}','${ORG_A}','Quản lý cổ đông',false,NULL);
    INSERT INTO public.role_permissions(organization_id, role_id, permission_key) VALUES
      ${quyenChu.map((k) => `('${ORG_A}','${VAI_CHU_A}','${k}'), ('${ORG_B}','${VAI_CHU_B}','${k}')`).join(",")},
      ('${ORG_A}','${VAI_XEM}','reports_finance.profit_distribution'), ('${ORG_A}','${VAI_QUAN_LY}','shareholder_profit.manage_shareholders');
    ${ganVai.map(([o, u, r, s], i) => `
      INSERT INTO public.role_bindings(id, organization_id, membership_id, role_id) VALUES ('${id(100 + i)}','${o}','${mem(u)}','${r}');
      INSERT INTO public.role_binding_scopes VALUES ('${o}','${id(100 + i)}','${s}');`).join("")}
    INSERT INTO public.buildings(id, organization_id, user_id, name, is_virtual) VALUES
      ('${TOA_AO}','${ORG_A}','${CHU}','Chung',true), ('${TOA_1}','${ORG_A}','${CHU}','Toà 1',false), ('${TOA_2}','${ORG_A}','${CHU}','Toà 2',false),
      ('${TOA_AO_B}','${ORG_B}','${NGOAI}','Chung B',true);
    INSERT INTO public.accounts(id, organization_id, user_id, name, is_virtual) VALUES
      ('${SO_QUY}','${ORG_A}','${CHU}','Tiền mặt',false), ('${SO_GIU}','${ORG_A}','${GIU_SO}','Sổ người giữ',false),
      ('${SO_TU}','${ORG_A}','${TU_UNG}','Sổ cổ đông giữ',false), ('${SO_AO}','${ORG_A}','${CHU}','Sổ ảo',true), ('${SO_B}','${ORG_B}','${NGOAI}','Tiền mặt B',false);
    INSERT INTO public.cashbook_possession_bindings(organization_id, membership_id, cashbook_id, possession_kind, valid_from) VALUES
      ${giuSo.map(([u, s, k]) => `('${ORG_A}','${mem(u)}','${s}','${k}', now() - interval '1 day')`).join(",")},
      ('${ORG_B}','${mem(NGOAI)}','${SO_B}','CUSTODIAN', now() - interval '1 day');
    INSERT INTO public.shareholders(id, organization_id, auth_user_id, name, is_active, deleted_at) VALUES
      ${coDong.map(([c, o, u, ten, hoatDong, xoa]) => `('${c}','${o}',${u ? `'${u}'` : "NULL"},'${ten}',${hoatDong},${xoa ? "now()" : "NULL"})`).join(",")};
    -- Hạng mục như production trước Đợt 1: chia_loi_nhuan ở hai công ty; công ty C không có.
    INSERT INTO public.income_expense_types(id, name, type, user_id, organization_id, category, is_restricted, force_approval, system_only,
        rule_key, manual_hidden, quick_entry_hidden, internal_transfer) VALUES
      ('${LOAI_CLN_A}','Chia lợi nhuận cổ đông','expense','${CHU}','${ORG_A}','Nhân sự – sale',true,true,false,'chia_loi_nhuan',false,true,true),
      ('${LOAI_VP_A}','Văn phòng','expense','${CHU}','${ORG_A}','Hành chính – pháp lý',false,false,false,'van_phong',false,false,false),
      ('${LOAI_CLN_B}','Chia lợi nhuận cổ đông','expense','${NGOAI}','${ORG_B}','Nhân sự – sale',true,true,false,'chia_loi_nhuan',false,true,true),
      ('${LOAI_VP_C}','Văn phòng','expense','${CHU}','${ORG_C}','Hành chính – pháp lý',false,false,false,'van_phong',false,false,false);
  `;
}
/** Ngoại lệ trên khoá quyền tạm ứng (khoá do M1 tạo): người được cấp, và một người đã bị thu hồi. */
const NGOAI_LE = (() => {
  const duocCap = [U_CD1, CHU, TU_UNG, U_R1, U_R2, U_R3];
  return `
    INSERT INTO public.member_permission_overrides(id, organization_id, membership_id, permission_key, effect, revoked_at) VALUES
      ${duocCap.map((u, i) => `('${id(201 + i)}','${ORG_A}','${mem(u)}','shareholder_profit.advance_own_cashbook','ALLOW',NULL)`).join(",")},
      ('${id(220)}','${ORG_A}','${mem(U_GO)}','shareholder_profit.advance_own_cashbook','ALLOW', now() - interval '1 day');
    INSERT INTO public.member_override_scopes VALUES
      ${duocCap.map((_, i) => `('${ORG_A}','${id(201 + i)}','${PHAM_VI_A}')`).join(",")}, ('${ORG_A}','${id(220)}','${PHAM_VI_A}');
  `;
})();

async function dungNen(d: PGlite) {
  await d.exec(NEN);
  await d.exec("SET check_function_bodies = off");
  for (const ten of Object.keys(MD5_PROD).filter((t) => !(t in MD5_TRUOC_VA))) await d.exec(thanTheoMd5(ten, MD5_PROD[ten]));
  for (const [ten, ma] of Object.entries(MD5_TRUOC_VA)) await d.exec(thanTheoMd5(ten, ma));
  await d.exec(VA_GHI_SO);
  for (const f of HAM_THEM) await d.exec(f);
  for (const f of THAN_CU_CUA_TAO) await d.exec(f);
  await d.exec(HAM_TEST);
  await d.exec("SET check_function_bodies = on");
  await d.exec(TRIGGER_NEN);
  await d.exec(duLieu());
  await d.exec(M1);
  await d.exec(NGOAI_LE);
  await d.exec(DOC);
  await d.exec(CHAN);
  await d.exec(TAO);
}

const db = new PGlite();
let nenTruocMigration: Blob;
const ghi: Record<string, unknown> = {};
let soKhoa = 0;
const khoa = (tien = "k") => `${tien}-${String(++soKhoa).padStart(6, "0")}`;

type Loi = { code: string; message: string; detail: string | null; hint: string | null };
const thanhLoi = (e: unknown): Loi => {
  const x = e as { code?: string; message?: string; detail?: string; hint?: string };
  return { code: x.code ?? "?", message: x.message ?? "", detail: x.detail ?? null, hint: x.hint ?? null };
};
async function giaoDich<T>(fn: () => Promise<T>): Promise<T> {
  await db.exec("BEGIN");
  try { return await fn(); } finally { await db.exec("ROLLBACK"); }
}
const mot = async <T>(sql: string) => (await db.query<{ v: T }>(sql)).rows[0]?.v as T;
/** Đặt người đang đăng nhập (auth.uid()) cho các câu chạy dưới vai chủ bảng — cách test phần chặn gọi RPC vòng đời V2. */
async function dangNhap(user: string | null) {
  await db.query("SELECT set_config('request.jwt.claim.sub', $1, true)", [user ?? ""]);
}
/** Gọi một RPC với auth.uid() = user, dưới vai authenticated (đo cả ACL); trả cột v. */
async function goi<T = Record<string, unknown>>(user: string | null, sql: string): Promise<T> {
  await dangNhap(user);
  await db.exec("SET LOCAL ROLE authenticated");
  try { return (await db.query<{ v: T }>(sql)).rows[0].v; } finally { await db.exec("RESET ROLE"); }
}
/** Như goi() nhưng chờ lỗi: chạy trong SAVEPOINT, trả mã + câu + DETAIL (null nếu chạy được). */
async function loiGoi(user: string | null, sql: string, vai = "authenticated"): Promise<Loi | null> {
  await dangNhap(user);
  await db.exec(`SAVEPOINT thu; SET LOCAL ROLE ${vai}`);
  try {
    await db.query(sql);
    await db.exec("RESET ROLE; RELEASE SAVEPOINT thu");
    return null;
  } catch (e) {
    await db.exec("ROLLBACK TO SAVEPOINT thu; RESET ROLE");
    return thanhLoi(e);
  }
}
/** Câu (có thể nhiều lệnh) chạy dưới vai chủ bảng, chờ lỗi. */
async function loi(sql: string): Promise<Loi | null> {
  await db.exec("SAVEPOINT thu");
  try { await db.exec(sql); await db.exec("RELEASE SAVEPOINT thu"); return null; } catch (e) {
    await db.exec("ROLLBACK TO SAVEPOINT thu");
    return thanhLoi(e);
  }
}
/** Lỗi phải có đúng SQLSTATE và mã máy đọc được ở đầu MESSAGE. */
function laLoi(l: Loi | null, code: string, ma: string): Loi {
  expect(l, `phải chặn: ${code} ${ma}`).not.toBeNull();
  expect(`${l?.code} ${l?.message}`).toContain(`${code} ${ma}`);
  return l as Loi;
}
const chiTiet = (l: Loi | null) => JSON.parse(l?.detail ?? "{}") as Record<string, unknown>;
type Route = "LEGACY" | "SHADOW" | "CANONICAL" | "FROZEN";
async function datRoute(r: Route) {
  const [mode, dong] = r === "LEGACY" ? ["OFF", false] : r === "SHADOW" ? ["SHADOW", false] : r === "CANONICAL" ? ["ON", false] : ["ON", true];
  await db.exec(`UPDATE app_private.server_feature_flags SET mode = '${mode}', force_freeze = ${dong}, commit_sha = '${"a".repeat(40)}',
    migration_sha256 = '${"b".repeat(64)}', maintenance_window_id = 'mw-test', approval_reference = 'ref-test' WHERE feature_key = '${CO}'`);
}
const q = (x: string | null | undefined) => (x === null || x === undefined ? "NULL" : `'${x}'`);
const dem = (bang: string, dk = "true") => mot<number>(`SELECT count(*)::int AS v FROM ${bang} WHERE ${dk}`);
interface AnhHam { md5: string; acl: string | null; chu: string; cfg: string[] | null; vol: string; definer: boolean; mo_ta: string }
/** Ảnh chụp mọi hàm public / app_private / auth (theo chữ ký): md5 thân, ACL, chủ hàm, cấu hình, volatility, DEFINER, md5 COMMENT. */
const chupHam = async (d: PGlite = db) => Object.fromEntries((await d.query<{ k: string; v: AnhHam }>(`
  SELECT n.nspname || '.' || p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')' AS k,
         jsonb_build_object('md5', md5(replace(p.prosrc, chr(13), '')), 'acl', p.proacl::text, 'chu', p.proowner::regrole::text,
           'cfg', p.proconfig, 'vol', p.provolatile, 'definer', p.prosecdef,
           'mo_ta', md5(COALESCE(obj_description(p.oid, 'pg_proc'), ''))) AS v
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname IN ('public', 'app_private', 'auth')`)).rows.map((r) => [r.k, r.v])) as Record<string, AnhHam>;
const md5E6 = (d: PGlite = db) => d.query<{ v: string }>(`SELECT md5(replace(p.prosrc, chr(13), '')) AS v FROM pg_proc p
  WHERE p.oid = to_regprocedure('${E6}(uuid,text,text,text)')`).then((r) => r.rows[0]?.v ?? null);

// ── Lời gọi các lệnh của migration ───────────────────────────────────────────
interface Ung { cd?: string; tien: number | string; so?: string | null; ngay?: string | null; ghiChu?: string | null; khoa?: string }
const w1 = (o: Ung) => `SELECT public.shareholder_profit_advance_v1(${q(o.cd ?? CD1)}, ${o.tien}, ${o.so === null ? "NULL" : q(o.so ?? SO_GIU)},
  ${o.ngay === null ? "NULL" : q(o.ngay ?? NGAY)}, ${q(o.ghiChu)}, '${o.khoa ?? khoa("ung")}') AS v`;
const r4 = (cd: string, tien: number | string | null, so: string | null) =>
  `SELECT public.shareholder_profit_advance_preview_v1('${cd}', ${tien ?? "NULL"}, ${q(so)}) AS v`;
const r3 = (org = ORG_A) => `SELECT public.shareholder_profit_advance_options_v1('${org}') AS v`;
const r1 = (org = ORG_A) => `SELECT public.shareholder_profit_positions_v1('${org}') AS v`;
const r2 = (org = ORG_A) => `SELECT public.shareholder_profit_my_position_v1('${org}') AS v`;
const r5 = (cd: string, thang: string | null = null, so: string | null = SO_QUY) =>
  `SELECT public.shareholder_profit_settlement_preview_v1('${cd}', ${q(thang)}, ${q(so)}) AS v`;
/** Lệnh chốt gửi HAI số chủ đã xem: `tien` = tiền thực chi, và phần ghi nhận X. Ca thử khai `k` = phần khấu trừ tạm ứng đã xem
 *  (mặc định 0) ⇒ X kỳ vọng = tien + k. Truyền `x` khi cần một số ghi nhận kỳ vọng riêng (ca lỗi đầu vào; ca tiền 0 mà không
 *  khấu trừ gì thì X = 0 không hợp lệ ở đầu vào). */
interface Chot { cd?: string; thang: string | null; so?: string | null; ngay?: string | null; ghiChu?: string | null;
  tien: number | string | null; k?: number; x?: number | string | null; khoa?: string }
const ghiNhanKyVong = (o: Chot) => (o.x !== undefined ? o.x : typeof o.tien === "number" ? o.tien + (o.k ?? 0) : o.tien);
const w2 = (o: Chot) => `SELECT public.shareholder_profit_settle_v1(${q(o.cd ?? CD1)}, ${q(o.thang)}, ${o.so === null ? "NULL" : q(o.so ?? SO_QUY)},
  ${o.ngay === null ? "NULL" : q(o.ngay ?? NGAY)}, ${q(o.ghiChu)}, ${ghiNhanKyVong(o) ?? "NULL"}, ${o.tien ?? "NULL"}, '${o.khoa ?? khoa("chot")}') AS v`;
const w3 = (banGhi: string, lyDo = "Chốt nhầm tháng cần làm lại", k = khoa("huychot")) =>
  `SELECT public.shareholder_profit_settlement_void_v1('${banGhi}', ${q(lyDo)}, '${k}') AS v`;
const e5 = (cd: string, tien: number, tamUng: boolean, so = SO_QUY) =>
  `SELECT public.shareholder_profit_ledger_payout_v1('${cd}', ${tien}, '${so}', '${NGAY}', NULL, ${tamUng}, '${khoa("e5")}') AS v`;
const e4 = (cd: string, tien: number | null, so: string | null) =>
  `SELECT public.shareholder_profit_payout_preview_v1('${cd}', ${tien ?? "NULL"}, ${q(so)}) AS v`;
/** E5 đã thu quyền của authenticated (20261118171708): phiếu E5 "cũ" (lập trước khi thu quyền) dựng bằng vai chủ hàm, với
 *  auth.uid() = người lập. Thân E5 là SECURITY DEFINER nên chạy y hệt lời gọi dưới vai authenticated trước đây — chỉ khác
 *  cửa ACL ở đầu lời gọi. */
async function e5Cu<T = KqUng>(user: string, sql: string): Promise<T> {
  await dangNhap(user);
  return (await db.query<{ v: T }>(sql)).rows[0].v;
}
const e9 = (cd: string, thang: string | null, cu: string | null) =>
  `SELECT public.profit_ledger_set_marker_v1('${ORG_A}','SHAREHOLDER','${cd}', ${q(thang)}, 'Đã trả đủ theo sổ tay', ${q(cu)}, true, '${khoa("moc")}') AS v`;

interface KqUng { voucher_id: string; approval_request_id: string; maker_kind: string; balance_before: number | null; warnings: { code: string }[];
  amount: number; within_amount: number; advance_amount: number; payout_kind: string; state: string }
interface KqChot { settlement_id: string; through_month: string; recognized_amount: number; advance_offset_amount: number; cash_amount: number;
  voucher_id: string | null; approval_request_id: string | null; state: string }
interface ViThe { unpaid_profit: number; advance_outstanding: number; advance_pending: number; settlement_cash_pending: number; balance: number;
  settled: { recognized: number; offset: number; cash: number }; last_settled_through_month: string | null; marker_month: string | null;
  needs_review: { count: number; suggested: number };
  components: { allocated: number; salary_investment: number; salary_advance_offset: number; payouts_approved: number; payouts_pending: number;
    unpaid_profit_raw: number; advance_outstanding_raw: number; advance_overoffset: number } }
const viThe = (cd: string, org = ORG_A) => mot<ViThe>(`SELECT app_private.profit_ledger_position_v1('${org}','${cd}') AS v`);
/** [A lợi nhuận chưa chi, B tạm ứng đã duyệt, tạm ứng chờ duyệt, tiền chốt chờ duyệt, số dư ròng]. */
const ab = async (cd: string) => {
  const v = await viThe(cd);
  return [v.unpaid_profit, v.advance_outstanding, v.advance_pending, v.settlement_cash_pending, v.balance].map(Number);
};
const soDuRong = async (cd: string) => Number(await mot<string>(`SELECT app_private.profit_ledger_balance_v1('${ORG_A}','SHAREHOLDER','${cd}') ->> 'balance' AS v`));
const phieu = (p: string) => db.query<Record<string, unknown>>(`SELECT * FROM public.income_expenses WHERE id = '${p}'`).then((r) => r.rows[0]);
const dongSo = (p: string) => db.query<Record<string, unknown>>(`SELECT * FROM app_private.profit_ledger_payouts WHERE voucher_id = '${p}'`).then((r) => r.rows[0]);
const banGhiChot = (s: string) => db.query<Record<string, unknown>>(`SELECT * FROM app_private.profit_ledger_payout_settlements WHERE id = '${s}'`).then((r) => r.rows[0]);
const mocHieuLuc = async (cd: string) =>
  (await db.query<{ v: string }>(`SELECT marker_id AS v FROM app_private.profit_ledger_active_marker_v1('${ORG_A}','SHAREHOLDER','${cd}')`)).rows[0]?.v ?? null;

/** Chốt lợi nhuận một tháng của một toà với phần của từng cổ đông (chèn hoặc đổi số). */
async function chotThang(thang: string, toa: string, phanBo: Record<string, number>, trangThai: "LOCKED" | "DRAFT" = "LOCKED") {
  const pm = (await db.query<{ id: string }>(`INSERT INTO public.profit_monthly(organization_id, building_id, period_month, status, locked_at)
    VALUES ('${ORG_A}','${toa}','${thang}','${trangThai}', now())
    ON CONFLICT (building_id, period_month) DO UPDATE SET status = EXCLUDED.status RETURNING id`)).rows[0].id;
  for (const [cd, tien] of Object.entries(phanBo)) {
    await db.exec(`INSERT INTO public.profit_allocations(profit_monthly_id, shareholder_id, amount, organization_id) VALUES ('${pm}','${cd}', ${tien}, '${ORG_A}')
      ON CONFLICT (profit_monthly_id, shareholder_id) DO UPDATE SET amount = EXCLUDED.amount`);
  }
  return pm;
}
/** Giả lập "phiếu lập ở giao dịch trước" (assert_committed_birth_boundary_v2): birth_txid giả, đặt trong ngữ cảnh LẬP. */
async function giaSinhTruoc(p: string) {
  await db.exec(`INSERT INTO app_private.profit_ledger_write_contexts(income_expense_id, purpose) VALUES ('${p}', 'CREATE');
    UPDATE public.income_expenses SET birth_txid = '1'::xid8 WHERE id = '${p}';
    DELETE FROM app_private.profit_ledger_write_contexts WHERE income_expense_id = '${p}';`);
}
const sqlDuyet = (p: string) =>
  `SELECT public.approve_income_expense_v2('${p}', (SELECT approval_version FROM public.income_expenses WHERE id = '${p}'), '${khoa("duyet")}')`;
const sqlGhiSo = (p: string, so: string) => `SELECT public.post_approved_income_expense_v2(jsonb_build_object(
  'subjectId', '${p}', 'cashbookId', '${so}', 'postedOn', '2026-11-12', 'idempotencyKey', '${khoa("ghiso")}',
  'expectedApprovalVersion', (SELECT approval_version FROM public.income_expenses WHERE id = '${p}'),
  'expectedPostingVersion', (SELECT posting_version FROM public.income_expenses WHERE id = '${p}'),
  'evidenceIds', jsonb_build_array(public.test_chung_tu('${ORG_A}'))))`;
/** Duyệt bằng RPC thật approve_income_expense_v2 (qua F1). */
async function duyet(p: string, user: string): Promise<Loi | null> {
  await giaSinhTruoc(p);
  await dangNhap(user);
  return loi(sqlDuyet(p));
}
/** Ghi sổ bằng RPC thật post_approved_income_expense_v2 (qua F1). */
async function ghiSo(p: string, user: string, so: string): Promise<Loi | null> {
  await dangNhap(user);
  return loi(sqlGhiSo(p, so));
}
/** Từ chối yêu cầu duyệt bằng RPC thật decide_financial_request_v2 (qua F5). */
async function tuChoi(yeuCau: string, user: string): Promise<Loi | null> {
  await dangNhap(user);
  return loi(`SELECT public.decide_financial_request_v2('${yeuCau}', 'REJECT', 'Sai số tiền cần lập lại')`);
}
/** Huỷ phiếu bằng lệnh huỷ E6 của Đợt 1. */
async function huyPhieu(p: string, user: string, kyVong: string): Promise<Loi | null> {
  await dangNhap(user);
  return loi(`SELECT public.profit_ledger_payout_cancel_v1('${p}', 'Lý do huỷ đủ tám ký tự', '${khoa("huy")}', '${kyVong}')`);
}
/** Lập phiếu tạm ứng (người giữ sổ lập hộ, mặc định cho CD1 từ SO_GIU) rồi chủ thứ hai duyệt. */
async function ungDaDuyet(tien: number, o: Partial<Ung> & { nguoiLap?: string; nguoiDuyet?: string } = {}): Promise<KqUng> {
  const kq = await goi<KqUng>(o.nguoiLap ?? GIU_SO, w1({ ...o, tien }));
  expect(await duyet(kq.voucher_id, o.nguoiDuyet ?? CHU2)).toBeNull();
  return kq;
}
/** Phiếu chi thường (không thuộc sổ tổng) chờ duyệt — làm phiếu lương cho dòng lương của sổ. */
async function taoPhieuThuong(p: string, tien: number) {
  await db.exec(`INSERT INTO public.income_expenses(id, user_id, organization_id, type, name, building_id, voucher_date, total_amount, account_id, approval_status)
    VALUES ('${p}','${CHU}','${ORG_A}','EXPENSE','Phiếu lương','${TOA_1}','2026-10-31', ${tien}, '${SO_QUY}', 'UNAPPROVED')`);
}
/** Dòng lương của sổ (C4) gắn một phiếu lương còn sống: Y = phần lợi nhuận trả qua lương, D = phần trừ tạm ứng. */
async function dongLuong(o: { cd: string; thang: string; y: number; d?: number; trangThai?: "LINKED" | "NEEDS_REVIEW"; phieu: string }) {
  await taoPhieuThuong(o.phieu, 100);
  const lk = (o.trangThai ?? "LINKED") === "LINKED";
  await db.exec(`INSERT INTO app_private.profit_ledger_salary_settlement_vouchers(organization_id, shareholder_id, staff_id, period_month, salary_voucher_id,
      investment_amount, advance_offset_amount, suggested_investment, sheet_status_at_quote, source, state, linked_at)
    VALUES ('${ORG_A}','${o.cd}','${CHU}','${o.thang}','${o.phieu}', ${o.y}, ${o.d ?? 0}, ${lk ? "NULL" : o.y}, 'LOCKED','PAYOUT_FALLBACK',
      '${lk ? "LINKED" : "NEEDS_REVIEW"}', ${lk ? "clock_timestamp()" : "NULL"})`);
}

beforeAll(async () => {
  await dungNen(db);
  // Ba ca kiểm COMMIT và ROLLBACK cần database riêng từ đúng trạng thái trước migration.
  nenTruocMigration = await db.dumpDataDir("none");
  ghi.rangBuocTruoc = await mot<string>(`SELECT pg_get_constraintdef(c.oid) AS v FROM pg_constraint c
    WHERE c.conrelid = 'app_private.profit_ledger_payouts'::regclass AND c.conname = 'profit_ledger_payouts_maker_kind_check'`);
  ghi.md5E5Truoc = await mot<string>(`SELECT md5(replace(p.prosrc, chr(13), '')) AS v FROM pg_proc p
    WHERE p.oid = 'public.shareholder_profit_ledger_payout_v1(uuid,numeric,uuid,date,text,boolean,text)'::regprocedure`);
  await db.exec(MIGRATION);
  const chup = `SELECT jsonb_build_object(
    'loai', (SELECT jsonb_agg(jsonb_build_array(t.id, t.xmin::text) ORDER BY t.id) FROM public.income_expense_types t WHERE t.rule_key = 'tam_ung_co_dong'),
    'rang_buoc', (SELECT jsonb_agg(jsonb_build_array(c.conname, c.oid::text) ORDER BY c.conname) FROM pg_constraint c
                   WHERE c.conrelid IN ('app_private.profit_ledger_payouts'::regclass, 'app_private.profit_ledger_payout_settlements'::regclass)),
    'trigger', (SELECT count(*) FROM pg_trigger t WHERE t.tgrelid = 'app_private.profit_ledger_payout_settlements'::regclass AND NOT t.tgisinternal)) AS v`;
  ghi.luot1 = await mot<unknown>(chup);
  await db.exec(MIGRATION);
  ghi.luot2 = await mot<unknown>(chup);
  // Migration sau: E6 che balance_after — hai lượt, chụp mọi hàm trước / sau từng lượt.
  ghi.hamTruocHuyChe = await chupHam();
  await db.exec(HUY_CHE);
  ghi.hamHuyChe1 = await chupHam();
  await db.exec(HUY_CHE);
  ghi.hamHuyChe2 = await chupHam();
  // Migration dọn dẹp (20261118171708) — hai lượt, chụp mọi hàm trước / sau từng lượt. Mọi ca bên dưới chạy trên trạng thái
  // SAU file này.
  ghi.hamTruocDonDep = await chupHam();
  await db.exec(DON_DEP);
  ghi.hamDonDep1 = await chupHam();
  await db.exec(DON_DEP);
  ghi.hamDonDep2 = await chupHam();
  await datRoute("CANONICAL");
}, 300000);
afterAll(() => db.close());

const RPC: [string, string][] = [
  ["public.shareholder_profit_positions_v1(uuid)", "v"],
  ["public.shareholder_profit_my_position_v1(uuid)", "s"],
  ["public.shareholder_profit_advance_options_v1(uuid)", "v"],
  ["public.shareholder_profit_advance_preview_v1(uuid,numeric,uuid)", "v"],
  ["public.shareholder_profit_advance_v1(uuid,numeric,uuid,date,text,text)", "v"],
  ["public.shareholder_profit_settlement_preview_v1(uuid,date,uuid)", "s"],
  ["public.shareholder_profit_settle_v1(uuid,date,uuid,date,text,numeric,numeric,text)", "v"],
  ["public.shareholder_profit_settlement_void_v1(uuid,text,text)", "v"],
];
const NOI_BO: [string, string][] = [
  ["app_private.guard_profit_ledger_payout_settlement_v1()", "v"],
  ["app_private.guard_profit_ledger_marker_settlement_v1()", "v"],
  ["app_private.profit_ledger_settlement_live_v1(uuid)", "s"],
  ["app_private.profit_ledger_position_v1(uuid,uuid)", "s"],
  ["app_private.profit_ledger_unpaid_through_v1(uuid,uuid,date)", "s"],
  ["app_private.profit_ledger_chot_months_v1(uuid,uuid)", "s"],
  ["app_private.profit_ledger_chot_rows_v1(uuid,uuid)", "s"],
  ["app_private.profit_ledger_chot_advance_right_v1(uuid,uuid)", "v"],
  ["app_private.profit_ledger_chot_holds_cashbook_v1(uuid,uuid,uuid)", "s"],
  ["app_private.profit_ledger_chot_hang_muc_v1(uuid,uuid,text)", "v"],
  ["app_private.profit_ledger_chot_assert_ngay_v1(uuid,uuid,date)", "s"],
  ["app_private.profit_ledger_chot_lap_phieu_v1(uuid,uuid,uuid,uuid,uuid,uuid,numeric,date,text,text,uuid,text,text,uuid,uuid,text,uuid,bigint,numeric,numeric,numeric,numeric,jsonb,jsonb)", "v"],
];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const C7 = "app_private.profit_ledger_payout_settlements";

describe("khung thử: nền Đợt 1 thật và hai lượt migration", () => {
  it("RPC vòng đời V2, cầu a85 và hàm quyền nạp vào đúng thân production (md5); công tắc đang CANONICAL", async () => {
    const r = (await db.query<{ ten: string; m: string }>(`
      SELECT n.nspname || '.' || p.proname AS ten, md5(replace(p.prosrc, chr(13), '')) AS m
        FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname || '.' || p.proname = ANY($1)`, [Object.keys(MD5_PROD)])).rows;
    expect(Object.fromEntries(r.map((x) => [x.ten, x.m]))).toEqual(MD5_PROD);
    expect(await mot<string>(`SELECT app_private.evaluate_feature_route('${CO}', '${ORG_A}') AS v`)).toBe("CANONICAL");
  });
  it("[ghim] lệnh lập tạm ứng dựng từ thân E5 đang là định nghĩa CUỐI trong migrations; migration không đổi E5 và không định nghĩa lại hàm nào đã có", async () => {
    expect(md5(dinhNghiaCuoi("public.shareholder_profit_ledger_payout_v1").body)).toBe(MD5_E5_GOC);
    expect(ghi.md5E5Truoc).toBe(MD5_E5_GOC);
    expect(await mot<string>(`SELECT md5(replace(p.prosrc, chr(13), '')) AS v FROM pg_proc p
      WHERE p.oid = 'public.shareholder_profit_ledger_payout_v1(uuid,numeric,uuid,date,text,boolean,text)'::regprocedure`)).toBe(MD5_E5_GOC);
    const ten = [...new Set([...MIGRATION.matchAll(/CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+([a-z_]+\.[a-z0-9_]+)\s*\(/gi)].map((m) => m[1].toLowerCase()))];
    expect(ten.sort()).toEqual([...RPC, ...NOI_BO].map(([h]) => h.slice(0, h.indexOf("("))).sort());
    const file = FILE.slice(FILE.lastIndexOf("/") + 1);
    // Ghim toàn bộ chuỗi của từng hàm. Dọn dẹp bọc R4; sổ quỹ tích hợp quyền lợi vào vị thế và tháng chốt.
    const keTiep: Record<string, string> = {
      [R4]: TEN_DON_DEP,
      "app_private.profit_ledger_position_v1": TEN_SO_QUY,
      "app_private.profit_ledger_chot_months_v1": TEN_SO_QUY,
      "app_private.profit_ledger_unpaid_through_v1": TEN_SO_QUY,
    };
    for (const t of ten) {
      const files = (DINH_NGHIA.get(t) ?? []).map((definition) => definition.file);
      expect(files, t).toEqual(keTiep[t] ? [file, keTiep[t]] : [file]);
    }
    // Không lệnh DDL nào chạm đối tượng cũ ngoài hai ngoại lệ đã khai ở đầu file: CHECK maker_kind của dòng sổ phiếu chi, và MỘT
    // trigger mới trên bảng mốc (DROP … IF EXISTS của chính trigger đó để chạy lại được).
    expect(MIGRATION.match(/^\s*(ALTER TABLE|DROP (?!TRIGGER IF EXISTS a00_profit_ledger_payout_settlements)\w+|ALTER FUNCTION)[^\n]*/gim)?.map((x) => x.trim()))
      .toEqual(["ALTER TABLE app_private.profit_ledger_payouts", "ALTER TABLE app_private.profit_ledger_payouts",
        "ALTER TABLE app_private.profit_ledger_payout_settlements ENABLE ROW LEVEL SECURITY;",
        "DROP TRIGGER IF EXISTS a10_profit_ledger_markers_settlement_guard ON app_private.profit_ledger_markers;"]);
    expect(MIGRATION.match(/^\s*CREATE TRIGGER \w+\s+BEFORE [A-Z ]+ ON (?!app_private\.profit_ledger_payout_settlements)[^\n]*/gim)?.map((x) => x.replace(/\s+/g, " ").trim()))
      .toEqual(["CREATE TRIGGER a10_profit_ledger_markers_settlement_guard BEFORE INSERT ON app_private.profit_ledger_markers"]);
  });
  it("lượt chạy lại không ghi lại hạng mục, ràng buộc, trigger (xmin / oid giữ nguyên)", () => {
    expect(ghi.luot2).toEqual(ghi.luot1);
    expect((ghi.luot1 as { trigger: number }).trigger).toBe(3);
    expect((ghi.luot1 as { loai: unknown[] }).loai).toHaveLength(2);
  });
  it("chạy như lane: dán thân HAI lần trong MỘT giao dịch trên nền chưa áp rồi ROLLBACK ⇒ không để lại gì; COMMIT một lượt ⇒ đủ đối tượng", async () => {
    const lan = new PGlite({ loadDataDir: nenTruocMigration });
    try {
      expect(THAN).not.toMatch(/^(BEGIN|COMMIT);/m);
      await lan.exec(`BEGIN; ${THAN} ${THAN} ROLLBACK;`);
      const con = async () => (await lan.query<{ v: unknown }>(`SELECT jsonb_build_object(
        'bang', to_regclass('${C7}') IS NOT NULL,
        'rpc', to_regprocedure('public.shareholder_profit_settle_v1(uuid,date,uuid,date,text,numeric,numeric,text)') IS NOT NULL,
        'check', (SELECT pg_get_constraintdef(c.oid) FROM pg_constraint c WHERE c.conname = 'profit_ledger_payouts_maker_kind_check'),
        'loai', (SELECT count(*) FROM public.income_expense_types WHERE rule_key = 'tam_ung_co_dong')) AS v`)).rows[0].v;
      expect(await con()).toEqual({ bang: false, rpc: false, check: ghi.rangBuocTruoc, loai: 0 });
      await lan.exec(MIGRATION);
      expect(await con()).toMatchObject({ bang: true, rpc: true, loai: 2 });
    } finally { await lan.close(); }
  }, 300000);
  it("thiếu nền Đợt 1 ⇒ dừng 55000, nêu rõ thứ thiếu (DB trần; thiếu chốt F1; thiếu khoá quyền tạm ứng)", async () => {
    const tran = new PGlite();
    try {
      await tran.exec("CREATE ROLE authenticated; CREATE ROLE anon; CREATE ROLE service_role;");
      const l = await tran.exec(MIGRATION).then(() => null, thanhLoi);
      expect(l).toMatchObject({ code: "55000", message: expect.stringMatching(/^Thiếu hàm nền của sổ tổng lợi nhuận \(Đợt 1 phải áp trước\): .*profit_ledger_balance_v1/) });
    } finally { await tran.close(); }
    await giaoDich(async () => {
      await db.exec("DROP TRIGGER a06_profit_ledger_payout_guard ON public.income_expenses");
      expect(await loi(THAN)).toMatchObject({ code: "55000", message: "Thiếu chốt chặn của sổ tổng (Đợt 1): a06_profit_ledger_payout_guard" });
    });
    // Chốt sẵn có của bảng mốc (trigger mới của file này chạy sau nó, dựa vào việc nó đã bắt giữ khoá sổ).
    await giaoDich(async () => {
      await db.exec("DROP TRIGGER a00_profit_ledger_markers_guard ON app_private.profit_ledger_markers");
      expect(await loi(THAN)).toMatchObject({ code: "55000", message: "Thiếu chốt chặn của sổ tổng (Đợt 1): a00_profit_ledger_markers_guard" });
    });
    await giaoDich(async () => {
      await db.exec(`DELETE FROM public.member_override_scopes; DELETE FROM public.member_permission_overrides;
        DELETE FROM public.permission_definitions WHERE key = 'shareholder_profit.advance_own_cashbook'`);
      expect(await loi(THAN)).toMatchObject({ code: "55000", message: expect.stringContaining("Thiếu nền sổ tổng") });
    });
  }, 300000);
  it("công ty đã có hạng mục CHI trùng tên 'Tạm Ứng' (khác hoa thường / dấu) mà không mang rule_key ⇒ dừng 55000, không tự chiếm hạng mục đó", async () => {
    await giaoDich(async () => {
      await db.exec(`INSERT INTO public.income_expense_types(name, type, user_id, organization_id, rule_key, force_approval) VALUES
        ('Chia lợi nhuận cổ đông','expense','${CHU}','${ORG_C}','chia_loi_nhuan', true), ('TẠM  ứng','expense','${CHU}','${ORG_C}', NULL, false)`);
      const l = await loi(THAN);
      expect(l).toMatchObject({ code: "55000", message: expect.stringContaining('trùng tên "Tạm Ứng"') });
      expect(l?.message).toContain(ORG_C);
      // Hạng mục THU trùng tên thì không cản (chỉ mục khác chiều).
      await db.exec(`UPDATE public.income_expense_types SET type = 'income' WHERE organization_id = '${ORG_C}' AND rule_key IS NULL AND name = 'TẠM  ứng'`);
      expect(await loi(THAN)).toBeNull();
      expect(await dem("public.income_expense_types", `organization_id = '${ORG_C}' AND rule_key = 'tam_ung_co_dong'`)).toBe(1);
    });
  });
});

describe("hình dạng, quyền gọi và volatility", () => {
  const quyen = (ham: string) => db.query<{ a: boolean; n: boolean; s: boolean; p: boolean; v: string; d: boolean; cfg: string[] | null; nd: number; ret: string }>(`
    SELECT has_function_privilege('authenticated', p.oid, 'EXECUTE') a, has_function_privilege('anon', p.oid, 'EXECUTE') n,
           has_function_privilege('service_role', p.oid, 'EXECUTE') s,
           EXISTS (SELECT 1 FROM aclexplode(p.proacl) x WHERE x.grantee = 0) p, p.provolatile v, p.prosecdef d, p.proconfig cfg,
           p.pronargdefaults nd, p.prorettype::regtype::text ret
      FROM pg_proc p WHERE p.oid = to_regprocedure($1)`, [ham]).then((r) => r.rows[0]);
  it("tám RPC: DEFINER, ghim search_path, không DEFAULT, trả jsonb, đúng volatility, chỉ authenticated gọi được (không anon, PUBLIC, service_role)", async () => {
    for (const [ham, vol] of RPC) {
      expect(await quyen(ham), ham).toEqual({ a: true, n: false, s: false, p: false, v: vol, d: true,
        cfg: ["search_path=pg_catalog, app_private, public"], nd: 0, ret: "jsonb" });
    }
    // Gọi thật bằng anon / service_role (kể cả khi có claim của chủ) ⇒ 42501 từ ACL, chưa vào thân hàm.
    await giaoDich(async () => {
      await chotThang("2026-09-01", TOA_1, { [CD1]: 100 });
      const truoc = await dem("public.income_expenses");
      for (const vai of ["anon", "service_role"]) {
        for (const sql of [r1(), r2(), r3(), r4(CD1, 10, SO_QUY), w1({ cd: CD_CHU, tien: 10, so: SO_QUY }), r5(CD1),
          w2({ thang: "2026-09-01", tien: 100 }), w3(id(1))]) {
          const l = await loiGoi(CHU, sql, vai);
          expect(l, `${vai}: ${sql.slice(14, 60)}`).toMatchObject({ code: "42501", message: expect.stringContaining("permission denied for function") });
        }
      }
      expect(await dem("public.income_expenses")).toBe(truoc);
      expect(await dem(C7)).toBe(0);
    });
  });
  it("hàm nội bộ và hàm trigger: đúng volatility, không vai nào gọi được; authenticated gọi thẳng bị 42501 kể cả khi được cấp USAGE trên schema", async () => {
    for (const [ham, vol] of NOI_BO) expect(await quyen(ham), ham).toMatchObject({ a: false, n: false, s: false, p: false, v: vol });
    await giaoDich(async () => {
      expect((await loiGoi(CHU, `SELECT app_private.profit_ledger_position_v1('${ORG_A}','${CD1}') AS v`))?.code).toBe("42501");
      await db.exec("GRANT USAGE ON SCHEMA app_private TO authenticated");
      for (const sql of [`SELECT app_private.profit_ledger_position_v1('${ORG_A}','${CD1}')`,
        `SELECT app_private.profit_ledger_chot_advance_right_v1('${ORG_A}','${U_CD1}')`,
        `SELECT app_private.profit_ledger_chot_hang_muc_v1('${ORG_A}','${CHU}','tam_ung_co_dong')`,
        `SELECT app_private.profit_ledger_settlement_live_v1('${id(1)}')`, `SELECT * FROM ${C7}`,
        `INSERT INTO ${C7}(organization_id, shareholder_id, through_month, recognized_amount, advance_offset_amount, cash_amount, unpaid_before, advance_before, ledger_seq, created_by)
           VALUES ('${ORG_A}','${CD1}','2026-09-01', 1, 1, 0, 1, 1, 1, '${CHU}')`]) {
        expect((await loiGoi(CHU, sql))?.code, sql.slice(0, 70)).toBe("42501");
      }
    });
  });
  it("bảng bản ghi chốt: RLS bật, không policy, không vai nào có quyền; ba trigger đúng chỗ", async () => {
    expect(await mot(`SELECT jsonb_build_object('rls', c.relrowsecurity, 'policy', (SELECT count(*) FROM pg_policy p WHERE p.polrelid = c.oid),
      'acl', (SELECT count(*) FROM aclexplode(c.relacl) a WHERE a.grantee <> c.relowner)) AS v FROM pg_class c WHERE c.oid = '${C7}'::regclass`))
      .toEqual({ rls: true, policy: 0, acl: 0 });
    const tg = (await db.query<{ ten: string; def: string }>(`SELECT t.tgname AS ten, pg_get_triggerdef(t.oid) AS def FROM pg_trigger t
      WHERE t.tgrelid = '${C7}'::regclass AND NOT t.tgisinternal ORDER BY 1`)).rows;
    expect(tg.map((x) => x.ten)).toEqual(["a00_profit_ledger_payout_settlements_guard", "a00_profit_ledger_payout_settlements_no_delete",
      "a00_profit_ledger_payout_settlements_no_truncate"]);
    expect(tg[0].def).toContain("BEFORE INSERT OR UPDATE ON app_private.profit_ledger_payout_settlements FOR EACH ROW EXECUTE FUNCTION app_private.guard_profit_ledger_payout_settlement_v1()");
    expect(tg[1].def).toContain("BEFORE DELETE");
    expect(tg[2].def).toContain("BEFORE TRUNCATE");
  });
  it("không hàm nào file này ghi tự ném mã lớp 40; so-rồi-ghi của lệnh chốt dùng PT409, đúng một chỗ", async () => {
    const ten = [...RPC, ...NOI_BO].map(([h]) => h.slice(0, h.indexOf("(")));
    const r = (await db.query<{ ten: string; than: string; mo_ta: string | null }>(`
      SELECT n.nspname || '.' || p.proname AS ten, p.prosrc AS than, obj_description(p.oid, 'pg_proc') AS mo_ta
        FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname || '.' || p.proname = ANY($1::text[])`, [ten])).rows;
    expect(r.map((x) => x.ten).sort()).toEqual([...ten].sort());
    const MA_LOP_40 = /'40001'|'40P01'|'40\d{3}'|\bserialization_failure\b|\bdeadlock_detected\b|\bSQLSTATE\s+'40/i;
    for (const x of r) {
      expect(x.than.replace(/--[^\n]*/g, " "), x.ten).not.toMatch(MA_LOP_40);
      expect(x.mo_ta ?? "", `COMMENT ${x.ten}`).not.toMatch(/40001|40P01/);
    }
    expect(MIGRATION.split("USING ERRCODE = 'PT409'").length - 1).toBe(1);
  });
  it("RPC đọc STABLE (cổ đông tự xem, xem trước chốt) không nằm trong bao đóng khoá dòng mà gate stable-fn-locks dò; ba RPC đọc phải kiểm quyền người khác thì VOLATILE", async () => {
    // Cùng luật với scripts/lib/stable-fn-locks-sql.mjs (4 tầng, theo tên), chạy trên catalog của test — có hàm khoá thật.
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
       WHERE f.vol <> 'v' AND f.nm LIKE ANY (ARRAY['shareholder_profit_%', 'profit_ledger_position_v1', 'profit_ledger_unpaid_through_v1',
         'profit_ledger_settlement_live_v1', 'profit_ledger_chot_%'])`)).rows;
    expect(r).toEqual([]);
    // Chống xanh rỗng: ba RPC đọc VOLATILE và hàm kiểm quyền người nhận THẬT SỰ nằm trong bao đóng khoá dòng.
    const trong = (await db.query<{ nm: string }>(String.raw`
      WITH RECURSIVE fns AS (
        SELECT p.oid, p.proname AS nm, regexp_replace(pg_get_functiondef(p.oid), '--[^' || chr(10) || ']*', ' ', 'g') AS def
          FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE p.prokind = 'f' AND n.nspname IN ('public', 'app_private')),
      closure AS (SELECT oid, nm, 0 AS depth FROM fns WHERE def ~* '\mfor\s+(share|update|no key update|key share)\M'
        UNION SELECT f.oid, f.nm, c.depth + 1 FROM fns f JOIN closure c ON c.depth < 4 AND f.oid <> c.oid AND f.def ~ ('\m' || c.nm || '\s*\('))
      SELECT DISTINCT nm FROM closure`)).rows.map((x) => x.nm);
    expect(trong).toEqual(expect.arrayContaining(["authorize_tenant_action_v3", "profit_ledger_chot_advance_right_v1", "shareholder_profit_positions_v1",
      "shareholder_profit_advance_options_v1", "shareholder_profit_advance_preview_v1", "shareholder_profit_advance_v1", "shareholder_profit_settle_v1"]));
  });
  it("hai RPC STABLE chạy được trong giao dịch CHỈ ĐỌC dưới vai authenticated; ba RPC đọc VOLATILE thì 25006 (web phải gọi bằng POST)", async () => {
    await db.exec("BEGIN READ ONLY");
    try {
      expect(await goi(U_CD1, r2())).toMatchObject({ shareholder: { id: CD1 }, unpaid_profit: 0 });
      expect(await goi(CHU, r5(CD1))).toMatchObject({ shareholder_id: CD1, blocked_reason: "NOTHING_TO_SETTLE" });
      for (const sql of [r1(), r3(), r4(CD1, 10, SO_QUY)]) expect((await loiGoi(CHU, sql))?.code, sql.slice(14, 60)).toBe("25006");
    } finally { await db.exec("ROLLBACK"); }
  });
});

describe("dữ liệu: dòng sổ phiếu chi, bản ghi chốt, hạng mục", () => {
  it("CHECK maker_kind của dòng sổ: trước chỉ hai giá trị, sau nhận thêm CUSTODIAN_FOR_PAYEE; lập hộ phải là cổ đông, người nhận có đăng nhập và khác người lập", async () => {
    expect(ghi.rangBuocTruoc).toBe("CHECK ((maker_kind = ANY (ARRAY['OWNER'::text, 'CUSTODIAN_ADVANCE'::text])))");
    expect(await mot(`SELECT jsonb_agg(pg_get_constraintdef(c.oid) ORDER BY c.conname) AS v FROM pg_constraint c
      WHERE c.conrelid = 'app_private.profit_ledger_payouts'::regclass AND c.conname IN ('profit_ledger_payouts_maker_kind_check', 'profit_ledger_payouts_custodian_for_payee_ck', 'profit_ledger_payouts_custodian_ck')`))
      .toEqual([
        "CHECK (((maker_kind <> 'CUSTODIAN_ADVANCE'::text) OR ((subject_kind = 'SHAREHOLDER'::text) AND payee_is_maker)))",
        "CHECK (((maker_kind <> 'CUSTODIAN_FOR_PAYEE'::text) OR ((subject_kind = 'SHAREHOLDER'::text) AND (NOT payee_is_maker) AND (payee_user_id IS NOT NULL))))",
        "CHECK ((maker_kind = ANY (ARRAY['OWNER'::text, 'CUSTODIAN_ADVANCE'::text, 'CUSTODIAN_FOR_PAYEE'::text])))"]);
    await giaoDich(async () => {
      // Đo riêng CHECK: tắt trigger nghi thức của bảng trong giao dịch này.
      await db.exec("ALTER TABLE app_private.profit_ledger_payouts DISABLE TRIGGER a00_profit_ledger_payouts_guard");
      let n = 0;
      const chen = async (cachLap: string, nguoiNhan: string | null, nguoiLap = GIU_SO, loai = "SHAREHOLDER") => {
        const p = id(5000 + ++n);
        await taoPhieuThuong(p, 10);
        return loi(`INSERT INTO app_private.profit_ledger_payouts(voucher_id, organization_id, subject_kind, shareholder_id, account_id, amount,
            balance_before, within_amount, advance_amount, maker_user_id, maker_membership_id, maker_kind, payee_is_maker, payee_user_id, ledger_seq)
          VALUES ('${p}','${ORG_A}','${loai}','${CD1}','${SO_GIU}', 10, 0, 0, 10, '${nguoiLap}','${mem(nguoiLap)}','${cachLap}',
            ${nguoiNhan !== null && nguoiNhan === nguoiLap}, ${q(nguoiNhan)}, ${900000 + n})`);
      };
      expect(await chen("CUSTODIAN_FOR_PAYEE", U_CD1)).toBeNull();
      expect(await chen("OWNER", null)).toBeNull();
      expect(await chen("CUSTODIAN_ADVANCE", GIU_SO)).toBeNull();
      expect(await chen("CUSTODIAN_FOR_PAYEE", null)).toMatchObject({ code: "23514", message: expect.stringContaining("profit_ledger_payouts_custodian_for_payee_ck") });
      expect(await chen("CUSTODIAN_FOR_PAYEE", GIU_SO)).toMatchObject({ code: "23514", message: expect.stringContaining("profit_ledger_payouts_custodian_for_payee_ck") });
      expect(await chen("CUSTODIAN_ADVANCE", U_CD1)).toMatchObject({ code: "23514", message: expect.stringContaining("profit_ledger_payouts_custodian_ck") });
      expect(await chen("NGUOI_LA", U_CD1)).toMatchObject({ code: "23514", message: expect.stringContaining("profit_ledger_payouts_maker_kind_check") });
    });
  });

  const chenC7 = (o: { x: number; k: number; tien: number; phieu?: string | null; seq?: string; ungTruoc?: number; them?: [string, string]; cd?: string }) =>
    `INSERT INTO ${C7}(organization_id, shareholder_id, through_month, recognized_amount, advance_offset_amount, cash_amount, cash_voucher_id,
        unpaid_before, advance_before, ledger_seq, created_by${o.them ? `, ${o.them[0]}` : ""})
      VALUES ('${ORG_A}','${o.cd ?? CD1}','2026-09-01', ${o.x}, ${o.k}, ${o.tien}, ${q(o.phieu)}, ${o.x}, ${o.ungTruoc ?? o.k},
        ${o.seq ?? "currval('app_private.profit_ledger_seq')"}, '${CHU}'${o.them ? `, ${o.them[1]}` : ""}) RETURNING id`;
  const khoaSo = (cd = CD1) => `SELECT app_private.profit_ledger_lock_v1('${ORG_A}','SHAREHOLDER','${cd}')`;
  const soMoi = "SELECT nextval('app_private.profit_ledger_seq')";
  it("bản ghi chốt chỉ chèn được dưới khoá sổ, ở ACTIVE, với số thứ tự vừa lấy và chưa dùng; các CHECK về số tiền", async () => {
    await giaoDich(async () => {
      await db.exec(soMoi);
      laLoi(await loi(chenC7({ x: 50, k: 50, tien: 0 })), "55000", "PROFIT_LEDGER_NOT_SERIALIZED");
      await db.exec(khoaSo());
      // Khoá sổ của cổ đông KHÁC không đủ.
      laLoi(await loi(chenC7({ x: 50, k: 50, tien: 0, cd: CD2 })), "55000", "PROFIT_LEDGER_NOT_SERIALIZED");
      laLoi(await loi(chenC7({ x: 50, k: 50, tien: 0, seq: "currval('app_private.profit_ledger_seq') + 7" })), "55000", "PROFIT_LEDGER_SEQ");
      laLoi(await loi(chenC7({ x: 50, k: 50, tien: 0, them: ["state, voided_by, voided_at, void_reason", `'VOID', '${CHU}', now(), 'Lý do đủ tám ký tự'`] })), "55000", "PROFIT_LEDGER_STATE");
      expect((await loi(chenC7({ x: 50, k: 40, tien: 0 })))?.message).toContain("profit_ledger_payout_settlements_split_ck");
      expect((await loi(chenC7({ x: 50, k: 20, tien: 30 })))?.message).toContain("profit_ledger_payout_settlements_cash_voucher_ck");
      expect((await loi(chenC7({ x: 50, k: 50, tien: 0, ungTruoc: 49 })))?.message).toContain("profit_ledger_payout_settlements_offset_ck");
      expect((await loi(chenC7({ x: 0, k: 0, tien: 0 })))?.code).toBe("23514");
      expect((await loi(chenC7({ x: 50, k: -1, tien: 51 })))?.code).toBe("23514");
      expect(await loi(chenC7({ x: 50, k: 50, tien: 0 }))).toBeNull();
      // Dùng lại đúng số vừa ghi (currval chưa đổi) ⇒ chặn; lấy số mới thì được.
      laLoi(await loi(chenC7({ x: 10, k: 10, tien: 0 })), "55000", "PROFIT_LEDGER_SEQ");
      await db.exec(soMoi);
      expect(await loi(chenC7({ x: 10, k: 10, tien: 0 }))).toBeNull();
      // Mốc / dòng sổ phiếu chi lập SAU vẫn theo nghi thức cũ (mỗi dòng một nextval sau khi giữ khoá): không đụng nhau.
      expect(await dem(C7, `shareholder_id = '${CD1}'`)).toBe(2);
    });
  });
  it("bản ghi chốt có phiếu tiền: phải là phiếu chi theo sổ tổng còn sống của đúng cổ đông, đúng số tiền, không có phần tạm ứng; mỗi phiếu một bản ghi", async () => {
    await giaoDich(async () => {
      await chotThang("2026-09-01", TOA_1, { [CD1]: 100, [CD_CHU]: 100 });
      const ung = await goi<KqUng>(GIU_SO, w1({ cd: CD1, tien: 30 }));           // phiếu tạm ứng (advance_amount = 30)
      const chi = await e5Cu(CHU, e5(CD1, 20, false));                            // phiếu chi lợi nhuận cũ (advance_amount = 0)
      const cuaNguoiKhac = await e5Cu(CHU, e5(CD_CHU, 20, false));
      await db.exec(khoaSo());
      const thu = async (o: Parameters<typeof chenC7>[0]) => { await db.exec(soMoi); return loi(chenC7(o)); };
      laLoi(await thu({ x: 30, k: 0, tien: 30, phieu: ung.voucher_id }), "55000", "PROFIT_LEDGER_SETTLEMENT_VOUCHER");
      laLoi(await thu({ x: 21, k: 0, tien: 21, phieu: chi.voucher_id }), "55000", "PROFIT_LEDGER_SETTLEMENT_VOUCHER");
      laLoi(await thu({ x: 20, k: 0, tien: 20, phieu: cuaNguoiKhac.voucher_id }), "55000", "PROFIT_LEDGER_SETTLEMENT_VOUCHER");
      laLoi(await thu({ x: 20, k: 0, tien: 20, phieu: id(4321) }), "55000", "PROFIT_LEDGER_SETTLEMENT_VOUCHER");
      expect(await thu({ x: 20, k: 0, tien: 20, phieu: chi.voucher_id })).toBeNull();
      expect((await thu({ x: 20, k: 0, tien: 20, phieu: chi.voucher_id }))?.message).toContain("profit_ledger_payout_settlements_cash_voucher_uq");
      // Phiếu đã chết (bị huỷ) không gắn được.
      const chet = await e5Cu(CHU, e5(CD1, 5, false));
      expect(await huyPhieu(chet.voucher_id, CHU, "PENDING")).toBeNull();
      await db.exec(khoaSo());
      laLoi(await thu({ x: 5, k: 0, tien: 5, phieu: chet.voucher_id }), "55000", "PROFIT_LEDGER_SETTLEMENT_VOUCHER");
    });
  });
  it("bản ghi chốt chỉ ghi thêm: chỉ ACTIVE → VOID (không phiếu tiền, đang giữ khoá sổ, chỉ đổi bốn cột huỷ); DELETE / TRUNCATE ⇒ 55000", async () => {
    await giaoDich(async () => {
      await chotThang("2026-09-01", TOA_1, { [CD1]: 100 });
      const chi = await e5Cu(CHU, e5(CD1, 20, false));
      await db.exec(`${khoaSo()}; ${soMoi}`);
      const khongTien = (await db.query<{ id: string }>(chenC7({ x: 50, k: 50, tien: 0 }))).rows[0].id;
      await db.exec(soMoi);
      const coTien = (await db.query<{ id: string }>(chenC7({ x: 20, k: 0, tien: 20, phieu: chi.voucher_id }))).rows[0].id;
      const huy = (s: string, them = "") => `UPDATE ${C7} SET state = 'VOID', voided_by = '${CHU}', voided_at = now(), void_reason = 'Lý do đủ tám ký tự'${them} WHERE id = '${s}'`;
      laLoi(await loi(huy(coTien)), "55000", "PROFIT_LEDGER_STATE");
      laLoi(await loi(huy(khongTien, ", note = 'sửa'")), "55000", "PROFIT_LEDGER_STATE");
      laLoi(await loi(`UPDATE ${C7} SET recognized_amount = 60, advance_offset_amount = 60, unpaid_before = 60, advance_before = 60 WHERE id = '${khongTien}'`), "55000", "PROFIT_LEDGER_STATE");
      expect((await loi(`UPDATE ${C7} SET state = 'VOID', voided_by = '${CHU}', voided_at = now(), void_reason = 'ngắn' WHERE id = '${khongTien}'`))?.message)
        .toContain("profit_ledger_payout_settlements_void_ck");
      laLoi(await loi(`DELETE FROM ${C7} WHERE id = '${khongTien}'`), "55000", "PROFIT_LEDGER_APPEND_ONLY");
      laLoi(await loi(`TRUNCATE ${C7}`), "55000", "PROFIT_LEDGER_APPEND_ONLY");
      expect(await loi(huy(khongTien))).toBeNull();
      laLoi(await loi(`UPDATE ${C7} SET state = 'ACTIVE', voided_by = NULL, voided_at = NULL, void_reason = NULL WHERE id = '${khongTien}'`), "55000", "PROFIT_LEDGER_STATE");
    });
    // Không giữ khoá sổ thì cả ACTIVE → VOID cũng bị chặn (giao dịch riêng: khoá sổ giữ tới hết giao dịch).
    await giaoDich(async () => {
      await db.exec("ALTER TABLE app_private.profit_ledger_payout_settlements DISABLE TRIGGER a00_profit_ledger_payout_settlements_guard");
      const s = (await db.query<{ id: string }>(chenC7({ x: 50, k: 50, tien: 0, seq: "987654" }))).rows[0].id;
      await db.exec("ALTER TABLE app_private.profit_ledger_payout_settlements ENABLE TRIGGER a00_profit_ledger_payout_settlements_guard");
      laLoi(await loi(`UPDATE ${C7} SET state = 'VOID', voided_by = '${CHU}', voided_at = now(), void_reason = 'Lý do đủ tám ký tự' WHERE id = '${s}'`), "55000", "PROFIT_LEDGER_STATE");
    });
  });
  it("hạng mục 'Tạm Ứng': gieo cho mọi công ty đang có hạng mục chia_loi_nhuan (chủ hạng mục = chủ dòng đó), đúng cờ; công ty khác không có", async () => {
    const r = (await db.query<Record<string, unknown>>(`SELECT t.organization_id AS org, t.name, t.type, t.category, t.rule_key, t.user_id, t.is_restricted, t.force_approval,
        t.system_only, t.manual_hidden, t.quick_entry_hidden, t.internal_transfer, t.is_default, t.is_deposit
      FROM public.income_expense_types t WHERE t.rule_key = 'tam_ung_co_dong' ORDER BY t.organization_id`)).rows;
    const chung = { name: "Tạm Ứng", type: "expense", category: "Chia lợi nhuận", rule_key: "tam_ung_co_dong", is_restricted: true, force_approval: true,
      system_only: true, manual_hidden: false, quick_entry_hidden: true, internal_transfer: true, is_default: false, is_deposit: false };
    expect(r).toEqual([{ org: ORG_A, user_id: CHU, ...chung }, { org: ORG_B, user_id: NGOAI, ...chung }]);
    // Hạng mục chia_loi_nhuan của Đợt 1 không bị đụng.
    expect(await mot(`SELECT jsonb_agg(jsonb_build_array(t.manual_hidden, t.system_only) ORDER BY t.organization_id) AS v FROM public.income_expense_types t WHERE t.rule_key = 'chia_loi_nhuan'`))
      .toEqual([[true, true], [true, true]]);
  });
  it("lập tay ở Thu chi với hạng mục 'Tạm Ứng' (ie_compat_insert_v2 — đường web rơi về sau khi create_income_expense_v1 từ chối) ⇒ 42501 HINT ie_system_only_manual_blocked", async () => {
    await giaoDich(async () => {
      const loai = await mot<string>(`SELECT id AS v FROM public.income_expense_types WHERE organization_id = '${ORG_A}' AND rule_key = 'tam_ung_co_dong'`);
      const dong = JSON.stringify({ type: "EXPENSE", name: "Tạm ứng lập tay", building_id: TOA_1, account_id: SO_QUY, voucher_date: NGAY, shareholder_id: CD1 });
      const goiTay = (l: string) => `SELECT public.ie_compat_insert_v2('${dong}'::jsonb, '[{"income_expense_type_id":"${l}","quantity":1,"unit_price":10}]'::jsonb) AS v`;
      const l = await loiGoi(CHU, goiTay(loai));
      expect(l).toMatchObject({ code: "42501", hint: "ie_system_only_manual_blocked" });
      // Đối chứng: hạng mục thường thì lập được (và shareholder_id tự khai bị lột — phiếu tay không vào sổ tổng).
      const r = await goi<{ id: string }>(CHU, goiTay(LOAI_VP_A));
      expect(await phieu(r.id)).toMatchObject({ shareholder_id: null, system_source: null });
    });
  });
  it("[ghim] báo cáo dòng tiền xếp phiếu vào cột chi chia lợi nhuận theo nguồn 'profit.ledger_payout' / shareholder_id — không theo hạng mục, nên phiếu 'Tạm Ứng' tự vào đúng cột", () => {
    const d = dinhNghiaCuoi("app_private.cash_flow_external_voucher_rows_v1");
    expect(d.file).toBe(FILE_DONG_TIEN.slice(FILE_DONG_TIEN.lastIndexOf("/") + 1));
    expect(d.body.replace(/\s+/g, " ")).toContain("WHEN ie.system_source IN ('profit.ledger_payout', 'profit.distribution') OR ie.shareholder_id IS NOT NULL OR items.shareholder_item THEN 'SHAREHOLDER'");
    // Cờ "chuyển tiền nội bộ" của dòng tiền chỉ theo rule_key noi_bo / tên bàn giao: hạng mục tam_ung_co_dong không bị loại khỏi "Chi ra".
    expect(d.body).not.toContain("internal_transfer");
    expect(d.body).not.toContain("tam_ung");
  });
});

describe("ví dụ của chủ: được chia 100, ứng 10 + 20 + 10", () => {
  /** Hai tháng đã chốt cho CD1 (60 + 40) và ba phiếu tạm ứng người giữ sổ lập hộ, chủ thứ hai đã duyệt. */
  async function dung(): Promise<KqUng[]> {
    await chotThang("2026-09-01", TOA_1, { [CD1]: 60 });
    await chotThang("2026-10-01", TOA_1, { [CD1]: 40 });
    const ung: KqUng[] = [];
    for (const tien of [10, 20, 10]) ung.push(await goi<KqUng>(GIU_SO, w1({ cd: CD1, tien })));
    for (const u of ung) expect(await duyet(u.voucher_id, CHU2)).toBeNull();
    return ung;
  }
  it("A 100 / B 40 (tạm ứng chỉ thành 'đang có' khi chủ duyệt); chốt ⇒ X 100, K 40, tiền 60, A 0 / B 0 khi phiếu còn chờ; huỷ phiếu tiền ⇒ A 100 / B 40 trở lại", async () => {
    await giaoDich(async () => {
      await chotThang("2026-09-01", TOA_1, { [CD1]: 60 });
      await chotThang("2026-10-01", TOA_1, { [CD1]: 40 });
      expect(await ab(CD1)).toEqual([100, 0, 0, 0, 100]);
      const ung: KqUng[] = [];
      for (const tien of [10, 20, 10]) ung.push(await goi<KqUng>(GIU_SO, w1({ cd: CD1, tien })));
      expect(await ab(CD1)).toEqual([100, 0, 40, 0, 60]);
      for (const u of ung) expect(await duyet(u.voucher_id, CHU2)).toBeNull();
      expect(await ab(CD1)).toEqual([100, 40, 0, 0, 60]);

      const xem = await goi(CHU, r5(CD1));
      expect(xem).toMatchObject({ through_month: "2026-10-01", recognized_amount: 100, advance_offset_amount: 40, cash_amount: 60,
        advance_left: 0, advance_pending: 0, can_submit: true, blocked_reason: null });
      const soPhieu = await dem("public.income_expenses");
      const chot = await goi<KqChot>(CHU, w2({ thang: "2026-10-01", tien: 60, k: 40 }));
      expect(chot).toMatchObject({ through_month: "2026-10-01", recognized_amount: 100, advance_offset_amount: 40, cash_amount: 60, state: "PENDING_APPROVAL" });
      expect(chot.voucher_id).toMatch(UUID);
      expect(await dem("public.income_expenses")).toBe(soPhieu + 1);
      // Phiếu tiền còn chờ duyệt: đã ghi nhận 100, đã khấu trừ 40, 60 đang chờ chi.
      expect(await ab(CD1)).toEqual([0, 0, 0, 60, 0]);

      // Huỷ phiếu tiền bằng lệnh huỷ của Đợt 1 ⇒ bản ghi chốt tự hết hiệu lực, hai con số trở lại.
      expect(await huyPhieu(chot.voucher_id as string, CHU, "PENDING")).toBeNull();
      expect(await ab(CD1)).toEqual([100, 40, 0, 0, 60]);
      expect(await banGhiChot(chot.settlement_id)).toMatchObject({ state: "ACTIVE", cash_voucher_id: chot.voucher_id });
      expect(await mot(`SELECT app_private.profit_ledger_settlement_live_v1('${chot.settlement_id}') AS v`)).toBe(false);
      // Và chốt lại được với đúng các số cũ.
      expect(await goi(CHU, r5(CD1))).toMatchObject({ recognized_amount: 100, advance_offset_amount: 40, cash_amount: 60, settlements: [] });
      expect(await goi<KqChot>(CHU, w2({ thang: "2026-10-01", tien: 60, k: 40 }))).toMatchObject({ cash_amount: 60, state: "PENDING_APPROVAL" });
    });
  });
  it("chủ thứ hai DUYỆT phiếu tiền ⇒ A 0 / B 0, hết tiền chờ; chi (ghi sổ) không đổi hai con số; huỷ phiếu đã chi ⇒ trở lại A 100 / B 40", async () => {
    await giaoDich(async () => {
      await dung();
      const chot = await goi<KqChot>(CHU, w2({ thang: "2026-10-01", tien: 60, k: 40 }));
      const p = chot.voucher_id as string;
      expect(await duyet(p, CHU2)).toBeNull();
      expect(await ab(CD1)).toEqual([0, 0, 0, 0, 0]);
      expect(await ghiSo(p, CHU, SO_QUY)).toBeNull();
      expect(await phieu(p)).toMatchObject({ approval_status: "APPROVED", posting_status: "POSTED" });
      expect(await ab(CD1)).toEqual([0, 0, 0, 0, 0]);
      expect(await huyPhieu(p, CHU2, "POSTED")).toBeNull();
      expect(await ab(CD1)).toEqual([100, 40, 0, 0, 60]);
    });
  });
  it("phiếu tiền bị TỪ CHỐI (decide_financial_request_v2 thật) ⇒ bản ghi chốt hết hiệu lực, A 100 / B 40 trở lại — không cần móc vào đường từ chối", async () => {
    await giaoDich(async () => {
      await dung();
      const chot = await goi<KqChot>(CHU, w2({ thang: "2026-10-01", tien: 60, k: 40 }));
      expect(await ab(CD1)).toEqual([0, 0, 0, 60, 0]);
      expect(await tuChoi(chot.approval_request_id as string, CHU2)).toBeNull();
      expect(await ab(CD1)).toEqual([100, 40, 0, 0, 60]);
      expect((await goi<{ settlements: unknown[] }>(U_CD1, r2())).settlements).toEqual([]);
    });
  });
  it("ứng 120 (vượt lợi nhuận) ⇒ K 100, tiền 0, KHÔNG có phiếu, bản ghi chốt hiệu lực ngay, B còn 20 chuyển kỳ sau; không cần sổ quỹ / ngày chi", async () => {
    await giaoDich(async () => {
      await dung();
      await ungDaDuyet(80);
      expect(await ab(CD1)).toEqual([100, 120, 0, 0, -20]);
      expect(await goi(CHU, r5(CD1, null, null))).toMatchObject({ through_month: "2026-10-01", recognized_amount: 100, advance_offset_amount: 100,
        cash_amount: 0, advance_left: 20, can_submit: true, blocked_reason: null });
      const dem0 = [await dem("public.income_expenses"), await dem("public.approval_requests"), await dem("app_private.profit_ledger_events")];
      const chot = await goi<KqChot>(CHU, w2({ thang: "2026-10-01", so: null, ngay: null, tien: 0, k: 100 }));
      expect(chot).toEqual({ settlement_id: expect.stringMatching(UUID), through_month: "2026-10-01", recognized_amount: 100, advance_offset_amount: 100,
        cash_amount: 0, voucher_id: null, approval_request_id: null, state: "SETTLED" });
      expect([await dem("public.income_expenses"), await dem("public.approval_requests"), await dem("app_private.profit_ledger_events")]).toEqual(dem0);
      expect(await ab(CD1)).toEqual([0, 20, 0, 0, -20]);
      expect(await banGhiChot(chot.settlement_id)).toMatchObject({ state: "ACTIVE", cash_voucher_id: null, recognized_amount: "100.00",
        advance_offset_amount: "100.00", cash_amount: "0.00", unpaid_before: "100.00", advance_before: "120.00", created_by: CHU });
    });
  });
  it("chốt hai lần liên tiếp: lần hai cùng tháng ⇒ 22023 PROFIT_LEDGER_SETTLE_NOTHING; có tháng mới ⇒ X chỉ là tháng mới, khấu trừ nốt phần ứng dư", async () => {
    await giaoDich(async () => {
      await dung();
      await ungDaDuyet(80);
      await goi<KqChot>(CHU, w2({ thang: "2026-10-01", so: null, ngay: null, tien: 0, k: 100 }));
      // Gửi lại đúng hai số đã xem lần trước (100 / 0): không còn gì để chốt.
      const l = laLoi(await loiGoi(CHU, w2({ thang: "2026-10-01", tien: 0, k: 100 })), "22023", "PROFIT_LEDGER_SETTLE_NOTHING");
      expect(chiTiet(l)).toEqual({ through_month: "2026-10-01", unpaid_through: 0 });
      // Xem trước không truyền tháng ⇒ tháng đủ điều kiện lớn nhất (tháng 10), dù không còn gì để chốt ở đó.
      for (const thang of [null, "2026-10-01"]) {
        expect(await goi(CHU, r5(CD1, thang)), String(thang)).toMatchObject({ through_month: "2026-10-01", min_through_month: null, recognized_amount: 0,
          advance_offset_amount: null, cash_amount: null, advance_left: null, can_submit: false, blocked_reason: "NOTHING_TO_SETTLE" });
      }

      await chotThang("2026-11-01", TOA_1, { [CD1]: 50 });
      const xem = await goi<{ months: unknown[] }>(CHU, r5(CD1));
      expect(xem).toMatchObject({ through_month: "2026-11-01", min_through_month: "2026-11-01", recognized_amount: 50, advance_offset_amount: 20, cash_amount: 30, advance_left: 0 });
      expect(xem.months).toEqual([
        { month: "2026-09-01", allocated: 60, unpaid_through: -40, selectable: false },
        { month: "2026-10-01", allocated: 40, unpaid_through: 0, selectable: false },
        { month: "2026-11-01", allocated: 50, unpaid_through: 50, selectable: true }]);
      // Tháng trước lần chốt gần nhất không chốt lại được.
      const lm = laLoi(await loiGoi(CHU, w2({ thang: "2026-09-01", tien: 0, x: 60 })), "22023", "PROFIT_LEDGER_SETTLE_MONTH");
      expect(chiTiet(lm)).toEqual({ through_month: "2026-09-01", min: "2026-10-01", max: "2026-11-01" });
      laLoi(await loiGoi(CHU, r5(CD1, "2026-09-01")), "22023", "PROFIT_LEDGER_SETTLE_MONTH");
      const chot2 = await goi<KqChot>(CHU, w2({ thang: "2026-11-01", tien: 30, k: 20 }));
      expect(chot2).toMatchObject({ recognized_amount: 50, advance_offset_amount: 20, cash_amount: 30, state: "PENDING_APPROVAL" });
      expect(await ab(CD1)).toEqual([0, 0, 0, 30, 0]);
      expect(await duyet(chot2.voucher_id as string, CHU2)).toBeNull();
      expect(await ab(CD1)).toEqual([0, 0, 0, 0, 0]);
      expect(await viThe(CD1)).toMatchObject({ settled: { recognized: 150, offset: 120, cash: 30 }, last_settled_through_month: "2026-11-01" });
    });
  });
  it("toà chốt muộn: phân bổ thêm cho tháng ĐÃ chốt chi ⇒ lần sau X = đúng phần thêm (chốt lại đến tháng gần nhất đã chốt)", async () => {
    await giaoDich(async () => {
      await chotThang("2026-09-01", TOA_1, { [CD1]: 60 });
      await chotThang("2026-10-01", TOA_1, { [CD1]: 40 });
      const chot = await goi<KqChot>(CHU, w2({ thang: "2026-10-01", tien: 100 }));
      expect(await duyet(chot.voucher_id as string, CHU2)).toBeNull();
      expect(await ab(CD1)).toEqual([0, 0, 0, 0, 0]);
      await chotThang("2026-09-01", TOA_2, { [CD1]: 25 });          // toà 2 chốt tháng 09 muộn
      expect(await ab(CD1)).toEqual([25, 0, 0, 0, 25]);
      const xem = await goi<{ months: unknown[] }>(CHU, r5(CD1));
      expect(xem).toMatchObject({ through_month: "2026-10-01", recognized_amount: 25, advance_offset_amount: 0, cash_amount: 25 });
      expect(xem.months).toEqual([
        { month: "2026-09-01", allocated: 85, unpaid_through: -15, selectable: false },
        { month: "2026-10-01", allocated: 40, unpaid_through: 25, selectable: true }]);
      expect(await goi<KqChot>(CHU, w2({ thang: "2026-10-01", tien: 25 }))).toMatchObject({ recognized_amount: 25, cash_amount: 25 });
      expect(await ab(CD1)).toEqual([0, 0, 0, 25, 0]);
    });
  });
  it("tạm ứng CHỜ DUYỆT không được khấu trừ: K chỉ tính phần đã duyệt; duyệt sau thì thành ứng dư chuyển kỳ sau", async () => {
    await giaoDich(async () => {
      await chotThang("2026-09-01", TOA_1, { [CD1]: 100 });
      await ungDaDuyet(30);
      const cho = await goi<KqUng>(GIU_SO, w1({ cd: CD1, tien: 20 }));
      expect(await ab(CD1)).toEqual([100, 30, 20, 0, 50]);
      expect(await goi(CHU, r5(CD1))).toMatchObject({ recognized_amount: 100, advance_offset_amount: 30, cash_amount: 70, advance_left: 0, advance_pending: 20 });
      // Khai số như thể khấu trừ cả phần chờ duyệt (ghi nhận 100, khấu trừ 50, tiền 50) ⇒ tiền lệch ⇒ PT409.
      laLoi(await loiGoi(CHU, w2({ thang: "2026-09-01", tien: 50, k: 50 })), "PT409", "PROFIT_LEDGER_SETTLE_CHANGED");
      const chot = await goi<KqChot>(CHU, w2({ thang: "2026-09-01", tien: 70, k: 30 }));
      expect(chot).toMatchObject({ recognized_amount: 100, advance_offset_amount: 30, cash_amount: 70 });
      expect(await ab(CD1)).toEqual([0, 0, 20, 70, -20]);
      expect(await duyet(cho.voucher_id, CHU2)).toBeNull();
      expect(await ab(CD1)).toEqual([0, 20, 0, 70, -20]);
    });
  });
  it("số liệu đổi giữa lúc xem trước và lúc chốt ⇒ PT409 PROFIT_LEDGER_SETTLE_CHANGED kèm số mới, không ghi gì; gửi lại với số mới thì được; thiếu số kỳ vọng ⇒ 22023", async () => {
    await giaoDich(async () => {
      await chotThang("2026-09-01", TOA_1, { [CD1]: 100 });
      const xem = await goi<{ cash_amount: number }>(CHU, r5(CD1));
      expect(xem.cash_amount).toBe(100);
      await ungDaDuyet(30);                                          // một phiếu tạm ứng vừa được duyệt sau khi chủ xem
      const dk = "operation = 'shareholder_profit.ledger_settle.v1'";
      const truoc = [await dem(C7), await dem("public.income_expenses"), await dem("app_private.canonical_write_operations", dk)];
      // Phần ghi nhận không đổi (100), chỉ TIỀN đổi (100 → 70) ⇒ vẫn PT409.
      const l = laLoi(await loiGoi(CHU, w2({ thang: "2026-09-01", tien: xem.cash_amount, khoa: "chot-cas-000001" })), "PT409", "PROFIT_LEDGER_SETTLE_CHANGED");
      expect(chiTiet(l)).toEqual({ expected_recognized: 100, expected_cash: 100, cash_amount: 70, recognized_amount: 100, advance_offset_amount: 30,
        through_month: "2026-09-01" });
      expect([await dem(C7), await dem("public.income_expenses"), await dem("app_private.canonical_write_operations", dk)]).toEqual(truoc);
      // Hai số kỳ vọng đều bắt buộc: tiền ≥ 0, phần ghi nhận > 0, tối đa hai số lẻ.
      for (const sai of [null, "-1", "70.001", "'NaN'::numeric", "'Infinity'::numeric"]) {
        laLoi(await loiGoi(CHU, w2({ thang: "2026-09-01", x: 100, tien: sai })), "22023", "PROFIT_LEDGER_SETTLE_EXPECTED: thiếu hoặc sai số tiền thực chi");
      }
      for (const sai of [null, "0", "-1", "100.001", "'NaN'::numeric", "'Infinity'::numeric"]) {
        laLoi(await loiGoi(CHU, w2({ thang: "2026-09-01", x: sai, tien: 70 })), "22023", "PROFIT_LEDGER_SETTLE_EXPECTED: thiếu hoặc sai phần lợi nhuận ghi nhận");
      }
      // Cùng khoá gửi lại với số mới: lần PT409 không để lại dòng chống gửi trùng nào.
      expect(await goi<KqChot>(CHU, w2({ thang: "2026-09-01", tien: 70, k: 30, khoa: "chot-cas-000001" }))).toMatchObject({ cash_amount: 70, advance_offset_amount: 30 });
    });
  });
  it("phần GHI NHẬN và phần khấu trừ cùng tăng một lượng giữa lúc xem trước và lúc chốt (toà chốt muộn + một phiếu tạm ứng vừa được duyệt): tiền không đổi nhưng vẫn PT409, không ghi gì", async () => {
    await giaoDich(async () => {
      await chotThang("2026-09-01", TOA_1, { [CD1]: 100 });
      await ungDaDuyet(30);
      const xem = await goi<{ recognized_amount: number; advance_offset_amount: number; cash_amount: number }>(CHU, r5(CD1));
      expect([xem.recognized_amount, xem.advance_offset_amount, xem.cash_amount]).toEqual([100, 30, 70]);
      // Sau khi chủ xem: toà 2 chốt muộn tháng 09 (+20) VÀ một phiếu tạm ứng 20 được duyệt ⇒ ghi nhận 120, khấu trừ 50, tiền VẪN 70.
      await chotThang("2026-09-01", TOA_2, { [CD1]: 20 });
      await ungDaDuyet(20);
      expect(await goi(CHU, r5(CD1))).toMatchObject({ recognized_amount: 120, advance_offset_amount: 50, cash_amount: 70 });
      const dk = "operation = 'shareholder_profit.ledger_settle.v1'";
      const truoc = [await dem(C7), await dem("public.income_expenses"), await dem("app_private.canonical_write_operations", dk),
        await dem("app_private.profit_ledger_events"), await ab(CD1)];
      const l = laLoi(await loiGoi(CHU, w2({ thang: "2026-09-01", x: xem.recognized_amount, tien: xem.cash_amount, khoa: "chot-cas-x-00001" })),
        "PT409", "PROFIT_LEDGER_SETTLE_CHANGED");
      expect(chiTiet(l)).toEqual({ expected_recognized: 100, expected_cash: 70, cash_amount: 70, recognized_amount: 120, advance_offset_amount: 50,
        through_month: "2026-09-01" });
      expect([await dem(C7), await dem("public.income_expenses"), await dem("app_private.canonical_write_operations", dk),
        await dem("app_private.profit_ledger_events"), await ab(CD1)]).toEqual(truoc);
      // Xem lại rồi gửi đúng hai số mới (cùng khoá): chốt được, bản ghi lưu đúng số chủ vừa xem.
      const chot = await goi<KqChot>(CHU, w2({ thang: "2026-09-01", x: 120, tien: 70, khoa: "chot-cas-x-00001" }));
      expect(chot).toMatchObject({ recognized_amount: 120, advance_offset_amount: 50, cash_amount: 70, state: "PENDING_APPROVAL" });
      expect(await banGhiChot(chot.settlement_id)).toMatchObject({ recognized_amount: "120.00", advance_offset_amount: "50.00", cash_amount: "70.00",
        unpaid_before: "120.00", advance_before: "50.00" });
    });
  });
});

describe("W1 — lập phiếu tạm ứng ở Thu chi", () => {
  it("người giữ sổ lập hộ: phiếu UNAPPROVED đúng hình dạng (hạng mục Tạm Ứng, nội bộ), dòng sổ CUSTODIAN_FOR_PAYEE toàn bộ là tạm ứng, nhật ký, yêu cầu chờ duyệt; không trả số của cổ đông", async () => {
    await giaoDich(async () => {
      await chotThang("2026-09-01", TOA_1, { [CD1]: 100 });
      const kq = await goi<KqUng>(GIU_SO, w1({ cd: CD1, tien: 30, khoa: "ung-hinh-dang-01" }));
      expect(kq).toEqual({ voucher_id: expect.stringMatching(UUID), approval_request_id: expect.stringMatching(UUID), shareholder_id: CD1, amount: 30,
        within_amount: 0, advance_amount: 30, balance_before: null, warnings: [{ code: "ADVANCE", advance_amount: 30 }, { code: "NEEDS_OWNER_APPROVAL" }],
        maker_kind: "CUSTODIAN_FOR_PAYEE", payout_kind: "ADVANCE", state: "PENDING_APPROVAL" });
      expect(await phieu(kq.voucher_id)).toMatchObject({ type: "EXPENSE", approval_status: "UNAPPROVED", system_source: "profit.ledger_payout", shareholder_id: CD1,
        profit_manager_id: null, account_id: SO_GIU, building_id: TOA_AO, user_id: CHU, organization_id: ORG_A, total_amount: "30.00", name: "Tạm ứng: Cổ đông 1",
        creator_name: "Người giữ sổ", maker_user_id: GIU_SO, maker_membership_id: mem(GIU_SO), business_result_accounting: false, idempotency_key: "ung-hinh-dang-01",
        posting_status: "UNPOSTED" });
      expect(await mot(`SELECT jsonb_build_object('rk', t.rule_key, 'ten', t.name, 'lop', i.accounting_class, 'tien', i.amount,
          'so', (SELECT count(*) FROM public.income_expense_items x WHERE x.income_expense_id = i.income_expense_id)) AS v
        FROM public.income_expense_items i JOIN public.income_expense_types t ON t.id = i.income_expense_type_id WHERE i.income_expense_id = '${kq.voucher_id}'`))
        .toEqual({ rk: "tam_ung_co_dong", ten: "Tạm Ứng", lop: "INTERNAL", tien: 30, so: 1 });
      expect(await dongSo(kq.voucher_id)).toMatchObject({ subject_kind: "SHAREHOLDER", shareholder_id: CD1, account_id: SO_GIU, amount: "30.00", balance_before: "100.00",
        within_amount: "0.00", advance_amount: "30.00", maker_user_id: GIU_SO, maker_kind: "CUSTODIAN_FOR_PAYEE", payee_is_maker: false, payee_user_id: U_CD1,
        approval_request_id: kq.approval_request_id });
      expect(await mot(`SELECT state AS v FROM public.approval_requests WHERE id = '${kq.approval_request_id}'`)).toBe("PENDING_APPROVAL");
      const nk = (await db.query<{ event_kind: string; amount: string; balance_before: string; balance_after: string; actor_id: string; payload: Record<string, unknown> }>(
        `SELECT event_kind, amount, balance_before, balance_after, actor_id, payload FROM app_private.profit_ledger_events WHERE voucher_id = '${kq.voucher_id}'`)).rows;
      expect(nk).toHaveLength(1);
      expect(nk[0]).toMatchObject({ event_kind: "PAYOUT_CREATED", amount: "30.00", balance_before: "100.00", balance_after: "70.00", actor_id: GIU_SO });
      expect(nk[0].payload).toMatchObject({ payout_kind: "ADVANCE", maker_kind: "CUSTODIAN_FOR_PAYEE", within_amount: 0, advance_amount: 30, account_id: SO_GIU });
      expect(await dem("app_private.profit_ledger_write_contexts")).toBe(0);
      expect(await dem("app_private.accounting_chain_writer_xids")).toBe(0);
      expect(await ab(CD1)).toEqual([100, 0, 30, 0, 70]);
      // Các lệnh đọc của Đợt 1 tự xếp đúng: phiếu này là tạm ứng (is_advance), sổ chi tiết vẫn cộng ra số dư.
      expect(await goi(CHU, `SELECT public.profit_ledger_payout_detail_v1('${kq.voucher_id}') AS v`)).toMatchObject({
        at_create: { balance_before: 100, within: 0, advance: 30, maker_kind: "CUSTODIAN_FOR_PAYEE", payee_is_maker: false } });
      const so = await goi<{ entries: { kind: string; is_advance: boolean; amount: number }[]; totals: { balance: number } }>(CHU,
        `SELECT public.shareholder_profit_ledger_entries_v1('${ORG_A}','${CD1}') AS v`);
      expect(so.entries.filter((e) => e.kind === "PAYOUT")).toMatchObject([{ is_advance: true, amount: -30 }]);
      expect(so.totals.balance).toBe(70);
    });
  });
  it("quyền: chỉ từ sổ quỹ người gọi đang GIỮ (không giữ / giữ sổ khác / chỉ là người biết sổ / chủ không giữ sổ đó ⇒ 42501 PROFIT_LEDGER_ADVANCE_CASHBOOK)", async () => {
    await giaoDich(async () => {
      for (const [ai, so] of [[KHONG_GIU, SO_GIU], [GIU_SO, SO_QUY], [GIU_SO, SO_TU], [CHU3, SO_GIU], [CHU, SO_GIU], [U_CD1, SO_GIU]]) {
        laLoi(await loiGoi(ai, w1({ cd: CD1, tien: 10, so })), "42501", "PROFIT_LEDGER_ADVANCE_CASHBOOK: chỉ lập phiếu tạm ứng từ sổ quỹ bạn đang giữ");
      }
      // Quyền giữ sổ đã hết hạn cũng không tính.
      await db.exec(`UPDATE public.cashbook_possession_bindings SET valid_to = now() - interval '1 minute' WHERE membership_id = '${mem(GIU_SO)}' AND cashbook_id = '${SO_GIU}'`);
      laLoi(await loiGoi(GIU_SO, w1({ cd: CD1, tien: 10, so: SO_GIU })), "42501", "PROFIT_LEDGER_ADVANCE_CASHBOOK");
      expect(await dem("public.income_expenses")).toBe(0);
    });
  });
  it("quyền: người nhận phải có đăng nhập và đang có quyền tạm ứng (không quyền / không đăng nhập / đã thu hồi / hết hạn / ngoại lệ hỏng / chặn khẩn cấp / thành viên ngưng ⇒ 42501 PROFIT_LEDGER_ADVANCE_PAYEE_NO_RIGHT)", async () => {
    await giaoDich(async () => {
      const khongQuyen = (cd: string) => loiGoi(GIU_SO, w1({ cd, tien: 10 }));
      for (const cd of [CD2, CD3, CD_GO, CD_XEM]) laLoi(await khongQuyen(cd), "42501", "PROFIT_LEDGER_ADVANCE_PAYEE_NO_RIGHT: người nhận chưa được cấp quyền tạm ứng");
      // Quyền chi lợi nhuận của người nhận KHÔNG thay quyền tạm ứng (chủ thứ ba là cổ đông nhưng chưa được cấp).
      await db.exec(`UPDATE public.shareholders SET auth_user_id = '${CHU3}' WHERE id = '${CD3}'`);
      laLoi(await khongQuyen(CD3), "42501", "PROFIT_LEDGER_ADVANCE_PAYEE_NO_RIGHT");
      // Ngoại lệ hỏng (không có cạnh phạm vi) ⇒ coi như không có quyền, không lộ lỗi 23514 của bộ máy quyền.
      await db.exec(`INSERT INTO public.member_permission_overrides(organization_id, membership_id, permission_key, effect) VALUES ('${ORG_A}','${mem(U_CD2)}','shareholder_profit.advance_own_cashbook','ALLOW')`);
      laLoi(await khongQuyen(CD2), "42501", "PROFIT_LEDGER_ADVANCE_PAYEE_NO_RIGHT");
      expect(await loiGoi(GIU_SO, w1({ cd: CD1, tien: 10 }))).toBeNull();
      // Hết hạn / thành viên ngưng / chặn khẩn cấp.
      await db.exec(`UPDATE public.member_permission_overrides SET expires_at = now() - interval '1 minute' WHERE membership_id = '${mem(U_R1)}'`);
      laLoi(await khongQuyen(CD_R1), "42501", "PROFIT_LEDGER_ADVANCE_PAYEE_NO_RIGHT");
      await db.exec(`UPDATE public.organization_memberships SET status = 'SUSPENDED' WHERE id = '${mem(U_R2)}'`);
      laLoi(await khongQuyen(CD_R2), "42501", "PROFIT_LEDGER_ADVANCE_PAYEE_NO_RIGHT");
      await db.exec(`INSERT INTO app_private.tenant_emergency_denies VALUES ('${ORG_A}','shareholder_profit.advance_own_cashbook', now() - interval '1 hour', NULL)`);
      laLoi(await khongQuyen(CD1), "42501", "PROFIT_LEDGER_ADVANCE_PAYEE_NO_RIGHT");
      expect(await dem("public.income_expenses")).toBe(1);
    });
  });
  it("chủ tự ứng (dù có quyền chi lợi nhuận) ⇒ CUSTODIAN_ADVANCE: chủ khác duyệt xong thì tự ghi sổ được; lệnh cũ E5 ghi OWNER nên tự ghi sổ bị chặn", async () => {
    await giaoDich(async () => {
      await chotThang("2026-09-01", TOA_1, { [CD_CHU]: 50 });
      const kq = await goi<KqUng>(CHU, w1({ cd: CD_CHU, tien: 20, so: SO_QUY }));
      expect(kq).toMatchObject({ maker_kind: "CUSTODIAN_ADVANCE", balance_before: 50, within_amount: 0, advance_amount: 20 });
      expect(await dongSo(kq.voucher_id)).toMatchObject({ maker_kind: "CUSTODIAN_ADVANCE", payee_is_maker: true, payee_user_id: CHU, within_amount: "0.00", advance_amount: "20.00" });
      laLoi(await duyet(kq.voucher_id, CHU), "42501", "PROFIT_LEDGER_MAKER_SELF_APPROVE");
      expect(await duyet(kq.voucher_id, CHU2)).toBeNull();
      expect(await ghiSo(kq.voucher_id, CHU, SO_QUY)).toBeNull();
      expect(await phieu(kq.voucher_id)).toMatchObject({ approval_status: "APPROVED", posting_status: "POSTED" });
      // Đối chứng lỗi cũ: cùng người, cùng sổ, lập bằng E5 ⇒ OWNER ⇒ sau khi duyệt, chính người nhận không tự ghi sổ được.
      // (Phiếu E5 cũ — lập trước khi thu quyền ở 20261118171708 — nên gọi E5 bằng vai chủ hàm.)
      const cu = await e5Cu(CHU, e5(CD_CHU, 10, true));
      expect(cu.maker_kind).toBe("OWNER");
      expect(await duyet(cu.voucher_id, CHU2)).toBeNull();
      laLoi(await ghiSo(cu.voucher_id, CHU, SO_QUY), "42501", "PROFIT_LEDGER_PAYEE_SELF_POST");
    });
  });
  it("cổ đông giữ sổ tự ứng ⇒ CUSTODIAN_ADVANCE (thấy số của mình); cũng người đó lập cho cổ đông KHÁC ⇒ CUSTODIAN_FOR_PAYEE (không thấy số)", async () => {
    await giaoDich(async () => {
      await chotThang("2026-09-01", TOA_1, { [CD_TU]: 40, [CD1]: 70 });
      const tu = await goi<KqUng>(TU_UNG, w1({ cd: CD_TU, tien: 55, so: SO_TU }));
      expect(tu).toMatchObject({ maker_kind: "CUSTODIAN_ADVANCE", balance_before: 40, advance_amount: 55 });
      const ho = await goi<KqUng>(TU_UNG, w1({ cd: CD1, tien: 5, so: SO_TU }));
      expect(ho).toMatchObject({ maker_kind: "CUSTODIAN_FOR_PAYEE", balance_before: null });
      expect(await ab(CD_TU)).toEqual([40, 0, 55, 0, -15]);
    });
  });
  it("cổ đông nghỉ / đã xoá / công ty khác, sổ ảo / sổ công ty khác, người ngoài công ty, super admin không là thành viên, chưa đăng nhập ⇒ 42501; công ty không có toà ảo ⇒ 55000", async () => {
    await giaoDich(async () => {
      // Cổ đông nghỉ / đã xoá của CHÍNH công ty mình (người gọi là thành viên).
      for (const cd of [CD_NGHI, CD_XOA]) expect(await loiGoi(GIU_SO, w1({ cd, tien: 10 }))).toMatchObject({ code: "42501", message: "Không tìm thấy cổ đông trong tổ chức hợp lệ" });
      // "Không có cổ đông đó" và "không thuộc công ty của cổ đông" trả CÙNG một câu, cùng mã, không DETAIL / HINT: người ngoài
      // (và thành viên công ty khác) không dò được một mã cổ đông có tồn tại hay không.
      const cung = { code: "42501", message: "Không có quyền lập phiếu tạm ứng cổ đông, hoặc không tìm thấy cổ đông trong tổ chức hợp lệ", detail: null, hint: null };
      for (const cd of [id(999), CD_B]) expect(await loiGoi(GIU_SO, w1({ cd, tien: 10 })), cd).toEqual(cung);
      for (const ai of [NGOAI, SUPER]) {
        for (const cd of [CD1, id(999)]) expect(await loiGoi(ai, w1({ cd, tien: 10 })), `${ai} ${cd}`).toEqual(cung);
      }
      expect(await loiGoi(null, w1({ cd: CD1, tien: 10 }))).toMatchObject({ code: "42501", message: "Chưa đăng nhập" });
      for (const so of [SO_AO, SO_B, id(998)]) expect(await loiGoi(GIU_SO, w1({ cd: CD1, tien: 10, so }))).toMatchObject({ code: "42501", message: "Sổ quỹ tiền thật không hợp lệ hoặc không thuộc tổ chức" });
      await db.exec(`UPDATE public.buildings SET deleted_at = now() WHERE id = '${TOA_AO}'`);
      expect(await loiGoi(GIU_SO, w1({ cd: CD1, tien: 10 }))).toMatchObject({ code: "55000", message: "Tổ chức chưa có toà ảo để hạch toán chia lợi nhuận" });
      expect(await dem("public.income_expenses")).toBe(0);
    });
  });
  it("đầu vào sai ⇒ 22023: khoá, số tiền (0, âm, 3 số lẻ, NaN, vô cực, quá lớn), thiếu sổ / ngày, ghi chú > 500", async () => {
    await giaoDich(async () => {
      for (const k of ["ngắn", "khoá có dấu cách", "-batdaugach", ""]) expect((await loiGoi(GIU_SO, w1({ tien: 10, khoa: k })))?.code, k).toBe("22023");
      for (const tien of ["0", "-5", "10.001", "'NaN'::numeric", "'Infinity'::numeric", "10000000000000", "NULL"]) {
        expect(await loiGoi(GIU_SO, w1({ tien })), tien).toMatchObject({ code: "22023", message: "Số tiền tạm ứng không hợp lệ" });
      }
      expect(await loiGoi(GIU_SO, w1({ tien: 10, so: null }))).toMatchObject({ code: "22023", message: "Thiếu sổ quỹ hoặc ngày chi" });
      expect(await loiGoi(GIU_SO, w1({ tien: 10, ngay: null }))).toMatchObject({ code: "22023", message: "Thiếu sổ quỹ hoặc ngày chi" });
      expect(await loiGoi(GIU_SO, w1({ tien: 10, ghiChu: "x".repeat(501) }))).toMatchObject({ code: "22023", message: "Ghi chú dài quá 500 ký tự" });
      expect(await loiGoi(GIU_SO, w1({ tien: 10, ghiChu: "x".repeat(500) }))).toBeNull();
      expect((await db.query<{ name: string }>("SELECT name FROM public.income_expenses")).rows).toEqual([{ name: "x".repeat(500) }]);
    });
  });
  it("công tắc TẮT / SHADOW ⇒ 55000 PROFIT_LEDGER_ROUTE_OFF; ĐÓNG BĂNG ⇒ 55000 PROFIT_LEDGER_FROZEN; không để lại gì", async () => {
    await giaoDich(async () => {
      for (const [r, ma] of [["LEGACY", "PROFIT_LEDGER_ROUTE_OFF"], ["SHADOW", "PROFIT_LEDGER_ROUTE_OFF"], ["FROZEN", "PROFIT_LEDGER_FROZEN"]] as [Route, string][]) {
        await datRoute(r);
        const l = laLoi(await loiGoi(GIU_SO, w1({ tien: 10 })), "55000", ma);
        expect(chiTiet(l).route).toBe(r);
      }
      for (const bang of ["public.income_expenses", "public.approval_requests", "app_private.profit_ledger_payouts", "app_private.canonical_write_operations"]) expect(await dem(bang), bang).toBe(0);
      await datRoute("CANONICAL");
      expect(await loiGoi(GIU_SO, w1({ tien: 10 }))).toBeNull();
    });
  });
  it("cùng khoá ⇒ trả y hệt, không ghi thêm; cùng khoá khác số tiền / ngày / ghi chú ⇒ 23505; lệnh tạm ứng và lệnh cũ E5 dùng chung khoá không đụng nhau", async () => {
    await giaoDich(async () => {
      const goc: Ung = { cd: CD1, tien: 12.5, so: SO_QUY, ghiChu: "Ứng đợt 1", khoa: "ung-trung-khoa-01" };
      const lan1 = await goi<KqUng>(CHU, w1(goc));
      const lan2 = await goi<KqUng>(CHU, w1(goc));
      expect(lan2).toEqual(lan1);
      expect(await dem("public.income_expenses")).toBe(1);
      expect(await dem("app_private.profit_ledger_payouts")).toBe(1);
      for (const doi of [{ tien: 13 }, { ghiChu: "Ứng đợt 2" }, { ngay: "2026-11-11" }]) {
        expect(await loiGoi(CHU, w1({ ...goc, ...doi }))).toMatchObject({ code: "23505", message: "idempotency_key đã dùng với nội dung khác" });
      }
      // Cùng người, cùng cổ đông, cùng khoá nhưng là lệnh KHÁC (E5): operation riêng nên vẫn lập được phiếu của nó. E5 đã thu
      // quyền của authenticated (20261118171708) ⇒ dựng phiếu E5 bằng vai chủ hàm, auth.uid() vẫn là CHU.
      expect(await loiGoi(CHU, `SELECT public.shareholder_profit_ledger_payout_v1('${CD1}', 12.5, '${SO_QUY}', '${NGAY}', 'Ứng đợt 1', true, 'ung-trung-khoa-01')`, "postgres")).toBeNull();
      expect(await dem("public.income_expenses")).toBe(2);
      expect(await mot(`SELECT jsonb_agg(operation ORDER BY operation) AS v FROM app_private.canonical_write_operations WHERE idempotency_key = 'ung-trung-khoa-01'`))
        .toEqual(["shareholder_profit.ledger_advance.v1", "shareholder_profit.ledger_payout.v1"]);
    });
  });
  it("cổ đông còn phiếu lương 'cần chủ xem lại' ⇒ 55000 PROFIT_LEDGER_SALARY_REVIEW_PENDING; hai khoá ngày như E5; luật duyệt DENY ⇒ huỷ cả lệnh", async () => {
    await giaoDich(async () => {
      await dongLuong({ cd: CD1, thang: "2026-10-01", y: 5, trangThai: "NEEDS_REVIEW", phieu: id(3101) });
      laLoi(await loiGoi(GIU_SO, w1({ tien: 10 })), "55000", "PROFIT_LEDGER_SALARY_REVIEW_PENDING");
      await db.exec(`UPDATE public.income_expenses SET deleted_at = now() WHERE id = '${id(3101)}'`);
      // Tháng của toà ảo đã chốt lợi nhuận / sổ quỹ đã chốt tới ngày chi.
      await db.exec(`INSERT INTO public.profit_monthly(organization_id, building_id, period_month, status, locked_at) VALUES ('${ORG_A}','${TOA_AO}','2026-05-01','LOCKED', now())`);
      const lt = laLoi(await loiGoi(GIU_SO, w1({ tien: 10, ngay: "2026-05-20" })), "55000", "PROFIT_LEDGER_PROFIT_MONTH_LOCKED: tháng 05/2026");
      expect(chiTiet(lt)).toEqual({ voucher_date: "2026-05-20", building_id: TOA_AO });
      await db.exec(`INSERT INTO app_private.cashbook_closures(organization_id, cashbook_id, closed_through) VALUES ('${ORG_A}','${SO_GIU}','2026-11-10')`);
      const ls = laLoi(await loiGoi(GIU_SO, w1({ tien: 10, ngay: "2026-11-10" })), "55000", "PROFIT_LEDGER_CASHBOOK_CLOSED");
      expect(chiTiet(ls)).toEqual({ closed_through: "2026-11-10", voucher_date: "2026-11-10" });
      await db.exec("SELECT set_config('test.submit', 'DENY', true)");
      laLoi(await loiGoi(GIU_SO, w1({ tien: 10, ngay: "2026-11-11" })), "55000", "PROFIT_LEDGER_REQUEST_NOT_PENDING");
      for (const bang of ["public.approval_requests", "app_private.profit_ledger_payouts", "app_private.profit_ledger_events", "public.income_expense_items"]) expect(await dem(bang), bang).toBe(0);
      expect(await dem("public.income_expenses", "system_source = 'profit.ledger_payout'")).toBe(0);
      await db.exec("SELECT set_config('test.submit', '', true)");
      expect(await loiGoi(GIU_SO, w1({ tien: 10, ngay: "2026-11-11" }))).toBeNull();
    });
  });
  it("còn phiếu lương 'cần chủ xem lại': người lập hộ chỉ nhận mã + câu, KHÔNG có DETAIL (số gợi ý là tiền của cổ đông); chính người nhận tự ứng thì có DETAIL", async () => {
    await giaoDich(async () => {
      await dongLuong({ cd: CD1, thang: "2026-10-01", y: 5, trangThai: "NEEDS_REVIEW", phieu: id(3111) });
      await dongLuong({ cd: CD_TU, thang: "2026-10-01", y: 7, trangThai: "NEEDS_REVIEW", phieu: id(3112) });
      // Lập hộ (người giữ sổ ≠ người nhận).
      const ho = laLoi(await loiGoi(GIU_SO, w1({ cd: CD1, tien: 10 })), "55000", "PROFIT_LEDGER_SALARY_REVIEW_PENDING");
      expect(ho.detail).toBeNull();
      expect(JSON.stringify(ho)).not.toMatch(/suggested|"count"/);
      // Cùng người đó lập hộ cho một cổ đông khác cũng đang có phiếu lương cần xem lại: vẫn không có DETAIL.
      expect((await loiGoi(GIU_SO, w1({ cd: CD_TU, tien: 10 })))).toMatchObject({ code: "55000", detail: null });
      // Chính người nhận tự ứng từ sổ mình giữ: giữ DETAIL như lệnh chi cũ.
      const tu = laLoi(await loiGoi(TU_UNG, w1({ cd: CD_TU, tien: 10, so: SO_TU })), "55000", "PROFIT_LEDGER_SALARY_REVIEW_PENDING");
      expect(chiTiet(tu)).toEqual({ count: 1, suggested: 7 });
      expect(await dem("public.income_expenses", "system_source = 'profit.ledger_payout'")).toBe(0);
    });
  });
  it("hạng mục 'Tạm Ứng' mất 'bắt buộc duyệt' ⇒ 55000 PROFIT_LEDGER_TYPE_NOT_FORCED; chưa có ⇒ tự tạo đúng cờ; công ty đã có hạng mục chi trùng tên (không mang rule_key) ⇒ KHÔNG chiếm, dừng 55000 PROFIT_LEDGER_TYPE_NAME_TAKEN", async () => {
    await giaoDich(async () => {
      const dk = `organization_id = '${ORG_A}' AND rule_key = 'tam_ung_co_dong'`;
      await db.exec(`UPDATE public.income_expense_types SET force_approval = false WHERE ${dk}`);
      const l = laLoi(await loiGoi(GIU_SO, w1({ tien: 10 })), "55000", 'PROFIT_LEDGER_TYPE_NOT_FORCED: hạng mục "Tạm Ứng" phải bật "Bắt buộc duyệt"');
      expect(chiTiet(l).income_expense_type_id).toMatch(UUID);
      await db.exec(`DELETE FROM public.income_expense_types WHERE ${dk}`);
      const r = await goi<KqUng>(GIU_SO, w1({ tien: 10 }));
      expect(await mot(`SELECT jsonb_build_object('ten', t.name, 'rk', t.rule_key, 'so', t.system_only, 'mh', t.manual_hidden, 'qh', t.quick_entry_hidden, 'it', t.internal_transfer,
          'fa', t.force_approval, 'r', t.is_restricted, 'cat', t.category, 'chu', t.user_id) AS v
        FROM public.income_expense_items i JOIN public.income_expense_types t ON t.id = i.income_expense_type_id WHERE i.income_expense_id = '${r.voucher_id}'`))
        .toEqual({ ten: "Tạm Ứng", rk: "tam_ung_co_dong", so: true, mh: false, qh: true, it: true, fa: true, r: true, cat: "Chia lợi nhuận", chu: CHU });
    });
    await giaoDich(async () => {
      await db.exec(`DELETE FROM public.income_expense_types WHERE organization_id = '${ORG_A}' AND rule_key = 'tam_ung_co_dong';
        INSERT INTO public.income_expense_types(id, name, type, user_id, organization_id, force_approval) VALUES ('${id(97)}','tạm  ỨNG','expense','${CHU}','${ORG_A}', true)`);
      // Hạng mục người dùng tự đặt (đang dùng cho việc khác): lệnh lập tạm ứng không dùng lại, không tạo thêm, không lập phiếu.
      const l = laLoi(await loiGoi(GIU_SO, w1({ tien: 10 })), "55000", 'PROFIT_LEDGER_TYPE_NAME_TAKEN: công ty đã có hạng mục chi tên "Tạm Ứng" dùng cho việc khác');
      expect(chiTiet(l)).toEqual({ income_expense_type_id: id(97) });
      expect(await dem("public.income_expense_types", `organization_id = '${ORG_A}' AND rule_key = 'tam_ung_co_dong'`)).toBe(0);
      expect(await dem("public.income_expense_items", `income_expense_type_id = '${id(97)}'`)).toBe(0);
      expect(await dem("public.income_expenses", "system_source = 'profit.ledger_payout'")).toBe(0);
      // Hạng mục THU trùng tên thì không cản (chỉ mục duy nhất theo chiều thu / chi): lệnh tự tạo hạng mục chi của mình.
      await db.exec(`UPDATE public.income_expense_types SET type = 'income' WHERE id = '${id(97)}'`);
      const r = await goi<KqUng>(GIU_SO, w1({ tien: 10 }));
      expect(await mot(`SELECT t.rule_key AS v FROM public.income_expense_items i JOIN public.income_expense_types t ON t.id = i.income_expense_type_id
        WHERE i.income_expense_id = '${r.voucher_id}'`)).toBe("tam_ung_co_dong");
    });
    // Nhánh chia_loi_nhuan (phiếu tiền của lệnh chốt) GIỮ dự phòng theo tên như lệnh chi cũ: dùng lại hạng mục trùng tên.
    await giaoDich(async () => {
      await db.exec(`UPDATE public.income_expense_types SET rule_key = NULL, name = 'chia  LỢI nhuận cổ đông' WHERE id = '${LOAI_CLN_A}'`);
      await chotThang("2026-09-01", TOA_1, { [CD1]: 100 });
      const chot = await goi<KqChot>(CHU, w2({ thang: "2026-09-01", tien: 100 }));
      expect(await mot(`SELECT income_expense_type_id AS v FROM public.income_expense_items WHERE income_expense_id = '${chot.voucher_id}'`)).toBe(LOAI_CLN_A);
      expect(await dem("public.income_expense_types", `organization_id = '${ORG_A}' AND rule_key = 'chia_loi_nhuan'`)).toBe(0);
    });
  });
  it("công ty khác lập tạm ứng cho cổ đông của mình bình thường (toà ảo, hạng mục, số dư của đúng công ty)", async () => {
    await giaoDich(async () => {
      await db.exec(`INSERT INTO public.member_permission_overrides(id, organization_id, membership_id, permission_key, effect) VALUES ('${id(230)}','${ORG_B}','${mem(NGOAI)}','shareholder_profit.advance_own_cashbook','ALLOW');
        INSERT INTO public.member_override_scopes VALUES ('${ORG_B}','${id(230)}','${PHAM_VI_B}')`);
      const r = await goi<KqUng>(NGOAI, w1({ cd: CD_B, tien: 300, so: SO_B }));
      expect(r).toMatchObject({ maker_kind: "CUSTODIAN_ADVANCE", balance_before: 0, advance_amount: 300 });
      expect(await phieu(r.voucher_id)).toMatchObject({ building_id: TOA_AO_B, organization_id: ORG_B, user_id: NGOAI });
      expect(await mot(`SELECT t.organization_id AS v FROM public.income_expense_items i JOIN public.income_expense_types t ON t.id = i.income_expense_type_id WHERE i.income_expense_id = '${r.voucher_id}'`)).toBe(ORG_B);
    });
  });
});

describe("F1 của Đợt 1 với phiếu người giữ sổ lập hộ (CUSTODIAN_FOR_PAYEE) — không sửa F1", () => {
  it("người lập không tự duyệt, người nhận không tự duyệt, chủ khác duyệt; người nhận không tự ghi sổ, người lập (giữ sổ) ghi sổ được", async () => {
    await giaoDich(async () => {
      await chotThang("2026-09-01", TOA_1, { [CD_CHU]: 80 });
      // CHU2 (giữ SO_QUY) lập hộ cho cổ đông CD_CHU — người nhận là CHU, cũng là chủ và cũng giữ SO_QUY.
      const kq = await goi<KqUng>(CHU2, w1({ cd: CD_CHU, tien: 25, so: SO_QUY }));
      expect(kq.maker_kind).toBe("CUSTODIAN_FOR_PAYEE");
      laLoi(await duyet(kq.voucher_id, CHU2), "42501", "PROFIT_LEDGER_MAKER_SELF_APPROVE");
      laLoi(await duyet(kq.voucher_id, CHU), "42501", "PROFIT_LEDGER_PAYEE_SELF_APPROVE");
      expect(await phieu(kq.voucher_id)).toMatchObject({ approval_status: "UNAPPROVED" });
      expect(await duyet(kq.voucher_id, CHU3)).toBeNull();
      expect(await ab(CD_CHU)).toEqual([80, 25, 0, 0, 55]);
      laLoi(await ghiSo(kq.voucher_id, CHU, SO_QUY), "42501", "PROFIT_LEDGER_PAYEE_SELF_POST");
      expect(await phieu(kq.voucher_id)).toMatchObject({ posting_status: "UNPOSTED" });
      expect(await ghiSo(kq.voucher_id, CHU2, SO_QUY)).toBeNull();
      expect(await phieu(kq.voucher_id)).toMatchObject({ approval_status: "APPROVED", posting_status: "POSTED", account_id: SO_QUY });
      expect(await mot(`SELECT jsonb_agg(event_kind ORDER BY created_at) AS v FROM app_private.profit_ledger_events WHERE voucher_id = '${kq.voucher_id}'`))
        .toEqual(["PAYOUT_CREATED", "PAYOUT_APPROVED", "PAYOUT_POSTED"]);
    });
  });
  it("người giữ sổ không có quyền chi lợi nhuận lập hộ: chủ duyệt, chính người giữ sổ ghi sổ từ sổ mình giữ; huỷ theo lệnh huỷ cũ: người lập chỉ huỷ được khi còn chờ duyệt, người nhận không huỷ được", async () => {
    await giaoDich(async () => {
      await chotThang("2026-09-01", TOA_1, { [CD1]: 100 });
      const a = await goi<KqUng>(GIU_SO, w1({ cd: CD1, tien: 10 }));
      expect(await duyet(a.voucher_id, CHU2)).toBeNull();
      expect(await ghiSo(a.voucher_id, GIU_SO, SO_GIU)).toBeNull();
      expect(await phieu(a.voucher_id)).toMatchObject({ posting_status: "POSTED" });
      // Phiếu đã duyệt: người lập (không có quyền chi lợi nhuận) không huỷ được nữa; người nhận cũng không.
      laLoi(await huyPhieu(a.voucher_id, GIU_SO, "POSTED"), "42501", "PROFIT_LEDGER_CANCEL_FORBIDDEN");
      laLoi(await huyPhieu(a.voucher_id, U_CD1, "POSTED"), "42501", "PROFIT_LEDGER_CANCEL_FORBIDDEN");
      // Phiếu còn chờ duyệt: người nhận không huỷ được, người lập huỷ được, chủ cũng huỷ được.
      const b = await goi<KqUng>(GIU_SO, w1({ cd: CD1, tien: 20 }));
      laLoi(await huyPhieu(b.voucher_id, U_CD1, "PENDING"), "42501", "PROFIT_LEDGER_CANCEL_FORBIDDEN");
      expect(await huyPhieu(b.voucher_id, GIU_SO, "PENDING")).toBeNull();
      const c = await goi<KqUng>(GIU_SO, w1({ cd: CD1, tien: 30 }));
      expect(await huyPhieu(c.voucher_id, CHU, "PENDING")).toBeNull();
      expect(await ab(CD1)).toEqual([100, 10, 0, 0, 90]);
    });
  });
  it("phiếu tiền của lần chốt: người chốt không tự duyệt, chủ khác duyệt; sửa số tiền / dòng hạng mục / xoá bị chốt chặn cũ chặn", async () => {
    await giaoDich(async () => {
      await chotThang("2026-09-01", TOA_1, { [CD1]: 100 });
      const chot = await goi<KqChot>(CHU, w2({ thang: "2026-09-01", tien: 100 }));
      const p = chot.voucher_id as string;
      laLoi(await duyet(p, CHU), "42501", "PROFIT_LEDGER_MAKER_SELF_APPROVE");
      laLoi(await loi(`UPDATE public.income_expenses SET total_amount = 1 WHERE id = '${p}'`), "55000", "PROFIT_LEDGER_LOCKED");
      laLoi(await loi(`UPDATE public.income_expense_items SET unit_price = 1 WHERE income_expense_id = '${p}'`), "55000", "PROFIT_LEDGER_ITEMS_LOCKED");
      laLoi(await loi(`DELETE FROM public.income_expenses WHERE id = '${p}'`), "55000", "PROFIT_LEDGER_NO_DELETE");
      expect(await duyet(p, CHU2)).toBeNull();
      expect(await ab(CD1)).toEqual([0, 0, 0, 0, 0]);
    });
  });
});

// ── 20261118143113: lệnh huỷ E6 không trả số dư của chủ thể cho người lập hộ ─────────────────────────
interface KqHuy { voucher_id: string; changed: boolean; cancellation_kind: string; reversal_posting_id: string | null; balance_after: number | null }
/** Lệnh huỷ E6 với khoá cho trước; ky null ⇒ không truyền trạng thái kỳ vọng (phiếu đã huỷ thì không có trạng thái kỳ vọng hợp lệ). */
const sqlE6 = (p: string, k: string, ky: string | null) =>
  `SELECT public.profit_ledger_payout_cancel_v1('${p}', 'Lý do huỷ đủ tám ký tự', '${k}', ${q(ky)}) AS v`;
/** Kết quả E6 đã lưu để phát lại, theo khoá chống gửi trùng. */
const daLuuE6 = (k: string) => mot<Record<string, unknown>>(`SELECT response_payload AS v FROM app_private.canonical_write_operations
  WHERE operation = 'shareholder_profit.ledger_cancel.v1' AND idempotency_key = '${k}'`);
const nhatKyHuy = (p: string) => db.query<{ balance_before: string; balance_after: string; actor_id: string }>(`SELECT balance_before, balance_after, actor_id
  FROM app_private.profit_ledger_events WHERE voucher_id = '${p}' AND event_kind = 'PAYOUT_CANCELLED' ORDER BY created_at`).then((r) => r.rows);
const QL = id(81);
/** Lương điều hành trên sổ tổng: công tắc riêng của lệnh lương điều hành BẬT; một quản lý (đăng nhập QUAN_LY) được phân bổ 200. */
async function nenLuongDieuHanh() {
  await db.exec(`INSERT INTO app_private.server_feature_flags(feature_key, domain, mode, commit_sha, migration_sha256, maintenance_window_id, approval_reference)
      VALUES ('shareholder_profit.pay_manager.v1','profit','ON','${"c".repeat(40)}','${"d".repeat(64)}','mw-ql','ref-ql');
    INSERT INTO public.profit_managers(id, organization_id, auth_user_id, name) VALUES ('${QL}','${ORG_A}','${QUAN_LY}','Quản lý điều hành')`);
  const pm = await chotThang("2026-09-01", TOA_1, {});
  await db.exec(`INSERT INTO public.profit_manager_allocations(profit_monthly_id, manager_id, amount, organization_id) VALUES ('${pm}','${QL}', 200, '${ORG_A}')`);
}
const luongDieuHanh = (tien: number) =>
  `SELECT public.manager_salary_payout_v1('${QL}', ${tien}, '${SO_QUY}', '${NGAY}', NULL, '${khoa("luong")}')::jsonb AS v`;

describe("20261118143113 — E6: balance_after chỉ cho người có quyền chi của loại chủ thể hoặc chính người nhận", () => {
  it("người giữ sổ KHÔNG có quyền chi lợi nhuận lập hộ rồi tự huỷ phiếu chờ: huỷ được, balance_after null; bản lưu để phát lại và lần gửi lại cùng khoá đều null; nhánh 'đã huỷ từ trước' (khoá khác) null; nhật ký nội bộ vẫn có số thật", async () => {
    await giaoDich(async () => {
      await chotThang("2026-09-01", TOA_1, { [CD1]: 100 });
      const kq = await goi<KqUng>(GIU_SO, w1({ cd: CD1, tien: 30 }));
      expect(kq).toMatchObject({ maker_kind: "CUSTODIAN_FOR_PAYEE", balance_before: null });
      const k = khoa("huyho");
      const lan1 = await goi<KqHuy>(GIU_SO, sqlE6(kq.voucher_id, k, "PENDING"));
      expect(lan1).toEqual({ voucher_id: kq.voucher_id, changed: true, cancellation_kind: "CANCELLED_UNPOSTED", reversal_posting_id: null, balance_after: null });
      expect(await phieu(kq.voucher_id)).toMatchObject({ approval_status: "CANCELLED", cancellation_kind: "CANCELLED_UNPOSTED" });
      // Bản lưu để phát lại: đủ năm khoá như cũ, balance_after là null; gửi lại cùng khoá ⇒ y hệt.
      const luu = await daLuuE6(k);
      expect(luu).toEqual(lan1);
      expect(Object.keys(luu).sort()).toEqual(["balance_after", "cancellation_kind", "changed", "reversal_posting_id", "voucher_id"]);
      expect(await goi<KqHuy>(GIU_SO, sqlE6(kq.voucher_id, k, "PENDING"))).toEqual(lan1);
      // Nhánh phiếu đã huỷ từ trước (khoá khác).
      const lai = khoa("huyho");
      expect(await goi<KqHuy>(GIU_SO, sqlE6(kq.voucher_id, lai, null))).toEqual({ ...lan1, changed: false });
      expect(await daLuuE6(lai)).toEqual({ ...lan1, changed: false });
      // Bảng nội bộ vẫn ghi đủ số; số dư thật đã về 100.
      expect(await nhatKyHuy(kq.voucher_id)).toEqual([{ balance_before: "70.00", balance_after: "100.00", actor_id: GIU_SO }]);
      expect(await soDuRong(CD1)).toBe(100);
      // Đối chứng trên CÙNG phiếu: chủ có quyền chi lợi nhuận gọi nhánh 'đã huỷ' ⇒ thấy số.
      expect(await goi<KqHuy>(CHU, sqlE6(kq.voucher_id, khoa("huyho"), null))).toEqual({ ...lan1, changed: false, balance_after: 100 });
    });
  });
  it("cổ đông tự tạm ứng (CUSTODIAN_ADVANCE, không có quyền chi lợi nhuận) huỷ phiếu chờ của mình ⇒ có số, cả bản lưu, lần gửi lại cùng khoá và nhánh đã huỷ", async () => {
    await giaoDich(async () => {
      await chotThang("2026-09-01", TOA_1, { [CD_TU]: 40 });
      const tu = await goi<KqUng>(TU_UNG, w1({ cd: CD_TU, tien: 15, so: SO_TU }));
      expect(tu).toMatchObject({ maker_kind: "CUSTODIAN_ADVANCE", balance_before: 40 });
      const k = khoa("huytu");
      const lan1 = await goi<KqHuy>(TU_UNG, sqlE6(tu.voucher_id, k, "PENDING"));
      expect(lan1).toEqual({ voucher_id: tu.voucher_id, changed: true, cancellation_kind: "CANCELLED_UNPOSTED", reversal_posting_id: null, balance_after: 40 });
      expect(await daLuuE6(k)).toEqual(lan1);
      expect(await goi<KqHuy>(TU_UNG, sqlE6(tu.voucher_id, k, "PENDING"))).toEqual(lan1);
      expect(await goi<KqHuy>(TU_UNG, sqlE6(tu.voucher_id, khoa("huytu"), null))).toEqual({ ...lan1, changed: false });
    });
  });
  it("người có quyền chi lợi nhuận (không phải người nhận) huỷ phiếu người giữ sổ lập hộ ⇒ có số — phiếu chờ duyệt và phiếu đã duyệt chưa chi", async () => {
    await giaoDich(async () => {
      await chotThang("2026-09-01", TOA_1, { [CD1]: 100 });
      const a = await goi<KqUng>(GIU_SO, w1({ cd: CD1, tien: 30 }));
      expect(await goi<KqHuy>(CHU, sqlE6(a.voucher_id, khoa("huychu"), "PENDING"))).toMatchObject({ changed: true, balance_after: 100 });
      const b = await ungDaDuyet(20);
      expect(await soDuRong(CD1)).toBe(80);
      expect(await goi<KqHuy>(CHU, sqlE6(b.voucher_id, khoa("huychu"), "APPROVED_UNPOSTED")))
        .toMatchObject({ changed: true, cancellation_kind: "CANCELLED_UNPOSTED", balance_after: 100 });
    });
  });
  it("hai vế 'chính người nhận' tách riêng — từ 20261118171708 chỉ đăng nhập HIỆN TẠI tính: người lập là người nhận LÚC LẬP (đăng nhập của cổ đông gỡ sau đó) ⇒ null; người lập là đăng nhập HIỆN TẠI của cổ đông (người nhận lúc lập là người khác) ⇒ có số", async () => {
    await giaoDich(async () => {
      await chotThang("2026-09-01", TOA_1, { [CD_TU]: 40, [CD1]: 100 });
      // Vế 'lúc lập': cổ đông giữ sổ tự ứng, rồi đăng nhập của cổ đông bị gỡ — dòng sổ vẫn ghi người nhận lúc lập, nhưng
      // đăng nhập lúc lập không còn được thấy số dư (20261118143113 trả 40 ở đây). Người lập vẫn tự huỷ được phiếu chờ.
      const tu = await goi<KqUng>(TU_UNG, w1({ cd: CD_TU, tien: 15, so: SO_TU }));
      await db.exec(`UPDATE public.shareholders SET auth_user_id = NULL WHERE id = '${CD_TU}'`);
      expect(await dongSo(tu.voucher_id)).toMatchObject({ maker_kind: "CUSTODIAN_ADVANCE", payee_user_id: TU_UNG });
      expect(await goi<KqHuy>(TU_UNG, sqlE6(tu.voucher_id, khoa("huynhan"), "PENDING"))).toMatchObject({ changed: true, balance_after: null });
      expect(await nhatKyHuy(tu.voucher_id)).toEqual([{ balance_before: "25.00", balance_after: "40.00", actor_id: TU_UNG }]);
      // Vế 'hiện tại': người giữ sổ lập hộ CD1 (người nhận lúc lập là U_CD1), rồi đăng nhập của CD1 chuyển sang chính người giữ sổ.
      const ho = await goi<KqUng>(GIU_SO, w1({ cd: CD1, tien: 30 }));
      expect(await dongSo(ho.voucher_id)).toMatchObject({ maker_kind: "CUSTODIAN_FOR_PAYEE", payee_user_id: U_CD1 });
      await db.exec(`UPDATE public.shareholders SET auth_user_id = '${GIU_SO}' WHERE id = '${CD1}'`);
      expect(await goi<KqHuy>(GIU_SO, sqlE6(ho.voucher_id, khoa("huynhan"), "PENDING"))).toMatchObject({ changed: true, balance_after: 100 });
    });
  });
  it("lương điều hành (MANAGER) như cũ: chủ có quyền pay_manager huỷ ⇒ có số (chờ duyệt, gửi lại cùng khoá, nhánh đã huỷ; người lập tự huỷ cũng thế); người nhận lương không huỷ được phiếu chờ (42501 như cũ)", async () => {
    await giaoDich(async () => {
      await nenLuongDieuHanh();
      const a = await goi<{ voucher_id: string; balance_before: number }>(CHU, luongDieuHanh(50));
      expect(a.balance_before).toBe(200);
      laLoi(await loiGoi(QUAN_LY, sqlE6(a.voucher_id, khoa("huyql"), "PENDING")), "42501",
        "PROFIT_LEDGER_CANCEL_FORBIDDEN: cần quyền shareholder_profit.pay_manager");
      const k = khoa("huyql");
      const lan1 = await goi<KqHuy>(CHU2, sqlE6(a.voucher_id, k, "PENDING"));
      expect(lan1).toEqual({ voucher_id: a.voucher_id, changed: true, cancellation_kind: "CANCELLED_UNPOSTED", reversal_posting_id: null, balance_after: 200 });
      expect(await daLuuE6(k)).toEqual(lan1);
      expect(await goi<KqHuy>(CHU2, sqlE6(a.voucher_id, k, "PENDING"))).toEqual(lan1);
      expect(await goi<KqHuy>(CHU2, sqlE6(a.voucher_id, khoa("huyql"), null))).toEqual({ ...lan1, changed: false });
      const b = await goi<{ voucher_id: string }>(CHU, luongDieuHanh(30));
      expect(await goi<KqHuy>(CHU, sqlE6(b.voucher_id, khoa("huyql"), "PENDING"))).toMatchObject({ changed: true, balance_after: 200 });
      expect(await nhatKyHuy(b.voucher_id)).toEqual([{ balance_before: "170.00", balance_after: "200.00", actor_id: CHU }]);
    });
  });
  it("lương điều hành — hệ quả của luật che: người lập bị chặn quyền pay_manager sau khi lập vẫn tự huỷ được phiếu chờ của mình; không phải người nhận ⇒ null (nhật ký vẫn có số), là đăng nhập hiện tại của người nhận lương ⇒ có số", async () => {
    await giaoDich(async () => {
      await nenLuongDieuHanh();
      const c = await goi<{ voucher_id: string }>(CHU, luongDieuHanh(40));
      const d = await goi<{ voucher_id: string }>(CHU, luongDieuHanh(10));
      const f = await goi<{ voucher_id: string }>(CHU2, luongDieuHanh(5));
      await db.exec(`INSERT INTO app_private.tenant_emergency_denies VALUES ('${ORG_A}','shareholder_profit.pay_manager', now() - interval '1 hour', NULL)`);
      // Chặn có hiệu lực thật: phiếu chờ của người KHÁC thì CHU không huỷ được nữa.
      laLoi(await loiGoi(CHU, sqlE6(f.voucher_id, khoa("huyql"), "PENDING")), "42501", "PROFIT_LEDGER_CANCEL_FORBIDDEN");
      expect(await goi<KqHuy>(CHU, sqlE6(c.voucher_id, khoa("huyql"), "PENDING"))).toMatchObject({ changed: true, balance_after: null });
      expect(await nhatKyHuy(c.voucher_id)).toEqual([{ balance_before: "145.00", balance_after: "185.00", actor_id: CHU }]);
      await db.exec(`UPDATE public.profit_managers SET auth_user_id = '${CHU}' WHERE id = '${QL}'`);
      expect(await goi<KqHuy>(CHU, sqlE6(d.voucher_id, khoa("huyql"), "PENDING"))).toMatchObject({ changed: true, balance_after: 195 });
    });
  });
});

describe("20261118143113 — migration: chỉ đổi thân + COMMENT của E6, tiền kiểm md5, chạy lại", () => {
  it("[ghim] thân E6 của file = nguyên văn thân 20261115084015 (md5 production) + đúng bốn chỗ đổi; ngoài ra file chỉ tạo lại E6 và COMMENT; không mã lỗi lớp 40", () => {
    expect(md5(E6_CHAN.body)).toBe(MD5_E6_PROD);
    expect(md5(E6_HUY_CHE.body)).toBe(MD5_E6_CHE);
    // Gỡ bốn chỗ đổi ⇒ phải ra ĐÚNG thân production.
    const go = E6_HUY_CHE.body
      .replace("  v_see_numbers boolean;\n", "")
      .replace(/ {2}-- Số dư của chủ thể \(balance_after\)[\s\S]*?OR COALESCE\(v_has_p AND v_actor = v_p\.payee_user_id, false\);\n/, "")
      .replace("'balance_after', CASE WHEN v_see_numbers THEN\n        (app_private", "'balance_after', (app_private")
      .replace("->> 'balance')::numeric END);", "->> 'balance')::numeric);")
      .replace("'balance_after', CASE WHEN v_see_numbers THEN v_bal_after END);", "'balance_after', v_bal_after);");
    expect(go).toBe(E6_CHAN.body);
    // Phần đầu câu tạo (chữ ký, DEFAULT, volatility, DEFINER, search_path) giữ nguyên văn.
    const dauCau = (s: string) => s.slice(0, s.indexOf("AS $fn$"));
    expect(dauCau(E6_HUY_CHE.stmt)).toBe(dauCau(E6_CHAN.stmt));
    // Ngoài thân hàm và hai khối kiểm: chỉ tạo lại E6 + COMMENT của nó; không GRANT / REVOKE / ALTER / DROP / ghi dữ liệu.
    const ngoai = HUY_CHE.replace(/\$(fn|truoc|sau)\$[\s\S]*?\$\1\$/g, "").replace(/--[^\n]*/g, "");
    expect(ngoai.match(/\b(GRANT|REVOKE|ALTER|DROP|INSERT|UPDATE|DELETE|TRUNCATE|NOTIFY)\b/gi)).toBeNull();
    expect(ngoai.match(/\bCREATE\b[^(\n]*/gi)).toEqual([`CREATE OR REPLACE FUNCTION ${E6}`]);
    expect(ngoai.match(/\bCOMMENT ON\b[^(\n]*/gi)).toEqual([`COMMENT ON FUNCTION ${E6}`]);
    // COMMENT = COMMENT cũ của 20261115084015 + đúng một câu.
    const cm = (s: string) => s.slice(s.indexOf(`COMMENT ON FUNCTION ${E6}(uuid, text, text, text) IS`)).split("';\n")[0];
    expect(cm(HUY_CHE)).toBe(`${cm(CHAN)} balance_after chỉ trả cho người có quyền chi của loại chủ thể hoặc chính người nhận; người lập hộ nhận null.`);
    const MA_LOP_40 = /'40001'|'40P01'|'40\d{3}'|\bserialization_failure\b|\bdeadlock_detected\b|\bSQLSTATE\s+'40/i;
    expect(E6_HUY_CHE.body.replace(/--[^\n]*/g, " ")).not.toMatch(MA_LOP_40);
    expect(HUY_CHE.replace(/--[^\n]*/g, " ").split("USING ERRCODE = '").slice(1).map((x) => x.slice(0, 5)).filter((x) => x.startsWith("40"))).toEqual([]);
  });
  it("chỉ E6 đổi: md5 thân, ACL, chủ hàm, cấu hình, COMMENT của MỌI hàm khác (Đợt 1 + tạm ứng) giữ nguyên; E6 đổi đúng thân + COMMENT, ACL / chủ / cấu hình như trước; lượt hai không đổi gì", () => {
    const truoc = ghi.hamTruocHuyChe as Record<string, AnhHam>;
    const sau1 = ghi.hamHuyChe1 as Record<string, AnhHam>;
    // Chống xanh rỗng: ảnh chụp có đủ hàm của Đợt 1 và của migration tạm ứng.
    expect(Object.keys(truoc).length).toBeGreaterThan(100);
    for (const ten of [E6, "public.shareholder_profit_advance_v1", "public.shareholder_profit_settle_v1", "public.shareholder_profit_ledger_payout_v1",
      "app_private.profit_ledger_position_v1", "app_private.guard_profit_ledger_payout_v1", "app_private.profit_ledger_balance_v1"]) {
      expect(Object.keys(truoc).some((k) => k.startsWith(`${ten}(`)), ten).toBe(true);
    }
    const doi = [...new Set([...Object.keys(truoc), ...Object.keys(sau1)])].filter((k) => JSON.stringify(truoc[k]) !== JSON.stringify(sau1[k]));
    expect(doi).toEqual([E6_SIG]);
    expect(truoc[E6_SIG].md5).toBe(md5(E6_CHAN.body));
    expect(sau1[E6_SIG].md5).toBe(md5(E6_HUY_CHE.body));
    expect(sau1[E6_SIG].mo_ta).not.toBe(truoc[E6_SIG].mo_ta);
    expect({ ...sau1[E6_SIG], md5: "", mo_ta: "" }).toEqual({ ...truoc[E6_SIG], md5: "", mo_ta: "" });
    expect(sau1[E6_SIG]).toMatchObject({ vol: "v", definer: true, cfg: ["search_path=pg_catalog, app_private, public"] });
    expect(truoc[E6_SIG].acl).toMatch(/authenticated=X/);
    expect(ghi.hamHuyChe2).toEqual(sau1);
  });
  it("tiền kiểm: E6 đang chạy khác thân đã rà (đổi ngoài luồng) ⇒ 55000 nêu md5, không ghi gì; thiếu E6 ⇒ 55000; hậu kiểm bắt quyền gọi sai (anon gọi được) ⇒ 55000, không giữ gì", async () => {
    await giaoDich(async () => {
      const ngoaiLuong = E6_CHAN.stmt.replace("BEGIN\n  IF v_actor IS NULL THEN", "BEGIN\n  -- sửa tay ngoài luồng\n  IF v_actor IS NULL THEN");
      expect(ngoaiLuong).not.toBe(E6_CHAN.stmt);
      await db.exec(ngoaiLuong);
      const m = await md5E6();
      expect(m).not.toBe(md5(E6_CHAN.body));
      const moTa = `SELECT obj_description('${E6}(uuid,text,text,text)'::regprocedure, 'pg_proc') AS v`;
      const moTaTruoc = await mot<string>(moTa);
      expect(await loi(THAN_HUY_CHE)).toMatchObject({ code: "55000",
        message: `public.profit_ledger_payout_cancel_v1 KHÁC thân đã rà (md5 ${m}) — DỪNG, đối chiếu thân đang chạy rồi rà lại` });
      expect([await md5E6(), await mot<string>(moTa)]).toEqual([m, moTaTruoc]);
      // Về thân production rồi cho anon EXECUTE ⇒ tiền kiểm qua, hậu kiểm dừng; không giữ gì (thân vẫn là bản production).
      await db.exec(E6_CHAN.stmt);
      await db.exec(`GRANT EXECUTE ON FUNCTION ${E6}(uuid, text, text, text) TO anon`);
      expect(await loi(THAN_HUY_CHE)).toMatchObject({ code: "55000", message: expect.stringContaining("Hậu kiểm: quyền gọi public.profit_ledger_payout_cancel_v1") });
      expect(await md5E6()).toBe(md5(E6_CHAN.body));
      await db.exec(`DROP FUNCTION ${E6}(uuid, text, text, text)`);
      expect(await loi(THAN_HUY_CHE)).toMatchObject({ code: "55000", message: expect.stringContaining("Thiếu public.profit_ledger_payout_cancel_v1(uuid, text, text, text)") });
    });
  });
  it("chạy như lane: trên nền vừa áp migration tạm ứng, dán thân HAI lần trong MỘT giao dịch rồi ROLLBACK ⇒ mọi hàm như trước (E6 = thân production); COMMIT một lượt rồi chạy lại cả file ⇒ thân che, ACL như trước", async () => {
    const lan = new PGlite({ loadDataDir: nenTruocMigration });
    try {
      await lan.exec(MIGRATION);
      const truoc = await chupHam(lan);
      expect(await md5E6(lan)).toBe(md5(E6_CHAN.body));
      expect(THAN_HUY_CHE).not.toMatch(/^(BEGIN|COMMIT);/m);
      await lan.exec(`BEGIN; ${THAN_HUY_CHE} ${THAN_HUY_CHE} ROLLBACK;`);
      expect(await chupHam(lan)).toEqual(truoc);
      await lan.exec(HUY_CHE);
      await lan.exec(HUY_CHE);
      expect(await md5E6(lan)).toBe(md5(E6_HUY_CHE.body));
      expect((await chupHam(lan))[E6_SIG].acl).toBe(truoc[E6_SIG].acl);
    } finally { await lan.close(); }
  }, 300000);
});

// ── 20261118171708: dọn dẹp sau tạm ứng — thu quyền E4 / E5, E6 bỏ vế "đăng nhập lúc lập", R4 che DETAIL của DRIFT ──
const quyenGoi = (ham: string, vai = "authenticated", d: PGlite = db) =>
  d.query<{ v: boolean }>(`SELECT has_function_privilege('${vai}', '${ham}'::regprocedure, 'EXECUTE') AS v`).then((r) => r.rows[0].v);
const md5Ham = (ham: string, d: PGlite = db) =>
  d.query<{ v: string }>(`SELECT md5(replace(p.prosrc, chr(13), '')) AS v FROM pg_proc p WHERE p.oid = '${ham}'::regprocedure`).then((r) => r.rows[0].v);

describe("20261118171708 — E4 / E5: authenticated không còn gọi được lệnh cũ chi lợi nhuận theo số nhập tay", () => {
  it("authenticated gọi E4 / E5 ⇒ 42501 permission denied (chủ có quyền chi lợi nhuận, cổ đông giữ sổ có quyền tạm ứng), anon / service_role cũng vậy; không ghi gì", async () => {
    await giaoDich(async () => {
      await chotThang("2026-09-01", TOA_1, { [CD1]: 100, [CD_CHU]: 50, [CD_TU]: 40 });
      const bang = ["public.income_expenses", "public.income_expense_items", "public.approval_requests", "app_private.profit_ledger_payouts",
        "app_private.profit_ledger_events", "app_private.canonical_write_operations", "app_private.server_feature_flag_operations"];
      const demHet = async () => { const out: number[] = []; for (const b of bang) out.push(await dem(b)); return out; };
      const truoc = await demHet();
      const thu: [string, string, string][] = [
        [CHU, e5(CD1, 20, false), "shareholder_profit_ledger_payout_v1"],
        [CHU, e5(CD_CHU, 10, true), "shareholder_profit_ledger_payout_v1"],
        [TU_UNG, e5(CD_TU, 5, true, SO_TU), "shareholder_profit_ledger_payout_v1"],
        [CHU, e4(CD1, 20, SO_QUY), "shareholder_profit_payout_preview_v1"],
        [TU_UNG, e4(CD_TU, null, null), "shareholder_profit_payout_preview_v1"],
      ];
      for (const vai of ["authenticated", "anon", "service_role"]) {
        for (const [ai, sql, ham] of thu) {
          expect(await loiGoi(ai, sql, vai), `${vai} ${ai} ${sql.slice(14, 70)}`)
            .toMatchObject({ code: "42501", message: `permission denied for function ${ham}`, detail: null });
        }
      }
      expect(await demHet()).toEqual(truoc);
      for (const ham of [E4_REGPROC, E5_REGPROC]) {
        for (const vai of ["authenticated", "anon", "service_role"]) expect(await quyenGoi(ham, vai), `${vai} ${ham}`).toBe(false);
      }
      // Lệnh mới thay thế vẫn mở cho authenticated (đối chứng: thu đúng hai lệnh cũ).
      expect(await goi<KqUng>(TU_UNG, w1({ cd: CD_TU, tien: 5, so: SO_TU }))).toMatchObject({ maker_kind: "CUSTODIAN_ADVANCE", state: "PENDING_APPROVAL" });
    });
  });
  it("chủ hàm và một hàm DEFINER khác vẫn gọi được như trước khi thu quyền: E4 xem trước, E5 lập phiếu (OWNER, chờ duyệt) — thân E5 không đổi", async () => {
    await giaoDich(async () => {
      await chotThang("2026-09-01", TOA_1, { [CD1]: 100 });
      // Vai chủ hàm, auth.uid() = chủ có quyền chi lợi nhuận.
      await dangNhap(CHU);
      expect(await mot<Record<string, unknown>>(e4(CD1, 20, SO_QUY))).toMatchObject({ shareholder_id: CD1, maker_kind: "OWNER", balance_before: 100,
        within_amount: 20, advance_amount: 0, can_submit: true });
      const kq = await e5Cu(CHU, e5(CD1, 20, false));
      expect(kq).toMatchObject({ maker_kind: "OWNER", within_amount: 20, advance_amount: 0 });
      expect(await phieu(kq.voucher_id)).toMatchObject({ approval_status: "UNAPPROVED", system_source: "profit.ledger_payout" });
      // Một hàm DEFINER khác (cùng chủ với E5) mở cho authenticated và gọi E5 bên trong: revoke không chặn đường đó.
      await db.exec(`CREATE FUNCTION public.test_e5_qua_definer(p_cd uuid, p_tien numeric, p_khoa text) RETURNS jsonb
          LANGUAGE sql SECURITY DEFINER SET search_path TO 'pg_catalog', 'public'
          AS $x$ SELECT public.shareholder_profit_ledger_payout_v1(p_cd, p_tien, '${SO_QUY}'::uuid, '${NGAY}'::date, NULL, false, p_khoa) $x$;
        REVOKE ALL ON FUNCTION public.test_e5_qua_definer(uuid, numeric, text) FROM PUBLIC;
        GRANT EXECUTE ON FUNCTION public.test_e5_qua_definer(uuid, numeric, text) TO authenticated;`);
      expect(await goi<KqUng>(CHU, `SELECT public.test_e5_qua_definer('${CD1}', 15, '${khoa("e5def")}') AS v`))
        .toMatchObject({ maker_kind: "OWNER", within_amount: 15, advance_amount: 0 });
      expect(await soDuRong(CD1)).toBe(65);
      expect(await md5Ham(E5_REGPROC)).toBe(MD5_E5_GOC);
    });
  });
});

describe("20261118171708 — E6: số dư chỉ cho người có quyền chi hoặc đăng nhập HIỆN TẠI của người nhận (đăng nhập lúc lập không còn tính)", () => {
  it("tài khoản CŨ của cổ đông (cổ đông đã gắn sang tài khoản khác, tài khoản cũ vẫn là thành viên) gọi lại E6 trên phiếu đã huỷ bằng khoá mới ⇒ balance_after null; khoá cũ ⇒ đúng kết quả đã lưu; người có quyền chi ⇒ số dư hiện tại", async () => {
    await giaoDich(async () => {
      await chotThang("2026-09-01", TOA_1, { [CD_TU]: 40 });
      // Cổ đông giữ sổ tự ứng rồi tự huỷ phiếu chờ khi CÒN là đăng nhập của cổ đông ⇒ thấy số (bản lưu để phát lại cũng có số).
      const tu = await goi<KqUng>(TU_UNG, w1({ cd: CD_TU, tien: 15, so: SO_TU }));
      expect(await dongSo(tu.voucher_id)).toMatchObject({ maker_kind: "CUSTODIAN_ADVANCE", payee_user_id: TU_UNG });
      const k1 = khoa("huycu");
      const lan1 = await goi<KqHuy>(TU_UNG, sqlE6(tu.voucher_id, k1, "PENDING"));
      expect(lan1).toEqual({ voucher_id: tu.voucher_id, changed: true, cancellation_kind: "CANCELLED_UNPOSTED", reversal_posting_id: null, balance_after: 40 });
      // Cổ đông gắn sang tài khoản khác; tài khoản cũ vẫn là thành viên ACTIVE. Số dư hiện tại đổi (thêm phân bổ tháng 10).
      await db.exec(`UPDATE public.shareholders SET auth_user_id = '${KHONG_GIU}' WHERE id = '${CD_TU}'`);
      expect(await dem("public.organization_memberships", `user_id = '${TU_UNG}' AND organization_id = '${ORG_A}' AND status = 'ACTIVE'`)).toBe(1);
      await chotThang("2026-10-01", TOA_1, { [CD_TU]: 5 });
      expect(await soDuRong(CD_TU)).toBe(45);
      // Tài khoản cũ, khoá MỚI ⇒ nhánh "đã huỷ từ trước": null, cả bản lưu (20261118143113 trả 45 ở đây — vế "lúc lập").
      const moi = khoa("huycu");
      expect(await goi<KqHuy>(TU_UNG, sqlE6(tu.voucher_id, moi, null))).toEqual({ ...lan1, changed: false, balance_after: null });
      expect(await daLuuE6(moi)).toEqual({ ...lan1, changed: false, balance_after: null });
      // Khoá CŨ ⇒ phát lại đúng kết quả đã lưu lúc còn là người nhận (không đọc lại số dư hiện tại).
      expect(await goi<KqHuy>(TU_UNG, sqlE6(tu.voucher_id, k1, "PENDING"))).toEqual(lan1);
      // Người có quyền chi lợi nhuận ⇒ số dư HIỆN TẠI.
      expect(await goi<KqHuy>(CHU, sqlE6(tu.voucher_id, khoa("huycu"), null))).toEqual({ ...lan1, changed: false, balance_after: 45 });
    });
  });
  it("đăng nhập HIỆN TẠI của cổ đông là người lập ⇒ có số; người nhận LÚC LẬP không lập phiếu, không có quyền chi ⇒ không gọi được (42501 như cũ); người giữ sổ lập hộ ⇒ null như cũ", async () => {
    await giaoDich(async () => {
      await chotThang("2026-09-01", TOA_1, { [CD1]: 100, [CD_R1]: 60 });
      // Người giữ sổ lập hộ CD1 (người nhận lúc lập là U_CD1) rồi tự huỷ phiếu chờ ⇒ null, cả nhánh đã huỷ.
      const ho = await goi<KqUng>(GIU_SO, w1({ cd: CD1, tien: 30 }));
      expect(await dongSo(ho.voucher_id)).toMatchObject({ maker_kind: "CUSTODIAN_FOR_PAYEE", payee_user_id: U_CD1 });
      const lan1 = await goi<KqHuy>(GIU_SO, sqlE6(ho.voucher_id, khoa("huyhien"), "PENDING"));
      expect(lan1).toMatchObject({ changed: true, balance_after: null });
      expect(await goi<KqHuy>(GIU_SO, sqlE6(ho.voucher_id, khoa("huyhien"), null))).toEqual({ ...lan1, changed: false });
      // Người nhận lúc lập (U_CD1: không lập phiếu, không có quyền chi) ⇒ 42501, DETAIL chỉ có tên quyền.
      const l = laLoi(await loiGoi(U_CD1, sqlE6(ho.voucher_id, khoa("huyhien"), null)), "42501", "PROFIT_LEDGER_CANCEL_FORBIDDEN");
      expect(chiTiet(l)).toEqual({ permission: "shareholder_profit.distribute" });
      // Đăng nhập của CD1 chuyển sang chính người giữ sổ ⇒ người lập giờ là đăng nhập HIỆN TẠI của cổ đông ⇒ có số.
      await db.exec(`UPDATE public.shareholders SET auth_user_id = '${GIU_SO}' WHERE id = '${CD1}'`);
      expect(await goi<KqHuy>(GIU_SO, sqlE6(ho.voucher_id, khoa("huyhien"), null))).toEqual({ ...lan1, changed: false, balance_after: 100 });
      // Lập hộ cho cổ đông KHÁC (CD_R1) vẫn null.
      const khac = await goi<KqUng>(GIU_SO, w1({ cd: CD_R1, tien: 10 }));
      expect(await goi<KqHuy>(GIU_SO, sqlE6(khac.voucher_id, khoa("huyhien"), "PENDING"))).toMatchObject({ changed: true, balance_after: null });
    });
  });
  it("phiếu đã duyệt: người nhận không tự huỷ — vẫn chặn CẢ đăng nhập lúc lập lẫn đăng nhập hiện tại (42501 PROFIT_LEDGER_CANCEL_PAYEE) dù cả hai có quyền chi; chủ khác huỷ ⇒ có số", async () => {
    await giaoDich(async () => {
      await chotThang("2026-09-01", TOA_1, { [CD_CHU]: 50 });
      const kq = await goi<KqUng>(CHU, w1({ cd: CD_CHU, tien: 20, so: SO_QUY }));
      expect(await dongSo(kq.voucher_id)).toMatchObject({ maker_kind: "CUSTODIAN_ADVANCE", payee_user_id: CHU });
      expect(await duyet(kq.voucher_id, CHU2)).toBeNull();
      laLoi(await loiGoi(CHU, sqlE6(kq.voucher_id, khoa("huyduyet"), "APPROVED_UNPOSTED")), "42501", "PROFIT_LEDGER_CANCEL_PAYEE");
      // Cổ đông gắn sang đăng nhập khác (CHU3 — cũng có quyền chi lợi nhuận).
      await db.exec(`UPDATE public.shareholders SET auth_user_id = '${CHU3}' WHERE id = '${CD_CHU}'`);
      for (const ai of [CHU, CHU3]) {
        laLoi(await loiGoi(ai, sqlE6(kq.voucher_id, khoa("huyduyet"), "APPROVED_UNPOSTED")), "42501", "PROFIT_LEDGER_CANCEL_PAYEE");
      }
      expect(await phieu(kq.voucher_id)).toMatchObject({ approval_status: "APPROVED" });
      expect(await goi<KqHuy>(CHU2, sqlE6(kq.voucher_id, khoa("huyduyet"), "APPROVED_UNPOSTED")))
        .toMatchObject({ changed: true, cancellation_kind: "CANCELLED_UNPOSTED", balance_after: 50 });
    });
  });
});

describe("20261118171708 — R4: lỗi lệch bất biến không mang số của cổ đông cho người không được thấy số", () => {
  const position = dinhNghiaCuoi("app_private.profit_ledger_position_v1");
  // Hai migration quỹ bổ sung nguồn dữ liệu cho vị thế. Chỉ áp trong giao dịch của ca
  // kiểm lớp che lỗi R4; các ca phát lại migration lịch sử vẫn chạy trên nền của chính chúng.
  async function napViTheHienHanh() {
    await db.exec("ALTER TABLE public.organization_memberships ADD COLUMN member_type text NOT NULL DEFAULT 'STAFF'");
    for (const file of [
      "20261120040328_phan_phoi_quy_chung.sql", TEN_SO_QUY,
    ]) {
      const sql = readFileSync(`${DIR}/${file}`, "utf8").replace(/^BEGIN;\s*$/m, "").replace(/^COMMIT;\s*$/m, "");
      await db.exec(sql);
    }
    // Nếu một forward-fix thay vị thế/R4, thực thi định nghĩa cuối rồi đo chính hàm đã nạp.
    for (const [signature, def] of [
      ["app_private.profit_ledger_position_v1(uuid,uuid)", position],
      ["public.shareholder_profit_advance_preview_v1(uuid,numeric,uuid)", dinhNghiaCuoi(R4)],
    ] as const) {
      await db.exec(def.stmt);
      expect(await md5Ham(signature)).toBe(md5(def.body));
    }
  }
  /** Ép lệch bất biến: chủ chốt chi hết tháng 9 của CD1 (phiếu tiền 100 chờ duyệt), rồi sửa thẳng bản ghi chốt (tắt chốt
   *  của bảng trong giao dịch thử) ⇒ tiền chốt chờ duyệt 107 > phiếu chi chờ duyệt 100 ⇒ profit_ledger_position_v1 ném DRIFT. */
  async function epLech() {
    await chotThang("2026-09-01", TOA_1, { [CD1]: 100 });
    const chot = await goi<KqChot>(CHU, w2({ cd: CD1, thang: "2026-09-01", tien: 100 }));
    expect(chot).toMatchObject({ recognized_amount: 100, cash_amount: 100, state: "PENDING_APPROVAL" });
    expect(await loiGoi(GIU_SO, r4(CD1, 10, SO_GIU))).toBeNull();
    await db.exec(`ALTER TABLE ${C7} DISABLE TRIGGER a00_profit_ledger_payout_settlements_guard;
      UPDATE ${C7} SET cash_amount = cash_amount + 7, recognized_amount = recognized_amount + 7 WHERE id = '${chot.settlement_id}';
      ALTER TABLE ${C7} ENABLE TRIGGER a00_profit_ledger_payout_settlements_guard;`);
    // Đối chứng: đọc thẳng vị thế (vai chủ bảng) ⇒ DRIFT kèm DETAIL đủ số.
    const goc = laLoi(await loi(`SELECT app_private.profit_ledger_position_v1('${ORG_A}','${CD1}')`), "XX000", "PROFIT_LEDGER_POSITION_DRIFT");
    expect(goc.message).toBe(CAU_DRIFT);
    expect(chiTiet(goc)).toMatchObject({ balance: 0, payouts_pending: 100, cash_pending: 107, recognized: 107, offset: 0 });
    return goc;
  }
  it("ép lệch bất biến: người giữ sổ lập hộ, thành viên không giữ sổ, người chỉ quản lý cổ đông, cổ đông khác ⇒ XX000 PROFIT_LEDGER_POSITION_DRIFT cùng câu, KHÔNG DETAIL; người có quyền chi lợi nhuận và chính người nhận có quyền tạm ứng ⇒ nguyên lỗi, có DETAIL", async () => {
    await giaoDich(async () => {
      await napViTheHienHanh();
      const goc = await epLech();
      const khongThay: [string, string | null][] = [[GIU_SO, SO_GIU], [GIU_SO, null], [TU_UNG, SO_TU], [KHONG_GIU, null], [QUAN_LY, null],
        [U_CD2, null], [U_XEM, null]];
      for (const [ai, so] of khongThay) {
        expect(await loiGoi(ai, r4(CD1, 10, so)), `${ai} ${so}`).toEqual({ code: "XX000", message: CAU_DRIFT, detail: null, hint: null });
        expect(await loiGoi(ai, r4(CD1, null, null)), `${ai} không số tiền`).toEqual({ code: "XX000", message: CAU_DRIFT, detail: null, hint: null });
      }
      for (const [ai, so] of [[CHU, SO_QUY], [CHU, null], [CHU2, null], [U_CD1, null]] as [string, string | null][]) {
        expect(await loiGoi(ai, r4(CD1, 10, so)), `${ai} ${so}`).toEqual(goc);
      }
      // Cổ đông khác của cùng công ty (không lệch) vẫn xem trước bình thường.
      expect(await goi(GIU_SO, r4(CD2, 10, SO_GIU))).toMatchObject({ shareholder_id: CD2, position: null });
    });
  });
  it("lỗi khác lúc đọc vị thế ném nguyên (cả DETAIL / HINT) cho mọi người gọi: XX000 câu khác, mã khác cùng câu DRIFT; chỉ đúng XX000 + câu mở đầu 'PROFIT_LEDGER_POSITION_DRIFT:' mới bị bỏ DETAIL với người không được thấy số", async () => {
    await giaoDich(async () => {
      await napViTheHienHanh();
      await chotThang("2026-09-01", TOA_1, { [CD1]: 100 });
      // Giữ chữ ký/quyền/cấu hình hàm thật. Chỉ thay thân để ép các mã lỗi không phát sinh từ dữ liệu hợp lệ.
      const thay = (ma: string, cau: string) => db.exec(position.stmt.replace(position.body, () =>
        ` BEGIN RAISE EXCEPTION '${cau}' USING ERRCODE = '${ma}', DETAIL = '{"so_cua_co_dong": 123}', HINT = 'báo kỹ thuật'; END `));
      const nguyen = (ma: string, cau: string) => ({ code: ma, message: cau, detail: '{"so_cua_co_dong": 123}', hint: "báo kỹ thuật" });
      for (const [ma, cau] of [["XX000", "LOI_KHAC: thử lỗi nội bộ khác"], ["P0001", "PROFIT_LEDGER_POSITION_DRIFT: cùng câu nhưng mã khác"],
        ["XX000", "PROFIT_LEDGER_POSITION_DRIFTX: gần giống"], ["XX000", "Lỗi: PROFIT_LEDGER_POSITION_DRIFT: không ở đầu câu"]]) {
        await thay(ma, cau);
        for (const ai of [GIU_SO, KHONG_GIU, CHU]) expect(await loiGoi(ai, r4(CD1, 10, null)), `${ai} ${ma} ${cau}`).toEqual(nguyen(ma, cau));
      }
      await thay("XX000", "PROFIT_LEDGER_POSITION_DRIFT: thử");
      for (const ai of [GIU_SO, KHONG_GIU]) {
        expect(await loiGoi(ai, r4(CD1, 10, null)), ai).toEqual({ code: "XX000", message: "PROFIT_LEDGER_POSITION_DRIFT: thử", detail: null, hint: null });
      }
      expect(await loiGoi(CHU, r4(CD1, 10, null))).toEqual(nguyen("XX000", "PROFIT_LEDGER_POSITION_DRIFT: thử"));
    });
  });
});

describe("20261118171708 — migration: chỉ ACL E4 / E5 và thân + COMMENT E6 / R4 đổi, tiền kiểm md5, chạy lại", () => {
  const dauCau = (s: string) => s.slice(0, s.indexOf("AS $fn$"));
  const boChuThich = (s: string) => s.replace(/^\s*--[^\n]*\n/gm, "");
  it("[ghim] E6 = nguyên văn 20261118143113 trừ đúng phép gán v_see_numbers (+ chú thích ngay trên); R4 = nguyên văn 20261118041911 trừ đúng phần bọc lời gọi vị thế; ngoài thân và hai khối kiểm chỉ có hai REVOKE … FROM authenticated, hai CREATE OR REPLACE, hai COMMENT; md5 ghim khớp thân; không mã lỗi lớp 40", () => {
    expect(md5(E6_HUY_CHE.body)).toBe(MD5_E6_CHE);
    expect(md5(R4_TAM_UNG.body)).toBe(MD5_R4_PROD);
    // E6: khối từ chú thích "Số dư của chủ thể" tới hết phép gán.
    const khoiE6 = (s: string) => { const a = s.indexOf("  -- Số dư của chủ thể (balance_after)"); return s.slice(a, s.indexOf(";\n", a) + 2); };
    const cuE6 = khoiE6(E6_HUY_CHE.body);
    const moiE6 = khoiE6(E6_DON_DEP.body);
    expect(E6_DON_DEP.body.replace(moiE6, cuE6)).toBe(E6_HUY_CHE.body);
    expect(boChuThich(moiE6)).toBe(boChuThich(cuE6).replace(", false)\n    OR COALESCE(v_has_p AND v_actor = v_p.payee_user_id, false);\n", ", false);\n"));
    expect(boChuThich(cuE6)).toContain("v_p.payee_user_id");
    expect(dauCau(E6_DON_DEP.stmt)).toBe(dauCau(E6_HUY_CHE.stmt));
    // Nhánh phiếu đã duyệt vẫn chặn theo CẢ hai đăng nhập.
    expect(E6_DON_DEP.body).toContain("IF v_actor = v_payee_now OR (v_has_p AND v_actor = v_p.payee_user_id) THEN");
    // R4: phần bọc thay đúng một dòng gọi vị thế.
    const a = R4_DON_DEP.body.indexOf("  -- Bất biến số dư lệch");
    const boc = R4_DON_DEP.body.slice(a, R4_DON_DEP.body.indexOf("  END;\n", a) + "  END;\n".length);
    expect(R4_DON_DEP.body.replace(boc, "  v_pos := app_private.profit_ledger_position_v1(v_sh.organization_id, p_shareholder_id);\n")).toBe(R4_TAM_UNG.body);
    expect(boChuThich(boc)).toBe(`  BEGIN
    v_pos := app_private.profit_ledger_position_v1(v_sh.organization_id, p_shareholder_id);
  EXCEPTION WHEN internal_error THEN
    IF v_see_numbers OR NOT starts_with(SQLERRM, 'PROFIT_LEDGER_POSITION_DRIFT:') THEN
      RAISE;
    END IF;
    RAISE EXCEPTION USING ERRCODE = 'XX000', MESSAGE = SQLERRM;
  END;
`);
    expect(dauCau(R4_DON_DEP.stmt)).toBe(dauCau(R4_TAM_UNG.stmt));
    // Ngoài thân hàm và hai khối kiểm.
    const ngoai = DON_DEP.replace(/\$(fn|truoc|sau)\$[\s\S]*?\$\1\$/g, "").replace(/--[^\n]*/g, "");
    expect(ngoai.match(/\b(GRANT|ALTER|DROP|INSERT|UPDATE|DELETE|TRUNCATE)\b/gi)).toBeNull();
    expect(ngoai.match(/\bREVOKE\b[^;]*;/gi)?.map((x) => x.replace(/\s+/g, " "))).toEqual([
      "REVOKE EXECUTE ON FUNCTION public.shareholder_profit_payout_preview_v1(uuid, numeric, uuid) FROM authenticated;",
      "REVOKE EXECUTE ON FUNCTION public.shareholder_profit_ledger_payout_v1(uuid, numeric, uuid, date, text, boolean, text) FROM authenticated;"]);
    expect(ngoai.match(/\bCREATE\b[^(\n]*/gi)).toEqual([`CREATE OR REPLACE FUNCTION ${E6}`, `CREATE OR REPLACE FUNCTION ${R4}`]);
    expect(ngoai.match(/\bCOMMENT ON\b[^(\n]*/gi)).toEqual([`COMMENT ON FUNCTION ${E6}`, `COMMENT ON FUNCTION ${R4}`]);
    expect(ngoai.match(/\bNOTIFY\b[^\n]*/gi)).toEqual(["NOTIFY pgrst, 'reload schema';"]);
    // COMMENT: E6 đổi đúng câu về balance_after; R4 thêm đúng một câu.
    const cm = (s: string, ham: string) => s.slice(s.indexOf(`COMMENT ON FUNCTION ${ham}`)).split("';\n")[0].split(" IS\n  '")[1];
    expect(cm(DON_DEP, `${E6}(uuid, text, text, text)`)).toBe(cm(HUY_CHE, `${E6}(uuid, text, text, text)`).replace(
      "hoặc chính người nhận; người lập hộ nhận null.", "hoặc chính người nhận theo đăng nhập hiện tại (đăng nhập lúc lập không tính); người lập hộ nhận null."));
    expect(cm(DON_DEP, `${R4}(uuid, numeric, uuid)`)).toBe(`${cm(MIGRATION, `${R4}(uuid, numeric, uuid)`)} Bất biến số dư lệch (XX000 PROFIT_LEDGER_POSITION_DRIFT): người không được thấy số chỉ nhận mã + câu, không DETAIL.`);
    // md5 ghim trong file: tiền kiểm nhận (production, bản của file), hậu kiểm đòi bản của file.
    expect(DON_DEP).toContain(`NOT IN ('${MD5_E6_CHE}', '${md5(E6_DON_DEP.body)}')`);
    expect(DON_DEP).toContain(`NOT IN ('${MD5_R4_PROD}', '${md5(R4_DON_DEP.body)}')`);
    expect(DON_DEP).toContain(`IS DISTINCT FROM '${md5(E6_DON_DEP.body)}' THEN`);
    expect(DON_DEP).toContain(`IS DISTINCT FROM '${md5(R4_DON_DEP.body)}' THEN`);
    const MA_LOP_40 = /'40001'|'40P01'|'40\d{3}'|\bserialization_failure\b|\bdeadlock_detected\b|\bSQLSTATE\s+'40/i;
    expect(DON_DEP.replace(/--[^\n]*/g, " ")).not.toMatch(MA_LOP_40);
    expect(DON_DEP.replace(/--[^\n]*/g, " ").split("ERRCODE = '").slice(1).map((x) => x.slice(0, 5)).filter((x) => x.startsWith("40"))).toEqual([]);
  });
  it("chỉ bốn hàm đổi: E4 / E5 mất ĐÚNG mục ACL của authenticated (thân, chủ, cấu hình, COMMENT, mục ACL khác giữ nguyên); E6 / R4 đổi thân + COMMENT (ACL / chủ / cấu hình như trước); mọi hàm khác giữ nguyên; lượt hai không đổi gì", () => {
    const truoc = ghi.hamTruocDonDep as Record<string, AnhHam>;
    const sau1 = ghi.hamDonDep1 as Record<string, AnhHam>;
    expect(Object.keys(truoc).length).toBeGreaterThan(100);
    const kE4 = Object.keys(truoc).find((k) => k.startsWith("public.shareholder_profit_payout_preview_v1(")) as string;
    const kE5 = Object.keys(truoc).find((k) => k.startsWith("public.shareholder_profit_ledger_payout_v1(")) as string;
    expect(kE4 && kE5).toBeTruthy();
    const doi = [...new Set([...Object.keys(truoc), ...Object.keys(sau1)])].filter((k) => JSON.stringify(truoc[k]) !== JSON.stringify(sau1[k]));
    expect(doi.sort()).toEqual([E6_SIG, R4_SIG, kE4, kE5].sort());
    for (const k of [kE4, kE5]) {
      expect(truoc[k].acl, k).toMatch(/,authenticated=X\/postgres\b/);
      expect(sau1[k].acl, k).toBe((truoc[k].acl as string).replace(",authenticated=X/postgres", ""));
      expect(sau1[k].acl, k).not.toMatch(/authenticated/);
      expect({ ...sau1[k], acl: "" }).toEqual({ ...truoc[k], acl: "" });
    }
    expect(truoc[kE5].md5).toBe(MD5_E5_GOC);
    for (const k of [E6_SIG, R4_SIG]) {
      expect({ ...sau1[k], md5: "", mo_ta: "" }, k).toEqual({ ...truoc[k], md5: "", mo_ta: "" });
      expect(sau1[k].mo_ta, k).not.toBe(truoc[k].mo_ta);
      expect(sau1[k].acl, k).toMatch(/authenticated=X/);
      expect(sau1[k]).toMatchObject({ vol: "v", definer: true, cfg: ["search_path=pg_catalog, app_private, public"] });
    }
    expect([truoc[E6_SIG].md5, sau1[E6_SIG].md5]).toEqual([MD5_E6_CHE, md5(E6_DON_DEP.body)]);
    expect([truoc[R4_SIG].md5, sau1[R4_SIG].md5]).toEqual([MD5_R4_PROD, md5(R4_DON_DEP.body)]);
    expect(ghi.hamDonDep2).toEqual(sau1);
  });
  it("tiền kiểm: E6 / R4 đang chạy khác thân đã rà ⇒ 55000 nêu md5, không ghi gì; thiếu hàm ⇒ 55000; hậu kiểm: authenticated còn gọi được E5 qua PUBLIC ⇒ 55000, không giữ gì; trên đúng thân production thì qua, chạy lại cũng qua", async () => {
    await giaoDich(async () => {
      // Về trạng thái TRƯỚC file này (như production 18/11/2026): E4 / E5 mở cho authenticated, E6 / R4 thân production.
      await db.exec(`${E6_HUY_CHE.stmt}
        ${R4_TAM_UNG.stmt}
        GRANT EXECUTE ON FUNCTION public.shareholder_profit_payout_preview_v1(uuid, numeric, uuid) TO authenticated;
        GRANT EXECUTE ON FUNCTION public.shareholder_profit_ledger_payout_v1(uuid, numeric, uuid, date, text, boolean, text) TO authenticated;`);
      const goc = await chupHam();
      expect(goc[R4_SIG].md5).toBe(MD5_R4_PROD);
      const ngoaiLuong = (stmt: string) => stmt.replace("BEGIN\n  IF v_actor IS NULL THEN", "BEGIN\n  -- sửa tay ngoài luồng\n  IF v_actor IS NULL THEN");
      for (const [ham, cau, tra] of [[E6, E6_HUY_CHE.stmt, E6_HUY_CHE.stmt], [R4, R4_TAM_UNG.stmt, R4_TAM_UNG.stmt]]) {
        expect(ngoaiLuong(cau)).not.toBe(cau);
        await db.exec(ngoaiLuong(cau));
        const truoc = await chupHam();
        const m = (truoc[ham === E6 ? E6_SIG : R4_SIG]).md5;
        expect(await loi(THAN_DON_DEP), ham).toMatchObject({ code: "55000",
          message: `${ham} KHÁC thân đã rà (md5 ${m}) — DỪNG, đối chiếu thân đang chạy rồi rà lại` });
        expect(await chupHam()).toEqual(truoc);
        await db.exec(tra);
      }
      expect(await chupHam()).toEqual(goc);
      // Hậu kiểm: E5 mở cho PUBLIC ⇒ sau REVOKE … FROM authenticated vẫn gọi được ⇒ 55000, không giữ gì.
      await db.exec(`GRANT EXECUTE ON FUNCTION ${E5_REGPROC.replace(/,/g, ", ")} TO PUBLIC`);
      const coPublic = await chupHam();
      expect(await loi(THAN_DON_DEP)).toMatchObject({ code: "55000", message: expect.stringContaining("Hậu kiểm: authenticated (hoặc anon) vẫn gọi được") });
      expect(await chupHam()).toEqual(coPublic);
      await db.exec(`REVOKE EXECUTE ON FUNCTION ${E5_REGPROC.replace(/,/g, ", ")} FROM PUBLIC`);
      expect(await chupHam()).toEqual(goc);
      // Đúng thân production ⇒ qua; chạy lại ⇒ qua, không đổi gì thêm.
      expect(await loi(THAN_DON_DEP)).toBeNull();
      const sau = await chupHam();
      expect(await loi(THAN_DON_DEP)).toBeNull();
      expect(await chupHam()).toEqual(sau);
      expect(sau[E6_SIG].md5).toBe(md5(E6_DON_DEP.body));
      expect(sau[R4_SIG].md5).toBe(md5(R4_DON_DEP.body));
      expect([await quyenGoi(E4_REGPROC), await quyenGoi(E5_REGPROC)]).toEqual([false, false]);
      // Thiếu hàm ⇒ 55000 nêu hàm thiếu.
      await db.exec(`DROP FUNCTION ${E4_REGPROC.replace(/,/g, ", ")}`);
      expect(await loi(THAN_DON_DEP)).toMatchObject({ code: "55000", message: expect.stringContaining("Thiếu public.shareholder_profit_payout_preview_v1(uuid, numeric, uuid)") });
    });
  });
  it("chạy như lane: trên nền vừa áp 20261118143113, dán thân HAI lần trong MỘT giao dịch rồi ROLLBACK ⇒ mọi hàm như trước; COMMIT một lượt rồi chạy lại cả file ⇒ E4 / E5 hết quyền của authenticated, E6 / R4 thân mới, ACL E6 / R4 như trước", async () => {
    const lan = new PGlite({ loadDataDir: nenTruocMigration });
    try {
      await lan.exec(MIGRATION);
      await lan.exec(HUY_CHE);
      const truoc = await chupHam(lan);
      expect([await quyenGoi(E4_REGPROC, "authenticated", lan), await quyenGoi(E5_REGPROC, "authenticated", lan)]).toEqual([true, true]);
      expect(THAN_DON_DEP).not.toMatch(/^(BEGIN|COMMIT);|^NOTIFY\b/m);
      await lan.exec(`BEGIN; ${THAN_DON_DEP} ${THAN_DON_DEP} ROLLBACK;`);
      expect(await chupHam(lan)).toEqual(truoc);
      await lan.exec(DON_DEP);
      await lan.exec(DON_DEP);
      const sau = await chupHam(lan);
      expect([sau[E6_SIG].md5, sau[R4_SIG].md5]).toEqual([md5(E6_DON_DEP.body), md5(R4_DON_DEP.body)]);
      expect([sau[E6_SIG].acl, sau[R4_SIG].acl]).toEqual([truoc[E6_SIG].acl, truoc[R4_SIG].acl]);
      expect([await quyenGoi(E4_REGPROC, "authenticated", lan), await quyenGoi(E5_REGPROC, "authenticated", lan)]).toEqual([false, false]);
    } finally { await lan.close(); }
  }, 300000);
});

describe("R3 / R4 — lựa chọn và xem trước phiếu tạm ứng", () => {
  interface LuaChon { route: string; accounts: { account_id: string; name: string }[]; payees: { shareholder_id: string; name: string; is_self: boolean }[];
    advance_type: { id: string; name: string } | null; can_create: boolean }
  const theoMa = <T extends { shareholder_id: string }>(ds: T[]) => [...ds].sort((a, b) => a.shareholder_id.localeCompare(b.shareholder_id));
  const NGUOI_NHAN: [string, string][] = [[CD1, "Cổ đông 1"], [CD_CHU, "Cổ đông là chủ"], [CD_TU, "Cổ đông giữ sổ"], [CD_R1, "Cổ đông R1"], [CD_R2, "Cổ đông R2"], [CD_R3, "Cổ đông R3"]];
  it("R3: sổ quỹ THẬT người gọi đang giữ + cổ đông đang hoạt động, có đăng nhập, có quyền tạm ứng (chỉ tên); không giữ sổ nào thì không có danh sách người nhận", async () => {
    await giaoDich(async () => {
      const loai = await mot<string>(`SELECT id AS v FROM public.income_expense_types WHERE organization_id = '${ORG_A}' AND rule_key = 'tam_ung_co_dong'`);
      const cuaGiuSo = await goi<LuaChon>(GIU_SO, r3());
      expect(Object.keys(cuaGiuSo).sort()).toEqual(["accounts", "advance_type", "can_create", "payees", "route"]);
      expect(cuaGiuSo).toMatchObject({ route: "CANONICAL", accounts: [{ account_id: SO_GIU, name: "Sổ người giữ" }], advance_type: { id: loai, name: "Tạm Ứng" }, can_create: true });
      expect(theoMa(cuaGiuSo.payees)).toEqual(theoMa(NGUOI_NHAN.map(([shareholder_id, name]) => ({ shareholder_id, name, is_self: false }))));
      // Chủ giữ SO_QUY và là cổ đông CD_CHU: thấy chính mình với is_self.
      const cuaChu = await goi<LuaChon>(CHU, r3());
      expect(cuaChu.accounts).toEqual([{ account_id: SO_QUY, name: "Tiền mặt" }]);
      expect(theoMa(cuaChu.payees)).toEqual(theoMa(NGUOI_NHAN.map(([shareholder_id, name]) => ({ shareholder_id, name, is_self: shareholder_id === CD_CHU }))));
      // Sổ ảo dù có dòng giữ sổ cũng không vào; sổ chỉ "biết" (KNOWER) cũng không.
      await db.exec(`INSERT INTO public.cashbook_possession_bindings(organization_id, membership_id, cashbook_id, possession_kind, valid_from)
        VALUES ('${ORG_A}','${mem(GIU_SO)}','${SO_AO}','CUSTODIAN', now() - interval '1 day')`);
      expect((await goi<LuaChon>(GIU_SO, r3())).accounts).toEqual([{ account_id: SO_GIU, name: "Sổ người giữ" }]);
      // Không giữ sổ nào (kể cả cổ đông có quyền tạm ứng, kể cả chủ): không lộ danh sách người nhận.
      for (const ai of [KHONG_GIU, U_CD1, CHU3]) {
        expect(await goi<LuaChon>(ai, r3()), ai).toMatchObject({ accounts: [], payees: [], can_create: false, advance_type: { id: loai } });
      }
      // Không số tiền nào trong kết quả.
      expect(JSON.stringify(cuaChu)).not.toMatch(/balance|unpaid|advance_outstanding|amount/);
      // Công tắc chưa CANONICAL: vẫn trả danh sách nhưng chưa lập được.
      await datRoute("SHADOW");
      expect(await goi<LuaChon>(GIU_SO, r3())).toMatchObject({ route: "SHADOW", can_create: false, accounts: [{ account_id: SO_GIU }] });
      // Người ngoài công ty, super admin không là thành viên, chưa đăng nhập ⇒ 42501; thiếu mã công ty ⇒ 22023.
      for (const ai of [NGOAI, SUPER]) laLoi(await loiGoi(ai, r3()), "42501", "PROFIT_LEDGER_FORBIDDEN");
      expect(await loiGoi(null, r3())).toMatchObject({ code: "42501", message: "Chưa đăng nhập" });
      laLoi(await loiGoi(CHU, "SELECT public.shareholder_profit_advance_options_v1(NULL) AS v"), "22023", "PROFIT_LEDGER_BAD_INPUT");
    });
  });
  it("R4: người giữ sổ lập hộ KHÔNG thấy số của cổ đông (position null, bỏ cảnh báo mang số); chính người nhận và người có quyền chi lợi nhuận thì thấy", async () => {
    await giaoDich(async () => {
      await chotThang("2026-09-01", TOA_1, { [CD1]: 100 });
      await ungDaDuyet(40);
      // Ứng 500 khi số dư ròng còn 60, ước tính tháng chưa chốt 100 ⇒ có cảnh báo "vượt ước tính" mang số.
      const ho = await goi<Record<string, unknown>>(GIU_SO, r4(CD1, 500, SO_GIU));
      expect(ho).toEqual({ route: "CANONICAL", shareholder_id: CD1, maker_kind: "CUSTODIAN_FOR_PAYEE", payee_is_maker: false, can_submit: true, blocked_reason: null,
        warnings: [{ code: "ADVANCE", advance_amount: 500 }, { code: "NEEDS_OWNER_APPROVAL" }], position: null });
      expect(JSON.stringify(ho)).not.toMatch(/440|"open_estimate"|unpaid_profit|"balance"/);
      // Người có quyền chi lợi nhuận (không giữ sổ đó): thấy số, nhưng không lập được từ sổ không giữ.
      const chu = await goi<{ warnings: unknown[]; position: Record<string, unknown> }>(CHU, r4(CD1, 500, SO_GIU));
      expect(chu).toMatchObject({ maker_kind: "CUSTODIAN_FOR_PAYEE", can_submit: false, blocked_reason: "NOT_CUSTODIAN" });
      expect(chu.warnings).toEqual([{ code: "ADVANCE", advance_amount: 500 },
        { code: "ADVANCE_EXCEEDS_ESTIMATE", outstanding_advance: 440, open_estimate: 100 }, { code: "NEEDS_OWNER_APPROVAL" }]);
      expect(chu.position).toMatchObject({ unpaid_profit: 100, advance_outstanding: 40, advance_pending: 0, balance: 60, after_advance: { advance_pending: 500, balance: -440 } });
      // Chính người nhận (có quyền tạm ứng, không giữ sổ): thấy số của mình, cách lập là tự tạm ứng, nhưng chưa giữ sổ nên chưa lập được.
      const tuXem = await goi<{ position: Record<string, unknown> }>(U_CD1, r4(CD1, 10, null));
      expect(tuXem).toMatchObject({ maker_kind: "CUSTODIAN_ADVANCE", payee_is_maker: true, can_submit: false, blocked_reason: "NOT_CUSTODIAN" });
      expect(tuXem.position).toMatchObject({ unpaid_profit: 100, advance_outstanding: 40, after_advance: { advance_pending: 10, balance: 50 } });
      // Chưa gõ số tiền / chưa chọn sổ: không cảnh báo, chưa lập được, không có "sau khi ứng".
      expect(await goi(CHU, r4(CD_CHU, null, null))).toMatchObject({ maker_kind: "CUSTODIAN_ADVANCE", can_submit: false, blocked_reason: null, warnings: [],
        position: { unpaid_profit: 0, after_advance: null } });
      expect(await goi(CHU, r4(CD_CHU, 10, SO_QUY))).toMatchObject({ can_submit: true, blocked_reason: null });
    });
  });
  it("R4: lý do chặn theo thứ tự ROUTE → NOT_CUSTODIAN → PAYEE_NO_RIGHT → SALARY_REVIEW_PENDING; người không giữ sổ không dò được quyền của người nhận", async () => {
    await giaoDich(async () => {
      const ly = async (ai: string, cd: string, so: string | null) => (await goi<{ blocked_reason: string | null }>(ai, r4(cd, 10, so))).blocked_reason;
      expect(await ly(GIU_SO, CD1, SO_GIU)).toBeNull();
      expect(await ly(GIU_SO, CD2, SO_GIU)).toBe("PAYEE_NO_RIGHT");
      expect(await ly(GIU_SO, CD3, SO_GIU)).toBe("PAYEE_NO_RIGHT");
      expect(await ly(GIU_SO, CD1, SO_QUY)).toBe("NOT_CUSTODIAN");
      expect(await ly(GIU_SO, CD1, null)).toBeNull();               // chưa chọn sổ nhưng có giữ ít nhất một sổ
      // Người không giữ sổ nào: luôn NOT_CUSTODIAN, dù người nhận có hay không có quyền (không lộ bit quyền), và không có position.
      for (const cd of [CD1, CD2]) expect(await goi(KHONG_GIU, r4(cd, 10, null))).toMatchObject({ blocked_reason: "NOT_CUSTODIAN", position: null });
      // Cổ đông không có quyền tạm ứng tự xem: không thấy số qua đường này.
      expect(await goi(U_CD2, r4(CD2, 10, null))).toMatchObject({ payee_is_maker: true, blocked_reason: "NOT_CUSTODIAN", position: null });
      await dongLuong({ cd: CD1, thang: "2026-10-01", y: 5, trangThai: "NEEDS_REVIEW", phieu: id(3201) });
      expect(await ly(GIU_SO, CD1, SO_GIU)).toBe("SALARY_REVIEW_PENDING");
      expect(await ly(GIU_SO, CD2, SO_GIU)).toBe("PAYEE_NO_RIGHT");
      await datRoute("FROZEN");
      expect(await goi(GIU_SO, r4(CD1, 10, SO_GIU))).toMatchObject({ route: "FROZEN", blocked_reason: "ROUTE", can_submit: false });
    });
  });
  it("R4: cổ đông nghỉ / đã xoá / công ty khác, người ngoài công ty, sổ ảo, số tiền sai ⇒ lỗi như lệnh lập", async () => {
    await giaoDich(async () => {
      for (const cd of [CD_NGHI, CD_XOA, CD_B, id(999)]) expect(await loiGoi(GIU_SO, r4(cd, 10, null)), cd).toMatchObject({ code: "42501", message: "Không tìm thấy cổ đông trong tổ chức hợp lệ" });
      for (const ai of [NGOAI, SUPER]) expect(await loiGoi(ai, r4(CD1, 10, null))).toMatchObject({ code: "42501", message: "Không tìm thấy cổ đông trong tổ chức hợp lệ" });
      expect(await loiGoi(null, r4(CD1, 10, null))).toMatchObject({ code: "42501", message: "Chưa đăng nhập" });
      for (const so of [SO_AO, SO_B]) expect(await loiGoi(GIU_SO, r4(CD1, 10, so))).toMatchObject({ code: "42501", message: "Sổ quỹ tiền thật không hợp lệ hoặc không thuộc tổ chức" });
      for (const tien of ["0", "-1", "1.001", "'NaN'::numeric"]) expect(await loiGoi(GIU_SO, r4(CD1, tien, null))).toMatchObject({ code: "22023", message: "Số tiền tạm ứng không hợp lệ" });
    });
  });
  it("xem trước khớp lệnh lập: cách lập và cảnh báo của R4 = của W1 (cho người thấy số)", async () => {
    await giaoDich(async () => {
      await chotThang("2026-09-01", TOA_1, { [CD_TU]: 40 });
      const xem = await goi<{ maker_kind: string; warnings: unknown[]; position: { balance: number } }>(TU_UNG, r4(CD_TU, 300, SO_TU));
      const lap = await goi<KqUng>(TU_UNG, w1({ cd: CD_TU, tien: 300, so: SO_TU }));
      expect([lap.maker_kind, lap.warnings, lap.balance_before]).toEqual([xem.maker_kind, xem.warnings, xem.position.balance]);
      expect(lap.warnings.map((w) => w.code)).toEqual(["ADVANCE", "ADVANCE_EXCEEDS_ESTIMATE", "NEEDS_OWNER_APPROVAL"]);
    });
  });
  it("W1 lập hộ vượt ước tính: kết quả trả về (cả khi gửi lại cùng khoá) không mang cảnh báo 'vượt ước tính' có số của cổ đông; dòng sổ vẫn lưu đủ cảnh báo cho chủ", async () => {
    await giaoDich(async () => {
      await chotThang("2026-09-01", TOA_1, { [CD1]: 100 });
      await ungDaDuyet(40);
      // Số dư ròng còn 60, ước tính tháng chưa chốt 100, ứng 500 ⇒ lệnh có cảnh báo "vượt ước tính" (440 so với 100).
      const lap = await goi<KqUng>(GIU_SO, w1({ cd: CD1, tien: 500, khoa: "ung-khong-lo-so-01" }));
      expect(lap.warnings).toEqual([{ code: "ADVANCE", advance_amount: 500 }, { code: "NEEDS_OWNER_APPROVAL" }]);
      expect(lap.balance_before).toBeNull();
      // Không so chuỗi "440" trên cả kết quả: voucher_id / approval_request_id là uuid ngẫu nhiên, có thể tình cờ chứa "440".
      expect(JSON.stringify(lap)).not.toMatch(/open_estimate|outstanding_advance|ADVANCE_EXCEEDS_ESTIMATE/);
      // Mọi con số trong kết quả chỉ là số tiền của chính phiếu (500 tạm ứng, 0 trong số dư), không có số nào của cổ đông.
      expect(Object.values(lap).filter((x) => typeof x === "number").sort((a, b) => a - b)).toEqual([0, 500, 500]);
      expect(await goi<KqUng>(GIU_SO, w1({ cd: CD1, tien: 500, khoa: "ung-khong-lo-so-01" }))).toEqual(lap);
      expect((await dongSo(lap.voucher_id)).warnings).toEqual([{ code: "ADVANCE", advance_amount: 500 },
        { code: "ADVANCE_EXCEEDS_ESTIMATE", outstanding_advance: 440, open_estimate: 100 }, { code: "NEEDS_OWNER_APPROVAL" }]);
    });
  });
});

describe("R5 / W2 — xem trước và chốt chi lợi nhuận đến hết tháng N", () => {
  it("phiếu tiền của lần chốt đúng hình dạng: hạng mục chia_loi_nhuan, dòng sổ OWNER không có phần tạm ứng, bản ghi chốt trỏ phiếu và đứng SAU dòng sổ, nhật ký payout_kind SETTLEMENT", async () => {
    await giaoDich(async () => {
      await chotThang("2026-09-01", TOA_1, { [CD1]: 70 });
      await chotThang("2026-10-01", TOA_1, { [CD1]: 50 });
      await ungDaDuyet(20);
      const chot = await goi<KqChot>(CHU, w2({ thang: "2026-10-01", tien: 100, k: 20, khoa: "chot-hinh-dang-01" }));
      expect(chot).toEqual({ settlement_id: expect.stringMatching(UUID), through_month: "2026-10-01", recognized_amount: 120, advance_offset_amount: 20, cash_amount: 100,
        voucher_id: expect.stringMatching(UUID), approval_request_id: expect.stringMatching(UUID), state: "PENDING_APPROVAL" });
      const p = chot.voucher_id as string;
      expect(await phieu(p)).toMatchObject({ type: "EXPENSE", approval_status: "UNAPPROVED", system_source: "profit.ledger_payout", shareholder_id: CD1, account_id: SO_QUY,
        building_id: TOA_AO, user_id: CHU, total_amount: "100.00", name: "Chi lợi nhuận đến hết 10/2026: Cổ đông 1", maker_user_id: CHU, business_result_accounting: false,
        idempotency_key: "chot-hinh-dang-01" });
      expect(await mot(`SELECT jsonb_build_object('rk', t.rule_key, 'lop', i.accounting_class, 'tien', i.amount) AS v
        FROM public.income_expense_items i JOIN public.income_expense_types t ON t.id = i.income_expense_type_id WHERE i.income_expense_id = '${p}'`))
        .toEqual({ rk: "chia_loi_nhuan", lop: "INTERNAL", tien: 100 });
      expect(await dongSo(p)).toMatchObject({ maker_kind: "OWNER", maker_user_id: CHU, payee_user_id: U_CD1, payee_is_maker: false, amount: "100.00", balance_before: "100.00",
        within_amount: "100.00", advance_amount: "0.00", approval_request_id: chot.approval_request_id });
      expect(await mot(`SELECT to_jsonb(s) - ARRAY['id','created_at','ledger_seq'] AS v FROM ${C7} s WHERE s.id = '${chot.settlement_id}'`)).toEqual({
        organization_id: ORG_A, shareholder_id: CD1, through_month: "2026-10-01", recognized_amount: 120, advance_offset_amount: 20, cash_amount: 100, cash_voucher_id: p,
        unpaid_before: 120, advance_before: 20, note: null, state: "ACTIVE", created_by: CHU, voided_by: null, voided_at: null, void_reason: null });
      expect(await mot(`SELECT s.ledger_seq > p.ledger_seq AS v FROM ${C7} s JOIN app_private.profit_ledger_payouts p ON p.voucher_id = s.cash_voucher_id WHERE s.id = '${chot.settlement_id}'`)).toBe(true);
      expect(await mot(`SELECT payload AS v FROM app_private.profit_ledger_events WHERE voucher_id = '${p}' AND event_kind = 'PAYOUT_CREATED'`)).toMatchObject({
        payout_kind: "SETTLEMENT", settlement_id: chot.settlement_id, through_month: "2026-10-01", recognized_amount: 120, advance_offset_amount: 20,
        within_amount: 100, advance_amount: 0, maker_kind: "OWNER" });
      expect(await mot(`SELECT jsonb_build_array(subject_id, response_payload) AS v FROM app_private.canonical_write_operations WHERE operation = 'shareholder_profit.ledger_settle.v1'`))
        .toEqual([chot.settlement_id, chot]);
      expect(await dem("app_private.profit_ledger_write_contexts")).toBe(0);
      // Lệnh đọc của Đợt 1: phiếu tiền của lần chốt KHÔNG phải tạm ứng; sổ chi tiết vẫn cộng ra số dư ròng.
      expect(await goi(CHU, `SELECT public.profit_ledger_payout_detail_v1('${p}') AS v`)).toMatchObject({ at_create: { within: 100, advance: 0, maker_kind: "OWNER" } });
      const so = await goi<{ entries: { kind: string; voucher_id: string; is_advance: boolean }[]; totals: { balance: number } }>(CHU,
        `SELECT public.shareholder_profit_ledger_entries_v1('${ORG_A}','${CD1}') AS v`);
      expect(so.entries.filter((e) => e.kind === "PAYOUT").map((e) => [e.voucher_id === p, e.is_advance])).toEqual([[false, true], [true, false]]);
      expect(so.totals.balance).toBe(0);
      // Ghi chú của chủ thành tên phiếu và ghi chú bản ghi chốt.
      await chotThang("2026-11-01", TOA_1, { [CD1]: 10 });
      const co = await goi<KqChot>(CHU, w2({ thang: "2026-11-01", tien: 10, ghiChu: "  Chi nốt tháng 11  " }));
      expect((await phieu(co.voucher_id as string)).name).toBe("Chi nốt tháng 11");
      expect((await banGhiChot(co.settlement_id)).note).toBe("Chi nốt tháng 11");
    });
  });
  it("R5: liệt kê tháng (phân bổ của tháng, X nếu chốt đến tháng đó, chọn được), mặc định tháng đủ điều kiện lớn nhất; chọn tháng sớm hơn thì chỉ ghi nhận tới tháng đó", async () => {
    await giaoDich(async () => {
      await chotThang("2026-08-01", TOA_1, { [CD1]: 30, [CD2]: 999 });
      await chotThang("2026-08-01", TOA_2, { [CD1]: 12.5 });
      await chotThang("2026-09-01", TOA_1, { [CD1]: -20 });          // tháng lỗ
      await chotThang("2026-10-01", TOA_1, { [CD1]: 60 });
      await chotThang("2026-11-01", TOA_1, { [CD1]: 500 }, "DRAFT");  // chưa chốt: không tính
      await ungDaDuyet(15);
      const xem = await goi<Record<string, unknown>>(CHU, r5(CD1));
      expect(Object.keys(xem).sort()).toEqual(["advance_left", "advance_offset_amount", "advance_pending", "blocked_reason", "can_submit", "cash_amount", "min_through_month",
        "months", "position", "recognized_amount", "route", "settlements", "shareholder_id", "through_month"]);
      expect(xem.months).toEqual([
        { month: "2026-08-01", allocated: 42.5, unpaid_through: 42.5, selectable: true },
        { month: "2026-09-01", allocated: -20, unpaid_through: 22.5, selectable: true },
        { month: "2026-10-01", allocated: 60, unpaid_through: 82.5, selectable: true }]);
      expect(xem).toMatchObject({ route: "CANONICAL", shareholder_id: CD1, min_through_month: "2026-08-01", through_month: "2026-10-01", recognized_amount: 82.5,
        advance_offset_amount: 15, cash_amount: 67.5, advance_left: 0, advance_pending: 0, settlements: [], can_submit: true, blocked_reason: null,
        position: { unpaid_profit: 82.5, advance_outstanding: 15, advance_pending: 0, settlement_cash_pending: 0, balance: 67.5, marker_month: null,
          last_settled_through_month: null, settled: { recognized: 0, offset: 0, cash: 0 } } });
      // Chốt đến tháng 08 thôi: X = 42,5; tháng 09 lỗ và tháng 10 để lại.
      expect(await goi(CHU, r5(CD1, "2026-08-01"))).toMatchObject({ through_month: "2026-08-01", recognized_amount: 42.5, advance_offset_amount: 15, cash_amount: 27.5 });
      const chot = await goi<KqChot>(CHU, w2({ thang: "2026-08-01", tien: 27.5, k: 15 }));
      expect(chot).toMatchObject({ recognized_amount: 42.5, advance_offset_amount: 15, cash_amount: 27.5 });
      expect(await ab(CD1)).toEqual([40, 0, 0, 27.5, 40]);
      const sau = await goi<{ months: unknown[]; settlements: Record<string, unknown>[] }>(CHU, r5(CD1));
      expect(sau.months).toEqual([
        { month: "2026-08-01", allocated: 42.5, unpaid_through: 0, selectable: false },
        { month: "2026-09-01", allocated: -20, unpaid_through: -20, selectable: false },
        { month: "2026-10-01", allocated: 60, unpaid_through: 40, selectable: true }]);
      expect(sau).toMatchObject({ through_month: "2026-10-01", min_through_month: "2026-10-01", recognized_amount: 40, cash_amount: 40 });
      expect(sau.settlements).toEqual([{ id: chot.settlement_id, through_month: "2026-08-01", recognized_amount: 42.5, advance_offset_amount: 15, cash_amount: 27.5,
        cash_voucher_id: chot.voucher_id, cash_voucher_code: null, cash_voucher_status: "UNAPPROVED", cash_voucher_posting_status: "UNPOSTED",
        created_at: expect.any(String), excluded_by_marker: false }]);
    });
  });
  it("R5: lý do chặn ROUTE / SALARY_REVIEW_PENDING / NOTHING_TO_SETTLE / ACCOUNT_REQUIRED; tháng sai ⇒ 22023; không quyền / cổ đông không hợp lệ ⇒ 42501", async () => {
    await giaoDich(async () => {
      const ly = async (cd = CD1, thang: string | null = null, so: string | null = SO_QUY) => (await goi<{ blocked_reason: string | null }>(CHU, r5(cd, thang, so))).blocked_reason;
      expect(await ly()).toBe("NOTHING_TO_SETTLE");                   // chưa có tháng nào
      await chotThang("2026-09-01", TOA_1, { [CD1]: 100, [CD3]: -5 });
      expect(await ly()).toBeNull();
      expect(await ly(CD1, null, null)).toBe("ACCOUNT_REQUIRED");
      expect(await ly(CD3)).toBe("NOTHING_TO_SETTLE");                // chỉ có tháng lỗ
      expect(await goi(CHU, r5(CD3, "2026-09-01"))).toMatchObject({ recognized_amount: -5, advance_offset_amount: null, cash_amount: null, can_submit: false });
      await dongLuong({ cd: CD1, thang: "2026-10-01", y: 5, trangThai: "NEEDS_REVIEW", phieu: id(3301) });
      expect(await ly()).toBe("SALARY_REVIEW_PENDING");
      await datRoute("SHADOW");
      expect(await goi(CHU, r5(CD1))).toMatchObject({ route: "SHADOW", blocked_reason: "ROUTE", can_submit: false, recognized_amount: 100 });
      for (const thang of ["2026-09-15", "2026-08-01", "2026-10-01", "infinity"]) laLoi(await loiGoi(CHU, r5(CD1, thang)), "22023", "PROFIT_LEDGER_SETTLE_MONTH");
      for (const ai of [GIU_SO, TU_UNG, U_CD1, QUAN_LY, NGOAI]) {
        expect(await loiGoi(ai, r5(CD1)), ai).toMatchObject({ code: "42501", message: "Không có quyền chi lợi nhuận cổ đông, hoặc không tìm thấy cổ đông trong tổ chức hợp lệ" });
      }
      for (const cd of [CD_NGHI, CD_XOA, CD_B, id(999)]) expect((await loiGoi(CHU, r5(cd)))?.code, cd).toBe("42501");
      expect(await loiGoi(null, r5(CD1))).toMatchObject({ code: "42501", message: "Chưa đăng nhập" });
      for (const so of [SO_AO, SO_B]) expect(await loiGoi(CHU, r5(CD1, null, so))).toMatchObject({ code: "42501", message: "Sổ quỹ tiền thật không hợp lệ hoặc không thuộc tổ chức" });
      laLoi(await loiGoi(CHU, "SELECT public.shareholder_profit_settlement_preview_v1(NULL, NULL, NULL) AS v"), "22023", "PROFIT_LEDGER_BAD_INPUT");
    });
  });
  it("R5 không truyền tháng ⇒ tháng ĐỦ ĐIỀU KIỆN lớn nhất, không phải tháng lớn nhất còn tiền: tháng cuối lỗ làm luỹ kế âm thì báo NOTHING_TO_SETTLE; muốn chốt đến tháng trước đó phải tự chọn", async () => {
    await giaoDich(async () => {
      await chotThang("2026-09-01", TOA_1, { [CD1]: 100 });
      await chotThang("2026-10-01", TOA_1, { [CD1]: -120 });          // tháng cuối lỗ: luỹ kế đến tháng 10 là −20
      const macDinh = await goi<{ months: unknown[] }>(CHU, r5(CD1));
      expect(macDinh.months).toEqual([
        { month: "2026-09-01", allocated: 100, unpaid_through: 100, selectable: true },
        { month: "2026-10-01", allocated: -120, unpaid_through: -20, selectable: false }]);
      // Không đề xuất chi 100 của tháng 09 khi cả kỳ đang âm.
      expect(macDinh).toMatchObject({ through_month: "2026-10-01", min_through_month: "2026-09-01", recognized_amount: -20, advance_offset_amount: null,
        cash_amount: null, advance_left: null, can_submit: false, blocked_reason: "NOTHING_TO_SETTLE", position: { unpaid_profit: -20, balance: -20 } });
      // Chủ TỰ CHỌN tháng 09 thì vẫn chốt được (phần lỗ để lại, như ca "chốt đến tháng 09 dù tháng 10 lỗ").
      expect(await goi(CHU, r5(CD1, "2026-09-01"))).toMatchObject({ through_month: "2026-09-01", recognized_amount: 100, advance_offset_amount: 0, cash_amount: 100,
        can_submit: true, blocked_reason: null });
      // Không còn tháng đủ điều kiện nào (mốc phủ hết) ⇒ như trước: không có tháng, NOTHING_TO_SETTLE.
      await goi(CHU, e9(CD1, "2026-10-01", null));
      expect(await goi(CHU, r5(CD1))).toMatchObject({ months: [], through_month: null, recognized_amount: null, cash_amount: null, can_submit: false,
        blocked_reason: "NOTHING_TO_SETTLE" });
    });
  });
  it("W2: chỉ người có quyền chi lợi nhuận, là thành viên; cổ đông phải đang hoạt động", async () => {
    await giaoDich(async () => {
      await chotThang("2026-09-01", TOA_1, { [CD1]: 100, [CD_NGHI]: 10, [CD_XOA]: 10 });
      // Thành viên công ty không có quyền chi lợi nhuận.
      for (const ai of [GIU_SO, TU_UNG, U_CD1, QUAN_LY, KHONG_GIU]) {
        expect(await loiGoi(ai, w2({ thang: "2026-09-01", tien: 100 })), ai).toMatchObject({ code: "42501", message: "Không có quyền chi lợi nhuận cổ đông" });
      }
      expect(await loiGoi(null, w2({ thang: "2026-09-01", tien: 100 }))).toMatchObject({ code: "42501", message: "Chưa đăng nhập" });
      // Cổ đông nghỉ / đã xoá của CHÍNH công ty mình (người gọi là thành viên).
      for (const cd of [CD_NGHI, CD_XOA]) expect(await loiGoi(CHU, w2({ cd, thang: "2026-09-01", tien: 10 })), cd).toMatchObject({ code: "42501", message: "Không tìm thấy cổ đông trong tổ chức hợp lệ" });
      // "Không có cổ đông đó" và "không thuộc công ty của cổ đông" trả CÙNG một câu, cùng mã: người ngoài không dò được một mã cổ đông có tồn tại hay không.
      const cung = { code: "42501", message: "Không có quyền chi lợi nhuận cổ đông, hoặc không tìm thấy cổ đông trong tổ chức hợp lệ", detail: null, hint: null };
      for (const ai of [NGOAI, SUPER]) {
        for (const cd of [CD1, id(999)]) expect(await loiGoi(ai, w2({ cd, thang: "2026-09-01", tien: 100 })), `${ai} ${cd}`).toEqual(cung);
      }
      for (const cd of [CD_B, id(999)]) expect(await loiGoi(CHU, w2({ cd, thang: "2026-09-01", tien: 10 })), cd).toEqual(cung);
      // Quyền chi lợi nhuận đã bị gỡ khỏi vai (đọc lại dưới khoá công ty).
      await db.exec(`DELETE FROM public.role_permissions WHERE permission_key = 'shareholder_profit.distribute' AND organization_id = '${ORG_A}'`);
      expect(await loiGoi(CHU, w2({ thang: "2026-09-01", tien: 100 }))).toMatchObject({ code: "42501", message: "Không có quyền chi lợi nhuận cổ đông" });
      expect(await dem(C7)).toBe(0);
    });
  });
  it("W2: tháng sai ⇒ 22023 PROFIT_LEDGER_SETTLE_MONTH (kèm min / max); không còn gì để chốt ⇒ 22023 PROFIT_LEDGER_SETTLE_NOTHING; có tiền mà thiếu sổ / ngày ⇒ 22023 PROFIT_LEDGER_SETTLE_ACCOUNT", async () => {
    await giaoDich(async () => {
      await chotThang("2026-08-01", TOA_1, { [CD2]: 10 });            // tháng 08 không có phần của CD1
      await chotThang("2026-09-01", TOA_1, { [CD1]: 100, [CD3]: -5 });
      await chotThang("2026-10-01", TOA_1, { [CD1]: -30 });
      await chotThang("2026-11-01", TOA_1, { [CD1]: 7 }, "DRAFT");
      for (const thang of [null, "2026-09-15", "infinity"]) expect(await loiGoi(CHU, w2({ thang, tien: 100 })), String(thang)).toMatchObject({ code: "22023", message: "PROFIT_LEDGER_SETTLE_MONTH: tháng chốt phải là ngày đầu tháng" });
      for (const thang of ["2026-08-01", "2026-11-01", "2027-01-01"]) {
        const l = laLoi(await loiGoi(CHU, w2({ thang, tien: 100 })), "22023", "PROFIT_LEDGER_SETTLE_MONTH: tháng chốt phải là tháng đã chốt lợi nhuận của cổ đông");
        expect(chiTiet(l)).toEqual({ through_month: thang, min: "2026-09-01", max: "2026-10-01" });
      }
      const ln = laLoi(await loiGoi(CHU, w2({ cd: CD3, thang: "2026-09-01", tien: 0, x: 5 })), "22023", "PROFIT_LEDGER_SETTLE_NOTHING: không còn lợi nhuận chưa chi đến hết tháng 09/2026");
      expect(chiTiet(ln)).toEqual({ through_month: "2026-09-01", unpaid_through: -5 });
      for (const thieu of [{ so: null }, { ngay: null }]) {
        const l = laLoi(await loiGoi(CHU, w2({ thang: "2026-10-01", tien: 70, ...thieu })), "22023", "PROFIT_LEDGER_SETTLE_ACCOUNT");
        expect(chiTiet(l)).toEqual({ cash_amount: 70 });
      }
      for (const so of [SO_AO, SO_B]) expect(await loiGoi(CHU, w2({ thang: "2026-10-01", tien: 70, so }))).toMatchObject({ code: "42501", message: "Sổ quỹ tiền thật không hợp lệ hoặc không thuộc tổ chức" });
      for (const k of ["ngắn", "khoá có dấu cách"]) expect((await loiGoi(CHU, w2({ thang: "2026-10-01", tien: 70, khoa: k })))?.code).toBe("22023");
      expect(await loiGoi(CHU, w2({ thang: "2026-10-01", tien: 70, ghiChu: "x".repeat(501) }))).toMatchObject({ code: "22023", message: "Ghi chú dài quá 500 ký tự" });
      expect(await dem(C7)).toBe(0);
      // Chủ được chốt đến tháng 09 dù tháng 10 lỗ (X = 100 > tổng chưa chi 70): phần lỗ để lại thành số âm chờ bù kỳ sau.
      expect(await goi<KqChot>(CHU, w2({ thang: "2026-09-01", tien: 100 }))).toMatchObject({ recognized_amount: 100, cash_amount: 100 });
      expect(await ab(CD1)).toEqual([-30, 0, 0, 100, -30]);
      laLoi(await loiGoi(CHU, w2({ thang: "2026-10-01", tien: 0, x: 70 })), "22023", "PROFIT_LEDGER_SETTLE_NOTHING");
    });
  });
  it("W2: công tắc chưa CANONICAL / đóng băng ⇒ 55000; còn phiếu lương cần xem lại ⇒ 55000; hai khoá ngày chỉ áp khi có tiền thực chi; luật duyệt DENY ⇒ huỷ cả lệnh (không còn bản ghi chốt)", async () => {
    await giaoDich(async () => {
      await chotThang("2026-09-01", TOA_1, { [CD1]: 100 });
      for (const [r, ma] of [["LEGACY", "PROFIT_LEDGER_ROUTE_OFF"], ["SHADOW", "PROFIT_LEDGER_ROUTE_OFF"], ["FROZEN", "PROFIT_LEDGER_FROZEN"]] as [Route, string][]) {
        await datRoute(r);
        laLoi(await loiGoi(CHU, w2({ thang: "2026-09-01", tien: 100 })), "55000", ma);
      }
      await datRoute("CANONICAL");
      await dongLuong({ cd: CD1, thang: "2026-10-01", y: 5, trangThai: "NEEDS_REVIEW", phieu: id(3401) });
      const l = laLoi(await loiGoi(CHU, w2({ thang: "2026-09-01", tien: 100 })), "55000", "PROFIT_LEDGER_SALARY_REVIEW_PENDING");
      expect(chiTiet(l)).toEqual({ count: 1, suggested: 5 });
      await db.exec(`UPDATE public.income_expenses SET deleted_at = now() WHERE id = '${id(3401)}'`);
      await db.exec(`INSERT INTO public.profit_monthly(organization_id, building_id, period_month, status, locked_at) VALUES ('${ORG_A}','${TOA_AO}','2026-05-01','LOCKED', now());
        INSERT INTO app_private.cashbook_closures(organization_id, cashbook_id, closed_through) VALUES ('${ORG_A}','${SO_QUY}','2026-11-10')`);
      laLoi(await loiGoi(CHU, w2({ thang: "2026-09-01", tien: 100, ngay: "2026-05-20" })), "55000", "PROFIT_LEDGER_PROFIT_MONTH_LOCKED");
      laLoi(await loiGoi(CHU, w2({ thang: "2026-09-01", tien: 100, ngay: "2026-11-10" })), "55000", "PROFIT_LEDGER_CASHBOOK_CLOSED");
      await db.exec("SELECT set_config('test.submit', 'DENY', true)");
      laLoi(await loiGoi(CHU, w2({ thang: "2026-09-01", tien: 100, ngay: "2026-11-11" })), "55000", "PROFIT_LEDGER_REQUEST_NOT_PENDING");
      await db.exec("SELECT set_config('test.submit', '', true)");
      expect([await dem(C7), await dem("public.income_expenses", "system_source = 'profit.ledger_payout'"), await dem("app_private.profit_ledger_payouts")]).toEqual([0, 0, 0]);
      // Lần chốt KHÔNG có tiền: ngày chi trong tháng đã chốt / sổ đã chốt không cản (không có phiếu nào được lập).
      await ungDaDuyet(100, { ngay: "2026-11-12" });
      expect(await goi<KqChot>(CHU, w2({ thang: "2026-09-01", tien: 0, k: 100, ngay: "2026-05-20" }))).toMatchObject({ cash_amount: 0, state: "SETTLED", voucher_id: null });
    });
  });
  it("W2: cùng khoá ⇒ trả y hệt, không ghi thêm (số kỳ vọng không thuộc nội dung); cùng khoá khác tháng / sổ / ngày / ghi chú ⇒ 23505", async () => {
    await giaoDich(async () => {
      await chotThang("2026-09-01", TOA_1, { [CD1]: 60 });
      await chotThang("2026-10-01", TOA_1, { [CD1]: 40 });
      const goc: Chot = { thang: "2026-10-01", tien: 100, ghiChu: "Chốt quý", khoa: "chot-trung-khoa-01" };
      const lan1 = await goi<KqChot>(CHU, w2(goc));
      expect(await goi<KqChot>(CHU, w2(goc))).toEqual(lan1);
      // Gửi lại sau khi số liệu đã đổi (phiếu tiền đã ghi nhận hết): vẫn trả kết quả cũ, kể cả khi số kỳ vọng khác.
      expect(await goi<KqChot>(CHU, w2({ ...goc, tien: 5 }))).toEqual(lan1);
      expect([await dem(C7), await dem("public.income_expenses")]).toEqual([1, 1]);
      for (const doi of [{ thang: "2026-09-01" }, { so: null }, { ngay: "2026-11-11" }, { ghiChu: "Khác" }]) {
        expect(await loiGoi(CHU, w2({ ...goc, ...doi })), JSON.stringify(doi)).toMatchObject({ code: "23505", message: "idempotency_key đã dùng với nội dung khác" });
      }
      // Người khác dùng cùng khoá là lệnh của người đó (không lấy được kết quả của chủ).
      laLoi(await loiGoi(CHU2, w2(goc)), "22023", "PROFIT_LEDGER_SETTLE_NOTHING");
    });
  });
  it("chủ chốt cho chính mình: phiếu tiền mang người lập = người nhận, phải do chủ KHÁC duyệt", async () => {
    await giaoDich(async () => {
      await chotThang("2026-09-01", TOA_1, { [CD_CHU]: 90 });
      const chot = await goi<KqChot>(CHU, w2({ cd: CD_CHU, thang: "2026-09-01", tien: 90 }));
      expect(await dongSo(chot.voucher_id as string)).toMatchObject({ maker_kind: "OWNER", payee_is_maker: true, payee_user_id: CHU });
      laLoi(await duyet(chot.voucher_id as string, CHU), "42501", "PROFIT_LEDGER_MAKER_SELF_APPROVE");
      expect(await duyet(chot.voucher_id as string, CHU2)).toBeNull();
      expect(await ab(CD_CHU)).toEqual([0, 0, 0, 0, 0]);
    });
  });
});

describe("W3 — huỷ bản ghi chốt không có phiếu tiền", () => {
  /** CD1 được chia 100, đã ứng (đã duyệt) 120, chốt đến hết 10/2026 không có tiền: X 100, K 100. */
  async function chotKhongTien(): Promise<KqChot> {
    await chotThang("2026-09-01", TOA_1, { [CD1]: 60 });
    await chotThang("2026-10-01", TOA_1, { [CD1]: 40 });
    await ungDaDuyet(120);
    return goi<KqChot>(CHU, w2({ thang: "2026-10-01", so: null, ngay: null, tien: 0, k: 100 }));
  }
  it("huỷ ⇒ VOID có người / giờ / lý do, hai con số trở lại, chốt lại được; cùng khoá ⇒ trả y hệt; huỷ lần nữa bằng khoá khác ⇒ 55000", async () => {
    await giaoDich(async () => {
      const chot = await chotKhongTien();
      expect(await ab(CD1)).toEqual([0, 20, 0, 0, -20]);
      const kq = await goi(CHU2, w3(chot.settlement_id, "  Chốt nhầm tháng cần làm lại  ", "huy-chot-000001"));
      expect(kq).toEqual({ settlement_id: chot.settlement_id, state: "VOID" });
      expect(await banGhiChot(chot.settlement_id)).toMatchObject({ state: "VOID", voided_by: CHU2, void_reason: "Chốt nhầm tháng cần làm lại", recognized_amount: "100.00" });
      expect((await banGhiChot(chot.settlement_id)).voided_at).not.toBeNull();
      expect(await ab(CD1)).toEqual([100, 120, 0, 0, -20]);
      expect(await goi(CHU2, w3(chot.settlement_id, "Chốt nhầm tháng cần làm lại", "huy-chot-000001"))).toEqual(kq);
      expect(await loiGoi(CHU2, w3(chot.settlement_id, "Lý do khác hẳn lúc trước", "huy-chot-000001"))).toMatchObject({ code: "23505" });
      const l = laLoi(await loiGoi(CHU, w3(chot.settlement_id, "Huỷ thêm lần nữa xem sao", "huy-chot-000002")), "55000", "PROFIT_LEDGER_SETTLE_NOT_ACTIVE");
      expect(chiTiet(l)).toEqual({ state: "VOID" });
      expect(await goi(CHU, r5(CD1, null, null))).toMatchObject({ recognized_amount: 100, advance_offset_amount: 100, cash_amount: 0, settlements: [] });
      expect(await goi<KqChot>(CHU, w2({ thang: "2026-10-01", so: null, ngay: null, tien: 0, k: 100 }))).toMatchObject({ state: "SETTLED" });
    });
  });
  it("bản ghi có phiếu tiền ⇒ 22023 PROFIT_LEDGER_SETTLE_HAS_VOUCHER (huỷ phiếu bằng lệnh huỷ phiếu); lý do / khoá sai ⇒ 22023; không quyền, không có, công ty khác ⇒ cùng một lỗi 42501", async () => {
    await giaoDich(async () => {
      await chotThang("2026-09-01", TOA_1, { [CD1]: 100 });
      const coTien = await goi<KqChot>(CHU, w2({ thang: "2026-09-01", tien: 100 }));
      const l = laLoi(await loiGoi(CHU, w3(coTien.settlement_id)), "22023", "PROFIT_LEDGER_SETTLE_HAS_VOUCHER");
      expect(chiTiet(l)).toEqual({ cash_voucher_id: coTien.voucher_id });
      expect(await banGhiChot(coTien.settlement_id)).toMatchObject({ state: "ACTIVE" });
      for (const lyDo of ["ngắn", "", "x".repeat(1001)]) laLoi(await loiGoi(CHU, w3(coTien.settlement_id, lyDo)), "22023", "PROFIT_LEDGER_BAD_REASON");
      expect((await loiGoi(CHU, w3(coTien.settlement_id, "Lý do đủ tám ký tự", "ngắn")))?.code).toBe("22023");
      laLoi(await loiGoi(CHU, "SELECT public.shareholder_profit_settlement_void_v1(NULL, 'Lý do đủ tám ký tự', 'khoa-du-dai-001') AS v"), "22023", "PROFIT_LEDGER_BAD_INPUT");
      const cung = { code: "42501", message: "Không có quyền chi lợi nhuận cổ đông, hoặc không tìm thấy bản ghi chốt" };
      for (const ai of [GIU_SO, U_CD1, QUAN_LY, NGOAI, SUPER]) expect(await loiGoi(ai, w3(coTien.settlement_id)), ai).toMatchObject(cung);
      expect(await loiGoi(CHU, w3(id(4242)))).toMatchObject(cung);
      expect(await loiGoi(null, w3(coTien.settlement_id))).toMatchObject({ code: "42501", message: "Chưa đăng nhập" });
    });
  });
  it("như lệnh huỷ phiếu: chạy cả khi công tắc tắt / đóng băng", async () => {
    await giaoDich(async () => {
      const chot = await chotKhongTien();
      await datRoute("FROZEN");
      expect(await goi(CHU, w3(chot.settlement_id))).toEqual({ settlement_id: chot.settlement_id, state: "VOID" });
      expect(await ab(CD1)).toEqual([100, 120, 0, 0, -20]);
    });
  });
  it("tự lấy khoá sổ của cổ đông: giao dịch chưa giữ khoá (bản ghi chốt có từ giao dịch trước) vẫn huỷ được, và sau lệnh thì khoá đang được giữ", async () => {
    await giaoDich(async () => {
      // Bản ghi chốt "có từ giao dịch trước": chèn thẳng khi tắt trigger nghi thức ⇒ giao dịch này CHƯA lấy khoá sổ của cổ đông
      // (ở các ca khác lệnh chốt chạy cùng giao dịch nên khoá đã được giữ sẵn — không đo được lệnh huỷ có tự lấy khoá hay không).
      const banGhi = id(7301);
      await db.exec(`ALTER TABLE ${C7} DISABLE TRIGGER a00_profit_ledger_payout_settlements_guard;
        INSERT INTO ${C7}(id, organization_id, shareholder_id, through_month, recognized_amount, advance_offset_amount, cash_amount,
            unpaid_before, advance_before, ledger_seq, created_by)
          VALUES ('${banGhi}','${ORG_A}','${CD1}','2026-09-01', 50, 50, 0, 50, 50, 987655, '${CHU}');
        ALTER TABLE ${C7} ENABLE TRIGGER a00_profit_ledger_payout_settlements_guard`);
      const giuKhoa = () => mot<boolean>(`SELECT app_private.profit_ledger_lock_held_v1('${ORG_A}','SHAREHOLDER','${CD1}') AS v`);
      expect(await giuKhoa()).toBe(false);
      expect(await goi(CHU, w3(banGhi))).toEqual({ settlement_id: banGhi, state: "VOID" });
      expect(await giuKhoa()).toBe(true);
    });
  });
});

describe("R1 / R2 — đọc vị thế", () => {
  it("R1: chủ xem mọi cổ đông chưa xoá (+ đã xoá còn số), đủ trường vị thế và has_advance_right; quyền như sổ tổng", async () => {
    await giaoDich(async () => {
      await chotThang("2026-09-01", TOA_1, { [CD1]: 100, [CD2]: 30 });
      await ungDaDuyet(40);
      const r = await goi<{ organization_id: string; route: string; as_of: string; shareholders: Record<string, unknown>[] }>(CHU, r1());
      expect(r).toMatchObject({ organization_id: ORG_A, route: "CANONICAL" });
      const theoId = Object.fromEntries(r.shareholders.map((s) => [s.shareholder_id as string, s]));
      expect(Object.keys(theoId).sort()).toEqual([CD1, CD2, CD3, CD_CHU, CD_TU, CD_NGHI, CD_GO, CD_XEM, CD_R1, CD_R2, CD_R3].sort());   // không có CD_XOA (không còn số), CD_B (công ty khác)
      expect(Object.keys(theoId[CD1]).sort()).toEqual(["advance_outstanding", "advance_pending", "balance", "components", "has_advance_right", "has_login", "is_active", "is_deleted",
        "last_settled_through_month", "marker_month", "name", "needs_review", "settled", "settlement_cash_pending", "shareholder_id", "unpaid_profit"]);
      expect(theoId[CD1]).toMatchObject({ name: "Cổ đông 1", is_active: true, is_deleted: false, has_login: true, has_advance_right: true, unpaid_profit: 100,
        advance_outstanding: 40, advance_pending: 0, settlement_cash_pending: 0, balance: 60, needs_review: { count: 0, suggested: 0 },
        components: { allocated: 100, salary_investment: 0, salary_advance_offset: 0, payouts_approved: 40, payouts_pending: 0 } });
      expect(theoId[CD2]).toMatchObject({ has_login: true, has_advance_right: false, unpaid_profit: 30, advance_outstanding: 0 });
      expect(Object.fromEntries(Object.entries(theoId).map(([k, v]) => [k, v.has_advance_right]))).toEqual({ [CD1]: true, [CD2]: false, [CD3]: false, [CD_CHU]: true,
        [CD_TU]: true, [CD_NGHI]: false, [CD_GO]: false, [CD_XEM]: false, [CD_R1]: true, [CD_R2]: true, [CD_R3]: true });
      expect(theoId[CD_NGHI]).toMatchObject({ is_active: false, has_login: false });
      // Cổ đông đã xoá còn số thì hiện, xếp sau cổ đông chưa xoá.
      await chotThang("2026-09-01", TOA_2, { [CD_XOA]: 7 });
      const r2n = await goi<{ shareholders: { shareholder_id: string; is_deleted: boolean; unpaid_profit: number }[] }>(CHU, r1());
      expect(r2n.shareholders.at(-1)).toMatchObject({ shareholder_id: CD_XOA, is_deleted: true, unpaid_profit: 7 });
      // Người chỉ có quyền quản lý cổ đông cũng xem được; người giữ sổ / cổ đông / người ngoài thì không.
      expect((await goi<{ shareholders: unknown[] }>(QUAN_LY, r1())).shareholders).toHaveLength(12);
      for (const ai of [GIU_SO, U_CD1, TU_UNG, NGOAI, null]) laLoi(await loiGoi(ai, r1()), "42501", "PROFIT_LEDGER_FORBIDDEN");
      laLoi(await loiGoi(CHU, r1(ORG_B)), "42501", "PROFIT_LEDGER_FORBIDDEN");
      laLoi(await loiGoi(CHU, "SELECT public.shareholder_profit_positions_v1(NULL) AS v"), "22023", "PROFIT_LEDGER_BAD_INPUT");
    });
  });
  it("R2: cổ đông tự xem vị thế và các lần chốt còn hiệu lực của MÌNH; không lộ id / số của người khác; quyền như 'lợi nhuận của tôi'", async () => {
    await giaoDich(async () => {
      await chotThang("2026-09-01", TOA_1, { [CD1]: 100, [CD_XEM]: 55, [CD2]: 30 });
      await ungDaDuyet(40);
      const chot = await goi<KqChot>(CHU, w2({ thang: "2026-09-01", tien: 60, k: 40 }));
      const toi = await goi<Record<string, unknown>>(U_CD1, r2());
      expect(Object.keys(toi).sort()).toEqual(["advance_outstanding", "advance_pending", "balance", "components", "last_settled_through_month", "marker_month", "needs_review",
        "organization_id", "route", "settled", "settlement_cash_pending", "settlements", "shareholder", "unpaid_profit"]);
      expect(toi).toMatchObject({ organization_id: ORG_A, route: "CANONICAL", shareholder: { id: CD1, name: "Cổ đông 1" }, unpaid_profit: 0, advance_outstanding: 0,
        advance_pending: 0, settlement_cash_pending: 60, balance: 0, last_settled_through_month: "2026-09-01", settled: { recognized: 100, offset: 40, cash: 60 } });
      expect(toi.settlements).toEqual([{ id: chot.settlement_id, through_month: "2026-09-01", recognized_amount: 100, advance_offset_amount: 40, cash_amount: 60,
        cash_voucher_id: chot.voucher_id, cash_voucher_code: null, cash_voucher_status: "UNAPPROVED", cash_voucher_posting_status: "UNPOSTED",
        created_at: expect.any(String), excluded_by_marker: false }]);
      // Không id người khác (chủ chốt, người giữ sổ lập phiếu, cổ đông khác), không tỷ lệ / số toà.
      const chuoi = JSON.stringify(toi);
      for (const la of [CHU, CHU2, GIU_SO, CD2, CD_XEM, U_CD2, TOA_1]) expect(chuoi).not.toContain(la);
      expect(chuoi).not.toMatch(/percent|building|created_by|maker/);
      // Cổ đông chỉ có quyền xem phân chia lợi nhuận cũng xem được số của mình.
      expect(await goi(U_XEM, r2())).toMatchObject({ shareholder: { id: CD_XEM }, unpaid_profit: 55, settlements: [] });
      // Cổ đông không có cả hai quyền, người không là cổ đông, người ngoài, công ty khác ⇒ 42501.
      for (const ai of [U_CD2, U_GO, GIU_SO, CHU2, NGOAI, null]) laLoi(await loiGoi(ai, r2()), "42501", "PROFIT_LEDGER_FORBIDDEN");
      laLoi(await loiGoi(U_CD1, r2(ORG_B)), "42501", "PROFIT_LEDGER_FORBIDDEN");
      laLoi(await loiGoi(U_CD1, "SELECT public.shareholder_profit_my_position_v1(NULL) AS v"), "22023", "PROFIT_LEDGER_BAD_INPUT");
      // Cổ đông đã xoá không còn tự xem được.
      await db.exec(`UPDATE public.shareholders SET deleted_at = now() WHERE id = '${CD_XEM}'`);
      laLoi(await loiGoi(U_XEM, r2()), "42501", "PROFIT_LEDGER_FORBIDDEN");
    });
  });
});

describe("mốc 'đã trả đủ đến hết tháng X' (Đợt 1) và bản ghi chốt", () => {
  const MA_MOC = "PROFIT_LEDGER_MARKER_BEFORE_SETTLEMENT";
  const e9QuanLy = (ql: string, thang: string | null, cu: string | null) =>
    `SELECT public.profit_ledger_set_marker_v1('${ORG_A}','MANAGER','${ql}', ${q(thang)}, 'Đã trả đủ theo sổ tay', ${q(cu)}, true, '${khoa("moc")}') AS v`;
  const soMoc = (dk = "true") => dem("app_private.profit_ledger_markers", dk);
  /** Được chia tháng 09 = 60, tháng 10 = 40; đã ứng 120 (đã duyệt); chốt đến hết tháng 10 không có tiền (X 100, K 100). */
  async function chotDenThang10(): Promise<KqChot> {
    await chotThang("2026-09-01", TOA_1, { [CD1]: 60 });
    await chotThang("2026-10-01", TOA_1, { [CD1]: 40 });
    await ungDaDuyet(120);
    const chot = await goi<KqChot>(CHU, w2({ thang: "2026-10-01", so: null, ngay: null, tien: 0, k: 100 }));
    expect(await ab(CD1)).toEqual([0, 20, 0, 0, -20]);
    return chot;
  }

  it("mốc đặt SỚM hơn tháng đã chốt chi bị lệnh đặt mốc của Đợt 1 từ chối (55000 PROFIT_LEDGER_MARKER_BEFORE_SETTLEMENT): tháng đã chốt không hiện lại 'chưa chi', không chi lần hai; mốc ĐÚNG tháng chốt thì qua; bản ghi đang bị mốc loại vẫn chặn mốc lùi; gỡ mốc vẫn qua", async () => {
    await giaoDich(async () => {
      const cu = await chotDenThang10();
      const truoc = [await soMoc(), await dem("app_private.profit_ledger_events", "event_kind = 'MARKER_SET'"), await viThe(CD1)];
      // Đúng kịch bản review: mốc "đã trả đủ đến hết tháng 9" (và sớm hơn) — gọi lệnh đặt mốc THẬT.
      for (const thang of ["2026-09-01", "2026-08-01"]) {
        const l = laLoi(await loiGoi(CHU, e9(CD1, thang, null)), "55000", `${MA_MOC}: đã chốt chi lợi nhuận đến hết tháng 10/2026`);
        expect(chiTiet(l), thang).toEqual({ settled_through_month: thang, last_settled_through_month: "2026-10-01" });
      }
      expect([await soMoc(), await dem("app_private.profit_ledger_events", "event_kind = 'MARKER_SET'"), await viThe(CD1)]).toEqual(truoc);
      expect(await mocHieuLuc(CD1)).toBeNull();
      // Tháng 10 KHÔNG hiện lại "chưa chi": không còn gì để chốt, gửi lại số cũ cũng không chi thêm.
      expect(await goi(CHU, r5(CD1))).toMatchObject({ through_month: "2026-10-01", recognized_amount: 0, cash_amount: null, can_submit: false, blocked_reason: "NOTHING_TO_SETTLE" });
      laLoi(await loiGoi(CHU, w2({ thang: "2026-10-01", tien: 40 })), "22023", "PROFIT_LEDGER_SETTLE_NOTHING");

      // Mốc ĐÚNG tháng chốt (tháng 10): qua như cũ; bản ghi chốt và phiếu tạm ứng nằm trước mốc.
      const moc = await goi<{ marker_id: string }>(CHU, e9(CD1, "2026-10-01", null));
      expect(await viThe(CD1)).toMatchObject({ unpaid_profit: 0, advance_outstanding: 0, advance_pending: 0, balance: 0, marker_month: "2026-10-01",
        last_settled_through_month: null, settled: { recognized: 0, offset: 0, cash: 0 } });
      const xem = await goi<{ months: unknown[]; settlements: { id: string; excluded_by_marker: boolean }[] }>(CHU, r5(CD1));
      expect(xem.months).toEqual([]);
      expect(xem.settlements).toMatchObject([{ id: cu.settlement_id, excluded_by_marker: true }]);
      // Bản ghi chốt đó vẫn CÒN HIỆU LỰC dù đang bị mốc loại: lùi mốc về tháng 9 (đè mốc tháng 10) vẫn bị chặn.
      const lui = laLoi(await loiGoi(CHU, e9(CD1, "2026-09-01", moc.marker_id)), "55000", MA_MOC);
      expect(chiTiet(lui)).toEqual({ settled_through_month: "2026-09-01", last_settled_through_month: "2026-10-01" });
      expect(await mocHieuLuc(CD1)).toBe(moc.marker_id);
      // Gỡ mốc (tháng NULL) không bị trigger đụng: bản ghi chốt và các phiếu cũ tính lại như trước khi đặt mốc.
      await goi(CHU, e9(CD1, null, moc.marker_id));
      expect(await ab(CD1)).toEqual([0, 20, 0, 0, -20]);
      expect((await viThe(CD1)).marker_month).toBeNull();
    });
  });
  it("mốc MUỘN hơn tháng đã chốt chi thì qua: bản ghi chốt lập trước mốc bị loại (như phiếu), chốt sau mốc tính bình thường và chỉ chọn được tháng sau mốc; gỡ mốc thì bản ghi cũ tính lại", async () => {
    await giaoDich(async () => {
      await chotThang("2026-09-01", TOA_1, { [CD1]: 60 });
      await chotThang("2026-10-01", TOA_1, { [CD1]: 40 });
      await ungDaDuyet(120);
      const cu = await goi<KqChot>(CHU, w2({ thang: "2026-09-01", so: null, ngay: null, tien: 0, k: 60 }));
      expect(await ab(CD1)).toEqual([40, 60, 0, 0, -20]);
      // Mốc "đã trả đủ đến hết tháng 10" — muộn hơn tháng đã chốt chi (tháng 9).
      const moc = await goi<{ marker_id: string }>(CHU, e9(CD1, "2026-10-01", null));
      expect(await viThe(CD1)).toMatchObject({ unpaid_profit: 0, advance_outstanding: 0, balance: 0, marker_month: "2026-10-01", last_settled_through_month: null,
        settled: { recognized: 0, offset: 0, cash: 0 } });
      await chotThang("2026-11-01", TOA_1, { [CD1]: 30 });
      const xem = await goi<{ months: unknown[]; settlements: { id: string; excluded_by_marker: boolean }[] }>(CHU, r5(CD1));
      expect(xem.months).toEqual([{ month: "2026-11-01", allocated: 30, unpaid_through: 30, selectable: true }]);
      expect(xem.settlements).toMatchObject([{ id: cu.settlement_id, excluded_by_marker: true }]);
      for (const thang of ["2026-09-01", "2026-10-01"]) {
        laLoi(await loiGoi(CHU, w2({ thang, tien: 30 })), "22023", "PROFIT_LEDGER_SETTLE_MONTH");
        laLoi(await loiGoi(CHU, r5(CD1, thang)), "22023", "PROFIT_LEDGER_SETTLE_MONTH");
      }
      // Chốt SAU mốc: tính bình thường (tạm ứng cũ nằm trước mốc nên không còn gì để khấu trừ).
      const moi = await goi<KqChot>(CHU, w2({ thang: "2026-11-01", tien: 30 }));
      expect(moi).toMatchObject({ recognized_amount: 30, advance_offset_amount: 0, cash_amount: 30 });
      expect(await viThe(CD1)).toMatchObject({ unpaid_profit: 0, settlement_cash_pending: 30, last_settled_through_month: "2026-11-01", settled: { recognized: 30, offset: 0, cash: 30 } });
      // Gỡ mốc: bản ghi chốt cũ (và phiếu tạm ứng cũ) tính lại, cùng bản ghi mới.
      await goi(CHU, e9(CD1, null, moc.marker_id));
      expect(await viThe(CD1)).toMatchObject({ unpaid_profit: 40, advance_outstanding: 60, advance_pending: 0, settlement_cash_pending: 30, balance: -20, marker_month: null,
        last_settled_through_month: "2026-11-01", settled: { recognized: 90, offset: 60, cash: 30 } });
    });
  });
  it("lần chốt hết hiệu lực thì mốc sớm đặt được: huỷ bản ghi chốt không tiền, hoặc huỷ / từ chối phiếu tiền của lần chốt", async () => {
    // (a) Lần chốt không tiền bị huỷ bằng lệnh huỷ bản ghi chốt.
    await giaoDich(async () => {
      const cu = await chotDenThang10();
      laLoi(await loiGoi(CHU, e9(CD1, "2026-09-01", null)), "55000", MA_MOC);
      await goi(CHU2, w3(cu.settlement_id));
      await goi(CHU, e9(CD1, "2026-09-01", null));
      // Nghĩa sẵn có của mốc (không còn lần chốt nào): tháng 10 chưa chi 40, phiếu tạm ứng cũ nằm trước mốc.
      expect(await viThe(CD1)).toMatchObject({ unpaid_profit: 40, advance_outstanding: 0, balance: 40, marker_month: "2026-09-01" });
    });
    // (b) Lần chốt có tiền: phiếu tiền còn chờ duyệt ⇒ còn hiệu lực ⇒ chặn; chủ huỷ phiếu tiền ⇒ hết hiệu lực ⇒ đặt được.
    await giaoDich(async () => {
      await chotThang("2026-09-01", TOA_1, { [CD1]: 60 });
      await chotThang("2026-10-01", TOA_1, { [CD1]: 40 });
      const cu = await goi<KqChot>(CHU, w2({ thang: "2026-10-01", tien: 100 }));
      laLoi(await loiGoi(CHU, e9(CD1, "2026-09-01", null)), "55000", MA_MOC);
      expect(await huyPhieu(cu.voucher_id as string, CHU, "PENDING")).toBeNull();
      await goi(CHU, e9(CD1, "2026-09-01", null));
      expect(await viThe(CD1)).toMatchObject({ unpaid_profit: 40, advance_outstanding: 0, balance: 40, marker_month: "2026-09-01" });
    });
    // (c) Phiếu tiền bị chủ thứ hai từ chối ⇒ cũng hết hiệu lực.
    await giaoDich(async () => {
      await chotThang("2026-09-01", TOA_1, { [CD1]: 60 });
      await chotThang("2026-10-01", TOA_1, { [CD1]: 40 });
      const cu = await goi<KqChot>(CHU, w2({ thang: "2026-10-01", tien: 100 }));
      expect(await tuChoi(cu.approval_request_id as string, CHU2)).toBeNull();
      await goi(CHU, e9(CD1, "2026-09-01", null));
      expect((await viThe(CD1)).marker_month).toBe("2026-09-01");
    });
  });
  it("chỉ mốc của ĐÚNG cổ đông có lần chốt bị chặn: cổ đông khác cùng công ty và mốc của lương điều hành đặt như cũ", async () => {
    await giaoDich(async () => {
      await chotThang("2026-09-01", TOA_1, { [CD1]: 60, [CD2]: 30 });
      await chotThang("2026-10-01", TOA_1, { [CD1]: 40, [CD2]: 10 });
      await ungDaDuyet(120);
      await goi<KqChot>(CHU, w2({ thang: "2026-10-01", so: null, ngay: null, tien: 0, k: 100 }));
      laLoi(await loiGoi(CHU, e9(CD1, "2026-09-01", null)), "55000", MA_MOC);
      // Cổ đông 2 chưa từng chốt chi: đặt mốc sớm tự do.
      await goi(CHU, e9(CD2, "2026-09-01", null));
      expect(await viThe(CD2)).toMatchObject({ unpaid_profit: 10, marker_month: "2026-09-01" });
      // Lương điều hành (chủ thể MANAGER): trigger không đụng.
      const QL = id(7401);
      await db.exec(`INSERT INTO public.profit_managers(id, organization_id, auth_user_id, name) VALUES ('${QL}','${ORG_A}', NULL, 'Quản lý điều hành')`);
      const moc = await goi<{ marker_id: string }>(CHU, e9QuanLy(QL, "2026-09-01", null));
      expect(moc.marker_id).toMatch(UUID);
      await goi(CHU, e9QuanLy(QL, "2026-08-01", moc.marker_id));     // lùi mốc của lương điều hành cũng không bị chặn
      expect([await soMoc("subject_kind = 'MANAGER'"), await soMoc(`subject_kind = 'SHAREHOLDER' AND shareholder_id = '${CD1}'`)]).toEqual([2, 0]);
    });
  });
  it("trigger của bảng mốc là chốt cuối (không chỉ lệnh đặt mốc): chèn thẳng dòng mốc sớm dưới khoá sổ cũng bị chặn; tên xếp sau chốt sẵn có của bảng", async () => {
    const tg = (await db.query<{ ten: string; def: string; bat: string }>(`SELECT t.tgname AS ten, pg_get_triggerdef(t.oid) AS def, t.tgenabled AS bat FROM pg_trigger t
      WHERE t.tgrelid = 'app_private.profit_ledger_markers'::regclass AND NOT t.tgisinternal AND t.tgtype & 4 = 4 ORDER BY t.tgname`)).rows;
    expect(tg.map((x) => x.ten)).toEqual(["a00_profit_ledger_markers_guard", "a10_profit_ledger_markers_settlement_guard"]);
    expect(tg[1].def).toContain("BEFORE INSERT ON app_private.profit_ledger_markers FOR EACH ROW EXECUTE FUNCTION app_private.guard_profit_ledger_marker_settlement_v1()");
    expect(tg.map((x) => x.bat)).toEqual(["O", "O"]);
    await giaoDich(async () => {
      await chotDenThang10();
      const chen = (thang: string | null) => `SELECT app_private.profit_ledger_lock_v1('${ORG_A}','SHAREHOLDER','${CD1}');
        INSERT INTO app_private.profit_ledger_markers(organization_id, subject_kind, shareholder_id, settled_through_month, reason, ledger_seq, created_by)
        VALUES ('${ORG_A}','SHAREHOLDER','${CD1}', ${q(thang)}, 'Chèn thẳng để đo trigger', nextval('app_private.profit_ledger_seq'), '${CHU}')`;
      laLoi(await loi(chen("2026-09-01")), "55000", MA_MOC);
      expect(await loi(chen("2026-10-01"))).toBeNull();
    });
  });
});

describe("lương của cổ đông kiêm nhân viên (cơ chế sẵn có, không đổi) trên hai con số", () => {
  it("phần lợi nhuận trả qua lương (Y) giảm lợi nhuận chưa chi, phần lương trừ tạm ứng (D) giảm tạm ứng đang có; X của tháng đã trả qua lương không tính lại", async () => {
    await giaoDich(async () => {
      await chotThang("2026-09-01", TOA_1, { [CD1]: 100 });
      await chotThang("2026-10-01", TOA_1, { [CD1]: 80 });
      await ungDaDuyet(40);
      // Lương tháng 09 trả phần lợi nhuận 100, trong đó trừ 40 tạm ứng (thực nhận 60 qua lương).
      await dongLuong({ cd: CD1, thang: "2026-09-01", y: 100, d: 40, phieu: id(3501) });
      expect(await viThe(CD1)).toMatchObject({ unpaid_profit: 80, advance_outstanding: 0, advance_pending: 0, balance: 80,
        components: { allocated: 180, salary_investment: 100, salary_advance_offset: 40, payouts_approved: 40 } });
      const xem = await goi<{ months: unknown[] }>(CHU, r5(CD1));
      expect(xem.months).toEqual([
        { month: "2026-09-01", allocated: 100, unpaid_through: 0, selectable: false },
        { month: "2026-10-01", allocated: 80, unpaid_through: 80, selectable: true }]);
      expect(xem).toMatchObject({ recognized_amount: 80, advance_offset_amount: 0, cash_amount: 80 });
      // Phiếu lương bị xoá ⇒ dòng lương hết tính (như số dư ròng): hai con số trở lại.
      await db.exec(`UPDATE public.income_expenses SET deleted_at = now() WHERE id = '${id(3501)}'`);
      expect(await ab(CD1)).toEqual([180, 40, 0, 0, 140]);
    });
  });
  /** Tiền cổ đông đã nhận, đọc thẳng từ dữ liệu: phiếu chi sổ tổng ĐÃ DUYỆT + phần lợi nhuận thực nhận qua lương (Y − D) của dòng lương còn tính; và tổng được chia. */
  const daNhan = (cd: string) => mot<{ quaPhieu: number; quaLuong: number; duocChia: number }>(`SELECT jsonb_build_object(
    'quaPhieu', (SELECT COALESCE(sum(ie.total_amount), 0) FROM public.income_expenses ie
                  WHERE ie.shareholder_id = '${cd}' AND ie.system_source = 'profit.ledger_payout' AND ie.approval_status = 'APPROVED' AND ie.deleted_at IS NULL),
    'quaLuong', (SELECT COALESCE(sum(l.investment_amount - l.advance_offset_amount), 0) FROM app_private.profit_ledger_salary_settlement_vouchers l
                   JOIN public.income_expenses ie ON ie.id = l.salary_voucher_id
                  WHERE l.shareholder_id = '${cd}' AND l.state = 'LINKED' AND ie.deleted_at IS NULL),
    'duocChia', (SELECT COALESCE(sum(a.amount), 0) FROM public.profit_allocations a JOIN public.profit_monthly pm ON pm.id = a.profit_monthly_id
                  WHERE a.shareholder_id = '${cd}' AND pm.status = 'LOCKED')) AS v`);
  const tho = async (cd: string) => {
    const c = (await viThe(cd)).components;
    return [c.unpaid_profit_raw, c.advance_outstanding_raw, c.advance_overoffset].map(Number);
  };

  it("chủ chốt tháng TRƯỚC khi lương tháng đó trả (lương giữ lại toàn bộ phần lợi nhuận, D = Y): tạm ứng không âm, không còn cặp số âm; tháng sau chốt chi ĐỦ phần được chia thêm; tổng tiền nhận = tổng được chia", async () => {
    await giaoDich(async () => {
      await chotThang("2026-09-01", TOA_1, { [CD1]: 30 });
      const c9 = await goi<KqChot>(CHU, w2({ thang: "2026-09-01", tien: 30 }));
      expect(await duyet(c9.voucher_id as string, CHU2)).toBeNull();
      expect(await ab(CD1)).toEqual([0, 0, 0, 0, 0]);
      // Lương tháng 09 chạy sau: công thức lương (theo số dư RÒNG) thấy tháng 09 đã chi hết nên giữ lại cả phần lợi nhuận: Y = 30, D = 30.
      await dongLuong({ cd: CD1, thang: "2026-09-01", y: 30, d: 30, phieu: id(3601) });
      expect(await ab(CD1)).toEqual([0, 0, 0, 0, 0]);
      expect(await tho(CD1)).toEqual([-30, -30, 30]);
      expect(await goi(CHU, r5(CD1))).toMatchObject({ through_month: "2026-09-01", recognized_amount: 0, cash_amount: null, blocked_reason: "NOTHING_TO_SETTLE",
        months: [{ month: "2026-09-01", allocated: 30, unpaid_through: 0, selectable: false }] });
      // Tháng 10 được chia thêm 50 ⇒ lợi nhuận chưa chi đúng 50, tạm ứng 0; chốt chi ĐỦ 50 (không thiếu phần lương đã giữ).
      await chotThang("2026-10-01", TOA_1, { [CD1]: 50 });
      expect(await ab(CD1)).toEqual([50, 0, 0, 0, 50]);
      expect(await goi(CHU, r5(CD1))).toMatchObject({ through_month: "2026-10-01", recognized_amount: 50, advance_offset_amount: 0, cash_amount: 50, advance_left: 0,
        months: [{ month: "2026-09-01", allocated: 30, unpaid_through: 0, selectable: false }, { month: "2026-10-01", allocated: 50, unpaid_through: 50, selectable: true }] });
      const c10 = await goi<KqChot>(CHU, w2({ thang: "2026-10-01", tien: 50 }));
      expect(c10).toMatchObject({ recognized_amount: 50, advance_offset_amount: 0, cash_amount: 50, state: "PENDING_APPROVAL" });
      // Bản ghi chốt ghi hai con số ĐÃ gấp (tạm ứng trước khi chốt không âm).
      expect(await banGhiChot(c10.settlement_id)).toMatchObject({ unpaid_before: "50.00", advance_before: "0.00" });
      expect(await ab(CD1)).toEqual([0, 0, 0, 50, 0]);
      expect(await duyet(c10.voucher_id as string, CHU2)).toBeNull();
      expect(await ab(CD1)).toEqual([0, 0, 0, 0, 0]);
      // Lương tháng 10 lại giữ toàn bộ phần lợi nhuận (D = Y = 50): vẫn 0 / 0.
      await dongLuong({ cd: CD1, thang: "2026-10-01", y: 50, d: 50, phieu: id(3602) });
      expect(await ab(CD1)).toEqual([0, 0, 0, 0, 0]);
      expect(await tho(CD1)).toEqual([-80, -80, 80]);
      // Tổng tiền nhận = hai lần chốt (30 + 50) + phần lợi nhuận thực nhận qua lương (Y − D = 0) = tổng được chia.
      expect(await daNhan(CD1)).toEqual({ quaPhieu: 80, quaLuong: 0, duocChia: 80 });
    });
  });
  it("thứ tự ngược — lương trả trước, chủ chốt sau: lương đã trả hết phần lợi nhuận nên không còn gì để chốt; tổng tiền nhận vẫn = tổng được chia", async () => {
    await giaoDich(async () => {
      await chotThang("2026-09-01", TOA_1, { [CD1]: 30 });
      // Lương tháng 09 chạy trước: chưa chi gì nên trả cả phần lợi nhuận qua lương, không trừ tạm ứng (Y = 30, D = 0).
      await dongLuong({ cd: CD1, thang: "2026-09-01", y: 30, d: 0, phieu: id(3611) });
      expect(await ab(CD1)).toEqual([0, 0, 0, 0, 0]);
      expect(await tho(CD1)).toEqual([0, 0, 0]);
      laLoi(await loiGoi(CHU, w2({ thang: "2026-09-01", tien: 30 })), "22023", "PROFIT_LEDGER_SETTLE_NOTHING");
      await chotThang("2026-10-01", TOA_1, { [CD1]: 50 });
      expect(await ab(CD1)).toEqual([50, 0, 0, 0, 50]);
      await dongLuong({ cd: CD1, thang: "2026-10-01", y: 50, d: 0, phieu: id(3612) });
      expect(await ab(CD1)).toEqual([0, 0, 0, 0, 0]);
      expect(await goi(CHU, r5(CD1))).toMatchObject({ through_month: "2026-10-01", recognized_amount: 0, cash_amount: null, blocked_reason: "NOTHING_TO_SETTLE" });
      for (const thang of ["2026-09-01", "2026-10-01"]) laLoi(await loiGoi(CHU, w2({ thang, tien: 50 })), "22023", "PROFIT_LEDGER_SETTLE_NOTHING");
      expect(await daNhan(CD1)).toEqual({ quaPhieu: 0, quaLuong: 80, duocChia: 80 });
    });
    // Xen kẽ: tháng 09 lương trước, tháng 10 chốt trước rồi lương giữ lại — vẫn cùng tổng.
    await giaoDich(async () => {
      await chotThang("2026-09-01", TOA_1, { [CD1]: 30 });
      await dongLuong({ cd: CD1, thang: "2026-09-01", y: 30, d: 0, phieu: id(3613) });
      await chotThang("2026-10-01", TOA_1, { [CD1]: 50 });
      const c10 = await goi<KqChot>(CHU, w2({ thang: "2026-10-01", tien: 50 }));
      expect(await duyet(c10.voucher_id as string, CHU2)).toBeNull();
      await dongLuong({ cd: CD1, thang: "2026-10-01", y: 50, d: 50, phieu: id(3614) });
      expect(await ab(CD1)).toEqual([0, 0, 0, 0, 0]);
      expect(await daNhan(CD1)).toEqual({ quaPhieu: 50, quaLuong: 30, duocChia: 80 });
    });
  });
  it("huỷ phiếu tạm ứng ĐÃ được một lần chốt còn hiệu lực khấu trừ ⇒ lợi nhuận chưa chi tăng lại đúng phần đã khấu trừ, tạm ứng 0; chốt lại ĐẾN CÙNG tháng đó chọn được và chi đúng phần ấy", async () => {
    await giaoDich(async () => {
      await chotThang("2026-09-01", TOA_1, { [CD1]: 100 });
      const ung = await ungDaDuyet(40);
      const chot = await goi<KqChot>(CHU, w2({ thang: "2026-09-01", tien: 60, k: 40 }));
      expect(chot).toMatchObject({ recognized_amount: 100, advance_offset_amount: 40, cash_amount: 60 });
      expect(await duyet(chot.voucher_id as string, CHU2)).toBeNull();
      expect(await ab(CD1)).toEqual([0, 0, 0, 0, 0]);
      // Chủ huỷ phiếu tạm ứng 40 (đã duyệt, chưa ghi sổ) SAU khi nó đã được khấu trừ: 40 đó công ty còn nợ lại.
      expect(await huyPhieu(ung.voucher_id, CHU, "APPROVED_UNPOSTED")).toBeNull();
      expect(await ab(CD1)).toEqual([40, 0, 0, 0, 40]);
      expect(await tho(CD1)).toEqual([0, -40, 40]);
      expect(await goi(CHU, r5(CD1))).toMatchObject({ through_month: "2026-09-01", recognized_amount: 40, advance_offset_amount: 0, cash_amount: 40, advance_left: 0,
        can_submit: true, months: [{ month: "2026-09-01", allocated: 100, unpaid_through: 40, selectable: true }] });
      const lai = await goi<KqChot>(CHU, w2({ thang: "2026-09-01", tien: 40 }));
      expect(lai).toMatchObject({ through_month: "2026-09-01", recognized_amount: 40, advance_offset_amount: 0, cash_amount: 40, state: "PENDING_APPROVAL" });
      expect(await banGhiChot(lai.settlement_id)).toMatchObject({ unpaid_before: "40.00", advance_before: "0.00" });
      expect(await ab(CD1)).toEqual([0, 0, 0, 40, 0]);
      expect(await duyet(lai.voucher_id as string, CHU2)).toBeNull();
      expect(await ab(CD1)).toEqual([0, 0, 0, 0, 0]);
      laLoi(await loiGoi(CHU, w2({ thang: "2026-09-01", tien: 40 })), "22023", "PROFIT_LEDGER_SETTLE_NOTHING");
      // Nhận 60 + 40 qua hai phiếu chốt (phiếu tạm ứng đã huỷ không tính) = được chia 100.
      expect(await daNhan(CD1)).toEqual({ quaPhieu: 100, quaLuong: 0, duocChia: 100 });
    });
  });
  it("lương trừ tạm ứng (D) dựa trên phiếu tạm ứng còn CHỜ duyệt: trước khi duyệt công ty còn nợ đúng D (tạm ứng 0, chờ duyệt = phiếu); duyệt ⇒ 0 / 0; từ chối ⇒ còn nợ D và chốt chi đúng D", async () => {
    /** Được chia 100; phiếu tạm ứng 40 còn chờ duyệt; lương tháng đó trả phần lợi nhuận 100 nhưng giữ lại 40 vì phiếu tạm ứng (lương tính theo số dư ròng). */
    const dung = async (phieuLuong: string) => {
      await chotThang("2026-09-01", TOA_1, { [CD1]: 100 });
      const ung = await goi<KqUng>(GIU_SO, w1({ cd: CD1, tien: 40 }));
      expect(await ab(CD1)).toEqual([100, 0, 40, 0, 60]);
      await dongLuong({ cd: CD1, thang: "2026-09-01", y: 100, d: 40, phieu: phieuLuong });
      expect(await ab(CD1)).toEqual([40, 0, 40, 0, 0]);
      expect(await tho(CD1)).toEqual([0, -40, 40]);
      return ung;
    };
    await giaoDich(async () => {
      const ung = await dung(id(3631));
      expect(await duyet(ung.voucher_id, CHU2)).toBeNull();
      expect(await ab(CD1)).toEqual([0, 0, 0, 0, 0]);
      expect(await tho(CD1)).toEqual([0, 0, 0]);
      // Nhận 40 (tạm ứng) + 60 (lương sau khi trừ) = được chia 100.
      expect(await daNhan(CD1)).toEqual({ quaPhieu: 40, quaLuong: 60, duocChia: 100 });
    });
    await giaoDich(async () => {
      const ung = await dung(id(3632));
      expect(await tuChoi(ung.approval_request_id, CHU2)).toBeNull();
      // Phiếu tạm ứng bị từ chối: 40 lương đã giữ lại là lợi nhuận công ty còn nợ.
      expect(await ab(CD1)).toEqual([40, 0, 0, 0, 40]);
      expect(await goi(CHU, r5(CD1))).toMatchObject({ through_month: "2026-09-01", recognized_amount: 40, advance_offset_amount: 0, cash_amount: 40, can_submit: true });
      const chot = await goi<KqChot>(CHU, w2({ thang: "2026-09-01", tien: 40 }));
      expect(await duyet(chot.voucher_id as string, CHU2)).toBeNull();
      expect(await ab(CD1)).toEqual([0, 0, 0, 0, 0]);
      expect(await daNhan(CD1)).toEqual({ quaPhieu: 40, quaLuong: 60, duocChia: 100 });
    });
  });
  it("[đặc tả] chốt NGAY khi phiếu tạm ứng đã bị lương trừ vẫn còn chờ duyệt, rồi phiếu đó được duyệt ⇒ lợi nhuận chưa chi ÂM đúng D (đã chi trước phần còn treo); lần chốt sau tự trừ lại", async () => {
    await giaoDich(async () => {
      await chotThang("2026-09-01", TOA_1, { [CD1]: 100 });
      const ung = await goi<KqUng>(GIU_SO, w1({ cd: CD1, tien: 40 }));
      await dongLuong({ cd: CD1, thang: "2026-09-01", y: 100, d: 40, phieu: id(3641) });
      // Màn xem trước cho chốt 40 trong lúc phiếu tạm ứng 40 còn chờ duyệt (advance_pending = 40 hiện kèm).
      expect(await goi(CHU, r5(CD1))).toMatchObject({ recognized_amount: 40, cash_amount: 40, advance_pending: 40, can_submit: true });
      const chot = await goi<KqChot>(CHU, w2({ thang: "2026-09-01", tien: 40 }));
      expect(await duyet(chot.voucher_id as string, CHU2)).toBeNull();
      expect(await ab(CD1)).toEqual([0, 0, 40, 0, -40]);
      // Phiếu tạm ứng được duyệt sau đó: cổ đông đã nhận 40 + 40 + 60 = 140 trên 100 được chia.
      expect(await duyet(ung.voucher_id, CHU2)).toBeNull();
      expect(await ab(CD1)).toEqual([-40, 0, 0, 0, -40]);
      expect(await daNhan(CD1)).toEqual({ quaPhieu: 80, quaLuong: 60, duocChia: 100 });
      // Tháng sau được chia 70: lần chốt chỉ chi 30 (X tính dồn trừ lại 40).
      await chotThang("2026-10-01", TOA_1, { [CD1]: 70 });
      expect(await goi(CHU, r5(CD1))).toMatchObject({ through_month: "2026-10-01", recognized_amount: 30, advance_offset_amount: 0, cash_amount: 30 });
    });
  });
});

describe("phiếu lập bằng lệnh cũ E5 (trước khi thu quyền ở 20261118171708) được xếp vào tạm ứng cho tới khi chủ chốt", () => {
  it("E5 của chủ: phiếu chờ duyệt ⇒ tạm ứng chờ duyệt; duyệt ⇒ tạm ứng đang có; chốt ⇒ khấu trừ hết, không chi thêm", async () => {
    await giaoDich(async () => {
      await chotThang("2026-09-01", TOA_1, { [CD1]: 100 });
      const cu = await e5Cu(CHU, e5(CD1, 100, false));
      expect(cu).toMatchObject({ maker_kind: "OWNER", within_amount: 100, advance_amount: 0 });
      expect(await ab(CD1)).toEqual([100, 0, 100, 0, 0]);
      expect(await duyet(cu.voucher_id, CHU2)).toBeNull();
      expect(await ab(CD1)).toEqual([100, 100, 0, 0, 0]);
      expect(await goi<KqChot>(CHU, w2({ thang: "2026-09-01", so: null, ngay: null, tien: 0, k: 100 }))).toMatchObject({ recognized_amount: 100, advance_offset_amount: 100, cash_amount: 0, state: "SETTLED" });
      expect(await ab(CD1)).toEqual([0, 0, 0, 0, 0]);
    });
  });
});

describe("bất biến trên kịch bản ngẫu nhiên: A − B_đã_duyệt − B_chờ_duyệt = số dư ròng, và mọi con số khớp mô hình viết độc lập", () => {
  let hat = 20261118;
  const rnd = () => {
    hat = (hat + 0x6d2b79f5) | 0;
    let t = Math.imul(hat ^ (hat >>> 15), 1 | hat);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const nguyen = (a: number, b: number) => a + Math.floor(rnd() * (b - a + 1));
  const chon = <T,>(ds: readonly T[]): T => ds[Math.floor(rnd() * ds.length)];
  const xs = (p: number) => rnd() < p;
  const THANG = ["2026-05-01", "2026-06-01", "2026-07-01", "2026-08-01", "2026-09-01", "2026-10-01"];
  const CO_DONG = [CD_R1, CD_R2, CD_R3];
  const thongKe = { kichBan: 0, phepSo: 0, chotCoTien: 0, chotKhongTien: 0, coKhauTru: 0, tuChoi: 0, huy: 0, huyChot: 0, moc: 0, goMoc: 0, chotSauMoc: 0,
    luong: 0, aAm: 0, gap: 0, gapKhiAAm: 0, chotCoGap: 0, khongChotDuoc: 0, moChot: 0, phieuCu: 0, tienChoDuyet: 0,
    mocBiChan: 0, mocSauChot: 0, macDinhKhongChotDuoc: 0 };

  // ── Mô hình JS: KHÔNG gọi hàm số dư nào của database. thuTu = thứ tự ghi vào sổ (đúng thứ tự ledger_seq vì chạy tuần tự).
  type TrangThai = "CHO" | "DUYET" | "CHET";
  interface Phieu { id: string; tien: number; tt: TrangThai; thuTu: number }
  interface BanGhi { id: string; thang: string; x: number; k: number; tien: number; phieu: string | null; thuTu: number; huy: boolean }
  interface Luong { thang: string; y: number; d: number; song: boolean; phieu: string }
  interface So { phieu: Phieu[]; chot: BanGhi[]; luong: Luong[]; moc: { thuTu: number; thang: string | null } | null }
  /** (toà|tháng) → trạng thái + phần của từng cổ đông. Trạng thái là của cả kỳ, chung mọi cổ đông. */
  type Ky = Map<string, { locked: boolean; phan: Map<string, number> }>;
  const tron = (x: number) => Math.round(x * 100) / 100 + 0;

  function tinh(ky: Ky, so: So, cd: string) {
    const mocThang = so.moc?.thang ?? null;
    const sauThang = (th: string) => mocThang === null || th > mocThang;
    const sauSeq = (t: number) => mocThang === null || t > (so.moc as { thuTu: number }).thuTu;
    const phieuSong = (pid: string) => so.phieu.find((p) => p.id === pid)?.tt !== "CHET";
    const theoThang = new Map<string, number>();
    for (const [k, v] of ky) {
      const th = k.split("|")[1];
      if (!v.locked || !v.phan.has(cd) || !sauThang(th)) continue;
      theoThang.set(th, (theoThang.get(th) ?? 0) + (v.phan.get(cd) as number));
    }
    const luong = so.luong.filter((l) => l.song && sauThang(l.thang));
    const chotSong = so.chot.filter((c) => !c.huy && (c.phieu === null || phieuSong(c.phieu)) && sauSeq(c.thuTu));
    const phieuTien = new Set(so.chot.filter((c) => c.phieu !== null).map((c) => c.phieu as string));
    const tong = (ds: number[]) => ds.reduce((a, b) => a + b, 0);
    const sx = tong(chotSong.map((c) => c.x));
    const sk = tong(chotSong.map((c) => c.k));
    const ung = (tt: TrangThai) => tong(so.phieu.filter((p) => p.tt === tt && sauSeq(p.thuTu) && !phieuTien.has(p.id)).map((p) => p.tien));
    const aTho = tong([...theoThang.values()]) - tong(luong.map((l) => l.y)) - sx;
    const bTho = ung("DUYET") - tong(luong.map((l) => l.d)) - sk;
    // Luật gấp (một chiều): tạm ứng không bao giờ âm; phần âm là lợi nhuận công ty còn nợ, cộng vào "chưa chi" và vào X của MỌI tháng.
    const gap = bTho < 0 ? -bTho : 0;
    const a = aTho + gap;
    const b = bTho < 0 ? 0 : bTho;
    const bCho = ung("CHO");
    const tienCho = tong(chotSong.filter((c) => c.phieu !== null && so.phieu.find((p) => p.id === c.phieu)?.tt === "CHO").map((c) => c.tien));
    const lanCuoi = chotSong.map((c) => c.thang).sort().at(-1) ?? null;
    const thang = [...theoThang.keys()].sort().map((th) => {
      const x = tong([...theoThang].filter(([t]) => t <= th).map(([, v]) => v)) - tong(luong.filter((l) => l.thang <= th).map((l) => l.y)) - sx + gap;
      return { month: th, allocated: tron(theoThang.get(th) as number), unpaid_through: tron(x), selectable: (lanCuoi === null || th >= lanCuoi) && tron(x) > 0 };
    });
    // Số dư ròng tính từ số THÔ (lõi Đợt 1 không biết luật gấp) — phải bằng a − b − bCho của số đã gấp.
    // Tháng mặc định của xem trước = tháng ĐỦ ĐIỀU KIỆN lớn nhất (các tháng liệt kê đã ở sau mốc; đủ điều kiện = không trước lần chốt gần nhất).
    const cacThang = [...theoThang.keys()].sort();
    const cuoi = cacThang.at(-1) ?? null;
    const macDinh = cuoi !== null && (lanCuoi === null || cuoi >= lanCuoi) ? cuoi : null;
    // Luật của bảng mốc: xét MỌI bản ghi chốt còn hiệu lực, KỂ CẢ bản đang bị mốc hiện tại loại.
    const chotMoiSong = so.chot.filter((c) => !c.huy && (c.phieu === null || phieuSong(c.phieu))).map((c) => c.thang).sort().at(-1) ?? null;
    return { viThe: [a, b, bCho, tienCho, aTho - bTho - bCho].map(tron), thang, b: tron(b), gap: tron(gap), tho: [aTho, bTho].map(tron), macDinh, chotMoiSong };
  }

  async function kichBan(k: number) {
    let n = 8000;
    let thuTu = 0;
    const ky: Ky = new Map();
    const so = new Map<string, So>(CO_DONG.map((cd) => [cd, { phieu: [], chot: [], luong: [], moc: null }]));
    const cua = (cd: string) => so.get(cd) as So;

    async function doiChieu(nhan: string) {
      for (const cd of CO_DONG) {
        const m = tinh(ky, cua(cd), cd);
        const v = await viThe(cd);
        const so5 = [v.unpaid_profit, v.advance_outstanding, v.advance_pending, v.settlement_cash_pending, v.balance].map(Number);
        expect(so5, `${nhan} · ${cd.slice(-2)} vị thế`).toEqual(m.viThe);
        // Tạm ứng không bao giờ âm, và bất biến giữ trên số ĐÃ gấp — khẳng định thẳng trên số của database.
        expect(so5[1], `${nhan} · ${cd.slice(-2)} tạm ứng không âm`).toBeGreaterThanOrEqual(0);
        expect(tron(so5[0] - so5[1] - so5[2]), `${nhan} · ${cd.slice(-2)} bất biến`).toBe(so5[4]);
        expect([v.components.unpaid_profit_raw, v.components.advance_outstanding_raw, v.components.advance_overoffset].map(Number),
          `${nhan} · ${cd.slice(-2)} số thô`).toEqual([...m.tho, m.gap]);
        expect(await soDuRong(cd), `${nhan} · ${cd.slice(-2)} số dư ròng`).toBe(m.viThe[4]);
        const xem = await goi<{ months: unknown[] }>(CHU, r5(cd, null, null));
        expect(xem.months, `${nhan} · ${cd.slice(-2)} các tháng`).toEqual(m.thang);
        thongKe.phepSo += 6;
        if (m.viThe[0] < 0) thongKe.aAm++;
        if (m.gap > 0) thongKe.gap++;
        if (m.gap > 0 && m.tho[0] < 0) thongKe.gapKhiAAm++;
        if (m.viThe[3] > 0) thongKe.tienChoDuyet++;
      }
    }
    /** Các tháng sớm hơn tháng của lần chốt CÒN HIỆU LỰC lớn nhất (kể cả lần đang bị mốc loại) — đặt mốc vào đó phải bị từ chối. */
    const thangSomHonLanChot = (cd: string) => {
      const lanChot = tinh(ky, cua(cd), cd).chotMoiSong;
      return lanChot === null ? [] : THANG.filter((t) => t < lanChot);
    };
    /** Đặt mốc bằng lệnh THẬT của Đợt 1. Luật của bảng mốc: mốc có tháng sớm hơn một lần chốt còn hiệu lực ⇒ 55000, không gì đổi. */
    async function datMoc(cd: string, thang: string | null) {
      const s = cua(cd);
      const lanChot = tinh(ky, s, cd).chotMoiSong;
      if (thang !== null && lanChot !== null && lanChot > thang) {
        const l = laLoi(await loiGoi(CHU, e9(cd, thang, await mocHieuLuc(cd))), "55000", "PROFIT_LEDGER_MARKER_BEFORE_SETTLEMENT");
        expect(chiTiet(l), `kịch bản ${k} · mốc bị chặn`).toEqual({ settled_through_month: thang, last_settled_through_month: lanChot });
        thongKe.mocBiChan++;
        return;
      }
      await goi(CHU, e9(cd, thang, await mocHieuLuc(cd)));
      s.moc = { thuTu: ++thuTu, thang };
      thongKe.moc++;
      if (thang === null) thongKe.goMoc++;
      else if (lanChot !== null) thongKe.mocSauChot++;
    }
    /** Số phận của một phiếu vừa lập: để chờ, chủ thứ hai duyệt, bị từ chối, hoặc chủ huỷ. */
    async function soPhan(p: Phieu, yeuCau: string, tyLeDuyet = 0.5) {
      const r = rnd() * 0.5 / tyLeDuyet;
      if (r < 0.5) { expect(await duyet(p.id, CHU2)).toBeNull(); p.tt = "DUYET"; }
      else if (r < 0.62) { expect(await tuChoi(yeuCau, CHU2)).toBeNull(); p.tt = "CHET"; thongKe.tuChoi++; }
      else if (r < 0.74) { expect(await huyPhieu(p.id, CHU, "PENDING")).toBeNull(); p.tt = "CHET"; thongKe.huy++; }
    }

    const viec = [...Array<string>(nguyen(3, 6)).fill("phanBo"), ...Array<string>(nguyen(3, 6)).fill("ung"), ...Array<string>(nguyen(3, 5)).fill("chot"),
      ...Array<string>(nguyen(0, 2)).fill("chiCu"), ...Array<string>(nguyen(0, 2)).fill("luong"), ...Array<string>(nguyen(0, 3)).fill("moc"),
      ...Array<string>(nguyen(0, 1)).fill("doiKy"), ...Array<string>(nguyen(0, 1)).fill("huyChot")]
      .map((v) => ({ v, r: rnd() })).sort((x, y) => x.r - y.r).map((x) => x.v);
    // Luôn có vài tháng đã chốt ngay từ đầu để các việc sau có nghĩa.
    for (const v of ["phanBo", "phanBo", ...viec]) {
      // Việc đặt mốc: nửa số lần nhắm cổ đông ĐANG có mốc (để có đè mốc / gỡ mốc).
      const coMoc = CO_DONG.filter((c) => cua(c).moc?.thang != null);
      const cd = v === "moc" && coMoc.length > 0 && xs(0.5) ? chon(coMoc) : chon(CO_DONG);
      const s = cua(cd);
      if (v === "phanBo") {
        const [toa, th] = [chon([TOA_1, TOA_2]), chon(THANG)];
        const kk = `${toa}|${th}`;
        const cu = ky.get(kk) ?? { locked: xs(0.9), phan: new Map<string, number>() };
        for (const c of CO_DONG) if (c === cd || xs(0.4)) cu.phan.set(c, nguyen(-30, 150));
        ky.set(kk, cu);
        await chotThang(th, toa, Object.fromEntries(cu.phan), cu.locked ? "LOCKED" : "DRAFT");
      } else if (v === "doiKy" && ky.size > 0) {
        // Mở chốt một kỳ đã chốt (kể cả kỳ đã chốt chi), hoặc chốt lại kỳ đang mở.
        const kk = chon([...ky.keys()]);
        const cu = ky.get(kk) as { locked: boolean; phan: Map<string, number> };
        cu.locked = !cu.locked;
        const [toa, th] = kk.split("|");
        await chotThang(th, toa, {}, cu.locked ? "LOCKED" : "DRAFT");
        thongKe.moChot++;
      } else if (v === "ung") {
        const kq = await goi<KqUng>(GIU_SO, w1({ cd, tien: xs(0.35) ? nguyen(150, 400) : nguyen(1, 80) }));
        const p: Phieu = { id: kq.voucher_id, tien: kq.amount, tt: "CHO", thuTu: ++thuTu };
        s.phieu.push(p);
        await soPhan(p, kq.approval_request_id, 0.65);
      } else if (v === "chiCu") {
        const kq = await e5Cu(CHU, e5(cd, nguyen(1, 60), true));
        const p: Phieu = { id: kq.voucher_id, tien: kq.amount, tt: "CHO", thuTu: ++thuTu };
        s.phieu.push(p);
        thongKe.phieuCu++;
        await soPhan(p, kq.approval_request_id);
      } else if (v === "luong") {
        const l: Luong = { thang: chon(THANG), y: nguyen(-10, 60), d: nguyen(0, 20), song: true, phieu: id(n++) };
        await dongLuong({ cd, thang: l.thang, y: l.y, d: l.d, phieu: l.phieu });
        s.luong.push(l);
        thongKe.luong++;
        if (xs(0.2)) { await db.exec(`UPDATE public.income_expenses SET deleted_at = now() WHERE id = '${l.phieu}'`); l.song = false; }
      } else if (v === "moc") {
        // Khi cổ đông đang có lần chốt còn hiệu lực: nhắm cả hai phía — tháng SỚM hơn (bị bảng mốc từ chối) và tháng từ lần chốt trở đi (qua).
        const som = thangSomHonLanChot(cd);
        const tuLanChot = THANG.filter((t) => !som.includes(t));
        await datMoc(cd, s.moc !== null && s.moc.thang !== null && xs(0.4) ? null
          : som.length > 0 && xs(0.4) ? chon(som) : som.length > 0 && tuLanChot.length > 0 && xs(0.7) ? chon(tuLanChot) : chon(THANG));
      } else if (v === "chot") {
        const m = tinh(ky, s, cd);
        const duoc = m.thang.filter((t) => t.selectable);
        const xem = await goi<{ can_submit: boolean; through_month: string | null; cash_amount: number | null }>(CHU, r5(cd, null, SO_QUY));
        // Không truyền tháng ⇒ tháng đủ điều kiện lớn nhất (kể cả khi không còn gì để chốt ở tháng đó).
        expect(xem.through_month, `kịch bản ${k} · tháng mặc định`).toBe(m.macDinh);
        if (m.macDinh !== null && !m.thang.some((t) => t.month === m.macDinh && t.selectable)) thongKe.macDinhKhongChotDuoc++;
        if (duoc.length === 0) {
          expect(xem, `kịch bản ${k} · không chốt được`).toMatchObject({ can_submit: false });
          thongKe.khongChotDuoc++;
        } else {
          // Chủ thường chốt đến tháng lớn nhất; đôi khi chọn tháng sớm hơn.
          const t = xs(0.75) ? (duoc.at(-1) as { month: string; unpaid_through: number }) : chon(duoc);
          const kMong = tron(Math.min(t.unpaid_through, Math.max(m.b, 0)));
          const tienMong = tron(t.unpaid_through - kMong);
          const chot = await goi<KqChot>(CHU, w2({ cd, thang: t.month, x: t.unpaid_through, tien: tienMong }));
          expect([chot.recognized_amount, chot.advance_offset_amount, chot.cash_amount], `kịch bản ${k} · chốt ${t.month}`).toEqual([t.unpaid_through, kMong, tienMong]);
          if (s.moc !== null && s.moc.thang !== null) thongKe.chotSauMoc++;
          if (kMong > 0) thongKe.coKhauTru++;
          if (m.gap > 0) thongKe.chotCoGap++;
          let p: Phieu | null = null;
          if (chot.voucher_id !== null) {
            p = { id: chot.voucher_id, tien: tienMong, tt: "CHO", thuTu: ++thuTu };
            s.phieu.push(p);
            thongKe.chotCoTien++;
          } else thongKe.chotKhongTien++;
          s.chot.push({ id: chot.settlement_id, thang: t.month, x: t.unpaid_through, k: kMong, tien: tienMong, phieu: chot.voucher_id, thuTu: ++thuTu, huy: false });
          if (p !== null) await soPhan(p, chot.approval_request_id as string);
          else if (xs(0.3)) { await goi(CHU, w3(chot.settlement_id)); (s.chot.at(-1) as BanGhi).huy = true; thongKe.huyChot++; }
          // Ngay sau lần chốt, đôi khi chủ thử lùi mốc về trước tháng vừa chốt: lần chốt còn hiệu lực thì bị chặn, đã chết thì qua.
          const som = thangSomHonLanChot(cd);
          if (som.length > 0 && xs(0.4)) await datMoc(cd, chon(som));
        }
      } else if (v === "huyChot") {
        const c = s.chot.find((x) => x.phieu === null && !x.huy);
        if (c) { await goi(CHU, w3(c.id)); c.huy = true; thongKe.huyChot++; }
      }
      await doiChieu(`kịch bản ${k} · sau ${v}`);
    }
    // Màn của chủ (R1) báo đúng các con số đó.
    const r = await goi<{ shareholders: { shareholder_id: string; unpaid_profit: number; advance_outstanding: number; advance_pending: number; settlement_cash_pending: number; balance: number }[] }>(CHU, r1());
    for (const cd of CO_DONG) {
      const dong = r.shareholders.find((x) => x.shareholder_id === cd);
      expect([dong?.unpaid_profit, dong?.advance_outstanding, dong?.advance_pending, dong?.settlement_cash_pending, dong?.balance], `kịch bản ${k} · R1 ${cd.slice(-2)}`)
        .toEqual(tinh(ky, cua(cd), cd).viThe);
    }
    thongKe.kichBan++;
  }

  it("40 kịch bản (phân bổ nhiều toà kể cả lỗ, mở chốt / chốt lại, tạm ứng, phiếu chi cũ, lương, mốc, chốt có / không tiền, từ chối, huỷ, huỷ bản ghi chốt): sau MỖI việc, vị thế (tạm ứng không bao giờ âm), số dư ròng và X từng tháng khớp mô hình", async () => {
    for (let k = 1; k <= 40; k++) await giaoDich(() => kichBan(k));
    expect(thongKe.kichBan).toBe(40);
    // Chống xanh rỗng: đủ từng loại tình huống.
    expect(thongKe.phepSo).toBeGreaterThan(5000);
    expect(thongKe.chotCoTien).toBeGreaterThan(40);
    expect(thongKe.chotKhongTien).toBeGreaterThan(10);
    expect(thongKe.coKhauTru).toBeGreaterThan(20);
    expect(thongKe.tuChoi).toBeGreaterThan(15);
    expect(thongKe.huy).toBeGreaterThan(20);
    expect(thongKe.huyChot).toBeGreaterThan(3);
    expect(thongKe.moc).toBeGreaterThan(30);
    expect(thongKe.goMoc).toBeGreaterThan(3);
    expect(thongKe.chotSauMoc).toBeGreaterThan(5);
    expect(thongKe.luong).toBeGreaterThan(20);
    expect(thongKe.moChot).toBeGreaterThan(8);
    expect(thongKe.phieuCu).toBeGreaterThan(20);
    expect(thongKe.aAm).toBeGreaterThan(50);
    // Luật gấp có việc để làm: nhiều trạng thái tạm ứng thô âm (đo 18/11: 127), cả khi lợi nhuận chưa chi thô cũng âm (44), và có lần chốt lúc đang gấp (5).
    // Luật của bảng mốc có việc để làm (đo 18/11: 36 lần mốc sớm bị từ chối, 6 lần mốc từ tháng chốt trở đi vẫn đặt được), và
    // tháng mặc định của xem trước nhiều lần là tháng không còn gì để chốt (36).
    expect(thongKe.mocBiChan).toBeGreaterThan(15);
    expect(thongKe.mocSauChot).toBeGreaterThan(3);
    expect(thongKe.macDinhKhongChotDuoc).toBeGreaterThan(15);
    expect(thongKe.gap).toBeGreaterThan(60);
    expect(thongKe.gapKhiAAm).toBeGreaterThan(20);
    expect(thongKe.chotCoGap).toBeGreaterThan(3);
    expect(thongKe.tienChoDuyet).toBeGreaterThan(50);
    expect(thongKe.khongChotDuoc).toBeGreaterThan(10);
  }, 600000);
});
