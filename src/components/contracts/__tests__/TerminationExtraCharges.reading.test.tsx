// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ContractWithRelations } from '@/types/contract';
import type { ExtraChargeItem } from '@/lib/contractValidation';
import type { MeterBillingSource } from '@/lib/meter-capture/types';
import type { ExtraChargesDraft } from '@/lib/contractExitSettlementDrafts';
const api = vi.hoisted(() => ({ resolve: vi.fn(), latest: vi.fn(), meter: vi.fn() }));
vi.mock('@/lib/meter-capture/service', () => ({ resolveMeterBilling: api.resolve, readLatestApprovedReading: api.latest, readActiveElectricMeter: api.meter }));
vi.mock('@/contexts/OrganizationContext', () => ({ useOrganization: () => ({ selectedOrganizationId: 'org-a' }) }));
vi.mock('@/components/meter-readings/MeterEvidenceThumb', () => ({ MeterEvidenceThumb: ({ captureId }: { captureId?: string }) => captureId ? <span>Ảnh {captureId}</span> : null }));
vi.mock('@/hooks/useBuildingServices', () => ({ useBuildingServices: () => ({ data: [
  { is_active: true, service_id: 'elec', unit_price_override: 3500, service: { name: 'Tiền điện', unit_price: 3500 } },
] }) }));
import { TerminationExtraCharges } from '../TerminationExtraCharges';
const id = (n: number) => `11111111-1111-4111-8111-${String(n).padStart(12, '0')}`;
const contract = { id: id(1), room_id: id(2), rent_price: 3_000_000, contract_services: [], contract_customers: [],
  initial_electricity_reading: 100, room: { building_id: id(3) } } as unknown as ContractWithRelations;
const source = (n = 4): MeterBillingSource => ({ meterId: id(n), meterName: `Đồng hồ ${n}`, meterType: 'ELECTRICITY', serviceId: null,
  decimalPlaces: 2, registerCode: '1.8.0', issues: [],
  start: { readingId: id(10 + n), value: '5000', version: '1', captureId: id(30 + n), readingDate: '2026-09-30' },
  end: { readingId: id(20 + n), value: '5012', version: '2', captureId: id(40 + n), readingDate: '2026-10-08' } });
let items: ExtraChargeItem[] = [];
const valid = vi.fn();
const changed = (value: ExtraChargeItem[]) => { items = value; };
const show = (target = contract) => render(<TerminationExtraCharges contract={target} chargeDate="2026-10-08" onChange={changed} onValidityChange={valid} />);
const electric = () => items.filter(item => item.kind === 'ELECTRIC');
// Đồng hồ ghi tay như production 30/10: không QR, không ảnh, resolver không tìm được số đầu.
const manualMeter = (): MeterBillingSource => ({ ...source(), registerCode: '', start: null, end: null, issues: ['MISSING_START', 'MISSING_END'] });
beforeEach(() => { items = []; vi.clearAllMocks(); api.resolve.mockResolvedValue([source()]); api.latest.mockResolvedValue(null); api.meter.mockResolvedValue(null); });
afterEach(cleanup);

describe('nguồn điện thanh lý đúng hợp đồng, ngày chốt và từng đồng hồ', () => {
  it('nguồn đã dùng bị thay thế chặn thanh lý và hướng dẫn kế toán điều chỉnh', async () => {
    api.resolve.mockResolvedValue([{ ...source(), issues: ['BILLED_READING_REPLACED'] }]); show();
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('kế toán xử lý điều chỉnh'));
    expect(valid).toHaveBeenLastCalledWith(false); expect(electric()).toEqual([]);
  });
  it('tự điền hai số đã chốt, khoá chỉnh tay và liên kết chứng cứ có phiên bản', async () => {
    show();
    await waitFor(() => expect(electric()).toHaveLength(1));
    expect(api.resolve).toHaveBeenCalledWith('org-a', { contractId: contract.id, month: '2026-10', readingDate: '2026-10-08', purpose: 'MOVE_OUT' });
    expect(electric()[0]).toMatchObject({ meter_id: id(4), previous_reading: 5000, current_reading: 5012, amount: 42000,
      meter_source: { startReadingId: id(14), endReadingId: id(24), endVersion: '2', purpose: 'MOVE_OUT' } });
    expect((screen.getByTitle('Số điện cuối Đồng hồ 4') as HTMLInputElement).readOnly).toBe(true);
    expect(screen.getByText(`Ảnh ${id(44)}`)).toBeTruthy();
    expect(valid).toHaveBeenLastCalledWith(true);
  });
  it('giữ dòng 0 kWh có chứng cứ và hỗ trợ nhiều đồng hồ', async () => {
    const first = source(), second = source(5);
    first.end!.value = first.start!.value;
    api.resolve.mockResolvedValue([first, second]); show();
    await waitFor(() => expect(electric()).toHaveLength(2));
    expect(electric()[0]).toMatchObject({ amount: 0, meter_source: { meterId: id(4), sortOrder: 0 } });
    expect(electric()[1]).toMatchObject({ amount: 42000, meter_source: { meterId: id(5), sortOrder: 1 } });
  });
  it('resolver lỗi và phòng không có đồng hồ ACTIVE thì như resolver trả rỗng: không có dòng điện, không lấy số đầu hợp đồng', async () => {
    api.resolve.mockRejectedValue(new Error('Không tải được nguồn chỉ số')); show();
    await waitFor(() => expect(screen.getByText(/Phòng chưa có đồng hồ điện đang dùng/)).toBeTruthy());
    expect(api.meter).toHaveBeenCalledWith(id(2)); expect(screen.queryByRole('alert')).toBeNull();
    expect(valid).toHaveBeenLastCalledWith(true); expect(electric()).toEqual([]);
    expect(screen.queryByTitle('Số điện đầu Đồng hồ 4')).toBeNull();
  });
  it('số đầu nhập âm bị chặn, không tính tiền điện', async () => {
    api.resolve.mockResolvedValue([manualMeter()]); api.latest.mockResolvedValue({ value: 3931, readingDate: '2026-09-30' }); show();
    await waitFor(() => expect((screen.getByTitle('Số điện đầu Đồng hồ 4') as HTMLInputElement).value).toBe('3931'));
    fireEvent.change(screen.getByTitle('Số điện đầu Đồng hồ 4'), { target: { value: '-5' } });
    fireEvent.change(screen.getByTitle('Số điện cuối Đồng hồ 4'), { target: { value: '3950' } });
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('Số đầu không được âm'));
    expect(valid).toHaveBeenLastCalledWith(false); expect(electric()).toEqual([]);
  });
  it('thiếu số một trong nhiều đồng hồ chặn quyết toán, không bỏ qua đồng hồ đó', async () => {
    api.resolve.mockResolvedValue([source(), { ...source(5), end: null, issues: ['MISSING_END'] }]); show();
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('Thiếu nguồn hợp lệ'));
    expect(valid).toHaveBeenLastCalledWith(false);
    expect((screen.getByTitle('Số điện cuối Đồng hồ 5') as HTMLInputElement).readOnly).toBe(true);
  });
  it('một đồng hồ chưa đăng ký capture vẫn nhập tay số cuối, không cho thay số đầu hoặc giảm số', async () => {
    api.resolve.mockResolvedValue([{ ...source(), registerCode: '', end: null, issues: ['MISSING_END'] }]); show();
    await waitFor(() => expect(screen.getByTitle('Số điện cuối Đồng hồ 4')).toBeTruthy());
    expect((screen.getByTitle('Số điện đầu Đồng hồ 4') as HTMLInputElement).readOnly).toBe(true);
    fireEvent.change(screen.getByTitle('Số điện cuối Đồng hồ 4'), { target: { value: '5012' } });
    await waitFor(() => expect(electric()[0]).toMatchObject({ meter_id: id(4), current_reading: 5012, amount: 42000 }));
    expect(electric()[0].meter_source).toBeUndefined();
    fireEvent.change(screen.getByTitle('Số điện cuối Đồng hồ 4'), { target: { value: '4999' } });
    await waitFor(() => expect(valid).toHaveBeenLastCalledWith(false));
    expect(electric()).toEqual([]);
  });
  it('một đồng hồ đã đăng ký capture thiếu số cuối phải chốt trước khi thanh lý, kể cả 0 kWh', async () => {
    api.resolve.mockResolvedValueOnce([{ ...source(), end: null, issues: ['MISSING_END'] }]); show();
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('cần chốt số cuối tại Ghi chỉ số'));
    expect(valid).toHaveBeenLastCalledWith(false);
    expect(electric()).toEqual([]);
    expect((screen.getByTitle('Số điện cuối Đồng hồ 4') as HTMLInputElement).readOnly).toBe(true);
    const approved = source(); approved.end!.value = approved.start!.value;
    api.resolve.mockResolvedValueOnce([approved]);
    fireEvent.click(screen.getByRole('button', { name: 'Tải lại chỉ số đã chốt' }));
    await waitFor(() => expect(electric()).toHaveLength(1));
    expect(valid).toHaveBeenLastCalledWith(true);
    expect(electric()[0]).toMatchObject({ amount: 0, previous_reading: 5000, current_reading: 5000,
      meter_source: { meterId: id(4), endReadingId: id(24) } });
  });
  it('đổi ngày chốt xoá nguồn cũ và chặn trong khi tải lại', async () => {
    const view = show(); await waitFor(() => expect(electric()).toHaveLength(1));
    api.resolve.mockReturnValue(new Promise(() => undefined));
    view.rerender(<TerminationExtraCharges contract={contract} chargeDate="2026-10-09" onChange={changed} onValidityChange={valid} />);
    await waitFor(() => expect(electric()).toHaveLength(0));
    expect(valid).toHaveBeenLastCalledWith(false);
    expect(api.resolve).toHaveBeenLastCalledWith('org-a', expect.objectContaining({ readingDate: '2026-10-09' }));
  });
  it('đồng hồ ghi tay lấy số đầu là chỉ số đã duyệt mới nhất rồi nhập tay số cuối như trước 23/10', async () => {
    api.resolve.mockResolvedValue([manualMeter()]); api.latest.mockResolvedValue({ value: 3931, readingDate: '2026-09-30' }); show();
    await waitFor(() => expect((screen.getByTitle('Số điện đầu Đồng hồ 4') as HTMLInputElement).value).toBe('3931'));
    expect(api.latest).toHaveBeenCalledWith(id(4)); expect(screen.queryByRole('alert')).toBeNull();
    fireEvent.change(screen.getByTitle('Số điện cuối Đồng hồ 4'), { target: { value: '3950' } });
    await waitFor(() => expect(electric()[0]).toMatchObject({ meter_id: id(4), previous_reading: 3931, current_reading: 3950, amount: 66500 }));
    expect(electric()[0].meter_source).toBeUndefined();
    expect(valid).toHaveBeenLastCalledWith(true);
  });
  it('số đầu của đồng hồ ghi tay sửa được như trước 23/10', async () => {
    api.resolve.mockResolvedValue([manualMeter()]); api.latest.mockResolvedValue({ value: 3931, readingDate: '2026-09-30' }); show();
    await waitFor(() => expect((screen.getByTitle('Số điện đầu Đồng hồ 4') as HTMLInputElement).value).toBe('3931'));
    expect((screen.getByTitle('Số điện đầu Đồng hồ 4') as HTMLInputElement).readOnly).toBe(false);
    fireEvent.change(screen.getByTitle('Số điện đầu Đồng hồ 4'), { target: { value: '3920' } });
    fireEvent.change(screen.getByTitle('Số điện cuối Đồng hồ 4'), { target: { value: '3950' } });
    await waitFor(() => expect(electric()[0]).toMatchObject({ meter_id: id(4), previous_reading: 3920, current_reading: 3950, amount: 105000 }));
  });
  it('đồng hồ ghi tay chưa có chỉ số đã duyệt dùng số đầu hợp đồng; thiếu cả hai thì để trống cho nhập, không tính từ 0', async () => {
    api.resolve.mockResolvedValue([manualMeter()]); const view = show();
    await waitFor(() => expect((screen.getByTitle('Số điện đầu Đồng hồ 4') as HTMLInputElement).value).toBe('100'));
    view.unmount();
    show({ ...contract, initial_electricity_reading: null } as unknown as ContractWithRelations);
    await waitFor(() => expect(screen.getByText('Chưa có chỉ số đã duyệt: nhập số đầu và số cuối.')).toBeTruthy());
    expect((screen.getByTitle('Số điện đầu Đồng hồ 4') as HTMLInputElement).value).toBe('');
    fireEvent.change(screen.getByTitle('Số điện cuối Đồng hồ 4'), { target: { value: '3950' } });
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('Nhập số đầu'));
    expect(valid).toHaveBeenLastCalledWith(false); expect(electric()).toEqual([]);
    fireEvent.change(screen.getByTitle('Số điện đầu Đồng hồ 4'), { target: { value: '3900' } });
    await waitFor(() => expect(electric()[0]).toMatchObject({ previous_reading: 3900, current_reading: 3950, amount: 175000 }));
    expect(valid).toHaveBeenLastCalledWith(true);
  });
  it('resolver lỗi (vd HĐ quá hạn) vẫn nhập tay theo đồng hồ ACTIVE của phòng như trước 23/10', async () => {
    api.resolve.mockRejectedValue(new Error('Chỉ số hoặc chứng cứ chưa đủ điều kiện.'));
    api.meter.mockResolvedValue({ meterId: id(4), meterName: 'Đồng hồ 4' }); api.latest.mockResolvedValue({ value: 3931, readingDate: '2026-09-30' }); show();
    await waitFor(() => expect((screen.getByTitle('Số điện đầu Đồng hồ 4') as HTMLInputElement).value).toBe('3931'));
    expect(api.meter).toHaveBeenCalledWith(id(2)); expect(screen.queryByRole('alert')).toBeNull();
    fireEvent.change(screen.getByTitle('Số điện cuối Đồng hồ 4'), { target: { value: '3950' } });
    await waitFor(() => expect(electric()[0]).toMatchObject({ meter_id: id(4), previous_reading: 3931, current_reading: 3950, amount: 66500 }));
    expect(valid).toHaveBeenLastCalledWith(true);
  });
  it('không đọc được chỉ số đã duyệt của đồng hồ ghi tay thì chặn và cho tải lại', async () => {
    api.resolve.mockResolvedValue([manualMeter()]); api.latest.mockRejectedValue(new Error('Không tải được chỉ số đã duyệt')); show();
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('Không tải được chỉ số đã duyệt'));
    expect(valid).toHaveBeenLastCalledWith(false); expect(electric()).toEqual([]);
    expect(screen.getByRole('button', { name: 'Tải lại nguồn chỉ số' })).toBeTruthy();
  });
  it('resolver báo thiếu quyền thì giữ lỗi, không quay về nhập tay', async () => {
    api.resolve.mockRejectedValue(Object.assign(new Error('Bạn chưa có quyền thực hiện thao tác này.'), { code: '42501' }));
    api.meter.mockResolvedValue({ meterId: id(4), meterName: 'Đồng hồ 4' }); show();
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('chưa có quyền'));
    expect(api.meter).not.toHaveBeenCalled(); expect(valid).toHaveBeenLastCalledWith(false);
  });
});

describe('bỏ cọc: số điện không bắt buộc (chủ chốt 30/10/2026)', () => {
  const showOptional = () => render(<TerminationExtraCharges contract={contract} chargeDate="2026-10-08" onChange={changed} onValidityChange={valid} meterOptional />);
  it('đồng hồ QR chưa chốt số cuối không chặn quyết toán, không thu tiền điện', async () => {
    api.resolve.mockResolvedValue([{ ...source(), end: null, issues: ['MISSING_END'] }]); showOptional();
    await waitFor(() => expect(valid).toHaveBeenLastCalledWith(true));
    expect(screen.queryByRole('alert')).toBeNull(); expect(electric()).toEqual([]);
  });
  it('không tải được nguồn chỉ số vẫn cho quyết toán, vẫn báo lỗi và cho tải lại', async () => {
    api.resolve.mockRejectedValue(Object.assign(new Error('Thiếu quyền'), { code: '42501' })); showOptional();
    await waitFor(() => expect(screen.getByRole('alert')).toBeTruthy());
    expect(valid).toHaveBeenLastCalledWith(true); expect(electric()).toEqual([]);
  });
  it('chỉ số đã dùng cho hoá đơn bị thay thế vẫn chặn và vẫn báo kế toán xử lý', async () => {
    api.resolve.mockResolvedValue([{ ...source(), issues: ['BILLED_READING_REPLACED'] }]); showOptional();
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('kế toán xử lý điều chỉnh'));
    expect(valid).toHaveBeenLastCalledWith(false); expect(electric()).toEqual([]);
  });
  it('đang tải thì vẫn chặn; số gõ tay sai vẫn chặn', async () => {
    api.resolve.mockResolvedValue([manualMeter()]); api.latest.mockResolvedValue({ value: 3931, readingDate: '2026-09-30' }); showOptional();
    expect(valid).toHaveBeenLastCalledWith(false);
    await waitFor(() => expect(valid).toHaveBeenLastCalledWith(true));
    fireEvent.change(screen.getByTitle('Số điện cuối Đồng hồ 4'), { target: { value: '3900' } });
    await waitFor(() => expect(valid).toHaveBeenLastCalledWith(false));
    expect(electric()).toEqual([]);
  });
});

describe('nháp quyết toán: điền lại các ô tự nhập', () => {
  it('điền lại khoản theo ngày, vệ sinh, dòng tuỳ ý và số điện ghi tay đúng đồng hồ; emit lại đúng nháp', async () => {
    api.resolve.mockResolvedValue([manualMeter()]); api.latest.mockResolvedValue({ value: 3931, readingDate: '2026-09-30' });
    const drafts: unknown[] = [];
    render(<TerminationExtraCharges contract={contract} chargeDate="2026-10-08" onChange={changed} onValidityChange={valid} onDraftChange={draft => drafts.push(draft)}
      initialDraft={{ fromDate: '2026-10-01', toDate: '2026-10-03', proratedAmount: 250_000, proratedTouched: true, cleaningAmount: 100_000,
        customRows: [{ name: 'Sửa khoá', amount: 80_000 }], meter: { meterId: id(4), currentReading: 3950, startOverride: 3920 } }} />);
    await waitFor(() => expect((screen.getByTitle('Số điện cuối Đồng hồ 4') as HTMLInputElement).value).toBe('3950'));
    expect((screen.getByTitle('Số điện đầu Đồng hồ 4') as HTMLInputElement).value).toBe('3920');
    expect((screen.getByPlaceholderText('Tên khoản thu thêm…') as HTMLInputElement).value).toBe('Sửa khoá');
    await waitFor(() => expect(items).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'PRORATED', amount: 250_000 }), expect.objectContaining({ kind: 'CLEANING', amount: 100_000 }),
      expect.objectContaining({ kind: 'CUSTOM', description: 'Sửa khoá', amount: 80_000 }),
      expect.objectContaining({ kind: 'ELECTRIC', previous_reading: 3920, current_reading: 3950, amount: 105_000 })])));
    expect(drafts[drafts.length - 1]).toEqual({ fromDate: '2026-10-01', toDate: '2026-10-03', proratedAmount: 250_000, proratedTouched: true, cleaningAmount: 100_000,
      customRows: [{ name: 'Sửa khoá', amount: 80_000 }], meter: { meterId: id(4), currentReading: 3950, startOverride: 3920 } });
  });
  it('số điện trong nháp của đồng hồ khác (đã thay đồng hồ) thì bỏ, không điền nhầm; chưa tải xong vẫn giữ trong nháp', async () => {
    let resolveSources: (value: MeterBillingSource[]) => void = () => undefined;
    api.resolve.mockReturnValue(new Promise(resolve => { resolveSources = resolve; }));
    const drafts: ExtraChargesDraft[] = [];
    render(<TerminationExtraCharges contract={contract} chargeDate="2026-10-08" onChange={changed} onValidityChange={valid} onDraftChange={draft => drafts.push(draft)}
      initialDraft={{ fromDate: '', toDate: '2026-10-08', proratedAmount: 0, proratedTouched: false, cleaningAmount: 200_000, customRows: [], meter: { meterId: id(9), currentReading: 4100 } }} />);
    await waitFor(() => expect(drafts.length).toBeGreaterThan(0));
    expect(drafts[drafts.length - 1].meter).toEqual({ meterId: id(9), currentReading: 4100 });
    api.latest.mockResolvedValue({ value: 3931, readingDate: '2026-09-30' });
    resolveSources([manualMeter()]);
    await waitFor(() => expect(drafts[drafts.length - 1].meter).toBeNull());
    expect((screen.getByTitle('Số điện cuối Đồng hồ 4') as HTMLInputElement).value).toBe('');
  });
});
