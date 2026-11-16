// Phiếu ĐÃ DUYỆT của tháng đã chốt lợi nhuận vẫn CHI / THU (ghi sổ) được — migration
// 20261116090142 (chủ chốt 16/11/2026: "Cho phép Chi qua khoá: phiếu đã duyệt của tháng đã chốt
// vẫn chi được, vì chi không đổi lợi nhuận tháng đó").
//
// Chạy THẬT trên PostgreSQL nhúng (PGlite):
//   - thân trigger phiếu ĐANG CHẠY production (cắt từ 20261022172918, tái lập md5 6e016a8f…) gắn
//     vào bảng như production; dữ liệu dựng khi tháng còn mở rồi mới chốt tháng;
//   - migration áp HAI lượt (lane kiểm idempotency);
//   - khoá ngày phiếu, luật kỳ, fa_accrual_allocations: định nghĩa SỐNG trong thư mục migration.
// Kiểm: đúng hai bước của nút Chi lọt qua khoá (ghi sổ phiếu đã duyệt bằng RPC vòng đời V2, thêm
// ảnh chứng từ khi phiếu còn chờ ghi sổ); mọi thứ khác vẫn bị chặn như cũ — không token, bút toán
// giả, kèm đổi cột tiền, duyệt, huỷ duyệt, hoàn tác ghi sổ, huỷ, xoá, gỡ ảnh, sửa ghi chú; lợi
// nhuận tháng đã chốt không đổi sau khi chi.
// Mọi số tiền / mã phiếu / tên ở đây là giả.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const TEN_FILE = '20261116090142_chi_phieu_da_duyet_qua_khoa_thang_ln.sql';
const FILE = process.env.CHI_QUA_KHOA_MIGRATION_FILE
  ?? 'supabase/migrations/20261116090142_chi_phieu_da_duyet_qua_khoa_thang_ln.sql';
const KHOA_KY = 'supabase/migrations/20261022172918_khoa_ky_thang_da_chot_ln.sql';
const PROD_MD5 = '6e016a8f60e83129cfb6cf2ad2829fb5';
// Chỉ cho scripts/dot-bien.mjs: thân trigger bị đột biến không khớp md5 ghim nên bỏ phép ghim và
// lượt hai, để ca hành vi (không phải phép ghim) là thứ phải đỏ.
const DOT_BIEN = process.env.CHI_QUA_KHOA_DOT_BIEN === '1';
const MIG_DIR = join(process.cwd(), 'supabase', 'migrations');
const DAU_HAM = 'CREATE OR REPLACE FUNCTION public.income_expenses_check_profit_lock()';

function sliceFunction(path: string, header: string, end: string): string {
  const sql = readFileSync(path, 'utf8');
  const start = sql.indexOf(header);
  if (start < 0) throw new Error(`Không thấy ${header} trong ${path}`);
  return sql.slice(start, sql.indexOf(end, start) + end.length);
}

/** Định nghĩa SỐNG: CREATE cuối cùng theo thứ tự tên file (bỏ file đang kiểm), bỏ chú thích. */
let corpus: string[] | null = null;
function liveFunctionSql(schema: string, fnName: string): string {
  corpus ??= readdirSync(MIG_DIR).filter((f) => f.endsWith('.sql') && f !== TEN_FILE).sort()
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
const [ORG, CHU] = [1, 2].map(id);
const TOA = id(11);
const [LOAI_CHI, LOAI_THU] = [21, 22].map(id);
const [SO_A, SO_B] = [31, 32].map(id);
const ANH_CU = 'https://kho.test/cu.png';
const ANH_MOI = 'https://kho.test/moi.png';

const db = new PGlite();

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
const CAU_KHOA_NGAY = (viec: string) =>
  `[PROFIT_LOCKED] Tháng 09/2026 của toà 99XY đã chốt lợi nhuận — mọi phiếu của tháng này bị khoá, không ${viec} được. Nhờ chủ công ty mở khoá tháng.`;
const CAU_KHOA_KY =
  '[PROFIT_LOCKED] Tháng 09/2026 của toà 99XY đã chốt lợi nhuận — không ghi được phiếu có kỳ trong tháng này. Muốn ghi: mở khoá tháng ở tab Chốt LN.';
async function biChan(sql: string, params: unknown[] = [], cau = CAU_KHOA_NGAY('sửa phiếu')) {
  const err = await loiCua(sql, params);
  expect(err?.code, err?.message ?? 'KHÔNG bị chặn').toBe('P0001');
  expect(err?.message).toBe(cau);
}
async function qua(sql: string, params: unknown[] = []) {
  const err = await loiCua(sql, params);
  expect(err?.message ?? null).toBeNull();
}

let n = 100;
async function phieu(p: {
  ngay: string; trangThai?: string; ghiSo?: string | null; so?: string; tien?: number; anh?: string[];
  ky?: [string, string]; loai?: 'INCOME' | 'EXPENSE';
}): Promise<string> {
  const pid = id(n++);
  await db.query(
    `INSERT INTO public.income_expenses(id, organization_id, building_id, code, name, type, voucher_date, approval_status,
       total_amount, user_id, approved_at, account_id, attachments, posting_mode, posting_status)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb,'CASHBOOK',$14)`,
    [pid, ORG, TOA, `PX${n}`, `Phiếu ${n}`, p.loai ?? 'EXPENSE', p.ngay, p.trangThai ?? 'APPROVED', p.tien ?? 1_234_000, CHU,
      (p.trangThai ?? 'APPROVED') === 'APPROVED' ? '2026-09-06T03:00:00Z' : null, p.so ?? SO_A,
      JSON.stringify(p.anh ?? []), p.ghiSo === undefined ? 'UNPOSTED' : p.ghiSo],
  );
  await db.query(
    `INSERT INTO public.income_expense_items(income_expense_id, amount, income_expense_type_id, start_date, end_date)
     VALUES ($1,$2,$3,$4,$5)`,
    [pid, p.tien ?? 1_234_000, p.loai === 'INCOME' ? LOAI_THU : LOAI_CHI, p.ky?.[0] ?? null, p.ky?.[1] ?? null],
  );
  return pid;
}

/** Bút toán như finance_v2_post_manual_voucher ghi (bảng bút toán không dính khoá tháng). */
async function butToan(voucher: string, so: string, o: { kind?: string; daoCua?: string | null } = {}): Promise<string> {
  const r = await db.query<{ id: string }>(
    `INSERT INTO public.income_expense_postings(voucher_id, account_id, event_kind, posted_on, reversal_of_id)
     VALUES ($1,$2,$3,'2026-11-16',$4) RETURNING id`,
    [voucher, so, o.kind ?? 'POSTING', o.daoCua ?? null]);
  return r.rows[0].id;
}
/** Token vòng đời V2 như finance_v2_begin_canonical_op cấp. */
async function token(voucher: string, purpose = 'FINANCE_V2_LIFECYCLE', xid = 'pg_current_xact_id()') {
  await db.query(
    `INSERT INTO app_private.ie_transition_authorization(income_expense_id, xid, purpose)
     VALUES ($1, ${xid}, $2)
     ON CONFLICT (income_expense_id) DO UPDATE SET xid = EXCLUDED.xid, purpose = EXCLUDED.purpose`,
    [voucher, purpose]);
}
/** Đúng câu đóng dấu đầu phiếu của post_approved_income_expense_v2. */
const DONG_DAU = `UPDATE public.income_expenses ie
   SET active_posting_id_v2 = $2, posting_status = 'POSTED', account_id = $3, reversed_by_posting_id = NULL,
       posting_id = $2, posted_at_v2 = now(), posting_version = ie.posting_version + 1, updated_at = now()`;
const GHI_SO = `${DONG_DAU} WHERE ie.id = $1`;
async function scope(voucher: string, ten: string) {
  await db.query(
    `INSERT INTO app_private.ie_flex_writer_xids(income_expense_id, transaction_id, backend_pid, scope)
     VALUES ($1, pg_current_xact_id(), pg_backend_pid(), $2)`, [voucher, ten]);
}
const THEM_ANH = 'UPDATE public.income_expenses SET attachments = $2::jsonb WHERE id = $1';
const j = (v: unknown) => JSON.stringify(v);
async function hang(voucher: string) {
  const r = await db.query<Record<string, unknown>>('SELECT * FROM public.income_expenses WHERE id = $1', [voucher]);
  return r.rows[0];
}
async function loiNhuanT9(): Promise<string> {
  await db.query("SELECT set_config('request.jwt.claim.sub', $1, true)", [CHU]);
  const r = await db.query<{ s: string }>(
    `SELECT COALESCE(jsonb_agg(to_jsonb(a) ORDER BY a.voucher_id, a.month, a.side, a.type_id), '[]')::text AS s
       FROM public.fa_accrual_allocations('2026-09-01', '2026-09-30', ARRAY['${TOA}']::uuid[]) a`);
  return r.rows[0].s;
}

const P: Record<string, string> = {};
let md5SauLuotMot = '';

beforeAll(async () => {
  await chay(`
    CREATE ROLE authenticated; CREATE ROLE anon; CREATE ROLE service_role;
    CREATE SCHEMA auth; CREATE SCHEMA app_private;
    CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE
      AS $$ SELECT nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
    CREATE TABLE public.memberships(user_id uuid, organization_id uuid);
    CREATE FUNCTION public.is_super_admin() RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT false $$;
    CREATE TABLE public.buildings(id uuid PRIMARY KEY, organization_id uuid, name text,
      is_virtual boolean DEFAULT false, deleted_at timestamptz);
    CREATE FUNCTION public.can_access_building(_building_id uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER
      AS $$ SELECT EXISTS (SELECT 1 FROM public.buildings b JOIN public.memberships m
             ON m.organization_id = b.organization_id WHERE b.id = _building_id AND m.user_id = auth.uid()) $$;
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
      repeat_cycle text DEFAULT 'NONE', repeat_infinity boolean DEFAULT false, repeat_count integer DEFAULT 0,
      repeat_remaining integer DEFAULT 0, repeat_next_date date, handover_id uuid, verified_at timestamptz,
      verified_by uuid, verified_by_name text, verified_note text, posting_mode text, posting_status text,
      review_state text, approval_version bigint NOT NULL DEFAULT 1, posting_version bigint NOT NULL DEFAULT 0,
      active_posting_id_v2 uuid, posting_id uuid, reversed_by_posting_id uuid, posted_at_v2 timestamptz,
      cancellation_kind text);
    CREATE TABLE public.income_expense_items(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), income_expense_id uuid,
      amount numeric, unit_price numeric DEFAULT 0, quantity numeric DEFAULT 1, accounting_class text DEFAULT 'PNL',
      income_expense_type_id uuid, start_date date, end_date date, description text);
    CREATE TABLE public.income_expense_postings(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), voucher_id uuid,
      account_id uuid NOT NULL, event_kind text NOT NULL, posted_on date NOT NULL, reversal_of_id uuid);
    CREATE TABLE public.profit_monthly(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), building_id uuid,
      period_month date, status text, locked_at timestamptz, UNIQUE (building_id, period_month));
    CREATE TABLE public.building_fee_accounts(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), building_id uuid,
      fee_category text, default_amount numeric, not_applicable boolean NOT NULL DEFAULT false, deleted_at timestamptz);
    CREATE TABLE app_private.ie_flex_writer_xids(income_expense_id uuid, transaction_id xid8, backend_pid integer,
      scope text);
    CREATE TABLE app_private.ie_transition_authorization(income_expense_id uuid PRIMARY KEY, xid xid8 NOT NULL,
      purpose text NOT NULL, granted_at timestamptz NOT NULL DEFAULT clock_timestamp());

    INSERT INTO public.memberships VALUES ('${CHU}','${ORG}');
    INSERT INTO public.buildings(id, organization_id, name) VALUES ('${TOA}','${ORG}','99XY');
    INSERT INTO public.income_expense_types(id, name, category) VALUES
      ('${LOAI_CHI}','Hoa hồng','Hoa hồng'),('${LOAI_THU}','Tiền phòng','Phòng');
  `);
  for (const sql of [
    liveFunctionSql('public', 'fa_accrual_allocations'),
    liveFunctionSql('app_private', 'profit_month_locked_v1'),
    liveFunctionSql('app_private', 'assert_profit_month_open_v2'),
    liveFunctionSql('app_private', 'profit_line_months_v1'),
    liveFunctionSql('app_private', 'profit_line_locked_month_v1'),
    liveFunctionSql('app_private', 'ie_invoice_month_v1'),
    liveFunctionSql('app_private', 'ie_invoice_locked_month_v1'),
    liveFunctionSql('app_private', 'ie_profit_period_locked_month_v1'),
    liveFunctionSql('app_private', 'raise_profit_period_locked_v1'),
    // Thân trigger phiếu ĐANG CHẠY production (trước migration này).
    sliceFunction(KHOA_KY, DAU_HAM, '$function$;'),
  ]) await chay(sql);
  await chay(`
    CREATE TRIGGER a02_ie_profit_lock_ins BEFORE INSERT ON public.income_expenses
      FOR EACH ROW EXECUTE FUNCTION public.income_expenses_check_profit_lock();
    CREATE TRIGGER a02_ie_profit_lock_upd BEFORE UPDATE ON public.income_expenses
      FOR EACH ROW EXECUTE FUNCTION public.income_expenses_check_profit_lock();
    CREATE TRIGGER a02_ie_profit_lock_del BEFORE DELETE ON public.income_expenses
      FOR EACH ROW EXECUTE FUNCTION public.income_expenses_check_profit_lock();
  `);

  // Dữ liệu dựng khi tháng 09/2026 còn MỞ (như đời thật), rồi mới chốt.
  P.choChi = await phieu({ ngay: '2026-09-05', anh: [ANH_CU] });
  P.choChi2 = await phieu({ ngay: '2026-09-12', tien: 700_000 });
  P.choThu = await phieu({ ngay: '2026-09-08', loai: 'INCOME', tien: 5_000_000 });
  P.daDao = await phieu({ ngay: '2026-09-10', ghiSo: 'REVERSED', tien: 300_000 });
  P.daChi = await phieu({ ngay: '2026-09-11', ghiSo: 'POSTED', tien: 400_000, anh: [ANH_CU] });
  P.choDuyet = await phieu({ ngay: '2026-09-15', trangThai: 'UNAPPROVED', tien: 900_000, anh: [ANH_CU] });
  P.ghiSoNull = await phieu({ ngay: '2026-09-16', ghiSo: null, tien: 110_000 });
  // Ngày phiếu tháng 10 (mở) nhưng kỳ hạng mục là tháng 09 đã chốt.
  P.kyT9 = await phieu({ ngay: '2026-10-05', ky: ['2026-09-01', '2026-09-30'], tien: 1_500_000, anh: [ANH_CU] });
  P.thangMo = await phieu({ ngay: '2026-10-07', tien: 123_000 });
  const cu = await butToan(P.daChi, SO_A);
  await db.query(`UPDATE public.income_expenses SET active_posting_id_v2 = $2, posting_id = $2, posting_version = 1
                   WHERE id = $1`, [P.daChi, cu]);
  await chay(`INSERT INTO public.profit_monthly(building_id, period_month, status, locked_at)
              VALUES ('${TOA}','2026-09-01','LOCKED','2026-10-03T03:00:00Z')`);

  // Bản production phải tái lập đúng md5 trước khi áp.
  const truoc = await db.query<{ m: string }>(
    "SELECT md5(pg_get_functiondef('public.income_expenses_check_profit_lock()'::regprocedure)) AS m");
  expect(truoc.rows[0].m).toBe(PROD_MD5);
  // Trước migration: nút Chi hỏng ở cả hai bước (đúng lỗi gặp thật).
  await trongGiaoDich(async () => {
    const pt = await butToan(P.choChi, SO_A);
    await token(P.choChi);
    await biChan(GHI_SO, [P.choChi, pt, SO_A]);
    await scope(P.choChi, 'ANNOTATE');
    await biChan(THEM_ANH, [P.choChi, j([ANH_CU, ANH_MOI])]);
  });

  const sql = readFileSync(FILE, 'utf8');
  await chay(sql);
  const sau = await db.query<{ m: string }>(
    "SELECT md5(pg_get_functiondef('public.income_expenses_check_profit_lock()'::regprocedure)) AS m");
  md5SauLuotMot = sau.rows[0].m;
  if (DOT_BIEN) return;
  if (!sql.includes(md5SauLuotMot)) throw new Error(`md5 lượt hai chưa ghim: trigger ${md5SauLuotMot}`);
  await chay(sql);
}, 120_000);
afterAll(() => db.close());

describe('migration', () => {
  it('md5 lượt hai được tiền kiểm nhận đúng bằng thân của chính file', () => {
    expect(md5SauLuotMot).toMatch(/^[0-9a-f]{32}$/);
    expect(md5SauLuotMot).not.toBe(PROD_MD5);
    expect(readFileSync(FILE, 'utf8')).toContain(`'${PROD_MD5}', '${md5SauLuotMot}'`);
  });

  it('chặn chạy khi thân trigger phiếu lạ', async () => {
    await trongGiaoDich(async () => {
      await chay(`CREATE OR REPLACE FUNCTION public.income_expenses_check_profit_lock() RETURNS trigger
        LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$;`);
      const block = readFileSync(FILE, 'utf8').replace(/^BEGIN;$/m, '').replace(/^COMMIT;$/m, '');
      await expect(db.exec(block)).rejects.toMatchObject({ code: '55000' });
    });
  });

  it('thân production giữ nguyên từng chữ, chỉ thêm MỘT khối ngoại lệ liền nhau sau LINK_CONTRACT', () => {
    const goc = sliceFunction(KHOA_KY, DAU_HAM, '$function$;');
    const moi = sliceFunction(FILE, DAU_HAM, '$function$;');
    const dau = moi.indexOf('    -- 16/11/2026 (chủ chốt:');
    const moc = "  END IF;\n\n  IF TG_OP <> 'INSERT' THEN\n    PERFORM app_private.assert_profit_month_open_v2(";
    const cuoi = moi.indexOf(moc);
    expect(dau).toBeGreaterThan(0);
    expect(cuoi).toBeGreaterThan(dau);
    // Bỏ khối thêm (kèm dòng trống ngăn trước nó) ⇒ phải ra đúng thân production.
    expect(moi.slice(0, dau).replace(/\n$/, '') + moi.slice(cuoi)).toBe(goc);
    const khoi = moi.slice(dau, cuoi);
    expect(khoi).not.toMatch(/is_org_owner_v1|is_super_admin|auth\.uid|business_result_accounting/);
    expect(moi.indexOf("IF v_scope = 'LINK_CONTRACT'")).toBeLessThan(dau);
  });

  it('hàm vẫn SECURITY INVOKER và ba trigger a02 vẫn gắn', async () => {
    const r = await db.query<{ prosecdef: boolean; so: number }>(
      `SELECT p.prosecdef,
              (SELECT count(*)::int FROM pg_trigger t WHERE t.tgrelid = 'public.income_expenses'::regclass
                  AND t.tgfoid = p.oid AND t.tgenabled = 'O') AS so
         FROM pg_proc p WHERE p.oid = 'public.income_expenses_check_profit_lock()'::regprocedure`);
    expect(r.rows[0]).toEqual({ prosecdef: false, so: 3 });
  });
});

describe('ghi sổ (Chi / Thu) phiếu đã duyệt của tháng đã chốt', () => {
  it('phiếu chi đã duyệt chờ chi: RPC vòng đời V2 ghi sổ được, kể cả sang sổ quỹ khác sổ dự kiến', async () => {
    await trongGiaoDich(async () => {
      const pt = await butToan(P.choChi, SO_B);
      await token(P.choChi);
      await qua(GHI_SO, [P.choChi, pt, SO_B]);
      const h = await hang(P.choChi);
      expect(h).toMatchObject({ posting_status: 'POSTED', active_posting_id_v2: pt, posting_id: pt, account_id: SO_B,
        approval_status: 'APPROVED', total_amount: '1234000' });
      expect(String(h.posting_version)).toBe('1');
      expect((h.voucher_date as Date).toISOString().slice(0, 10)).toBe('2026-09-05');
    });
  });

  it('phiếu thu đã duyệt chờ thu, phiếu đã đảo bút toán (REVERSED) chi lại: đều qua', async () => {
    await trongGiaoDich(async () => {
      for (const v of [P.choThu, P.daDao]) {
        const pt = await butToan(v, SO_A);
        await token(v);
        await qua(GHI_SO, [v, pt, SO_A]);
        expect(await hang(v)).toMatchObject({ posting_status: 'POSTED', active_posting_id_v2: pt });
      }
    });
  });

  it('ngày phiếu ở tháng mở nhưng KỲ rơi vào tháng đã chốt: cũng chi được', async () => {
    await trongGiaoDich(async () => {
      // Không token ⇒ đúng câu khoá kỳ (chứng minh phiếu này đang nằm dưới khoá kỳ).
      const pt = await butToan(P.kyT9, SO_A);
      await biChan(GHI_SO, [P.kyT9, pt, SO_A], CAU_KHOA_KY);
      await token(P.kyT9);
      await qua(GHI_SO, [P.kyT9, pt, SO_A]);
    });
  });

  it('chi xong, lợi nhuận tháng đã chốt không đổi một dòng nào', async () => {
    await trongGiaoDich(async () => {
      const truoc = await loiNhuanT9();
      expect(truoc).toContain(P.choChi);
      for (const v of [P.choChi, P.choThu, P.kyT9]) {
        const pt = await butToan(v, SO_B);
        await token(v);
        await qua(GHI_SO, [v, pt, SO_B]);
      }
      expect(await loiNhuanT9()).toBe(truoc);
    });
  });

  it('không có token vòng đời V2 (đường ghi sổ cũ, sửa tay): chặn', async () => {
    await trongGiaoDich(async () => {
      const pt = await butToan(P.choChi, SO_A);
      await biChan(GHI_SO, [P.choChi, pt, SO_A]);
    });
  });

  it('token sai mục đích, token của transaction khác, token của phiếu khác: chặn', async () => {
    await trongGiaoDich(async () => {
      const pt = await butToan(P.choChi, SO_A);
      await token(P.choChi, 'POSTING_FLAG_REPAIR');
      await biChan(GHI_SO, [P.choChi, pt, SO_A]);
      await token(P.choChi, 'FINANCE_V2_LIFECYCLE', "'1'::xid8");
      await biChan(GHI_SO, [P.choChi, pt, SO_A]);
      await db.query('DELETE FROM app_private.ie_transition_authorization');
      await token(P.choChi2);
      await biChan(GHI_SO, [P.choChi, pt, SO_A]);
    });
  });

  it('bút toán giả: của phiếu khác, không phải POSTING, sai sổ quỹ, đã bị đảo, không tồn tại, NULL — chặn', async () => {
    await trongGiaoDich(async () => {
      await token(P.choChi);
      const cuaPhieuKhac = await butToan(P.choChi2, SO_A);
      await biChan(GHI_SO, [P.choChi, cuaPhieuKhac, SO_A]);
      const dao = await butToan(P.choChi, SO_A, { kind: 'REVERSAL' });
      await biChan(GHI_SO, [P.choChi, dao, SO_A]);
      const that = await butToan(P.choChi, SO_A);
      await biChan(GHI_SO, [P.choChi, that, SO_B]); // đầu phiếu ghi sổ khác sổ của bút toán
      await butToan(P.choChi, SO_A, { kind: 'REVERSAL', daoCua: that });
      await biChan(GHI_SO, [P.choChi, that, SO_A]); // bút toán đã bị đảo
      await biChan(GHI_SO, [P.choChi, id(999), SO_A]);
      await biChan(GHI_SO, [P.choChi, null, SO_A]);
    });
  });

  it.each([
    ['số tiền', 'total_amount = 1'],
    ['ngày phiếu sang tháng mở', "voucher_date = '2026-11-16'"],
    ['ngày phiếu trong tháng đã chốt', "voucher_date = '2026-09-06'"],
    ['tên phiếu', "name = 'đổi'"],
    ['ghi chú', "notes = 'đổi'"],
    ['ảnh', `attachments = '[]'::jsonb`],
    ['người duyệt', `approved_by = '${CHU}'`],
    ['phiên bản duyệt', 'approval_version = ie.approval_version + 1'],
    ['hợp đồng', `contract_id = '${id(77)}'`],
    ['cờ KQKD', 'business_result_accounting = false'],
    ['chế độ ghi sổ', "posting_mode = 'NON_CASH'"],
  ])('ghi sổ kèm đổi %s: chặn', async (_ten, set) => {
    await trongGiaoDich(async () => {
      const pt = await butToan(P.choChi, SO_A);
      await token(P.choChi);
      const err = await loiCua(`${DONG_DAU}, ${set} WHERE ie.id = $1`, [P.choChi, pt, SO_A]);
      expect(err?.code, err?.message ?? 'KHÔNG bị chặn').toBe('P0001');
      expect(err?.message).toContain('[PROFIT_LOCKED]');
    });
  });

  it('DUYỆT phiếu chờ duyệt, và "Duyệt và Chi" trong một câu: vẫn chặn dù có token', async () => {
    await trongGiaoDich(async () => {
      await token(P.choDuyet);
      await biChan("UPDATE public.income_expenses SET approval_status = 'APPROVED', approved_at = now() WHERE id = $1",
        [P.choDuyet]);
      const pt = await butToan(P.choDuyet, SO_A);
      await biChan(`${DONG_DAU}, approval_status = 'APPROVED' WHERE ie.id = $1`, [P.choDuyet, pt, SO_A]);
      // Chưa duyệt mà đóng dấu ghi sổ: chặn.
      await biChan(GHI_SO, [P.choDuyet, pt, SO_A]);
    });
  });

  it('hoàn tác ghi sổ, ghi sổ lại phiếu ĐÃ ghi sổ, huỷ duyệt, huỷ, xoá mềm, xoá: vẫn chặn dù có token', async () => {
    await trongGiaoDich(async () => {
      await token(P.daChi);
      const dao = await butToan(P.daChi, SO_A, { kind: 'REVERSAL' });
      await biChan(`UPDATE public.income_expenses SET posting_status = 'REVERSED', reversed_by_posting_id = $2,
                      posting_version = posting_version + 1 WHERE id = $1`, [P.daChi, dao]);
      const pt2 = await butToan(P.daChi, SO_A);
      await biChan(GHI_SO, [P.daChi, pt2, SO_A]);
      await token(P.choChi);
      await biChan("UPDATE public.income_expenses SET approval_status = 'UNAPPROVED', approved_at = NULL WHERE id = $1",
        [P.choChi]);
      await biChan("UPDATE public.income_expenses SET approval_status = 'CANCELLED' WHERE id = $1", [P.choChi]);
      await biChan('UPDATE public.income_expenses SET deleted_at = now() WHERE id = $1', [P.choChi]);
      await biChan('DELETE FROM public.income_expenses WHERE id = $1', [P.choChi], CAU_KHOA_NGAY('xoá phiếu'));
    });
  });

  it('posting_status chưa có (NULL) hoặc đích không phải POSTED: không thuộc ngoại lệ ghi sổ', async () => {
    await trongGiaoDich(async () => {
      const pt = await butToan(P.ghiSoNull, SO_A);
      await token(P.ghiSoNull);
      await biChan(GHI_SO, [P.ghiSoNull, pt, SO_A]);
      const pt2 = await butToan(P.choChi, SO_A);
      await token(P.choChi);
      await biChan(`UPDATE public.income_expenses SET active_posting_id_v2 = $2, account_id = $3,
                      posting_version = posting_version + 1 WHERE id = $1`, [P.choChi, pt2, SO_A]);
    });
  });

  it('phiếu đã xoá mềm: không ghi sổ được', async () => {
    await trongGiaoDich(async () => {
      await chay('ALTER TABLE public.income_expenses DISABLE TRIGGER a02_ie_profit_lock_upd');
      await db.query('UPDATE public.income_expenses SET deleted_at = now() WHERE id = $1', [P.choChi2]);
      await chay('ALTER TABLE public.income_expenses ENABLE TRIGGER a02_ie_profit_lock_upd');
      const pt = await butToan(P.choChi2, SO_A);
      await token(P.choChi2);
      await biChan(GHI_SO, [P.choChi2, pt, SO_A]);
    });
  });
});

describe('ảnh chứng từ của lần chi', () => {
  it('THÊM ảnh lên phiếu đã duyệt chờ chi (scope ANNOTATE): qua, ảnh cũ còn nguyên', async () => {
    await trongGiaoDich(async () => {
      await scope(P.choChi, 'ANNOTATE');
      await qua(THEM_ANH, [P.choChi, j([ANH_CU, ANH_MOI])]);
      expect((await hang(P.choChi)).attachments).toEqual([ANH_CU, ANH_MOI]);
    });
    await trongGiaoDich(async () => {
      // Phiếu chưa có ảnh nào, phiếu đã đảo bút toán, phiếu có kỳ trong tháng đã chốt.
      for (const [v, anh] of [[P.choChi2, [ANH_MOI]], [P.daDao, [ANH_MOI]], [P.kyT9, [ANH_CU, ANH_MOI]]] as const) {
        await scope(v, 'ANNOTATE');
        await qua(THEM_ANH, [v, j(anh)]);
      }
    });
  });

  it('GỠ ảnh, thay ảnh, đặt NULL / không phải mảng: chặn', async () => {
    await trongGiaoDich(async () => {
      await scope(P.choChi, 'ANNOTATE');
      await biChan(THEM_ANH, [P.choChi, j([])]);
      await biChan(THEM_ANH, [P.choChi, j([ANH_MOI])]);
      await biChan(THEM_ANH, [P.choChi, j({ a: ANH_CU })]);
      await biChan(THEM_ANH, [P.choChi, j(ANH_CU)]);
      await biChan('UPDATE public.income_expenses SET attachments = NULL WHERE id = $1', [P.choChi]);
    });
  });

  it('thêm ảnh kèm sửa ghi chú / số tiền: chặn', async () => {
    await trongGiaoDich(async () => {
      await scope(P.choChi, 'ANNOTATE');
      await biChan("UPDATE public.income_expenses SET attachments = $2::jsonb, notes = 'thêm chữ' WHERE id = $1",
        [P.choChi, j([ANH_CU, ANH_MOI])]);
      await biChan('UPDATE public.income_expenses SET attachments = $2::jsonb, total_amount = 1 WHERE id = $1',
        [P.choChi, j([ANH_CU, ANH_MOI])]);
    });
  });

  it('không có scope, scope khác ANNOTATE: chặn', async () => {
    await trongGiaoDich(async () => {
      await biChan(THEM_ANH, [P.choChi, j([ANH_CU, ANH_MOI])]);
      await scope(P.choChi, 'STOP_RECURRING');
      await biChan(THEM_ANH, [P.choChi, j([ANH_CU, ANH_MOI])]);
    });
    await trongGiaoDich(async () => {
      await token(P.choChi); // token ghi sổ không mở cửa thêm ảnh
      await biChan(THEM_ANH, [P.choChi, j([ANH_CU, ANH_MOI])]);
    });
  });

  it('phiếu ĐÃ ghi sổ, phiếu chờ duyệt, phiếu chưa có posting_status: thêm ảnh vẫn chặn (dùng Bổ sung)', async () => {
    await trongGiaoDich(async () => {
      for (const v of [P.daChi, P.choDuyet, P.ghiSoNull]) {
        await scope(v, 'ANNOTATE');
        await biChan(THEM_ANH, [v, j([ANH_CU, ANH_MOI])]);
      }
    });
  });

  it('phiếu đã xoá mềm: thêm ảnh vẫn chặn', async () => {
    await trongGiaoDich(async () => {
      await chay('ALTER TABLE public.income_expenses DISABLE TRIGGER a02_ie_profit_lock_upd');
      await db.query('UPDATE public.income_expenses SET deleted_at = now() WHERE id = $1', [P.choChi]);
      await chay('ALTER TABLE public.income_expenses ENABLE TRIGGER a02_ie_profit_lock_upd');
      await scope(P.choChi, 'ANNOTATE');
      await biChan(THEM_ANH, [P.choChi, j([ANH_CU, ANH_MOI])]);
    });
  });
});

// Test trên chép tay hai câu UPDATE của RPC. Phép so tĩnh này buộc bản chép và danh sách cột được
// miễn trong trigger khớp định nghĩa SỐNG của RPC: RPC đóng dấu thêm một cột thì ca này đỏ, thay vì
// test hành vi vẫn xanh còn nút Chi hỏng lại trên production.
describe('danh sách cột miễn khớp RPC sống', () => {
  const cotSet = (set: string) => [...set.matchAll(/([a-z_0-9]+)\s*=/g)].map((m) => m[1]).sort();

  it('câu đóng dấu ghi sổ của post_approved_income_expense_v2 đổi đúng các cột được miễn + updated_at', () => {
    const rpc = liveFunctionSql('public', 'post_approved_income_expense_v2');
    const set = /UPDATE public\.income_expenses ie\s+SET([\s\S]*?)WHERE ie\.id = v_voucher/.exec(rpc)?.[1] ?? '';
    const cot = cotSet(set);
    expect(cot.length).toBeGreaterThan(0);
    const than = sliceFunction(FILE, DAU_HAM, '$function$;');
    const mien = /to_jsonb\(OLD\) - v_mien - ARRAY\[([^\]]+)\]\)\s+IS NOT DISTINCT FROM\s+\(to_jsonb\(NEW\) - v_mien - ARRAY\[([^\]]+)\]\) THEN\s+IF EXISTS/
      .exec(than);
    const ten = (x: string | undefined) => [...(x ?? '').matchAll(/'([a-z_0-9]+)'/g)].map((m) => m[1]).sort();
    expect(ten(mien?.[1])).toEqual(ten(mien?.[2]));
    expect(than).toMatch(/v_mien := ARRAY\[[^\]]*'updated_at'\]/);
    expect(cot).toEqual([...ten(mien?.[1]), 'updated_at'].sort());
    expect(cotSet(DONG_DAU.slice(DONG_DAU.indexOf('SET')))).toEqual(cot);
  });

  it('annotate_income_expense_v1 chỉ ghi attachments và notes lên đầu phiếu', () => {
    const rpc = liveFunctionSql('public', 'annotate_income_expense_v1');
    const cau = [...rpc.matchAll(/UPDATE public\.income_expenses\s+SET([\s\S]*?)WHERE id = p_voucher/g)];
    expect(cau).toHaveLength(1);
    expect(cotSet(cau[0][1])).toEqual(['attachments', 'notes']);
  });
});

describe('khoá cũ và ngoại lệ cũ giữ nguyên', () => {
  it('sửa thẳng phiếu của tháng đã chốt, lập phiếu mới vào tháng đã chốt: chặn', async () => {
    await trongGiaoDich(async () => {
      await biChan('UPDATE public.income_expenses SET total_amount = 5 WHERE id = $1', [P.choChi]);
      await biChan("UPDATE public.income_expenses SET name = 'x' WHERE id = $1", [P.daChi]);
      await biChan(
        `INSERT INTO public.income_expenses(organization_id, building_id, name, type, voucher_date, approval_status)
         VALUES ($1, $2, 'mới', 'EXPENSE', '2026-09-20', 'UNAPPROVED')`, [ORG, TOA], CAU_KHOA_NGAY('lập phiếu'));
    });
  });

  it('đánh dấu đã kiểm, dừng lặp, gắn hợp đồng: vẫn qua như trước', async () => {
    await trongGiaoDich(async () => {
      await qua("UPDATE public.income_expenses SET verified_at = now(), verified_note = 'ok' WHERE id = $1", [P.daChi]);
      await scope(P.choChi, 'LINK_CONTRACT');
      await qua('UPDATE public.income_expenses SET contract_id = $2 WHERE id = $1', [P.choChi, id(77)]);
    });
  });

  it('phiếu tháng đang mở: ghi sổ, sửa, thêm/gỡ ảnh không dính khoá', async () => {
    await trongGiaoDich(async () => {
      const pt = await butToan(P.thangMo, SO_A);
      await qua(GHI_SO, [P.thangMo, pt, SO_A]);
      await qua("UPDATE public.income_expenses SET attachments = '[]'::jsonb, notes = 'x', total_amount = 9 WHERE id = $1",
        [P.thangMo]);
    });
  });
});
