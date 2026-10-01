import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ results: [] as unknown[], query: vi.fn(), user: vi.fn() }));
vi.mock('@tanstack/react-query', () => ({ useQuery: (options: unknown) => options }));
vi.mock('@/lib/authSession', () => ({ getSessionUser: mocks.user }));
vi.mock('@/integrations/supabase/client', () => ({ supabase: { from: (...args: unknown[]) => mocks.query(...args) } }));
import { useVacantRoomsReport, useTerminationsReport, useExpenseRatioReport } from '../realEstateReports';
beforeEach(() => {
  mocks.results = []; mocks.user.mockResolvedValue({ id: 'user' });
  mocks.query.mockImplementation(() => {
    const result = mocks.results.shift();
    const chain = new Proxy({}, { get: (_, name) => name === 'then' ? Promise.resolve(result).then.bind(Promise.resolve(result)) : () => chain });
    return chain;
  });
});
const run = (query: unknown) => (query as { queryFn: () => Promise<unknown> }).queryFn();
describe('required estate report sources', () => {
  it('rejects missing ended contracts instead of calculating vacancy with absent dates', async () => {
    const error = { code: 'XX000' };
    mocks.results = [{ data: [] }, { data: [] }, { data: null, error }];
    await expect(run(useVacantRoomsReport())).rejects.toBe(error);
  });
  it('rejects failed termination details instead of filling unknown types', async () => {
    const error = { code: '42501' };
    mocks.results = [{ data: [{ id: 'c', status: 'TERMINATED' }] }, { data: null, error }];
    await expect(run(useTerminationsReport())).rejects.toBe(error);
  });
  it('groups expenses by type read separately instead of a per-row type embed (prod timeout 57014)', async () => {
    mocks.results = [
      { data: [{ id: 'i1', voucher_date: '2026-09-05', building_id: 'b', total_amount: 1000000 }] }, { data: [] },
      { data: [{ id: 'e1', voucher_date: '2026-09-06', building_id: 'b', type: 'EXPENSE', approval_status: 'APPROVED',
        income_expense_items: [{ amount: 200000, income_expense_type_id: 't1' }, { amount: 50000, income_expense_type_id: 'hidden' }, { amount: 70000, income_expense_type_id: 't2' }] }] }, { data: [] },
      { data: [{ id: 't1', name: 'Điện', category: 'Vận hành', type: 'expense' }, { id: 't2', name: 'Thu khác', category: 'Thu', type: 'income' }] }, { data: [] },
    ];
    const report = await run(useExpenseRatioReport(new Date(2026, 8, 1), new Date(2026, 8, 30))) as { byMonth: { month: string; totalExpense: number; revenue: number }[]; byTypeName: { typeName: string; total: number }[] };
    expect(mocks.query.mock.calls.map(call => call[0]).slice(-6)).toEqual(['income_expenses', 'income_expenses', 'income_expenses', 'income_expenses', 'income_expense_types', 'income_expense_types']);
    expect(report.byMonth).toEqual([expect.objectContaining({ month: '2026-09', revenue: 1000000, totalExpense: 200000 })]);
    expect(report.byTypeName).toEqual([{ category: 'Vận hành', typeName: 'Điện', total: 200000 }]);
  });
  it('rejects an unreadable type table instead of dropping every expense', async () => {
    mocks.results = [{ data: [] }, { data: [] }, { data: null, error: { code: '42501' } }];
    await expect(run(useExpenseRatioReport(new Date(2026, 8, 1), new Date(2026, 8, 30)))).rejects.toBeTruthy();
  });
  it('does not convert an expired login to zero expense totals', async () => {
    mocks.user.mockResolvedValue(null);
    await expect(run(useExpenseRatioReport())).rejects.toMatchObject({ message: expect.stringMatching(/authenticated/) });
  });
});
