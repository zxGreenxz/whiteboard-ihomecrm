// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
const m = vi.hoisted(() => ({ read: vi.fn() }));
vi.mock('@/lib/contractSettlementReader', async original => ({ ...await original<object>(), readContractSettlement: m.read }));
vi.mock('@/lib/contractSettlementRepository', () => ({ readSettlementPage: vi.fn() }));
vi.mock('@/integrations/supabase/client', () => ({ supabase: {
  channel: () => ({ on() { return this; }, subscribe() { return this; } }), removeChannel: vi.fn(),
} }));
import { useContractSettlement } from '../useContractSettlement';
const scope = { organizationId: 'org', actorId: 'actor', scopeRevision: 'r1', buildingIds: ['building'], period: '2026-09', mode: 'all' as const, dateBasis: 'business' as const, filters: { period: '2026-09' } };
const complete = { rows: [], totals: null, partial: false, error: null, pagination: { complete: true, pages: 1, nextCursor: null } };
afterEach(() => { cleanup(); vi.clearAllMocks(); });
it('exposes background fetching and rejects an incomplete refresh even without transport error', async () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  m.read.mockResolvedValueOnce(complete);
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  const { result } = renderHook(() => useContractSettlement(scope), { wrapper });
  await waitFor(() => expect(result.current.pagination.complete).toBe(true));
  let resolve!: (value: typeof complete) => void;
  m.read.mockImplementationOnce(() => new Promise(r => { resolve = r; }));
  let pending!: Promise<void>;
  act(() => { pending = result.current.refresh(); });
  await waitFor(() => expect(result.current.fetching).toBe(true));
  expect(result.current.loading).toBe(false);
  await act(async () => { resolve({ ...complete, partial: true, pagination: { ...complete.pagination, complete: false } }); await expect(pending).rejects.toThrow('Chưa tải lại'); });
  await waitFor(() => expect(result.current.fetching).toBe(false));
  client.clear();
});
