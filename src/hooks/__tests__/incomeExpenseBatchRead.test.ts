import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ header: vi.fn(), links: vi.fn(), details: vi.fn(), eq: vi.fn(), live: vi.fn() }));
vi.mock('@/integrations/supabase/client', () => ({ supabase: { from: () => {
  const query = { select: () => query, eq: (...args: unknown[]) => { state.eq(...args); return query; },
    is: (...args: unknown[]) => { state.live(...args); return query; }, maybeSingle: state.header };
  return query;
} } }));
vi.mock('@/lib/supabaseFetchAll', () => ({ fetchAllRows: state.links }));
vi.mock('@/hooks/income-expenses/detailRead', () => ({
  loadIncomeExpenseDetails: state.details, loadIncomeExpenseDetail: vi.fn(),
  hydrateIncomeExpenseDetailRelations: async (rows: unknown[]) => rows,
  withDetailReadDeadline: (promise: Promise<unknown>) => promise,
}));
vi.mock('@/hooks/income-expenses/reservationCreators', () => ({ hydrateReservationCreators: async (rows: unknown[]) => rows }));
vi.mock('@/hooks/income-expenses/supplements', () => ({ hydrateIncomeExpenseSupplements: async (rows: unknown[]) => rows }));

import { loadIncomeExpenseBatch, readIncomeExpenseBatchMembership } from '../useVoucherDetail';

const org = 'test-organization';
const header = { id: 'batch', organization_id: org, type: 'EXPENSE', name: 'Chi tổng', attachments: ['saved.jpg'] };
const child = (id: string) => ({ id, code: id, total_amount: 100, approval_status: 'UNAPPROVED', building_name: 'Tòa thử' });
beforeEach(() => {
  vi.resetAllMocks();
  state.header.mockResolvedValue({ data: header, error: null });
  state.links.mockResolvedValue([{ income_expense_id: 'PC2' }, { income_expense_id: 'PC1' }]);
  state.details.mockResolvedValue([child('PC2'), child('PC1')]);
});

describe('đọc toàn bộ phiếu tổng trước khi chi nhanh', () => {
  it('đọc đủ IDs của đợt theo tổ chức, giữ metadata đầy đủ và sắp xếp phiếu để hiển thị', async () => {
    const result = await loadIncomeExpenseBatch('batch', org);
    expect(state.eq).toHaveBeenCalledWith('id', 'batch');
    expect(state.eq).toHaveBeenCalledWith('organization_id', org);
    expect(state.live).toHaveBeenCalledWith('deleted_at', null);
    expect(state.details).toHaveBeenCalledWith(org, ['PC2', 'PC1']);
    expect(result).toMatchObject({ id: 'batch', organization_id: org, voucher_ids: ['PC2', 'PC1'], voucher_count: 2, total_amount: 200 });
    expect(result?.vouchers.map(row => row.id)).toEqual(['PC1', 'PC2']);
  });
  it('đọc lại membership không tải lại nội dung con đã chi', async () => {
    expect(await readIncomeExpenseBatchMembership('batch', org)).toEqual({ id: 'batch', organization_id: org, type: 'EXPENSE', voucher_ids: ['PC2', 'PC1'] });
    expect(state.details).not.toHaveBeenCalled();
  });
  it('đợt không còn thấy trả null và không đọc phiếu con', async () => {
    state.header.mockResolvedValue({ data: null, error: null });
    expect(await loadIncomeExpenseBatch('batch', org)).toBeNull();
    expect(state.links).not.toHaveBeenCalled();
  });
  it('lỗi đọc không được coi là đợt rỗng', async () => {
    const denied = new Error('permission denied');
    state.header.mockResolvedValue({ data: null, error: denied });
    await expect(loadIncomeExpenseBatch('batch', org)).rejects.toBe(denied);
  });
  it.each([{ organization_id: 'other-org' }, { type: 'UNKNOWN' }])('từ chối header không hợp lệ %j', patch => {
    state.header.mockResolvedValue({ data: { ...header, ...patch }, error: null });
    return expect(loadIncomeExpenseBatch('batch', org)).rejects.toThrow('không hợp lệ');
  });
  it('membership trùng không được làm mất phiếu khi gộp', async () => {
    state.links.mockResolvedValue([{ income_expense_id: 'PC1' }, { income_expense_id: 'PC1' }]);
    await expect(loadIncomeExpenseBatch('batch', org)).rejects.toThrow('bị trùng');
    expect(state.details).not.toHaveBeenCalled();
  });
  it('thiếu một chi tiết con phải báo lỗi thay vì trả đợt một phần', async () => {
    state.details.mockResolvedValue([child('PC1')]);
    await expect(loadIncomeExpenseBatch('batch', org)).rejects.toThrow('Chưa tải đủ');
  });
});
