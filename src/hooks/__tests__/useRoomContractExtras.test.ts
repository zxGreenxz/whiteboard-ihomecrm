// @vitest-environment jsdom
// =============================================================================
// useRoomContractExtras — đọc phụ cho ngăn kéo "Vòng đời hợp đồng".
//
// Gia hạn chỉ lấy lượt HIỆU LỰC (APPROVED/COMPLETED) và lọc NGAY TRÊN SERVER —
// cùng quy ước với useRenewedContracts và `originalEndDate` của RPC phòng. Lượt
// DRAFT hay trạng thái lạ không được lọt thành mốc "Gia hạn hợp đồng".
// Ranh giới giả lập: builder PostgREST + fetchAllRows (như useContractLifecycle).
// =============================================================================

import { createElement, type ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useRoomContractExtras } from '@/hooks/useRoomContractExtras';

const H = vi.hoisted(() => ({
  bang: new Map<string, unknown[] | null>(),
  chuoi: [] as { bang: string; ops: [string, unknown[]][] }[],
}));

vi.mock('@/integrations/supabase/client', () => {
  const dung = (bang: string) => {
    const ghi: { bang: string; ops: [string, unknown[]][] } = { bang, ops: [] };
    H.chuoi.push(ghi);
    const p: unknown = new Proxy({} as Record<string, unknown>, {
      get(_t, prop) {
        if (typeof prop !== 'string' || prop === 'then') return undefined;
        return (...args: unknown[]) => { ghi.ops.push([prop, args]); return p; };
      },
    });
    return p;
  };
  return { supabase: { from: (b: string) => dung(b) } };
});

vi.mock('@/lib/supabaseFetchAll', () => ({
  SUPABASE_PAGE: 1000,
  fetchAllRows: async (build: (f: number, t: number) => unknown, opts: { label?: string } = {}) => {
    build(0, 999); // dựng chuỗi thật để soi cột / bộ lọc
    const label = opts.label ?? '';
    return H.bang.has(label) ? H.bang.get(label) : [];
  },
}));

const bocLot = () => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  return ({ children }: { children: ReactNode }) => createElement(QueryClientProvider, { client: qc }, children);
};

beforeEach(() => {
  H.bang.clear();
  H.chuoi.length = 0;
});

describe('useRoomContractExtras — gia hạn hiệu lực', () => {
  it('truy vấn contract_extensions lọc status APPROVED/COMPLETED trên server, không đọc cột status', async () => {
    const { result } = renderHook(() => useRoomContractExtras(['c1']), { wrapper: bocLot() });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    const q = H.chuoi.find((c) => c.bang === 'contract_extensions');
    expect(q?.ops).toContainEqual(['in', ['status', ['APPROVED', 'COMPLETED']]]);
    expect(String(q?.ops.find(([op]) => op === 'select')?.[1][0])).not.toMatch(/\bstatus\b/);
  });

  it('không lọc lại ở client: mọi dòng server trả về đều thành mốc', async () => {
    H.bang.set('room-contract-extras.extensions', [
      { contract_id: 'c1', extension_date: '2026-08-10', old_end_date: '2026-08-30', new_end_date: '2027-02-28' },
      { contract_id: 'c1', extension_date: '2026-08-10', old_end_date: '2027-02-28', new_end_date: '2027-08-31' },
    ]);
    const { result } = renderHook(() => useRoomContractExtras(['c1']), { wrapper: bocLot() });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.extensions).toEqual([
      { contractId: 'c1', date: '2026-08-10', oldEndDate: '2026-08-30', newEndDate: '2027-02-28' },
      { contractId: 'c1', date: '2026-08-10', oldEndDate: '2027-02-28', newEndDate: '2027-08-31' },
    ]);
    expect(result.current.data?.partial).toBe(false);
  });

  it('đọc gia hạn hỏng ⇒ partial, không làm sập các nguồn khác', async () => {
    H.bang.set('room-contract-extras.extensions', null);
    const { result } = renderHook(() => useRoomContractExtras(['c1']), { wrapper: bocLot() });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.extensions).toEqual([]);
    expect(result.current.data?.partial).toBe(true);
  });
});
