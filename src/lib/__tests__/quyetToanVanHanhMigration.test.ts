import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  landlordOperationOptionsSchema, landlordOperationsListSchema, settlementMonthSchema,
  settlementOverviewSchema, settlementPublicSchema, shareLinksSchema, upsertReceiptSchema,
} from "@/lib/landlordSettlement";

/**
 * Migration 20261021083438 — quyết toán toà VẬN HÀNH CHO CHỦ NHÀ (chủ chốt 21/10/2026).
 * Chạy THẬT trên PostgreSQL nhúng: migration HAI lượt, rồi gọi RPC bằng vai
 * authenticated / anon như PostgREST. Kiểm công thức (ai giữ tiền, % quản lý, lỗ thì 0),
 * chặn quyền, chốt có CAS + phát hiện phiếu đổi sau chốt, thanh toán chống bấm trùng,
 * link công khai không lộ id/tên sổ, điều khoản theo tháng, đối chiếu KQKD, và gói RPC
 * thật parse được bằng đúng schema zod mà web dùng.
 *
 * Dữ liệu đặt ở 2025 (tháng đã qua) để phép "chỉ chốt tháng đã qua" không phụ thuộc ngày chạy.
 */
const FILE = "supabase/migrations/20261021083438_quyet_toan_van_hanh_chu_nha.sql";
const MIG_DIR = join(process.cwd(), "supabase", "migrations");
/**
 * Định nghĩa SỐNG của một hàm public: câu CREATE cuối cùng trong toàn bộ thư mục migration (theo thứ
 * tự tên file), bỏ qua dòng chú thích. Không ghim file cũ — hàm thật đổi thì test chạy theo bản mới.
 */
function liveDefinitionOf(fnName: string): string {
  const re = new RegExp(`CREATE\\s+(?:OR\\s+REPLACE\\s+)?FUNCTION\\s+public\\.${fnName}\\s*\\(`, "gi");
  let hit: { sql: string; start: number } | null = null;
  for (const f of readdirSync(MIG_DIR).filter((x) => x.endsWith(".sql")).sort()) {
    const sql = readFileSync(join(MIG_DIR, f), "utf8");
    for (const m of sql.matchAll(re)) {
      const lineStart = sql.lastIndexOf("\n", m.index) + 1;
      if (!sql.slice(lineStart, m.index).includes("--")) hit = { sql, start: m.index };
    }
  }
  if (!hit) throw new Error(`không tìm thấy định nghĩa public.${fnName}`);
  const rest = hit.sql.slice(hit.start);
  const open = /\bAS\s+(\$[A-Za-z_]*\$)/i.exec(rest);
  if (!open) throw new Error(`public.${fnName}: không thấy thân hàm`);
  const close = rest.indexOf(open[1], open.index + open[0].length);
  return rest.slice(0, rest.indexOf(";", close + open[1].length) + 1);
}
/** Các hàm sống mà quyết toán gọi tới: nguồn KQKD / Chốt LN, bỏ dấu tiếng Việt, khớp hạng mục phí. */
const LIVE_FNS = ["nrm_vn", "fee_type_matches", "fa_accrual_allocations"].map(liveDefinitionOf);
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const [ORG_A, ORG_B, CHU_A, NHAN_VIEN_A, CHU_B, SUPER] = [1, 2, 3, 4, 5, 6].map(id);
const [TOA_A, TOA_B, TOA_AO, TOA_C] = [11, 12, 13, 14].map(id);
const [SO_CHU_NHA, SO_QUAN_LY, SO_AO, SO_CONG_TY_B, SO_CHU_NHA_C] = [21, 22, 23, 24, 25].map(id);
const [LOAI_THU, LOAI_DIEN, LOAI_TU_LANH] = [31, 32, 33].map(id);
const db = new PGlite();

type Json = Record<string, unknown>;

async function asUser(user: string | null) {
  await db.exec("RESET ROLE");
  await db.query("SELECT set_config('request.jwt.claim.sub',$1,true)", [user ?? ""]);
  await db.exec(user ? "SET LOCAL ROLE authenticated" : "SET LOCAL ROLE anon");
}
async function asPostgres() {
  await db.exec("RESET ROLE");
}
async function trongGiaoDich<T>(fn: () => Promise<T>): Promise<T> {
  await db.exec("BEGIN");
  try { return await fn(); } finally { await db.exec("ROLLBACK"); }
}
async function rpc<T = Json>(sql: string, params: unknown[] = []): Promise<T> {
  const r = await db.query<{ r: T }>(`SELECT ${sql} AS r`, params);
  return r.rows[0].r;
}
const so = (v: unknown) => Number(v);
/** db.exec cho khối SQL dài: lỗi thì kèm đoạn quanh vị trí lỗi để biết câu nào hỏng. */
async function chay(sql: string) {
  try { await db.exec(sql); } catch (e) {
    const pos = Number((e as { position?: string }).position ?? 0);
    throw new Error(`${(e as Error).message} — gần: ${sql.slice(Math.max(0, pos - 160), pos + 40)}`);
  }
}
/** Câu mong lỗi chạy trong SAVEPOINT để transaction của ca test còn dùng tiếp được. */
async function expectLoi(sql: string, params: unknown[], code: string) {
  await db.exec("SAVEPOINT thu_loi");
  let err: unknown = null;
  try { await db.query(sql, params); } catch (e) { err = e; }
  await db.exec(err ? "ROLLBACK TO SAVEPOINT thu_loi" : "RELEASE SAVEPOINT thu_loi");
  expect(err).toMatchObject({ code });
}

let n = 100;
async function phieu(p: {
  toa?: string; loai: "INCOME" | "EXPENSE"; so: string | null; thang: string; trangThai?: string;
  kqkd?: boolean | null; xoa?: boolean; dong?: { lop: string; tien: number; tu?: string; den?: string }[]; tong?: number; nguon?: string;
  butToan?: string; lamTron?: { so: string; tien: number }; thoi?: { so: string; tien: number };
  ten?: string; hoaDon?: string; hanChe?: boolean; loaiHangMuc?: string;
}) {
  const pid = id(n++);
  await db.query(
    `INSERT INTO public.income_expenses(id, organization_id, building_id, code, name, type, voucher_date, account_id,
       approval_status, business_result_accounting, total_amount, deleted_at, system_source, posting_status,
       rounding_account_id, rounding_amount, change_account_id, change_amount, invoice_id, has_restricted_item)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)`,
    [pid, ORG_A, p.toa ?? TOA_A, `P${n}`, p.ten ?? `Phiếu ${n}`, p.loai, p.thang, p.so, p.trangThai ?? "APPROVED",
      p.kqkd ?? null, p.tong ?? (p.dong ?? []).reduce((s, d) => s + d.tien, 0), p.xoa ? new Date().toISOString() : null,
      p.nguon ?? null, p.butToan ?? "POSTED", p.lamTron?.so ?? null, p.lamTron?.tien ?? 0,
      p.thoi?.so ?? null, p.thoi?.tien ?? 0, p.hoaDon ?? null, p.hanChe ?? false],
  );
  for (const d of p.dong ?? []) {
    await db.query(
      "INSERT INTO public.income_expense_items(income_expense_id, amount, accounting_class, income_expense_type_id, start_date, end_date) VALUES ($1,$2,$3,$4,$5,$6)",
      [pid, d.tien, d.lop, p.loaiHangMuc ?? LOAI_THU, d.tu ?? null, d.den ?? null],
    );
  }
  return pid;
}

let PHIEU_LO_CHI = "";
let PHIEU_HAN_CHE_MA = "";

beforeAll(async () => {
  await chay(`
    CREATE ROLE authenticated; CREATE ROLE anon; CREATE ROLE service_role;
    CREATE SCHEMA auth; CREATE SCHEMA app_private; CREATE SCHEMA extensions;
    GRANT USAGE ON SCHEMA public, auth TO authenticated, anon;
    CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
    CREATE FUNCTION extensions.gen_random_bytes(integer) RETURNS bytea LANGUAGE sql VOLATILE
      AS $$ SELECT substring(decode(md5(random()::text) || md5(random()::text), 'hex') from 1 for $1) $$;
    CREATE TABLE public.organizations(id uuid PRIMARY KEY, name text);
    CREATE TABLE public.memberships(user_id uuid, organization_id uuid, is_owner boolean);
    CREATE TABLE public.super_admins(user_id uuid PRIMARY KEY);
    CREATE FUNCTION public.is_super_admin() RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER
      AS $$ SELECT EXISTS (SELECT 1 FROM public.super_admins WHERE user_id = auth.uid()) $$;
    CREATE FUNCTION public.my_org_ids() RETURNS uuid[] LANGUAGE sql STABLE SECURITY DEFINER
      AS $$ SELECT COALESCE(array_agg(organization_id), '{}') FROM public.memberships WHERE user_id = auth.uid() $$;
    CREATE FUNCTION app_private.ie_actor_is_company_owner_v1(p_org uuid, p_actor uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER
      AS $$ SELECT EXISTS (SELECT 1 FROM public.memberships WHERE user_id = p_actor AND organization_id = p_org AND is_owner) $$;
    CREATE TABLE public.buildings(id uuid PRIMARY KEY, organization_id uuid, name text, name_sort text,
      is_virtual boolean DEFAULT false, deleted_at timestamptz);
    CREATE FUNCTION public.can_access_building(_building_id uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER
      AS $$ SELECT public.is_super_admin() OR EXISTS (SELECT 1 FROM public.buildings b JOIN public.memberships m
             ON m.organization_id = b.organization_id WHERE b.id = _building_id AND m.user_id = auth.uid()) $$;
    CREATE TABLE public.accounts(id uuid PRIMARY KEY, organization_id uuid, name text, code text,
      is_virtual boolean DEFAULT false, deleted_at timestamptz);
    CREATE TABLE public.income_expenses(id uuid PRIMARY KEY, organization_id uuid, building_id uuid, code text, name text,
      notes text, type text, voucher_date date, account_id uuid, approval_status text, business_result_accounting boolean,
      total_amount numeric, deleted_at timestamptz, system_source text, posting_status text,
      change_account_id uuid, change_amount numeric DEFAULT 0, rounding_account_id uuid, rounding_amount numeric DEFAULT 0,
      invoice_id uuid, has_restricted_item boolean DEFAULT false);
    CREATE TABLE public.income_expense_types(id uuid PRIMARY KEY, organization_id uuid, name text, category text,
      fee_category text, type text);
    CREATE TABLE public.income_expense_items(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), income_expense_id uuid,
      amount numeric, unit_price numeric, quantity numeric, accounting_class text, income_expense_type_id uuid,
      start_date date, end_date date);
    CREATE TABLE public.invoices(id uuid PRIMARY KEY, billing_month text, deleted_at timestamptz);
    CREATE TABLE public.building_fee_accounts(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), building_id uuid,
      fee_category text, not_applicable boolean DEFAULT false, deleted_at timestamptz);
    CREATE TABLE public.profiles(id uuid PRIMARY KEY, full_name text, email text);

    INSERT INTO public.organizations VALUES ('${ORG_A}','A'),('${ORG_B}','B');
    INSERT INTO public.memberships VALUES ('${CHU_A}','${ORG_A}',true),('${NHAN_VIEN_A}','${ORG_A}',false),('${CHU_B}','${ORG_B}',true);
    INSERT INTO public.super_admins VALUES ('${SUPER}');
    INSERT INTO public.profiles VALUES ('${CHU_A}','Chủ A',null);
    INSERT INTO public.buildings(id, organization_id, name, name_sort, is_virtual) VALUES
      ('${TOA_A}','${ORG_A}','44TA','toa a',false),('${TOA_B}','${ORG_B}','55TB','toa b',false),
      ('${TOA_AO}','${ORG_A}','Kho chung','kho chung',true),('${TOA_C}','${ORG_A}','Hẻm 66 Thành Công','toa c',false);
    INSERT INTO public.accounts(id, organization_id, name, code, is_virtual) VALUES
      ('${SO_CHU_NHA}','${ORG_A}','Sổ chủ nhà','TK1',false),('${SO_QUAN_LY}','${ORG_A}','Sổ quản lý','TK2',false),
      ('${SO_AO}','${ORG_A}','Cấn trừ thanh lý','TK3',true),('${SO_CONG_TY_B}','${ORG_B}','Sổ B','TK9',false),
      ('${SO_CHU_NHA_C}','${ORG_A}','Sổ chủ nhà C','TK5',false);
    INSERT INTO public.income_expense_types(id, organization_id, name, category, fee_category, type) VALUES
      ('${LOAI_THU}','${ORG_A}','Tiền phòng','Phòng',null,'income'),
      ('${LOAI_DIEN}','${ORG_A}','Đóng tiền điện','Điện','dien','expense'),
      ('${LOAI_TU_LANH}','${ORG_A}','Mua tủ lạnh','Điện',null,'expense');
    -- toà A đã khai điện (chưa có phiếu nào) và tiền nhà "không áp dụng"
    INSERT INTO public.building_fee_accounts(building_id, fee_category, not_applicable) VALUES
      ('${TOA_A}','dien',false),('${TOA_A}','tien_nha',true);
  `);
  // nrm_vn, fee_type_matches, fa_accrual_allocations: chạy đúng ĐỊNH NGHĨA SỐNG (CREATE cuối cùng trong
  // thư mục migration) để cảnh báo thiếu chi và khối đối chiếu KQKD đo trên hàm thật.
  for (const fn of LIVE_FNS) await chay(fn);

  // Tháng 01/2025 — đủ mọi loại dòng.
  await phieu({ loai: "INCOME", so: SO_CHU_NHA, thang: "2025-01-05", dong: [{ lop: "PNL", tien: 10_000_000 }] });
  await phieu({ loai: "INCOME", so: SO_QUAN_LY, thang: "2025-01-06", dong: [{ lop: "PNL", tien: 1_000_000 }] });
  PHIEU_HAN_CHE_MA = `P${n + 1}`; // phieu() tăng n trước khi đặt mã
  await phieu({ loai: "EXPENSE", so: SO_QUAN_LY, thang: "2025-01-07", hanChe: true, ten: "Lương nhân viên",
    dong: [{ lop: "PNL", tien: 2_000_000 }] });
  await phieu({ loai: "EXPENSE", so: SO_CHU_NHA, thang: "2025-01-08", dong: [{ lop: "PNL", tien: 500_000 }] });
  await phieu({ loai: "INCOME", so: SO_QUAN_LY, thang: "2025-01-09", dong: [{ lop: "DEPOSIT", tien: 3_000_000 }] });
  // thanh lý: cấn 400k cọc vào khoản khách phải trả (sổ ảo cấn trừ) ⇒ doanh thu bên quản lý
  await phieu({ loai: "EXPENSE", so: SO_AO, thang: "2025-01-10", nguon: "termination.offset", dong: [{ lop: "DEPOSIT", tien: 400_000 }] });
  await phieu({ loai: "INCOME", so: SO_AO, thang: "2025-01-10", nguon: "termination.revenue", dong: [{ lop: "PNL", tien: 400_000 }] });
  // thanh lý: trả thêm cho khách 150k ngoài cọc (PNL) + hoàn 850k cọc (DEPOSIT), một phiếu, sổ quản lý
  await phieu({ loai: "EXPENSE", so: SO_QUAN_LY, thang: "2025-01-10", nguon: "termination.refund",
    dong: [{ lop: "PNL", tien: 150_000 }, { lop: "DEPOSIT", tien: 850_000 }] });
  // khách chuyển cọc + trả thừa vào SỔ CHỦ NHÀ: chủ nhà giữ hộ tiền quản lý phải hoàn
  await phieu({ loai: "INCOME", so: SO_CHU_NHA, thang: "2025-01-19", dong: [{ lop: "DEPOSIT", tien: 800_000 }] });
  await phieu({ loai: "INCOME", so: SO_CHU_NHA, thang: "2025-01-19", dong: [{ lop: "CUSTOMER_CREDIT", tien: 5_000 }] });
  // dòng nội bộ: không tính, nhưng phải hiện ở nhóm "không tính"
  await phieu({ loai: "INCOME", so: SO_QUAN_LY, thang: "2025-01-20", dong: [{ lop: "INTERNAL", tien: 20_000 }] });
  await phieu({ loai: "EXPENSE", so: SO_QUAN_LY, thang: "2025-01-11", trangThai: "UNAPPROVED", dong: [{ lop: "PNL", tien: 700_000 }] });
  await phieu({ loai: "INCOME", so: SO_CHU_NHA, thang: "2025-01-11", trangThai: "UNAPPROVED", dong: [{ lop: "PNL", tien: 600_000 }] });
  await phieu({ loai: "INCOME", so: SO_CHU_NHA, thang: "2025-01-12", trangThai: "CANCELLED", dong: [{ lop: "PNL", tien: 9_999 }] });
  await phieu({ loai: "INCOME", so: SO_QUAN_LY, thang: "2025-01-13", kqkd: false, dong: [{ lop: "PNL", tien: 5_000 }] });
  await phieu({ loai: "INCOME", so: SO_QUAN_LY, thang: "2025-01-14", tong: 100_000 });
  await phieu({ loai: "INCOME", so: SO_CHU_NHA, thang: "2025-01-15", xoa: true, dong: [{ lop: "PNL", tien: 77 }] });
  await phieu({ toa: TOA_B, loai: "INCOME", so: SO_CONG_TY_B, thang: "2025-01-16", dong: [{ lop: "PNL", tien: 1_234 }] });
  await phieu({ loai: "INCOME", so: null, thang: "2025-01-17", dong: [{ lop: "PNL", tien: 50_000 }] });
  await phieu({ loai: "EXPENSE", so: SO_QUAN_LY, thang: "2025-01-18", kqkd: true, dong: [{ lop: "DEPOSIT", tien: 30_000 }] });
  // Tháng 02/2025 — lỗ.
  await phieu({ loai: "INCOME", so: SO_CHU_NHA, thang: "2025-02-03", dong: [{ lop: "PNL", tien: 1_000_000 }] });
  PHIEU_LO_CHI = await phieu({ loai: "EXPENSE", so: SO_QUAN_LY, thang: "2025-02-04", dong: [{ lop: "PNL", tien: 3_000_000 }] });
  // Tháng 03/2025 — phiếu đã duyệt nhưng bút toán bị đảo; tiền thối (tính) và làm tròn (KHÔNG tính) rơi vào sổ chủ nhà.
  await phieu({ loai: "INCOME", so: SO_CHU_NHA, thang: "2025-03-03", butToan: "REVERSED", dong: [{ lop: "PNL", tien: 100_000 }] });
  await phieu({ loai: "INCOME", so: SO_QUAN_LY, thang: "2025-03-04", lamTron: { so: SO_CHU_NHA, tien: 1_000 },
    thoi: { so: SO_CHU_NHA, tien: 2_000 }, dong: [{ lop: "PNL", tien: 50_000 }] });
  // Trước ngày áp dụng: khách chuyển cọc 700k vào sổ chủ nhà (gợi ý số dư đầu kỳ).
  await phieu({ loai: "INCOME", so: SO_CHU_NHA, thang: "2024-12-20", dong: [{ lop: "DEPOSIT", tien: 700_000 }] });

  const sql = readFileSync(FILE, "utf8");
  await chay(sql);
  await chay(sql);

  // Cấu hình toà A (ghi thẳng như dữ liệu có sẵn; đường RPC thêm/sửa có ca riêng). Số dư đầu kỳ đã xác nhận.
  await chay(`
    INSERT INTO app_private.landlord_operations
      (building_id, organization_id, landlord_name, effective_from, opening_confirmed_at, opening_confirmed_by,
       opening_confirmed_from, opening_confirmed_pre_start, created_by, updated_by)
    VALUES ('${TOA_A}','${ORG_A}','Chủ nhà A','2025-01-01',now(),'${CHU_A}','2025-01-01',700000,'${CHU_A}','${CHU_A}');
    INSERT INTO app_private.landlord_operation_terms (building_id, valid_from, manager_percent, landlord_account_ids, created_by)
    VALUES ('${TOA_A}','2025-01-01',30,ARRAY['${SO_CHU_NHA}']::uuid[],'${CHU_A}');
  `);
}, 60000);
afterAll(() => db.close());

describe("công thức quyết toán tháng", () => {
  it("tách đúng ai giữ tiền, % quản lý, phần chủ nhà và số chủ nhà phải trả", async () => {
    const thang = await trongGiaoDich(async () => {
      await asUser(CHU_A);
      return rpc<Json>("public.landlord_settlement_month_v1($1, $2::date)", [TOA_A, "2025-01-01"]);
    });
    const st = thang.statement as Json;
    const t = st.totals as Json;
    expect(thang.status).toBe("OPEN");
    expect(so(t.landlord_collected)).toBe(10_000_000);
    // quản lý thu = sổ quản lý 1tr + cấn cọc (sổ ảo) 400k + phiếu không dòng 100k + phiếu không sổ 50k
    expect(so(t.manager_collected)).toBe(1_550_000);
    expect(so(t.landlord_paid)).toBe(500_000);
    // quản lý chi = 2tr + DEPOSIT bị ép tính KQKD 30k + trả thêm cho khách ngoài cọc khi thanh lý 150k
    expect(so(t.manager_paid)).toBe(2_180_000);
    expect(so(t.revenue)).toBe(11_550_000);
    expect(so(t.expense)).toBe(2_680_000);
    expect(so(t.profit)).toBe(8_870_000);
    expect(so(t.manager_share)).toBe(2_661_000);
    expect(so(t.landlord_share)).toBe(6_209_000);
    // cọc 800k + trả thừa 5k khách chuyển vào sổ chủ nhà
    expect(so(t.landlord_held_deposits)).toBe(805_000);
    expect(so(t.landlord_owes_manager)).toBe(4_096_000);
    // bảo toàn: chủ nhà đang giữ (thu − chi + cọc giữ hộ) − phần chủ nhà được hưởng = số chủ nhà phải trả
    expect(so(t.landlord_collected) - so(t.landlord_paid) + so(t.landlord_held_deposits) - so(t.landlord_share))
      .toBe(so(t.landlord_owes_manager));
    expect(st.deposits).toEqual({ received: 3_805_000, paid_out: 1_250_000, landlord_received: 805_000, landlord_paid_out: 0 });
    expect(st.termination).toEqual({
      revenue_from_deposit: 400_000, forfeit_revenue: 0, extra_receipt: 0, refund_beyond_deposit: 150_000,
      deposit_refunded: 850_000, deposit_offset: 400_000, pending_refund: 0,
    });
    expect(st.pending).toMatchObject({ voucher_count: 2, income: 600_000, expense: 700_000 });
    // không khoản nào biến mất: dòng tắt KQKD (5k) và dòng nội bộ (20k) vẫn hiện ở nhóm "không tính"
    expect(st.excluded).toEqual({ voucher_count: 2, income: 25_000, expense: 0 });
    const ex = (st.vouchers as Json[]).filter((v) => v.group === "EXCLUDED").map((v) => v.excluded_reason).sort();
    expect(ex).toEqual(["INTERNAL", "NOT_KQKD"]);
    const nguon = (st.vouchers as Json[]).map((v) => v.source).filter(Boolean).sort();
    expect(nguon).toEqual(["DEPOSIT_OFFSET", "TERMINATION_REFUND", "TERMINATION_REFUND", "TERMINATION_REVENUE"]);
    expect(thang.can_close).toBe(false);
    expect(thang.close_blockers).toEqual(["PENDING_VOUCHERS"]);
    expect(st.terms_from).toBe("2025-01-01");
    expect(st.foreign_account_voucher_count).toBe(0);
  });

  it("tháng lỗ: phần quản lý 0đ, chủ nhà vẫn hoàn khoản quản lý chi hộ", async () => {
    const t = await trongGiaoDich(async () => {
      await asUser(CHU_A);
      const m = await rpc<Json>("public.landlord_settlement_month_v1($1, $2::date)", [TOA_A, "2025-02-01"]);
      return (m.statement as Json).totals as Json;
    });
    expect(so(t.profit)).toBe(-2_000_000);
    expect(so(t.manager_share)).toBe(0);
    expect(so(t.landlord_share)).toBe(-2_000_000);
    expect(so(t.landlord_owes_manager)).toBe(3_000_000);
  });

  it("tháng trước ngày áp dụng là NOT_APPLICABLE", async () => {
    const m = await trongGiaoDich(async () => {
      await asUser(CHU_A);
      return rpc<Json>("public.landlord_settlement_month_v1($1, $2::date)", [TOA_A, "2024-12-01"]);
    });
    expect(m.status).toBe("NOT_APPLICABLE");
    expect(m.statement).toBeNull();
  });

  it("phiếu duyệt mà bút toán đã đảo: vẫn tính KQKD nhưng chặn chốt; tiền thối vào sổ chủ nhà được bù trừ, làm tròn thì không", async () => {
    const m = await trongGiaoDich(async () => {
      await asUser(CHU_A);
      return rpc<Json>("public.landlord_settlement_month_v1($1, $2::date)", [TOA_A, "2025-03-01"]);
    });
    const st = m.statement as Json;
    const t = st.totals as Json;
    expect(st.reversed_voucher_count).toBe(1);
    expect(m.can_close).toBe(false);
    expect(m.close_blockers).toEqual(["REVERSED_POSTINGS"]);
    expect(so(t.profit)).toBe(150_000);
    expect(so(t.manager_share)).toBe(45_000);
    // chỉ tiền thối 2k; làm tròn 1k là khoản khách trả thiếu được bỏ qua, không phải tiền mặt
    expect(so(t.landlord_extra_cash)).toBe(2_000);
    // 45k + 0 − 50k + 0 + 2k
    expect(so(t.landlord_owes_manager)).toBe(-3_000);
    expect((st.vouchers as Json[]).filter((v) => v.cash_reversed).length).toBe(1);
  });
});

describe("quyền", () => {
  it.each([
    ["nhân viên cùng công ty", NHAN_VIEN_A],
    ["chủ công ty khác", CHU_B],
  ])("%s không xem được (42501)", async (_ten, user) => {
    await trongGiaoDich(async () => {
      await asUser(user);
      await expectLoi("SELECT public.landlord_settlement_month_v1($1, '2025-01-01'::date)", [TOA_A], "42501");
    });
  });

  it("super admin xem được", async () => {
    const m = await trongGiaoDich(async () => {
      await asUser(SUPER);
      return rpc<Json>("public.landlord_settlement_month_v1($1, $2::date)", [TOA_A, "2025-01-01"]);
    });
    expect(m.status).toBe("OPEN");
  });

  it("anon không gọi được RPC quản trị", async () => {
    await trongGiaoDich(async () => {
      await asUser(null);
      await expectLoi("SELECT public.landlord_settlement_month_v1($1, '2025-01-01'::date)", [TOA_A], "42501");
    });
  });

  it("danh sách toà: nhân viên không quản được, chủ công ty A thấy toà A", async () => {
    const [nv, chu] = await trongGiaoDich(async () => {
      await asUser(NHAN_VIEN_A);
      const a = await rpc<Json>("public.landlord_operations_list_v1()");
      await asUser(CHU_A);
      const b = await rpc<Json>("public.landlord_operations_list_v1()");
      return [a, b];
    });
    expect(nv.can_manage).toBe(false);
    expect(nv.operations).toEqual([]);
    expect(chu.can_manage).toBe(true);
    expect((chu.operations as Json[]).map((o) => o.building_id)).toEqual([TOA_A]);
    expect(so((chu.operations as Json[])[0].manager_percent)).toBe(30);
    // toà ảo không phải ứng viên
    expect((chu.candidate_buildings as Json[]).map((o) => o.building_id)).toEqual([TOA_A, TOA_C]);
  });
});

describe("cài đặt toà", () => {
  it.each([
    ["tỷ lệ > 100", 120, [SO_CHU_NHA]],
    ["sổ của công ty khác", 30, [SO_CONG_TY_B]],
    ["không chọn sổ nào", 30, []],
    ["sổ ảo (cấn trừ / làm tròn / tiền thối)", 30, [SO_AO]],
  ])("%s ⇒ 22023", async (_ten, pct, accounts) => {
    await trongGiaoDich(async () => {
      await asUser(CHU_A);
      await expectLoi("SELECT public.landlord_operation_upsert_v1($1, 'Chủ nhà A', $2, '2025-01-01'::date, $3::uuid[], null, true)",
        [TOA_A, pct, accounts], "22023");
    });
  });

  it("sửa cấu hình ghi sổ thay đổi và chuẩn hoá tháng áp dụng về ngày 1", async () => {
    const [kq, opts] = await trongGiaoDich(async () => {
      await asUser(CHU_A);
      const a = await rpc<Json>(
        "public.landlord_operation_upsert_v1($1, 'Chủ nhà A', 25, '2025-01-15'::date, $2::uuid[], 'thoả thuận mới', true)",
        [TOA_A, [SO_CHU_NHA]],
      );
      const b = await rpc<Json>("public.landlord_operation_options_v1($1)", [TOA_A]);
      return [a, b];
    });
    expect(kq).toEqual({ building_id: TOA_A, created: false, terms_from: "2025-01-01", opening_needs_reconfirm: false,
      opening_needs_confirm: true });
    expect((opts.current as Json).effective_from).toBe("2025-01-01");
    expect(so((opts.current as Json).manager_percent)).toBe(25);
    expect((opts.history as Json[]).length).toBe(1);
  });

  it("lưu lại y nguyên không sinh lịch sử; số dư đầu kỳ vào tổng quyết toán; gợi ý cọc ở sổ chủ nhà trước ngày áp dụng", async () => {
    const [h1, h2, opts, ov] = await trongGiaoDich(async () => {
      await asUser(CHU_A);
      const sql = "public.landlord_operation_upsert_v1($1, 'Chủ nhà A', 30, '2025-01-01'::date, $2::uuid[], null, true, 300000)";
      await rpc(sql, [TOA_A, [SO_CHU_NHA]]);
      const a = ((await rpc<Json>("public.landlord_operation_options_v1($1)", [TOA_A])).history as Json[]).length;
      await rpc(sql, [TOA_A, [SO_CHU_NHA]]);
      const o = await rpc<Json>("public.landlord_operation_options_v1($1)", [TOA_A]);
      const b = (o.history as Json[]).length;
      const v = await rpc<Json>("public.landlord_settlement_overview_v1($1)", [TOA_A]);
      return [a, b, o, v];
    });
    expect(h1).toBe(1);
    expect(h2).toBe(1);
    expect(so((opts.current as Json).opening_balance)).toBe(300_000);
    expect(so((opts.current as Json).pre_start_landlord_deposits)).toBe(700_000);
    const t = ov.totals as Json;
    expect(so(t.opening_balance)).toBe(300_000);
    expect(so(t.balance_closed)).toBe(300_000);
  });

  it("số dư đầu kỳ lẻ đồng ⇒ 22023", async () => {
    await trongGiaoDich(async () => {
      await asUser(CHU_A);
      await expectLoi("SELECT public.landlord_operation_upsert_v1($1, 'Chủ nhà A', 30, '2025-01-01'::date, $2::uuid[], null, true, 10.5)",
        [TOA_A, [SO_CHU_NHA]], "22023");
    });
  });
});

describe("chốt tháng", () => {
  it("không chốt được khi còn phiếu chờ duyệt hoặc tháng chưa hết", async () => {
    await trongGiaoDich(async () => {
      await asUser(CHU_A);
      const m = await rpc<Json>("public.landlord_settlement_month_v1($1, $2::date)", [TOA_A, "2025-01-01"]);
      await expectLoi("SELECT public.landlord_settlement_close_v1($1, '2025-01-01'::date, $2, null)", [TOA_A, m.live_hash], "55000");
    });
    await trongGiaoDich(async () => {
      await asUser(CHU_A);
      await expectLoi("SELECT public.landlord_settlement_close_v1($1, date_trunc('month', now())::date, 'x', null)", [TOA_A], "55000");
    });
  });

  it("chốt có CAS, chụp số, báo phiếu đổi sau chốt, mở chốt có lý do rồi chốt lại", async () => {
    await trongGiaoDich(async () => {
      await asUser(CHU_A);
      const m = await rpc<Json>("public.landlord_settlement_month_v1($1, $2::date)", [TOA_A, "2025-02-01"]);
      expect(m.can_close).toBe(true);
      const h1 = String(m.live_hash);
      expect(await rpc<Json>("public.landlord_settlement_close_v1($1, '2025-02-01'::date, $2, null)", [TOA_A, h1]))
        .toEqual({ status: "CLOSED", revision: 1 });
      expect(await rpc<Json>("public.landlord_settlement_close_v1($1, '2025-02-01'::date, $2, null)", [TOA_A, h1]))
        .toEqual({ status: "ALREADY_CLOSED", revision: 1 });

      // phiếu của tháng đã chốt bị sửa
      await asPostgres();
      await db.query("UPDATE public.income_expense_items SET amount = 2500000 WHERE income_expense_id = $1", [PHIEU_LO_CHI]);
      await asUser(CHU_A);
      const sauSua = await rpc<Json>("public.landlord_settlement_month_v1($1, $2::date)", [TOA_A, "2025-02-01"]);
      expect(sauSua.status).toBe("CLOSED");
      expect(sauSua.is_stale).toBe(true);
      // vẫn hiện số LÚC CHỐT
      expect(so(((sauSua.statement as Json).totals as Json).landlord_owes_manager)).toBe(3_000_000);
      await expectLoi("SELECT public.landlord_settlement_close_v1($1, '2025-02-01'::date, $2, null)", [TOA_A, sauSua.live_hash], "55000");

      await expectLoi("SELECT public.landlord_settlement_reopen_v1($1, '2025-02-01'::date, 'ngắn')", [TOA_A], "22023");
      expect(await rpc<Json>("public.landlord_settlement_reopen_v1($1, '2025-02-01'::date, 'sửa phiếu chi tháng 2')", [TOA_A]))
        .toEqual({ status: "REOPENED", revision: 2 });
      await expectLoi("SELECT public.landlord_settlement_close_v1($1, '2025-02-01'::date, $2, null)", [TOA_A, h1], "40001");
      expect(await rpc<Json>("public.landlord_settlement_close_v1($1, '2025-02-01'::date, $2, 'chốt lại')", [TOA_A, sauSua.live_hash]))
        .toEqual({ status: "CLOSED", revision: 3 });
      const daChot = await rpc<Json>("public.landlord_settlement_month_v1($1, $2::date)", [TOA_A, "2025-02-01"]);
      expect(daChot.is_stale).toBe(false);
      expect(so(((daChot.statement as Json).totals as Json).landlord_owes_manager)).toBe(2_500_000);
      expect((daChot.closed as Json).closed_by_name).toBe("Chủ A");
    });
  });
});

describe("thanh toán và số còn lại", () => {
  it("ghi, chống bấm trùng, huỷ có lý do; còn lại = tháng đã chốt − đã trả", async () => {
    await trongGiaoDich(async () => {
      await asUser(CHU_A);
      const m = await rpc<Json>("public.landlord_settlement_month_v1($1, $2::date)", [TOA_A, "2025-02-01"]);
      await rpc("public.landlord_settlement_close_v1($1, '2025-02-01'::date, $2, null)", [TOA_A, m.live_hash]);

      const p1 = await rpc<Json>(
        "public.landlord_settlement_add_payment_v1($1, '2025-03-05'::date, 'LANDLORD_TO_MANAGER', 1000000, 'chuyển khoản', 'khoa-thu-0001')", [TOA_A]);
      expect(p1.status).toBe("CREATED");
      expect(await rpc<Json>(
        "public.landlord_settlement_add_payment_v1($1, '2025-03-05'::date, 'LANDLORD_TO_MANAGER', 1000000, 'chuyển khoản', 'khoa-thu-0001')", [TOA_A]))
        .toEqual({ id: p1.id, status: "REPLAYED" });
      await expectLoi("SELECT public.landlord_settlement_add_payment_v1($1, '2025-03-05'::date, 'LANDLORD_TO_MANAGER', 2000000, 'chuyển khoản', 'khoa-thu-0001')", [TOA_A], "23505");
      await expectLoi("SELECT public.landlord_settlement_add_payment_v1($1, '2025-03-05'::date, 'LANDLORD_TO_MANAGER', 1000.5, null, 'khoa-thu-0002')", [TOA_A], "22023");
      const p2 = await rpc<Json>(
        "public.landlord_settlement_add_payment_v1($1, '2025-03-06'::date, 'MANAGER_TO_LANDLORD', 200000, null, 'khoa-thu-0003')", [TOA_A]);

      const ov = await rpc<Json>("public.landlord_settlement_overview_v1($1)", [TOA_A]);
      const t = ov.totals as Json;
      expect(so(t.closed_net)).toBe(3_000_000);
      expect(so(t.paid_by_landlord)).toBe(1_000_000);
      expect(so(t.paid_by_manager)).toBe(200_000);
      expect(so(t.balance_closed)).toBe(2_200_000);
      // tháng 01 (4.096.000) và 03 (−3.000) còn mở: cộng vào số "gồm cả tạm tính"
      expect(so(t.balance_with_open)).toBe(2_200_000 + 4_096_000 - 3_000);
      expect(t.closed_month_count).toBe(1);

      expect(await rpc<Json>("public.landlord_settlement_void_payment_v1($1, 'ghi nhầm chiều tiền')", [p2.id]))
        .toEqual({ id: p2.id, status: "VOIDED" });
      const sauHuy = await rpc<Json>("public.landlord_settlement_overview_v1($1)", [TOA_A]);
      expect(so((sauHuy.totals as Json).balance_closed)).toBe(2_000_000);
      expect((sauHuy.payments as Json[]).find((p) => p.id === p2.id)?.voided).toBe(true);
    });
  });
});

describe("link công khai cho chủ nhà", () => {
  it("anon đọc được qua token, không lộ id; token thu hồi/sai trả NULL", async () => {
    await trongGiaoDich(async () => {
      await asUser(CHU_A);
      const { token } = await rpc<{ token: string }>("public.landlord_share_link_create_v1($1, 'Zalo')", [TOA_A]);
      expect(token).toMatch(/^[A-Za-z0-9_-]{32}$/);

      await asUser(null);
      const pub = await rpc<Json>("public.landlord_settlement_public_v1($1, '2025-01-01'::date)", [token]);
      const month = pub.month as Json;
      const st = month.statement as Json;
      expect(so((st.totals as Json).landlord_owes_manager)).toBe(4_096_000);
      expect((st.vouchers as Json[]).length).toBeGreaterThan(0);
      expect((st.vouchers as Json[]).every((v) => !("id" in v))).toBe(true);
      // không lộ tên sổ của nhân viên: chỉ nói tiền ở bên nào
      expect(new Set((st.vouchers as Json[]).map((v) => v.account_name)))
        .toEqual(new Set(["Sổ chủ nhà", "Sổ quản lý", "Cấn trừ cọc (nội bộ)"]));
      expect((st.vouchers as Json[]).find((v) => v.code === PHIEU_HAN_CHE_MA)?.name).toBe("Khoản hạn chế (ẩn chi tiết)");
      expect(month.warnings).toBeNull();
      expect(month.kqkd_bridge).toBeNull();
      expect(month.close_blockers).toEqual([]);
      expect("building_id" in st).toBe(false);
      expect(month.live_hash).toBeNull();
      expect(month.can_close).toBe(false);
      expect(((pub.overview as Json).payments as Json[]).every((p) => !("id" in p))).toBe(true);
      expect(await rpc("public.landlord_settlement_public_v1('khong-phai-token', null)")).toBeNull();

      await asUser(CHU_A);
      expect(await rpc<Json>("public.landlord_share_link_revoke_v1($1)", [token])).toEqual({ status: "REVOKED" });
      await asUser(null);
      expect(await rpc("public.landlord_settlement_public_v1($1, null)", [token])).toBeNull();
    });
  });

  it("toà ngừng áp dụng thì link trả NULL", async () => {
    await trongGiaoDich(async () => {
      await asUser(CHU_A);
      const { token } = await rpc<{ token: string }>("public.landlord_share_link_create_v1($1, null)", [TOA_A]);
      await rpc("public.landlord_operation_upsert_v1($1, 'Chủ nhà A', 30, '2025-01-01'::date, $2::uuid[], null, false)", [TOA_A, [SO_CHU_NHA]]);
      await asUser(null);
      expect(await rpc("public.landlord_settlement_public_v1($1, null)", [token])).toBeNull();
    });
  });

  it("huỷ thanh toán / thu hồi link: người ngoài không phân biệt được id/token có tồn tại hay không", async () => {
    await trongGiaoDich(async () => {
      await asUser(CHU_A);
      const p = await rpc<Json>(
        "public.landlord_settlement_add_payment_v1($1, '2025-03-05'::date, 'LANDLORD_TO_MANAGER', 1000, null, 'khoa-do-0001')", [TOA_A]);
      const { token } = await rpc<{ token: string }>("public.landlord_share_link_create_v1($1, null)", [TOA_A]);
      await asUser(CHU_B);
      await expectLoi("SELECT public.landlord_settlement_void_payment_v1($1, 'thử huỷ của người khác')", [p.id], "42501");
      await expectLoi("SELECT public.landlord_settlement_void_payment_v1($1, 'thử huỷ của người khác')", [id(999)], "42501");
      await expectLoi("SELECT public.landlord_share_link_revoke_v1($1)", [token], "42501");
      await expectLoi("SELECT public.landlord_share_link_revoke_v1($1)", ["khong-co-token-nay-0123456789abcdef"], "42501");
    });
  });
});

const thang = (toa: string, m: string) => rpc<Json>("public.landlord_settlement_month_v1($1, $2::date)", [toa, m]);
const UPSERT_A = "public.landlord_operation_upsert_v1($1, 'Chủ nhà A', $2, $3::date, $4::uuid[], null, true, $5, $6, $7::date, $8)";
/** Cài toà A qua RPC: % · tháng áp dụng · số dư đầu kỳ · đã xác nhận · áp % từ tháng. */
const caiToaA = (pct: number, tu: string, soDu = 0, xacNhan = true, apTu: string | null = null, daThay: number | null = 700_000) =>
  rpc<Json>(UPSERT_A, [TOA_A, pct, tu, [SO_CHU_NHA], soDu, xacNhan, apTu, daThay]);
async function chot(m: string) {
  const x = await thang(TOA_A, m);
  return rpc<Json>("public.landlord_settlement_close_v1($1, $2::date, $3, null)", [TOA_A, m, x.live_hash]);
}

describe("điều khoản theo tháng, tháng áp dụng, số dư đầu kỳ", () => {
  it("đổi % sau khi chốt: tháng đã chốt giữ % cũ, % mới áp từ tháng sau tháng chốt; không đổi được từ tháng đã chốt", async () => {
    await trongGiaoDich(async () => {
      await asUser(CHU_A);
      expect((await chot("2025-02-01")).status).toBe("CLOSED");
      const kq = await caiToaA(40, "2025-01-01");
      expect(upsertReceiptSchema.parse(kq).terms_from).toBe("2025-03-01");

      const feb = await thang(TOA_A, "2025-02-01");
      expect(feb.is_stale).toBe(false);
      expect(so((feb.statement as Json).manager_percent)).toBe(30);
      const jan = await thang(TOA_A, "2025-01-01");
      expect(so((jan.statement as Json).manager_percent)).toBe(30);
      const mar = (await thang(TOA_A, "2025-03-01")).statement as Json;
      expect(so(mar.manager_percent)).toBe(40);
      expect(mar.terms_from).toBe("2025-03-01");
      expect(so((mar.totals as Json).manager_share)).toBe(60_000); // 150k × 40%

      await expectLoi(`SELECT ${UPSERT_A}`, [TOA_A, 50, "2025-01-01", [SO_CHU_NHA], 0, true, "2025-02-01", 700_000], "55000");
      await expectLoi(`SELECT ${UPSERT_A}`, [TOA_A, 50, "2025-01-01", [SO_CHU_NHA], 0, true, "2025-01-01", 700_000], "55000");
      // từ một tháng chưa chốt về sau thì được; trùng điều khoản ngay trước thì gộp
      expect((await caiToaA(30, "2025-01-01", 0, true, "2025-04-01")).terms_from).toBe("2025-04-01");

      const ov = settlementOverviewSchema.parse(await rpc("public.landlord_settlement_overview_v1($1)", [TOA_A]));
      expect(ov.months.slice(0, 4).map((x) => x.manager_percent)).toEqual([30, 30, 40, 30]);
      expect(ov.manager_percent).toBe(30);
      const opts = landlordOperationOptionsSchema.parse(await rpc("public.landlord_operation_options_v1($1)", [TOA_A]));
      expect(opts.current?.terms.map((x) => [x.valid_from, x.manager_percent]))
        .toEqual([["2025-01-01", 30], ["2025-03-01", 40], ["2025-04-01", 30]]);
      expect(opts.current?.last_closed_month).toBe("2025-02-01");
      expect(opts.current?.next_terms_month).toBe("2025-03-01");
      // lịch sử ghi đủ điều khoản trước/sau
      const h = opts.history[0];
      expect(Array.isArray(h.after.terms)).toBe(true);
    });
  });

  it("dời tháng bắt đầu ra sau tháng đã chốt bị chặn; dời về trước thì mở thêm tháng và điều khoản đầu tiên theo về", async () => {
    await trongGiaoDich(async () => {
      await asUser(CHU_A);
      await chot("2025-02-01");
      await expectLoi(`SELECT ${UPSERT_A}`, [TOA_A, 30, "2025-03-01", [SO_CHU_NHA], 0, true, null, 700_000], "55000");
      // 01 → 02: tháng 02 đã chốt vẫn trong thời gian áp dụng
      await caiToaA(30, "2025-02-01");
      expect((await thang(TOA_A, "2025-01-01")).status).toBe("NOT_APPLICABLE");
      const feb = await thang(TOA_A, "2025-02-01");
      expect([feb.status, feb.is_stale]).toEqual(["CLOSED", false]);
      // về 12/2024: tháng 12 mở ra; cọc 700k khách chuyển vào sổ chủ nhà nay nằm TRONG kỳ
      await caiToaA(30, "2024-12-01");
      const dec = await thang(TOA_A, "2024-12-01");
      expect(dec.status).toBe("OPEN");
      expect(so(((dec.statement as Json).totals as Json).landlord_held_deposits)).toBe(700_000);
      const opts = landlordOperationOptionsSchema.parse(await rpc("public.landlord_operation_options_v1($1)", [TOA_A]));
      expect(opts.current?.terms.map((x) => x.valid_from)).toEqual(["2024-12-01"]);
      expect(opts.current?.pre_start_landlord_deposits).toBe(0);
      expect((await thang(TOA_A, "2025-02-01")).is_stale).toBe(false);
    });
  });

  it("số dư đầu kỳ chưa xác nhận chặn chốt; xác nhận rồi mới chốt; đổi số thì phải xác nhận lại", async () => {
    await trongGiaoDich(async () => {
      await asUser(CHU_A);
      await caiToaA(30, "2025-01-01", 300_000, false);
      const feb = await thang(TOA_A, "2025-02-01");
      expect(feb.close_blockers).toEqual(["OPENING_UNCONFIRMED"]);
      expect(feb.can_close).toBe(false);
      await expectLoi("SELECT public.landlord_settlement_close_v1($1, '2025-02-01'::date, $2, null)", [TOA_A, feb.live_hash], "55000");

      await caiToaA(30, "2025-01-01", 300_000, true);
      const daXacNhan = landlordOperationOptionsSchema.parse(await rpc("public.landlord_operation_options_v1($1)", [TOA_A]));
      expect(daXacNhan.current?.opening_confirmed_at).not.toBeNull();
      expect((await thang(TOA_A, "2025-02-01")).can_close).toBe(true);
      expect((await chot("2025-02-01")).status).toBe("CLOSED");

      // lưu lại cùng số, vẫn tick: giữ nguyên dấu xác nhận cũ
      await caiToaA(30, "2025-01-01", 300_000, true);
      const giuNguyen = landlordOperationOptionsSchema.parse(await rpc("public.landlord_operation_options_v1($1)", [TOA_A]));
      expect(giuNguyen.current?.opening_confirmed_at).toBe(daXacNhan.current?.opening_confirmed_at);

      // đổi số mà vẫn tick: là một lần xác nhận MỚI (dấu thời gian mới), không mượn dấu cũ
      await caiToaA(30, "2025-01-01", 350_000, true);
      const xacNhanLai = landlordOperationOptionsSchema.parse(await rpc("public.landlord_operation_options_v1($1)", [TOA_A]));
      expect(xacNhanLai.current?.opening_confirmed_at).not.toBeNull();
      expect(xacNhanLai.current?.opening_confirmed_at).not.toBe(daXacNhan.current?.opening_confirmed_at);

      await caiToaA(30, "2025-01-01", 400_000, false);
      const ov = settlementOverviewSchema.parse(await rpc("public.landlord_settlement_overview_v1($1)", [TOA_A]));
      expect(ov.opening_confirmed).toBe(false);
      expect(ov.totals.opening_balance).toBe(400_000);
    });
  });

  it("phiếu chờ duyệt ghi ngày trước tháng áp dụng chặn chốt tháng đầu tiên (chỉ tháng đầu)", async () => {
    await trongGiaoDich(async () => {
      await asPostgres();
      await phieu({ loai: "EXPENSE", so: SO_QUAN_LY, thang: "2024-12-15", trangThai: "UNAPPROVED", dong: [{ lop: "PNL", tien: 90_000 }] });
      await asUser(CHU_A);
      const jan = settlementMonthSchema.parse(await thang(TOA_A, "2025-01-01"));
      expect(jan.close_blockers).toContain("PRE_START_PENDING");
      expect(jan.warnings?.pre_start_pending).toMatchObject({ voucher_count: 1, income: 0, expense: 90_000 });
      const feb = settlementMonthSchema.parse(await thang(TOA_A, "2025-02-01"));
      expect(feb.close_blockers).toEqual([]);
      expect(feb.warnings?.pre_start_pending).toBeNull();
    });
  });
});

describe("cảnh báo và đối chiếu", () => {
  it("phiếu dùng sổ chủ nhà của toà vận hành khác: đánh dấu, chặn chốt", async () => {
    await trongGiaoDich(async () => {
      await asUser(CHU_A);
      await rpc("public.landlord_operation_upsert_v1($1, 'Chủ nhà C', 20, '2025-06-01'::date, $2::uuid[], null, true)",
        [TOA_C, [SO_CHU_NHA_C]]);
      await asPostgres();
      await phieu({ loai: "EXPENSE", so: SO_CHU_NHA_C, thang: "2025-02-10", dong: [{ lop: "PNL", tien: 100_000 }] });
      await asUser(CHU_A);
      const feb = settlementMonthSchema.parse(await thang(TOA_A, "2025-02-01"));
      expect(feb.statement?.foreign_account_voucher_count).toBe(1);
      expect(feb.statement?.vouchers.filter((v) => v.foreign_landlord_account).map((v) => v.amount)).toEqual([100_000]);
      expect(feb.close_blockers).toEqual(["FOREIGN_LANDLORD_ACCOUNT"]);
      await expectLoi("SELECT public.landlord_settlement_close_v1($1, '2025-02-01'::date, $2, null)", [TOA_A, feb.live_hash], "55000");
    });
  });

  it("khoản chi cố định chưa có phiếu; phiếu ở toà khác có nhắc mã toà", async () => {
    await trongGiaoDich(async () => {
      await asUser(CHU_A);
      // toà A khai điện (chưa có phiếu), tiền nhà "không áp dụng"; nước chưa khai vẫn phải có
      expect((await thang(TOA_A, "2025-01-01") as { warnings: Json }).warnings.missing_fixed_expenses).toEqual(["dien", "nuoc"]);
      await asPostgres();
      await phieu({ loai: "EXPENSE", so: SO_QUAN_LY, thang: "2025-01-21", trangThai: "UNAPPROVED", loaiHangMuc: LOAI_TU_LANH,
        ten: "Mua tủ lạnh", dong: [{ lop: "PNL", tien: 3_900_000 }] });
      await asUser(CHU_A);
      expect((await thang(TOA_A, "2025-01-01") as { warnings: Json }).warnings.missing_fixed_expenses).toEqual(["dien", "nuoc"]);
      await asPostgres();
      await phieu({ loai: "EXPENSE", so: SO_QUAN_LY, thang: "2025-02-05", loaiHangMuc: LOAI_DIEN, dong: [{ lop: "PNL", tien: 400_000 }] });
      await phieu({ toa: TOA_AO, loai: "EXPENSE", so: SO_QUAN_LY, thang: "2025-02-06", ten: "in decal 44 TA cho khách",
        dong: [{ lop: "PNL", tien: 50_000 }] });
      await phieu({ toa: TOA_AO, loai: "EXPENSE", so: SO_QUAN_LY, thang: "2025-02-07", ten: "đồ cho nhà 144TA",
        dong: [{ lop: "PNL", tien: 60_000 }] });
      // bàn giao tiền mặt (tắt KQKD) nhắc tên toà: không làm sai lợi nhuận ⇒ không báo
      await phieu({ toa: TOA_AO, loai: "EXPENSE", so: SO_QUAN_LY, thang: "2025-02-08", kqkd: false, ten: "Bàn giao tiền 44TA",
        dong: [{ lop: "PNL", tien: 70_000 }] });
      await asUser(CHU_A);
      const feb = settlementMonthSchema.parse(await thang(TOA_A, "2025-02-01"));
      expect(feb.warnings?.missing_fixed_expenses).toEqual(["nuoc"]);
      expect(feb.warnings?.related_elsewhere.voucher_count).toBe(1);
      expect(feb.warnings?.related_elsewhere.vouchers[0]).toMatchObject({ building_name: "Kho chung", amount: 50_000 });
      // đánh dấu nước "không áp dụng" ⇒ không đòi nữa
      await asPostgres();
      await db.query("INSERT INTO public.building_fee_accounts(building_id, fee_category, not_applicable) VALUES ($1, 'nuoc', true)", [TOA_A]);
      await asUser(CHU_A);
      expect(settlementMonthSchema.parse(await thang(TOA_A, "2025-02-01")).warnings?.missing_fixed_expenses).toEqual([]);
    });
  });

  it("theo kỳ: tiền phòng hoá đơn tháng 02 thu sớm ngày 28/01 vào ĐÚNG tháng 02 (như Báo cáo LN); đối chiếu khớp từng đồng", async () => {
    await trongGiaoDich(async () => {
      await asUser(CHU_A);
      const jan0 = settlementMonthSchema.parse(await thang(TOA_A, "2025-01-01"));
      expect(jan0.kqkd_bridge).toEqual({ kqkd_profit: 8_870_000, settlement_profit: 8_870_000, rows: [] });

      await asPostgres();
      await db.query("INSERT INTO public.invoices(id, billing_month) VALUES ($1, '2025-02')", [id(901)]);
      await phieu({ loai: "INCOME", so: SO_CHU_NHA, thang: "2025-01-28", hoaDon: id(901), ten: "Tiền phòng T2 thu sớm",
        dong: [{ lop: "PNL", tien: 500_000 }] });
      await asUser(CHU_A);
      const jan = settlementMonthSchema.parse(await thang(TOA_A, "2025-01-01"));
      const feb = settlementMonthSchema.parse(await thang(TOA_A, "2025-02-01"));
      // tháng 01 không đổi; tháng 02 có thêm 500k chủ nhà thu (lập ngày 28/01)
      expect(jan.statement!.totals.profit).toBe(8_870_000);
      expect(jan.statement!.vouchers.some((v) => v.name === "Tiền phòng T2 thu sớm")).toBe(false);
      expect(feb.statement!.totals.landlord_collected).toBe(1_500_000);
      expect(feb.statement!.totals.profit).toBe(-1_500_000);
      expect(feb.statement!.vouchers.find((v) => v.name === "Tiền phòng T2 thu sớm"))
        .toMatchObject({ voucher_date: "2025-01-28", side: "LANDLORD", group: "PNL", amount: 500_000 });
      for (const m of [jan, feb]) {
        expect(m.kqkd_bridge?.rows).toEqual([]);
        expect(m.kqkd_bridge?.settlement_profit).toBe(m.statement!.totals.profit);
        expect(m.kqkd_bridge?.kqkd_profit).toBe(m.statement!.totals.profit);
      }
    });
  });

  it("theo kỳ: kỳ dịch vụ 2 tháng chia đều 2 tháng; phiếu sửa sau khi chốt ⇒ 'đổi sau khi chốt'", async () => {
    await trongGiaoDich(async () => {
      await asPostgres();
      // trả trong tháng 01 cho kỳ dịch vụ 01/02–31/03 (2 tháng)
      await phieu({ loai: "EXPENSE", so: SO_QUAN_LY, thang: "2025-01-25", ten: "Dịch vụ quý",
        dong: [{ lop: "PNL", tien: 120_000, tu: "2025-02-01", den: "2025-03-31" }] });
      await asUser(CHU_A);
      const [jan, feb, mar] = await Promise.all(["2025-01-01", "2025-02-01", "2025-03-01"]
        .map(async (m) => settlementMonthSchema.parse(await thang(TOA_A, m))));
      expect(jan.statement!.vouchers.some((v) => v.name === "Dịch vụ quý")).toBe(false);
      expect(feb.statement!.vouchers.find((v) => v.name === "Dịch vụ quý")?.amount).toBe(60_000);
      expect(mar.statement!.vouchers.find((v) => v.name === "Dịch vụ quý")?.amount).toBe(60_000);
      expect(feb.statement!.totals.manager_paid).toBe(3_060_000);
      for (const m of [jan, feb, mar]) expect(m.kqkd_bridge?.rows).toEqual([]);
      // tháng 02 đã chốt, sau đó phiếu chi của tháng bị sửa ⇒ "đổi sau khi chốt"
      await chot("2025-02-01");
      await asPostgres();
      await db.query("UPDATE public.income_expense_items SET amount = 2500000 WHERE income_expense_id = $1", [PHIEU_LO_CHI]);
      await asUser(CHU_A);
      const feb2 = settlementMonthSchema.parse(await thang(TOA_A, "2025-02-01"));
      expect(feb2.is_stale).toBe(true);
      expect(feb2.kqkd_bridge?.rows.map((r) => [r.reason, r.settlement_amount, r.kqkd_amount]))
        .toEqual([["CHANGED_AFTER_CLOSE", -3_000_000, -2_500_000]]);
    });
  });

  it("bản chép luật kỳ (landlord_kqkd_lines_v1) khớp TỪNG ĐỒNG với định nghĩa sống của fa_accrual_allocations", async () => {
    await trongGiaoDich(async () => {
      await asPostgres();
      // đủ mọi nhánh xếp tháng: hoá đơn, hoá đơn không dòng, kỳ chia lẻ nhiều tháng, kỳ ngược, không kỳ,
      // phiếu không dòng, ép KQKD, hạng mục không tồn tại, phiếu chờ duyệt (chỉ bản chép có)
      await db.query("INSERT INTO public.invoices(id, billing_month) VALUES ($1, '2025-03'), ($2, '2025-04')", [id(911), id(912)]);
      await phieu({ loai: "INCOME", so: SO_CHU_NHA, thang: "2025-02-27", hoaDon: id(911), dong: [{ lop: "PNL", tien: 333_333 }, { lop: "DEPOSIT", tien: 1_000 }] });
      await phieu({ loai: "INCOME", so: SO_QUAN_LY, thang: "2025-03-02", hoaDon: id(912), tong: 70_000 });
      await phieu({ loai: "EXPENSE", so: SO_QUAN_LY, thang: "2025-01-03", dong: [{ lop: "PNL", tien: 100_001, tu: "2025-01-15", den: "2025-04-02" }] });
      await phieu({ loai: "EXPENSE", so: SO_QUAN_LY, thang: "2025-02-03", dong: [{ lop: "PNL", tien: 40_000, tu: "2025-03-20", den: "2025-03-01" }] });
      await phieu({ loai: "INCOME", so: SO_CHU_NHA, thang: "2025-03-09", kqkd: true, dong: [{ lop: "DEPOSIT", tien: 9_000, tu: "2025-03-01" }] });
      await phieu({ loai: "EXPENSE", so: SO_QUAN_LY, thang: "2025-03-10", loaiHangMuc: id(399), dong: [{ lop: "PNL", tien: 7_000 }] });
      await phieu({ loai: "EXPENSE", so: SO_QUAN_LY, thang: "2025-03-11", trangThai: "UNAPPROVED", dong: [{ lop: "PNL", tien: 8_000, tu: "2025-03-01", den: "2025-04-30" }] });
      await db.query("INSERT INTO public.super_admins VALUES ($1) ON CONFLICT DO NOTHING", [SUPER]);
      await asUser(SUPER);
      const canon = await db.query<{ k: string; s: string }>(
        `SELECT a.month || '|' || a.voucher_id || '|' || upper(a.side) AS k, sum(a.amount)::text AS s
           FROM public.fa_accrual_allocations('2024-12-01'::date, '2025-05-01'::date, ARRAY[$1]::uuid[]) a
          GROUP BY 1 ORDER BY 1`, [TOA_A]);
      await asPostgres();
      const ban = await db.query<{ k: string; s: string }>(
        `SELECT l.month || '|' || l.voucher_id || '|' || upper(l.side) AS k, sum(l.amount)::text AS s
           FROM app_private.landlord_kqkd_lines_v1($1, '2024-12-01'::date, '2025-05-01'::date) l
          WHERE l.approval_status = 'APPROVED'
          GROUP BY 1 ORDER BY 1`, [TOA_A]);
      expect(canon.rows.length).toBeGreaterThan(20);
      expect(ban.rows.map((r) => [r.k, Number(r.s)])).toEqual(canon.rows.map((r) => [r.k, Number(r.s)]));
      // phiếu chờ duyệt chỉ có ở bản chép, chia 2 tháng 4k + 4k
      const cho = await db.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM app_private.landlord_kqkd_lines_v1($1, '2025-03-01'::date, '2025-04-01'::date) l
          WHERE l.approval_status = 'UNAPPROVED' AND l.amount = 4000`, [TOA_A]);
      expect(Number(cho.rows[0].n)).toBe(2);
    });
  });

  it("khoản lãi lỗ có kỳ trước tháng áp dụng (phiếu lập sau): cảnh báo ở tháng đầu, không tính, không chặn chốt", async () => {
    await trongGiaoDich(async () => {
      await asPostgres();
      await phieu({ loai: "EXPENSE", so: SO_CHU_NHA, thang: "2025-01-04", ten: "Điện tháng 12 trả muộn",
        dong: [{ lop: "PNL", tien: 450_000, tu: "2024-12-01", den: "2024-12-31" }] });
      await asUser(CHU_A);
      const jan = settlementMonthSchema.parse(await thang(TOA_A, "2025-01-01"));
      expect(jan.statement!.totals.profit).toBe(8_870_000);
      expect(jan.warnings?.pre_start_period).toMatchObject({ voucher_count: 1, expense: 450_000 });
      expect(jan.warnings?.pre_start_period?.vouchers[0]).toMatchObject({ name: "Điện tháng 12 trả muộn", amount: 450_000 });
      expect(jan.close_blockers).not.toContain("PRE_START_PENDING");
      const feb = settlementMonthSchema.parse(await thang(TOA_A, "2025-02-01"));
      expect(feb.warnings?.pre_start_period).toBeNull();
    });
  });

  it("phần chủ nhà cho Báo cáo LN: đúng số từng tháng (chốt lấy số đã chốt), chỉ toà người gọi xem được", async () => {
    await trongGiaoDich(async () => {
      await asUser(CHU_A);
      await chot("2025-02-01");
      // sau khi chốt, phiếu tháng 02 bị sửa: phần chủ nhà vẫn lấy SỐ ĐÃ CHỐT, không lấy số sống
      await asPostgres();
      await db.query("UPDATE public.income_expense_items SET amount = 2500000 WHERE income_expense_id = $1", [PHIEU_LO_CHI]);
      await asUser(CHU_A);
      const rows = await rpc<Json[]>("public.landlord_ihome_profit_v1($1::date, $2::date)", ["2024-11-01", "2025-03-01"]);
      // trước tháng áp dụng (01/2025) không có dòng: cả lợi nhuận là của iHome
      expect(rows.map((r) => [r.period_month, r.status])).toEqual([
        ["2025-01-01", "OPEN"], ["2025-02-01", "CLOSED"], ["2025-03-01", "OPEN"]]);
      expect(rows.every((r) => r.building_id === TOA_A)).toBe(true);
      expect([so(rows[0].profit), so(rows[0].manager_share), so(rows[0].landlord_share)]).toEqual([8_870_000, 2_661_000, 6_209_000]);
      expect([so(rows[1].profit), so(rows[1].manager_share), so(rows[1].landlord_share)]).toEqual([-2_000_000, 0, -2_000_000]);
      for (const r of rows) {
        const m = settlementMonthSchema.parse(await thang(TOA_A, String(r.period_month)));
        expect([r.status, so(r.profit), so(r.manager_share), so(r.landlord_share)]).toEqual(
          [m.status, m.statement!.totals.profit, m.statement!.totals.manager_share, m.statement!.totals.landlord_share]);
      }
      // công ty khác: không thấy toà nào; anon: không có quyền gọi
      await asUser(CHU_B);
      expect(await rpc<Json[]>("public.landlord_ihome_profit_v1($1::date, $2::date)", ["2025-01-01", "2025-03-01"])).toEqual([]);
      await asUser(null);
      await expectLoi("SELECT public.landlord_ihome_profit_v1('2025-01-01'::date, '2025-03-01'::date)", [], "42501");
    });
  });

  it("phiếu đã duyệt nhưng chưa ghi sổ quỹ (UNPOSTED): đánh dấu và chặn chốt", async () => {
    await trongGiaoDich(async () => {
      await asPostgres();
      await phieu({ loai: "EXPENSE", so: SO_QUAN_LY, thang: "2025-02-15", butToan: "UNPOSTED", dong: [{ lop: "PNL", tien: 300_000 }] });
      await asUser(CHU_A);
      const feb = settlementMonthSchema.parse(await thang(TOA_A, "2025-02-01"));
      expect(feb.statement?.unposted_voucher_count).toBe(1);
      expect(feb.statement?.vouchers.filter((v) => v.cash_unposted).map((v) => v.amount)).toEqual([300_000]);
      expect(feb.close_blockers).toEqual(["UNPOSTED_POSTINGS"]);
      await expectLoi("SELECT public.landlord_settlement_close_v1($1, '2025-02-01'::date, $2, null)", [TOA_A, feb.live_hash], "55000");
    });
  });

  it("duyệt cọc giữ chỗ ở sổ QUẢN LÝ sau khi chốt không làm tháng 'đã đổi'; cọc ở sổ chủ nhà chờ duyệt thì chặn chốt", async () => {
    await trongGiaoDich(async () => {
      await asPostgres();
      const cocQl = await phieu({ loai: "INCOME", so: SO_QUAN_LY, thang: "2025-02-12", trangThai: "UNAPPROVED",
        dong: [{ lop: "DEPOSIT", tien: 2_000_000 }] });
      await asUser(CHU_A);
      expect((await chot("2025-02-01")).status).toBe("CLOSED");
      await asPostgres();
      await db.query("UPDATE public.income_expenses SET approval_status = 'APPROVED' WHERE id = $1", [cocQl]);
      await asUser(CHU_A);
      expect((await thang(TOA_A, "2025-02-01")).is_stale).toBe(false);
      await rpc("public.landlord_settlement_reopen_v1($1, '2025-02-01'::date, 'thử cọc sổ chủ nhà')", [TOA_A]);
      await asPostgres();
      await phieu({ loai: "INCOME", so: SO_CHU_NHA, thang: "2025-02-13", trangThai: "UNAPPROVED", dong: [{ lop: "DEPOSIT", tien: 900_000 }] });
      await asUser(CHU_A);
      const feb = settlementMonthSchema.parse(await thang(TOA_A, "2025-02-01"));
      expect(feb.close_blockers).toEqual(["PENDING_VOUCHERS"]);
      expect(feb.statement?.pending).toMatchObject({ voucher_count: 1, income: 0, expense: 0, landlord_deposit: 900_000 });
    });
  });

  it("phiếu toà khác ghi vào sổ chủ nhà của toà này: chặn chốt; trừ toà vận hành khác cũng khai sổ đó", async () => {
    await trongGiaoDich(async () => {
      await asUser(CHU_A);
      // toà C (cùng chủ nhà) khai chung sổ chủ nhà với toà A
      await rpc("public.landlord_operation_upsert_v1($1, 'Chủ nhà C', 20, '2025-01-01'::date, $2::uuid[], null, true)",
        [TOA_C, [SO_CHU_NHA]]);
      await asPostgres();
      await phieu({ toa: TOA_C, loai: "INCOME", so: SO_CHU_NHA, thang: "2025-02-09", dong: [{ lop: "PNL", tien: 800_000 }] });
      await asUser(CHU_A);
      expect(settlementMonthSchema.parse(await thang(TOA_A, "2025-02-01")).close_blockers).toEqual([]);
      await asPostgres();
      await phieu({ toa: TOA_AO, loai: "EXPENSE", so: SO_CHU_NHA, thang: "2025-02-11", ten: "Mua đồ kho", dong: [{ lop: "PNL", tien: 2_000_000 }] });
      await asUser(CHU_A);
      const feb = settlementMonthSchema.parse(await thang(TOA_A, "2025-02-01"));
      expect(feb.close_blockers).toEqual(["LANDLORD_ACCOUNT_ELSEWHERE"]);
      expect(feb.warnings?.landlord_account_elsewhere.vouchers.map((v) => [v.building_name, v.amount]))
        .toEqual([["Kho chung", 2_000_000]]);
      await expectLoi("SELECT public.landlord_settlement_close_v1($1, '2025-02-01'::date, $2, null)", [TOA_A, feb.live_hash], "55000");
      // gợi ý sổ: sổ đang có phiếu của toà khác được đếm (sổ dùng chung)
      const opts = landlordOperationOptionsSchema.parse(await rpc("public.landlord_operation_options_v1($1)", [TOA_A]));
      expect(opts.accounts.find((a) => a.id === SO_CHU_NHA)?.other_building_count_120d).toBeGreaterThanOrEqual(0);
    });
  });

  it("phiếu ở toà khác nhắc tên toà có dấu (bỏ dấu, chịu khoảng trắng/gạch nối)", async () => {
    await trongGiaoDich(async () => {
      await asUser(CHU_A);
      await rpc("public.landlord_operation_upsert_v1($1, 'Chủ nhà C', 20, '2025-01-01'::date, $2::uuid[], null, true)",
        [TOA_C, [SO_CHU_NHA_C]]);
      await asPostgres();
      await phieu({ toa: TOA_AO, loai: "EXPENSE", so: SO_QUAN_LY, thang: "2025-02-06", ten: "sửa điện nhà hem 66-thanh cong",
        dong: [{ lop: "PNL", tien: 450_000 }] });
      await phieu({ toa: TOA_AO, loai: "EXPENSE", so: SO_QUAN_LY, thang: "2025-02-07", ten: "Sơn cửa Hẻm 66 Thành Công",
        dong: [{ lop: "PNL", tien: 550_000 }] });
      await asUser(CHU_A);
      const feb = settlementMonthSchema.parse(await thang(TOA_C, "2025-02-01"));
      expect(feb.warnings?.related_elsewhere.vouchers.map((v) => v.amount).sort()).toEqual([450_000, 550_000]);
    });
  });
});

describe("vòng 2: xác nhận số dư, sổ đã xoá, áp % từ tháng, link toà đã xoá", () => {
  it("cọc trước kỳ đổi (phiếu nhập muộn) ⇒ xác nhận số dư cũ hết hiệu lực; tick lại thì hết chặn; dời tháng mà bỏ tick thì chặn", async () => {
    await trongGiaoDich(async () => {
      await asUser(CHU_A);
      await caiToaA(30, "2025-01-01", 700_000, true);
      let o = landlordOperationOptionsSchema.parse(await rpc("public.landlord_operation_options_v1($1)", [TOA_A]));
      expect([o.current?.opening_confirmation_stale, o.current?.opening_confirmed_pre_start]).toEqual([false, 700_000]);
      expect((await thang(TOA_A, "2025-02-01")).close_blockers).toEqual([]);

      await asPostgres();
      await phieu({ loai: "INCOME", so: SO_CHU_NHA, thang: "2024-12-28", dong: [{ lop: "DEPOSIT", tien: 200_000 }] });
      await asUser(CHU_A);
      o = landlordOperationOptionsSchema.parse(await rpc("public.landlord_operation_options_v1($1)", [TOA_A]));
      expect([o.current?.opening_confirmation_stale, o.current?.pre_start_landlord_deposits]).toEqual([true, 900_000]);
      expect((await thang(TOA_A, "2025-02-01")).close_blockers).toEqual(["OPENING_UNCONFIRMED"]);
      expect(settlementOverviewSchema.parse(await rpc("public.landlord_settlement_overview_v1($1)", [TOA_A])).opening_confirmed).toBe(false);

      await caiToaA(30, "2025-01-01", 900_000, true, null, 900_000);
      o = landlordOperationOptionsSchema.parse(await rpc("public.landlord_operation_options_v1($1)", [TOA_A]));
      expect(o.current?.opening_confirmation_stale).toBe(false);
      expect((await thang(TOA_A, "2025-02-01")).close_blockers).toEqual([]);

      await caiToaA(30, "2024-12-01", 900_000, false);
      expect((await thang(TOA_A, "2024-12-01")).close_blockers).toContain("OPENING_UNCONFIRMED");
    });
  });

  it("sổ chủ nhà đang dùng mà bị xoá mềm vẫn lưu được cài đặt; THÊM sổ đã xoá thì không", async () => {
    await trongGiaoDich(async () => {
      await asPostgres();
      await db.query("UPDATE public.accounts SET deleted_at = now() WHERE id IN ($1, $2)", [SO_CHU_NHA, SO_QUAN_LY]);
      await asUser(CHU_A);
      expect((await caiToaA(30, "2025-01-01")).building_id).toBe(TOA_A);
      await expectLoi(`SELECT ${UPSERT_A}`, [TOA_A, 30, "2025-01-01", [SO_CHU_NHA, SO_QUAN_LY], 0, true, null, 700_000], "22023");
      const opts = landlordOperationOptionsSchema.parse(await rpc("public.landlord_operation_options_v1($1)", [TOA_A]));
      expect(opts.accounts.find((a) => a.id === SO_CHU_NHA)?.is_deleted).toBe(true);
    });
  });

  it("áp % từ một tháng cụ thể so với điều khoản đang áp ở tháng đó (kể cả khi trùng bản mới nhất)", async () => {
    await trongGiaoDich(async () => {
      await asUser(CHU_A);
      expect((await caiToaA(40, "2025-01-01", 0, true, "2025-05-01")).terms_from).toBe("2025-05-01");
      // muốn 40% sớm từ 03: trùng bản mới nhất nhưng khác điều khoản đang áp ở 03 ⇒ phải đổi
      expect((await caiToaA(40, "2025-01-01", 0, true, "2025-03-01")).terms_from).toBe("2025-03-01");
      const o = landlordOperationOptionsSchema.parse(await rpc("public.landlord_operation_options_v1($1)", [TOA_A]));
      expect(o.current?.terms.map((t) => [t.valid_from, t.manager_percent])).toEqual([["2025-01-01", 30], ["2025-03-01", 40]]);
      // lặp lại y nguyên ⇒ không đổi gì
      expect((await caiToaA(40, "2025-01-01", 0, true, "2025-03-01")).terms_from).toBeNull();
    });
  });

  it("toà bị xoá mềm hoặc thành toà ảo: link chủ nhà trả NULL", async () => {
    await trongGiaoDich(async () => {
      await asUser(CHU_A);
      const { token } = await rpc<{ token: string }>("public.landlord_share_link_create_v1($1, null)", [TOA_A]);
      await asPostgres();
      await db.query("UPDATE public.buildings SET deleted_at = now() WHERE id = $1", [TOA_A]);
      await asUser(null);
      expect(await rpc("public.landlord_settlement_public_v1($1, null)", [token])).toBeNull();
    });
  });
});

describe("vòng 3: xác nhận đúng số đã thấy, đổi điều khoản từng trường, hash, nhãn đối chiếu", () => {
  it("chỉ ghi xác nhận khi cơ sở không đổi trong lần lưu VÀ đúng số cọc trước kỳ người dùng đã thấy", async () => {
    await trongGiaoDich(async () => {
      await asUser(CHU_A);
      // thấy sai số (vd màn cũ) ⇒ không xác nhận, báo phải đối chiếu lại
      const sai = upsertReceiptSchema.parse(await caiToaA(30, "2025-01-01", 700_000, true, null, 123));
      expect(sai.opening_needs_reconfirm).toBe(true);
      let o = landlordOperationOptionsSchema.parse(await rpc("public.landlord_operation_options_v1($1)", [TOA_A]));
      expect(o.current?.opening_confirmed_at).toBeNull();
      // đúng số đã thấy ⇒ xác nhận
      expect(upsertReceiptSchema.parse(await caiToaA(30, "2025-01-01", 700_000, true, null, 700_000)).opening_needs_reconfirm).toBe(false);
      o = landlordOperationOptionsSchema.parse(await rpc("public.landlord_operation_options_v1($1)", [TOA_A]));
      expect(o.current?.opening_confirmed_at).not.toBeNull();
      // chưa có xác nhận; đổi sổ của điều khoản ĐẦU mà tick ngay (cọc trước kỳ tình cờ không đổi) ⇒ không nhận
      // trong lần lưu đó (có xác nhận cũ còn khớp số thì được giữ — cơ sở không đổi giá trị)
      await caiToaA(30, "2025-01-01", 700_000, false);
      const doiSo = upsertReceiptSchema.parse(
        await rpc(UPSERT_A, [TOA_A, 30, "2025-01-01", [SO_CHU_NHA, SO_QUAN_LY], 700_000, true, "2025-01-01", 700_000]));
      expect(doiSo.opening_needs_reconfirm).toBe(true);
      await caiToaA(30, "2025-01-01", 700_000, true, "2025-01-01", 700_000);
      // dời tháng áp dụng mà vẫn tick, kể cả gửi đúng số cọc trước kỳ của tháng MỚI ⇒ không nhận
      const doi = upsertReceiptSchema.parse(await caiToaA(30, "2025-02-01", 700_000, true, null, 1_505_000));
      expect(doi.opening_needs_reconfirm).toBe(true);
      expect((await thang(TOA_A, "2025-02-01")).close_blockers).toContain("OPENING_UNCONFIRMED");
      const lui = upsertReceiptSchema.parse(await caiToaA(30, "2024-12-01", 700_000, true, null, 700_000));
      expect(lui.opening_needs_reconfirm).toBe(true);
      expect((await thang(TOA_A, "2024-12-01")).close_blockers).toContain("OPENING_UNCONFIRMED");
    });
  });

  it("đổi % từ tháng X chỉ đổi %, giữ sổ của từng mốc sau X (không kéo sổ của mốc mới nhất về X)", async () => {
    await trongGiaoDich(async () => {
      await asUser(CHU_A);
      // từ 04: chủ nhà nhận thêm sổ quản lý cũ làm sổ chủ nhà
      await rpc(UPSERT_A, [TOA_A, 30, "2025-01-01", [SO_CHU_NHA, SO_QUAN_LY], 0, true, "2025-04-01", 700_000]);
      // tăng % từ 03, gửi đúng sổ của điều khoản đang áp ở 03
      expect((await rpc<Json>(UPSERT_A, [TOA_A, 35, "2025-01-01", [SO_CHU_NHA], 0, true, "2025-03-01", 700_000])).terms_from)
        .toBe("2025-03-01");
      const o = landlordOperationOptionsSchema.parse(await rpc("public.landlord_operation_options_v1($1)", [TOA_A]));
      expect(o.current?.terms.map((t) => [t.valid_from, t.manager_percent, t.landlord_account_ids.length]))
        .toEqual([["2025-01-01", 30, 1], ["2025-03-01", 35, 1], ["2025-04-01", 35, 2]]);
      // tháng 03: tiền khách vào sổ quản lý vẫn là quản lý thu
      const mar = settlementMonthSchema.parse(await thang(TOA_A, "2025-03-01"));
      expect(mar.statement?.totals.manager_collected).toBe(50_000);
      expect(mar.statement?.manager_percent).toBe(35);
    });
  });

  it("phiếu toà khác ghi vào sổ chủ nhà, nhập sau khi chốt, làm tháng 'đã đổi'", async () => {
    await trongGiaoDich(async () => {
      await asUser(CHU_A);
      await chot("2025-02-01");
      await asPostgres();
      await phieu({ toa: TOA_AO, loai: "EXPENSE", so: SO_CHU_NHA, thang: "2025-02-20", dong: [{ lop: "PNL", tien: 3_000_000 }] });
      await asUser(CHU_A);
      expect((await thang(TOA_A, "2025-02-01")).is_stale).toBe(true);
      const ov = settlementOverviewSchema.parse(await rpc("public.landlord_settlement_overview_v1($1)", [TOA_A]));
      expect(ov.months.find((m) => m.period_month === "2025-02-01")?.is_stale).toBe(true);
    });
  });

  it("đối chiếu KQKD: phiếu bị dời ngày sang tháng khác sau khi chốt ⇒ 'đổi sau khi chốt'", async () => {
    await trongGiaoDich(async () => {
      await asUser(CHU_A);
      await chot("2025-02-01");
      await asPostgres();
      await db.query("UPDATE public.income_expenses SET voucher_date = '2025-03-02' WHERE id = $1", [PHIEU_LO_CHI]);
      await asUser(CHU_A);
      const feb = settlementMonthSchema.parse(await thang(TOA_A, "2025-02-01"));
      expect(feb.kqkd_bridge?.rows.find((r) => r.settlement_amount === -3_000_000)?.reason).toBe("CHANGED_AFTER_CLOSE");
    });
  });

  it("sổ chủ nhà của toà vận hành đang NGỪNG áp dụng vẫn là tiền chủ nhà kia ⇒ vẫn chặn; tên toà có ' - ' vẫn nhận ra", async () => {
    await trongGiaoDich(async () => {
      await asUser(CHU_A);
      await rpc("public.landlord_operation_upsert_v1($1, 'Chủ nhà C', 20, '2025-01-01'::date, $2::uuid[], null, false)",
        [TOA_C, [SO_CHU_NHA_C]]);
      await asPostgres();
      await phieu({ loai: "EXPENSE", so: SO_CHU_NHA_C, thang: "2025-02-10", dong: [{ lop: "PNL", tien: 100_000 }] });
      await phieu({ toa: TOA_AO, loai: "EXPENSE", so: SO_QUAN_LY, thang: "2025-02-06", ten: "sửa ống nước 44 - TA",
        dong: [{ lop: "PNL", tien: 75_000 }] });
      await asUser(CHU_A);
      const feb = settlementMonthSchema.parse(await thang(TOA_A, "2025-02-01"));
      expect(feb.statement?.foreign_account_voucher_count).toBe(1);
      expect(feb.close_blockers).toContain("FOREIGN_LANDLORD_ACCOUNT");
      expect(feb.warnings?.related_elsewhere.vouchers.map((v) => v.amount)).toEqual([75_000]);
      // toà kia bị XOÁ mềm thì không còn chặn (không ai sửa được điều khoản của nó nữa)
      await asPostgres();
      await db.query("UPDATE public.buildings SET deleted_at = now() WHERE id = $1", [TOA_C]);
      await asUser(CHU_A);
      expect(settlementMonthSchema.parse(await thang(TOA_A, "2025-02-01")).statement?.foreign_account_voucher_count).toBe(0);
    });
  });
});

describe("vòng 4: sổ đã xoá ở phiên bản cũ, kẹp tháng áp tỷ lệ", () => {
  it("sổ đã xoá còn ở một phiên bản điều khoản cũ vẫn lưu được và vẫn hiện để bỏ chọn", async () => {
    await trongGiaoDich(async () => {
      await asUser(CHU_A);
      // 01: [chủ nhà, quản lý cũ]; từ 04 bỏ sổ quản lý cũ
      await rpc(UPSERT_A, [TOA_A, 30, "2025-01-01", [SO_CHU_NHA, SO_QUAN_LY], 0, true, "2025-01-01", 700_000]);
      await rpc(UPSERT_A, [TOA_A, 30, "2025-01-01", [SO_CHU_NHA], 0, true, "2025-04-01", 700_000]);
      await asPostgres();
      await db.query("UPDATE public.accounts SET deleted_at = now() WHERE id = $1", [SO_QUAN_LY]);
      await asUser(CHU_A);
      // chỉ tăng % từ 02, gửi đúng sổ đang áp ở 02 (có sổ đã xoá)
      const r = upsertReceiptSchema.parse(
        await rpc(UPSERT_A, [TOA_A, 35, "2025-01-01", [SO_CHU_NHA, SO_QUAN_LY], 0, true, "2025-02-01", 700_000]));
      expect(r.terms_from).toBe("2025-02-01");
      const o = landlordOperationOptionsSchema.parse(await rpc("public.landlord_operation_options_v1($1)", [TOA_A]));
      expect(o.accounts.find((a) => a.id === SO_QUAN_LY)?.is_deleted).toBe(true);
      expect(o.current?.terms.map((t) => [t.valid_from, t.manager_percent, t.landlord_account_ids.length]))
        .toEqual([["2025-01-01", 30, 2], ["2025-02-01", 35, 2], ["2025-04-01", 35, 1]]);
    });
  });

  it("tháng áp tỷ lệ sớm hơn tháng bắt đầu mới: không đổi gì thì không lỗi; có đổi thì kẹp về tháng bắt đầu", async () => {
    await trongGiaoDich(async () => {
      await asUser(CHU_A);
      expect(upsertReceiptSchema.parse(await caiToaA(30, "2025-03-01", 0, true, "2025-01-01")).terms_from).toBeNull();
      expect(upsertReceiptSchema.parse(await caiToaA(45, "2025-03-01", 0, true, "2025-01-01")).terms_from).toBe("2025-03-01");
    });
  });
});

describe("gói RPC thật và schema zod", () => {
  it("gói RPC thật parse được bằng đúng schema zod mà web dùng", async () => {
    await trongGiaoDich(async () => {
      await asUser(CHU_A);
      for (const m of ["2024-12-01", "2025-01-01", "2025-02-01", "2025-03-01"]) {
        settlementMonthSchema.parse(await thang(TOA_A, m));
      }
      settlementOverviewSchema.parse(await rpc("public.landlord_settlement_overview_v1($1)", [TOA_A]));
      landlordOperationOptionsSchema.parse(await rpc("public.landlord_operation_options_v1($1)", [TOA_A]));
      landlordOperationsListSchema.parse(await rpc("public.landlord_operations_list_v1()"));
      const { token } = await rpc<{ token: string }>("public.landlord_share_link_create_v1($1, 'Zalo')", [TOA_A]);
      shareLinksSchema.parse(await rpc("public.landlord_share_links_v1($1)", [TOA_A]));
      await asUser(null);
      settlementPublicSchema.parse(await rpc("public.landlord_settlement_public_v1($1, '2025-01-01'::date)", [token]));
    });
  });
});
