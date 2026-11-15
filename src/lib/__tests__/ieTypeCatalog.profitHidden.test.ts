// D2.14: hai hạng mục "Chia lợi nhuận cổ đông" và "Lương điều hành" (Đợt 1 đặt system_only + manual_hidden +
// quick_entry_hidden) không còn hiện khi lập phiếu tay / tạo nhanh / Báo chi nhanh; bộ lọc nhóm ở Thu chi
// tìm được phiếu mới của sổ tổng (cả danh sách lẫn thống kê).
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ inCalls: [] as [string, unknown][], rpc: vi.fn() }));
vi.mock('@/integrations/supabase/client', () => ({
  supabase: {
    rpc: h.rpc,
    from: () => {
      const b: Record<string, unknown> = {};
      for (const method of ['select', 'eq', 'is', 'order', 'lte', 'neq', 'range', 'gt', 'gte', 'not', 'or', 'limit', 'ilike']) b[method] = () => b;
      b.in = (column: string, values: unknown) => { h.inCalls.push([column, values]); return b; };
      b.then = (done: (value: unknown) => unknown) => Promise.resolve({ data: [], error: null, count: 0 }).then(done);
      return b;
    },
  },
}));

import { isPickableIeType, pickableIeTypes, type IeTypeCatalogFields } from '../ieTypeCatalog';
import { usableExpenseCategories, type CategoryRef } from '../quickEntry/categorySuggest';
import { incomeExpenseStatsQuery, incomeExpensesListQuery } from '@/hooks/income-expenses/queries';

const ORG = 'org-a';
const hiddenTypes: (IeTypeCatalogFields & CategoryRef)[] = [
  { id: 't-chia', name: 'Chia lợi nhuận cổ đông', category: 'Chia lợi nhuận', type: 'expense', organization_id: ORG, rule_key: 'chia_loi_nhuan', system_only: true, manual_hidden: true, quick_entry_hidden: true, is_restricted: true },
  { id: 't-luong', name: 'Lương điều hành', category: 'Chia lợi nhuận', type: 'expense', organization_id: ORG, rule_key: 'luong_dieu_hanh', system_only: true, manual_hidden: true, quick_entry_hidden: true },
];
const normal: IeTypeCatalogFields & CategoryRef = { id: 't-dien', name: 'Tiền điện', category: 'Vận hành', type: 'expense', organization_id: ORG };

beforeEach(() => { h.inCalls = []; h.rpc.mockReset(); });

describe('hai hạng mục chia lợi nhuận đã ẩn', () => {
  it('không chọn được khi lập phiếu tay (kể cả người được chọn hạng mục hạn chế)', () => {
    for (const t of hiddenTypes) expect(isPickableIeType(t), t.name).toBe(false);
    expect(pickableIeTypes([...hiddenTypes, normal], { canPickRestricted: true }).map((t) => t.id)).toEqual(['t-dien']);
  });
  it('phiếu cũ đang gắn hạng mục vẫn giữ được khi sửa (keepIds)', () => {
    expect(pickableIeTypes([...hiddenTypes, normal], { canPickRestricted: true, keepIds: ['t-chia'] }).map((t) => t.id)).toEqual(['t-chia', 't-dien']);
  });
  it('không hiện ở Báo chi nhanh', () => {
    expect(usableExpenseCategories([...hiddenTypes, normal], { organizationId: ORG, canUseRestricted: true }).map((c) => c.id)).toEqual(['t-dien']);
  });
});

describe('bộ lọc nhóm nguồn ở Thu chi nhận phiếu sổ tổng', () => {
  it('danh sách: nhóm "Chia lợi nhuận" lọc cả phiếu cũ lẫn phiếu sổ tổng; nhóm "Lương" có lương điều hành mới', async () => {
    await incomeExpensesListQuery({ source_group: 'Chia lợi nhuận' }, { page: 1, pageSize: 20 }).queryFn().catch(() => undefined);
    await incomeExpensesListQuery({ source_group: 'Lương' }, { page: 1, pageSize: 20 }).queryFn().catch(() => undefined);
    const sources = h.inCalls.filter(([column]) => column === 'system_source').map(([, values]) => values as string[]);
    expect(sources[0]).toEqual(expect.arrayContaining(['profit.distribution', 'profit.ledger_payout']));
    expect(sources[1]).toEqual(expect.arrayContaining(['salary.manager', 'profit.manager_salary']));
  });
  it('thống kê: p_sources của nhóm có nguồn mới', async () => {
    h.rpc.mockResolvedValue({ data: null, error: { code: '42501', message: 'x' } });
    await incomeExpenseStatsQuery({ source_group: 'Chia lợi nhuận' }, false).queryFn().catch(() => undefined);
    const args = h.rpc.mock.calls.find((c) => c[0] === 'get_income_expense_layer_stats')?.[1] as { p_sources?: string[] } | undefined;
    expect(args?.p_sources).toEqual(expect.arrayContaining(['profit.distribution', 'profit.ledger_payout']));
  });
});
