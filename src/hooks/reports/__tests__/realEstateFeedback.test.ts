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
  it('does not convert an expired login to zero expense totals', async () => {
    mocks.user.mockResolvedValue(null);
    await expect(run(useExpenseRatioReport())).rejects.toMatchObject({ message: expect.stringMatching(/authenticated/) });
  });
});
