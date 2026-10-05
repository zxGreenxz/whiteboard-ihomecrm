// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fetchPersonalFinancePermissions, usePersonalFinancePermissions } from '../usePersonalFinancePermissions';

const h = vi.hoisted(() => ({ rpc: vi.fn(), getSession: vi.fn(), setHeader: vi.fn() }));
vi.mock('@/integrations/supabase/client', () => ({ supabase: { rpc: h.rpc, auth: { getSession: h.getSession } } }));
const denied = { view: false, create: false, edit: false, delete: false };
function response(data: unknown, error: unknown = null) {
  const result = Promise.resolve({ data, error });
  h.setHeader.mockImplementation(() => result);
  h.rpc.mockReturnValue({ setHeader: h.setHeader });
}
beforeEach(() => {
  h.getSession.mockResolvedValue({ data: { session: { user: { id: 'actor-a' }, access_token: 'fixture-a' } }, error: null });
  response({});
});
afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe('personal-only permission projection', () => {
  it.each([null, [], {}, { income_expenses: { create: true } }, { __superadmin: 'true' }, { personal_finance: { view: 'true', create: 1, edit: {}, delete: [] } }])('fails closed for absent or malformed permissions: %j', async input => {
    response(input);
    expect(await fetchPersonalFinancePermissions('actor-a')).toEqual(denied);
  });
  it('converts the owner sentinel only to personal actions and pins the verified actor JWT', async () => {
    response({ __superadmin: true, income_expenses: { create: true }, invoices: { delete: true } });
    expect(await fetchPersonalFinancePermissions('actor-a')).toEqual({ view: true, create: true, edit: true, delete: true });
    expect(h.rpc).toHaveBeenCalledWith('get_my_permissions');
    expect(h.setHeader).toHaveBeenCalledWith('Authorization', 'Bearer fixture-a');
  });
  it('preserves individual denied actions and understands a legitimate scoped grant', async () => {
    response({ personal_finance: { view: true, create: { org_wide: false, building_ids: ['building-a'] }, edit: false }, income_expenses: { delete: true } });
    expect(await fetchPersonalFinancePermissions('actor-a')).toEqual({ view: true, create: true, edit: false, delete: false });
  });
  it('refuses to load actor A permissions using actor B session', async () => {
    await expect(fetchPersonalFinancePermissions('actor-b')).rejects.toThrow('Phiên đăng nhập đã thay đổi.');
    expect(h.rpc).not.toHaveBeenCalled();
  });
  it('throws backend read errors rather than claiming the account was denied', async () => {
    response(null, new Error('Temporary failure'));
    await expect(fetchPersonalFinancePermissions('actor-a')).rejects.toThrow('Temporary failure');
  });
});

it('an actor switch never exposes the previous actor cached personal grants', async () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(['auth', 'user'], { id: 'actor-a' });
  response({ __superadmin: true });
  const { result } = renderHook(() => usePersonalFinancePermissions(), { wrapper: ({ children }) => <QueryClientProvider client={client}>{children}</QueryClientProvider> });
  await waitFor(() => expect(result.current.data?.create).toBe(true));
  let finish!: (value: unknown) => void;
  const pending = new Promise(resolve => { finish = resolve; });
  h.rpc.mockReturnValue({ setHeader: () => pending });
  h.getSession.mockResolvedValue({ data: { session: { user: { id: 'actor-b' }, access_token: 'fixture-b' } }, error: null });
  await act(async () => { client.setQueryData(['auth', 'user'], { id: 'actor-b' }); });
  await waitFor(() => expect(result.current.data).toBeUndefined());
  await act(async () => { finish({ data: {}, error: null }); });
  await waitFor(() => expect(result.current.data).toEqual(denied));
});

it('a failed refresh hides cached grants and keeps the error available for retry', async () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(['auth', 'user'], { id: 'actor-a' });
  response({ __superadmin: true });
  const { result } = renderHook(() => usePersonalFinancePermissions(), { wrapper: ({ children }) => <QueryClientProvider client={client}>{children}</QueryClientProvider> });
  await waitFor(() => expect(result.current.data?.create).toBe(true));
  response(null, new Error('Read unavailable'));
  await act(async () => { await result.current.refetch(); });
  await waitFor(() => expect(result.current.isError).toBe(true));
  expect(result.current.data).toBeUndefined();
  response({});
  await act(async () => { await result.current.refetch(); });
  await waitFor(() => expect(result.current.data).toEqual(denied));
});
