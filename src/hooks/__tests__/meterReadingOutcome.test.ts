// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const io = vi.hoisted(() => ({ from: vi.fn(), rpc: vi.fn() }));
vi.mock('@tanstack/react-query', () => ({ useQuery: (config: unknown) => config, useMutation: (config: unknown) => config, useQueryClient: () => ({ invalidateQueries: vi.fn() }) }));
vi.mock('@/integrations/supabase/client', () => ({ supabase: io }));
vi.mock('@/lib/authSession', () => ({ getSessionUser: vi.fn().mockResolvedValue({ id: 'user-1' }) }));
vi.mock('@/contexts/OrganizationContext', () => ({ useOrganization: () => ({ selectedOrganizationId: 'org-1' }) }));
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn(), warning: vi.fn() } }));
import { useImportMeterReadings,useMeterReadingsList, useMeterReadingStats, useCreateMeterReading, useBulkCreateMeterReadings, useUpdateMeterReading, useDeleteMeterReading, useBulkDeleteMeterReadings, useApproveMeterReading, useBulkApproveMeterReadings, useUnapproveMeterReading } from '../useMeterReadings';

beforeEach(()=>{localStorage.clear();localStorage.setItem('ihomecrm.selectedOrganizationId','org-1');});
afterEach(() => { io.from.mockReset(); io.rpc.mockReset(); });
it.each([{ data: null, error: null, count: 0 }, { data: [], error: { message: 'offline' }, count: 0 }, { data: [], error: null, count: null }])('danh sách chỉ số không giả rỗng khi response chưa xác nhận %#', async response => {
  const chain = { select: vi.fn(), range: vi.fn(), order: vi.fn() };
  chain.select.mockReturnValue(chain); chain.range.mockReturnValue(chain); chain.order.mockReturnValue(chain);
  Object.assign(chain, { then: (resolve: (value: unknown) => void) => resolve(response) }); io.from.mockReturnValue(chain);
  await expect((useMeterReadingsList({}, { page: 1, pageSize: 20 }) as unknown as { queryFn: () => Promise<unknown> }).queryFn()).rejects.toThrow();
});

it.each([{ data: null, error: null }, { data: null, error: { message: 'offline' } }])('thống kê chỉ số không giả 0 khi RPC chưa xác nhận %#', async response => {
  io.rpc.mockResolvedValue(response);
  await expect((useMeterReadingStats() as unknown as { queryFn: () => Promise<unknown> }).queryFn()).rejects.toThrow();
});

it.each([
  ['tạo', useCreateMeterReading, { meter_id: 'meter-1', reading_date: '2026-09-30', current_reading: 1 }],
  ['sửa', useUpdateMeterReading, { id: 'reading-1', current_reading: 2 }],
])('%s chỉ số không success nếu server không trả hàng', async (_label, hook, input) => {
  const chain = { insert: vi.fn(), update: vi.fn(), eq: vi.fn(), select: vi.fn(), single: vi.fn().mockResolvedValue({ data: null, error: null }) };
  chain.insert.mockReturnValue(chain); chain.update.mockReturnValue(chain); chain.eq.mockReturnValue(chain); chain.select.mockReturnValue(chain); io.from.mockReturnValue(chain);
  await expect((hook() as unknown as { mutationFn: (x: typeof input) => Promise<unknown> }).mutationFn(input)).rejects.toThrow('Chưa xác nhận');
});

it('xóa chỉ số không success nếu update không ảnh hưởng hàng nào', async () => {
  const chain = { update: vi.fn(), eq: vi.fn(), select: vi.fn(), single: vi.fn().mockResolvedValue({ data: null, error: null }) };
  chain.update.mockReturnValue(chain); chain.eq.mockReturnValue(chain); chain.select.mockReturnValue(chain); io.from.mockReturnValue(chain);
  await expect((useDeleteMeterReading() as unknown as { mutationFn: (id: string) => Promise<unknown> }).mutationFn('reading-1')).rejects.toThrow('Chưa xác nhận');
});

it('bulk create/delete không nhận kết quả null như 0 hàng thành công', async () => {
  const chain = { insert: vi.fn(), update: vi.fn(), in: vi.fn(), select: vi.fn(), then: (resolve: (value: unknown) => void) => resolve({ data: null, error: null }) };
  chain.insert.mockReturnValue(chain); chain.update.mockReturnValue(chain); chain.in.mockReturnValue(chain); chain.select.mockReturnValue(chain); io.from.mockReturnValue(chain);
  await expect((useBulkCreateMeterReadings() as unknown as { mutationFn: (x: unknown[]) => Promise<unknown> }).mutationFn([{ meter_id: 'm', reading_date: '2026-09-30', current_reading: 1 }])).rejects.toThrow('Chưa xác nhận');
  await expect((useBulkDeleteMeterReadings() as unknown as { mutationFn: (x: string[]) => Promise<unknown> }).mutationFn(['reading-1'])).rejects.toThrow('Chưa xác nhận');
});

it('bulk duyệt không chuyển RPC null thành đã duyệt 0', async () => {
  io.rpc.mockResolvedValue({ data: null, error: null });
  await expect((useBulkApproveMeterReadings() as unknown as { mutationFn: (x: string[]) => Promise<unknown> }).mutationFn(['reading-1'])).rejects.toThrow('Chưa xác nhận');
});

it.each([['duyệt', useApproveMeterReading], ['bỏ duyệt', useUnapproveMeterReading]])('%s một chỉ số cần ID và trạng thái được server xác nhận', async (_label, hook) => {
  io.rpc.mockResolvedValue({ data: null, error: null });
  await expect((hook() as unknown as { mutationFn: (id: string) => Promise<unknown> }).mutationFn('reading-1')).rejects.toThrow('Chưa xác nhận');
});

it('bulk duyệt một phần chỉ cảnh báo đúng số đã duyệt', async () => {
  io.rpc.mockResolvedValue({ data: 1, error: null });
  const hook = useBulkApproveMeterReadings() as unknown as { mutationFn: (ids: string[]) => Promise<number>; onSuccess: (count: number, ids: string[]) => void };
  const count = await hook.mutationFn(['reading-1', 'reading-2']);
  hook.onSuccess(count, ['reading-1', 'reading-2']);
  const { toast } = await import('sonner');
  expect(toast.warning).toHaveBeenCalledWith(expect.stringContaining('1/2'));
  expect(toast.success).not.toHaveBeenCalled();
});

it.each([['single',useCreateMeterReading,{meter_id:'m1',reading_date:'2026-09-30',current_reading:1}],['batch',useBulkCreateMeterReadings,[{meter_id:'m1',reading_date:'2026-09-30',current_reading:1}]]])('unknown %s create holds across remount',async(_name,hook,input)=>{const writer={insert:vi.fn(),select:vi.fn(),single:vi.fn().mockResolvedValue({data:null,error:null}),then:(resolve:(v:unknown)=>void)=>resolve({data:null,error:null})};writer.insert.mockReturnValue(writer);writer.select.mockReturnValue(writer);io.from.mockReturnValue(writer);const useReadingsResult=()=>(hook() as unknown as {mutationFn:(x:unknown)=>Promise<unknown>}).mutationFn(input);await expect(useReadingsResult()).rejects.toThrow();await expect(useReadingsResult()).rejects.toThrow();expect(writer.insert).toHaveBeenCalledTimes(1);});
it('unknown import preserves confirmed IDs and cannot replay RPC after remount',async()=>{io.rpc.mockResolvedValue({data:[{reading_id:'r1',success:true}],error:null});const input={readings:[{meter_code:'M1',reading_date:'2026-09-30',current_reading:1},{meter_code:'M2',reading_date:'2026-09-30',current_reading:2}]};const useReadingsResult=()=>(useImportMeterReadings() as unknown as {mutationFn:(x:unknown)=>Promise<unknown>}).mutationFn(input);await expect(useReadingsResult()).rejects.toThrow();await expect(useReadingsResult()).rejects.toThrow();expect(io.rpc).toHaveBeenCalledTimes(1);});
it('NaN reading is rejected before the insert',async()=>{const writer={insert:vi.fn(),select:vi.fn(),single:vi.fn().mockResolvedValue({data:{id:'r1'},error:null})};writer.insert.mockReturnValue(writer);writer.select.mockReturnValue(writer);io.from.mockReturnValue(writer);await expect((useCreateMeterReading() as unknown as {mutationFn:(x:unknown)=>Promise<unknown>}).mutationFn({meter_id:'m1',reading_date:'2026-09-30',current_reading:NaN})).rejects.toThrow();expect(writer.insert).not.toHaveBeenCalled();});
