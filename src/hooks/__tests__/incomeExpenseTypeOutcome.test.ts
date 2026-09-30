// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const io = vi.hoisted(() => ({ from: vi.fn(), rpc: vi.fn() }));
vi.mock('@tanstack/react-query', () => ({ useQuery: (config: unknown) => config, useMutation: (config: unknown) => config, useQueryClient: () => ({ invalidateQueries: vi.fn() }) }));
vi.mock('@/integrations/supabase/client', () => ({ supabase: io }));
vi.mock('@/lib/authSession', () => ({ getSessionUser: vi.fn().mockResolvedValue({ id: 'user-1' }) }));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
import { useIncomeExpenseTypes, useIncomeExpenseTypeCategories, useHiddenInReportTypes, useDeleteIncomeExpenseType } from '../useIncomeExpenseTypes';

beforeEach(()=>{localStorage.clear();localStorage.setItem('ihomecrm.selectedOrganizationId','org-1');});
afterEach(() => { io.from.mockReset(); io.rpc.mockReset(); });
type QueryHook = { queryFn: () => Promise<unknown> };

it.each([
  ['hạng mục', useIncomeExpenseTypes],
  ['nhóm hạng mục', useIncomeExpenseTypeCategories],
  ['hạng mục ẩn báo cáo', useHiddenInReportTypes],
])('không biến phản hồi %s null thành danh sách rỗng', async (_label, hook) => {
  io.rpc.mockResolvedValue({ data: ['org-1'], error: null });
  const chain = { select: vi.fn(), order: vi.fn(), not: vi.fn(), eq: vi.fn() };
  chain.select.mockReturnValue(chain); chain.not.mockReturnValue(chain);
  chain.order.mockResolvedValue({ data: null, error: null }); chain.eq.mockResolvedValue({ data: null, error: null });
  io.from.mockReturnValue(chain);
  await expect((hook() as unknown as QueryHook).queryFn()).rejects.toThrow('Chưa xác nhận');
});

it('không báo xóa loại thu chi khi server không xác nhận hàng bị xóa', async () => {
  const usage = { select: vi.fn(), eq: vi.fn(), limit: vi.fn().mockResolvedValue({ data: [], error: null }) };
  usage.select.mockReturnValue(usage); usage.eq.mockReturnValue(usage);
  const deletion = { delete: vi.fn(), eq: vi.fn(), select: vi.fn(), single: vi.fn().mockResolvedValue({ data: null, error: null }) };
  deletion.delete.mockReturnValue(deletion); deletion.eq.mockReturnValue(deletion); deletion.select.mockReturnValue(deletion);
  io.from.mockImplementation((table: string) => table === 'income_expense_items' ? usage : deletion);
  await expect((useDeleteIncomeExpenseType() as unknown as { mutationFn: (id: string) => Promise<unknown> }).mutationFn('type-1')).rejects.toThrow('Chưa xác nhận');
  expect(deletion.select).toHaveBeenCalledWith('id,name');
});
