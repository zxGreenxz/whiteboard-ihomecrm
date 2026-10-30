import { describe, expect, it, vi } from 'vitest';
import { buildExcelRows, buildInvoiceItems, buildInvoiceFormData, reresolveRowPricing, type SubmitContext } from '../excelInvoiceRows';
import type { MeterBillingSource } from './types';
// Nguồn Mode Excel thật (fetchExcelInvoiceSource): bảng giả theo tên, resolver giả theo hợp đồng.
const db = vi.hoisted(() => ({ tables: {} as Record<string, unknown[]>, resolve: vi.fn() }));
vi.mock('@/integrations/supabase/client', () => {
  const query = (table: string): unknown => {
    const result = { data: db.tables[table] ?? [], error: null };
    const chain: unknown = new Proxy({}, { get: (_target, key) => key === 'then' ? (done: (value: typeof result) => unknown) => done(result) : () => chain });
    return chain;
  };
  return { supabase: { from: query } };
});
vi.mock('@/lib/meter-capture/service', () => ({ resolveMeterBilling: db.resolve, meterInvoiceRequestId: vi.fn(), readSavedMeterInvoiceRequest: vi.fn() }));
vi.mock('@/hooks/useInvoices', () => ({ useCreateInvoice: vi.fn() }));
vi.mock('@/contexts/OrganizationContext', () => ({ useOrganization: vi.fn() }));
import { fetchExcelInvoiceSource } from '@/hooks/invoices/useExcelInvoiceData';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const source = (over: Partial<MeterBillingSource> = {}): MeterBillingSource => ({
  meterId: id(1), meterName: 'Điện phòng A', meterType: 'ELECTRICITY', serviceId: id(4), decimalPlaces: 2, registerCode: '1.8.0',
  start: { readingId: id(2), value: '123.45', version: '1', captureId: null, readingDate: '2026-09-30' },
  end: { readingId: id(3), value: '145.50', version: '2', captureId: id(9), readingDate: '2026-10-31' }, issues: [], ...over,
});
const defaults = { elec: 3500, water: 0, pdv: 0, elecServiceId: id(4), waterServiceId: null, pdvServiceId: null };
const ctx: SubmitContext = { buildingId: id(5), billingMonth: '2026-10', issueDate: '2026-10-31', dueDate: '2026-11-05', periodStart: new Date(2026, 9, 1), fromDate: '2026-10-01', toDate: '2026-10-31' };
function row(sources = [source()]) {
  return buildExcelRows({ contracts: [{ id: id(6), room_id: id(7), rent_price: 1000000, room: { id: id(7), name: 'A', building_id: id(5) } }],
    meterByRoom: new Map([[id(7), id(1)]]), lastReading: new Map([[id(1), 999999]]), creditByContract: new Map(), invoiceCountByContract: new Map(),
    previousDebtByContract: new Map(), billingSourcesByContract: new Map([[id(6), sources]]), defaults, billingMonth: '2026-10' })[0];
}
describe('nguồn chỉ số của hóa đơn nhanh', () => {
  it('số đã chụp tháng này điền số cuối, không lấy latest làm số đầu', () => {
    const result = row();
    expect(result.prev_reading).toBe(123.45); expect(result.current_reading).toBe(145.5);
    const item = buildInvoiceItems(result, ctx).find(item => item.meter_source)!;
    expect(item.quantity).toBeCloseTo(22.05); expect(item.meter_source).toMatchObject({ endReadingId: id(3), startReadingId: id(2), currentReading: '145.50' });
  });
  it('0 kWh vẫn giữ nguồn chỉ số và snapshot', () => {
    const s = source(); s.end!.value = s.start!.value;
    const item = buildInvoiceItems(row([s]), ctx).find(item => item.meter_source)!;
    expect(item.quantity).toBe(0); expect(item.meter_source?.endReadingId).toBe(id(3));
  });
  it('nhiều đồng hồ tạo từng dòng, tổng và đơn giá tải lại khớp', () => {
    const second = source({ meterId: id(10), end: { ...source().end!, readingId: id(11), value: '125.45' } });
    const result = row([source(), second]);
    expect(buildInvoiceItems(result, ctx).filter(item => item.meter_source)).toHaveLength(2);
    expect(result.electric_amount).toBeCloseTo(24.05 * 3500);
    expect(reresolveRowPricing(result, { ...defaults, elec: 4000 }).electric_amount).toBeCloseTo(24.05 * 4000);
  });
  it('không dùng ảnh cũ làm chứng cứ cho số đã sửa tay', () => {
    expect(() => buildInvoiceItems({ ...row(), current_reading: 150 }, ctx)).toThrow('xác nhận lại');
  });
  it('thiếu đầu hoặc thiếu một trong nhiều đồng hồ thì chặn lưu', () => {
    expect(() => buildInvoiceFormData(row([source({ start: null, issues: ['MISSING_START'] })]), ctx)).toThrow();
    expect(() => buildInvoiceFormData(row([source(), source({ meterId: id(10), end: null, issues: ['MISSING_END'] })]), ctx)).toThrow();
  });
  it('Mode Excel có kỳ: resolver lỗi ở một HĐ không chặn cả toà; đồng hồ ghi tay lấy chỉ số đã duyệt mới nhất', async () => {
    const contract = (n: number, room: string) => ({ id: id(60 + n), organization_id: id(90), rent_price: 1000000, room_id: id(70 + n), status: 'ACTIVE',
      discounts: null, start_date: '2026-01-01', created_at: '2026-01-01T00:00:00Z', room: { id: id(70 + n), name: room, building_id: id(5) },
      contract_customers: [], contract_services: [] });
    db.tables = {
      contracts: [contract(1, '101'), contract(2, '102')],
      meters: [{ id: id(81), room_id: id(71), meter_type: 'ELECTRICITY' }, { id: id(82), room_id: id(72), meter_type: 'ELECTRICITY' }],
      meter_readings: [{ meter_id: id(81), current_reading: 8670, reading_date: '2026-10-31' }, { meter_id: id(82), current_reading: 13641, reading_date: '2026-10-31' }],
    };
    // 101: HĐ ACTIVE đã quá end_date ⇒ resolver 22023. 102: resolver trả số 30/04 (bản duy nhất có contract_id).
    db.resolve.mockImplementation(async (_org: string, input: { contractId: string }) => {
      if (input.contractId === id(61)) throw Object.assign(new Error('Chỉ số hoặc chứng cứ chưa đủ điều kiện.'), { code: '22023' });
      return [source({ meterId: id(82), registerCode: '', end: null, issues: ['MISSING_END'] })];
    });
    const loaded = await fetchExcelInvoiceSource(id(5), { month: '2026-11', readingDate: '2026-11-30' });
    expect(loaded.billingSourcesByContract?.has(id(61))).toBe(false);
    const rows = buildExcelRows({ ...loaded, defaults, billingMonth: '2026-11' });
    expect(rows.map(r => [r.room_name, r.prev_reading, r.meter_billing ?? null, r.meter_billing_error ?? null]))
      .toEqual([['101', 8670, null, null], ['102', 13641, null, null]]);
    // Thiếu quyền không được biến thành "nhập tay": vẫn báo lỗi tải dữ liệu.
    db.resolve.mockRejectedValue(Object.assign(new Error('Bạn chưa có quyền thực hiện thao tác này.'), { code: '42501' }));
    await expect(fetchExcelInvoiceSource(id(5), { month: '2026-11', readingDate: '2026-11-30' })).rejects.toThrow('chưa có quyền');
  });
  it('đồng hồ ghi tay (không QR/ảnh) giữ số đầu là chỉ số đã duyệt mới nhất và nhập tay như trước 23/10', () => {
    // Hai ca production 30/10: resolver trả số đầu cũ (bản duy nhất có contract_id) hoặc thiếu số đầu.
    for (const manual of [source({ registerCode: '', end: null, issues: ['MISSING_END'] }),
      source({ registerCode: '', start: null, end: null, issues: ['MISSING_START', 'MISSING_END'] })]) {
      const result = row([manual]);
      expect(result.meter_billing).toBeUndefined(); expect(result.meter_billing_error).toBeFalsy();
      expect(result.current_reading).toBe(''); expect(result.prev_reading).toBe(999999);
      expect(() => buildInvoiceFormData({ ...result, current_reading: 1000010, electric_amount: 38500 }, ctx)).not.toThrow();
    }
  });
  it('đồng hồ đã đăng ký ảnh phải chốt số cuối trước khi tạo hóa đơn', () => {
    const result = row([source({ end: null, issues: ['MISSING_END'] })]);
    expect(result.meter_billing_error).toContain('chốt số cuối');
    expect(() => buildInvoiceFormData({ ...result, current_reading: 145.5 }, ctx)).toThrow();
  });
  it('chỉ số đã dùng rồi bị thay thế yêu cầu kế toán xử lý, không âm thầm tính lại hóa đơn', () => {
    const result = row([source({ issues: ['BILLED_READING_REPLACED'] })]);
    expect(result.meter_billing_error).toContain('kế toán xử lý');
    expect(() => buildInvoiceFormData(result, ctx)).toThrow();
  });
});
