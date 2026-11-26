import { createHash, randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * Migration 20261119032905 — chủ tự Duyệt và Chi phiếu sổ tổng do CHỦ lập (chốt chặn F1, app_private.guard_profit_ledger_payout_v1).
 * Chủ chốt 19/11/2026 ("làm đúng luồng thu chi"): phiếu vẫn lưu xong ở Chờ duyệt rồi mới duyệt (rào "lập rồi mới duyệt" của
 * vòng đời V2 giữ nguyên), Chi vẫn phải có chứng từ; phiếu maker_kind = 'OWNER' (phiếu tiền của lần chốt chi W2, lương điều
 * hành, phiếu E5 cũ) mà người thao tác có quyền chi của đúng loại chủ thể thì (a) người lập tự duyệt, (b) người nhận duyệt,
 * (c) người nhận ghi sổ (Chi — quyền theo CẢ CÔNG TY, kiểm không khoá dòng). Phiếu tạm ứng giữ luật cũ.
 *
 * Chạy THẬT trên PostgreSQL nhúng, cùng khung nạp với soTongLoiNhuanTamUngChotMigration.test.ts (chép, không import):
 *  - M1 → đọc → chặn → tạo (nền Đợt 1) → 20261118041911 → 20261118143113 → 20261118171708 (mỗi file hai lượt) → migration
 *    này HAI lượt, chụp mọi hàm trước / sau từng lượt;
 *  - RPC vòng đời V2 (approve / post / approve_and_post), cầu a85, a87, rào "lập rồi mới duyệt" và mọi hàm chúng gọi là THÂN
 *    PRODUCTION chọn theo md5; phiếu do CHÍNH lệnh lập của sổ tổng (W2, W1, E5, lương điều hành) lập rồi duyệt / ghi sổ bằng
 *    RPC thật qua F1, F1b, F2, F4, F5 thật.
 * Thay bằng bản giả: submit_financial_request_v1 (máy luật duyệt), append_income_expense_event_v1, finance_v2_log_event,
 * org_today_v1. Mỗi ca chạy trong MỘT giao dịch rồi ROLLBACK ⇒ "lập ở giao dịch trước" giả lập bằng birth_txid giả đặt trong
 * ngữ cảnh LẬP (giaSinhTruoc, như các test sổ tổng khác); MỘT ca dựng nền riêng và chạy HAI giao dịch thật (lập COMMIT rồi duyệt
 * và chi ở giao dịch sau) không giả gì. Ca có tên mở đầu "[ghim]" chỉ đo văn bản / md5 — script đột biến cần ít nhất một ca
 * KHÁC đỏ.
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
/** Migration của file này (20261119032905): F1 — chủ tự duyệt / tự chi phiếu chủ lập. */
const FILE_CHU_TU = "supabase/migrations/20261119032905_so_tong_loi_nhuan_chu_tu_duyet_chi.sql";
const TEN_CHU_TU = FILE_CHU_TU.slice(DIR.length + 1);
const CHU_TU = readFileSync(FILE_CHU_TU, "utf8");
/** Thân migration không có BEGIN / COMMIT của chính file — để dán vào một giao dịch (như lane). */
const THAN_CHU_TU = CHU_TU.replace(/^BEGIN;\s*$/m, "").replace(/^COMMIT;\s*$/m, "");
const F1 = "app_private.guard_profit_ledger_payout_v1";
const F1_REGPROC = `${F1}()`;
/** md5 thân F1 (prosrc, bỏ CR): bản của 20261115084015 = production (đo 19/11/2026) và bản của migration này. */
const MD5_F1_PROD = "668c5e5c0a1e2c7dda74f0bd7f5f6e3b";
const MD5_F1_MOI = "126c1ddc4cdd6acf6b9af64561d87794";
const F1_CHAN = dinhNghiaTrong(F1, FILE_CHAN.slice(DIR.length + 1));
const F1_CHU_TU = dinhNghiaTrong(F1, TEN_CHU_TU);

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
const e9 = (cd: string, thang: string | null, cu: string | null, xacNhan = true) =>
  `SELECT public.profit_ledger_set_marker_v1('${ORG_A}','SHAREHOLDER','${cd}', ${q(thang)}, 'Đã trả đủ theo sổ tay', ${q(cu)}, ${xacNhan}, '${khoa("moc")}') AS v`;

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
  // Migration của file này — hai lượt, chụp mọi hàm trước / sau từng lượt. Mọi ca bên dưới chạy trên trạng thái SAU file này.
  ghi.md5F1Truoc = await mot<string>(`SELECT md5(replace(p.prosrc, chr(13), '')) AS v FROM pg_proc p WHERE p.oid = '${F1_REGPROC}'::regprocedure`);
  ghi.hamTruoc = await chupHam();
  await db.exec(CHU_TU);
  ghi.ham1 = await chupHam();
  await db.exec(CHU_TU);
  ghi.ham2 = await chupHam();
  await datRoute("CANONICAL");
}, 300000);
afterAll(() => db.close());

// ── Trợ giúp riêng của file này ────────────────────────────────────────────────
const md5F1 = (d: PGlite = db) => d.query<{ v: string }>(`SELECT md5(replace(p.prosrc, chr(13), '')) AS v FROM pg_proc p
  WHERE p.oid = '${F1_REGPROC}'::regprocedure`).then((r) => r.rows[0]?.v ?? null);
interface DuyetChiTuyChon {
  /** true = một chứng từ FINALIZED mới; chuỗi = đúng mã chứng từ đó; false = không chứng từ. */
  anh?: boolean | string;
  /** Khoá chống gửi trùng; vắng = khoá mới. */
  k?: string;
  /** [approval_version, posting_version] mong đợi; vắng = đọc từ phiếu lúc gọi. */
  ver?: [number, number];
}
/** Duyệt và Chi bằng RPC thật approve_and_post_income_expense_v2 (đúng lệnh hộp "Duyệt và Chi" của màn Chờ duyệt / Thu chi). */
const sqlDuyetChi = (p: string, so: string, o: DuyetChiTuyChon = {}) => {
  const anh = o.anh ?? true;
  const chungTu = anh === false ? "'[]'::jsonb"
    : typeof anh === "string" ? `jsonb_build_array('${anh}')` : `jsonb_build_array(public.test_chung_tu('${ORG_A}'))`;
  const ver = o.ver ? [String(o.ver[0]), String(o.ver[1])]
    : [`(SELECT approval_version FROM public.income_expenses WHERE id = '${p}')`, `(SELECT posting_version FROM public.income_expenses WHERE id = '${p}')`];
  return `SELECT public.approve_and_post_income_expense_v2(jsonb_build_object(
    'subjectId', '${p}', 'cashbookId', '${so}', 'postedOn', '2026-11-12', 'idempotencyKey', '${o.k ?? khoa("duyetchi")}',
    'expectedApprovalVersion', ${ver[0]}, 'expectedPostingVersion', ${ver[1]}, 'evidenceIds', ${chungTu})) AS v`;
};
/** Chi (post_approved_income_expense_v2) KHÔNG kèm chứng từ. */
const sqlGhiSoKhongAnh = (p: string, so: string) => `SELECT public.post_approved_income_expense_v2(jsonb_build_object(
  'subjectId', '${p}', 'cashbookId', '${so}', 'postedOn', '2026-11-12', 'idempotencyKey', '${khoa("ghiso")}',
  'expectedApprovalVersion', (SELECT approval_version FROM public.income_expenses WHERE id = '${p}'),
  'expectedPostingVersion', (SELECT posting_version FROM public.income_expenses WHERE id = '${p}'),
  'evidenceIds', '[]'::jsonb)) AS v`;
/** Duyệt và Chi (qua F1) ở "lời gọi sau" lệnh lập — birth_txid giả của giao dịch trước. */
async function duyetChi(p: string, user: string, so: string, anh: boolean | string = true): Promise<Loi | null> {
  await giaSinhTruoc(p);
  await dangNhap(user);
  return loi(sqlDuyetChi(p, so, { anh }));
}
/** Duyệt (so = null) hoặc Duyệt và Chi NGAY trong giao dịch của lệnh lập — không giả "lập ở giao dịch trước". */
async function duyetCungGiaoDich(p: string, user: string, so: string | null): Promise<Loi | null> {
  await dangNhap(user);
  return loi(so ? sqlDuyetChi(p, so) : sqlDuyet(p));
}
const trangThai = async (p: string) => {
  const r = await phieu(p);
  return { approval_status: r.approval_status, posting_status: r.posting_status };
};
interface DongNhatKy { event_kind: string; actor_id: string; payload: Record<string, unknown> }
const nhatKy = (p: string) => db.query<DongNhatKy>(`SELECT event_kind, actor_id, payload FROM app_private.profit_ledger_events
  WHERE voucher_id = '${p}' ORDER BY event_kind`).then((r) => r.rows);
/** Dấu 'owner_self' của từng loại nhật ký (null = không có dấu). */
const dauChuTu = async (p: string) => Object.fromEntries((await nhatKy(p)).map((e) => [e.event_kind, e.payload.owner_self ?? null]));
interface DongButToan { event_kind: string; account_id: string; net: string; source_kind: string; amount_basis: string;
  posted_by_user_id: string; dong: unknown }
const butToan = (p: string) => db.query<DongButToan>(`SELECT p.event_kind, p.account_id, p.net_cash_effect::text AS net, p.source_kind,
    p.amount_basis, p.posted_by_user_id,
    (SELECT jsonb_agg(jsonb_build_array(l.account_id, l.line_kind, l.signed_amount::text) ORDER BY l.line_kind)
       FROM public.income_expense_posting_lines l WHERE l.posting_id = p.id) AS dong
  FROM public.income_expense_postings p WHERE p.voucher_id = '${p}' ORDER BY p.created_at, p.event_kind`).then((r) => r.rows);
const yeuCau = (p: string) => db.query<{ state: string }>(`SELECT state FROM public.approval_requests
  WHERE subject_type = 'FINANCIAL_VOUCHER' AND subject_id = '${p}' ORDER BY submission_no`).then((r) => r.rows.map((x) => x.state));
/** Chủ chốt chi lợi nhuận một cổ đông (W2) đến hết một tháng ⇒ một phiếu tiền chờ duyệt. Trả id phiếu. */
async function chotChi(user: string, cd: string, tien: number, o: { so?: string; thang?: string; khoa?: string } = {}): Promise<string> {
  const kq = await goi<KqChot>(user, w2({ cd, thang: o.thang ?? "2026-09-01", tien, so: o.so ?? SO_QUY, khoa: o.khoa }));
  expect(kq).toMatchObject({ state: "PENDING_APPROVAL", cash_amount: tien });
  return kq.voucher_id as string;
}

// Lương điều hành: QL_CHU nhận bằng đăng nhập của chính nick chủ CHU (người đang giữ SO_QUY).
const QL_CHU = id(81);
interface KqLuong { voucher_id: string; state: string; balance_before: number }
async function nenLuongDieuHanh(duoc: number) {
  await db.exec(`INSERT INTO app_private.server_feature_flags(feature_key, domain, mode, commit_sha, migration_sha256, maintenance_window_id, approval_reference)
      VALUES ('shareholder_profit.pay_manager.v1','profit','ON','${"c".repeat(40)}','${"d".repeat(64)}','mw-ql','ref-ql')
      ON CONFLICT (feature_key) DO NOTHING;
    INSERT INTO public.profit_managers(id, organization_id, auth_user_id, name) VALUES ('${QL_CHU}','${ORG_A}','${CHU}','Quản lý là chủ');`);
  const pm = (await db.query<{ id: string }>(`INSERT INTO public.profit_monthly(organization_id, building_id, period_month, status, locked_at)
    VALUES ('${ORG_A}','${TOA_2}','2026-08-01','LOCKED', now()) RETURNING id`)).rows[0].id;
  await db.exec(`INSERT INTO public.profit_manager_allocations(profit_monthly_id, manager_id, amount, organization_id)
    VALUES ('${pm}','${QL_CHU}', ${duoc}, '${ORG_A}')`);
}
const e11 = (ql: string, tien: number, so = SO_QUY) =>
  `SELECT public.manager_salary_payout_v1('${ql}', ${tien}, '${so}', '${NGAY}', NULL, '${khoa("luong")}')::jsonb AS v`;
const soDuQuanLy = async (ql: string) =>
  Number(await mot<string>(`SELECT app_private.profit_ledger_balance_v1('${ORG_A}','MANAGER','${ql}') ->> 'balance' AS v`));

/** Thu một quyền của một người bằng ngoại lệ DENY toàn công ty (đường authorize_tenant_action_v3 / authorized_scope_v3 cùng đọc). */
async function camQuyen(user: string, key: string, n: number) {
  await db.exec(`INSERT INTO public.member_permission_overrides(id, organization_id, membership_id, permission_key, effect)
      VALUES ('${id(n)}','${ORG_A}','${mem(user)}','${key}','DENY');
    INSERT INTO public.member_override_scopes VALUES ('${ORG_A}','${id(n)}','${PHAM_VI_A}');`);
}
/** Cấp thêm quyền (toàn công ty) cho một người qua một vai riêng. */
async function capVai(user: string, keys: string[], n: number) {
  await db.exec(`INSERT INTO public.organization_roles(id, organization_id, name) VALUES ('${id(n)}','${ORG_A}','Vai thử ${n}');
    INSERT INTO public.role_permissions(organization_id, role_id, permission_key) VALUES ${keys.map((k) => `('${ORG_A}','${id(n)}','${k}')`).join(",")};
    INSERT INTO public.role_bindings(id, organization_id, membership_id, role_id) VALUES ('${id(n + 1)}','${ORG_A}','${mem(user)}','${id(n)}');
    INSERT INTO public.role_binding_scopes VALUES ('${ORG_A}','${id(n + 1)}','${PHAM_VI_A}');`);
}

describe("khung thử: nền thật, hai lượt migration", () => {
  it("RPC vòng đời V2, cầu a85 / a87, rào 'lập rồi mới duyệt' và hàm quyền nạp vào đúng thân production (md5); công tắc CANONICAL; F1 trước = production, sau = bản của file này", async () => {
    const r = (await db.query<{ ten: string; m: string }>(`
      SELECT n.nspname || '.' || p.proname AS ten, md5(replace(p.prosrc, chr(13), '')) AS m
        FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname || '.' || p.proname = ANY($1)`, [Object.keys(MD5_PROD)])).rows;
    expect(Object.fromEntries(r.map((x) => [x.ten, x.m]))).toEqual(MD5_PROD);
    expect(await mot<string>(`SELECT app_private.evaluate_feature_route('${CO}', '${ORG_A}') AS v`)).toBe("CANONICAL");
    expect(ghi.md5F1Truoc).toBe(MD5_F1_PROD);
    expect(await md5F1()).toBe(MD5_F1_MOI);
  });
  it("[ghim] migration chỉ định nghĩa lại F1 (từ thân 20261115084015 = production), không DDL nào khác; mã lỗi, ERRCODE và thứ tự báo lỗi của F1 giữ nguyên", () => {
    expect(md5(F1_CHAN.body)).toBe(MD5_F1_PROD);
    expect(md5(F1_CHU_TU.body)).toBe(MD5_F1_MOI);
    expect(dinhNghiaCuoi(F1).file).toBe(TEN_CHU_TU);
    const ten = [...new Set([...CHU_TU.matchAll(/CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+([a-z_]+\.[a-z0-9_]+)\s*\(/gi)].map((m) => m[1].toLowerCase()))];
    expect(ten).toEqual([F1]);
    expect(CHU_TU.match(/^(ALTER|DROP|GRANT|REVOKE|INSERT|UPDATE|DELETE|TRUNCATE|CREATE (?!OR REPLACE FUNCTION app_private\.guard_profit_ledger_payout_v1\(\)))[^\n]*/gim)).toBeNull();
    // Tiền kiểm nhận đúng hai bản (production, bản của file), hậu kiểm đòi bản của file.
    expect(CHU_TU.match(new RegExp(MD5_F1_PROD, "g"))).toHaveLength(1);
    expect(CHU_TU.match(new RegExp(MD5_F1_MOI, "g"))).toHaveLength(2);
    const ma = (than: string) => [...than.matchAll(/RAISE EXCEPTION '([A-Z_]+):[\s\S]*?USING ERRCODE = '([0-9A-Z]{5})'/g)].map((m) => `${m[1]}/${m[2]}`);
    expect(ma(F1_CHAN.body).length).toBeGreaterThan(15);
    expect(ma(F1_CHU_TU.body)).toEqual(ma(F1_CHAN.body));
  });
  it("chỉ F1 đổi (thân + COMMENT); ACL, chủ hàm, cấu hình, volatility, DEFINER của F1 và mọi hàm khác giữ nguyên; lượt chạy lại không đổi gì", () => {
    const truoc = ghi.hamTruoc as Record<string, AnhHam>;
    const sau = ghi.ham1 as Record<string, AnhHam>;
    expect(Object.keys(sau).sort()).toEqual(Object.keys(truoc).sort());
    expect(Object.keys(truoc).filter((k) => JSON.stringify(truoc[k]) !== JSON.stringify(sau[k]))).toEqual([F1_REGPROC]);
    expect(truoc[F1_REGPROC].md5).toBe(MD5_F1_PROD);
    expect(sau[F1_REGPROC].md5).toBe(MD5_F1_MOI);
    expect(sau[F1_REGPROC].mo_ta).not.toBe(truoc[F1_REGPROC].mo_ta);
    expect({ ...sau[F1_REGPROC], md5: "", mo_ta: "" }).toEqual({ ...truoc[F1_REGPROC], md5: "", mo_ta: "" });
    expect(ghi.ham2).toEqual(ghi.ham1);
  });
  it("chạy như lane: dán thân HAI lần trong MỘT giao dịch trên nền chưa áp rồi ROLLBACK ⇒ F1 vẫn là bản production; áp thật rồi HAI giao dịch thật: chủ lập (COMMIT) rồi tự Duyệt và Chi ở giao dịch sau ⇒ đã chi, không giả gì", async () => {
    const lan = new PGlite();
    try {
      await dungNen(lan);
      for (const f of [MIGRATION, HUY_CHE, DON_DEP]) await lan.exec(f);
      expect(await md5F1(lan)).toBe(MD5_F1_PROD);
      expect(THAN_CHU_TU).not.toMatch(/^(BEGIN|COMMIT);/m);
      await lan.exec(`BEGIN; ${THAN_CHU_TU} ${THAN_CHU_TU} ROLLBACK;`);
      expect(await md5F1(lan)).toBe(MD5_F1_PROD);
      await lan.exec(CHU_TU);
      expect(await md5F1(lan)).toBe(MD5_F1_MOI);

      await lan.exec(`UPDATE app_private.server_feature_flags SET mode = 'ON', force_freeze = false, commit_sha = '${"a".repeat(40)}',
        migration_sha256 = '${"b".repeat(64)}', maintenance_window_id = 'mw-test', approval_reference = 'ref-test' WHERE feature_key = '${CO}'`);
      const pm = (await lan.query<{ id: string }>(`INSERT INTO public.profit_monthly(organization_id, building_id, period_month, status, locked_at)
        VALUES ('${ORG_A}','${TOA_1}','2026-09-01','LOCKED', now()) RETURNING id`)).rows[0].id;
      await lan.exec(`INSERT INTO public.profit_allocations(profit_monthly_id, shareholder_id, amount, organization_id) VALUES ('${pm}','${CD_CHU}', 100, '${ORG_A}')`);
      /** Một lệnh trong MỘT giao dịch thật (COMMIT), auth.uid() = user, dưới vai `vai` (null = chủ bảng). */
      const giaoDichThat = async <T>(user: string, sql: string, vai: string | null): Promise<T> => {
        await lan.exec("BEGIN");
        try {
          await lan.query("SELECT set_config('request.jwt.claim.sub', $1, true)", [user]);
          if (vai) await lan.exec(`SET LOCAL ROLE ${vai}`);
          const v = (await lan.query<{ v: T }>(sql)).rows[0].v;
          await lan.exec("COMMIT");
          return v;
        } catch (e) {
          await lan.exec("ROLLBACK");
          throw e;
        }
      };
      const kq = await giaoDichThat<KqChot>(CHU, w2({ cd: CD_CHU, thang: "2026-09-01", tien: 100 }), "authenticated");
      const p = kq.voucher_id as string;
      // Giao dịch sau: chính nick chủ (người lập, người nhận, đang giữ sổ) Duyệt và Chi có chứng từ.
      const bienNhan = await giaoDichThat<Record<string, unknown>>(CHU, sqlDuyetChi(p, SO_QUY), null);
      expect(bienNhan).toMatchObject({ voucherId: p, approvalStatus: "APPROVED", postingStatus: "POSTED" });
      const ie = (await lan.query<{ a: string; s: string; b: string | null }>(`SELECT approval_status AS a, posting_status AS s,
        birth_txid::text AS b FROM public.income_expenses WHERE id = '${p}'`)).rows[0];
      expect(ie).toMatchObject({ a: "APPROVED", s: "POSTED" });
      expect(ie.b).not.toBe("1");
      expect((await lan.query(`SELECT 1 FROM public.income_expense_postings
        WHERE voucher_id = '${p}' AND event_kind = 'POSTING' AND account_id = '${SO_QUY}' AND net_cash_effect = -100`)).rows).toHaveLength(1);
      expect((await lan.query<{ v: unknown }>(`SELECT jsonb_object_agg(event_kind, payload -> 'owner_self') AS v
        FROM app_private.profit_ledger_events WHERE voucher_id = '${p}'`)).rows[0].v)
        .toEqual({ PAYOUT_CREATED: null, PAYOUT_APPROVED: { maker: true, payee: true }, PAYOUT_POSTED: { payee: true } });
    } finally {
      await lan.close();
    }
  }, 300000);
  it("tiền kiểm: thân F1 khác bản đã rà ⇒ 55000, không ghi gì; trigger a06 không gắn F1 ⇒ 55000; thiếu authorized_scope_v3 ⇒ 55000; bản production ⇒ chạy được", async () => {
    await giaoDich(async () => {
      await db.exec(F1_CHAN.stmt.replace("-- Bước DUYỆT.", "-- Bước DUYỆT (bản lạ)."));
      const la = await md5F1();
      expect([MD5_F1_PROD, MD5_F1_MOI]).not.toContain(la);
      expect(await loi(THAN_CHU_TU)).toMatchObject({ code: "55000", message: expect.stringContaining("KHÁC thân đã rà") });
      expect(await md5F1()).toBe(la);
    });
    await giaoDich(async () => {
      await db.exec("DROP TRIGGER a06_profit_ledger_payout_guard ON public.income_expenses");
      expect(await loi(THAN_CHU_TU)).toMatchObject({ code: "55000", message: expect.stringContaining("a06_profit_ledger_payout_guard") });
    });
    await giaoDich(async () => {
      await db.exec("DROP FUNCTION app_private.authorized_scope_v3(text, uuid)");
      expect(await loi(THAN_CHU_TU)).toMatchObject({ code: "55000", message: expect.stringContaining("authorized_scope_v3") });
    });
    await giaoDich(async () => {
      await db.exec(F1_CHAN.stmt);
      expect(await md5F1()).toBe(MD5_F1_PROD);
      expect(await loi(THAN_CHU_TU)).toBeNull();
      expect(await md5F1()).toBe(MD5_F1_MOI);
    });
  });
});

describe("chi lợi nhuận cổ đông (phiếu tiền của lần chốt W2): nick chủ tự Duyệt và Chi ở lời gọi sau", () => {
  it("nick chủ giữ sổ: lập rồi tự Duyệt và Chi có chứng từ ⇒ đã chi; bút toán, dòng sổ quỹ, yêu cầu duyệt y như chủ khác bấm Duyệt và Chi; hai con số đúng", async () => {
    await giaoDich(async () => {
      await chotThang("2026-09-01", TOA_1, { [CD1]: 100, [CD2]: 100 });
      const tu = await chotChi(CHU, CD1, 100);
      const doiChung = await chotChi(CHU, CD2, 100);
      expect(await ab(CD1)).toEqual([0, 0, 0, 100, 0]);
      expect(await duyetChi(tu, CHU, SO_QUY)).toBeNull();
      expect(await duyetChi(doiChung, CHU2, SO_QUY)).toBeNull();
      for (const p of [tu, doiChung]) {
        expect(await trangThai(p)).toEqual({ approval_status: "APPROVED", posting_status: "POSTED" });
        expect(await yeuCau(p)).toEqual(["APPROVED"]);
      }
      const bt = await butToan(tu);
      expect(bt).toEqual([{ event_kind: "POSTING", account_id: SO_QUY, net: "-100.00", source_kind: "MANUAL", amount_basis: "VOUCHER_TOTAL",
        posted_by_user_id: CHU, dong: [[SO_QUY, "MAIN", "-100.00"]] }]);
      expect(await butToan(doiChung)).toEqual([{ ...bt[0], posted_by_user_id: CHU2 }]);
      expect(await ab(CD1)).toEqual([0, 0, 0, 0, 0]);
      expect(await ab(CD2)).toEqual([0, 0, 0, 0, 0]);
      expect(await dauChuTu(tu)).toEqual({ PAYOUT_APPROVED: { maker: true, payee: false }, PAYOUT_CREATED: null, PAYOUT_POSTED: null });
      expect(await dauChuTu(doiChung)).toEqual({ PAYOUT_APPROVED: null, PAYOUT_CREATED: null, PAYOUT_POSTED: null });
      expect(await dem("app_private.canonical_write_operations",
        `operation = 'income_expense.approve_and_post.v2' AND completed_at IS NOT NULL AND subject_id IN ('${tu}','${doiChung}')`)).toBe(2);
    });
  });
  it("CÙNG giao dịch với lệnh lập: Duyệt hay Duyệt và Chi vẫn bị rào 'lập rồi mới duyệt' chặn (55000), kể cả chủ khác; không ghi gì", async () => {
    await giaoDich(async () => {
      await chotThang("2026-09-01", TOA_1, { [CD1]: 100 });
      const p = await chotChi(CHU, CD1, 100);
      for (const [user, so] of [[CHU, SO_QUY], [CHU, null], [CHU2, SO_QUY], [CHU2, null]] as const) {
        expect(await duyetCungGiaoDich(p, user, so), `${user} ${so ?? "chỉ duyệt"}`)
          .toMatchObject({ code: "55000", message: expect.stringContaining("create and transition in same transaction") });
      }
      expect(await trangThai(p)).toEqual({ approval_status: "UNAPPROVED", posting_status: "UNPOSTED" });
      expect(await yeuCau(p)).toEqual(["PENDING_APPROVAL"]);
      expect((await nhatKy(p)).map((e) => e.event_kind)).toEqual(["PAYOUT_CREATED"]);
    });
  });
  it("thiếu chứng từ ⇒ Chi bị chặn như cũ (55000), cả lệnh Duyệt và Chi không ghi gì; chỉ Duyệt được, Chi sau vẫn phải có chứng từ", async () => {
    await giaoDich(async () => {
      await chotThang("2026-09-01", TOA_1, { [CD1]: 100 });
      const p = await chotChi(CHU, CD1, 100);
      expect(await duyetChi(p, CHU, SO_QUY, false))
        .toMatchObject({ code: "55000", message: expect.stringContaining("at least one FINALIZED evidence is required") });
      expect(await trangThai(p)).toEqual({ approval_status: "UNAPPROVED", posting_status: "UNPOSTED" });
      expect((await nhatKy(p)).map((e) => e.event_kind)).toEqual(["PAYOUT_CREATED"]);
      expect(await duyet(p, CHU)).toBeNull();
      expect(await trangThai(p)).toEqual({ approval_status: "APPROVED", posting_status: "UNPOSTED" });
      await dangNhap(CHU);
      expect(await loi(sqlGhiSoKhongAnh(p, SO_QUY)))
        .toMatchObject({ code: "55000", message: expect.stringContaining("at least one FINALIZED evidence is required") });
      expect(await ghiSo(p, CHU, SO_QUY)).toBeNull();
      expect(await trangThai(p)).toEqual({ approval_status: "APPROVED", posting_status: "POSTED" });
    });
  });
  it("nick chủ KHÔNG giữ sổ của phiếu: Duyệt và Chi bị chặn (42501, không ghi gì); chỉ Duyệt được; người giữ sổ (không phải người nhận) bấm Chi sau", async () => {
    await giaoDich(async () => {
      await chotThang("2026-09-01", TOA_1, { [CD1]: 100 });
      const p = await chotChi(CHU3, CD1, 100);
      expect((await duyetChi(p, CHU3, SO_QUY))?.code).toBe("42501");
      expect(await trangThai(p)).toEqual({ approval_status: "UNAPPROVED", posting_status: "UNPOSTED" });
      expect(await duyet(p, CHU3)).toBeNull();
      expect(await trangThai(p)).toEqual({ approval_status: "APPROVED", posting_status: "UNPOSTED" });
      expect((await ghiSo(p, CHU3, SO_QUY))?.code).toBe("42501");
      expect(await ghiSo(p, CHU2, SO_QUY)).toBeNull();
      expect(await trangThai(p)).toEqual({ approval_status: "APPROVED", posting_status: "POSTED" });
      expect(await dauChuTu(p)).toEqual({ PAYOUT_APPROVED: { maker: true, payee: false }, PAYOUT_CREATED: null, PAYOUT_POSTED: null });
    });
  });
  it("người nhận là chính nick chủ (cổ đông là chủ): chủ lập cho mình, tự Duyệt và Chi ⇒ đã chi; nhật ký tự duyệt + tự chi; vẫn KHÔNG tự huỷ phiếu đã chi cho mình (E6 không đổi)", async () => {
    await giaoDich(async () => {
      await chotThang("2026-09-01", TOA_1, { [CD_CHU]: 100 });
      const p = await chotChi(CHU, CD_CHU, 100);
      expect(await duyetChi(p, CHU, SO_QUY)).toBeNull();
      expect(await trangThai(p)).toEqual({ approval_status: "APPROVED", posting_status: "POSTED" });
      expect(await dauChuTu(p)).toEqual({ PAYOUT_APPROVED: { maker: true, payee: true }, PAYOUT_CREATED: null, PAYOUT_POSTED: { payee: true } });
      expect(await ab(CD_CHU)).toEqual([0, 0, 0, 0, 0]);
      laLoi(await huyPhieu(p, CHU, "POSTED"), "42501", "PROFIT_LEDGER_CANCEL_PAYEE");
      expect(await huyPhieu(p, CHU2, "POSTED")).toBeNull();
      expect(await trangThai(p)).toEqual({ approval_status: "CANCELLED", posting_status: "REVERSED" });
    });
  });
  it("nick chủ không giữ sổ lập cho nick chủ giữ sổ (người nhận): người lập tự duyệt rồi người nhận tự Chi; hoặc người nhận tự Duyệt và Chi", async () => {
    await giaoDich(async () => {
      await chotThang("2026-09-01", TOA_1, { [CD_CHU]: 100 });
      await chotThang("2026-10-01", TOA_1, { [CD_CHU]: 50 });
      const p1 = await chotChi(CHU3, CD_CHU, 100);
      expect(await duyet(p1, CHU3)).toBeNull();
      expect(await ghiSo(p1, CHU, SO_QUY)).toBeNull();
      expect(await trangThai(p1)).toEqual({ approval_status: "APPROVED", posting_status: "POSTED" });
      expect(await dauChuTu(p1)).toEqual({ PAYOUT_APPROVED: { maker: true, payee: false }, PAYOUT_CREATED: null, PAYOUT_POSTED: { payee: true } });
      const p2 = await chotChi(CHU3, CD_CHU, 50, { thang: "2026-10-01" });
      expect(await duyetChi(p2, CHU, SO_QUY)).toBeNull();
      expect(await trangThai(p2)).toEqual({ approval_status: "APPROVED", posting_status: "POSTED" });
      expect(await dauChuTu(p2)).toEqual({ PAYOUT_APPROVED: { maker: false, payee: true }, PAYOUT_CREATED: null, PAYOUT_POSTED: { payee: true } });
    });
  });
  it("người nhận theo đăng nhập HIỆN TẠI là nick chủ (đăng nhập của cổ đông đổi sau khi lập): tự Duyệt và Chi được phiếu chủ lập, nhật ký ghi người nhận", async () => {
    await giaoDich(async () => {
      await chotThang("2026-09-01", TOA_1, { [CD1]: 100 });
      const p = await chotChi(CHU3, CD1, 100);
      await db.exec(`UPDATE public.shareholders SET auth_user_id = '${CHU2}' WHERE id = '${CD1}'`);
      expect(await dongSo(p)).toMatchObject({ maker_kind: "OWNER", payee_user_id: U_CD1 });
      expect(await duyetChi(p, CHU2, SO_QUY)).toBeNull();
      expect(await dauChuTu(p)).toEqual({ PAYOUT_APPROVED: { maker: false, payee: true }, PAYOUT_CREATED: null, PAYOUT_POSTED: { payee: true } });
    });
  });
  it("phát lại theo khoá chống gửi trùng: Duyệt và Chi gửi lại đúng lệnh ⇒ biên nhận cũ, không bút toán thứ hai; lệnh chốt gửi lại cùng khoá ⇒ biên nhận cũ, không phiếu thứ hai", async () => {
    await giaoDich(async () => {
      await chotThang("2026-09-01", TOA_1, { [CD1]: 100 });
      const kChot = khoa("chot");
      const kq = await goi<KqChot>(CHU, w2({ cd: CD1, thang: "2026-09-01", tien: 100, khoa: kChot }));
      const p = kq.voucher_id as string;
      await giaSinhTruoc(p);
      const v = await phieu(p);
      const chungTu = await mot<string>(`SELECT public.test_chung_tu('${ORG_A}') AS v`);
      const lenh = sqlDuyetChi(p, SO_QUY, { anh: chungTu, k: khoa("duyetchi"), ver: [Number(v.approval_version), Number(v.posting_version)] });
      await dangNhap(CHU);
      const lan1 = await mot<Record<string, unknown>>(lenh);
      const lan2 = await mot<Record<string, unknown>>(lenh);
      expect(lan1).toMatchObject({ voucherId: p, approvalStatus: "APPROVED", postingStatus: "POSTED" });
      expect(lan2).toEqual(lan1);
      expect(await butToan(p)).toHaveLength(1);
      expect((await nhatKy(p)).map((e) => e.event_kind)).toEqual(["PAYOUT_APPROVED", "PAYOUT_CREATED", "PAYOUT_POSTED"]);
      expect(await goi<KqChot>(CHU, w2({ cd: CD1, thang: "2026-09-01", tien: 100, khoa: kChot }))).toEqual(kq);
      expect(await dem("public.income_expenses", `shareholder_id = '${CD1}'`)).toBe(1);
    });
  });
  it("phiếu E5 cũ (chủ lập, OWNER) cũng theo luật mới: chủ vừa lập vừa nhận tự duyệt rồi tự Chi", async () => {
    await giaoDich(async () => {
      await chotThang("2026-09-01", TOA_1, { [CD_CHU]: 100 });
      const cu = await e5Cu(CHU, e5(CD_CHU, 10, true));
      expect(cu.maker_kind).toBe("OWNER");
      expect(await duyet(cu.voucher_id, CHU)).toBeNull();
      expect(await ghiSo(cu.voucher_id, CHU, SO_QUY)).toBeNull();
      expect(await trangThai(cu.voucher_id)).toEqual({ approval_status: "APPROVED", posting_status: "POSTED" });
      expect(await dauChuTu(cu.voucher_id)).toMatchObject({ PAYOUT_APPROVED: { maker: true, payee: true }, PAYOUT_POSTED: { payee: true } });
    });
  });
});

describe("lương điều hành: nick chủ tự Duyệt và Chi", () => {
  it("lương điều hành của CHÍNH nick chủ giữ sổ: lập rồi tự Duyệt và Chi ⇒ đã chi; nhật ký tự duyệt + tự chi; số còn lại giảm đúng", async () => {
    await giaoDich(async () => {
      await nenLuongDieuHanh(50);
      const kq = await goi<KqLuong>(CHU, e11(QL_CHU, 20));
      expect(kq).toMatchObject({ state: "PENDING_APPROVAL", balance_before: 50 });
      expect(await duyetChi(kq.voucher_id, CHU, SO_QUY)).toBeNull();
      expect(await trangThai(kq.voucher_id)).toEqual({ approval_status: "APPROVED", posting_status: "POSTED" });
      expect(await dauChuTu(kq.voucher_id)).toEqual({ PAYOUT_APPROVED: { maker: true, payee: true }, PAYOUT_CREATED: null, PAYOUT_POSTED: { payee: true } });
      expect(await soDuQuanLy(QL_CHU)).toBe(30);
    });
  });
  it("nick chủ không giữ sổ lập lương điều hành cho nick chủ giữ sổ: người lập tự duyệt, người nhận tự Chi", async () => {
    await giaoDich(async () => {
      await nenLuongDieuHanh(50);
      const kq = await goi<KqLuong>(CHU3, e11(QL_CHU, 20));
      expect(await duyet(kq.voucher_id, CHU3)).toBeNull();
      expect(await ghiSo(kq.voucher_id, CHU, SO_QUY)).toBeNull();
      expect(await trangThai(kq.voucher_id)).toEqual({ approval_status: "APPROVED", posting_status: "POSTED" });
      expect(await dauChuTu(kq.voucher_id)).toEqual({ PAYOUT_APPROVED: { maker: true, payee: false }, PAYOUT_CREATED: null, PAYOUT_POSTED: { payee: true } });
    });
  });
  it("vượt số còn lại lúc duyệt ⇒ 22023 như cũ, kể cả người lập tự duyệt; không ghi gì", async () => {
    await giaoDich(async () => {
      await nenLuongDieuHanh(50);
      const kq = await goi<KqLuong>(CHU, e11(QL_CHU, 40));
      await db.exec(`UPDATE public.profit_manager_allocations SET amount = 30 WHERE manager_id = '${QL_CHU}'`);
      laLoi(await duyet(kq.voucher_id, CHU), "22023", "PROFIT_MANAGER_LEDGER_OVERDRAW");
      laLoi(await duyetChi(kq.voucher_id, CHU, SO_QUY), "22023", "PROFIT_MANAGER_LEDGER_OVERDRAW");
      expect(await trangThai(kq.voucher_id)).toEqual({ approval_status: "UNAPPROVED", posting_status: "UNPOSTED" });
      expect((await nhatKy(kq.voucher_id)).map((e) => e.event_kind)).toEqual(["PAYOUT_CREATED"]);
    });
  });
  it("cùng giao dịch với lệnh lập ⇒ 55000 rào 'lập rồi mới duyệt'; không ghi gì", async () => {
    await giaoDich(async () => {
      await nenLuongDieuHanh(50);
      const kq = await goi<KqLuong>(CHU, e11(QL_CHU, 20));
      expect(await duyetCungGiaoDich(kq.voucher_id, CHU, SO_QUY))
        .toMatchObject({ code: "55000", message: expect.stringContaining("create and transition in same transaction") });
      expect(await trangThai(kq.voucher_id)).toEqual({ approval_status: "UNAPPROVED", posting_status: "UNPOSTED" });
    });
  });
});

describe("phiếu tạm ứng (người giữ sổ lập) giữ luật cũ", () => {
  it("chủ lập hộ phiếu tạm ứng (CUSTODIAN_FOR_PAYEE) dù có quyền chi: không tự duyệt (MAKER_SELF_APPROVE); chủ khác duyệt được", async () => {
    await giaoDich(async () => {
      const kq = await goi<KqUng>(CHU, w1({ cd: CD1, tien: 10, so: SO_QUY }));
      expect(kq.maker_kind).toBe("CUSTODIAN_FOR_PAYEE");
      laLoi(await duyet(kq.voucher_id, CHU), "42501", "PROFIT_LEDGER_MAKER_SELF_APPROVE");
      expect(await trangThai(kq.voucher_id)).toEqual({ approval_status: "UNAPPROVED", posting_status: "UNPOSTED" });
      expect(await duyet(kq.voucher_id, CHU2)).toBeNull();
    });
  });
  it("tạm ứng cho cổ đông là nick chủ: người nhận không tự duyệt, không tự Chi dù có quyền chi; chủ khác duyệt, người giữ sổ khác Chi", async () => {
    await giaoDich(async () => {
      const kq = await goi<KqUng>(CHU2, w1({ cd: CD_CHU, tien: 10, so: SO_QUY }));
      expect(kq.maker_kind).toBe("CUSTODIAN_FOR_PAYEE");
      laLoi(await duyet(kq.voucher_id, CHU), "42501", "PROFIT_LEDGER_PAYEE_SELF_APPROVE");
      expect(await duyet(kq.voucher_id, CHU3)).toBeNull();
      laLoi(await ghiSo(kq.voucher_id, CHU, SO_QUY), "42501", "PROFIT_LEDGER_PAYEE_SELF_POST");
      expect(await ghiSo(kq.voucher_id, CHU2, SO_QUY)).toBeNull();
      expect(await dauChuTu(kq.voucher_id)).toEqual({ PAYOUT_APPROVED: null, PAYOUT_CREATED: null, PAYOUT_POSTED: null });
    });
  });
  it("chủ tự tạm ứng (CUSTODIAN_ADVANCE): không tự duyệt; chủ khác duyệt xong thì chính người đó Chi được (luật cũ, không phải dấu tự chi mới)", async () => {
    await giaoDich(async () => {
      const kq = await goi<KqUng>(CHU, w1({ cd: CD_CHU, tien: 10, so: SO_QUY }));
      expect(kq.maker_kind).toBe("CUSTODIAN_ADVANCE");
      laLoi(await duyet(kq.voucher_id, CHU), "42501", "PROFIT_LEDGER_MAKER_SELF_APPROVE");
      expect(await duyet(kq.voucher_id, CHU2)).toBeNull();
      expect(await ghiSo(kq.voucher_id, CHU, SO_QUY)).toBeNull();
      expect(await dauChuTu(kq.voucher_id)).toEqual({ PAYOUT_APPROVED: null, PAYOUT_CREATED: null, PAYOUT_POSTED: null });
    });
  });
  it("người nhận theo đăng nhập HIỆN TẠI (đăng nhập của cổ đông đổi sau khi lập) vẫn không tự duyệt phiếu tạm ứng dù là nick chủ", async () => {
    await giaoDich(async () => {
      const kq = await goi<KqUng>(GIU_SO, w1({ cd: CD1, tien: 10 }));
      await db.exec(`UPDATE public.shareholders SET auth_user_id = '${CHU2}' WHERE id = '${CD1}'`);
      expect(await dongSo(kq.voucher_id)).toMatchObject({ maker_kind: "CUSTODIAN_FOR_PAYEE", payee_user_id: U_CD1 });
      laLoi(await duyet(kq.voucher_id, CHU2), "42501", "PROFIT_LEDGER_PAYEE_SELF_APPROVE");
      expect(await duyet(kq.voucher_id, CHU3)).toBeNull();
    });
  });
  it("thứ tự báo lỗi không đổi: người giữ sổ lập hộ (có quyền duyệt thu chi, không có quyền chi lợi nhuận) tự duyệt ⇒ MAKER_SELF_APPROVE, không phải APPROVE_FORBIDDEN", async () => {
    await giaoDich(async () => {
      await capVai(GIU_SO, ["income_expenses.approve"], 301);
      const kq = await goi<KqUng>(GIU_SO, w1({ cd: CD1, tien: 10 }));
      expect(kq.maker_kind).toBe("CUSTODIAN_FOR_PAYEE");
      laLoi(await duyet(kq.voucher_id, GIU_SO), "42501", "PROFIT_LEDGER_MAKER_SELF_APPROVE");
    });
  });
});

describe("người không có quyền chi vẫn bị chặn", () => {
  it("có quyền duyệt thu chi nhưng không có quyền chi lợi nhuận, duyệt phiếu chủ lập ⇒ APPROVE_FORBIDDEN (42501) như cũ", async () => {
    await giaoDich(async () => {
      await chotThang("2026-09-01", TOA_1, { [CD1]: 100 });
      await capVai(QUAN_LY, ["income_expenses.approve"], 311);
      const p = await chotChi(CHU, CD1, 100);
      laLoi(await duyet(p, QUAN_LY), "42501", "PROFIT_LEDGER_APPROVE_FORBIDDEN");
      expect(await trangThai(p)).toEqual({ approval_status: "UNAPPROVED", posting_status: "UNPOSTED" });
    });
  });
  it("nick chủ bị thu quyền chi (ngoại lệ DENY): người lập không tự duyệt được nữa (MAKER_SELF_APPROVE); người nhận không tự Chi được nữa (PAYEE_SELF_POST); chủ khác vẫn làm được", async () => {
    await giaoDich(async () => {
      await chotThang("2026-09-01", TOA_1, { [CD1]: 100, [CD_CHU]: 100 });
      const p1 = await chotChi(CHU, CD1, 100);
      const p2 = await chotChi(CHU, CD_CHU, 100);
      await camQuyen(CHU, "shareholder_profit.distribute", 321);
      laLoi(await duyet(p1, CHU), "42501", "PROFIT_LEDGER_MAKER_SELF_APPROVE");
      laLoi(await duyet(p2, CHU), "42501", "PROFIT_LEDGER_MAKER_SELF_APPROVE");
      expect(await duyet(p2, CHU2)).toBeNull();
      laLoi(await ghiSo(p2, CHU, SO_QUY), "42501", "PROFIT_LEDGER_PAYEE_SELF_POST");
      expect(await ghiSo(p2, CHU2, SO_QUY)).toBeNull();
      expect(await trangThai(p2)).toEqual({ approval_status: "APPROVED", posting_status: "POSTED" });
    });
  });
  it("quyền xét theo ĐÚNG loại chủ thể: nick chủ bị thu RIÊNG quyền chi lương điều hành (DENY pay_manager, vẫn còn distribute) ⇒ không tự duyệt phiếu lương điều hành mình lập (MAKER_SELF_APPROVE), người nhận không tự Chi phiếu lương điều hành (PAYEE_SELF_POST); chủ khác vẫn làm được", async () => {
    await giaoDich(async () => {
      await nenLuongDieuHanh(50);
      const tuLap = await goi<KqLuong>(CHU, e11(QL_CHU, 10));     // CHU lập lương điều hành cho chính mình
      const choChu = await goi<KqLuong>(CHU3, e11(QL_CHU, 20));   // nick không giữ sổ lập cho CHU (người nhận)
      expect(await duyet(choChu.voucher_id, CHU3)).toBeNull();   // CHU3 còn pay_manager ⇒ người lập tự duyệt được
      await camQuyen(CHU, "shareholder_profit.pay_manager", 331);
      // Tiền đề của ca: CHU vẫn có quyền chi lợi nhuận cổ đông theo cả công ty, chỉ mất quyền chi lương điều hành — phép
      // kiểm dùng nhầm khoá distribute cho phiếu lương điều hành sẽ cho qua.
      await dangNhap(CHU);
      const quyen = (k: string) => mot<boolean>(`SELECT COALESCE(bool_or(s.org_wide), false) AS v
        FROM app_private.authorized_scope_v3('${k}', '${ORG_A}') s`);
      expect(await quyen("shareholder_profit.distribute")).toBe(true);
      expect(await quyen("shareholder_profit.pay_manager")).toBe(false);
      laLoi(await duyet(tuLap.voucher_id, CHU), "42501", "PROFIT_LEDGER_MAKER_SELF_APPROVE");
      laLoi(await duyetChi(tuLap.voucher_id, CHU, SO_QUY), "42501", "PROFIT_LEDGER_MAKER_SELF_APPROVE");
      expect(await trangThai(tuLap.voucher_id)).toEqual({ approval_status: "UNAPPROVED", posting_status: "UNPOSTED" });
      laLoi(await ghiSo(choChu.voucher_id, CHU, SO_QUY), "42501", "PROFIT_LEDGER_PAYEE_SELF_POST");
      expect(await trangThai(choChu.voucher_id)).toEqual({ approval_status: "APPROVED", posting_status: "UNPOSTED" });
      expect(await duyet(tuLap.voucher_id, CHU2)).toBeNull();
      expect(await ghiSo(choChu.voucher_id, CHU2, SO_QUY)).toBeNull();
      expect(await trangThai(choChu.voucher_id)).toEqual({ approval_status: "APPROVED", posting_status: "POSTED" });
      expect(await dauChuTu(choChu.voucher_id)).toEqual({ PAYOUT_APPROVED: { maker: true, payee: false }, PAYOUT_CREATED: null, PAYOUT_POSTED: null });
    });
  });
  it("người nhận là cổ đông giữ sổ nhưng không có quyền chi lợi nhuận: chủ lập tự duyệt được, người nhận KHÔNG tự Chi (PAYEE_SELF_POST)", async () => {
    await giaoDich(async () => {
      await chotThang("2026-09-01", TOA_1, { [CD_TU]: 100 });
      const p = await chotChi(CHU, CD_TU, 100, { so: SO_TU });
      expect(await duyet(p, CHU)).toBeNull();
      laLoi(await ghiSo(p, TU_UNG, SO_TU), "42501", "PROFIT_LEDGER_PAYEE_SELF_POST");
      expect(await trangThai(p)).toEqual({ approval_status: "APPROVED", posting_status: "UNPOSTED" });
    });
  });
});

describe("mã lỗi và thứ tự khoá", () => {
  it("F1 không tự ném mã lớp 40; bước ghi sổ không khoá dòng (không gọi authorize_tenant_action_v3 / khoá công ty / khoá sổ, chỉ authorized_scope_v3); authorized_scope_v3 STABLE, không khoá dòng", async () => {
    const than = (await mot<string>(`SELECT p.prosrc AS v FROM pg_proc p WHERE p.oid = '${F1_REGPROC}'::regprocedure`)).replace(/--[^\n]*/g, " ");
    expect(than).not.toMatch(/'40001'|'40P01'|'40\d{3}'|\bserialization_failure\b|\bdeadlock_detected\b/i);
    expect(CHU_TU).not.toMatch(/40001|40P01/);
    const dau = than.indexOf("IF v_buoc = 'GHI_SO' THEN");
    const ghiSoKhoi = than.slice(dau, than.indexOf("RETURN NEW;\n  END IF;", dau));
    expect(dau).toBeGreaterThan(0);
    expect(ghiSoKhoi).toContain("app_private.authorized_scope_v3(v_key, OLD.organization_id)");
    expect(ghiSoKhoi).not.toMatch(/authorize_tenant_action_v3|lock_org_for_decision_v1|profit_ledger_lock_v1|\bFOR\s+(SHARE|UPDATE|NO KEY UPDATE|KEY SHARE)\b/i);
    const scope = await mot<{ vol: string; src: string }>(`SELECT jsonb_build_object('vol', p.provolatile, 'src', p.prosrc) AS v
      FROM pg_proc p WHERE p.oid = 'app_private.authorized_scope_v3(text,uuid)'::regprocedure`);
    expect(scope.vol).toBe("s");
    expect(scope.src).not.toMatch(/\bFOR\s+(SHARE|UPDATE|NO KEY UPDATE|KEY SHARE)\b/i);
  });
});

describe("Phân phối quỹ chung trên sổ cổ đông", () => {
  const source = (kind: string, amount: number, available: number, ref: string, date = "2026-11-03") =>
    `SELECT public.shared_fund_record_source_v1('${ORG_A}','${kind}','${date}',${amount},'${ref}','Biên bản đối chiếu quỹ',${available},'${khoa("source")}') AS v`;
  const distribute = (lines: { shareholder_id: string; amount: number; advance_offset_amount: number }[],
    available = 900, reference = "QC-01", date = "2026-11-04") =>
    `SELECT public.shared_fund_distribute_v1('${ORG_A}','${date}','${reference}','Biên bản hai cổ đông','${JSON.stringify(lines)}'::jsonb,${available},'${khoa("distribution")}') AS v`;
  const openAdvance = (amount: number, expectedUnpaid = 0, month = "2026-10-01", asOf = "2026-10-31") =>
    `SELECT public.shareholder_profit_opening_advance_v1('${ORG_A}','${CD1}','${month}','${asOf}',${amount},${expectedUnpaid},'Đối chiếu số dư đến cuối tháng','${khoa("opening")}') AS v`;
  const hand = { shareholder_id: CD1, amount: 400, advance_offset_amount: 400 };
  const payable = { shareholder_id: CD2, amount: 400, advance_offset_amount: 0 };
  const state = `SELECT public.shared_fund_state_v1('${ORG_A}') AS v`;

  beforeAll(async () => {
    // Cùng schema/role/các RPC thật của luồng duyệt và chi ở trên.
    await db.exec("ALTER TABLE public.organization_memberships ADD COLUMN member_type text NOT NULL DEFAULT 'STAFF'");
    await db.query("UPDATE public.organization_memberships SET member_type='OWNER' WHERE user_id IN ($1,$2,$3)", [CHU, CHU2, NGOAI]);
    const migrations = readdirSync(DIR).filter(file =>
      file.endsWith("_phan_phoi_quy_chung.sql") || file.endsWith("_so_du_dau_ky_va_phan_phoi_quy_co_dong.sql") ||
      file.endsWith("_phieu_tam_ung_lich_su_theo_ky.sql")).sort();
    expect(migrations).toHaveLength(3);
    for (let pass = 0; pass < 2; pass++) {
      for (const file of migrations) await db.exec(readFileSync(`${DIR}/${file}`, "utf8"));
    }
  }, 180000);

  it("hoàn đồng thời mọi người góp bằng một phiếu qua hai giao dịch đã commit", async () => {
    const local = await PGlite.create({ loadDataDir: await db.dumpDataDir() });
    try {
      // Nền này chuyên kiểm đường tiền. Phép xem trước/chốt nhà được kiểm riêng bằng RPC trên project TEST.
      await local.exec(`
        CREATE TABLE public.profit_close_revisions(id uuid PRIMARY KEY, organization_id uuid, building_id uuid,
          profit_monthly_id uuid, period_month date, revision_number integer, operation text, created_at timestamptz DEFAULT now());
        ALTER TABLE public.profit_monthly ADD COLUMN management_salary numeric DEFAULT 0, ADD COLUMN revision_number integer DEFAULT 1,
          ADD COLUMN IF NOT EXISTS shareholder_percent_total numeric, ADD COLUMN IF NOT EXISTS shareholder_allocated_amount numeric,
          ADD COLUMN IF NOT EXISTS unallocated_profit numeric, ADD COLUMN IF NOT EXISTS unallocated_disposition text,
          ADD COLUMN IF NOT EXISTS unallocated_disposition_reason text;
        CREATE OR REPLACE FUNCTION app_private.org_timezone_v1(uuid) RETURNS text LANGUAGE sql AS $$ SELECT 'Asia/Ho_Chi_Minh'::text $$;
        CREATE FUNCTION public._profit_close_preview_core_v2(uuid,date,uuid[],jsonb,text,boolean DEFAULT false)
          RETURNS jsonb LANGUAGE sql AS $$ SELECT '{}'::jsonb $$;
      `);
      const migration = readFileSync(`${DIR}/20261126015743_gom_loi_nhuan_va_hoan_quy_dong_loat.sql`, 'utf8');
      for (const name of ['recompute_ie_business_result','trg_ie_items_recompute_business_result','trg_ie_recompute_business_result']) {
        await local.exec(dinhNghiaTruocM1('public.'+name));
      }
      await local.exec(`CREATE TRIGGER ie_business_result AFTER INSERT OR UPDATE OF business_result_accounting,total_amount
        ON public.income_expenses FOR EACH ROW EXECUTE FUNCTION public.trg_ie_recompute_business_result();
        CREATE TRIGGER ie_items_business_result AFTER INSERT OR UPDATE OR DELETE ON public.income_expense_items
        FOR EACH ROW EXECUTE FUNCTION public.trg_ie_items_recompute_business_result();`);
      await local.exec(dinhNghiaTrong("public._profit_write_close_v2","20260721110000_profit_unallocated_integrity_v3.sql").stmt);
      await local.exec(migration);
      await local.exec(migration);
      const overview = readFileSync(`${DIR}/20261126041014_lich_chi_quy_cua_co_dong.sql`, 'utf8');
      await local.exec(overview);
      await local.exec(overview);
      const periodId = id(8001);
      await local.exec(`INSERT INTO app_private.house_pool_rules(organization_id,building_id,first_shareholder,second_shareholder,
        share_percent,retained_percent,from_month,automatic_from,activated_by) VALUES ('${ORG_A}','${TOA_1}','${CD_CHU}','${CD1}',44,1,'2026-06-01','2026-11-01','${CHU}');
        INSERT INTO public.profit_monthly(id,organization_id,building_id,period_month,status,adjusted_profit)
        VALUES ('${periodId}','${ORG_A}','${TOA_1}','2026-11-01','LOCKED',1000);
        INSERT INTO public.profit_close_revisions(id,organization_id,building_id,profit_monthly_id,period_month,revision_number,operation,created_at)
        VALUES (gen_random_uuid(),'${ORG_A}','${TOA_1}','${periodId}','2026-11-01',1,'CLOSE','2026-11-10T00:00:00Z');`);
      await local.query("SELECT set_config('request.jwt.claim.sub',$1,false)", [CHU]);
      const quote = async () => (await local.query<{q:{hash:string;lines:{available:number;paid:number;reserved:number;amount:number}[]}}>(
        "SELECT public.house_pool_state_v1($1,2500)->'quote' q",[ORG_A])).rows[0].q;
      const first = await quote();
      expect(first.lines.map(l => l.amount)).toEqual([110,110]);
      await local.exec('SET ROLE authenticated');
      const args=[ORG_A,SO_QUY,NGAY,first.hash,randomUUID()];
      const create="SELECT public.house_pool_return_v1($1,2500,$2,$3,$4,$5) AS v";
      await expect(local.query(create,[ORG_A,SO_QUY,"2026-11-09",first.hash,randomUUID()])).rejects.toMatchObject({code:"22023"});
      const {voucher_id,total}=(await local.query<{v:{voucher_id:string;total:number}}>(create,args)).rows[0].v;
      expect(total).toBe(220);
      expect((await local.query("SELECT public.house_pool_receipt_v1($1,$2,'return') AS receipt",[ORG_A,args[4]])).rows)
        .toEqual([{receipt:{voucher:voucher_id,imported:null}}]);
      expect((await local.query<{v:{voucher_id:string}}>(create,args)).rows[0].v).toMatchObject({voucher_id});
      expect((await quote()).lines.map(l=>l.reserved)).toEqual([110,110]);
      await local.exec(`RESET ROLE;
        CREATE VIEW app_private.house_pool_expense_status AS
        SELECT '${id(8321)}'::uuid voucher_id,'PC-TEST'::text code,'2026-11-05'::date voucher_date,
          '${ORG_A}'::uuid organization_id,'${CD_CHU}'::uuid first_holder,'${CD1}'::uuid second_holder,
          25::bigint first_amount,51::bigint amount,true live;
        SET ROLE authenticated;`);
      const personalCharges = "SELECT public.shareholder_profit_my_position_v1($1)->'fund_charges' AS charges";
      await local.query("SELECT set_config('request.jwt.claim.sub',$1,false)",[U_CD1]);
      expect((await local.query(personalCharges,[ORG_A])).rows).toEqual([{charges:[expect.objectContaining({amount:26,live:true})]}]);
      await local.query("SELECT set_config('request.jwt.claim.sub',$1,false)",[U_XEM]);
      expect((await local.query(personalCharges,[ORG_A])).rows).toEqual([{charges:[]}]);
      const personalHistory = "SELECT public.shareholder_profit_my_position_v1($1)->'fund_payments' AS payments";
      await local.query("SELECT set_config('request.jwt.claim.sub',$1,false)",[U_CD1]);
      expect((await local.query(personalHistory,[ORG_A])).rows).toEqual([{payments:[expect.objectContaining({amount:110,state:'RESERVED'})]}]);
      await local.query("SELECT set_config('request.jwt.claim.sub',$1,false)",[U_XEM]);
      expect((await local.query(personalHistory,[ORG_A])).rows).toEqual([{payments:[]}]);
      await local.query("SELECT set_config('request.jwt.claim.sub',$1,false)",[CHU]);
      await local.exec('RESET ROLE');
      await expect(local.query(sqlDuyetChi(voucher_id,SO_QUY,{anh:false}))).rejects.toMatchObject({code:'55000'});
      expect((await quote()).lines.map(l=>l.paid)).toEqual([0,0]);
      await local.query("UPDATE app_private.server_feature_flags SET force_freeze=true WHERE feature_key=$1",[CO]);
      await expect(local.query(sqlDuyetChi(voucher_id,SO_QUY))).rejects.toMatchObject({code:'42501'});
      await local.query("UPDATE app_private.server_feature_flags SET force_freeze=false WHERE feature_key=$1",[CO]);
      await local.query("DELETE FROM public.role_permissions WHERE role_id=$1 AND permission_key='shareholder_profit.distribute'",[VAI_CHU_A]);
      await expect(local.query(sqlDuyetChi(voucher_id,SO_QUY))).rejects.toMatchObject({code:'42501'});
      await local.query("INSERT INTO public.role_permissions(organization_id,role_id,permission_key) VALUES($1,$2,'shareholder_profit.distribute')",[ORG_A,VAI_CHU_A]);
      await local.query(sqlDuyetChi(voucher_id,SO_QUY));
      expect((await quote()).lines.map(l=>[l.paid,l.reserved,l.available])).toEqual([[110,0,330],[110,0,330]]);
      await local.query(source('OPENING',500,0,'FUND-TEST'));
      await local.query(source('DEBIT',220,500,voucher_id));
      const overviewFund = (await local.query<{v:{expense_vouchers:{id:string;amount:number;posting:string}[]}}>(state)).rows[0].v;
      expect(overviewFund.expense_vouchers).toMatchObject([{id:voucher_id,amount:220,posting:'POSTED'}]);
      await local.query("SELECT set_config('request.jwt.claim.sub',$1,false)",[U_CD1]);
      expect((await local.query(personalHistory,[ORG_A])).rows).toEqual([{payments:[expect.objectContaining({amount:110,state:'PAID'})]}]);
      await expect(local.query(state)).rejects.toMatchObject({code:'42501'});
      await local.query("SELECT set_config('request.jwt.claim.sub',$1,false)",[CHU]);
      expect((await local.query('SELECT net_cash_effect::int AS amount FROM public.income_expense_postings WHERE voucher_id=$1 AND event_kind=\'POSTING\'',[voucher_id])).rows).toEqual([{amount:-220}]);
      await local.exec(dinhNghiaTrong("public.reverse_posted_income_expense_v2","20260723050000_finance_v2_writers.sql").stmt);
      const reversal = [voucher_id,SO_QUY,NGAY,'Đảo toàn bộ đợt thử',randomUUID()];
      const undo = "SELECT public.reverse_posted_income_expense_v2($1,$2,$3,$4,$5)";
      await expect(local.query(undo, reversal)).rejects.toMatchObject({code:'42501'});
      await local.exec(`INSERT INTO public.permission_definitions(key,resource,action,sensitivity)
        VALUES ('income_expenses.reverse','income_expenses','reverse','MANAGE');
        INSERT INTO public.role_permissions(organization_id,role_id,permission_key)
        VALUES ('${ORG_A}','${VAI_CHU_A}','income_expenses.reverse');`);
      await local.query(undo, reversal);
      expect((await quote()).lines.map(l=>[l.paid,l.reserved,l.available])).toEqual([[0,0,440],[0,0,440]]);
      expect((await local.query('SELECT sum(net_cash_effect)::int AS amount FROM public.income_expense_postings WHERE voucher_id=$1',[voucher_id])).rows).toEqual([{amount:0}]);
      await local.query("SELECT set_config('request.jwt.claim.sub',$1,false)",[NGOAI]);
      await local.exec('SET ROLE authenticated');
      await expect(local.query(create,[ORG_A,SO_QUY,NGAY,first.hash,randomUUID()])).rejects.toMatchObject({code:'42501'});
      await expect(quote()).rejects.toMatchObject({code:'42501'});
      await local.query("SELECT set_config('request.jwt.claim.sub',$1,false)",[U_XEM]);
      await expect(quote()).rejects.toMatchObject({code:'42501'});
    } finally {
      await local.close();
    }
  }, 180000);
  it("chia từ số đã đối chiếu, cấn đúng một lần, chi khoản phải trả qua W2", () => giaoDich(async () => {
    await chotThang("2026-10-01", TOA_1, { [CD1]: 120 });
    const opening = openAdvance(500, 120);
    await goi(CHU, opening);
    await goi(CHU, opening);
    expect(await viThe(CD1)).toMatchObject({ advance_outstanding: 500, unpaid_profit: 0 });
    const initial = source("OPENING", 900, 0, "QUY-DA-CHOT");
    await goi(CHU, initial);
    await goi(CHU, initial);
    const instruction = distribute([hand, payable]);
    const first = await goi(CHU, instruction);
    expect(first).toMatchObject({ amount: 800, advance_offset_amount: 400, payable_amount: 400, available_amount: 100 });
    expect(await goi(CHU, instruction)).toEqual(first);
    expect(await viThe(CD1)).toMatchObject({ advance_outstanding: 100, unpaid_profit: 0, balance: -100 });
    expect(await viThe(CD2)).toMatchObject({ advance_outstanding: 0, unpaid_profit: 400, balance: 400 });
    expect(await dem("public.income_expenses")).toBe(0);
    expect(await goi(CHU, state)).toMatchObject({ available_amount: 100 });
    const preview = await goi(CHU, r5(CD2, null));
    expect(preview.months).toEqual([
      expect.objectContaining({ month: "2026-11-01", unpaid_through: 400, selectable: true }),
    ]);
    // Một kỳ lợi nhuận mới chỉ được cấn số ứng thực còn lại.
    await chotThang("2026-11-01", TOA_1, { [CD1]: 135 });
    const net = await goi<KqChot>(CHU, w2({ cd: CD1, thang: "2026-11-01", so: SO_QUY, tien: 35, k: 100 }));
    expect(net).toMatchObject({ recognized_amount: 135, advance_offset_amount: 100, cash_amount: 35 });
    const paid = await goi<KqChot>(CHU, w2({ cd: CD2, thang: "2026-11-01", so: SO_QUY, tien: 400 }));
    expect(paid.voucher_id).toBeTruthy();
    expect(await duyetChi(paid.voucher_id!, CHU, SO_QUY)).toBeNull();
    expect(await viThe(CD2)).toMatchObject({ unpaid_profit: 0, advance_outstanding: 0, balance: 0 });
    expect(await goi(CHU, state)).toMatchObject({ available_amount: 100 });
  }));

  it("mốc sổ giữ kỳ đã đối chiếu và yêu cầu xác nhận cả khoản ứng bị che bởi số phải trả", () => giaoDich(async () => {
    await goi(CHU, openAdvance(90, 0, "2026-09-01", "2026-09-30"));
    const marker = await mocHieuLuc(CD1);
    expect(marker).toBeTruthy();
    expect(await loiGoi(CHU, e9(CD1, null, marker))).toMatchObject({ code: "22023" });
    await goi(CHU, source("OPENING", 120, 0, "NGUON-DA-CHOT", "2026-10-01"));
    await goi(CHU, distribute([{ ...hand, amount: 120, advance_offset_amount: 20 }], 120, "QC-01", "2026-10-02"));
    expect(await viThe(CD1)).toMatchObject({ advance_outstanding: 70, unpaid_profit: 100, balance: 30 });
    const markerPreview = `SELECT public.profit_ledger_marker_preview_v1('${ORG_A}', 'SHAREHOLDER', '${CD1}', '2026-10-01') AS v`;
    const preview = await goi(CHU, markerPreview);
    expect(preview).toMatchObject({ advance_erased: 70, requires_acknowledge: true });
    expect(await loiGoi(CHU, e9(CD1, "2026-09-01", marker))).toMatchObject({ code: "22023" });
    const nextMarker = e9(CD1, "2026-10-01", marker);
    expect(await loiGoi(CHU, e9(CD1, "2026-10-01", marker, false))).toMatchObject({ code: "22023" });
    expect(await viThe(CD1)).toMatchObject({ advance_outstanding: 70, unpaid_profit: 100 });
    expect(await goi(CHU, nextMarker)).toMatchObject({ advance_erased: 70 });
    expect(await viThe(CD1)).toMatchObject({ advance_outstanding: 0, unpaid_profit: 0 });
  }));

  it("chuyển số dư đã đối chiếu khi một phần ứng có phiếu CRM và một phần ở sổ ngoài", () => giaoDich(async () => {
    const advance = await ungDaDuyet(30, { ngay: "2026-11-09", so: SO_QUY, nguoiLap: CHU });
    expect(await ghiSo(advance.voucher_id, CHU, SO_QUY)).toBeNull();
    expect(await viThe(CD1)).toMatchObject({ advance_outstanding: 30 });
    // Kỳ lợi nhuận tháng 10 đã quyết toán bằng cả các khoản phát sinh trong tháng 11.
    const migrate = (expected: number, asOfDate = "2026-11-12") =>
      `SELECT public.shareholder_profit_opening_advance_v1('${ORG_A}', '${CD1}', '2026-10-01',
        '${asOfDate}', 90, 0, 'Tổng đối chiếu đã gồm phiếu ứng CRM và ứng sổ ngoài', 'legacy-reconciled', ${expected}) AS v`;
    expect(await loiGoi(CHU, migrate(30, "2026-11-11"))).toMatchObject({ code: "PT409" });
    expect(await loiGoi(CHU, migrate(0))).toMatchObject({ code: "PT409" });
    const receipt = await goi(CHU, migrate(30));
    expect(await goi(CHU, migrate(30))).toEqual(receipt);
    expect(await loiGoi(CHU, migrate(30).replace(CD1, CD2))).toMatchObject({ code: "PT409" });
    expect(await viThe(CD1)).toMatchObject({ advance_outstanding: 90, unpaid_profit: 0 });
    expect(await dem("public.income_expenses")).toBe(1);
    expect(await huyPhieu(advance.voucher_id, CHU2, "POSTED")).toMatchObject({ code: "55000" });
    expect(await phieu(advance.voucher_id)).toMatchObject({ approval_status: "APPROVED", posting_status: "POSTED" });
  }));

  it("bảy phiếu lịch sử và ba phiếu đã chi tái hiện mười kỳ, không thay đổi sổ tiền", () => giaoDich(async () => {
    const month = (n: number) => `2026-${String(n).padStart(2, '0')}-01`;
    for (let n=5; n<=10; n++) await chotThang(month(n), TOA_1, { [CD1]:50 });
    for (let n=9; n<=11; n++) {
      const p = await ungDaDuyet(100, { ngay:month(n), so:SO_QUY, nguoiLap:CHU });
      expect(await ghiSo(p.voucher_id, CHU, SO_QUY)).toBeNull();
    }
    const opening = await goi<{opening_id:string}>(CHU,
      `SELECT public.shareholder_profit_opening_advance_v1('${ORG_A}','${CD1}','2026-10-01','2026-11-12',521,300,'Biên bản tổng hợp mười kỳ','history-monthly-fixture',300) AS v`);
    await db.query("INSERT INTO public.income_expenses(id,user_id,organization_id,type,name,building_id,voucher_date,code,total_amount,account_id,approval_status,posting_status,active_posting_id_v2) VALUES ($1,$2,$3,'EXPENSE','Bàn giao tiền',$4,$5,'PC-SOURCE-TEST',23,$6,'APPROVED','POSTED',$7)",
      [id(8900),CHU,ORG_A,TOA_1,month(2),SO_QUY,id(8901)]);
    const receipts = Array.from({length:7},(_,i)=>({period_month:month(i+1), amount:100+i,
      source_codes:i===0?['PC-SOURCE-TEST']:[], external_profit:i<4?50:null, evidence:'Bảng đối chiếu kỳ '+(i+1)}));
    const save = (rows:typeof receipts, org=ORG_A, shareholder=CD1) =>
      `SELECT public.shareholder_record_opening_receipts_v1('${org}','${shareholder}','${opening.opening_id}','${JSON.stringify(rows)}') AS v`;
    const position = await viThe(CD1);
    const postings = await dem('public.income_expense_postings');
    expect(await loiGoi(U_CD1,save(receipts))).toMatchObject({code:'42501'});
    expect(await loiGoi(NGOAI,save(receipts,ORG_B))).not.toBeNull();
    expect(await loiGoi(CHU,save(receipts,ORG_A,CD2))).not.toBeNull();
    expect(await loiGoi(CHU,save([...receipts,receipts[0]]))).toMatchObject({code:'22023'});
    expect(await loiGoi(CHU,save([...receipts.slice(0,6),{...receipts[6],period_month:month(10)}]))).toMatchObject({code:'22023'});
    expect(await loiGoi(CHU,save(receipts.slice(1)))).toMatchObject({code:'22023'});
    expect(await dem('app_private.shareholder_opening_advance_receipts')).toBe(0);
    expect(await loiGoi(CHU,save(receipts.map((r,i)=>({...r,source_codes:i===1?['PC-SOURCE-TEST']:[]}))))).toMatchObject({code:'22023'});
    expect(await dem('app_private.shareholder_opening_advance_receipts')).toBe(0);
    expect(await goi(CHU,save(receipts))).toMatchObject({count:7,amount:721});
    expect(await goi(CHU,save([...receipts].reverse()))).toMatchObject({count:7,amount:721});
    expect(await loiGoi(CHU,save(receipts.slice(1)))).toMatchObject({code:'PT409'});
    const ledger = await goi<{historical_advances:unknown[];payouts:unknown[]}>(U_CD1,
      `SELECT public.shareholder_profit_my_ledger_v1('${ORG_A}') AS v`);
    expect(ledger.historical_advances).toHaveLength(7);
    expect(ledger.historical_advances[0]).toMatchObject({sources:[{code:'PC-SOURCE-TEST',date:month(2),amount:23,live:true}]});
    expect(ledger.payouts).toHaveLength(3);
    const other = await goi<{historical_advances:unknown[]}>(U_XEM,
      `SELECT public.shareholder_profit_my_ledger_v1('${ORG_A}') AS v`);
    expect(other.historical_advances).toEqual([]);
    expect(await viThe(CD1)).toEqual(position);
    expect(await dem('public.income_expenses')).toBe(4);
    expect(await dem('public.income_expense_postings')).toBe(postings);
  }));

  it("khôi phục khoản phải trả đúng tháng quỹ khi phiếu ứng đã cấn bị hủy", () => giaoDich(async () => {
    const advance = await ungDaDuyet(50, { ngay: "2026-11-09", so: SO_QUY, nguoiLap: CHU });
    expect(await ghiSo(advance.voucher_id, CHU, SO_QUY)).toBeNull();
    await goi(CHU, source("OPENING", 50, 0, "NGUON-50"));
    const offset = [{ shareholder_id: CD1, amount: 50, advance_offset_amount: 50 }];
    expect(await loiGoi(CHU, distribute(offset, 50, "PP-THU", "2026-11-05"))).toMatchObject({ code: "PT409" });
    await goi(CHU, distribute(offset, 50, "PP-THAT", "2026-11-12"));
    expect(await viThe(CD1)).toMatchObject({ unpaid_profit: 0, advance_outstanding: 0 });
    expect(await huyPhieu(advance.voucher_id, CHU2, "POSTED")).toBeNull();
    expect(await viThe(CD1)).toMatchObject({ unpaid_profit: 50, advance_outstanding: 0 });
    expect(await goi(CHU, r5(CD1))).toMatchObject({
      months: [expect.objectContaining({ month: "2026-11-01", unpaid_through: 50, selectable: true })],
    });
    expect(await goi(CHU, w2({ cd: CD1, thang: "2026-11-01", tien: 50, ngay: "2026-11-13" })))
      .toMatchObject({ cash_amount: 50, advance_offset_amount: 0 });
    expect(await goi(CHU, state)).toMatchObject({ available_amount: 0 });
  }));

  it("từ chối phân bổ vượt số dư, quá số ứng hay sai cổ đông và không ghi dở", () => giaoDich(async () => {
    await goi(CHU, source("OPENING", 900, 0, "DAU-KY"));
    for (const row of [
      { ...hand, amount: 1000, advance_offset_amount: 0 },
      hand,
      { ...payable, shareholder_id: CD_B },
      { ...payable, amount: -1 },
    ]) {
      expect(await loiGoi(CHU, distribute([payable, row]))).not.toBeNull();
    }
    expect(await loiGoi(CHU, distribute([payable, payable]))).not.toBeNull();
    await goi(CHU, distribute([payable]));
    expect(await loiGoi(CHU, distribute([payable], 900, "QC-02"))).not.toBeNull();
    expect(await loiGoi(CHU, distribute([payable], 500, "QC-01"))).not.toBeNull();
    expect(await goi(CHU, state)).toMatchObject({ available_amount: 500 });
    expect(await viThe(CD2)).toMatchObject({ unpaid_profit: 400 });
  }));

  it("kiểm quyền và nguồn đối soát cho từng công ty", () => giaoDich(async () => {
    const open = source("OPENING", 900, 0, "DAU-KY");
    for (const user of [NGOAI, U_XEM, null]) {
      expect(await loiGoi(user, open)).toMatchObject({ code: "42501" });
      expect(await loiGoi(user, state)).toMatchObject({ code: "42501" });
    }
    await goi(CHU, open);
    expect(await loiGoi(CHU, source("OPENING", 1, 900, "DAU-LAN-2"))).not.toBeNull();
    await goi(CHU, source("DEBIT", 100, 900, "CHI-01"));
    expect(await loiGoi(CHU, source("DEBIT", 100, 800, "CHI-01"))).not.toBeNull();
    await goi(CHU, source("CREDIT", 200, 800, "BO-SUNG"));
    expect(await goi(CHU, state)).toMatchObject({ available_amount: 1000 });
  }));
});

describe("duyệt tạm ứng cổ đông theo quyền hiện tại của người bấm", () => {
  beforeAll(async () => {
    // Nạp đúng phần vá trigger ngày 21/11, khi người chủ tự duyệt còn phải có tên trong bước được giao.
    const routing = readFileSync(`${DIR}/20261121014008_duyet_phieu_co_dong_theo_vai_tro.sql`, "utf8");
    const patch = routing.match(/'app_private\.guard_profit_ledger_payout_v1\(\)'::regprocedure,\s*\$old\$([\s\S]*?)\$old\$,\s*\$new\$([\s\S]*?)\$new\$/);
    if (!patch) throw new Error("Thiếu phần vá phân công duyệt ngày 21/11");
    const previous = await mot<string>(`SELECT pg_get_functiondef('${F1_REGPROC}'::regprocedure) AS v`);
    expect(previous).toContain(patch[1]);
    await db.exec(previous.replace(patch[1], patch[2]));
    // Fixture gửi phiếu ở trên tạo một bước ANY/1. Gắn bước đó với quy tắc duyệt theo quyền.
    await db.exec(`
      ALTER TABLE public.approval_requests ADD matched_rule_id uuid DEFAULT '${id(810)}';
      ALTER TABLE public.approval_request_steps ADD rule_step_snapshot jsonb DEFAULT '{"rule_step_id":"${id(811)}"}';
      ALTER TABLE public.approval_request_step_candidates ADD eligible_at_submit boolean DEFAULT true;
      CREATE TABLE public.approval_rule_steps(id uuid, rule_id uuid, organization_id uuid);
      CREATE TABLE public.approval_step_approvers(step_id uuid, organization_id uuid, approver_type text, permission_key text);
      INSERT INTO public.approval_rule_steps VALUES ('${id(811)}','${id(810)}','${ORG_A}');
      INSERT INTO public.approval_step_approvers VALUES ('${id(811)}','${ORG_A}','PERMISSION','income_expenses.approve');
      CREATE FUNCTION app_private.profit_advance_maker_kind_v1(uuid,boolean) RETURNS text LANGUAGE sql AS $$ SELECT 'OWNER'::text $$;
    `);
    const migration = readFileSync(`${DIR}/20261125124010_duyet_tam_ung_co_dong_theo_quyen.sql`, "utf8");
    await db.exec(migration);
    await db.exec(migration);
  });

  it("người giữ sổ lập hộ được cấp đủ quyền sau khi lập thì tự duyệt được phiếu còn chờ", () => giaoDich(async () => {
    const voucher = await goi<KqUng>(GIU_SO, w1({ cd: CD1, tien: 10 }));
    expect(voucher.maker_kind).toBe("CUSTODIAN_FOR_PAYEE");
    await capVai(GIU_SO, ["income_expenses.approve"], 401);
    laLoi(await duyet(voucher.voucher_id, GIU_SO), "42501", "PROFIT_LEDGER_APPROVE_FORBIDDEN");
    await capVai(GIU_SO, ["shareholder_profit.distribute"], 402);
    expect(await duyet(voucher.voucher_id, GIU_SO)).toBeNull();
    expect(await trangThai(voucher.voucher_id)).toEqual({ approval_status: "APPROVED", posting_status: "UNPOSTED" });
    expect((await nhatKy(voucher.voucher_id)).map(e => e.event_kind).sort()).toEqual(["PAYOUT_APPROVED", "PAYOUT_CREATED"]);
  }));

  it("người nhận có đủ quyền duyệt phiếu do người khác lập hộ, người giữ sổ lập hộ ghi chi", () => giaoDich(async () => {
    const voucher = await goi<KqUng>(CHU2, w1({ cd: CD_CHU, tien: 10, so: SO_QUY }));
    laLoi(await duyetChi(voucher.voucher_id, CHU, SO_QUY), "42501", "PROFIT_LEDGER_PAYEE_SELF_POST");
    expect(await trangThai(voucher.voucher_id)).toEqual({ approval_status: "UNAPPROVED", posting_status: "UNPOSTED" });
    expect(await duyet(voucher.voucher_id, CHU)).toBeNull();
    expect(await ghiSo(voucher.voucher_id, CHU2, SO_QUY)).toBeNull();
  }));

  it("phiếu chủ lập có cùng loại người lập với chốt chi nhưng sự kiện lập xác nhận đây là tạm ứng", () => giaoDich(async () => {
    await db.exec(`CREATE FUNCTION app_private.ie_actor_is_company_owner_v1(uuid,uuid) RETURNS boolean LANGUAGE sql
      AS $$ SELECT $1='${ORG_A}'::uuid AND $2='${CHU}'::uuid $$`);
    const classify = readFileSync(`${DIR}/20261121004800_phan_loai_tam_ung_do_chu_lap.sql`, "utf8");
    await db.exec(classify.replace(/^BEGIN;\s*$/m, "").replace(/^COMMIT;\s*$/m, ""));
    const voucher = await goi<KqUng>(CHU, w1({ cd: CD1, tien: 10, so: SO_QUY }));
    expect(await dongSo(voucher.voucher_id)).toMatchObject({ maker_kind: "OWNER" });
    expect(await duyet(voucher.voucher_id, CHU)).toBeNull();
  }));

  it("phiếu chốt chi do chủ lập vẫn cần người đã được phân công", () => giaoDich(async () => {
    await chotThang("2026-09-01", TOA_1, { [CD1]: 100 });
    const voucher = await chotChi(CHU, CD1, 100);
    laLoi(await duyet(voucher, CHU), "42501", "PROFIT_LEDGER_MAKER_SELF_APPROVE");
    expect(await duyet(voucher, CHU2)).toBeNull();
  }));

  it.each(["MEMBER", "nhiều bước"])("phiếu tạm ứng theo quy trình %s giữ điều kiện phân công", (rule) => giaoDich(async () => {
    const voucher = await goi<KqUng>(CHU, w1({ cd: CD1, tien: 10, so: SO_QUY }));
    if (rule === "MEMBER") {
      await db.exec("UPDATE public.approval_step_approvers SET approver_type='MEMBER', permission_key=NULL");
    } else {
      await db.exec(`INSERT INTO public.approval_request_steps(organization_id,request_id,step_no,status,mode,min_approvals)
        SELECT organization_id,id,2,'WAITING','ANY',1 FROM public.approval_requests WHERE subject_id='${voucher.voucher_id}'`);
    }
    laLoi(await duyet(voucher.voucher_id, CHU), "42501", "PROFIT_LEDGER_MAKER_SELF_APPROVE");
    expect(await trangThai(voucher.voucher_id)).toEqual({ approval_status: "UNAPPROVED", posting_status: "UNPOSTED" });
  }));

  it("người giữ sổ tự ứng, có đủ quyền thì được duyệt và chi từ sổ đang giữ", () => giaoDich(async () => {
    const voucher = await goi<KqUng>(CHU, w1({ cd: CD_CHU, tien: 10, so: SO_QUY }));
    expect(voucher.maker_kind).toBe("CUSTODIAN_ADVANCE");
    expect(await duyetChi(voucher.voucher_id, CHU, SO_QUY)).toBeNull();
    expect(await trangThai(voucher.voucher_id)).toEqual({ approval_status: "APPROVED", posting_status: "POSTED" });
  }));
});
