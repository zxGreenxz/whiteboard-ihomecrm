// "Nợ thực" khi cộng công nợ (22/10/2026): public.invoice_effective_outstanding_v1 trừ phần nợ cũ đã
// KÉO SANG một hoá đơn gánh còn mở (previous_debt_sources) mà nợ của nó cũng nằm trong tập đang cộng
// (trực tiếp hoặc bắc cầu). Chạy THẬT migration trên PGlite (nạp hai lượt — idempotent), dưới RLS
// rút gọn (công ty + toà) và từ một hàm DEFINER như đường đọc Hermes v2.
//
// Khuôn chuỗi lấy từ dữ liệu TEST 22/10 (đã che: id, số tiền, tên đều tổng hợp):
//   A  chuỗi 6 tầng, kỳ đảo (T5→T7→T6→T8→T9→T10), mọi tầng còn mở;
//   B  hoá đơn gánh hai nguồn + nợ cũ nhập tay không khai nguồn (ca biên giữ nguyên);
//   C  phòng nợ nhiều kỳ KHÔNG kéo (không được trừ gì).
// Còn lại là ca biên: gánh đã thu một phần / PAID / huỷ / xoá mềm / nháp, ảnh chụp lệch dư nợ
// nguồn, hoá đơn âm, công ty khác, phần tử hỏng, gánh trùng, tự gánh.
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const MIGRATION = 'supabase/migrations/20261021183549_invoice_effective_outstanding_v1.sql';
const migrationSql = readFileSync(MIGRATION, 'utf8');

const u = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const ORG = 'aaaa0000-0000-4000-8000-0000000000a1';
const ORG_X = 'bbbb0000-0000-4000-8000-0000000000b1';
const OWNER = u(1); // toàn công ty ORG
const STAFF = u(2); // chỉ toà B1
const B1 = u(11), B2 = u(12), BX = u(13);

type Inv = {
  id: string; org?: string; building?: string; month: string; status: string; total: number; paid?: number;
  sources?: unknown; prev?: number; deleted?: boolean;
};
const src = (id: string, amount: unknown) => ({ type: 'invoice', id, amount, label: 'nhãn' });

// A — 6 tầng: mỗi tầng gánh trọn dư nợ tầng trước + tiền kỳ mình.
const A = { t5: u(105), t7: u(107), t6: u(106), t8: u(108), t9: u(109), t10: u(110) };
// B — gánh hai nguồn (B9, B7); B7 và B8 ghi nợ cũ TAY (không khai nguồn); B6 không ai khai gánh.
const B = { t6: u(206), t7: u(207), t8: u(208), t9: u(209), t10: u(210) };
// C — bốn kỳ nợ, không kéo.
const C = { t7: u(307), t8: u(308), t9: u(309), t10: u(310) };
// Ca biên (mỗi cặp: nguồn …1, gánh …2/3).
const E = {
  d1: u(401), d2: u(402), // gánh PARTIAL_PAID
  e1: u(411), e2: u(412), // gánh PAID, nguồn chỉ được kéo một phần
  f1: u(421), f2: u(422), // gánh CANCELLED
  g1: u(431), g2: u(432), // gánh xoá mềm
  h1: u(441), h2: u(442), h3: u(443), // gánh DRAFT / PENDING_APPROVAL
  i1: u(451), i2: u(452), // khách trả thẳng nguồn sau khi kéo (ảnh chụp > dư nợ)
  j1: u(461), j2: u(462), // nguồn tăng sau khi kéo (ảnh chụp < dư nợ)
  k1: u(471), k2: u(472), // hoá đơn âm
  l1: u(481), lx: u(482), // gánh ở công ty khác
  m1: u(491), m2: u(492), // phần tử hỏng
  n1: u(501), n2: u(502), n3: u(503), // hai gánh cùng nguồn
  o1: u(511), // tự gánh chính mình
  p1: u(521), // previous_debt_sources không phải mảng
  s1: u(531), s2: u(532), // nguồn ở B1, gánh ở B2 (STAFF chỉ thấy B1)
  y1: u(541), y2: u(542), // chu trình: y2 gánh y1, rồi y1 bị sửa khai gánh y2 (cạnh ngược thời gian)
};

const ROWS: Inv[] = [
  { id: A.t5, month: '2026-05', status: 'OVERDUE', total: 1_600_000, paid: 1_000_000 },
  { id: A.t7, month: '2026-07', status: 'OVERDUE', total: 1_340_000, prev: 600_000, sources: [src(A.t5, 600_000)] },
  { id: A.t6, month: '2026-06', status: 'OVERDUE', total: 2_380_000, prev: 1_340_000, sources: [src(A.t7, 1_340_000)] },
  { id: A.t8, month: '2026-08', status: 'OVERDUE', total: 3_380_000, prev: 2_380_000, sources: [src(A.t6, 2_380_000)] },
  { id: A.t9, month: '2026-09', status: 'OVERDUE', total: 4_300_000, prev: 3_380_000, sources: [src(A.t8, 3_380_000)] },
  { id: A.t10, month: '2026-10', status: 'OVERDUE', total: 5_150_000, prev: 4_300_000, sources: [src(A.t9, 4_300_000)] },

  { id: B.t6, month: '2026-06', status: 'OVERDUE', total: 4_500_000, paid: 4_000_000 },
  { id: B.t7, month: '2026-07', status: 'OVERDUE', total: 4_700_000, paid: 4_200_000, prev: 500_000, sources: [] },
  { id: B.t8, month: '2026-08', status: 'PAID', total: 4_500_000, paid: 4_500_000, prev: 500_000, sources: [] },
  { id: B.t9, month: '2026-09', status: 'PARTIAL_PAID', total: 4_000_000, paid: 3_000_000 },
  { id: B.t10, month: '2026-10', status: 'APPROVED', total: 5_500_000, prev: 1_500_000,
    sources: [src(B.t9, 1_000_000), src(B.t7, 500_000)] },

  { id: C.t7, month: '2026-07', status: 'OVERDUE', total: 3_000_000 },
  { id: C.t8, month: '2026-08', status: 'OVERDUE', total: 2_900_000 },
  { id: C.t9, month: '2026-09', status: 'OVERDUE', total: 2_800_000 },
  { id: C.t10, month: '2026-10', status: 'APPROVED', total: 2_700_000 },

  { id: E.d1, month: '2026-09', status: 'OVERDUE', total: 1_000_000 },
  { id: E.d2, month: '2026-10', status: 'PARTIAL_PAID', total: 3_000_000, paid: 1_200_000, sources: [src(E.d1, 1_000_000)] },
  // Gánh PAID: recompute đã cộng 1.000.000 phần kéo vào paid_amount của nguồn ⇒ còn 500.000 THẬT.
  { id: E.e1, month: '2026-08', status: 'PARTIAL_PAID', total: 1_500_000, paid: 1_000_000 },
  { id: E.e2, month: '2026-09', status: 'PAID', total: 2_000_000, paid: 2_000_000, sources: [src(E.e1, 1_000_000)] },
  { id: E.f1, month: '2026-08', status: 'OVERDUE', total: 700_000 },
  { id: E.f2, month: '2026-09', status: 'CANCELLED', total: 1_700_000, sources: [src(E.f1, 700_000)] },
  { id: E.g1, month: '2026-08', status: 'OVERDUE', total: 800_000 },
  { id: E.g2, month: '2026-09', status: 'APPROVED', total: 1_800_000, sources: [src(E.g1, 800_000)], deleted: true },
  { id: E.h1, month: '2026-08', status: 'OVERDUE', total: 900_000 },
  { id: E.h2, month: '2026-09', status: 'DRAFT', total: 1_900_000, sources: [src(E.h1, 900_000)] },
  { id: E.h3, month: '2026-10', status: 'PENDING_APPROVAL', total: 1_900_000, sources: [src(E.h1, 900_000)] },
  { id: E.i1, month: '2026-08', status: 'PARTIAL_PAID', total: 1_000_000, paid: 600_000 },
  { id: E.i2, month: '2026-09', status: 'OVERDUE', total: 3_000_000, sources: [src(E.i1, 1_000_000)] },
  { id: E.j1, month: '2026-08', status: 'OVERDUE', total: 1_300_000 },
  { id: E.j2, month: '2026-09', status: 'OVERDUE', total: 3_000_000, sources: [src(E.j1, 1_000_000)] },
  { id: E.k1, month: '2026-08', status: 'OVERDUE', total: -3_600_000 },
  { id: E.k2, month: '2026-09', status: 'OVERDUE', total: 1_000_000, sources: [src(E.k1, 500_000)] },
  { id: E.l1, month: '2026-08', status: 'OVERDUE', total: 1_000_000 },
  { id: E.lx, org: ORG_X, building: BX, month: '2026-09', status: 'APPROVED', total: 2_000_000, sources: [src(E.l1, 1_000_000)] },
  { id: E.m1, month: '2026-08', status: 'OVERDUE', total: 1_000_000 },
  { id: E.m2, month: '2026-09', status: 'APPROVED', total: 2_000_000, sources: [
    { type: 'deposit', contract_id: u(999), amount: 500_000 },
    src(E.m1, 'abc'),
    src('khong-phai-uuid', 5),
    src(E.m1, -50_000),
    'chuoi',
    src(E.m1.toUpperCase(), '200000'),
  ] },
  { id: E.n1, month: '2026-08', status: 'OVERDUE', total: 600_000 },
  { id: E.n2, month: '2026-09', status: 'OVERDUE', total: 1_600_000, sources: [src(E.n1, 600_000)] },
  { id: E.n3, month: '2026-10', status: 'APPROVED', total: 1_600_000, sources: [src(E.n1, 600_000)] },
  { id: E.o1, month: '2026-08', status: 'APPROVED', total: 1_000_000, sources: [src(u(511), 1_000_000)] },
  { id: E.p1, month: '2026-08', status: 'APPROVED', total: 1_000_000, sources: { type: 'invoice', id: u(511), amount: 1 } },
  { id: E.s1, month: '2026-08', status: 'OVERDUE', total: 1_000_000 },
  { id: E.s2, building: B2, month: '2026-09', status: 'APPROVED', total: 2_000_000, sources: [src(E.s1, 1_000_000)] },
  { id: E.y1, month: '2026-08', status: 'OVERDUE', total: 1_000_000, sources: [src(u(542), 2_000_000)] },
  { id: E.y2, month: '2026-09', status: 'OVERDUE', total: 2_000_000, sources: [src(E.y1, 1_000_000)] },
];

const db = new PGlite();

beforeAll(async () => {
  await db.exec(`
    CREATE ROLE authenticated; CREATE ROLE anon; CREATE ROLE service_role;
    CREATE SCHEMA auth;
    CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('test.uid', true), '')::uuid $$;
    CREATE TYPE public.invoice_status AS ENUM ('DRAFT','PENDING_APPROVAL','APPROVED','PAID','PARTIAL_PAID','OVERDUE','CANCELLED');
    CREATE TABLE public.invoices(id uuid PRIMARY KEY, organization_id uuid, building_id uuid, billing_month text,
      status public.invoice_status, total_amount numeric(15,2), paid_amount numeric(15,2) DEFAULT 0,
      remaining_amount numeric(15,2) GENERATED ALWAYS AS (total_amount - paid_amount) STORED,
      previous_debt numeric(15,2) DEFAULT 0, previous_debt_sources jsonb NOT NULL DEFAULT '[]'::jsonb,
      created_at timestamptz NOT NULL, deleted_at timestamptz);
    -- Quyền rút gọn: (người, công ty, toà) — toà NULL = toàn công ty.
    CREATE TABLE public.test_access(user_id uuid, organization_id uuid, building_id uuid);
    INSERT INTO public.test_access VALUES ('${OWNER}','${ORG}',NULL),('${STAFF}','${ORG}','${B1}');
    ALTER TABLE public.invoices ENABLE ROW LEVEL SECURITY;
    CREATE POLICY invoices_scope ON public.invoices FOR SELECT TO authenticated USING (EXISTS (
      SELECT 1 FROM public.test_access a WHERE a.user_id = auth.uid() AND a.organization_id = invoices.organization_id
        AND (a.building_id IS NULL OR a.building_id = invoices.building_id)));
    GRANT USAGE ON SCHEMA public, auth TO authenticated, anon, service_role;
    GRANT SELECT ON public.invoices, public.test_access TO authenticated;
  `);
  // created_at theo thứ tự mảng: hoá đơn gánh luôn tạo SAU nguồn (như 33/33 cạnh thật đo 22/10).
  for (const [index, r] of ROWS.entries()) {
    await db.query(
      `INSERT INTO public.invoices(id, organization_id, building_id, billing_month, status, total_amount, paid_amount,
         previous_debt, previous_debt_sources, created_at, deleted_at)
       VALUES ($1, $2, $3, $4, $5::public.invoice_status, $6, $7, $8, $9::jsonb,
         timestamptz '2026-05-01 00:00+07' + make_interval(hours => $10::int), $11)`,
      [r.id, r.org ?? ORG, r.building ?? B1, r.month, r.status, r.total, r.paid ?? 0, r.prev ?? 0,
        JSON.stringify(r.sources ?? []), index, r.deleted ? '2026-10-01' : null],
    );
  }
  // Hai lượt: idempotent như lane.
  await db.exec(migrationSql);
  await db.exec(migrationSql);
  // Như hermes_domain_read_v2: DEFINER (owner = superuser của PGlite) gọi cho tập id đã cấp quyền.
  await db.exec(`
    CREATE FUNCTION public.definer_probe(p uuid[]) RETURNS TABLE(invoice_id uuid, remaining_amount numeric,
      carried_forward_amount numeric, effective_outstanding numeric)
    LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$ SELECT * FROM public.invoice_effective_outstanding_v1(p) $$;
    GRANT EXECUTE ON FUNCTION public.definer_probe(uuid[]) TO authenticated;
  `);
}, 60_000);

afterAll(async () => { await db.close(); });

type Out = { remaining: number; carried: number; effective: number };

async function asUser(uid: string | null, ids: string[], fn = 'invoice_effective_outstanding_v1'): Promise<Map<string, Out>> {
  await db.exec('BEGIN');
  try {
    await db.query("SELECT set_config('test.uid', $1, true)", [uid ?? '']);
    await db.exec(`SET LOCAL ROLE ${uid ? 'authenticated' : 'anon'}`);
    const res = await db.query<{ invoice_id: string; remaining_amount: string; carried_forward_amount: string; effective_outstanding: string }>(
      `SELECT * FROM public.${fn}($1::uuid[])`, [`{${ids.join(',')}}`]);
    return new Map(res.rows.map((r) => [r.invoice_id, {
      remaining: Number(r.remaining_amount), carried: Number(r.carried_forward_amount), effective: Number(r.effective_outstanding),
    }]));
  } finally {
    await db.exec('ROLLBACK');
  }
}
const eff = (m: Map<string, Out>, id: string) => m.get(id)?.effective;
const sumEff = (m: Map<string, Out>, ids: string[]) => ids.reduce((s, id) => s + (m.get(id)?.effective ?? 0), 0);
const sumRem = (m: Map<string, Out>, ids: string[]) => ids.reduce((s, id) => s + (m.get(id)?.remaining ?? 0), 0);

describe('invoice_effective_outstanding_v1 — chuỗi khuôn thật', () => {
  it('A: chuỗi 6 tầng kỳ đảo chỉ còn nợ ở hoá đơn trên cùng; cộng thẳng đếm gấp hơn ba lần', async () => {
    const ids = Object.values(A);
    const m = await asUser(OWNER, ids);
    expect(sumRem(m, ids)).toBe(17_150_000);
    expect(sumEff(m, ids)).toBe(5_150_000);
    for (const id of [A.t5, A.t7, A.t6, A.t8, A.t9]) {
      expect(eff(m, id), id).toBe(0);
      expect(m.get(id)?.carried, id).toBe(m.get(id)?.remaining);
    }
    expect(eff(m, A.t10)).toBe(5_150_000);
    expect(m.get(A.t10)?.carried).toBe(0);
  });

  it('B: gánh hai nguồn trừ đúng hai nguồn; nợ cũ nhập tay không khai nguồn KHÔNG suy ra (ca biên)', async () => {
    const open = [B.t6, B.t7, B.t9, B.t10];
    const m = await asUser(OWNER, [...open, B.t8]);
    expect(sumRem(m, open)).toBe(7_500_000);
    expect(eff(m, B.t7)).toBe(0);
    expect(eff(m, B.t9)).toBe(0);
    expect(eff(m, B.t6)).toBe(500_000); // không hoá đơn nào khai gánh B6
    expect(eff(m, B.t10)).toBe(5_500_000);
    expect(eff(m, B.t8)).toBe(0); // PAID
    expect(sumEff(m, open)).toBe(6_000_000);
  });

  it('C: nợ nhiều kỳ không kéo — không trừ gì', async () => {
    const ids = Object.values(C);
    const m = await asUser(OWNER, ids);
    for (const id of ids) expect(m.get(id)).toEqual({ remaining: m.get(id)?.remaining, carried: 0, effective: m.get(id)?.remaining });
    expect(sumEff(m, ids)).toBe(11_400_000);
  });
});

describe('invoice_effective_outstanding_v1 — chỉ khử trùng TRONG tập đang cộng', () => {
  it('một kỳ / một hoá đơn: hoá đơn gánh ngoài tập ⇒ giữ nguyên dư nợ (thẻ một kỳ khớp dòng của kỳ)', async () => {
    const m = await asUser(OWNER, [A.t9]);
    expect(m.get(A.t9)).toEqual({ remaining: 4_300_000, carried: 0, effective: 4_300_000 });
  });

  it('tiền tố của chuỗi theo hạn: tầng cuối trong tập giữ toàn bộ phần đã gom', async () => {
    const m = await asUser(OWNER, [A.t5, A.t7, A.t6]);
    expect([eff(m, A.t5), eff(m, A.t7), eff(m, A.t6)]).toEqual([0, 0, 2_380_000]);
  });

  it('bắc cầu: thiếu một tầng giữa (T8 ngoài tập) vẫn không đếm hai lần — nợ T6 đã nằm trong T10 qua T8→T9', async () => {
    const ids = [A.t5, A.t7, A.t6, A.t9, A.t10];
    const m = await asUser(OWNER, ids);
    expect(eff(m, A.t6)).toBe(0);
    expect(sumEff(m, ids)).toBe(5_150_000);
  });

  it('lọc theo trạng thái: nợ cũ quá hạn vẫn là quá hạn khi hoá đơn gánh chưa tới hạn (ngoài tập)', async () => {
    const overdue = [B.t6, B.t7];
    const m = await asUser(OWNER, overdue);
    expect(sumEff(m, overdue)).toBe(1_000_000);
  });

  it('chu trình (cạnh ngược thời gian) bị bỏ: một chiều được tính, nợ không biến mất', async () => {
    const m = await asUser(OWNER, [E.y1, E.y2]);
    expect(eff(m, E.y1)).toBe(0); // y2 tạo sau, gánh y1
    expect(eff(m, E.y2)).toBe(2_000_000); // cạnh y1 → y2 ngược thời gian: không trừ
    expect(sumEff(m, [E.y1, E.y2])).toBe(2_000_000);
  });
});

describe('invoice_effective_outstanding_v1 — ca biên', () => {
  it('gánh đã thu một phần: nguồn 0, gánh giữ phần chưa thu (đúng số đòi khách)', async () => {
    const m = await asUser(OWNER, [E.d1, E.d2]);
    expect(eff(m, E.d1)).toBe(0);
    expect(eff(m, E.d2)).toBe(1_800_000);
  });

  it('gánh PAID không bị trừ lần hai — phần kéo đã nằm trong paid_amount của nguồn', async () => {
    const m = await asUser(OWNER, [E.e1, E.e2]);
    expect(m.get(E.e1)).toEqual({ remaining: 500_000, carried: 0, effective: 500_000 });
    expect(eff(m, E.e2)).toBe(0);
  });

  it('gánh huỷ / xoá mềm / nháp / chờ duyệt: nợ ở lại nguồn', async () => {
    const m = await asUser(OWNER, [E.f1, E.g1, E.h1]);
    expect(eff(m, E.f1)).toBe(700_000);
    expect(eff(m, E.g1)).toBe(800_000);
    expect(eff(m, E.h1)).toBe(900_000);
  });

  it('chặn trên: ảnh chụp lớn hơn dư nợ nguồn ⇒ nguồn 0, không âm; ảnh chụp nhỏ hơn ⇒ phần chưa kéo vẫn là nợ', async () => {
    const m = await asUser(OWNER, [E.i1, E.i2, E.j1, E.j2]);
    expect(m.get(E.i1)).toEqual({ remaining: 400_000, carried: 1_000_000, effective: 0 });
    expect(eff(m, E.i2)).toBe(3_000_000);
    expect(eff(m, E.j1)).toBe(300_000);
  });

  it('hoá đơn âm không bị trừ thêm', async () => {
    const m = await asUser(OWNER, [E.k1, E.k2]);
    expect(m.get(E.k1)).toEqual({ remaining: -3_600_000, carried: 500_000, effective: -3_600_000 });
  });

  it('gánh ở công ty khác không trừ được nợ của công ty này (kể cả khi gọi từ DEFINER)', async () => {
    expect(eff(await asUser(OWNER, [E.l1]), E.l1)).toBe(1_000_000);
    expect(eff(await asUser(OWNER, [E.l1], 'definer_probe'), E.l1)).toBe(1_000_000);
    // Tập gồm cả hoá đơn hai công ty (như super admin / DEFINER): cạnh khác công ty vẫn không được tính.
    expect(eff(await asUser(OWNER, [E.l1, E.lx], 'definer_probe'), E.l1)).toBe(1_000_000);
  });

  it('phần tử hỏng bị bỏ qua: cọc, tiền không phải số, id lạ, tiền âm, phần tử không phải object; id viết hoa và tiền dạng chuỗi số vẫn đọc', async () => {
    const m = await asUser(OWNER, [E.m1, E.m2]);
    expect(m.get(E.m1)).toEqual({ remaining: 1_000_000, carried: 200_000, effective: 800_000 });
  });

  it('hai gánh cùng một nguồn: nguồn về 0, không âm; chỉ một gánh trong tập thì chỉ trừ phần của gánh đó', async () => {
    const m = await asUser(OWNER, [E.n1, E.n2, E.n3]);
    expect(m.get(E.n1)).toEqual({ remaining: 600_000, carried: 1_200_000, effective: 0 });
    const one = await asUser(OWNER, [E.n1, E.n3]);
    expect(one.get(E.n1)).toEqual({ remaining: 600_000, carried: 600_000, effective: 0 });
  });

  it('tự khai gánh chính mình và previous_debt_sources không phải mảng: không trừ, không lỗi', async () => {
    const m = await asUser(OWNER, [E.o1, E.p1]);
    expect(eff(m, E.o1)).toBe(1_000_000);
    expect(eff(m, E.p1)).toBe(1_000_000);
  });

  it('mảng rỗng / NULL / id không tồn tại: không dòng nào', async () => {
    expect((await asUser(OWNER, [])).size).toBe(0);
    expect((await asUser(OWNER, [u(9999)])).size).toBe(0);
    await db.exec('BEGIN');
    try {
      await db.query("SELECT set_config('test.uid', $1, true)", [OWNER]);
      await db.exec('SET LOCAL ROLE authenticated');
      const res = await db.query('SELECT * FROM public.invoice_effective_outstanding_v1(NULL)');
      expect(res.rows).toHaveLength(0);
    } finally { await db.exec('ROLLBACK'); }
  });
});

describe('invoice_effective_outstanding_v1 — quyền', () => {
  it('RLS người gọi: nhân viên chỉ toà B1 không nhận dòng toà B2; gánh ở toà không thấy thì không trừ', async () => {
    const staff = await asUser(STAFF, [E.s1, E.s2]);
    expect([...staff.keys()]).toEqual([E.s1]);
    expect(eff(staff, E.s1)).toBe(1_000_000);
    const owner = await asUser(OWNER, [E.s1, E.s2]);
    expect(eff(owner, E.s1)).toBe(0);
    expect(eff(owner, E.s2)).toBe(2_000_000);
  });

  it('gọi từ hàm DEFINER (như hermes_domain_read_v2) cho tập id đã cấp: cùng số với chủ', async () => {
    const ids = [...Object.values(A), ...Object.values(B), E.d1, E.d2, E.e1, E.i1, E.n1, E.s1];
    const owner = await asUser(OWNER, ids);
    const definer = await asUser(STAFF, ids, 'definer_probe');
    expect(Object.fromEntries(definer)).toEqual(Object.fromEntries(owner));
  });

  it('anon không gọi được; người không thuộc công ty nào nhận rỗng', async () => {
    await expect(asUser(null, [A.t10])).rejects.toThrow(/permission denied/);
    expect((await asUser(u(77), [A.t10])).size).toBe(0);
  });

  it('catalog: INVOKER, search_path rỗng, STABLE, EXECUTE chỉ authenticated', async () => {
    const res = await db.query<{ prosecdef: boolean; provolatile: string; proconfig: string[]; acl: string }>(`
      SELECT p.prosecdef, p.provolatile, p.proconfig, p.proacl::text AS acl FROM pg_proc p
       WHERE p.oid = 'public.invoice_effective_outstanding_v1(uuid[])'::regprocedure`);
    expect(res.rows[0].prosecdef).toBe(false);
    expect(res.rows[0].provolatile).toBe('s');
    expect(res.rows[0].proconfig).toEqual(['search_path=""']);
    expect(res.rows[0].acl).toMatch(/authenticated=X\//);
    expect(res.rows[0].acl).not.toMatch(/anon=|service_role=|(^|[{,])=X\//);
  });
});
