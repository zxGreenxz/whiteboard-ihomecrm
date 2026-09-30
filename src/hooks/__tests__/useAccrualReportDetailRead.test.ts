import { beforeEach, describe, expect, it, vi } from 'vitest';
// useQuery is replaced by an options collector below; invoke the query factory.
import { useAccrualMonthReport as accrualQueryOptions } from '../useAccrualReport';

const mocks = vi.hoisted(() => ({
  load: vi.fn(),
  rows: { nonInvoice: [] as Record<string, unknown>[], invoice: [] as Record<string, unknown>[], noItem: [] as Record<string, unknown>[] },
  cap: 1000,
  transportError: false,
}));
vi.mock('@tanstack/react-query', () => ({ useQuery: (options: unknown) => options }));
vi.mock('@/hooks/income-expenses/detailRead', () => ({ loadIncomeExpenseDetails: mocks.load }));
vi.mock('@/integrations/supabase/client', () => ({ supabase: {
  from: () => {
    let selected = '';
    const builder = {
      select: (value: string) => { selected = value; return builder; },
      is: () => builder, or: () => builder, in: () => builder, eq: () => builder,
      not: () => builder, gte: () => builder, lte: () => builder, order: () => builder,
      range: async (from: number, to: number) => {
        if (mocks.transportError) return { data: null, error: new Error('Network unavailable') };
        const source = selected.includes('items:income_expense_items!inner') ? mocks.rows.nonInvoice
          : selected.includes('invoice:invoices') ? mocks.rows.invoice : mocks.rows.noItem;
        return { data: source.slice(from, Math.min(to + 1, from + mocks.cap)), error: null };
      },
    };
    return builder;
  },
} }));

const base = (id = 'v1') => ({ id, organization_id: 'org1', name: 'Chi phí', type: 'EXPENSE',
  voucher_date: '2026-09-22', approval_status: 'APPROVED', building_id: 'b1', building: null,
  room_id: null, invoice_id: null, total_amount: 900, business_result_accounting: null, items: [] });
const full = (id = 'v1') => ({ ...base(id), building_name: '950NK',
  detail_read: { complete: true, expected_item_count: 1 },
  items: [{ id: `${id}-item`, income_expense_type_id: 't1', type_name: 'Thu chi khác', category: 'Khác',
    is_deposit: false, accounting_class: 'PNL', amount: 900, quantity: 1, unit_price: 900,
    start_date: '2026-09-01', end_date: '2026-09-30' }] });

const run = () => (accrualQueryOptions('2026-09', {}) as unknown as {
  queryFn: () => Promise<{ totalExpense: number; rows: { typeName: string; buildingName: string | null }[] }>;
}).queryFn();

beforeEach(() => {
  mocks.rows = { nonInvoice: [], invoice: [], noItem: [] };
  mocks.cap = 1000;
  mocks.transportError = false;
  mocks.load.mockReset().mockImplementation(async (_org: string, ids: string[]) => ids.map(id => full(id)));
});

describe('báo cáo dùng chi tiết phiếu đầy đủ', () => {
  it('lỗi tải danh sách phải báo chưa đủ dữ liệu', async () => {
    mocks.transportError = true;
    await expect(run()).rejects.toThrow('Network unavailable');
    expect(mocks.load).not.toHaveBeenCalled();
  });
  it('hiển thị đúng hạng mục và tên tòa khi quan hệ nhúng bị thiếu nhãn', async () => {
    mocks.rows.nonInvoice = [{ ...base(), items: [{ id: 'v1-item', amount: 900, start_date: null, end_date: null }] }];
    mocks.rows.noItem = [base()];
    const result = await run();
    expect(result.totalExpense).toBe(900);
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]).toMatchObject({ typeName: 'Thu chi khác', buildingName: '950NK' });
    expect(mocks.load).toHaveBeenCalledWith('org1', ['v1']);
  });

  it('không biến lỗi đọc hạng mục thành phiếu không có hạng mục', async () => {
    mocks.rows.noItem = [base()];
    mocks.load.mockRejectedValue(new Error('Không tải đủ chi tiết phiếu'));
    await expect(run()).rejects.toThrow('Không tải đủ chi tiết phiếu');
  });

  it('giữ total_amount của phiếu thực sự không có hạng mục', async () => {
    mocks.rows.noItem = [base()];
    mocks.load.mockResolvedValue([{ ...base(), building_name: '950NK',
      detail_read: { complete: true, expected_item_count: 0 } }]);
    const result = await run();
    expect(result.totalExpense).toBe(900);
    expect(result.rows[0]).toMatchObject({ typeName: 'Không có hạng mục', buildingName: '950NK' });
  });

  it('không bỏ sót trang khi server trả ít hơn kích thước yêu cầu', async () => {
    mocks.cap = 1;
    mocks.rows.nonInvoice = [base('v1'), base('v2')];
    expect((await run()).totalExpense).toBe(1800);
  });

  it.each([
    { approval_status: 'CANCELLED' }, { building_id: 'b2' }, { room_id: 'r2' }, { invoice_id: 'invoice-new' },
  ])('không dùng phiếu đã đổi phạm vi trong lúc đọc: %j', async (change) => {
    mocks.rows.nonInvoice = [base()];
    mocks.load.mockResolvedValue([{ ...full(), ...change }]);
    await expect(run()).rejects.toThrow('Phiếu đã thay đổi trong lúc tải báo cáo');
  });
});
