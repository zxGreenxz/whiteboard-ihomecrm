// @vitest-environment jsdom
import type { ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';

const rpc = vi.hoisted(() => vi.fn());
vi.mock('@/integrations/supabase/client', () => ({ supabase: { rpc } }));
vi.mock('@/lib/storage', () => ({ uploadFile: vi.fn(), deleteFile: vi.fn(), sanitizeStorageFileName: vi.fn() }));
vi.mock('@/components/income-expenses/AttachmentUpload', () => ({ validateAttachmentFile: vi.fn() }));
import { useCustodianCashbooksV2 } from '../financeV2Mutations';

afterEach(cleanup);

it('lỗi RPC là trạng thái lỗi; thử lại thành công với [] mới là thật sự không có sổ', async () => {
  rpc.mockResolvedValueOnce({ data: null, error: { message: 'Không đọc được sổ' } })
    .mockResolvedValueOnce({ data: [], error: null });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  const { result } = renderHook(() => useCustodianCashbooksV2(true), { wrapper });
  await waitFor(() => expect(result.current.isError).toBe(true));
  expect(result.current.data).toBeUndefined();
  expect(result.current.error?.message).toBe('Không đọc được sổ');
  await act(async () => { await result.current.refetch(); });
  await waitFor(() => expect(result.current.isSuccess).toBe(true));
  expect(result.current.data).toEqual([]);
  expect(rpc).toHaveBeenCalledTimes(2);
  expect(rpc).toHaveBeenLastCalledWith('list_cashbooks_for_expense_v2', undefined);
  client.clear();
});
