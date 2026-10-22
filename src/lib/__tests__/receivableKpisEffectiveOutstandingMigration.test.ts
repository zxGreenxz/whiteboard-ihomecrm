// Nợ thực ở KPI phải thu (20261021190215: fa_snapshot_kpis) và "Công nợ tổng" của Bảng tin (20261021190406:
// get_dashboard_summary). Chạy THẬT ba migration trên PGlite (hàm dùng chung 20261021183549 trước), mỗi file hai lượt.
//
// Bảng tin: repo lệch production (file cuối 20260703180000 ≠ bản đang chạy), nên 20261021190406 dựng từ định nghĩa SỐNG
// và chặn bằng md5 prosrc. Test đảo đúng MỘT khối công nợ của file về bản cũ ⇒ md5 phải bằng md5 production ghi trong
// $requires$ — chứng minh file = bản đang chạy + đúng một khối đổi.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const OUTSTANDING = readFileSync('supabase/migrations/20261021183549_invoice_effective_outstanding_v1.sql', 'utf8');
const KPIS = readFileSync('supabase/migrations/20261021190215_receivable_kpis_effective_outstanding_v1.sql', 'utf8');
const DASHBOARD = readFileSync('supabase/migrations/20261021190406_dashboard_total_debt_effective_outstanding_v1.sql', 'utf8');

const u = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const ORG = u(1), B1 = u(11), B2 = u(12), BV = u(13), R1 = u(21), R2 = u(22), RV = u(23);
const md5 = (s: string) => createHash('md5').update(s).digest('hex');
const bodyOf = (statement: string) =>
  statement.slice(statement.indexOf('AS $function$') + 'AS $function$'.length, statement.lastIndexOf('$function$'));

const NEW_DEBT_BLOCK = DASHBOARD.slice(DASHBOARD.indexOf('  -- công nợ (20261021190406)'), DASHBOARD.indexOf('  WHERE o.effective_outstanding > 0;') + '  WHERE o.effective_outstanding > 0;'.length);
const OLD_DEBT_BLOCK = `  -- công nợ: lọc tòa khi v_bids không rỗng (như cũ)
  SELECT COALESCE(sum(COALESCE(total_amount,0) - COALESCE(paid_amount,0)), 0) INTO r_debt
  FROM invoices
  WHERE status IN ('APPROVED','PARTIAL_PAID') AND deleted_at IS NULL
    AND (cardinality(v_bids) = 0 OR building_id = ANY(v_bids));`;
const DASHBOARD_STATEMENT = DASHBOARD.slice(DASHBOARD.indexOf('CREATE OR REPLACE FUNCTION public.get_dashboard_summary('),
  DASHBOARD.indexOf('$function$;') + '$function$;'.length);
const LIVE_MD5 = /md5\(p\.prosrc\) NOT IN \('([0-9a-f]{32})', '([0-9a-f]{32})'\)/.exec(DASHBOARD);

const db = new PGlite();

beforeAll(async () => {
  await db.exec(`
    CREATE ROLE authenticated; CREATE ROLE anon; CREATE ROLE service_role;
    CREATE TYPE public.invoice_status AS ENUM ('DRAFT','PENDING_APPROVAL','APPROVED','PAID','PARTIAL_PAID','OVERDUE','CANCELLED');
    CREATE TABLE public.buildings(id uuid PRIMARY KEY, organization_id uuid, name text, is_virtual boolean DEFAULT false, deleted_at timestamptz);
    CREATE TABLE public.rooms(id uuid PRIMARY KEY, building_id uuid, status text, rent_price numeric, deleted_at timestamptz);
    CREATE TABLE public.contracts(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), room_id uuid, status text, rent_price numeric, deposit_paid numeric,
      start_date date, end_date date, created_at timestamptz DEFAULT now(), deleted_at timestamptz);
    CREATE TABLE public.invoices(id uuid PRIMARY KEY, organization_id uuid, building_id uuid, room_id uuid, status public.invoice_status,
      due_date date, total_amount numeric(15,2), paid_amount numeric(15,2) DEFAULT 0,
      remaining_amount numeric(15,2) GENERATED ALWAYS AS (total_amount - paid_amount) STORED,
      previous_debt_sources jsonb NOT NULL DEFAULT '[]'::jsonb, created_at timestamptz NOT NULL, deleted_at timestamptz);
    CREATE TABLE public.invoice_pnl_cash_entries(building_id uuid, revenue_date date, pnl_amount numeric);
    CREATE TABLE public.issues(status text);
    CREATE TABLE public.leads(status text, created_at timestamptz);
    CREATE TABLE public.deposits(status text, created_at timestamptz);
    CREATE TABLE public.fixture_access(building_id uuid PRIMARY KEY);
    CREATE FUNCTION public.can_access_building(uuid) RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT EXISTS(SELECT 1 FROM public.fixture_access WHERE building_id = $1) $$;
    CREATE FUNCTION public.org_today_v1(uuid DEFAULT NULL) RETURNS date LANGUAGE sql STABLE AS $$ SELECT date '2026-10-22' $$;
    INSERT INTO public.buildings VALUES ('${B1}','${ORG}','Toà 1',false,NULL),('${B2}','${ORG}','Toà 2',false,NULL),('${BV}','${ORG}','Ảo',true,NULL);
    INSERT INTO public.rooms VALUES ('${R1}','${B1}','OCCUPIED',3000000,NULL),('${R2}','${B2}','OCCUPIED',3000000,NULL),('${RV}','${BV}','OCCUPIED',0,NULL);
    INSERT INTO public.fixture_access VALUES ('${B1}'),('${B2}'),('${BV}');
  `);
  // Khuôn thật đã che: chuỗi 3 tầng ở toà 1 (gánh trọn, hoá đơn gánh quá hạn) + hai kỳ không kéo ở toà 2.
  const src = (id: string, amount: number) => JSON.stringify([{ type: 'invoice', id, amount, label: 'nhãn' }]);
  await db.exec(`INSERT INTO public.invoices(id,organization_id,building_id,room_id,status,due_date,total_amount,paid_amount,previous_debt_sources,created_at) VALUES
    ('${u(101)}','${ORG}','${B1}','${R1}','OVERDUE','2026-06-30',1600000,1000000,'[]','2026-06-01'),
    ('${u(102)}','${ORG}','${B1}','${R1}','OVERDUE','2026-07-31',1340000,0,'${src(u(101), 600000)}','2026-07-01'),
    ('${u(103)}','${ORG}','${B1}','${R1}','PARTIAL_PAID','2026-08-31',2380000,0,'${src(u(102), 1340000)}','2026-08-01'),
    ('${u(104)}','${ORG}','${B1}','${R1}','OVERDUE','2026-10-05',3380000,0,'${src(u(103), 2380000)}','2026-09-01'),
    ('${u(201)}','${ORG}','${B2}','${R2}','OVERDUE','2026-09-30',2900000,0,'[]','2026-09-01'),
    ('${u(202)}','${ORG}','${B2}','${R2}','APPROVED','2026-10-31',2700000,0,'[]','2026-10-01'),
    ('${u(203)}','${ORG}','${B2}','${R2}','PAID','2026-08-31',2800000,2800000,'[]','2026-08-01')`);
  for (const sql of [OUTSTANDING, OUTSTANDING]) await db.exec(sql);
  // Bản production của Bảng tin = khối công nợ cũ trong thân file mới (md5 phải khớp $requires$).
  await db.exec(DASHBOARD_STATEMENT.replace(NEW_DEBT_BLOCK, () => OLD_DEBT_BLOCK));
  // fa_snapshot_kpis bản trước (20260731070000) để $requires$ của file KPI thấy hàm có sẵn.
  const kpiOld = readFileSync('supabase/migrations/20260731070000_current_date_to_org_today.sql', 'utf8');
  const start = kpiOld.indexOf('CREATE OR REPLACE FUNCTION public.fa_snapshot_kpis(');
  await db.exec(kpiOld.slice(start, kpiOld.indexOf('\n$function$;', start) + '\n$function$;'.length));
  // ACL để mặc định (PUBLIC/anon có EXECUTE) như bản dựng lại từ baseline --no-acl của Restore Drill: lượt áp đầu phải tự
  // đặt lại đúng ACL production; lượt thứ hai bắt đầu từ ACL production (đường production) và phải giữ nguyên.
  await db.exec(`
    CREATE TEMP TABLE before_kpis AS SELECT * FROM public.fa_snapshot_kpis(NULL);
    CREATE TEMP TABLE before_dash AS SELECT public.get_dashboard_summary(NULL) AS d;`);
  for (const sql of [KPIS, KPIS, DASHBOARD, DASHBOARD]) await db.exec(sql);
}, 60_000);

afterAll(async () => { await db.close(); });

const num = (v: unknown) => Number(v);

describe('get_dashboard_summary (20261021190406) — dựng từ định nghĩa sống', () => {
  it('file = bản production (md5 trong $requires$) + đúng một khối công nợ đổi', () => {
    expect(LIVE_MD5).not.toBeNull();
    expect(DASHBOARD_STATEMENT.split(NEW_DEBT_BLOCK)).toHaveLength(2);
    expect(md5(bodyOf(DASHBOARD_STATEMENT.replace(NEW_DEBT_BLOCK, () => OLD_DEBT_BLOCK)))).toBe(LIVE_MD5![1]);
    expect(md5(bodyOf(DASHBOARD_STATEMENT))).toBe(LIVE_MD5![2]);
  });

  it('total_debt: thêm hoá đơn OVERDUE (N-A4-04), cộng nợ thực — chuỗi kéo chỉ đếm ở hoá đơn gánh', async () => {
    const before = num(((await db.query<{ d: { total_debt: number } }>('SELECT d FROM before_dash')).rows[0].d).total_debt);
    // Trước: chỉ APPROVED/PARTIAL_PAID cộng thẳng = 2.380.000 (tầng giữa) + 2.700.000.
    expect(before).toBe(5_080_000);
    const after = num((await db.query<{ d: { total_debt: number } }>('SELECT public.get_dashboard_summary(NULL) AS d')).rows[0].d.total_debt);
    // Sau: toà 1 = hoá đơn gánh 3.380.000 (gom 600k + 740k + 1.040k + 1.000k), toà 2 = 2.900.000 + 2.700.000.
    expect(after).toBe(8_980_000);
    const b1 = num((await db.query<{ d: { total_debt: number } }>(`SELECT public.get_dashboard_summary('${B1}') AS d`)).rows[0].d.total_debt);
    expect(b1).toBe(3_380_000);
  });

  it('một định nghĩa với KPI phải thu: total_debt = Σ receivable_total của cùng các toà', async () => {
    const kpi = (await db.query<{ receivable_total: string }>('SELECT receivable_total FROM public.fa_snapshot_kpis(NULL)')).rows
      .reduce((s, r) => s + num(r.receivable_total), 0);
    const dash = num((await db.query<{ d: { total_debt: number } }>('SELECT public.get_dashboard_summary(NULL) AS d')).rows[0].d.total_debt);
    expect(dash).toBe(kpi);
  });
});

describe('fa_snapshot_kpis (20261021190215)', () => {
  it('receivable_total trước/sau theo toà; tổng = Σ tuổi nợ (bất biến client giữ nguyên)', async () => {
    const rows = async (table: string) => (await db.query<Record<string, string>>(
      `SELECT building_id, receivable_total, aging_not_due, aging_1_30, aging_31_60, aging_61_90, aging_over_90 FROM ${table} ORDER BY building_name`)).rows;
    const before = await rows('before_kpis');
    const after = await rows('public.fa_snapshot_kpis(NULL)');
    // Toà 1: cộng thẳng 600k + 1.340k + 2.380k + 3.380k = 7.700.000 → nợ thực 3.380.000; toà 2 không kéo: giữ 5.600.000.
    expect(before.map((r) => [r.building_id, num(r.receivable_total)])).toEqual([[B1, 7_700_000], [B2, 5_600_000]]);
    expect(after.map((r) => [r.building_id, num(r.receivable_total)])).toEqual([[B1, 3_380_000], [B2, 5_600_000]]);
    for (const r of after) {
      const aging = num(r.aging_not_due) + num(r.aging_1_30) + num(r.aging_31_60) + num(r.aging_61_90) + num(r.aging_over_90);
      expect(aging).toBe(num(r.receivable_total));
    }
    // Tuổi nợ theo kỳ phát sinh gốc (ngày 22/10): mỗi hoá đơn của chuỗi giữ phần của nó với hạn của nó —
    // 600.000 hạn 30/06 (> 90 ngày), 740.000 hạn 31/07 (61–90), 1.040.000 hạn 31/08 (31–60), 1.000.000 hạn 05/10 (1–30).
    // Trước (cộng thẳng) cũng đúng các khoảng đó nhưng mỗi khoảng phồng thêm phần đã kéo sang hoá đơn sau.
    expect([after[0].aging_not_due, after[0].aging_1_30, after[0].aging_31_60, after[0].aging_61_90, after[0].aging_over_90].map(num))
      .toEqual([0, 1_000_000, 1_040_000, 740_000, 600_000]);
    expect([before[0].aging_not_due, before[0].aging_1_30, before[0].aging_31_60, before[0].aging_61_90, before[0].aging_over_90].map(num))
      .toEqual([0, 3_380_000, 2_380_000, 1_340_000, 600_000]);
  });

  it('hoá đơn gánh bị huỷ ⇒ nợ trở lại nguồn; lọc toà chỉ thu hẹp', async () => {
    await db.exec('BEGIN');
    try {
      await db.exec(`UPDATE public.invoices SET status = 'CANCELLED' WHERE id = '${u(104)}'`);
      const one = await db.query<{ receivable_total: string }>(`SELECT receivable_total FROM public.fa_snapshot_kpis(ARRAY['${B1}'::uuid])`);
      expect(one.rows.map((r) => num(r.receivable_total))).toEqual([2_380_000]);
    } finally { await db.exec('ROLLBACK'); }
  });

  it('catalog: chữ ký, DEFINER, search_path giữ nguyên; không đẻ overload', async () => {
    const res = await db.query<{ n: number; prosecdef: boolean; cfg: string }>(`
      SELECT count(*) OVER () AS n, p.prosecdef, array_to_string(p.proconfig, ',') AS cfg FROM pg_proc p WHERE p.proname = 'fa_snapshot_kpis'`);
    expect(res.rows).toHaveLength(1);
    expect(res.rows[0].prosecdef).toBe(true);
    expect(res.rows[0].cfg).toBe('search_path=public');
  });
});

describe('ACL hai hàm sau hai lượt áp (bắt đầu từ ACL mặc định của bản dựng lại --no-acl)', () => {
  it('đúng chuỗi ACL production 22/10; anon không EXECUTE', async () => {
    const res = await db.query<{ sig: string; acl: string; anon_x: boolean }>(`
      SELECT p.oid::regprocedure::text AS sig, p.proacl::text AS acl, has_function_privilege('anon', p.oid, 'EXECUTE') AS anon_x
        FROM pg_proc p WHERE p.proname IN ('fa_snapshot_kpis', 'get_dashboard_summary') ORDER BY 1`);
    const prodAcl = '{postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}';
    expect(res.rows).toEqual([
      { sig: 'fa_snapshot_kpis(uuid[])', acl: prodAcl, anon_x: false },
      { sig: 'get_dashboard_summary(uuid)', acl: prodAcl, anon_x: false },
    ]);
  });
});
