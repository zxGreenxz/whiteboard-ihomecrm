// @vitest-environment jsdom
import { createElement, type ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useContractMovements, type MovementArgs } from '@/hooks/useContractMovements';

// Giả lập ranh giới PostgREST; fetchAllRows thật phải đi qua đủ các trang,
// kể cả khi server giới hạn mỗi response thấp hơn pageSize client yêu cầu.
const H = vi.hoisted(() => ({
  rows: new Map<string, unknown[]>(),
  calls: [] as { table: string; ops: [string, unknown[]][] }[],
  failTable: '',
  serverPage: 200,
}));

vi.mock('@/integrations/supabase/client', () => ({
  supabase: {
    from: (table: string) => {
      const call = { table, ops: [] as [string, unknown[]][] };
      H.calls.push(call);
      const builder: unknown = new Proxy({}, {
        get: (_target, key) => {
          if (key === 'then') return (resolve: (value: unknown) => unknown) => {
            const range = call.ops.find(([op]) => op === 'range')?.[1] as number[] | undefined;
            const limit = call.ops.find(([op]) => op === 'limit')?.[1][0] as number | undefined;
            const from = range?.[0] ?? 0;
            const count = Math.min(range ? range[1] - from + 1 : limit ?? 1000, H.serverPage);
            return Promise.resolve({
              data: H.failTable === table && from > 0 ? null : (H.rows.get(table) ?? []).slice(from, from + count),
              error: H.failTable === table && from > 0 ? { message: 'later page denied' } : null,
            }).then(resolve);
          };
          if (typeof key !== 'string') return undefined;
          return (...args: unknown[]) => { call.ops.push([key, args]); return builder; };
        },
      });
      return builder;
    },
  },
}));

const ARGS: MovementArgs = { organizationId: 'org', buildingIds: ['building'], period: '2026-09' };
const contract = (id: string) => ({
  id, contract_number: id, user_id: null, signed_date: '2026-09-01', start_date: '2026-09-01',
  end_date: '2027-09-01', rent_price: 100, total_deposit: 100, contract_customers: [],
  rooms: { id: 'room', name: '101', building_id: 'building', buildings: { name: 'A' } },
});
const termination = (status: string) => ({
  id: status, status, termination_date: '2026-09-20', termination_type: 'NORMAL',
  refund_amount: 80, total_deductions: 20, outstanding_debt: 20, actual_move_out_date: '2026-09-20',
  contracts: contract('contract'),
});
const wrapper = () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  return ({ children }: { children: ReactNode }) => createElement(QueryClientProvider, { client }, children);
};
const run = async (args = ARGS) => {
  const hook = renderHook(() => useContractMovements(args), { wrapper: wrapper() });
  await waitFor(() => expect(hook.result.current.isLoading).toBe(false));
  return hook;
};

beforeEach(() => { H.rows.clear(); H.calls.length = 0; H.failTable = ''; H.serverPage = 200; });

describe('useContractMovements — dữ liệu đủ và hiệu lực', () => {
  it('enabled false không đọc gì; mặc định vẫn tải khi đủ org/toà', async () => {
    const disabled = await run({ ...ARGS, enabled: false });
    expect(H.calls).toHaveLength(0);
    expect(disabled.result.current.isLoading).toBe(false);
    await run();
    expect(H.calls.length).toBeGreaterThan(0);
  });

  it('đọc đủ hơn 400 biến động mỗi loại và hơn 200 giữ chỗ, mọi trang giữ bộ lọc/thứ tự', async () => {
    H.rows.set('contracts', Array.from({ length: 405 }, (_, i) => contract(`c-${i}`)));
    H.rows.set('contract_extensions', Array.from({ length: 405 }, (_, i) => ({
      id: `e-${i}`, extension_date: '2026-09-02', contracts: contract(`c-${i}`),
    })));
    H.rows.set('contract_terminations', Array.from({ length: 405 }, (_, i) => ({ ...termination('COMPLETED'), id: `t-${i}` })));
    H.rows.set('room_reservation_holds', Array.from({ length: 205 }, (_, i) => ({
      id: `h-${i}`, held_at: '2026-09-03', amount: 10, building_id: 'building', room_id: 'room',
    })));
    const { result } = await run();
    expect(result.current.isError).toBe(false);
    expect(result.current.rows).toHaveLength(1420);
    expect(new Set(result.current.rows.map((r) => r.key)).size).toBe(1420);
    for (const call of H.calls) {
      expect(call.ops).toContainEqual(['eq', ['organization_id', 'org']]);
      const buildingColumn = call.table === 'contracts' ? 'rooms.building_id'
        : call.table === 'room_reservation_holds' ? 'building_id' : 'contracts.rooms.building_id';
      expect(call.ops).toContainEqual(['in', [buildingColumn, ['building']]]);
      expect(call.ops.filter(([op]) => op === 'order').map(([, args]) => args[0])).toHaveLength(2);
      expect(call.ops.filter(([op]) => op === 'order').at(-1)?.[1][0]).toBe('id');
      expect(call.ops.find(([op]) => op === 'gte')?.[1][1]).toBe('2026-09-01');
      expect(call.ops.find(([op]) => op === 'lt')?.[1][1]).toBe('2026-10-01');
      expect(call.ops.at(-1)?.[0]).toBe('range');
    }
  });

  it.each(['contracts', 'contract_extensions', 'contract_terminations', 'room_reservation_holds'])(
    'lỗi trang sau của %s không biến thành danh sách thiếu', async (table) => {
      H.rows.set(table, Array.from({ length: 205 }, (_, id) => ({ id: String(id) })));
      H.failTable = table;
      const log = vi.spyOn(console, 'error').mockImplementation(() => {});
      try {
        const { result } = await run();
        expect(result.current.isError).toBe(true);
        expect(result.current.rows).toEqual([]);
      } finally { log.mockRestore(); }
    },
  );

  it('chỉ APPROVED/COMPLETED là biến động đã thanh lý; debt là đầu vào quyết toán', async () => {
    H.rows.set('contract_terminations', ['DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'COMPLETED'].map(termination));
    const { result } = await run();
    expect(result.current.rows.map((r) => r.key).sort()).toEqual(['terminate:APPROVED', 'terminate:COMPLETED']);
    expect(result.current.rows.every((r) => r.description.includes('Công nợ đưa vào quyết toán 20 đ'))).toBe(true);
    expect(result.current.rows.every((r) => !r.description.includes('còn nợ'))).toBe(true);
    const select = H.calls.find((c) => c.table === 'contract_terminations')?.ops.find(([op]) => op === 'select')?.[1][0];
    expect(select).toMatch(/\bstatus\b/);
  });
});
