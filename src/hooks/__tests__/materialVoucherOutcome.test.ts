// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const io = vi.hoisted(() => ({ from: vi.fn() }));
vi.mock('@tanstack/react-query', () => ({ useQuery: (config: unknown) => config, useMutation: (config: unknown) => config, useQueryClient: () => ({ invalidateQueries: vi.fn() }) }));
vi.mock('@/integrations/supabase/client', () => ({ supabase: io }));
vi.mock('@/lib/authSession', () => ({ getSessionUser: async () => ({ id: 'actor' }) }));
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn(), info: vi.fn() } }));
import { useCreateMaterialPurchase, useUpdateMaterialPurchase, useMaterialPurchases } from '../useMaterialPurchases';
import { useCreateMaterialAdjustment, useSetMaterialStock, useMaterialAdjustments } from '../useMaterialAdjustments';
import { toast } from 'sonner';
import { useCreateMaterialUsage, useUpsertJobMaterialUsage } from '../useMaterialUsages';
interface Mutation { mutationFn: (x: unknown) => Promise<unknown>; onSuccess: (x: unknown) => void; onError: (x: unknown) => void }
const purchase = { purchase_date: '2026-09-30', supplier_id: null, notes: null, items: [{ material_id: 'm-1', quantity: 2, unit_price: 100 }] };
beforeEach(() => { localStorage.clear(); localStorage.setItem('ihomecrm.selectedOrganizationId', 'org-a'); vi.clearAllMocks(); });
afterEach(() => io.from.mockReset());

it.each([['phiếu nhập', useCreateMaterialPurchase, 'material_purchases', 'material_purchase_items'], ['phiếu kiểm kê', useCreateMaterialAdjustment, 'material_adjustments', 'material_adjustment_items']])('tạo %s dòng lỗi và cleanup bị từ chối giữ ID, chặn tạo lại sau remount', async (_label, hook, headerTable, itemTable) => {
  const header = { insert: vi.fn(), select: vi.fn(), single: vi.fn().mockResolvedValueOnce({ data: { id: 'voucher-1' }, error: null }).mockResolvedValue({ data: null, error: { code: '42501', message: 'cleanup raw SQL' } }), delete: vi.fn(), eq: vi.fn() };
  header.insert.mockReturnValue(header); header.select.mockReturnValue(header); header.delete.mockReturnValue(header); header.eq.mockReturnValue(header);
  const lines = { insert: vi.fn(), select: vi.fn().mockResolvedValue({ data: null, error: { code: '42501', message: 'raw SQL' } }), then: (resolve: (x: unknown) => void) => resolve({ data: null, error: { code: '42501', message: 'raw SQL' } }) };
  lines.insert.mockReturnValue(lines);
  io.from.mockImplementation((table: string) => table === headerTable ? header : table === itemTable ? lines : null);
  const input = headerTable === 'material_purchases' ? purchase : { adjustment_date: '2026-09-30', type: 'IN', reason: null, items: [{ material_id: 'm-1', quantity: 2 }] };
  const mutation = hook() as unknown as Mutation;
  const error = await mutation.mutationFn(input).catch(error => error);
  expect(error).toMatchObject({ outcome: 'partial', completed: [{ id: 'voucher-1' }] });
  expect(header.delete).toHaveBeenCalledTimes(1);
  mutation.onError(error);
  expect(JSON.stringify(vi.mocked(toast.error).mock.calls)).not.toContain('raw SQL');
  await expect((hook() as unknown as Mutation).mutationFn(input)).rejects.toMatchObject({ outcome: 'partial', completed: [{ id: 'voucher-1' }] });
  expect(header.insert).toHaveBeenCalledTimes(1);
});

it.each([['phiếu nhập', useMaterialPurchases], ['phiếu kiểm kê', useMaterialAdjustments]])('%s query null không giả danh sách rỗng', async (_label, hook) => {
  const chain = { select: vi.fn(), order: vi.fn(), then: (resolve: (x: unknown) => void) => resolve({ data: null, error: null }) };
  chain.select.mockReturnValue(chain); chain.order.mockReturnValue(chain); io.from.mockReturnValue(chain);
  await expect((hook() as unknown as { queryFn: () => Promise<unknown> }).queryFn()).rejects.toThrow('Chưa xác nhận');
});

it('SET tồn không báo đã cập nhật khi không phát sinh điều chỉnh', async () => {
  const hook = useSetMaterialStock() as unknown as Mutation;
  const result = await hook.mutationFn({ material_id: 'm-1', target_quantity: 2, current_quantity: 2 });
  hook.onSuccess(result);
  expect(toast.success).not.toHaveBeenCalled();
});

it('sửa phiếu nhập giữ ID header và dòng cũ đã xóa khi INSERT mới bị từ chối, không replay', async () => {
  const header = { update: vi.fn(), eq: vi.fn(), select: vi.fn(), single: vi.fn().mockResolvedValue({ data: { id: 'voucher-1' }, error: null }) };
  header.update.mockReturnValue(header); header.eq.mockReturnValue(header); header.select.mockReturnValue(header);
  const lines = { select: vi.fn(), eq: vi.fn(), insert: vi.fn(), delete: vi.fn() };
  lines.select.mockResolvedValue({ data: [{ id: 'old-1' }], error: null }); lines.eq.mockReturnValue(lines); lines.delete.mockReturnValue(lines);
  lines.insert.mockReturnValue({ select: () => Promise.resolve({ data: null, error: { code: '42501', message: 'raw SQL' } }) });
  io.from.mockImplementation((table: string) => table === 'material_purchases' ? header : lines);
  const input = { id: 'voucher-1', input: purchase };
  const error = await (useUpdateMaterialPurchase() as unknown as Mutation).mutationFn(input).catch(error => error);
  expect(error).toMatchObject({ outcome: 'partial', completed: [{ id: 'voucher-1' }, { id: 'old-1' }] });
  expect(lines.delete).toHaveBeenCalledTimes(1);
  expect(lines.delete.mock.invocationCallOrder[0]).toBeLessThan(lines.insert.mock.invocationCallOrder[0]);
  await expect((useUpdateMaterialPurchase() as unknown as Mutation).mutationFn(input)).rejects.toMatchObject({ outcome: 'partial', completed: [{ id: 'voucher-1' }, { id: 'old-1' }] });
  expect(header.update).toHaveBeenCalledTimes(1); expect(lines.insert).toHaveBeenCalledTimes(1);
});

it('header không trả ID là bất định và chặn gửi lại sau remount', async () => {
  const header = { insert: vi.fn(), select: vi.fn(), single: vi.fn().mockResolvedValue({ data: null, error: null }) };
  header.insert.mockReturnValue(header); header.select.mockReturnValue(header); io.from.mockReturnValue(header);
  await expect((useCreateMaterialPurchase() as unknown as Mutation).mutationFn(purchase)).rejects.toMatchObject({ outcome: 'unknown' });
  await expect((useCreateMaterialPurchase() as unknown as Mutation).mutationFn(purchase)).rejects.toMatchObject({ outcome: 'unknown' });
  expect(header.insert).toHaveBeenCalledTimes(1);
});


it('phiếu xuất manual partial giữ ID và chặn tạo lại sau remount', async () => {
  const header = { insert: vi.fn(), select: vi.fn(), single: vi.fn().mockResolvedValueOnce({ data: { id: 'usage-1' }, error: null }).mockResolvedValue({ data: null, error: { code: '42501', message: 'cleanup raw SQL' } }), delete: vi.fn(), eq: vi.fn() };
  header.insert.mockReturnValue(header); header.select.mockReturnValue(header); header.delete.mockReturnValue(header); header.eq.mockReturnValue(header);
  const lines = { insert: vi.fn(), select: vi.fn().mockResolvedValue({ data: null, error: { code: '42501', message: 'raw SQL' } }), then: (resolve: (x: unknown) => void) => resolve({ data: null, error: { code: '42501', message: 'raw SQL' } }) };
  lines.insert.mockReturnValue(lines); io.from.mockImplementation((table: string) => table === 'material_usages' ? header : lines);
  const input = { usage_date: '2026-09-30', notes: null, items: [{ material_id: 'm-1', quantity: 2, unit_cost_at_usage: 100 }] };
  await expect((useCreateMaterialUsage() as unknown as Mutation).mutationFn(input)).rejects.toMatchObject({ outcome: 'partial', completed: [{ id: 'usage-1' }] });
  await expect((useCreateMaterialUsage() as unknown as Mutation).mutationFn(input)).rejects.toMatchObject({ outcome: 'partial', completed: [{ id: 'usage-1' }] });
  expect(header.delete).toHaveBeenCalledTimes(1);
  expect(header.insert).toHaveBeenCalledTimes(1);
});

it('vật tư công việc giữ ID header và dòng đã xóa khi INSERT mới bị từ chối, không replay', async () => {
  const header = { select: vi.fn(), eq: vi.fn(), maybeSingle: vi.fn().mockResolvedValue({ data: { id: 'usage-1' }, error: null }), update: vi.fn(), single: vi.fn().mockResolvedValue({ data: { id: 'usage-1' }, error: null }) };
  header.select.mockReturnValue(header); header.eq.mockReturnValue(header); header.update.mockReturnValue(header);
  const lines = { select: vi.fn(), eq: vi.fn(), insert: vi.fn(), delete: vi.fn() };
  lines.select.mockResolvedValue({ data: [{ id: 'old-1' }], error: null }); lines.eq.mockReturnValue(lines); lines.delete.mockReturnValue(lines);
  lines.insert.mockReturnValue({ select: () => Promise.resolve({ data: null, error: { code: '42501', message: 'raw SQL' } }) });
  io.from.mockImplementation((table: string) => table === 'material_usages' ? header : lines);
  const input = { job_id: 'job-1', usage_date: '2026-09-30', notes: null, items: [{ material_id: 'm-1', quantity: 2, unit_cost_at_usage: 100 }] };
  const error = await (useUpsertJobMaterialUsage() as unknown as Mutation).mutationFn(input).catch(error => error);
  expect(error).toMatchObject({ outcome: 'partial', completed: [{ id: 'usage-1' }, { id: 'old-1' }] });
  expect(lines.delete).toHaveBeenCalledTimes(1);
  expect(lines.delete.mock.invocationCallOrder[0]).toBeLessThan(lines.insert.mock.invocationCallOrder[0]);
  await expect((useUpsertJobMaterialUsage() as unknown as Mutation).mutationFn(input)).rejects.toMatchObject({ outcome: 'partial', completed: [{ id: 'usage-1' }, { id: 'old-1' }] });
  expect(header.update).toHaveBeenCalledTimes(1); expect(lines.insert).toHaveBeenCalledTimes(1);
});

it('SET đã có phiếu partial không được coi tồn khớp là biên nhận hoàn tất', async () => {
  const header = { insert: vi.fn(), select: vi.fn(), single: vi.fn().mockResolvedValueOnce({ data: { id: 'adjustment-1' }, error: null }).mockResolvedValue({ data: null, error: { code: '42501', message: 'cleanup raw SQL' } }), delete: vi.fn(), eq: vi.fn() };
  header.insert.mockReturnValue(header); header.select.mockReturnValue(header); header.delete.mockReturnValue(header); header.eq.mockReturnValue(header);
  const lines = { insert: vi.fn(), select: vi.fn().mockResolvedValue({ data: null, error: { code: '42501', message: 'raw SQL' } }) };
  lines.insert.mockReturnValue(lines); io.from.mockImplementation((table: string) => table === 'material_adjustments' ? header : lines);
  await expect((useSetMaterialStock() as unknown as Mutation).mutationFn({ material_id: 'm-1', target_quantity: 3, current_quantity: 1 })).rejects.toMatchObject({ outcome: 'partial' });
  await expect((useSetMaterialStock() as unknown as Mutation).mutationFn({ material_id: 'm-1', target_quantity: 3, current_quantity: 3 })).rejects.toMatchObject({ outcome: 'partial', completed: [{ id: 'adjustment-1' }] });
});

it('tạo phiếu nhập xác nhận ID dòng mặc định từ server, rồi mở khóa lượt tạo tiếp', async () => {
  const lineId = '22222222-2222-4222-8222-222222222222';
  const header = { insert: vi.fn(), select: vi.fn(), single: vi.fn().mockResolvedValue({ data: { id: 'purchase-1' }, error: null }) };
  header.insert.mockReturnValue(header); header.select.mockReturnValue(header);
  const lines = { insert: vi.fn(), select: vi.fn().mockResolvedValue({ data: [{ id: lineId }], error: null }) };
  lines.insert.mockReturnValue(lines); io.from.mockImplementation((table: string) => table === 'material_purchases' ? header : lines);
  await expect((useCreateMaterialPurchase() as unknown as Mutation).mutationFn(purchase)).resolves.toMatchObject({ id: 'purchase-1' });
  expect(lines.insert).toHaveBeenCalledWith([{ purchase_id: 'purchase-1', material_id: 'm-1', quantity: 2, unit_price: 100 }]);
  await expect((useCreateMaterialPurchase() as unknown as Mutation).mutationFn(purchase)).resolves.toMatchObject({ id: 'purchase-1' });
  expect(header.insert).toHaveBeenCalledTimes(2);
});

it('response thiếu ID dòng giữ header và chặn retry, không báo hoàn tất', async () => {
  const header = { insert: vi.fn(), select: vi.fn(), single: vi.fn().mockResolvedValue({ data: { id: 'purchase-1' }, error: null }) };
  header.insert.mockReturnValue(header); header.select.mockReturnValue(header);
  const lines = { insert: vi.fn(), select: vi.fn().mockResolvedValue({ data: [], error: null }) };
  lines.insert.mockReturnValue(lines); io.from.mockImplementation((table: string) => table === 'material_purchases' ? header : lines);
  await expect((useCreateMaterialPurchase() as unknown as Mutation).mutationFn(purchase)).rejects.toMatchObject({ outcome: 'partial', completed: [{ id: 'purchase-1' }] });
  await expect((useCreateMaterialPurchase() as unknown as Mutation).mutationFn(purchase)).rejects.toMatchObject({ outcome: 'partial' });
  expect(header.insert).toHaveBeenCalledTimes(1);
});

it('biên nhận DELETE dòng phiếu nhập malformed giữ header và chặn INSERT mới/replay', async () => {
  const header = { update: vi.fn(), eq: vi.fn(), select: vi.fn(), single: vi.fn().mockResolvedValue({ data: { id: 'purchase-1' }, error: null }) };
  header.update.mockReturnValue(header); header.eq.mockReturnValue(header); header.select.mockReturnValue(header);
  const lines = { delete: vi.fn(), eq: vi.fn(), select: vi.fn().mockResolvedValue({ data: [{ id: null }], error: null }), insert: vi.fn() };
  lines.delete.mockReturnValue(lines); lines.eq.mockReturnValue(lines);
  io.from.mockImplementation((table: string) => table === 'material_purchases' ? header : lines);
  const input = { id: 'purchase-1', input: purchase };
  await expect((useUpdateMaterialPurchase() as unknown as Mutation).mutationFn(input)).rejects.toMatchObject({ outcome: 'partial', completed: [{ id: 'purchase-1' }] });
  await expect((useUpdateMaterialPurchase() as unknown as Mutation).mutationFn(input)).rejects.toMatchObject({ outcome: 'partial' });
  expect(header.update).toHaveBeenCalledTimes(1); expect(lines.delete).toHaveBeenCalledTimes(1); expect(lines.insert).not.toHaveBeenCalled();
});

it('lỗi đọc phiếu vật tư công việc không trở thành chưa có phiếu để tạo mới', async () => {
  const header = { select: vi.fn(), eq: vi.fn(), maybeSingle: vi.fn().mockResolvedValue({ data: null, error: { code: '42501', message: 'raw SQL' } }), insert: vi.fn(), update: vi.fn() };
  header.select.mockReturnValue(header); header.eq.mockReturnValue(header); io.from.mockReturnValue(header);
  await expect((useUpsertJobMaterialUsage() as unknown as Mutation).mutationFn({ job_id: 'job-1', usage_date: '2026-09-30', notes: null, items: [{ material_id: 'm-1', quantity: 2, unit_cost_at_usage: 100 }] })).rejects.toMatchObject({ code: '42501' });
  expect(header.insert).not.toHaveBeenCalled(); expect(header.update).not.toHaveBeenCalled();
});
