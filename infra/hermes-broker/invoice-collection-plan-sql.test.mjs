import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';

// Phía SQL của bộ vector kế hoạch thu tiền (src/lib/__tests__/fixtures/invoice-collection-plan-vectors.json; phía TS:
// src/lib/__tests__/invoiceCollectionPlanVectors.test.ts): public.invoice_collection_plan_core_v1 lấy NGUYÊN câu CREATE trong migration
// 20261022075219 (hàm thuần, search_path rỗng) và chạy trên PGlite trần. Ca ts=false là chỗ SQL chặt hơn TS có chủ ý hoặc khuôn sổ/dòng v5.
const MIGRATION = 'supabase/migrations/20261022075219_invoice_collection_plan_v1.sql';
const { vectors } = JSON.parse(readFileSync('src/lib/__tests__/fixtures/invoice-collection-plan-vectors.json', 'utf8'));
const coreSql = () => {
  const sql = readFileSync(MIGRATION, 'utf8').replaceAll('\r\n', '\n');
  const match = sql.match(/CREATE OR REPLACE FUNCTION public\.invoice_collection_plan_core_v1\([\s\S]*?END \$fn\$;/);
  assert.ok(match, 'câu CREATE của hàm lõi'); return match[0];
};
const MONEY = ['amountTm', 'amountTk', 'amountTt', 'change', 'credit', 'rounding', 'applied', 'returned', 'overpayAction'];

test('invoice_collection_plan_core_v1: khớp mọi vector (tiền, phần dư, làm tròn, cọc, sổ, sổ thối, thu trùng, khuôn p_tenders v5)', async t => {
  const db = new PGlite(); t.after(() => db.close());
  await db.exec(coreSql());
  const plan = async input => (await db.query('SELECT public.invoice_collection_plan_core_v1($1::jsonb) r', [JSON.stringify(input)])).rows[0].r;
  for (const v of vectors) {
    const got = await plan(v.input);
    assert.equal(got.ok, v.expected.ok, `${v.name}: ok`);
    if (v.expected.blockers) assert.deepEqual(got.blockers, v.expected.blockers, `${v.name}: blockers`);
    for (const key of MONEY) if (key in v.expected) assert.equal(got[key], v.expected[key], `${v.name}: ${key}`);
    if ('tenders' in v.expected) assert.deepEqual(got.tenders, v.expected.tenders, `${v.name}: tenders`);
    if ('changeAccount' in v.expected) assert.equal(got.accounts?.change, v.expected.changeAccount, `${v.name}: sổ thối`);
    if ('duplicate' in v.expected) assert.equal(got.duplicate?.id ?? null, v.expected.duplicate, `${v.name}: thu trùng`);
  }
  // Đầu vào sai khuôn ⇒ 22023 (không đoán).
  for (const bad of [null, { remaining: 1, lines: [] }, { remaining: 1, lines: Array.from({ length: 11 }, () => ({ method: 'TK', amount: 1 })) },
    { remaining: 1, lines: [{ method: 'TK', amount: 1 }], overpay: 'maybe' }])
    await assert.rejects(plan(bad), error => error.code === '22023', JSON.stringify(bad));
  // Hình thức lạ ⇒ chặn, không tính tiền.
  assert.deepEqual((await plan({ remaining: 100000, lines: [{ method: 'CK', amount: 100000 }] })).blockers, ['invalid_method']);
});
