// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ContractWithRelations } from '@/types/contract';
import type { ExtraChargeItem } from '@/lib/contractValidation';
import type { MeterBillingSource } from '@/lib/meter-capture/types';
const api = vi.hoisted(() => ({ resolve: vi.fn() }));
vi.mock('@/lib/meter-capture/service', () => ({ resolveMeterBilling: api.resolve }));
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
const show = () => render(<TerminationExtraCharges contract={contract} chargeDate="2026-10-08" onChange={changed} onValidityChange={valid} />);
const electric = () => items.filter(item => item.kind === 'ELECTRIC');
beforeEach(() => { items = []; vi.clearAllMocks(); api.resolve.mockResolvedValue([source()]); });
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
  it('lỗi nguồn chặn quyết toán, không lấy số đầu hợp đồng làm dự phòng', async () => {
    api.resolve.mockRejectedValue(new Error('Không tải được nguồn chỉ số')); show();
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('Không tải được nguồn'));
    expect(valid).toHaveBeenLastCalledWith(false); expect(electric()).toEqual([]);
    expect(screen.queryByTitle('Số điện đầu Đồng hồ 4')).toBeNull();
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
});
