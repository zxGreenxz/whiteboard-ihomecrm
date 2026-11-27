// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const io = vi.hoisted(() => ({ from: vi.fn(), rpc: vi.fn() }));
vi.mock('@tanstack/react-query', () => ({ useQuery: (config: unknown) => config, useMutation: (config: unknown) => config, useQueryClient: () => ({ invalidateQueries: vi.fn() }) }));
vi.mock('@/contexts/OrganizationContext', () => ({ useOrganization: () => ({ selectedOrganizationId: 'org-a' }) }));
vi.mock('@/integrations/supabase/client', () => ({ supabase: io }));
vi.mock('@/lib/authSession', () => ({ getSessionUser: async () => ({ id: 'actor' }) }));
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn(), info: vi.fn() } }));
import { useCreateMaterialPurchase, useUpdateMaterialPurchase, useMaterialPurchases } from '../useMaterialPurchases';
import { useCreateMaterialAdjustment, useSetMaterialStock, useMaterialAdjustments } from '../useMaterialAdjustments';
import { toast } from 'sonner';
import { RepeatableWriteUnknownError } from '@/lib/financialWorkflow';
import { forgetUnconfirmedCreates } from '@/lib/clientRecordCreate';
import { useCreateMaterialUsage, useUpsertJobMaterialUsage } from '../useMaterialUsages';
interface Mutation { mutationFn: (x: unknown) => Promise<unknown>; onSuccess: (x: unknown) => void; onError: (x: unknown) => void }
const purchase = { purchase_date: '2026-09-30', supplier_id: null, notes: null, items: [{ material_id: 'm-1', quantity: 2, unit_price: 100 }] };
beforeEach(() => { localStorage.clear(); localStorage.setItem('ihomecrm.selectedOrganizationId', 'org-a'); vi.clearAllMocks(); forgetUnconfirmedCreates(); });
afterEach(() => { io.from.mockReset(); io.rpc.mockReset(); });
/** Đợt 9: đặt tồn đọc tồn hiện tại của vật tư trên máy chủ trước khi tính phần chênh. */
const serverStock = (onHand: number) => { const chain = { select: vi.fn(), eq: vi.fn(), maybeSingle: vi.fn().mockResolvedValue({ data: { id: 'm-1', on_hand: onHand }, error: null }) }; chain.select.mockReturnValue(chain); chain.eq.mockReturnValue(chain); return chain; };
const sentId = (mock: { mock: { calls: unknown[][] } }, call: number) => (mock.mock.calls[call][0] as { id?: unknown }).id;

// Đợt 9 (luật 5): trước đợt 9 test này tên «tạo %s dòng lỗi và cleanup bị từ chối giữ ID, chặn tạo lại sau remount» và
// chốt lần tạo sau bị chặn. Hàng rào giữ: không lộ lỗi gốc, nêu mã phiếu tạm còn lại. Nay không khoá: lần sau dùng lại
// ĐÚNG mã phiếu tạm đó (khoá chính chặn phiếu thứ hai), không tạo phiếu mới.
it.each([['phiếu nhập', useCreateMaterialPurchase, 'material_purchases', 'material_purchase_items'], ['phiếu kiểm kê', useCreateMaterialAdjustment, 'material_adjustments', 'material_adjustment_items']])('tạo %s: dòng bị từ chối và gỡ phiếu tạm cũng bị từ chối ⇒ báo từ chối kèm mã phiếu tạm, không khoá; lần sau dùng lại đúng mã phiếu', async (_label, hook, headerTable, itemTable) => {
  const header = { insert: vi.fn(), select: vi.fn(), single: vi.fn().mockResolvedValueOnce({ data: { id: 'voucher-1', organization_id: 'org-a' }, error: null }).mockResolvedValue({ data: null, error: { code: '42501', message: 'cleanup raw SQL' } }), delete: vi.fn(), eq: vi.fn() };
  header.insert.mockReturnValue(header); header.select.mockReturnValue(header); header.delete.mockReturnValue(header); header.eq.mockReturnValue(header);
  const lines = { insert: vi.fn(), select: vi.fn().mockResolvedValue({ data: null, error: { code: '42501', message: 'raw SQL' } }), then: (resolve: (x: unknown) => void) => resolve({ data: null, error: { code: '42501', message: 'raw SQL' } }) };
  lines.insert.mockReturnValue(lines);
  io.from.mockImplementation((table: string) => table === headerTable ? header : table === itemTable ? lines : null);
  const input = headerTable === 'material_purchases' ? purchase : { adjustment_date: '2026-09-30', type: 'IN', reason: null, items: [{ material_id: 'm-1', quantity: 2 }] };
  const mutation = hook() as unknown as Mutation;
  const error = await mutation.mutationFn(input).catch(error => error);
  expect(error).toMatchObject({ outcome: 'failure' });
  expect(error).not.toBeInstanceOf(RepeatableWriteUnknownError);
  expect(String((error as Error).message)).toContain('voucher-1');
  expect(header.delete).toHaveBeenCalledTimes(1);
  mutation.onError(error);
  expect(JSON.stringify(vi.mocked(toast.error).mock.calls)).not.toContain('raw SQL');
  await (hook() as unknown as Mutation).mutationFn(input).catch(() => undefined);
  expect(header.insert).toHaveBeenCalledTimes(2);
  expect(sentId(header.insert, 1)).toBe('voucher-1');
});

it.each([['phiếu nhập', useMaterialPurchases], ['phiếu kiểm kê', useMaterialAdjustments]])('%s query null không giả danh sách rỗng', async (_label, hook) => {
  const chain = { select: vi.fn(), order: vi.fn(), then: (resolve: (x: unknown) => void) => resolve({ data: null, error: null }) };
  chain.select.mockReturnValue(chain); chain.order.mockReturnValue(chain); io.from.mockReturnValue(chain);
  await expect((hook() as unknown as { queryFn: () => Promise<unknown> }).queryFn()).rejects.toThrow('Chưa xác nhận');
});

// Đợt 9: tồn đọc trên máy chủ (trước đây lấy `current_quantity` của màn).
it('SET tồn không báo đã cập nhật khi tồn trên máy chủ đã khớp (không phát sinh điều chỉnh)', async () => {
  io.from.mockImplementation(() => serverStock(2));
  const hook = useSetMaterialStock() as unknown as Mutation;
  const result = await hook.mutationFn({ material_id: 'm-1', target_quantity: 2 });
  expect(result).toBeNull();
  hook.onSuccess(result);
  expect(toast.success).not.toHaveBeenCalled();
});

// Đợt 8 (luật 5): sửa phiếu nhập ghi lặp lại được. Trước đợt 8 test này tên «sửa phiếu nhập giữ ID header và dòng cũ đã
// xóa khi INSERT mới bị từ chối, không replay» và chốt lần bấm sau bị chặn. Đợt 10b: trước đó test tên «sửa phiếu nhập: INSERT
// mới bị từ chối sau khi đã xoá dòng cũ ⇒ báo rõ đã xoá, không khoá…». Nay cả đầu phiếu + dòng đi MỘT hàm máy chủ nguyên tử:
// từ chối là lùi cả, không còn «đã xoá dòng cũ»; không khoá, bấm lại gửi lại cả bộ.
it('sửa phiếu nhập: máy chủ từ chối hàm nguyên tử ⇒ báo từ chối (không lộ lỗi gốc, không còn câu «đã xoá dòng cũ»), không khoá; bấm lại gửi lại cả bộ', async () => {
  io.rpc.mockResolvedValue({ data: null, error: { code: '42501', message: 'raw SQL' } });
  const input = { id: 'voucher-1', input: purchase };
  const mutation = useUpdateMaterialPurchase() as unknown as Mutation;
  const error = await mutation.mutationFn(input).catch(error => error);
  expect(error).toMatchObject({ code: '42501' });
  mutation.onError(error);
  expect(JSON.stringify(vi.mocked(toast.error).mock.calls)).not.toContain('raw SQL');
  expect(JSON.stringify(vi.mocked(toast.error).mock.calls)).not.toContain('Đã xoá các dòng cũ');
  expect(io.from).not.toHaveBeenCalled();
  await expect((useUpdateMaterialPurchase() as unknown as Mutation).mutationFn(input)).rejects.toMatchObject({ code: '42501' });
  expect(io.rpc).toHaveBeenCalledTimes(2);
  expect(io.rpc).toHaveBeenLastCalledWith('replace_material_purchase_v1', { p_purchase_id: 'voucher-1', p_purchase_date: '2026-09-30', p_supplier_id: null, p_notes: null, p_items: purchase.items });
});

// Đợt 9: trước đợt 9 test này tên «header không trả ID là bất định và chặn gửi lại sau remount». Hàng rào giữ: biên nhận
// thiếu mã vẫn là chưa rõ, không báo xong. Nay không khoá: hook mới gửi lại ĐÚNG mã đầu phiếu cũ.
it('header không trả ID là bất định (không báo xong), không khoá; hook mới gửi lại đúng mã đầu phiếu', async () => {
  const header = { insert: vi.fn(), select: vi.fn(), single: vi.fn().mockResolvedValue({ data: null, error: null }) };
  header.insert.mockReturnValue(header); header.select.mockReturnValue(header); io.from.mockReturnValue(header);
  await expect((useCreateMaterialPurchase() as unknown as Mutation).mutationFn(purchase)).rejects.toBeInstanceOf(RepeatableWriteUnknownError);
  await expect((useCreateMaterialPurchase() as unknown as Mutation).mutationFn(purchase)).rejects.toMatchObject({ outcome: 'unknown' });
  expect(header.insert).toHaveBeenCalledTimes(2);
  expect(typeof sentId(header.insert, 0)).toBe('string');
  expect(sentId(header.insert, 1)).toBe(sentId(header.insert, 0));
});

// Đợt 9: trước đợt 9 test này tên «phiếu xuất manual partial giữ ID và chặn tạo lại sau remount». Nay như phiếu nhập.
it('phiếu xuất tay: dòng bị từ chối, gỡ phiếu tạm cũng bị từ chối ⇒ báo từ chối kèm mã phiếu tạm, không khoá; lần sau dùng lại đúng mã phiếu', async () => {
  const header = { insert: vi.fn(), select: vi.fn(), single: vi.fn().mockResolvedValueOnce({ data: { id: 'usage-1', organization_id: 'org-a' }, error: null }).mockResolvedValue({ data: null, error: { code: '42501', message: 'cleanup raw SQL' } }), delete: vi.fn(), eq: vi.fn() };
  header.insert.mockReturnValue(header); header.select.mockReturnValue(header); header.delete.mockReturnValue(header); header.eq.mockReturnValue(header);
  const lines = { insert: vi.fn(), select: vi.fn().mockResolvedValue({ data: null, error: { code: '42501', message: 'raw SQL' } }), then: (resolve: (x: unknown) => void) => resolve({ data: null, error: { code: '42501', message: 'raw SQL' } }) };
  lines.insert.mockReturnValue(lines); io.from.mockImplementation((table: string) => table === 'material_usages' ? header : lines);
  const input = { usage_date: '2026-09-30', notes: null, items: [{ material_id: 'm-1', quantity: 2, unit_cost_at_usage: 100 }] };
  const error = await (useCreateMaterialUsage() as unknown as Mutation).mutationFn(input).catch(failure => failure);
  expect(error).toMatchObject({ outcome: 'failure' });
  expect(String((error as Error).message)).toContain('usage-1');
  expect(String((error as Error).message)).not.toContain('raw SQL');
  await (useCreateMaterialUsage() as unknown as Mutation).mutationFn(input).catch(() => undefined);
  expect(header.delete).toHaveBeenCalledTimes(1);
  expect(header.insert).toHaveBeenCalledTimes(2);
  expect(sentId(header.insert, 1)).toBe('usage-1');
});

// Đợt 8 (luật 5): vật tư công việc ghi lặp lại được. Trước đợt 8 test này tên «vật tư công việc giữ ID header và dòng đã
// xóa khi INSERT mới bị từ chối, không replay» và chốt lần lưu sau bị chặn. Đợt 10b: trước đó test tên «vật tư công việc: INSERT
// mới bị từ chối sau khi đã xoá dòng cũ ⇒ báo rõ đã xoá…». Nay MỘT hàm máy chủ nguyên tử: từ chối là lùi cả.
it('vật tư công việc: máy chủ từ chối hàm nguyên tử ⇒ báo từ chối (không lộ lỗi gốc, không còn câu «đã xoá vật tư cũ»), không khoá; bấm lại gửi lại cả bộ', async () => {
  io.rpc.mockResolvedValue({ data: null, error: { code: '42501', message: 'raw SQL' } });
  const input = { job_id: 'job-1', usage_date: '2026-09-30', notes: null, items: [{ material_id: 'm-1', quantity: 2, unit_cost_at_usage: 100 }] };
  const mutation = useUpsertJobMaterialUsage() as unknown as Mutation & { onError: (error: unknown, variables: unknown) => void };
  const error = await mutation.mutationFn(input).catch(error => error);
  expect(error).toMatchObject({ code: '42501' });
  mutation.onError(error, input);
  expect(JSON.stringify(vi.mocked(toast.error).mock.calls)).not.toContain('raw SQL');
  expect(JSON.stringify(vi.mocked(toast.error).mock.calls)).not.toContain('Đã xoá vật tư cũ');
  expect(io.from).not.toHaveBeenCalled();
  await expect((useUpsertJobMaterialUsage() as unknown as Mutation).mutationFn(input)).rejects.toMatchObject({ code: '42501' });
  expect(io.rpc).toHaveBeenCalledTimes(2);
  expect(io.rpc).toHaveBeenLastCalledWith('save_job_material_usage_v1', { p_job_id: 'job-1', p_usage_date: '2026-09-30', p_notes: null, p_items: input.items });
});

// Đợt 9: trước đợt 9 test này tên «SET đã có phiếu partial không được coi tồn khớp là biên nhận hoàn tất» và chốt lần sau
// bị chặn. Hàng rào giữ (nay mạnh hơn): số tồn của màn KHÔNG BAO GIỜ được coi là tồn đã khớp; tồn đọc trên máy chủ còn lệch
// thì lần sau vẫn ghi phần chênh, dùng lại đúng mã phiếu tạm của lần trước.
it('SET: màn nói tồn đã khớp nhưng tồn trên máy chủ chưa khớp ⇒ không coi là hoàn tất; lần sau dùng lại đúng phiếu tạm của lần trước', async () => {
  const header = { insert: vi.fn(), select: vi.fn(), single: vi.fn().mockResolvedValueOnce({ data: { id: 'adjustment-1', organization_id: 'org-a' }, error: null }).mockResolvedValue({ data: null, error: { code: '42501', message: 'cleanup raw SQL' } }), delete: vi.fn(), eq: vi.fn() };
  header.insert.mockReturnValue(header); header.select.mockReturnValue(header); header.delete.mockReturnValue(header); header.eq.mockReturnValue(header);
  const lines = { insert: vi.fn(), select: vi.fn().mockResolvedValue({ data: null, error: { code: '42501', message: 'raw SQL' } }) };
  lines.insert.mockReturnValue(lines);
  const stock = serverStock(1);
  io.from.mockImplementation((table: string) => table === 'materials' ? stock : table === 'material_adjustments' ? header : lines);
  await expect((useSetMaterialStock() as unknown as Mutation).mutationFn({ material_id: 'm-1', target_quantity: 3 })).rejects.toMatchObject({ outcome: 'failure' });
  const second = await (useSetMaterialStock() as unknown as Mutation).mutationFn({ material_id: 'm-1', target_quantity: 3, current_quantity: 3 }).catch(failure => failure);
  expect(second).not.toBeNull();
  expect(header.insert).toHaveBeenCalledTimes(2);
  expect(sentId(header.insert, 1)).toBe('adjustment-1');
  expect(header.insert.mock.calls[1][0]).toMatchObject({ type: 'IN' });
});

// Đợt 9: trước đợt 9 test này tên «tạo phiếu nhập xác nhận ID dòng mặc định từ server, rồi mở khóa lượt tạo tiếp». Dòng nay
// mang mã do trình duyệt sinh; biên nhận đủ dòng là xong; lượt tạo tiếp là phiếu mới.
it('tạo phiếu nhập: dòng mang mã do trình duyệt sinh, biên nhận trả đúng các mã đó là xong; lượt tạo tiếp là phiếu mới', async () => {
  const header = { insert: vi.fn(), select: vi.fn(), single: vi.fn().mockResolvedValue({ data: { id: 'purchase-1', organization_id: 'org-a' }, error: null }) };
  header.insert.mockReturnValue(header); header.select.mockReturnValue(header);
  // Máy chủ giữ `id` gửi lên (production): biên nhận trả đúng các mã dòng đã gửi.
  const lines = { insert: vi.fn((sent: Array<{ id: string }>) => ({ select: async () => ({ data: sent.map(row => ({ id: row.id })), error: null }) })) };
  io.from.mockImplementation((table: string) => table === 'material_purchases' ? header : lines);
  await expect((useCreateMaterialPurchase() as unknown as Mutation).mutationFn(purchase)).resolves.toMatchObject({ id: 'purchase-1' });
  expect(lines.insert).toHaveBeenCalledWith([{ purchase_id: 'purchase-1', material_id: 'm-1', quantity: 2, unit_price: 100, organization_id: 'org-a', id: expect.any(String) }]);
  await expect((useCreateMaterialPurchase() as unknown as Mutation).mutationFn(purchase)).resolves.toMatchObject({ id: 'purchase-1' });
  expect(header.insert).toHaveBeenCalledTimes(2);
  expect(sentId(header.insert, 1)).not.toBe(sentId(header.insert, 0));
});

// Đợt 9: trước đợt 9 test này tên «response thiếu ID dòng giữ header và chặn retry, không báo hoàn tất». Hàng rào giữ: biên
// nhận thiếu mã dòng không bao giờ là hoàn tất (chưa rõ, kèm mã phiếu). Nay không khoá: lần sau gửi lại đúng mã phiếu và mã dòng.
it('biên nhận thiếu mã dòng: không báo hoàn tất (chưa rõ, kèm mã phiếu), không khoá; lần sau gửi lại đúng mã phiếu và mã dòng', async () => {
  const header = { insert: vi.fn(), select: vi.fn(), single: vi.fn().mockResolvedValue({ data: { id: 'purchase-1', organization_id: 'org-a' }, error: null }) };
  header.insert.mockReturnValue(header); header.select.mockReturnValue(header);
  const lines = { insert: vi.fn(), select: vi.fn().mockResolvedValue({ data: [], error: null }) };
  lines.insert.mockReturnValue(lines); io.from.mockImplementation((table: string) => table === 'material_purchases' ? header : lines);
  await expect((useCreateMaterialPurchase() as unknown as Mutation).mutationFn(purchase)).rejects.toMatchObject({ outcome: 'unknown', completed: [{ id: 'purchase-1' }] });
  await expect((useCreateMaterialPurchase() as unknown as Mutation).mutationFn(purchase)).rejects.toMatchObject({ outcome: 'unknown' });
  expect(header.insert).toHaveBeenCalledTimes(2);
  expect(sentId(header.insert, 1)).toBe('purchase-1');
  expect((lines.insert.mock.calls[1][0] as Array<{ id: string }>)[0].id).toBe((lines.insert.mock.calls[0][0] as Array<{ id: string }>)[0].id);
});

// Đợt 8 (luật 5): trước đợt 8 test này tên «biên nhận DELETE dòng phiếu nhập malformed giữ header và chặn INSERT
// mới/replay». Đợt 10b: trước đó test tên «biên nhận DELETE dòng phiếu nhập malformed: không bao giờ chèn dòng mới lên trên…».
// Không còn lệnh xoá riêng; hàng rào giữ nguyên ở dạng mới: biên nhận sai dạng của hàm nguyên tử không bao giờ là đã lưu.
it('biên nhận sai dạng của hàm sửa phiếu nhập: chưa rõ, không bao giờ báo đã lưu; không khoá, bấm lại gửi lại cả bộ', async () => {
  io.rpc.mockResolvedValue({ data: { purchase: { id: 'purchase-1' }, items: [{ id: null }] }, error: null });
  const input = { id: 'purchase-1', input: purchase };
  const error = await (useUpdateMaterialPurchase() as unknown as Mutation).mutationFn(input).catch(error => error);
  expect(error).toBeInstanceOf(RepeatableWriteUnknownError);
  expect(String((error as Error).message)).toMatch(/một lần/);
  expect(String((error as Error).message)).not.toMatch(/chưa có dòng vật tư nào|Đã xoá các dòng cũ/);
  await expect((useUpdateMaterialPurchase() as unknown as Mutation).mutationFn(input)).rejects.toMatchObject({ outcome: 'unknown' });
  expect(io.rpc).toHaveBeenCalledTimes(2); expect(io.from).not.toHaveBeenCalled();
});

// Đợt 10b: trước đợt 10b test này tên «lỗi đọc phiếu vật tư công việc không trở thành chưa có phiếu để tạo mới» (bước đọc phiếu
// ở trình duyệt). Nay máy chủ tự tra phiếu trong cùng giao dịch; lỗi của hàm đi nguyên, trình duyệt không đoán «chưa có phiếu».
it('lỗi máy chủ khi lưu vật tư công việc đi nguyên lỗi, trình duyệt không tự đọc / tạo phiếu', async () => {
  io.rpc.mockResolvedValue({ data: null, error: { code: '42501', message: 'raw SQL' } });
  await expect((useUpsertJobMaterialUsage() as unknown as Mutation).mutationFn({ job_id: 'job-1', usage_date: '2026-09-30', notes: null, items: [{ material_id: 'm-1', quantity: 2, unit_cost_at_usage: 100 }] })).rejects.toMatchObject({ code: '42501' });
  expect(io.from).not.toHaveBeenCalled(); expect(io.rpc).toHaveBeenCalledOnce();
});
