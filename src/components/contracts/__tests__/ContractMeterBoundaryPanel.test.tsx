// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ContractMeterBoundaryPanel } from '../ContractMeterBoundaryPanel';

const meter = '00000000-0000-4000-8000-000000000005';
const state = vi.hoisted(() => ({ set: null as Record<string, unknown> | null, mutateAsync: vi.fn() }));
vi.mock('@/hooks/useContractMeterBoundaries', () => ({
  useContractMeterBoundaries: () => ({ isPending: false, isError: false, data: state.set }),
  useReviseContractMeterBoundaries: () => ({ isPending: false, mutateAsync: state.mutateAsync }),
}));
vi.mock('../ContractMeterBoundaryFields', () => ({ ContractMeterBoundaryFields: () => null }));

const set = (overrides: Record<string, unknown>) => ({
  id: '00000000-0000-4000-8000-000000000009', revision: 3, state: 'MISSING', history: [],
  readings: [{ id: 'r1', meter_id: meter, meter_code: 'E1', meter_type: 'ELECTRICITY', reading: null, measured_at: null, evidence: null }],
  ...overrides,
});
const show = (exit?: { state: 'PENDING' | 'FINALIZED'; current_kind: 'NATURAL_EXPIRY' | 'EARLY_RETURN' | 'FORFEIT' }) =>
  render(<ContractMeterBoundaryPanel contractId="contract" roomId="room" canEdit exit={exit} />);

beforeEach(() => { state.set = null; state.mutateAsync.mockReset().mockResolvedValue({}); });
afterEach(cleanup);

describe('chỉ số lúc trả phòng trong hồ sơ', () => {
  it('bỏ cọc chưa có số chốt: nói rõ không cần, số đầu khách sau do quản lý nhập', () => {
    state.set = set({});
    show({ state: 'FINALIZED', current_kind: 'FORFEIT' });
    expect(screen.getByRole('heading', { name: 'Chỉ số lúc trả phòng · Không cần số chốt' })).toBeTruthy();
    expect(screen.getByText(/Số đầu của khách sau do quản lý nhập khi làm hợp đồng mới/)).toBeTruthy();
  });
  it('còn chờ quyết toán: chỉ đường nhập số ở bước quyết toán', () => {
    state.set = set({});
    show({ state: 'PENDING', current_kind: 'EARLY_RETURN' });
    expect(screen.getByRole('heading', { name: 'Chỉ số lúc trả phòng · Chờ bổ sung' })).toBeTruthy();
    expect(screen.getByText(/Số điện cuối nhập ở bước quyết toán/)).toBeTruthy();
  });
  it('đã quyết toán mà chưa có số chốt: yêu cầu bổ sung', () => {
    state.set = set({});
    show({ state: 'FINALIZED', current_kind: 'NATURAL_EXPIRY' });
    expect(screen.getByText(/Đã quyết toán nhưng chưa có số điện chốt/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Đã đối soát, giữ số này' })).toBeNull();
  });
  it('REVIEW: "Đã đối soát" gửi lại đúng số đang ghi kèm lý do', async () => {
    state.set = set({ state: 'REVIEW', readings: [{ id: 'r1', meter_id: meter, meter_code: 'E1', meter_type: 'ELECTRICITY',
      reading: 1890, measured_at: '2026-09-28T16:59:59+00:00', evidence: 'Chỉ số chốt khi quyết toán TLY-1' }] });
    show({ state: 'FINALIZED', current_kind: 'EARLY_RETURN' });
    fireEvent.click(screen.getByRole('button', { name: 'Đã đối soát, giữ số này' }));
    const confirm = screen.getByRole('button', { name: 'Xác nhận đã đối soát' }) as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('Đã đối soát thế nào'), { target: { value: 'Đã thu thêm 7 kWh' } });
    fireEvent.click(confirm);
    await vi.waitFor(() => expect(state.mutateAsync).toHaveBeenCalledTimes(1));
    expect(state.mutateAsync.mock.calls[0][0]).toMatchObject({
      setId: '00000000-0000-4000-8000-000000000009', expectedRevision: 3, reason: 'Đã thu thêm 7 kWh',
      boundary: { state: 'VERIFIED', readings: [{ meterId: meter, reading: 1890, measuredAt: '2026-09-28T16:59:59.000Z', evidence: 'Chỉ số chốt khi quyết toán TLY-1' }] },
    });
  });
});
