// @vitest-environment jsdom
//
// CAP 1000 DÒNG ÂM THẦM — bài kiểm chung cho các hook đọc danh sách org-wide.
//
// PostgREST trả tối đa 1000 dòng cho một request không `.range()`, và KHÔNG báo
// lỗi gì: hook nhận đúng 1000 dòng rồi coi đó là toàn bộ bảng. Dropdown thiếu
// phòng, danh sách thiếu công tơ, báo cáo thiếu khách — tất cả im lặng.
//
// Giả lập ở đây đúng hành vi đó: builder không gọi `.range()` thì chỉ được 1000
// dòng đầu. Vì vậy bài này ĐỎ với mã chưa vá và XANH sau khi hook phân trang.
//
// Xem `src/lib/supabaseFetchAll.ts` cho giao kèo phân trang (order ổn định +
// tiebreaker duy nhất, fail-closed khi lỗi).
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';

/** Trần một response của PostgREST khi caller không tự giới hạn. */
const CAP_POSTGREST = 1000;

type Supply = (from: number, to: number) => { rows: unknown[]; count: number };

const boundary = vi.hoisted(() => ({
  supply: null as null | ((table: string) => Supply),
  calls: [] as Array<{ table: string; from: number; to: number }>,
}));

/**
 * Builder giả: mọi method lọc/sắp xếp trả về chính nó; chỉ `.range()` đổi cửa
 * sổ. `then` nằm ở cuối chuỗi nên `await query` chạy đúng một lần.
 */
class FakeQuery {
  private from = 0;
  private to = CAP_POSTGREST - 1;
  constructor(private readonly table: string, private readonly supply: Supply) {}
  range(from: number, to: number) {
    this.from = from;
    // Server vẫn cắt theo trần của nó, dù caller xin nhiều hơn.
    this.to = Math.min(to, from + CAP_POSTGREST - 1);
    return this;
  }
  then(resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) {
    boundary.calls.push({ table: this.table, from: this.from, to: this.to });
    const { rows, count } = this.supply(this.from, this.to);
    return Promise.resolve({ data: rows, error: null, count }).then(resolve, reject);
  }
}

const CHAIN = ['select', 'is', 'eq', 'in', 'not', 'neq', 'gte', 'lte', 'gt', 'lt', 'or', 'filter', 'order', 'limit'];
for (const m of CHAIN) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (FakeQuery.prototype as any)[m] = function chainable(this: FakeQuery) { return this; };
}

vi.mock('@/integrations/supabase/client', () => ({
  supabase: {
    from: (table: string) => {
      if (!boundary.supply) throw new Error('test chưa nạp dữ liệu giả');
      return new FakeQuery(table, boundary.supply(table));
    },
    rpc: vi.fn(),
    auth: { getUser: vi.fn() },
  },
}));
vi.mock('@/lib/authSession', () => ({
  getSessionUser: vi.fn(async () => ({ id: 'u-1' })),
}));
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

import { useRooms } from '../useRooms';
import { useRoomsWithActiveContracts } from '../useRoomsWithContracts';
import { useMeters } from '../useMeters';
import { useLeads } from '../useLeads';
import { useMaterials } from '../useMaterials';
import { useTenants, useTenantsLegacy } from '../useTenants';

/** 1003 dòng: vượt trần 1000 đúng 3 dòng — đủ để lộ phần bị cắt. */
const TONG = 1003;

function bang(total: number, shape: (i: number) => Record<string, unknown>): Supply {
  const all = Array.from({ length: total }, (_, i) => shape(i));
  return (from: number, to: number) => ({ rows: all.slice(from, to + 1), count: all.length });
}

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

beforeEach(() => {
  boundary.calls = [];
  boundary.supply = null;
});

describe('hook đọc danh sách không được dừng ở 1000 dòng', () => {
  it('useRooms lấy đủ mọi phòng (1003), không cắt ở 1000', async () => {
    const supply = bang(TONG, (i) => ({
      id: `room-${String(i).padStart(5, '0')}`,
      name: `P${String(i).padStart(4, '0')}`,
      building_id: 'b1',
      floor: 1,
      deleted_at: null,
      building: { id: 'b1', name: 'Toà A', code: 'A' },
    }));
    boundary.supply = () => supply;
    const { result } = renderHook(() => useRooms(), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toHaveLength(TONG);
    expect(boundary.calls.length).toBeGreaterThan(1);
  });

  it('useRoomsWithActiveContracts lấy đủ mọi phòng có HĐ', async () => {
    const supply = bang(TONG, (i) => ({
      id: `room-${String(i).padStart(5, '0')}`,
      name: `P${i}`,
      rent_price: 1_000_000,
      floor: 1,
      status: 'OCCUPIED',
      building_id: 'b1',
      contracts: [{ id: `c${i}`, end_date: '2027-01-01', rent_price: 1_000_000, status: 'ACTIVE', contract_customers: [] }],
    }));
    boundary.supply = () => supply;
    const { result } = renderHook(() => useRoomsWithActiveContracts(), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toHaveLength(TONG);
  });

  it('useMeters lấy đủ mọi công tơ', async () => {
    const supply = bang(TONG, (i) => ({ id: `m-${i}`, deleted_at: null, created_at: '2026-01-01' }));
    boundary.supply = () => supply;
    const { result } = renderHook(() => useMeters(), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toHaveLength(TONG);
  });

  it('useLeads lấy đủ mọi khách hẹn', async () => {
    const supply = bang(TONG, (i) => ({ id: `l-${i}`, created_at: '2026-01-01' }));
    boundary.supply = () => supply;
    const { result } = renderHook(() => useLeads(), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toHaveLength(TONG);
  });

  it('useMaterials lấy đủ mọi vật tư', async () => {
    const supply = bang(TONG, (i) => ({
      id: `mat-${i}`, name: `Vật tư ${i}`, code: null, description: null,
      on_hand: 0, reorder_level: 0, deleted_at: null, category: null,
    }));
    boundary.supply = () => supply;
    const { result } = renderHook(() => useMaterials(), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toHaveLength(TONG);
  });

  it('useTenants KHÔNG truyền phân trang ⇒ lấy đủ, và count khớp số dòng thật', async () => {
    const supply = bang(TONG, (i) => ({ id: `t-${i}`, deleted_at: null, created_at: '2026-01-01' }));
    boundary.supply = () => supply;
    const { result } = renderHook(() => useTenants(), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.data).toHaveLength(TONG);
    expect(result.current.data?.count).toBe(TONG);
  });

  it('useTenants CÓ phân trang ⇒ vẫn đúng một request đúng cửa sổ', async () => {
    const supply = bang(TONG, (i) => ({ id: `t-${i}`, deleted_at: null, created_at: '2026-01-01' }));
    boundary.supply = () => supply;
    const { result } = renderHook(() => useTenants(undefined, { page: 2, pageSize: 20 }), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.data).toHaveLength(20);
    expect(result.current.data?.count).toBe(TONG);
    expect(boundary.calls).toEqual([{ table: 'tenants', from: 20, to: 39 }]);
  });

  it('useTenantsLegacy lấy đủ mọi khách thuê', async () => {
    const supply = bang(TONG, (i) => ({ id: `t-${i}`, deleted_at: null, created_at: '2026-01-01' }));
    boundary.supply = () => supply;
    const { result } = renderHook(() => useTenantsLegacy(), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toHaveLength(TONG);
  });
});

describe('gate fetch: hook chỉ chạy khi dialog mở', () => {
  it('useRooms({ enabled: false }) không gửi request nào', async () => {
    const supply = bang(10, (i) => ({ id: `r-${i}`, name: `P${i}`, building: null }));
    boundary.supply = () => supply;
    const { result } = renderHook(() => useRooms(undefined, { enabled: false }), { wrapper });
    await waitFor(() => expect(result.current.fetchStatus).toBe('idle'));
    expect(boundary.calls).toEqual([]);
  });

  it('useTenantsLegacy({ enabled: false }) không gửi request nào', async () => {
    const supply = bang(10, (i) => ({ id: `t-${i}` }));
    boundary.supply = () => supply;
    const { result } = renderHook(() => useTenantsLegacy({ enabled: false }), { wrapper });
    await waitFor(() => expect(result.current.fetchStatus).toBe('idle'));
    expect(boundary.calls).toEqual([]);
  });
});
