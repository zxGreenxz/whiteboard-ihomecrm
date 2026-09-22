// @vitest-environment jsdom
import { createElement, type ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { useIncomeExpenseFormBuildings } from '@/hooks/useIncomeExpenseFormScope';

const rpc = vi.hoisted(() => vi.fn());
vi.mock('@/integrations/supabase/client', () => ({ supabase: { rpc } }));

it('nguồn tòa bắt buộc giữ lỗi riêng với rỗng và refetch phục hồi được', async () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => createElement(QueryClientProvider, { client }, children);
  rpc.mockResolvedValueOnce({ data: null, error: { message: 'offline' } });
  const { result } = renderHook(() => useIncomeExpenseFormBuildings({ failOnError: true }), { wrapper });
  await waitFor(() => expect(result.current.isError).toBe(true));
  expect(result.current.data).toBeUndefined();
  rpc.mockResolvedValueOnce({ data: [], error: null });
  await result.current.refetch();
  await waitFor(() => expect(result.current.isSuccess).toBe(true));
  expect(result.current.data).toEqual([]);
});
