import { beforeEach, expect, it, vi } from 'vitest';
import { hasCompleteCommissionVisibility, readProfitCommissionChecks } from '@/hooks/useProfitCommissionChecks';
import type { CommissionCheckContract, CommissionCheckVoucher } from '@/lib/profitCommissionChecks';

const data = vi.hoisted(() => ({
  tables: {} as Record<string, Record<string, unknown>[]>, calls: [] as { table: string; ops: [string, unknown[]][] }[],
  permissions: {} as unknown, restricted: true, errorTable: '', followupError: false,
}));
vi.mock('@/integrations/supabase/client', () => ({ supabase: {
  from: (table: string) => {
    const ops: [string, unknown[]][] = []; data.calls.push({ table, ops });
    const valueAt = (row: Record<string, unknown>, key: string): unknown => key.split('.').reduce<unknown>((value, part) =>
      value && typeof value === 'object' ? (value as Record<string, unknown>)[part] : undefined, row);
    const builder: unknown = new Proxy({}, { get: (_, method) => {
      if (method === 'then') return (resolve: (value: unknown) => void) => {
        let rows = data.tables[table] ?? [];
        for (const [op, args] of ops) {
          const [key, value] = args;
          if (op === 'eq' || op === 'is') rows = rows.filter(row => valueAt(row, String(key)) === value);
          if (op === 'neq') rows = rows.filter(row => valueAt(row, String(key)) !== value);
          if (op === 'in') rows = rows.filter(row => (value as unknown[]).includes(valueAt(row, String(key))));
          if (op === 'gte') rows = rows.filter(row => String(valueAt(row, String(key))) >= String(value));
          if (op === 'lte') rows = rows.filter(row => String(valueAt(row, String(key))) <= String(value));
          if (op === 'range') rows = rows.slice(Number(key), Number(value) + 1);
        }
        resolve(data.errorTable === table ? { data: null, error: { message: 'offline' } } : { data: rows, error: null });
      };
      return (...args: unknown[]) => { ops.push([String(method), args]); return builder; };
    } });
    return builder;
  },
  rpc: (name: string, args?: Record<string, unknown>) => ({ abortSignal: () => {
    if (name === 'get_my_permissions_v2') return Promise.resolve({ data: data.permissions, error: null });
    if (name === 'can_view_restricted_ie') return Promise.resolve({ data: data.restricted, error: null });
    const ids = args?.p_contract_ids as string[];
    const rows = ids.map(id => ({ contract_id: id, contract_number: 'DEMO', building_id: BUILDING,
      building_name: 'Tòa thử', room_name: '101', kind: 'broker', state: 'PENDING', last_reason: null, last_at: null,
      last_actor: null, attempted_amount: null, can_manage: true, voucher_id: null, voucher_code: null, voucher_status: null, events: [] }));
    return Promise.resolve({ data: { rows, total: rows.length, counts_by_kind: { all: rows.length, broker: rows.length, sale: 0 } },
      error: data.followupError ? { message: 'followup unavailable' } : null });
  } }),
} }));

const ORG = '10000000-0000-4000-8000-000000000001';
const OTHER_ORG = '10000000-0000-4000-8000-000000000002';
const BUILDING = '20000000-0000-4000-8000-000000000001';
const CONTRACT = '30000000-0000-4000-8000-000000000001';
const scope = { organizationId: ORG, buildingIds: [BUILDING], month: '2026-11' };
const contract: CommissionCheckContract & { deleted_at: null } = { id: CONTRACT, organization_id: ORG, contract_number: 'DEMO',
  start_date: '2026-11-03', signed_date: '2026-10-25', status: 'ACTIVE', deleted_at: null, room_id: 'room',
  room: { id: 'room', name: '101', building_id: BUILDING, building: { name: 'Tòa thử' } } };
const voucher: CommissionCheckVoucher = { id: 'voucher', organization_id: ORG, contract_id: CONTRACT, code: 'DEMO-PC',
  room_id: 'room', building_id: BUILDING, type: 'EXPENSE', deleted_at: null, total_amount: 50,
  voucher_date: '2026-09-03', commission_kind: 'broker', system_source: null, approval_status: 'APPROVED', posting_status: 'POSTED',
  active_posting_id_v2: 'posting', business_result_accounting: null, invoice_id: null, invoice: null, items: [] };
const run = () => readProfitCommissionChecks(scope, new AbortController().signal);
beforeEach(() => {
  data.calls = []; data.errorTable = ''; data.followupError = false; data.restricted = true;
  data.permissions = { __superadmin: true };
  data.tables = { contracts: [{ ...contract }], income_expenses: [{ ...voucher }], income_expense_postings: [] };
});

it('reads the selected start period but checks vouchers from all periods in the exact org and contract', async () => {
  data.tables.contracts.push({ ...contract, id: 'other', organization_id: OTHER_ORG }, { ...contract, id: 'draft', status: 'DRAFT' },
    { ...contract, id: 'old', start_date: '2026-10-01' });
  data.tables.income_expenses.push({ ...voucher, id: 'foreign', organization_id: OTHER_ORG }, { ...voucher, id: 'previous', contract_id: 'old' });
  const result = await run();
  expect(result.rows).toHaveLength(1); expect(result.rows[0].vouchers).toHaveLength(1);
  expect(result.rows[0].vouchers[0].voucher.voucher_date).toBe('2026-09-03');
  expect(result.rows[0].vouchers[0].postedOn).toBeNull();
  expect(result.postingReadFailed).toBe(true);
});
it('never infers a link from a matching room: surfaces the unlinked voucher separately', async () => {
  data.tables.income_expenses = [{ ...voucher, contract_id: null }];
  const result = await run(); expect(result.rows[0].state).toBe('MISSING'); expect(result.orphans).toHaveLength(1);
});
it('continues beyond 1,000 vouchers and counts a duplicate from the next page', async () => {
  data.tables.income_expenses = Array.from({ length: 1001 }, (_, i) => ({ ...voucher, id: `v-${i}` }));
  const result = await run(); expect(result.rows[0].vouchers).toHaveLength(1001); expect(result.rows[0].state).toBe('DUPLICATE');
});
it.each(['contracts', 'income_expenses'])('fails closed when %s cannot be read', async table => {
  data.errorTable = table; await expect(run()).rejects.toThrow();
});
it('does not manufacture missing decisions when the canonical follow-up fails', async () => {
  data.followupError = true; await expect(run()).rejects.toBeTruthy();
});
it('keeps voucher identity when posting rows are inaccessible or unavailable', async () => {
  data.errorTable = 'income_expense_postings'; const result = await run();
  expect(result.rows[0].state).toBe('ONE'); expect(result.rows[0].vouchers[0].postedOn).toBeNull(); expect(result.postingReadFailed).toBe(true);
});
it('warns when a successful posting read returns only part of the requested payment dates', async () => {
  data.tables.income_expenses.push({ ...voucher, id: 'second', active_posting_id_v2: 'posting-second' });
  data.tables.income_expense_postings = [{ id: 'posting', organization_id: ORG, posted_on: '2026-10-02' }];
  const result = await run();
  expect(result.postingReadFailed).toBe(true);
  expect(result.rows[0].vouchers.map(row => row.postedOn)).toEqual(['2026-10-02', null]);
});
it('scoped or restricted visibility never turns an empty result into confirmed absence', async () => {
  data.restricted = false; data.tables.income_expenses = [];
  expect((await run()).rows[0].state).toBe('UNVERIFIED');
  const full = { org_wide: true, building_ids: [] };
  expect(hasCompleteCommissionVisibility({ contracts: { view: full }, buildings: { view: full }, income_expenses: { view: full } }, true)).toBe(true);
  expect(hasCompleteCommissionVisibility({ contracts: { view: full }, buildings: { view: full }, income_expenses: { view: { ...full, org_wide: false, building_ids: [BUILDING] } } }, true)).toBe(false);
});
