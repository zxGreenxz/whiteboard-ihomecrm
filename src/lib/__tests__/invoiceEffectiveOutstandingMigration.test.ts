// "Nợ thực" khi cộng công nợ (22/10/2026): public.invoice_effective_outstanding_v1 — phần nợ cũ đã KÉO SANG một
// hoá đơn gánh chưa trả xong (previous_debt_sources) mà nợ của nó cũng nằm trong tập đang cộng (trực tiếp hoặc
// bắc cầu) chỉ tính MỘT lần, ở hoá đơn PHÁT SINH GỐC (tuổi nợ theo kỳ gốc); tiền thu vào hoá đơn gánh trả phần
// mới trước, nợ kéo sau cùng (khớp recompute_invoice_for_id). Cột effective_outstanding_at_carrier giữ cách cũ
// (dồn về hoá đơn gánh) với CÙNG tổng. Chạy THẬT migration trên PGlite (nạp hai lượt — idempotent), dưới RLS rút
// gọn (công ty + toà) và từ một hàm DEFINER như đường đọc Hermes v2.
//
// Khuôn chuỗi lấy từ dữ liệu TEST 22/10 (đã che: id, số tiền, tên đều tổng hợp):
//   A  chuỗi 6 tầng, kỳ đảo, mọi tầng còn mở;
//   B  hoá đơn gánh hai nguồn + nợ cũ nhập tay không khai nguồn (ca biên giữ nguyên);
//   C  phòng nợ nhiều kỳ KHÔNG kéo (không được trừ gì).
// Còn lại là ca biên: gánh đã thu một phần / thu quá phần riêng / PAID / huỷ / xoá mềm / nháp, ảnh chụp lệch dư nợ
// nguồn, hoá đơn âm, công ty khác, phần tử hỏng, gánh trùng, tự gánh. Cuối file: phép thử thuộc tính trên tập con
// ngẫu nhiên so với bản tham chiếu "dồn về hoá đơn gánh".
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
  d1: u(401), d2: u(402), // gánh PARTIAL_PAID, thu chưa hết phần riêng
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
  q1: u(551), q2: u(552), // gánh thu VƯỢT phần riêng: một phần nợ kéo đã trả qua hoá đơn gánh
  r1: u(561), r2: u(562), r3: u(563), // hai nguồn, gánh còn giữ ít hơn tổng kéo: nguồn cũ nhất giữ trước
  w1: u(571), w2: u(572), w3: u(573), // w2 (ngoài tập lọc) gom w1 rồi chỉ kéo MỘT PHẦN sang w3
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
  // q2: phần riêng 2.000.000 + kéo 1.000.000, đã thu 2.500.000 ⇒ 500.000 của nợ kéo đã trả qua q2.
  { id: E.q1, month: '2026-08', status: 'OVERDUE', total: 1_000_000 },
  { id: E.q2, month: '2026-09', status: 'PARTIAL_PAID', total: 3_000_000, paid: 2_500_000, sources: [src(E.q1, 1_000_000)] },
  // r3: phần riêng 1.000.000 + kéo 400.000 (r1) + 300.000 (r2), đã thu 1.200.000 ⇒ còn giữ 500.000 nợ kéo.
  { id: E.r1, month: '2026-07', status: 'OVERDUE', total: 400_000 },
  { id: E.r2, month: '2026-08', status: 'OVERDUE', total: 300_000 },
  { id: E.r3, month: '2026-09', status: 'PARTIAL_PAID', total: 1_700_000, paid: 1_200_000,
    sources: [src(E.r2, 300_000), src(E.r1, 400_000)] },
  // w2: phần riêng 500.000 + kéo w1 1.000.000; w3 chỉ kéo 600.000 của w2 (ảnh chụp nhỏ hơn dư nợ w2).
  { id: E.w1, month: '2026-07', status: 'OVERDUE', total: 1_000_000 },
  { id: E.w2, month: '2026-08', status: 'PARTIAL_PAID', total: 1_500_000, prev: 1_000_000, sources: [src(E.w1, 1_000_000)] },
  { id: E.w3, month: '2026-09', status: 'APPROVED', total: 2_600_000, prev: 600_000, sources: [src(E.w2, 600_000)] },
];

// Bản tham chiếu "dồn về hoá đơn gánh" (cách tính trước, cùng tập hoá đơn gánh hợp lệ): nguồn trừ phần đã kéo
// sang gánh được đếm, chặn ở dư nợ còn lại. effective_outstanding_at_carrier phải bằng nó từng dòng; tổng nợ thực
// theo kỳ gốc phải bằng tổng của nó.
const REFERENCE = `
  CREATE FUNCTION public.reference_at_carrier(p_invoice_ids uuid[])
  RETURNS TABLE(invoice_id uuid, effective numeric) LANGUAGE sql STABLE SET search_path = '' AS $ref$
    WITH RECURSIVE src AS (SELECT i.id, COALESCE(i.remaining_amount, 0)::numeric AS remaining FROM public.invoices i
                            WHERE i.id = ANY (COALESCE(p_invoice_ids, '{}'::uuid[]))),
    links AS (
      SELECT x.id AS source_id, c.id AS carrier_id,
             GREATEST(CASE WHEN jsonb_typeof(e.value->'amount') = 'number' THEN (e.value->>'amount')::numeric
               WHEN e.value->>'amount' ~ '^\\s*[0-9]+(\\.[0-9]+)?\\s*$' THEN btrim(e.value->>'amount')::numeric ELSE 0 END, 0) AS amount
        FROM public.invoices c
       CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(c.previous_debt_sources) = 'array'
         THEN c.previous_debt_sources ELSE '[]'::jsonb END) e
       CROSS JOIN LATERAL (SELECT CASE WHEN jsonb_typeof(e.value) = 'object' AND e.value->>'type' = 'invoice'
         AND e.value->>'id' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
         THEN (e.value->>'id')::uuid END AS id) ref
        JOIN public.invoices x ON x.id = ref.id AND x.organization_id = c.organization_id AND x.created_at < c.created_at
       WHERE c.deleted_at IS NULL AND c.status::text IN ('DRAFT','PENDING_APPROVAL','APPROVED','PARTIAL_PAID','OVERDUE')),
    covered(id) AS (SELECT s.id FROM src s UNION SELECT l.source_id FROM links l JOIN covered cv ON cv.id = l.carrier_id),
    carried AS (SELECT l.source_id, sum(l.amount) AS amount FROM links l
                 WHERE l.carrier_id IN (SELECT cv.id FROM covered cv) GROUP BY l.source_id)
    SELECT s.id, s.remaining - LEAST(COALESCE(k.amount, 0), GREATEST(s.remaining, 0))
      FROM src s LEFT JOIN carried k ON k.source_id = s.id
  $ref$;`;

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
      carried_out_amount numeric, carried_in_amount numeric, effective_outstanding numeric, effective_outstanding_at_carrier numeric)
    LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$ SELECT * FROM public.invoice_effective_outstanding_v1(p) $$;
    GRANT EXECUTE ON FUNCTION public.definer_probe(uuid[]) TO authenticated;
    ${REFERENCE}
  `);
}, 60_000);

afterAll(async () => { await db.close(); });

type Out = { remaining: number; out: number; in: number; effective: number; atCarrier: number };
type Row = { invoice_id: string; remaining_amount: string; carried_out_amount: string; carried_in_amount: string;
  effective_outstanding: string; effective_outstanding_at_carrier: string };

async function asUser(uid: string | null, ids: string[], fn = 'invoice_effective_outstanding_v1'): Promise<Map<string, Out>> {
  await db.exec('BEGIN');
  try {
    await db.query("SELECT set_config('test.uid', $1, true)", [uid ?? '']);
    await db.exec(`SET LOCAL ROLE ${uid ? 'authenticated' : 'anon'}`);
    const res = await db.query<Row>(`SELECT * FROM public.${fn}($1::uuid[])`, [`{${ids.join(',')}}`]);
    return new Map(res.rows.map((r) => [r.invoice_id, {
      remaining: Number(r.remaining_amount), out: Number(r.carried_out_amount), in: Number(r.carried_in_amount),
      effective: Number(r.effective_outstanding), atCarrier: Number(r.effective_outstanding_at_carrier),
    }]));
  } finally {
    await db.exec('ROLLBACK');
  }
}
const eff = (m: Map<string, Out>, id: string) => m.get(id)?.effective;
const effs = (m: Map<string, Out>, ids: string[]) => ids.map((id) => eff(m, id));
const sumEff = (m: Map<string, Out>, ids: string[]) => ids.reduce((s, id) => s + (m.get(id)?.effective ?? 0), 0);
const sumCarrier = (m: Map<string, Out>, ids: string[]) => ids.reduce((s, id) => s + (m.get(id)?.atCarrier ?? 0), 0);
const sumRem = (m: Map<string, Out>, ids: string[]) => ids.reduce((s, id) => s + (m.get(id)?.remaining ?? 0), 0);

describe('invoice_effective_outstanding_v1 — chuỗi khuôn thật', () => {
  it('A: chuỗi 6 tầng — mỗi kỳ giữ phần phát sinh của nó; cộng thẳng đếm gấp hơn ba lần; cách cũ cùng tổng', async () => {
    const ids = [A.t5, A.t7, A.t6, A.t8, A.t9, A.t10];
    const m = await asUser(OWNER, ids);
    expect(sumRem(m, ids)).toBe(17_150_000);
    expect(sumEff(m, ids)).toBe(5_150_000);
    // Theo kỳ phát sinh gốc: phần riêng của từng hoá đơn (dư nợ trừ phần nhận từ nguồn).
    expect(effs(m, ids)).toEqual([600_000, 740_000, 1_040_000, 1_000_000, 920_000, 850_000]);
    expect(ids.map((id) => m.get(id)?.out)).toEqual([600_000, 1_340_000, 2_380_000, 3_380_000, 4_300_000, 0]);
    expect(ids.map((id) => m.get(id)?.in)).toEqual([0, 600_000, 1_340_000, 2_380_000, 3_380_000, 4_300_000]);
    // Dồn về hoá đơn gánh (cách cũ): nguồn 0, hoá đơn trên cùng giữ cả chuỗi — cùng tổng.
    expect(ids.map((id) => m.get(id)?.atCarrier)).toEqual([0, 0, 0, 0, 0, 5_150_000]);
    expect(sumCarrier(m, ids)).toBe(5_150_000);
  });

  it('B: gánh hai nguồn — nguồn giữ nợ của kỳ mình, gánh giữ phần riêng; nợ cũ nhập tay không khai nguồn KHÔNG suy ra', async () => {
    const open = [B.t6, B.t7, B.t9, B.t10];
    const m = await asUser(OWNER, [...open, B.t8]);
    expect(sumRem(m, open)).toBe(7_500_000);
    expect(effs(m, [B.t6, B.t7, B.t9, B.t10])).toEqual([500_000, 500_000, 1_000_000, 4_000_000]);
    expect(m.get(B.t10)?.in).toBe(1_500_000);
    expect(eff(m, B.t8)).toBe(0); // PAID
    expect(sumEff(m, open)).toBe(6_000_000);
    expect(sumCarrier(m, open)).toBe(6_000_000);
  });

  it('C: nợ nhiều kỳ không kéo — không trừ gì', async () => {
    const ids = Object.values(C);
    const m = await asUser(OWNER, ids);
    for (const id of ids) {
      const r = m.get(id)!;
      expect(r).toEqual({ remaining: r.remaining, out: 0, in: 0, effective: r.remaining, atCarrier: r.remaining });
    }
    expect(sumEff(m, ids)).toBe(11_400_000);
  });
});

describe('invoice_effective_outstanding_v1 — chỉ khử trùng TRONG tập đang cộng', () => {
  it('một kỳ / một hoá đơn: hoá đơn gánh ngoài tập ⇒ giữ nguyên dư nợ (thẻ một kỳ khớp dòng của kỳ)', async () => {
    const m = await asUser(OWNER, [A.t9]);
    expect(m.get(A.t9)).toEqual({ remaining: 4_300_000, out: 0, in: 0, effective: 4_300_000, atCarrier: 4_300_000 });
  });

  it('tiền tố của chuỗi: mỗi kỳ giữ phần của nó (cách cũ: tầng cuối trong tập giữ cả phần đã gom)', async () => {
    const m = await asUser(OWNER, [A.t5, A.t7, A.t6]);
    expect(effs(m, [A.t5, A.t7, A.t6])).toEqual([600_000, 740_000, 1_040_000]);
    expect([A.t5, A.t7, A.t6].map((id) => m.get(id)?.atCarrier)).toEqual([0, 0, 2_380_000]);
  });

  it('bắc cầu: thiếu một tầng giữa (T8 ngoài tập) — phần riêng của T8 ở lại hoá đơn gánh trong tập, không mất, không đếm hai lần', async () => {
    const ids = [A.t5, A.t7, A.t6, A.t9, A.t10];
    const m = await asUser(OWNER, ids);
    expect(effs(m, ids)).toEqual([600_000, 740_000, 1_040_000, 1_920_000, 850_000]);
    expect(sumEff(m, ids)).toBe(5_150_000);
    expect(sumCarrier(m, ids)).toBe(5_150_000);
  });

  it('hoá đơn giữa ngoài tập chỉ chuyển tiếp phần của nguồn trong tập mà nó đã kéo đi — phần nó còn giữ không tính', async () => {
    // Tập {w1, w3} (w2 bị lọc ra): w3 chứa 600.000 kéo từ w2, phần cũ nhất của w2 là nợ w1 ⇒ 600.000 về w1; 400.000 nợ w1
    // còn nằm ở w2 (ngoài tập) không được đếm. Cùng tổng 2.600.000 với cách dồn về hoá đơn gánh.
    const m = await asUser(OWNER, [E.w1, E.w3]);
    expect(effs(m, [E.w1, E.w3])).toEqual([600_000, 2_000_000]);
    expect(sumEff(m, [E.w1, E.w3])).toBe(2_600_000);
    expect(sumCarrier(m, [E.w1, E.w3])).toBe(2_600_000);
    const all = await asUser(OWNER, [E.w1, E.w2, E.w3]);
    expect(effs(all, [E.w1, E.w2, E.w3])).toEqual([1_000_000, 500_000, 2_000_000]);
  });

  it('lọc theo trạng thái: nợ cũ quá hạn vẫn là quá hạn khi hoá đơn gánh chưa tới hạn (ngoài tập)', async () => {
    const overdue = [B.t6, B.t7];
    const m = await asUser(OWNER, overdue);
    expect(sumEff(m, overdue)).toBe(1_000_000);
  });

  it('chu trình (cạnh ngược thời gian) bị bỏ: một chiều được tính, nợ không biến mất', async () => {
    const m = await asUser(OWNER, [E.y1, E.y2]);
    expect(effs(m, [E.y1, E.y2])).toEqual([1_000_000, 1_000_000]); // y2 tạo sau, gánh y1; cạnh y1 → y2 ngược: bỏ
    expect(sumEff(m, [E.y1, E.y2])).toBe(2_000_000);
  });
});

describe('invoice_effective_outstanding_v1 — gánh đã thu một phần', () => {
  it('thu chưa hết phần riêng: nợ kéo còn nguyên ở nguồn (như recompute: nguồn chỉ coi là trả khi gánh PAID)', async () => {
    const m = await asUser(OWNER, [E.d1, E.d2]);
    expect(effs(m, [E.d1, E.d2])).toEqual([1_000_000, 800_000]);
    expect(m.get(E.d2)?.atCarrier).toBe(1_800_000);
  });

  it('thu VƯỢT phần riêng: phần vượt trả nợ kéo — nguồn chỉ còn phần gánh còn giữ, gánh về 0, không âm', async () => {
    const m = await asUser(OWNER, [E.q1, E.q2]);
    expect(m.get(E.q1)).toEqual({ remaining: 1_000_000, out: 1_000_000, in: 0, effective: 500_000, atCarrier: 0 });
    expect(m.get(E.q2)).toEqual({ remaining: 500_000, out: 0, in: 500_000, effective: 0, atCarrier: 500_000 });
  });

  it('hai nguồn, gánh giữ ít hơn tổng kéo: nguồn CŨ nhất giữ trước (nợ cũ trả sau cùng)', async () => {
    const m = await asUser(OWNER, [E.r1, E.r2, E.r3]);
    expect(effs(m, [E.r1, E.r2, E.r3])).toEqual([400_000, 100_000, 0]);
    expect(sumEff(m, [E.r1, E.r2, E.r3])).toBe(500_000);
    expect(sumCarrier(m, [E.r1, E.r2, E.r3])).toBe(500_000);
  });
});

describe('invoice_effective_outstanding_v1 — ca biên', () => {
  it('gánh PAID không là cạnh — phần kéo đã nằm trong paid_amount của nguồn', async () => {
    const m = await asUser(OWNER, [E.e1, E.e2]);
    expect(m.get(E.e1)).toEqual({ remaining: 500_000, out: 0, in: 0, effective: 500_000, atCarrier: 500_000 });
    expect(eff(m, E.e2)).toBe(0);
  });

  it('gánh huỷ / xoá mềm: nợ ở lại nguồn; gánh nháp / chờ duyệt ngoài tập: nợ ở lại nguồn', async () => {
    const m = await asUser(OWNER, [E.f1, E.g1, E.h1]);
    expect(effs(m, [E.f1, E.g1, E.h1])).toEqual([700_000, 800_000, 900_000]);
  });

  it('gánh nháp / chờ duyệt TRONG tập (thẻ /invoices cộng cả nháp): không đếm hai lần — nguồn giữ, gánh đầu trừ', async () => {
    const m = await asUser(OWNER, [E.h1, E.h2, E.h3]);
    expect(effs(m, [E.h1, E.h2, E.h3])).toEqual([900_000, 1_000_000, 1_900_000]);
    expect(m.get(E.h1)?.out).toBe(900_000); // dư nợ chỉ chia một lần: gánh thứ hai (trùng) không được trừ
  });

  it('ảnh chụp lớn hơn dư nợ nguồn: chỉ chuyển phần còn nợ, phần chênh ở hoá đơn gánh; ảnh chụp nhỏ hơn: phần chưa kéo ở nguồn', async () => {
    const m = await asUser(OWNER, [E.i1, E.i2, E.j1, E.j2]);
    expect(m.get(E.i1)).toEqual({ remaining: 400_000, out: 400_000, in: 0, effective: 400_000, atCarrier: 0 });
    expect(eff(m, E.i2)).toBe(2_600_000);
    expect(effs(m, [E.j1, E.j2])).toEqual([1_300_000, 2_000_000]);
    expect(m.get(E.j1)?.atCarrier).toBe(300_000);
  });

  it('hoá đơn âm không kéo gì và không bị trừ thêm', async () => {
    const m = await asUser(OWNER, [E.k1, E.k2]);
    expect(m.get(E.k1)).toEqual({ remaining: -3_600_000, out: 0, in: 0, effective: -3_600_000, atCarrier: -3_600_000 });
    expect(eff(m, E.k2)).toBe(1_000_000);
  });

  it('gánh ở công ty khác không trừ được nợ của công ty này (kể cả khi gọi từ DEFINER)', async () => {
    expect(eff(await asUser(OWNER, [E.l1]), E.l1)).toBe(1_000_000);
    expect(eff(await asUser(OWNER, [E.l1], 'definer_probe'), E.l1)).toBe(1_000_000);
    // Tập gồm cả hoá đơn hai công ty (như super admin / DEFINER): cạnh khác công ty vẫn không được tính.
    const both = await asUser(OWNER, [E.l1, E.lx], 'definer_probe');
    expect(effs(both, [E.l1, E.lx])).toEqual([1_000_000, 2_000_000]);
  });

  it('phần tử hỏng bị bỏ qua: cọc, tiền không phải số, id lạ, tiền âm, phần tử không phải object; id viết hoa và tiền dạng chuỗi số vẫn đọc', async () => {
    const m = await asUser(OWNER, [E.m1, E.m2]);
    expect(m.get(E.m1)).toEqual({ remaining: 1_000_000, out: 200_000, in: 0, effective: 1_000_000, atCarrier: 800_000 });
    expect(eff(m, E.m2)).toBe(1_800_000);
  });

  it('hai gánh cùng một nguồn: dư nợ nguồn chỉ chia một lần (gánh tạo trước); chỉ một gánh trong tập thì chia cho gánh đó', async () => {
    const m = await asUser(OWNER, [E.n1, E.n2, E.n3]);
    expect(m.get(E.n1)).toEqual({ remaining: 600_000, out: 600_000, in: 0, effective: 600_000, atCarrier: 0 });
    expect(effs(m, [E.n2, E.n3])).toEqual([1_000_000, 1_600_000]);
    const one = await asUser(OWNER, [E.n1, E.n3]);
    expect(effs(one, [E.n1, E.n3])).toEqual([600_000, 1_000_000]);
  });

  it('tự khai gánh chính mình và previous_debt_sources không phải mảng: không trừ, không lỗi', async () => {
    const m = await asUser(OWNER, [E.o1, E.p1]);
    expect(effs(m, [E.o1, E.p1])).toEqual([1_000_000, 1_000_000]);
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
  it('RLS người gọi: nhân viên chỉ toà B1 không nhận dòng toà B2; gánh ở toà không thấy thì không là cạnh', async () => {
    const staff = await asUser(STAFF, [E.s1, E.s2]);
    expect([...staff.keys()]).toEqual([E.s1]);
    expect(staff.get(E.s1)).toEqual({ remaining: 1_000_000, out: 0, in: 0, effective: 1_000_000, atCarrier: 1_000_000 });
    const owner = await asUser(OWNER, [E.s1, E.s2]);
    expect(effs(owner, [E.s1, E.s2])).toEqual([1_000_000, 1_000_000]);
    expect(owner.get(E.s1)?.atCarrier).toBe(0);
  });

  it('gọi từ hàm DEFINER (như hermes_domain_read_v2) cho tập id đã cấp: cùng số với chủ', async () => {
    const ids = [...Object.values(A), ...Object.values(B), E.d1, E.d2, E.e1, E.i1, E.n1, E.s1, E.q1, E.q2];
    const owner = await asUser(OWNER, ids);
    const definer = await asUser(STAFF, ids, 'definer_probe');
    expect(Object.fromEntries(definer)).toEqual(Object.fromEntries(owner));
  });

  it('anon không gọi được; người không thuộc công ty nào nhận rỗng', async () => {
    await expect(asUser(null, [A.t10])).rejects.toThrow(/permission denied/);
    expect((await asUser(u(77), [A.t10])).size).toBe(0);
  });

  it('catalog: INVOKER, search_path rỗng, STABLE, EXECUTE authenticated + service_role (như get_dashboard_summary)', async () => {
    const res = await db.query<{ prosecdef: boolean; provolatile: string; proconfig: string[]; acl: string; svc: boolean; anon: boolean }>(`
      SELECT p.prosecdef, p.provolatile, p.proconfig, p.proacl::text AS acl,
             has_function_privilege('service_role', p.oid, 'EXECUTE') AS svc, has_function_privilege('anon', p.oid, 'EXECUTE') AS anon
        FROM pg_proc p WHERE p.oid = 'public.invoice_effective_outstanding_v1(uuid[])'::regprocedure`);
    expect(res.rows[0].prosecdef).toBe(false);
    expect(res.rows[0].provolatile).toBe('s');
    expect(res.rows[0].proconfig).toEqual(['search_path=""']);
    expect(res.rows[0].acl).toMatch(/authenticated=X\//);
    expect(res.rows[0].svc).toBe(true);
    expect(res.rows[0].anon).toBe(false);
    expect(res.rows[0].acl).not.toMatch(/anon=|(^|[{,])=X\//);
  });
});

describe('invoice_effective_outstanding_v1 — thuộc tính trên tập con ngẫu nhiên', () => {
  // PRNG cố định để lần chạy lặp lại được.
  const rng = (seed: number) => () => { seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648; return seed / 2_147_483_648; };

  it('cùng tổng với cách dồn về hoá đơn gánh, cột cách cũ khớp tham chiếu từng dòng, 0 ≤ nợ thực ≤ dư nợ', async () => {
    const all = ROWS.filter((r) => (r.org ?? ORG) === ORG).map((r) => r.id);
    const next = rng(20261022);
    for (let round = 0; round < 300; round++) {
      const ids = all.filter(() => next() < 0.45);
      const m = await asUser(OWNER, ids);
      await db.exec('BEGIN');
      let ref: Map<string, number>;
      try {
        await db.query("SELECT set_config('test.uid', $1, true)", [OWNER]);
        await db.exec('SET LOCAL ROLE authenticated');
        const res = await db.query<{ invoice_id: string; effective: string }>(
          'SELECT * FROM public.reference_at_carrier($1::uuid[])', [`{${ids.join(',')}}`]);
        ref = new Map(res.rows.map((r) => [r.invoice_id, Number(r.effective)]));
      } finally { await db.exec('ROLLBACK'); }
      const keys = [...m.keys()];
      expect(new Set(keys), `round ${round}`).toEqual(new Set(ref.keys()));
      for (const id of keys) {
        const r = m.get(id)!;
        expect(r.atCarrier, `round ${round} ${id}`).toBe(ref.get(id));
        expect(r.atCarrier, `round ${round} ${id}`).toBe(r.remaining - r.out);
        if (r.remaining >= 0) {
          expect(r.effective, `round ${round} ${id}`).toBeGreaterThanOrEqual(0);
          expect(r.effective, `round ${round} ${id}`).toBeLessThanOrEqual(r.remaining);
        } else {
          expect(r.effective, `round ${round} ${id}`).toBe(r.remaining);
        }
      }
      expect(sumEff(m, keys), `round ${round}`).toBe(sumCarrier(m, keys));
    }
  }, 120_000);
});
