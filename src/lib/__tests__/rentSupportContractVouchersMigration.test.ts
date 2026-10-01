import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { beforeAll, afterAll, expect, it } from 'vitest';

const db = new PGlite();
const migration = readFileSync('supabase/migrations/20261001082829_rent_support_contract_vouchers.sql', 'utf8');
const party = '11111111-1111-4111-8111-111111111111';
const other = '22222222-2222-4222-8222-222222222222';
const plan = { version: 2, start_billing_month: '2026-09', payer: 'SALE', sale_party_id: null,
  deduction_policy: 'COMMISSION_ONLY', collection_mode: 'UPFRONT_COMMITTED',
  segments: [{ month_count: 3, monthly_amount: '300000' }, { month_count: 9, monthly_amount: '100000' }] };
const sources = [
  { source_id: party, kind: 'COMMISSION', party_id: party, gross_original: '3000000' },
  { source_id: other, kind: 'BONUS', party_id: other, gross_original: '500000' },
].map(source => ({ ...source, already_paid: '0', prior_withheld: '0', reserved: '0', verified: true, locked: false, route: 'CASHBOOK' }));
beforeAll(async () => {
  await db.exec('CREATE SCHEMA app_private;');
  const pureFunctions = migration.split('CREATE OR REPLACE FUNCTION app_private.rent_support_withholding_guard_v1')[0];
  await db.exec(pureFunctions); await db.exec(pureFunctions);
}, 30000);
afterAll(async () => db.close());
type Quote = { state: string; due_upfront: string; sources: { kind: string; current_withheld: string; net_this_operation: string }[] };
async function quote(policy: string, bound: string | null = null, committed = 0) {
  return (await db.query<{ result: Quote }>('SELECT app_private.rent_support_allocate_funding_v1($1,$2,$3,1800000,$4,$5) result',
    ['SALE', bound, policy, committed, JSON.stringify(sources)])).rows[0].result;
}
it('saves a Sale schedule without a recipient while preserving the full monthly commitment', async () => {
  const result = (await db.query<{ result: { payload: typeof plan; committed_total: string; months: unknown[] } }>(
    'SELECT app_private.validate_rent_support_v1($1) result', [JSON.stringify(plan)])).rows[0].result;
  expect(result.payload.sale_party_id).toBeNull(); expect(result.committed_total).toBe('1800000'); expect(result.months).toHaveLength(12);
});
it('deducts bonus first and then commission from canonical contract sources with different recipients', async () => {
  const q = await quote('BONUS_THEN_COMMISSION'); expect(q.state).toBe('READY');
  expect(q.sources.map(s => [s.kind, s.current_withheld, s.net_this_operation])).toEqual([
    ['BONUS', '500000', '0'], ['COMMISSION', '1300000', '1700000'],
  ]);
});
it('defaults to commission only and never deducts the same funded commitment again', async () => {
  const q = await quote('COMMISSION_ONLY'); expect(q.state).toBe('READY');
  expect(q.sources.find(s => s.kind === 'COMMISSION')?.current_withheld).toBe('1800000');
  expect(q.sources.find(s => s.kind === 'BONUS')?.current_withheld).toBe('0');
  const replay = await quote('COMMISSION_ONLY', null, 1800000);
  expect(replay.due_upfront).toBe('0'); expect(replay.sources.every(s => s.current_withheld === '0')).toBe(true);
});
it('keeps existing explicit recipient bindings enforced', async () => {
  const q = await quote('BONUS_THEN_COMMISSION', party); expect(q.state).toBe('READY');
  expect(q.sources.find(s => s.kind === 'BONUS')?.current_withheld).toBe('0');
  expect(q.sources.find(s => s.kind === 'COMMISSION')?.current_withheld).toBe('1800000');
});
