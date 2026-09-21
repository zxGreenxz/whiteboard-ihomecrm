// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
const client = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock('@/integrations/supabase/client', () => ({ supabase: client }));
import { useUpdateIncomeExpenseRecipient } from './recipientMutations';
afterEach(cleanup);
it('invokes the Supabase RPC with its client receiver preserved', async () => {
  const voucherId = 'aaaaaaaa-0000-4000-8000-000000000001', organizationId = 'dddddddd-0000-4000-8000-000000000001';
  const original = { payerName: 'Old', bankName: null, bankAccount: null };
  const result = { voucherId, organizationId, recipient: { ...original, payerName: 'New' } };
  client.rpc.mockImplementation(function (this: unknown) {
    if (this !== client) throw new TypeError('Missing Supabase client receiver');
    return Promise.resolve({ data: result, error: null });
  });
  const query = new QueryClient();
  try {
    const hook = renderHook(() => useUpdateIncomeExpenseRecipient(), { wrapper: ({ children }: { children: ReactNode }) => <QueryClientProvider client={query}>{children}</QueryClientProvider> });
    await act(async () => { expect(await hook.result.current.mutateAsync({ voucherId, organizationId,
      expected: { ...original, approvalVersion: 1, postingVersion: 1, reviewVersion: 1 }, patch: { payerName: 'New' } })).toEqual(result); });
    expect(client.rpc).toHaveBeenCalledTimes(1);
  } finally { query.clear(); }
});
