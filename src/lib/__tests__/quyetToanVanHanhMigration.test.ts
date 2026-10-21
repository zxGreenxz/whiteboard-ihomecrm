import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * Migration 20261021083438 — quyết toán toà VẬN HÀNH CHO CHỦ NHÀ (chủ chốt 21/10/2026).
 * Chạy THẬT trên PostgreSQL nhúng: migration HAI lượt, rồi gọi RPC bằng vai
 * authenticated / anon như PostgREST. Kiểm công thức (ai giữ tiền, % quản lý, lỗ thì 0),
 * chặn quyền, chốt có CAS + phát hiện phiếu đổi sau chốt, thanh toán chống bấm trùng,
 * và link công khai không lộ id nội bộ.
 *
 * Dữ liệu đặt ở 2025 (tháng đã qua) để phép "chỉ chốt tháng đã qua" không phụ thuộc ngày chạy.
 */
const FILE = "supabase/migrations/20261021083438_quyet_toan_van_hanh_chu_nha.sql";
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const [ORG_A, ORG_B, CHU_A, NHAN_VIEN_A, CHU_B, SUPER] = [1, 2, 3, 4, 5, 6].map(id);
const [TOA_A, TOA_B, TOA_AO] = [11, 12, 13].map(id);
const [SO_CHU_NHA, SO_QUAN_LY, SO_AO, SO_CONG_TY_B] = [21, 22, 23, 24].map(id);
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
  kqkd?: boolean | null; xoa?: boolean; dong?: { lop: string; tien: number }[]; tong?: number; nguon?: string;
  butToan?: string; lamTron?: { so: string; tien: number };
}) {
  const pid = id(n++);
  await db.query(
    `INSERT INTO public.income_expenses(id, organization_id, building_id, code, name, type, voucher_date, account_id,
       approval_status, business_result_accounting, total_amount, deleted_at, system_source, posting_status,
       rounding_account_id, rounding_amount)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
    [pid, ORG_A, p.toa ?? TOA_A, `P${n}`, `Phiếu ${n}`, p.loai, p.thang, p.so, p.trangThai ?? "APPROVED",
      p.kqkd ?? null, p.tong ?? (p.dong ?? []).reduce((s, d) => s + d.tien, 0), p.xoa ? new Date().toISOString() : null,
      p.nguon ?? null, p.butToan ?? "POSTED", p.lamTron?.so ?? null, p.lamTron?.tien ?? 0],
  );
  for (const d of p.dong ?? []) {
    await db.query(
      "INSERT INTO public.income_expense_items(income_expense_id, amount, accounting_class) VALUES ($1,$2,$3)",
      [pid, d.tien, d.lop],
    );
  }
  return pid;
}

let PHIEU_LO_CHI = "";

beforeAll(async () => {
  await db.exec(`
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
      type text, voucher_date date, account_id uuid, approval_status text, business_result_accounting boolean,
      total_amount numeric, deleted_at timestamptz, system_source text, posting_status text,
      change_account_id uuid, change_amount numeric DEFAULT 0, rounding_account_id uuid, rounding_amount numeric DEFAULT 0);
    CREATE TABLE public.income_expense_items(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), income_expense_id uuid,
      amount numeric, unit_price numeric, quantity numeric, accounting_class text);
    CREATE TABLE public.profiles(id uuid PRIMARY KEY, full_name text, email text);

    INSERT INTO public.organizations VALUES ('${ORG_A}','A'),('${ORG_B}','B');
    INSERT INTO public.memberships VALUES ('${CHU_A}','${ORG_A}',true),('${NHAN_VIEN_A}','${ORG_A}',false),('${CHU_B}','${ORG_B}',true);
    INSERT INTO public.super_admins VALUES ('${SUPER}');
    INSERT INTO public.profiles VALUES ('${CHU_A}','Chủ A',null);
    INSERT INTO public.buildings(id, organization_id, name, name_sort, is_virtual) VALUES
      ('${TOA_A}','${ORG_A}','Toà A','toa a',false),('${TOA_B}','${ORG_B}','Toà B','toa b',false),
      ('${TOA_AO}','${ORG_A}','Kho chung','kho chung',true);
    INSERT INTO public.accounts(id, organization_id, name, code, is_virtual) VALUES
      ('${SO_CHU_NHA}','${ORG_A}','Sổ chủ nhà','TK1',false),('${SO_QUAN_LY}','${ORG_A}','Sổ quản lý','TK2',false),
      ('${SO_AO}','${ORG_A}','Cấn trừ thanh lý','TK3',true),('${SO_CONG_TY_B}','${ORG_B}','Sổ B','TK9',false);
  `);

  // Tháng 01/2025 — đủ mọi loại dòng.
  await phieu({ loai: "INCOME", so: SO_CHU_NHA, thang: "2025-01-05", dong: [{ lop: "PNL", tien: 10_000_000 }] });
  await phieu({ loai: "INCOME", so: SO_QUAN_LY, thang: "2025-01-06", dong: [{ lop: "PNL", tien: 1_000_000 }] });
  await phieu({ loai: "EXPENSE", so: SO_QUAN_LY, thang: "2025-01-07", dong: [{ lop: "PNL", tien: 2_000_000 }] });
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
  // Tháng 03/2025 — phiếu đã duyệt nhưng bút toán bị đảo; làm tròn rơi vào sổ chủ nhà.
  await phieu({ loai: "INCOME", so: SO_CHU_NHA, thang: "2025-03-03", butToan: "REVERSED", dong: [{ lop: "PNL", tien: 100_000 }] });
  await phieu({ loai: "INCOME", so: SO_QUAN_LY, thang: "2025-03-04", lamTron: { so: SO_CHU_NHA, tien: 1_000 },
    dong: [{ lop: "PNL", tien: 50_000 }] });
  // Trước ngày áp dụng: khách chuyển cọc 700k vào sổ chủ nhà (gợi ý số dư đầu kỳ).
  await phieu({ loai: "INCOME", so: SO_CHU_NHA, thang: "2024-12-20", dong: [{ lop: "DEPOSIT", tien: 700_000 }] });

  const sql = readFileSync(FILE, "utf8");
  await db.exec(sql);
  await db.exec(sql);

  // Cấu hình toà A (ghi thẳng như dữ liệu có sẵn; đường RPC thêm/sửa có ca riêng).
  await db.exec(`
    INSERT INTO app_private.landlord_operations
      (building_id, organization_id, landlord_name, manager_percent, effective_from, landlord_account_ids, created_by, updated_by)
    VALUES ('${TOA_A}','${ORG_A}','Chủ nhà A',30,'2025-01-01',ARRAY['${SO_CHU_NHA}']::uuid[],'${CHU_A}','${CHU_A}');
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

  it("phiếu duyệt mà bút toán đã đảo: vẫn tính KQKD nhưng chặn chốt; làm tròn vào sổ chủ nhà được bù trừ", async () => {
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
    expect(so(t.landlord_extra_cash)).toBe(1_000);
    // 45k + 0 − 50k + 0 + 1k
    expect(so(t.landlord_owes_manager)).toBe(-4_000);
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
    // toà ảo không phải ứng viên
    expect((chu.candidate_buildings as Json[]).map((o) => o.building_id)).toEqual([TOA_A]);
  });
});

describe("cài đặt toà", () => {
  it.each([
    ["tỷ lệ > 100", 120, [SO_CHU_NHA]],
    ["sổ của công ty khác", 30, [SO_CONG_TY_B]],
    ["không chọn sổ nào", 30, []],
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
    expect(kq).toEqual({ building_id: TOA_A, created: false });
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
      // tháng 01 còn mở: cộng vào số "gồm cả tạm tính"
      // tháng 01 (4.096.000) và 03 (−4.000) còn mở: cộng vào số "gồm cả tạm tính"
      expect(so(t.balance_with_open)).toBe(2_200_000 + 4_096_000 - 4_000);

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
});
