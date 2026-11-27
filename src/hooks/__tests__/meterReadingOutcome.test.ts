// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const io = vi.hoisted(() => ({ from: vi.fn(), rpc: vi.fn() }));
vi.mock('@tanstack/react-query', () => ({ useQuery: (config: unknown) => config, useMutation: (config: unknown) => config, useQueryClient: () => ({ invalidateQueries: vi.fn() }) }));
vi.mock('@/integrations/supabase/client', () => ({ supabase: io }));
vi.mock('@/lib/authSession', () => ({ getSessionUser: vi.fn().mockResolvedValue({ id: 'user-1' }) }));
vi.mock('@/contexts/OrganizationContext', () => ({ useOrganization: () => ({ selectedOrganizationId: 'org-1' }) }));
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn(), warning: vi.fn() } }));
import { MeterReadingsRejectedError } from '@/lib/meterReadingRpc';
import { useImportMeterReadings,useMeterReadingsList, useMeterReadingStats, useBulkCreateMeterReadings, useUpdateMeterReading, useDeleteMeterReading, useBulkDeleteMeterReadings } from '../useMeterReadings';

beforeEach(()=>{localStorage.clear();localStorage.setItem('ihomecrm.selectedOrganizationId','org-1');});
afterEach(() => { io.from.mockReset(); io.rpc.mockReset(); });
const [B1, M1, M2, R1] = ['b', '1', '2', '3'].map(c => `${c.repeat(8)}-${c.repeat(4)}-4${c.repeat(3)}-8${c.repeat(3)}-${c.repeat(12)}`);
const batchInput = [{ building_id: B1, meter_id: M1, reading_date: '2026-10-22', current_reading: 1234 }];
const written = { buildingId: B1, readingDate: '2026-10-22', settlementMonth: '2026-10', count: 1, replaced: [],
  created: [{ n: 1, id: R1, code: 'CSS261000001', meterId: M1, previous: 1200, value: 1234, consumption: 34 }] };
// useMutation đã được giả lập thành đối tượng cấu hình: gọi qua biến thường để không phải gọi hook trong hàm thường.
const bulkMutation = useBulkCreateMeterReadings as unknown as () => { mutationFn: (x: unknown[]) => Promise<unknown> };
const bulk = (input: unknown[] = batchInput) => bulkMutation().mutationFn(input);

it('ghi chỉ số hàng loạt: kết quả chưa rõ ⇒ lần sau gửi lại ĐÚNG khoá idempotency, hàm ghi trả kết quả đã chốt và gỡ dấu chờ', async () => {
  io.rpc.mockResolvedValueOnce({ data: null, error: null }).mockResolvedValueOnce({ data: written, error: null }).mockResolvedValueOnce({ data: written, error: null });
  await expect(bulk()).rejects.toThrow('Chưa xác nhận');
  await expect(bulk()).resolves.toEqual(written.created);
  const keys = io.rpc.mock.calls.map(([name, args]) => [name, (args as { p_idempotency_key: string }).p_idempotency_key]);
  expect(keys[0]).toEqual(['record_meter_readings_v2', expect.stringMatching(/^[A-Za-z0-9][A-Za-z0-9._:-]{7,199}$/)]);
  expect(keys[1]).toEqual(keys[0]);
  // Đã gỡ dấu chờ: lượt mới là yêu cầu mới (khoá mới).
  await expect(bulk()).resolves.toEqual(written.created);
  expect((io.rpc.mock.calls[2][1] as { p_idempotency_key: string }).p_idempotency_key).not.toBe(keys[0][1]);
});

it('ghi chỉ số hàng loạt: tháng đã có chỉ số ⇒ từ chối đã xác nhận nêu từng dòng, không giữ dấu chờ', async () => {
  io.rpc.mockResolvedValueOnce({ data: null, error: { code: '22023', message: 'meter_readings_rejected', hint: 'duplicate_month',
    details: JSON.stringify([{ n: 1, status: 'duplicate_month', roomName: 'P101', meterCode: 'DH-101', previous: 1200, existingValue: 1230 }]) } });
  const error = await bulk().catch((e: unknown) => e) as MeterReadingsRejectedError;
  expect(error).toBeInstanceOf(MeterReadingsRejectedError);
  expect(error.message).toBe('Chưa lưu chỉ số nào: P101 (DH-101): đã có chỉ số tháng này (1.230); mở dòng đó để sửa.');
  expect(error.outcome).toBe('failure');
  io.rpc.mockResolvedValueOnce({ data: written, error: null });
  await expect(bulk()).resolves.toEqual(written.created);
});

it('ghi chỉ số hàng loạt: một lô chỉ một toà và một ngày chốt; thiếu toà ⇒ chặn trước khi gọi hàm ghi', async () => {
  await expect(bulk([...batchInput, { ...batchInput[0], meter_id: M2, reading_date: '2026-10-23' }])).rejects.toThrow('Mỗi lần ghi một toà và một ngày chốt.');
  await expect(bulk([{ ...batchInput[0], building_id: '' }])).rejects.toThrow('Mỗi lần ghi một toà và một ngày chốt.');
  expect(io.rpc).not.toHaveBeenCalled();
});
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

// Đợt 11: đã gỡ dòng «tạo» (useCreateMeterReading đã xoá: không còn nơi gọi).
it.each([
  ['sửa', useUpdateMeterReading, { id: 'reading-1', current_reading: 2 }],
])('%s chỉ số không success nếu server không trả hàng', async (_label, hook, input) => {
  const chain = { insert: vi.fn(), update: vi.fn(), eq: vi.fn(), select: vi.fn(), single: vi.fn().mockResolvedValue({ data: null, error: null }) };
  chain.insert.mockReturnValue(chain); chain.update.mockReturnValue(chain); chain.eq.mockReturnValue(chain); chain.select.mockReturnValue(chain); io.from.mockReturnValue(chain);
  await expect((hook() as unknown as { mutationFn: (x: typeof input) => Promise<unknown> }).mutationFn(input)).rejects.toThrow('Chưa xác nhận');
});

// Đợt 8: xoá mềm chỉ đóng dấu dòng còn sống; khớp 0 dòng thì đọc lại đúng chỉ số đó trước khi kết luận.
it.each([
  ['biên nhận rỗng (null)', null, 'Chưa xác nhận'],
  ['khớp 0 dòng mà chỉ số vẫn còn', [], 'chưa có quyền xoá'],
])('xóa chỉ số không success nếu update không ảnh hưởng hàng nào: %s', async (_label, receipt, message) => {
  const chain = { update: vi.fn(), eq: vi.fn(), is: vi.fn(), select: vi.fn(), maybeSingle: vi.fn().mockResolvedValue({ data: { id: 'reading-1', deleted_at: null }, error: null }), then: (resolve: (value: unknown) => void) => resolve({ data: receipt, error: null }) };
  chain.update.mockReturnValue(chain); chain.eq.mockReturnValue(chain); chain.is.mockReturnValue(chain); chain.select.mockReturnValue(chain); io.from.mockReturnValue(chain);
  await expect((useDeleteMeterReading() as unknown as { mutationFn: (id: string) => Promise<unknown> }).mutationFn('reading-1')).rejects.toThrow(message);
});

it('bulk create/delete không nhận kết quả null như 0 hàng thành công', async () => {
  const chain = { insert: vi.fn(), update: vi.fn(), in: vi.fn(), is: vi.fn(), select: vi.fn(), then: (resolve: (value: unknown) => void) => resolve({ data: null, error: null }) };
  chain.insert.mockReturnValue(chain); chain.update.mockReturnValue(chain); chain.in.mockReturnValue(chain); chain.is.mockReturnValue(chain); chain.select.mockReturnValue(chain); io.from.mockReturnValue(chain);
  io.rpc.mockResolvedValueOnce({ data: null, error: null });
  await expect((useBulkCreateMeterReadings() as unknown as { mutationFn: (x: unknown[]) => Promise<unknown> }).mutationFn([{ building_id: B1, meter_id: M1, reading_date: '2026-09-30', current_reading: 1 }])).rejects.toThrow('Chưa xác nhận');
  await expect((useBulkDeleteMeterReadings() as unknown as { mutationFn: (x: string[]) => Promise<unknown> }).mutationFn(['reading-1'])).rejects.toThrow('Chưa xác nhận');
});

// Đợt 9: nhập chỉ số đi qua record_meter_readings_v2 theo nhóm toà + ngày chốt. Biên nhận chưa rõ ⇒ lần sau gửi lại ĐÚNG mã
// chống trùng của nhóm (không khoá); hàm ghi trả lại kết quả đã chốt.
it('unknown import: lần sau gửi lại đúng mã của nhóm, không khoá; hàm ghi trả kết quả đã chốt',async()=>{const meters={select:vi.fn(),eq:vi.fn(),in:vi.fn(),is:vi.fn(),then:(resolve:(value:unknown)=>void)=>resolve({data:[{id:M1,code:'M1',building_id:B1}],error:null})};meters.select.mockReturnValue(meters);meters.eq.mockReturnValue(meters);meters.in.mockReturnValue(meters);meters.is.mockReturnValue(meters);io.from.mockReturnValue(meters);io.rpc.mockResolvedValueOnce({data:{created:[{reading_id:'r1'}]},error:null}).mockResolvedValueOnce({data:written,error:null});const input={readings:[{meter_code:'M1',reading_date:'2026-10-22',current_reading:1234}]};const useReadingsResult=()=>(useImportMeterReadings() as unknown as {mutationFn:(x:unknown)=>Promise<unknown>}).mutationFn(input);await expect(useReadingsResult()).rejects.toThrow('Chưa xác nhận');await expect(useReadingsResult()).resolves.toEqual([{reading_id:R1,reading_code:'CSS261000001',success:true,error_message:null}]);const keys=io.rpc.mock.calls.map(([name,args])=>[name,(args as {p_idempotency_key:string}).p_idempotency_key]);expect(keys[0][0]).toBe('record_meter_readings_v2');expect(keys[1]).toEqual(keys[0]);});
// Đợt 11: hàng rào này trước đây chạy trên useCreateMeterReading (đã xoá); nay chạy trên sửa chỉ số, cùng phép kiểm.
it('NaN reading is rejected before the write',async()=>{const writer={update:vi.fn(),eq:vi.fn(),select:vi.fn(),single:vi.fn().mockResolvedValue({data:{id:'r1'},error:null})};writer.update.mockReturnValue(writer);writer.eq.mockReturnValue(writer);writer.select.mockReturnValue(writer);io.from.mockReturnValue(writer);await expect((useUpdateMeterReading() as unknown as {mutationFn:(x:unknown)=>Promise<unknown>}).mutationFn({id:'r1',current_reading:NaN})).rejects.toThrow();expect(writer.update).not.toHaveBeenCalled();});
