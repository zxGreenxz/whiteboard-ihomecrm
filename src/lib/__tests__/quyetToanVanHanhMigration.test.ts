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
  kqkd?: boolean | null; xoa?: boolean; dong?: { lop: string; tien: number }[]; tong?: number;
}) {
  const pid = id(n++);
  await db.query(
    `INSERT INTO public.income_expenses(id, organization_id, building_id, code, name, type, voucher_date, account_id,
       approval_status, business_result_accounting, total_amount, deleted_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
    [pid, ORG_A, p.toa ?? TOA_A, `P${n}`, `Phiếu ${n}`, p.loai, p.thang, p.so, p.trangThai ?? "APPROVED",
      p.kqkd ?? null, p.tong ?? (p.dong ?? []).reduce((s, d) => s + d.tien, 0), p.xoa ? new Date().toISOString() : null],
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
      total_amount numeric, deleted_at timestamptz);
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
  await phieu({ loai: "EXPENSE", so: SO_AO, thang: "2025-01-10", dong: [{ lop: "DEPOSIT", tien: 400_000 }] });
  await phieu({ loai: "INCOME", so: SO_AO, thang: "2025-01-10", dong: [{ lop: "PNL", tien: 400_000 }] });
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
    // quản lý chi = 2tr + dòng DEPOSIT bị ép tính KQKD (business_result_accounting = true) 30k
    expect(so(t.manager_paid)).toBe(2_030_000);
    expect(so(t.revenue)).toBe(11_550_000);
    expect(so(t.expense)).toBe(2_530_000);
    expect(so(t.profit)).toBe(9_020_000);
    expect(so(t.manager_share)).toBe(2_706_000);
    expect(so(t.landlord_share)).toBe(6_314_000);
    expect(so(t.landlord_owes_manager)).toBe(3_186_000);
    // bảo toàn: chủ nhà đang giữ − phần chủ nhà được hưởng = số chủ nhà phải trả
    expect(so(t.landlord_collected) - so(t.landlord_paid) - so(t.landlord_share)).toBe(so(t.landlord_owes_manager));
    expect(st.deposits).toEqual({ received: 3_000_000, paid_out: 400_000 });
    expect(st.pending).toMatchObject({ voucher_count: 2, income: 600_000, expense: 700_000 });
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
      expect(so(t.balance_with_open)).toBe(2_200_000 + 3_186_000);

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
      expect(so((st.totals as Json).landlord_owes_manager)).toBe(3_186_000);
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
