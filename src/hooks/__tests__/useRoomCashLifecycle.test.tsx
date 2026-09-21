// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({ actor: 'aaaaaaaa-0000-4000-8000-000000000001' as string | null,
  org: 'aaaaaaaa-0000-4000-8000-000000000002' as string | null, rpc: vi.fn(), listeners: new Map<string, () => void>() }));
vi.mock('@/hooks/useAuth', () => ({ useAuth: () => ({ data: state.actor ? { id: state.actor } : null }) }));
vi.mock('@/contexts/OrganizationContext', () => ({ useOrganization: () => ({ selectedOrganizationId: state.org }) }));
vi.mock('@/integrations/supabase/client', () => ({ supabase: { rpc: state.rpc,
  channel: () => { const channel = { on: (_event: string, filter: { table: string }, listener: () => void) => { state.listeners.set(filter.table, listener); return channel; }, subscribe: () => channel }; return channel; }, removeChannel: vi.fn(),
} }));
import { useRoomCashLifecycle } from '../useRoomCashLifecycle';
const roomId = 'aaaaaaaa-0000-4000-8000-000000000003';
const contractId = 'aaaaaaaa-0000-4000-8000-000000000004';
const fixture = (signedDate = '2026-09-01') => ({ organizationId: state.org, today: '2026-09-20',
  room: { id: roomId, name: '301', buildingId: roomId, buildingName: '80DS3' }, range: { from: null, to: null },
  contracts: [{ id: contractId, number: 'HD1', status: 'ACTIVE', signedDate, startDate: '2026-09-05', endDate: null, actualEndDate: null, rentPrice: 4_000_000, totalDeposit: 4_000_000, tenantName: 'Khách' }],
  segments: [], events: [], vacancies: [], generatedAt: '2026-09-20T10:00:00Z' });
const clients: QueryClient[] = [];
const wrapper = () => { const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } }); clients.push(client);
  return ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>; };
beforeEach(() => { state.actor = 'aaaaaaaa-0000-4000-8000-000000000001'; state.org = 'aaaaaaaa-0000-4000-8000-000000000002'; state.listeners.clear(); state.rpc.mockReset(); });
afterEach(() => { cleanup(); clients.splice(0).forEach(client => client.clear()); });
const respond = (data: unknown, error: { code: string; message: string } | null = null) => {
  const promise = Promise.resolve({ data, error }); return Object.assign(promise, { abortSignal: () => promise });
};
describe('shared room lifecycle read boundary', () => {
  it('does not query without a selected organization', () => {
    state.org = null; renderHook(() => useRoomCashLifecycle(roomId), { wrapper: wrapper() }); expect(state.rpc).not.toHaveBeenCalled();
  });
  it('rejects cross-org payload and maps denied reads without raw server details', async () => {
    state.rpc.mockReturnValueOnce(respond({ ...fixture(), organizationId: roomId }));
    const hook = renderHook(() => useRoomCashLifecycle(roomId), { wrapper: wrapper() });
    await waitFor(() => expect(hook.result.current.isError).toBe(true)); expect(hook.result.current.data).toBeUndefined();
    state.rpc.mockReturnValueOnce(respond(null, { code: '42501', message: 'private server details' }));
    await act(async () => { await hook.result.current.refetch(); });
    await waitFor(() => expect(hook.result.current.error?.message).toBe('Bạn không có quyền xem lịch sử phòng trong phạm vi này.'));
  });
  it('does not reuse the old actor cache after switching accounts', async () => {
    state.rpc.mockImplementation(() => respond(fixture()));
    const hook = renderHook(() => useRoomCashLifecycle(roomId), { wrapper: wrapper() });
    await waitFor(() => expect(hook.result.current.isSuccess).toBe(true));
    state.actor = roomId; state.rpc.mockReturnValue(respond(null, { code: '42501', message: 'denied' }));
    hook.rerender(); expect(hook.result.current.data).toBeUndefined();
    await waitFor(() => expect(hook.result.current.isError).toBe(true)); expect(state.rpc).toHaveBeenCalledTimes(2);
  });
  it('reloads signed dates and residence history on contract events without changing the room target', async () => {
    state.rpc.mockReturnValue(respond(fixture()));
    const hook = renderHook(() => useRoomCashLifecycle(roomId), { wrapper: wrapper() });
    await waitFor(() => expect(hook.result.current.data?.contracts[0].signedDate).toBe('2026-09-01'));
    state.rpc.mockReturnValue(respond(fixture('2026-09-02')));
    expect(state.listeners.has('contract_transfers')).toBe(true);
    expect(state.listeners.has('contract_terminations')).toBe(true);
    await act(async () => { state.listeners.get('contracts')!(); });
    await waitFor(() => expect(hook.result.current.data?.contracts[0].signedDate).toBe('2026-09-02'));
    expect(state.rpc.mock.calls.every(call => call[1].p_room_id === roomId)).toBe(true);
  });
});
