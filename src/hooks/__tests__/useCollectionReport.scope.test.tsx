// @vitest-environment jsdom
import { act, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useThuTienBuildings } from '../useThuTienBuildings';
import { useThuTienInvoices } from '../useCollectionReport';

const mock = vi.hoisted(() => ({
  org: 'org-a',
  permissions: { data: undefined as unknown, isLoading: false, isPending: false, isError: false, error: null as unknown, refetch: vi.fn() },
  buildings: { data: [] as { id: string; organization_id: string; name: string }[], isLoading: false, isPending: false, isError: false, error: null, refetch: vi.fn() },
  from: vi.fn(), eq: vi.fn(), in: vi.fn(), range: vi.fn(),
}));
vi.mock('@/contexts/OrganizationContext', () => ({ useOrganization: () => ({ selectedOrganizationId: mock.org }) }));
vi.mock('@/hooks/useMyPermissions', () => ({ useMyPermissions: () => mock.permissions }));
vi.mock('@/hooks/useBuildings', () => ({ useBuildings: () => mock.buildings }));
vi.mock('@/integrations/supabase/client', () => ({ supabase: { from: mock.from } }));

function wrapper() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  return ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}
beforeEach(() => {
  vi.clearAllMocks();
  mock.org = 'org-a';
  mock.permissions.isError = false;
  mock.permissions.error = null;
  mock.permissions.data = {
    buildings: { view: { org_wide: true, building_ids: [] } },
    thu_tien: { view: { org_wide: false, building_ids: ['a'] } },
  };
  mock.buildings.data = [
    { id: 'a', name: 'Assigned', organization_id: 'org-a' },
    { id: 'b', name: 'Colleague', organization_id: 'org-a' },
    { id: 'c', name: 'Another company', organization_id: 'org-b' },
  ];
  const query = { select: vi.fn().mockReturnThis(), is: vi.fn().mockReturnThis(), neq: vi.fn().mockReturnThis(),
    eq: mock.eq.mockReturnThis(), in: mock.in.mockReturnThis(), order: vi.fn().mockReturnThis(),
    range: mock.range.mockResolvedValue({ data: [], error: null }) };
  mock.from.mockReturnValue(query);
});

describe('Thu tiền remains assigned while operations become company-wide', () => {
  it('does not turn building.view company scope into collection scope', () => {
    const hook = renderHook(() => useThuTienBuildings(), { wrapper: wrapper() });
    expect(hook.result.current.data?.map(building => building.id)).toEqual(['a']);
  });
  it('filters the actual invoice request by organization AND assigned buildings', async () => {
    const hook = renderHook(() => useThuTienInvoices('2026-11'), { wrapper: wrapper() });
    await waitFor(() => expect(hook.result.current.isSuccess).toBe(true));
    expect(mock.eq).toHaveBeenCalledWith('organization_id', 'org-a');
    expect(mock.in).toHaveBeenCalledWith('building_id', ['a']);
  });
  it('does not issue an unbounded request while permissions are loading or empty', async () => {
    mock.permissions.data = undefined;
    const hook = renderHook(() => useThuTienInvoices('2026-11'), { wrapper: wrapper() });
    expect(mock.from).not.toHaveBeenCalled();
    act(() => { mock.permissions.data = {}; hook.rerender(); });
    await waitFor(() => expect(hook.result.current.isSuccess).toBe(true));
    expect(hook.result.current.data).toEqual([]);
    expect(mock.from).not.toHaveBeenCalled();
  });
  it('invalidates the visible cache when scope is revoked, including a failed refresh', async () => {
    const hook = renderHook(() => useThuTienInvoices('2026-11'), { wrapper: wrapper() });
    await waitFor(() => expect(hook.result.current.isSuccess).toBe(true));
    act(() => { mock.permissions.isError = true; mock.permissions.error = new Error('Unavailable'); hook.rerender(); });
    expect(hook.result.current.data).toBeUndefined();
    expect(mock.from).toHaveBeenCalledTimes(1);
  });
  it('uses a new query and scope when switching organization', async () => {
    const hook = renderHook(() => useThuTienInvoices('2026-11'), { wrapper: wrapper() });
    await waitFor(() => expect(hook.result.current.isSuccess).toBe(true));
    act(() => {
      mock.org = 'org-b';
      mock.permissions.data = { thu_tien: { view: { org_wide: false, building_ids: ['c'] } } };
      hook.rerender();
    });
    await waitFor(() => expect(mock.in).toHaveBeenLastCalledWith('building_id', ['c']));
    expect(mock.eq).toHaveBeenCalledWith('organization_id', 'org-b');
  });
});
