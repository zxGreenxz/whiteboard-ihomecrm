// @vitest-environment jsdom
//
// Ranh giới invalidate của useCreateContract sau bản vá 15/09 (plan con B).
//
// create_contract_v2 ghi 5 bảng có realtime, nên hub sẽ tự đánh lượt thứ hai
// trên ~70 khoá rồi prefetch 3 domain. Chín lượt invalidate cũ ở onSuccess gần
// như trùng khít với lượt đó — trừ ["rooms"], thứ mà descriptor `rooms` CỐ Ý
// không khai (nó chỉ mang ["business-performance"]).
//
// Ca dưới đây ghim cả ba điều: cái gì còn đánh, cái gì cố ý thôi, và mốc
// markLocalWrite — thiếu mốc ấy thì phần cắt chỉ là dời việc sang hub.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';

const boundary = vi.hoisted(() => ({ create: vi.fn() }));
vi.mock('@/lib/contractCreateRpc', () => ({ createContractV2: boundary.create }));
vi.mock('@/integrations/supabase/client', () => ({ supabase: { rpc: vi.fn() } }));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { useCreateContract } from '../useContracts';
import {
  laTiengVongNoiBo,
  __resetLocalWriteEchoForTest,
} from '@/lib/realtime/localWriteEcho';
import type { ContractCreateRequest } from '@/lib/contractCreateRpc';

const wrapperFor = (client: QueryClient) =>
  ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );

describe('useCreateContract — lượt invalidate thứ nhất', () => {
  beforeEach(() => {
    __resetLocalWriteEchoForTest();
    boundary.create.mockResolvedValue({ contract: { id: 'hd-1' } });
  });
  afterEach(() => __resetLocalWriteEchoForTest());

  it('chỉ còn khoá màn đang mở và khoá hub KHÔNG phủ', async () => {
    const client = new QueryClient({
      defaultOptions: { queries: { staleTime: Infinity }, mutations: { retry: false } },
    });
    const conGiu = ['contracts', 'rooms'];
    // Bảy khoá này nằm trong descriptor `invoices` / `income_expenses` của hub.
    const hubPhu = [
      'invoices',
      'invoices-legacy',
      'income-expenses',
      'accounts-with-balance',
      'reservation-deposits',
      'orphan-deposit-vouchers',
    ];
    for (const key of [...conGiu, ...hubPhu, 'accounts']) {
      client.setQueryData([key, 'ngu-canh'], { cu: true });
    }

    const { result, unmount } = renderHook(useCreateContract, {
      wrapper: wrapperFor(client),
    });
    await act(() => result.current.mutateAsync({} as ContractCreateRequest));

    for (const key of conGiu) {
      expect(client.getQueryState([key, 'ngu-canh'])?.isInvalidated, key).toBe(true);
    }
    for (const key of hubPhu) {
      expect(client.getQueryState([key, 'ngu-canh'])?.isInvalidated, key).toBe(false);
    }
    // `accounts` (danh sách sổ quỹ) không đổi khi tạo hợp đồng — chỉ số dư đổi,
    // và số dư đi bằng khoá `accounts-with-balance` do hub lo.
    expect(client.getQueryState(['accounts', 'ngu-canh'])?.isInvalidated).toBe(false);

    unmount();
    client.clear();
  });

  it('đánh dấu đủ 5 bảng realtime mà RPC thật sự ghi', async () => {
    const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
    const { result, unmount } = renderHook(useCreateContract, {
      wrapper: wrapperFor(client),
    });
    await act(() => result.current.mutateAsync({} as ContractCreateRequest));

    const bayGio = Date.now();
    for (const bang of [
      'contracts',
      'rooms',
      'invoices',
      'income_expenses',
      'income_expense_items',
    ] as const) {
      expect(laTiengVongNoiBo(bang, bayGio), bang).toBe(true);
    }
    // Không khai thừa: bảng RPC không ghi thì đừng bịt tai với máy khác.
    expect(laTiengVongNoiBo('customers', bayGio)).toBe(false);
    expect(laTiengVongNoiBo('payments', bayGio)).toBe(false);

    unmount();
    client.clear();
  });
});
