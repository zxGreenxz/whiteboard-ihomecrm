// Khoá tháng đã chốt LN theo KỲ + RPC "phát sinh sau chốt" (rà 21/10 F06, chủ chốt 22/10/2026:
// "chặn hẳn", Báo cáo LN tháng đã chốt không cộng khoản sau chốt mà báo lên).
//
// Chạy THẬT trên PostgreSQL nhúng (PGlite):
//   - thân trigger phiếu ĐANG CHẠY production (cắt từ 20260925073251, tái lập md5 877f88c3…) gắn
//     vào bảng như production; dữ liệu dựng khi tháng còn mở (gồm cả phiếu "sau chốt" lập trước
//     khi có khoá kỳ), rồi chốt tháng;
//   - migration 20261022172918 áp HAI lượt (lane kiểm idempotency);
//   - fa_accrual_allocations, khoá ngày phiếu, bộ sinh phiếu định kỳ: định nghĩa SỐNG (CREATE
//     cuối cùng trong thư mục migration).
// Kiểm: chặn lập / sửa / xoá / huỷ / DUYỆT phiếu có kỳ trong tháng đã chốt với mọi người; kỳ tháng
// mở và ngoại lệ không đổi tiền vẫn qua; phiếu chờ duyệt kẹt vẫn huỷ/xoá được; thu tiền hoá đơn
// tháng đã chốt vẫn lập + duyệt được và hiện ở RPC; RPC đúng luật kỳ, đúng quyền, che phiếu hạn chế,
// gói parse được bằng zod của web; luật tháng của dòng khớp từng (phiếu, tháng) với
// fa_accrual_allocations; job sinh phiếu định kỳ không vỡ cả lượt.
// Mọi số tiền / mã phiếu / tên ở đây là giả.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { profitPostLockSchema } from '@/lib/profitPostLock';

const FILE = process.env.KHOA_KY_MIGRATION_FILE ?? 'supabase/migrations/20261022172918_khoa_ky_thang_da_chot_ln.sql';
const KHOA_NGAY = 'supabase/migrations/20260925073251_khoa_thang_loi_nhuan_tuyet_doi.sql';
const PROD_MD5 = '877f88c3b7371acb6633ce5f091e85d4';
const MIG_DIR = join(process.cwd(), 'supabase', 'migrations');
const KHOA_KY_FILE = '20261022172918_khoa_ky_thang_da_chot_ln.sql';

function sliceFunction(path: string, header: string, end: string): string {
  const sql = readFileSync(path, 'utf8');
  const start = sql.indexOf(header);
  if (start < 0) throw new Error(`Không thấy ${header} trong ${path}`);
  return sql.slice(start, sql.indexOf(end, start) + end.length);
}

/** Định nghĩa SỐNG: CREATE cuối cùng theo thứ tự tên file (bỏ file khoá kỳ này), bỏ chú thích. */
let corpus: string[] | null = null;
function liveFunctionSql(schema: string, fnName: string): string {
  corpus ??= readdirSync(MIG_DIR).filter((f) => f.endsWith('.sql') && f !== KHOA_KY_FILE).sort()
    .map((f) => readFileSync(join(MIG_DIR, f), 'utf8').replace(/--[^\n]*/g, ''));
  const re = new RegExp(`CREATE\\s+(?:OR\\s+REPLACE\\s+)?FUNCTION\\s+${schema}\\.${fnName}\\s*\\(`, 'gi');
  let hit: string | null = null;
  for (const sql of corpus) for (const m of sql.matchAll(re)) hit = sql.slice(m.index);
  if (!hit) throw new Error(`Không tìm thấy định nghĩa ${schema}.${fnName}`);
  const tag = /\bAS\s+(\$[A-Za-z0-9_]*\$)/i.exec(hit);
  if (!tag) throw new Error(`Không thấy thân hàm ${schema}.${fnName}`);
  return `${hit.slice(0, hit.indexOf(tag[1], tag.index + tag[0].length) + tag[1].length)};`;
}

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const [ORG_A, ORG_B, CHU_A, NV_A, CHU_B, SUPER, NGOAI] = [1, 2, 3, 4, 5, 6, 7].map(id);
const [TOA_A, TOA_A2, TOA_B] = [11, 12, 13].map(id);
const [LOAI_THU, LOAI_CHI, LOAI_COC] = [21, 22, 23].map(id);
const [HD_T8, HD_T9] = [31, 32].map(id);
const CHOT_T8 = '2025-09-03T03:00:00Z';

const db = new PGlite();
type Json = Record<string, unknown>;

async function chay(sql: string) {
  try {
    await db.exec(sql);
  } catch (e) {
    const pos = Number((e as { position?: string }).position ?? 0);
    throw new Error(`${(e as Error).message} — gần: ${sql.slice(Math.max(0, pos - 160), pos + 40)}`);
  }
}
async function trongGiaoDich<T>(fn: () => Promise<T>): Promise<T> {
  await db.exec('BEGIN');
  try {
    return await fn();
  } finally {
    await db.exec('ROLLBACK');
  }
}
/** Đặt người đăng nhập (claim sub) — vai postgres giữ nguyên (writer thật là RPC definer). */
async function laNguoi(user: string | null) {
  await db.query("SELECT set_config('request.jwt.claim.sub', $1, true)", [user ?? '']);
}
async function asUser(user: string | null) {
  await db.exec('RESET ROLE');
  await laNguoi(user);
  await db.exec(user ? 'SET LOCAL ROLE authenticated' : 'SET LOCAL ROLE anon');
}
/** Câu mong lỗi chạy trong SAVEPOINT để transaction của ca test còn dùng tiếp được. */
async function loiCua(sql: string, params: unknown[] = []): Promise<{ code?: string; message: string } | null> {
  await db.exec('SAVEPOINT thu_loi');
  let err: { code?: string; message: string } | null = null;
  try {
    await db.query(sql, params);
  } catch (e) {
    err = e as { code?: string; message: string };
  }
  await db.exec(err ? 'ROLLBACK TO SAVEPOINT thu_loi' : 'RELEASE SAVEPOINT thu_loi');
  return err;
}
async function biChanKy(sql: string, params: unknown[] = [], thang = '08/2025', toa = '44TA') {
  const err = await loiCua(sql, params);
  expect(err?.code, err?.message).toBe('P0001');
  expect(err?.message).toBe(
    `[PROFIT_LOCKED] Tháng ${thang} của toà ${toa} đã chốt lợi nhuận — không ghi được phiếu có kỳ trong tháng này. Muốn ghi: mở khoá tháng ở tab Chốt LN.`,
  );
}
async function qua(sql: string, params: unknown[] = []) {
  const err = await loiCua(sql, params);
  expect(err?.message ?? null).toBeNull();
}

let n = 100;
async function phieu(p: {
  toa?: string; loai?: 'INCOME' | 'EXPENSE'; ngay: string; trangThai?: string; kqkd?: boolean | null;
  dong?: { tien: number; tu?: string | null; den?: string | null; loaiHm?: string }[]; tong?: number;
  hoaDon?: string | null; hanChe?: boolean; tao?: string; duyet?: string | null; ma?: string;
}): Promise<string> {
  const pid = id(n++);
  const tao = p.tao ?? '2025-08-25T03:00:00Z';
  await db.query(
    `INSERT INTO public.income_expenses(id, organization_id, building_id, code, name, type, voucher_date, approval_status,
       business_result_accounting, total_amount, invoice_id, has_restricted_item, user_id, created_at, approved_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
    [pid, p.toa === TOA_B ? ORG_B : ORG_A, p.toa ?? TOA_A, p.ma ?? `PX${n}`, `Phiếu ${n}`, p.loai ?? 'EXPENSE', p.ngay,
      p.trangThai ?? 'APPROVED', p.kqkd ?? null, p.tong ?? (p.dong ?? []).reduce((s, d) => s + d.tien, 0),
      p.hoaDon ?? null, p.hanChe ?? false, CHU_A, tao,
      p.duyet === undefined ? ((p.trangThai ?? 'APPROVED') === 'APPROVED' ? tao : null) : p.duyet],
  );
  for (const d of p.dong ?? []) {
    await db.query(
      `INSERT INTO public.income_expense_items(income_expense_id, amount, income_expense_type_id, start_date, end_date)
       VALUES ($1,$2,$3,$4,$5)`,
      [pid, d.tien, d.loaiHm ?? (p.loai === 'INCOME' ? LOAI_THU : LOAI_CHI), d.tu ?? null, d.den ?? null],
    );
  }
  return pid;
}

const P: Record<string, string> = {};
let md5SauLuotMot = '';

beforeAll(async () => {
  await chay(`
    CREATE ROLE authenticated; CREATE ROLE anon; CREATE ROLE service_role;
    CREATE SCHEMA auth; CREATE SCHEMA app_private;
    GRANT USAGE ON SCHEMA public, auth TO authenticated, anon;
    CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE
      AS $$ SELECT nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
    CREATE TABLE public.memberships(user_id uuid, organization_id uuid);
    CREATE TABLE public.super_admins(user_id uuid PRIMARY KEY);
    CREATE TABLE public.restricted_viewers(user_id uuid PRIMARY KEY);
    CREATE FUNCTION public.is_super_admin() RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER
      AS $$ SELECT EXISTS (SELECT 1 FROM public.super_admins WHERE user_id = auth.uid()) $$;
    CREATE TABLE public.buildings(id uuid PRIMARY KEY, organization_id uuid, name text,
      is_virtual boolean DEFAULT false, deleted_at timestamptz);
    CREATE FUNCTION public.can_access_building(_building_id uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER
      AS $$ SELECT public.is_super_admin() OR EXISTS (SELECT 1 FROM public.buildings b JOIN public.memberships m
             ON m.organization_id = b.organization_id WHERE b.id = _building_id AND m.user_id = auth.uid()) $$;
    CREATE FUNCTION public.can_view_restricted_ie() RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER
      AS $$ SELECT EXISTS (SELECT 1 FROM public.restricted_viewers WHERE user_id = auth.uid()) $$;
    CREATE TABLE public.invoices(id uuid PRIMARY KEY, billing_month text, building_id uuid, deleted_at timestamptz);
    CREATE TABLE public.income_expense_types(id uuid PRIMARY KEY, name text, category text, is_deposit boolean DEFAULT false,
      fee_category text);
    CREATE TABLE public.income_expenses(
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid, building_id uuid, code text, name text,
      type text, voucher_date date, approval_status text DEFAULT 'APPROVED', business_result_accounting boolean,
      counts_in_business_result boolean DEFAULT true, total_amount numeric DEFAULT 0, deleted_at timestamptz,
      invoice_id uuid, has_restricted_item boolean DEFAULT false, user_id uuid, created_at timestamptz DEFAULT now(),
      approved_at timestamptz, approved_by uuid, updated_at timestamptz DEFAULT now(), account_id uuid, notes text,
      room_id uuid, tenant_id uuid, contract_id uuid, payer_name text, attachments jsonb DEFAULT '[]',
      receive_bank_name text, receive_bank_account text, creator_name text,
      repeat_parent_id uuid, repeat_cycle text DEFAULT 'NONE', repeat_infinity boolean DEFAULT false,
      repeat_count integer DEFAULT 0, repeat_remaining integer DEFAULT 0, repeat_next_date date,
      repeat_auto_approve boolean DEFAULT true, handover_id uuid, verified_at timestamptz, verified_by uuid,
      verified_by_name text, verified_note text, posting_mode text, posting_status text, review_state text);
    CREATE TABLE public.income_expense_items(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), income_expense_id uuid,
      amount numeric, unit_price numeric DEFAULT 0, quantity numeric DEFAULT 1, accounting_class text,
      income_expense_type_id uuid, start_date date, end_date date, description text);
    CREATE TABLE public.profit_monthly(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), building_id uuid,
      period_month date, status text, locked_at timestamptz, UNIQUE (building_id, period_month));
    CREATE TABLE public.building_fee_accounts(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), building_id uuid,
      fee_category text, default_amount numeric, not_applicable boolean NOT NULL DEFAULT false, deleted_at timestamptz);
    CREATE TABLE app_private.ie_flex_writer_xids(income_expense_id uuid, transaction_id xid8, backend_pid integer,
      scope text);

    -- Như production: lớp KQKD của dòng do trigger BEFORE "set_ie_item_accounting_class" điền (xếp
    -- SAU a02 theo tên); tổng phiếu do trigger AFTER tính lại (cập nhật dòng phiếu).
    CREATE FUNCTION public.set_ie_item_accounting_class() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF NEW.accounting_class IS NULL THEN
        NEW.accounting_class := CASE WHEN (SELECT t.is_deposit FROM public.income_expense_types t
                                           WHERE t.id = NEW.income_expense_type_id) THEN 'DEPOSIT' ELSE 'PNL' END;
      END IF;
      RETURN NEW;
    END $$;
    CREATE TRIGGER set_ie_item_accounting_class BEFORE INSERT OR UPDATE ON public.income_expense_items
      FOR EACH ROW EXECUTE FUNCTION public.set_ie_item_accounting_class();
    CREATE FUNCTION public.auto_calc_item_amount() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF NEW.amount IS NULL THEN NEW.amount := NEW.quantity * NEW.unit_price; END IF;
      RETURN NEW;
    END $$;
    CREATE TRIGGER trigger_auto_calc_item_amount BEFORE INSERT OR UPDATE ON public.income_expense_items
      FOR EACH ROW EXECUTE FUNCTION public.auto_calc_item_amount();
    CREATE FUNCTION public.auto_recalc_total_amount() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      UPDATE public.income_expenses v
         SET total_amount = (SELECT COALESCE(sum(i.amount), 0) FROM public.income_expense_items i
                              WHERE i.income_expense_id = v.id)
       WHERE v.id = COALESCE(NEW.income_expense_id, OLD.income_expense_id)
         AND v.total_amount IS DISTINCT FROM (SELECT COALESCE(sum(i.amount), 0) FROM public.income_expense_items i
                                               WHERE i.income_expense_id = v.id);
      RETURN NULL;
    END $$;
    CREATE TRIGGER trigger_auto_recalc_total_amount AFTER INSERT OR UPDATE OR DELETE ON public.income_expense_items
      FOR EACH ROW EXECUTE FUNCTION public.auto_recalc_total_amount();

    -- Bộ sinh phiếu định kỳ: phụ thuộc nhỏ.
    CREATE FUNCTION public.org_today_v1(p_organization_id uuid DEFAULT NULL::uuid) RETURNS date LANGUAGE sql STABLE
      AS $$ SELECT '2025-10-20'::date $$;
    CREATE FUNCTION app_private.ie_spend_gate_v1(p_org uuid, p_building uuid, p_direction text, p_writer text,
      p_system_source text, p_account uuid, p_voucher_date date, p_lines jsonb, p_exclude_voucher uuid DEFAULT NULL,
      p_context jsonb DEFAULT '{}'::jsonb) RETURNS jsonb LANGUAGE sql AS $$ SELECT '{"enforce": false}'::jsonb $$;

    INSERT INTO public.memberships VALUES ('${CHU_A}','${ORG_A}'),('${NV_A}','${ORG_A}'),('${CHU_B}','${ORG_B}');
    INSERT INTO public.super_admins VALUES ('${SUPER}');
    INSERT INTO public.restricted_viewers VALUES ('${CHU_A}');
    INSERT INTO public.buildings(id, organization_id, name) VALUES
      ('${TOA_A}','${ORG_A}','44TA'),('${TOA_A2}','${ORG_A}','45TA'),('${TOA_B}','${ORG_B}','55TB');
    INSERT INTO public.income_expense_types(id, name, category, is_deposit) VALUES
      ('${LOAI_THU}','Tiền phòng','Phòng',false),('${LOAI_CHI}','Đóng tiền điện','Điện',false),
      ('${LOAI_COC}','Tiền cọc','Cọc',true);
    INSERT INTO public.invoices VALUES ('${HD_T8}','2025-08','${TOA_A}',null),('${HD_T9}','2025-09','${TOA_A}',null);
  `);
  for (const sql of [
    liveFunctionSql('public', 'add_cycle'),
    liveFunctionSql('public', 'fa_accrual_allocations'),
    liveFunctionSql('app_private', 'profit_month_locked_v1'),
    liveFunctionSql('app_private', 'assert_profit_month_open_v2'),
    liveFunctionSql('public', 'income_expense_items_check_profit_lock'),
    liveFunctionSql('public', 'generate_recurring_vouchers'),
    // Thân trigger phiếu ĐANG CHẠY production (trước migration này).
    sliceFunction(KHOA_NGAY, 'CREATE OR REPLACE FUNCTION public.income_expenses_check_profit_lock()', '$function$;'),
  ]) await chay(sql);
  await chay(`
    CREATE TRIGGER a02_ie_profit_lock_ins BEFORE INSERT ON public.income_expenses
      FOR EACH ROW EXECUTE FUNCTION public.income_expenses_check_profit_lock();
    CREATE TRIGGER a02_ie_profit_lock_upd BEFORE UPDATE ON public.income_expenses
      FOR EACH ROW EXECUTE FUNCTION public.income_expenses_check_profit_lock();
    CREATE TRIGGER a02_ie_profit_lock_del BEFORE DELETE ON public.income_expenses
      FOR EACH ROW EXECUTE FUNCTION public.income_expenses_check_profit_lock();
    CREATE TRIGGER a02_ie_items_profit_lock BEFORE INSERT OR UPDATE OR DELETE ON public.income_expense_items
      FOR EACH ROW EXECUTE FUNCTION public.income_expense_items_check_profit_lock();
  `);

  // Dữ liệu dựng khi tháng còn MỞ / trước khi có khoá kỳ (như đời thật), rồi mới chốt T8/2025
  // toà A + toà B. Lập + duyệt TRƯỚC khi chốt — số chốt đã có chúng.
  P.truoc = await phieu({ ngay: '2025-08-20', dong: [{ tien: 500_000 }] });
  P.truocKy = await phieu({ ngay: '2025-09-01', tao: '2025-09-01T01:00:00Z', dong: [{ tien: 400_000, tu: '2025-08-01', den: '2025-08-31' }] });
  // Lập trước chốt, duyệt SAU chốt (dữ liệu cũ trước khoá kỳ).
  P.duyetSau = await phieu({ ngay: '2025-09-01', tao: '2025-09-01T02:00:00Z', duyet: '2025-09-10T03:00:00Z',
    dong: [{ tien: 300_000, tu: '2025-08-01', den: '2025-08-31' }] });
  // Lập SAU chốt (dữ liệu cũ, trước khi có khoá kỳ).
  P.sau = await phieu({ ngay: '2025-09-05', tao: '2025-09-05T03:00:00Z', dong: [{ tien: 1_200_000, tu: '2025-08-01', den: '2025-08-31' }] });
  P.haiThang = await phieu({ ngay: '2025-09-06', tao: '2025-09-06T03:00:00Z', dong: [{ tien: 1_000_001, tu: '2025-08-01', den: '2025-09-30' }] });
  P.hanChe = await phieu({ ngay: '2025-09-07', tao: '2025-09-07T03:00:00Z', hanChe: true, ma: 'PXHANCHE',
    dong: [{ tien: 2_000_000, tu: '2025-08-01', den: '2025-08-31' }] });
  P.thuHd = await phieu({ loai: 'INCOME', ngay: '2025-09-04', tao: '2025-09-04T03:00:00Z', hoaDon: HD_T8, dong: [{ tien: 3_000_000 }] });
  P.cho = await phieu({ ngay: '2025-09-02', tao: '2025-09-02T03:00:00Z', trangThai: 'UNAPPROVED',
    dong: [{ tien: 250_000, tu: '2025-08-01', den: '2025-08-31' }] });
  P.coc = await phieu({ loai: 'INCOME', ngay: '2025-09-08', tao: '2025-09-08T03:00:00Z',
    dong: [{ tien: 5_000_000, tu: '2025-08-01', den: '2025-08-31', loaiHm: LOAI_COC }] });
  P.tatKqkd = await phieu({ ngay: '2025-09-08', tao: '2025-09-08T03:00:00Z', kqkd: false,
    dong: [{ tien: 70_000, tu: '2025-08-01', den: '2025-08-31' }] });
  P.huy = await phieu({ ngay: '2025-09-08', tao: '2025-09-08T03:00:00Z', trangThai: 'CANCELLED',
    dong: [{ tien: 80_000, tu: '2025-08-01', den: '2025-08-31' }] });
  P.t9 = await phieu({ ngay: '2025-09-09', tao: '2025-09-09T03:00:00Z', dong: [{ tien: 90_000 }] });
  P.toaA2 = await phieu({ toa: TOA_A2, ngay: '2025-09-09', tao: '2025-09-09T03:00:00Z',
    dong: [{ tien: 11_000, tu: '2025-08-01', den: '2025-08-31' }] });
  P.toaB = await phieu({ toa: TOA_B, ngay: '2025-09-09', tao: '2025-09-09T03:00:00Z',
    dong: [{ tien: 22_000, tu: '2025-08-01', den: '2025-08-31' }] });
  // Phiếu định kỳ (thu) lặp hằng tháng từ 15/07: kỳ con 15/08 rơi vào tháng đã chốt, 15/09 và 15/10 mở.
  P.cha = await phieu({ loai: 'INCOME', ngay: '2025-07-15', tao: '2025-07-15T03:00:00Z', dong: [{ tien: 100_000, tu: '2025-07-01', den: '2025-07-31' }] });
  await db.query("UPDATE public.income_expenses SET repeat_cycle = 'MONTH', repeat_infinity = true WHERE id = $1", [P.cha]);

  await chay(`
    INSERT INTO public.profit_monthly(building_id, period_month, status, locked_at) VALUES
      ('${TOA_A}','2025-08-01','LOCKED','${CHOT_T8}'),
      ('${TOA_B}','2025-08-01','LOCKED','${CHOT_T8}'),
      ('${TOA_A}','2025-09-01','DRAFT',null);
  `);

  // Bản production phải tái lập đúng md5 trước khi áp.
  const { rows } = await db.query<{ m: string }>(
    "SELECT md5(pg_get_functiondef('public.income_expenses_check_profit_lock()'::regprocedure)) AS m");
  expect(rows[0].m).toBe(PROD_MD5);

  const sql = readFileSync(FILE, 'utf8');
  await chay(sql);
  const sau = await db.query<{ m: string }>(
    "SELECT md5(pg_get_functiondef('public.income_expenses_check_profit_lock()'::regprocedure)) AS m");
  md5SauLuotMot = sau.rows[0].m;
  await chay(sql);
}, 120_000);
afterAll(() => db.close());

async function rpc(user: string | null, from: string, to: string, ids: string[] | null): Promise<Json> {
  await asUser(user);
  const r = await db.query<{ r: Json }>(
    'SELECT public.profit_post_lock_vouchers_v1($1::date, $2::date, $3::uuid[]) AS r', [from, to, ids]);
  return r.rows[0].r;
}
const ma = (rows: unknown) => (rows as Json[]).map((r) => r.voucher_id).sort();
const DONG = `INSERT INTO public.income_expense_items(income_expense_id, amount, income_expense_type_id, start_date, end_date)
              VALUES ($1, $2, $3, $4, $5)`;
const DAU = `INSERT INTO public.income_expenses(id, organization_id, building_id, name, type, voucher_date, approval_status,
               business_result_accounting, invoice_id)
             VALUES ($1, $2, $3, 'Phiếu thử', $4, $5, $6, $7, $8)`;

describe('migration', () => {
  it('md5 lượt hai được tiền kiểm nhận đúng bằng thân của chính file', () => {
    const sql = readFileSync(FILE, 'utf8');
    expect(md5SauLuotMot).toMatch(/^[0-9a-f]{32}$/);
    expect(sql).toContain(`'${PROD_MD5}', '${md5SauLuotMot}'`);
  });

  it('chặn chạy khi thân trigger phiếu lạ', async () => {
    await trongGiaoDich(async () => {
      await chay(`CREATE OR REPLACE FUNCTION public.income_expenses_check_profit_lock() RETURNS trigger
        LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$;`);
      const block = readFileSync(FILE, 'utf8').replace(/^BEGIN;$/m, '').replace(/^COMMIT;$/m, '');
      await expect(db.exec(block)).rejects.toMatchObject({ code: '55000' });
    });
  });

  it('thân production giữ nguyên từng chữ, chỉ thêm cửa kỳ (khai biến, tính, đường nhanh, raise)', () => {
    const goc = sliceFunction(KHOA_NGAY, 'CREATE OR REPLACE FUNCTION public.income_expenses_check_profit_lock()', '$function$;');
    const moi = sliceFunction(FILE, 'CREATE OR REPLACE FUNCTION public.income_expenses_check_profit_lock()', '$function$;');
    // Đúng các dòng THÊM, theo thứ tự; mọi dòng khác (bỏ chú thích) trùng thân production.
    const THEM = [
      '  v_ky_cu date;',
      '  v_ky_moi date;',
      "  IF TG_OP <> 'INSERT' THEN",
      '    v_ky_cu := app_private.ie_profit_period_locked_month_v1(OLD, false);',
      '  END IF;',
      "  IF TG_OP <> 'DELETE' THEN",
      '    v_ky_moi := app_private.ie_profit_period_locked_month_v1(NEW, true);',
      '  END IF;',
      '',
      '    OR v_ky_cu IS NOT NULL',
      '    OR v_ky_moi IS NOT NULL',
      '  IF v_ky_cu IS NOT NULL THEN',
      '    PERFORM app_private.raise_profit_period_locked_v1(OLD.building_id, v_ky_cu);',
      '  END IF;',
      '  IF v_ky_moi IS NOT NULL THEN',
      '    PERFORM app_private.raise_profit_period_locked_v1(NEW.building_id, v_ky_moi);',
      '  END IF;',
      '',
    ];
    const dong = (s: string) => s.split('\n').filter((l) => !/^\s*--/.test(l));
    const a = dong(goc);
    let j = 0;
    let k = 0;
    for (const line of dong(moi)) {
      if (j < a.length && line === a[j]) {
        j++;
        continue;
      }
      expect(line).toBe(THEM[k]);
      k++;
    }
    expect(j).toBe(a.length);
    expect(k).toBe(THEM.length);
    // Cửa kỳ không có cửa vượt theo người (như khoá cũ).
    expect(moi.replace(/--[^\n]*/g, '')).not.toMatch(/is_org_owner_v1|is_super_admin|auth\.uid|business_result_accounting/);
  });
});

describe('khoá theo KỲ khi lập / sửa / duyệt', () => {
  it('lập tay phiếu ngày tháng mở, kỳ trong tháng đã chốt ⇒ chặn — với mọi người (chủ, super admin, job)', async () => {
    for (const nguoi of [CHU_A, SUPER, null]) {
      await trongGiaoDich(async () => {
        await laNguoi(nguoi);
        const pid = id(900);
        await qua(DAU, [pid, ORG_A, TOA_A, 'EXPENSE', '2025-09-15', 'APPROVED', null, null]);
        await biChanKy(DONG, [pid, 100_000, LOAI_CHI, '2025-08-01', '2025-08-31']);
      });
    }
  });

  it('phiếu CHỜ DUYỆT có kỳ trong tháng đã chốt cũng không lập được', async () => {
    await trongGiaoDich(async () => {
      const pid = id(901);
      await qua(DAU, [pid, ORG_A, TOA_A, 'EXPENSE', '2025-09-15', 'UNAPPROVED', null, null]);
      await biChanKy(DONG, [pid, 100_000, LOAI_CHI, '2025-07-01', '2025-08-31']);
    });
  });

  it('kỳ tháng mở / không kỳ / kỳ ngược bắt đầu tháng mở ⇒ qua; kỳ ngược bắt đầu tháng chốt, kỳ phủ ⇒ chặn', async () => {
    await trongGiaoDich(async () => {
      const pid = id(902);
      await qua(DAU, [pid, ORG_A, TOA_A, 'EXPENSE', '2025-09-15', 'APPROVED', null, null]);
      await qua(DONG, [pid, 100_000, LOAI_CHI, '2025-09-01', '2025-09-30']);
      await qua(DONG, [pid, 100_000, LOAI_CHI, null, null]);
      await qua(DONG, [pid, 100_000, LOAI_CHI, '2025-09-01', null]);
      await qua(DONG, [pid, 100_000, LOAI_CHI, '2025-09-10', '2025-08-05']);
      await qua(DONG, [pid, 100_000, LOAI_CHI, '2025-07-01', '2025-07-31']);
      await biChanKy(DONG, [pid, 100_000, LOAI_CHI, '2025-08-10', '2025-07-05']);
      await biChanKy(DONG, [pid, 100_000, LOAI_CHI, '2025-06-01', '2025-10-31']);
    });
  });

  it('dòng không tính KQKD (cọc) qua; phiếu ép KQKD thì dòng cọc cũng bị chặn; tắt KQKD thì qua, bật lại ⇒ chặn', async () => {
    await trongGiaoDich(async () => {
      const [a, b, c] = [id(903), id(904), id(905)];
      for (const [pid, kqkd] of [[a, null], [b, true], [c, false]] as const) {
        await qua(DAU, [pid, ORG_A, TOA_A, 'INCOME', '2025-09-15', 'APPROVED', kqkd, null]);
      }
      await qua(DONG, [a, 100_000, LOAI_COC, '2025-08-01', '2025-08-31']);
      await biChanKy(DONG, [b, 100_000, LOAI_COC, '2025-08-01', '2025-08-31']);
      await qua(DONG, [c, 100_000, LOAI_THU, '2025-08-01', '2025-08-31']);
      await biChanKy('UPDATE public.income_expenses SET business_result_accounting = NULL WHERE id = $1', [c]);
    });
  });

  it('DUYỆT phiếu chờ có kỳ trong tháng đã chốt ⇒ chặn; sửa phiếu chờ đó ⇒ chặn; sửa kỳ dòng sang tháng mở rồi duyệt ⇒ qua', async () => {
    await trongGiaoDich(async () => {
      await biChanKy("UPDATE public.income_expenses SET approval_status = 'APPROVED', approved_at = now() WHERE id = $1", [P.cho]);
      await biChanKy("UPDATE public.income_expenses SET name = 'Đổi tên' WHERE id = $1", [P.cho]);
      await qua(
        "UPDATE public.income_expense_items SET start_date = '2025-09-01', end_date = '2025-09-30' WHERE income_expense_id = $1",
        [P.cho]);
      await qua("UPDATE public.income_expenses SET approval_status = 'APPROVED', approved_at = now() WHERE id = $1", [P.cho]);
    });
  });

  it('chỉ đổi kỳ dòng (tổng phiếu không đổi) vào tháng đã chốt ⇒ cửa hạng mục chặn — phiếu chờ duyệt và đã duyệt', async () => {
    await trongGiaoDich(async () => {
      const cho = await phieu({ ngay: '2025-09-12', tao: '2025-09-12T03:00:00Z', trangThai: 'UNAPPROVED',
        dong: [{ tien: 50_000, tu: '2025-09-01', den: '2025-09-30' }] });
      await biChanKy("UPDATE public.income_expense_items SET start_date = '2025-08-01', end_date = '2025-08-31' WHERE income_expense_id = $1", [cho]);
      await biChanKy("UPDATE public.income_expense_items SET start_date = '2025-08-01', end_date = '2025-08-31' WHERE income_expense_id = $1", [P.t9]);
    });
  });

  it('phiếu chờ duyệt kẹt (kỳ trong tháng đã chốt) vẫn HUỶ / XOÁ được', async () => {
    await trongGiaoDich(async () => {
      await qua("UPDATE public.income_expenses SET approval_status = 'CANCELLED' WHERE id = $1", [P.cho]);
    });
    await trongGiaoDich(async () => {
      await qua('UPDATE public.income_expenses SET deleted_at = now() WHERE id = $1', [P.cho]);
    });
    await trongGiaoDich(async () => {
      await qua('DELETE FROM public.income_expense_items WHERE income_expense_id = $1', [P.cho]);
      await qua('DELETE FROM public.income_expenses WHERE id = $1', [P.cho]);
    });
  });

  it('phiếu đã duyệt có kỳ trong tháng đã chốt: huỷ / xoá / đổi tiền / đổi ngày / đổi sổ / sửa dòng ⇒ chặn', async () => {
    for (const pid of [P.truocKy, P.sau]) {
      await trongGiaoDich(async () => {
        await biChanKy("UPDATE public.income_expenses SET approval_status = 'CANCELLED' WHERE id = $1", [pid]);
        await biChanKy('UPDATE public.income_expenses SET deleted_at = now() WHERE id = $1', [pid]);
        await biChanKy("UPDATE public.income_expenses SET voucher_date = '2025-09-20' WHERE id = $1", [pid]);
        await biChanKy('UPDATE public.income_expenses SET account_id = $2 WHERE id = $1', [pid, id(991)]);
        await biChanKy("UPDATE public.income_expenses SET notes = 'sửa' WHERE id = $1", [pid]);
        await biChanKy('UPDATE public.income_expense_items SET amount = 1 WHERE income_expense_id = $1', [pid]);
        await biChanKy("UPDATE public.income_expense_items SET description = 'ghi chú' WHERE income_expense_id = $1", [pid]);
        await biChanKy("UPDATE public.income_expense_items SET start_date = '2025-09-01', end_date = '2025-09-30' WHERE income_expense_id = $1", [pid]);
        await biChanKy(DONG, [pid, 1_000, LOAI_CHI, '2025-09-01', '2025-09-30']);
        await biChanKy('DELETE FROM public.income_expense_items WHERE income_expense_id = $1', [pid]);
        await biChanKy('DELETE FROM public.income_expenses WHERE id = $1', [pid]);
      });
    }
  });

  it('phiếu kỳ hai tháng (T8 chốt, T9 mở): cả phiếu bị khoá', async () => {
    await trongGiaoDich(async () => {
      await biChanKy("UPDATE public.income_expenses SET notes = 'sửa' WHERE id = $1", [P.haiThang]);
      await biChanKy('UPDATE public.income_expense_items SET amount = 1 WHERE income_expense_id = $1', [P.haiThang]);
    });
  });

  it('ngoại lệ không đổi tiền vẫn qua (đã kiểm, bàn giao, dời lịch, cột vòng đời NULL→giá trị, tắt lặp, gắn hợp đồng)', async () => {
    await trongGiaoDich(async () => {
      await qua("UPDATE public.income_expenses SET verified_at = now(), verified_note = 'ok', verified_by = $2 WHERE id = $1", [P.truocKy, CHU_A]);
      await qua('UPDATE public.income_expenses SET handover_id = $2 WHERE id = $1', [P.truocKy, id(990)]);
      await qua("UPDATE public.income_expenses SET repeat_next_date = '2025-12-01', repeat_remaining = 2 WHERE id = $1", [P.truocKy]);
      await qua("UPDATE public.income_expenses SET posting_status = 'POSTED', review_state = 'OK' WHERE id = $1", [P.truocKy]);
      await qua('UPDATE public.income_expenses SET has_restricted_item = true WHERE id = $1', [P.truocKy]);
      // posting_status đã có giá trị ⇒ đổi tiếp là đổi thật ⇒ chặn
      await biChanKy("UPDATE public.income_expenses SET posting_status = 'REVERSED' WHERE id = $1", [P.truocKy]);
    });
    await trongGiaoDich(async () => {
      await biChanKy('UPDATE public.income_expenses SET contract_id = $2 WHERE id = $1', [P.truocKy, id(992)]);
      await db.query(
        `INSERT INTO app_private.ie_flex_writer_xids VALUES ($1, pg_current_xact_id(), pg_backend_pid(), 'LINK_CONTRACT')`,
        [P.truocKy]);
      await qua('UPDATE public.income_expenses SET contract_id = $2 WHERE id = $1', [P.truocKy, id(992)]);
    });
    await trongGiaoDich(async () => {
      // Phiếu lặp có kỳ T8 (dựng khi tháng mở) ⇒ chốt ⇒ tắt lặp qua writer STOP_RECURRING vẫn được.
      await db.query("UPDATE public.profit_monthly SET locked_at = NULL WHERE building_id = $1 AND period_month = '2025-08-01'", [TOA_A]);
      await db.query("UPDATE public.income_expenses SET repeat_cycle = 'MONTH', repeat_infinity = true WHERE id = $1", [P.sau]);
      await db.query("UPDATE public.profit_monthly SET locked_at = $2 WHERE building_id = $1 AND period_month = '2025-08-01'", [TOA_A, CHOT_T8]);
      await biChanKy("UPDATE public.income_expenses SET repeat_cycle = 'NONE', repeat_infinity = false WHERE id = $1", [P.sau]);
      await db.query(
        `INSERT INTO app_private.ie_flex_writer_xids VALUES ($1, pg_current_xact_id(), pg_backend_pid(), 'STOP_RECURRING')`,
        [P.sau]);
      await qua("UPDATE public.income_expenses SET repeat_cycle = 'NONE', repeat_infinity = false WHERE id = $1", [P.sau]);
    });
  });

  it('khoá theo NGÀY PHIẾU cũ giữ nguyên câu cũ', async () => {
    await trongGiaoDich(async () => {
      const err = await loiCua(`INSERT INTO public.income_expenses(organization_id, building_id, name, type, voucher_date)
                                VALUES ($1,$2,'Ngày T8','EXPENSE','2025-08-25')`, [ORG_A, TOA_A]);
      expect(err?.message).toContain('mọi phiếu của tháng này bị khoá, không lập phiếu được');
    });
  });

  it('thu tiền hoá đơn tháng đã chốt (thu mới nợ cũ) ⇒ lập + duyệt vẫn qua, kể cả tiền thối gắn hoá đơn; hiện ở RPC', async () => {
    await trongGiaoDich(async () => {
      const [thu, thoi] = [id(906), id(907)];
      await qua(DAU, [thu, ORG_A, TOA_A, 'INCOME', '2025-09-20', 'UNAPPROVED', null, HD_T8]);
      await qua(DONG, [thu, 1_500_000, LOAI_THU, '2025-08-01', '2025-08-31']);
      await qua("UPDATE public.income_expenses SET approval_status = 'APPROVED', approved_at = now() WHERE id = $1", [thu]);
      await qua(DAU, [thoi, ORG_A, TOA_A, 'EXPENSE', '2025-09-20', 'APPROVED', null, HD_T8]);
      await qua(DONG, [thoi, 20_000, LOAI_CHI, null, null]);
      const r = await rpc(CHU_A, '2025-08-01', '2025-08-01', [TOA_A]);
      expect(ma(r.after_lock)).toEqual(expect.arrayContaining([thu, thoi]));
      const by = new Map((r.after_lock as Json[]).map((v) => [v.voucher_id as string, v]));
      expect(by.get(thu)).toMatchObject({ income: 1_500_000, expense: 0, invoice_month: '2025-08' });
      expect(by.get(thoi)).toMatchObject({ income: 0, expense: 20_000, invoice_month: '2025-08' });
    });
  });

  it('phiếu ở toà chưa chốt tháng đó ⇒ qua', async () => {
    await trongGiaoDich(async () => {
      const pid = id(908);
      await qua(DAU, [pid, ORG_A, TOA_A2, 'EXPENSE', '2025-09-15', 'APPROVED', null, null]);
      await qua(DONG, [pid, 100_000, LOAI_CHI, '2025-08-01', '2025-08-31']);
    });
  });

  it('dời phiếu sang toà / khôi phục phiếu đã huỷ vào tháng đã chốt ⇒ chặn', async () => {
    await trongGiaoDich(async () => {
      await biChanKy('UPDATE public.income_expenses SET building_id = $2 WHERE id = $1', [P.toaA2, TOA_A], '08/2025', '44TA');
      await biChanKy("UPDATE public.income_expenses SET approval_status = 'APPROVED' WHERE id = $1", [P.huy]);
    });
  });

  it('mở khoá tháng ⇒ lập được lại', async () => {
    await trongGiaoDich(async () => {
      await db.query(`UPDATE public.profit_monthly SET locked_at = NULL, status = 'DRAFT'
                       WHERE building_id = $1 AND period_month = '2025-08-01'`, [TOA_A]);
      const pid = id(909);
      await qua(DAU, [pid, ORG_A, TOA_A, 'EXPENSE', '2025-09-15', 'APPROVED', null, null]);
      await qua(DONG, [pid, 100_000, LOAI_CHI, '2025-08-01', '2025-08-31']);
    });
  });

  it('job sinh phiếu định kỳ: kỳ con trong tháng đã chốt bị bỏ qua, cả lượt vẫn chạy', async () => {
    await trongGiaoDich(async () => {
      const { rows } = await db.query<{ voucher_date: string }>(
        "SELECT to_char(voucher_date, 'YYYY-MM-DD') AS voucher_date FROM public.generate_recurring_vouchers(NULL) ORDER BY 1");
      expect(rows.map((r) => r.voucher_date)).toEqual(['2025-09-15', '2025-10-15']);
      const con = await db.query<{ n: number }>(
        'SELECT count(*)::int AS n FROM public.income_expenses WHERE repeat_parent_id = $1', [P.cha]);
      expect(con.rows[0].n).toBe(2);
    });
  });

  it('job sinh phiếu định kỳ: phiếu cha nằm trong tháng đã chốt (cả ngày lẫn kỳ) vẫn được dời lịch; phiếu cha khác vẫn sinh', async () => {
    await trongGiaoDich(async () => {
      // Chốt thêm T7 toà A: phiếu cha (ngày + kỳ T7) bị khoá, chỉ còn ngoại lệ dời lịch.
      await db.query("INSERT INTO public.profit_monthly(building_id, period_month, status, locked_at) VALUES ($1, '2025-07-01', 'LOCKED', $2)",
        [TOA_A, CHOT_T8]);
      const cha2 = await phieu({ toa: TOA_A2, ngay: '2025-09-29', tao: '2025-09-29T03:00:00Z', dong: [{ tien: 10_000 }] });
      await db.query("UPDATE public.income_expenses SET repeat_cycle = 'WEEK', repeat_infinity = true WHERE id = $1", [cha2]);
      const { rows } = await db.query<{ parent_id: string; voucher_date: string }>(
        "SELECT parent_id, to_char(voucher_date, 'YYYY-MM-DD') AS voucher_date FROM public.generate_recurring_vouchers(NULL)");
      expect(rows.filter((r) => r.parent_id === P.cha).map((r) => r.voucher_date).sort()).toEqual(['2025-09-15', '2025-10-15']);
      expect(rows.filter((r) => r.parent_id === cha2)).toHaveLength(3);
      // Ghi sổ dời lịch phiếu cha (khối EXCEPTION riêng — lỗi sẽ im lặng) phải thật sự ghi được.
      const cha = await db.query<{ d: string | null }>(
        "SELECT to_char(repeat_next_date, 'YYYY-MM-DD') AS d FROM public.income_expenses WHERE id = $1", [P.cha]);
      expect(cha.rows[0].d).not.toBeNull();
    });
  });
});

describe('luật tháng của dòng khớp fa_accrual_allocations', () => {
  it('mọi (phiếu, tháng) không theo hoá đơn trùng với định nghĩa SỐNG', async () => {
    await trongGiaoDich(async () => {
      await laNguoi(CHU_A);
      const fa = await db.query<{ k: string }>(
        `SELECT DISTINCT a.voucher_id || '|' || a.month AS k
           FROM public.fa_accrual_allocations('2024-01-01', '2026-12-01', $1::uuid[]) a
           JOIN public.income_expenses v ON v.id = a.voucher_id
          WHERE v.invoice_id IS NULL
            AND EXISTS (SELECT 1 FROM public.income_expense_items i WHERE i.income_expense_id = v.id)`,
        [[TOA_A, TOA_A2]]);
      const moi = await db.query<{ k: string }>(
        `SELECT DISTINCT v.id || '|' || m.m AS k
           FROM public.income_expenses v
           JOIN public.income_expense_items i ON i.income_expense_id = v.id
           CROSS JOIN LATERAL app_private.profit_line_months_v1(v.voucher_date, i.start_date, i.end_date) AS m(m)
          WHERE v.building_id = ANY ($1::uuid[]) AND v.invoice_id IS NULL AND v.deleted_at IS NULL
            AND v.approval_status = 'APPROVED' AND v.business_result_accounting IS DISTINCT FROM false
            AND (v.business_result_accounting IS TRUE OR i.accounting_class = 'PNL')`,
        [[TOA_A, TOA_A2]]);
      expect(fa.rows.length).toBeGreaterThan(5);
      expect(moi.rows.map((r) => r.k).sort()).toEqual(fa.rows.map((r) => r.k).sort());
    });
  });

  it('tháng khoá theo kỳ của phiếu = tháng chốt mà fa_accrual_allocations đổ dòng vào', async () => {
    await trongGiaoDich(async () => {
      await laNguoi(CHU_A);
      const { rows } = await db.query<{ id: string; m: string | null; fa: string | null }>(
        `SELECT v.id,
                app_private.ie_profit_period_locked_month_v1(v, false)::text AS m,
                (SELECT min(a.month)::text FROM public.fa_accrual_allocations('2024-01-01', '2026-12-01', ARRAY[v.building_id]) a
                  WHERE a.voucher_id = v.id
                    AND EXISTS (SELECT 1 FROM public.profit_monthly pm WHERE pm.building_id = v.building_id
                                 AND pm.period_month = a.month AND pm.locked_at IS NOT NULL)) AS fa
           FROM public.income_expenses v
          WHERE v.building_id = ANY ($1::uuid[]) AND v.invoice_id IS NULL`, [[TOA_A, TOA_A2]]);
      for (const r of rows) expect(r.m, r.id).toBe(r.fa);
      expect(rows.filter((r) => r.m !== null).length).toBeGreaterThan(4);
    });
  });
});

describe('RPC phát sinh sau chốt', () => {
  it('đúng luật kỳ: lập/duyệt sau chốt ⇒ có; trước chốt / chờ duyệt / huỷ / ngoài KQKD ⇒ không', async () => {
    const r = await trongGiaoDich(() => rpc(CHU_A, '2025-08-01', '2025-08-01', [TOA_A, TOA_A2, TOA_B]));
    expect(profitPostLockSchema.parse(r)).toBeTruthy();
    expect((r.locked as Json[]).map((l) => l.building_id)).toEqual([TOA_A]);
    expect(ma(r.after_lock)).toEqual([P.duyetSau, P.sau, P.haiThang, P.hanChe, P.thuHd].sort());
    const by = new Map((r.after_lock as Json[]).map((v) => [v.voucher_id as string, v]));
    expect(by.get(P.sau)).toMatchObject({ income: 0, expense: 1_200_000, month: '2025-08-01', type: 'EXPENSE',
      voucher_date: '2025-09-05', period_from: '2025-08-01', period_to: '2025-08-31', building_name: '44TA',
      invoice_month: null });
    // kỳ 2 tháng: phần T8 làm tròn như canonical (1.000.001 ⇒ 500.001 + 500.000)
    expect(by.get(P.haiThang)).toMatchObject({ expense: 500_001 });
    expect(by.get(P.thuHd)).toMatchObject({ income: 3_000_000, invoice_month: '2025-08', type: 'INCOME' });
    expect(String(by.get(P.sau)?.locked_at)).toContain('2025-09-03');
  });

  it('khoảng T8–T9: phiếu kỳ hai tháng chỉ có phần T8 (T9 chưa chốt)', async () => {
    const r = await trongGiaoDich(() => rpc(CHU_A, '2025-08-01', '2025-09-01', [TOA_A]));
    const hai = (r.after_lock as Json[]).filter((v) => v.voucher_id === P.haiThang);
    expect(hai).toHaveLength(1);
    expect(hai[0]).toMatchObject({ month: '2025-08-01' });
    expect((r.locked as Json[]).map((l) => l.month)).toEqual(['2025-08-01']);
  });

  it('tháng chưa chốt ⇒ rỗng', async () => {
    const r = await trongGiaoDich(() => rpc(CHU_A, '2025-09-01', '2025-09-01', [TOA_A]));
    expect(r).toMatchObject({ locked: [], after_lock: [] });
  });

  it('chốt lại sau khi duyệt ⇒ không còn là phát sinh sau chốt; mở khoá ⇒ rỗng', async () => {
    await trongGiaoDich(async () => {
      await db.query(`UPDATE public.profit_monthly SET locked_at = '2025-09-30T00:00:00Z'
                       WHERE building_id = $1 AND period_month = '2025-08-01'`, [TOA_A]);
      const r = await rpc(CHU_A, '2025-08-01', '2025-08-01', [TOA_A]);
      expect(ma(r.after_lock)).toEqual([]);
    });
    await trongGiaoDich(async () => {
      await db.query(`UPDATE public.profit_monthly SET locked_at = NULL, status = 'DRAFT'
                       WHERE building_id = $1 AND period_month = '2025-08-01'`, [TOA_A]);
      const r = await rpc(CHU_A, '2025-08-01', '2025-08-01', [TOA_A]);
      expect(r).toMatchObject({ locked: [], after_lock: [] });
    });
  });

  it('phiếu hạn chế: người không được xem thấy tiền, không thấy mã/tên', async () => {
    const r = await trongGiaoDich(() => rpc(NV_A, '2025-08-01', '2025-08-01', [TOA_A]));
    const h = (r.after_lock as Json[]).find((v) => v.voucher_id === P.hanChe);
    expect(h).toMatchObject({ restricted: true, code: null, name: null, expense: 2_000_000 });
    const r2 = await trongGiaoDich(() => rpc(CHU_A, '2025-08-01', '2025-08-01', [TOA_A]));
    expect((r2.after_lock as Json[]).find((v) => v.voucher_id === P.hanChe)).toMatchObject({ restricted: false, code: 'PXHANCHE' });
  });

  it('quyền: công ty khác chỉ thấy toà mình; người ngoài rỗng; danh sách NULL = mọi toà xem được', async () => {
    const b = await trongGiaoDich(() => rpc(CHU_B, '2025-08-01', '2025-08-01', [TOA_A, TOA_B]));
    expect((b.locked as Json[]).map((l) => l.building_id)).toEqual([TOA_B]);
    expect(ma(b.after_lock)).toEqual([P.toaB]);
    const ngoai = await trongGiaoDich(() => rpc(NGOAI, '2025-08-01', '2025-08-01', null));
    expect(ngoai).toMatchObject({ locked: [], after_lock: [] });
    const tatCa = await trongGiaoDich(() => rpc(CHU_A, '2025-08-01', '2025-08-01', null));
    expect((tatCa.locked as Json[]).map((l) => l.building_id)).toEqual([TOA_A]);
    const sup = await trongGiaoDich(() => rpc(SUPER, '2025-08-01', '2025-08-01', null));
    expect((sup.locked as Json[]).map((l) => l.building_id).sort()).toEqual([TOA_A, TOA_B].sort());
  });

  it('anon / chưa đăng nhập ⇒ 42501; khoảng tháng sai ⇒ 22023', async () => {
    await trongGiaoDich(async () => {
      await asUser(null);
      const e1 = await loiCua("SELECT public.profit_post_lock_vouchers_v1('2025-08-01', '2025-08-01', NULL)");
      expect(e1?.code).toBe('42501');
    });
    await trongGiaoDich(async () => {
      await db.exec('RESET ROLE');
      await laNguoi(null);
      await db.exec('SET LOCAL ROLE authenticated');
      const e2 = await loiCua("SELECT public.profit_post_lock_vouchers_v1('2025-08-01', '2025-08-01', NULL)");
      expect(e2?.code).toBe('42501');
    });
    await trongGiaoDich(async () => {
      await asUser(CHU_A);
      expect((await loiCua("SELECT public.profit_post_lock_vouchers_v1('2025-09-01', '2025-08-01', NULL)"))?.code).toBe('22023');
      expect((await loiCua("SELECT public.profit_post_lock_vouchers_v1('2022-01-01', '2025-08-01', NULL)"))?.code).toBe('22023');
    });
  });

  it('ACL: anon không gọi được, authenticated gọi được; hàm nội bộ đóng', async () => {
    const { rows } = await db.query<{ anon: boolean; auth: boolean; noi_bo: boolean; trg: boolean }>(`
      SELECT has_function_privilege('anon', 'public.profit_post_lock_vouchers_v1(date,date,uuid[])', 'EXECUTE') AS anon,
             has_function_privilege('authenticated', 'public.profit_post_lock_vouchers_v1(date,date,uuid[])', 'EXECUTE') AS auth,
             has_function_privilege('authenticated', 'app_private.ie_profit_period_locked_month_v1(public.income_expenses,boolean)', 'EXECUTE') AS noi_bo,
             has_function_privilege('authenticated', 'app_private.guard_ie_item_profit_period_v1()', 'EXECUTE') AS trg`);
    expect(rows[0]).toEqual({ anon: false, auth: true, noi_bo: false, trg: false });
  });
});
