import { describe, expect, it } from 'vitest';
import { buildExcelRows, buildInvoiceItems, buildInvoiceFormData, reresolveRowPricing, type SubmitContext } from '../excelInvoiceRows';
import type { MeterBillingSource } from './types';

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
  it('một đồng hồ chưa có số cuối cho nhập tay, vẫn dùng đúng số đầu', () => {
    const result = row([source({ end: null, issues: ['MISSING_END'] })]);
    expect(result.meter_billing_error).toBeFalsy(); expect(result.current_reading).toBe(''); expect(result.prev_reading).toBe(123.45);
  });
});
