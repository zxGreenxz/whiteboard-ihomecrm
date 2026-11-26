// @vitest-environment jsdom
// Đợt 9 (luật 5): form TẠO căn hộ, công tơ, dịch vụ, định mức không tự khoá sau kết quả chưa rõ (kể cả lỗi chưa rõ kiểu cũ):
// giữ nội dung đang nhập, báo rõ, nút Lưu bấm lại được và gửi lại đúng dữ liệu đó (hook gửi lại đúng mã cũ). Dịch vụ / định
// mức đã tạo mà bước sau (tòa áp dụng, bậc giá) chưa xong: báo mã, bấm Lưu lại để làm tiếp.
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const BUILDING = '11111111-1111-4111-8111-111111111111';
const io = vi.hoisted(() => ({ createRoom: vi.fn(), createMeter: vi.fn(), createService: vi.fn(), createQuota: vi.fn(), refetch: vi.fn() }));
// Ô chọn của Radix không mở được trong jsdom: thay bằng nút cho từng lựa chọn.
vi.mock('@/components/ui/select', async () => {
  const React = await import('react');
  const Choose = React.createContext<(value: string) => void>(() => undefined);
  return {
    Select: ({ onValueChange, children }: { onValueChange?: (value: string) => void; children: React.ReactNode }) => <Choose.Provider value={onValueChange ?? (() => undefined)}>{children}</Choose.Provider>,
    SelectTrigger: ({ children, ...props }: { children: React.ReactNode }) => <div {...props}>{children}</div>,
    SelectValue: () => null,
    SelectContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
    SelectItem: ({ value, children }: { value: string; children: React.ReactNode }) => { const choose = React.useContext(Choose); return <button type="button" onClick={() => choose(value)}>{children}</button>; },
  };
});
vi.mock('@/integrations/supabase/client', () => ({ supabase: { from: vi.fn() } }));
vi.mock('@/hooks/useRooms', () => ({ useCreateRoom: () => ({ mutateAsync: io.createRoom, isPending: false }), useUpdateRoom: () => ({ mutateAsync: vi.fn(), isPending: false }), useRooms: () => ({ data: [{ id: 'r1', name: '101' }], isLoading: false, isError: false, refetch: io.refetch }) }));
vi.mock('@/hooks/useBuildings', () => ({ useBuildings: () => ({ data: [{ id: BUILDING, name: 'Tòa A', status: 'ACTIVE' }], isLoading: false, isError: false, refetch: io.refetch }) }));
vi.mock('@/hooks/useFloors', () => ({ useFloors: () => ({ data: [{ id: 'f1', floor_number: 1 }], isLoading: false, isError: false, refetch: io.refetch }) }));
vi.mock('@/hooks/useDocumentTemplates', () => ({ useDocumentTemplatesByType: () => ({ data: [], isLoading: false, isError: false, refetch: io.refetch }) }));
vi.mock('@/components/rooms/RoomPriceHistorySection', () => ({ RoomPriceHistorySection: () => null }));
vi.mock('@/components/rooms/QuickCreateBuildingDialog', () => ({ default: () => null }));
vi.mock('@/components/rooms/QuickCreateFloorDialog', () => ({ default: () => null }));
vi.mock('@/hooks/useMeters', () => ({ useCreateMeter: () => ({ mutateAsync: io.createMeter, isPending: false }), useUpdateMeter: () => ({ mutateAsync: vi.fn(), isPending: false }) }));
vi.mock('@/hooks/useServices', async importOriginal => ({
  ...await importOriginal<typeof import('@/hooks/useServices')>(),
  useCreateService: () => ({ mutateAsync: io.createService, isPending: false }),
  useCreateServiceQuota: () => ({ mutateAsync: io.createQuota, isPending: false }),
  useServiceQuotas: () => ({ data: [], isLoading: false, isError: false, refetch: io.refetch }),
}));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));
vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });

import RoomFormDialog from '@/components/rooms/RoomFormDialog';
import MeterForm from '@/components/meters/MeterForm';
import { CreateServiceDialog } from '@/components/services/CreateServiceDialog';
import { CreateQuotaDialog } from '@/components/service-quotas/CreateQuotaDialog';
import { ServiceLinksPartialError, ServiceQuotaPartialError } from '@/hooks/useServices';
import { FinancialWorkflowError } from '@/lib/financialWorkflow';

const button = (name: string) => screen.getByRole('button', { name }) as HTMLButtonElement;
const legacyUnknown = (what: string) => new FinancialWorkflowError(`Chưa xác nhận được kết quả ${what}.`, 'unknown', []);
beforeEach(() => { vi.clearAllMocks(); });
afterEach(cleanup);

it('tạo căn hộ: kết quả chưa rõ (lỗi chưa rõ kiểu cũ) không khoá form; bấm lại gửi lại đúng dữ liệu', async () => {
  io.createRoom.mockRejectedValueOnce(legacyUnknown('tạo căn hộ')).mockResolvedValueOnce({ id: 'r-moi', name: 'P201' });
  const close = vi.fn();
  render(<RoomFormDialog open onOpenChange={close} preselectedBuildingId={BUILDING} />);
  fireEvent.click(button('Tầng 1'));
  fireEvent.change(screen.getByLabelText(/Tên phòng/), { target: { value: 'P201' } });
  fireEvent.click(button('Thêm căn hộ'));
  await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('Chưa xác nhận được kết quả tạo căn hộ'));
  expect(button('Thêm căn hộ').disabled).toBe(false);
  expect((screen.getByLabelText(/Tên phòng/) as HTMLInputElement).value).toBe('P201');
  fireEvent.click(button('Thêm căn hộ'));
  await waitFor(() => expect(close).toHaveBeenCalledWith(false));
  expect(io.createRoom).toHaveBeenCalledTimes(2);
  expect(io.createRoom.mock.calls[1]?.[0]).toEqual(io.createRoom.mock.calls[0]?.[0]);
  expect(io.createRoom.mock.calls[0]?.[0]).toMatchObject({ building_id: BUILDING, floor: 1, name: 'P201' });
});

it('tạo căn hộ trùng tên căn hộ khác: câu báo nêu mã căn hộ đó và ô tên báo lỗi', async () => {
  const cause = { code: '23505', message: 'duplicate key value violates unique constraint "idx_rooms_unique_name_per_building"' };
  io.createRoom.mockRejectedValueOnce(new FinancialWorkflowError('Căn hộ «P201» đã có trong tòa nhà này (mã room-cu).', 'failure', [], cause));
  render(<RoomFormDialog open onOpenChange={vi.fn()} preselectedBuildingId={BUILDING} />);
  fireEvent.click(button('Tầng 1'));
  fireEvent.change(screen.getByLabelText(/Tên phòng/), { target: { value: 'P201' } });
  fireEvent.click(button('Thêm căn hộ'));
  await waitFor(() => expect(screen.getAllByRole('alert').map(node => node.textContent).join(' ')).toContain('room-cu'));
  expect(screen.getByText('Tên căn hộ đã có trong tòa nhà này.')).toBeTruthy();
  expect(button('Thêm căn hộ').disabled).toBe(false);
});

const fillMeter = () => {
  fireEvent.click(button('Tòa A'));
  fireEvent.click(button('101'));
  fireEvent.click(button('Điện'));
  fireEvent.change(screen.getByPlaceholderText('VD: CTD-201'), { target: { value: 'CT-9' } });
};

it('tạo công tơ: kết quả chưa rõ (lỗi chưa rõ kiểu cũ) không khoá form; bấm lại gửi lại đúng dữ liệu', async () => {
  io.createMeter.mockRejectedValueOnce(legacyUnknown('tạo công tơ')).mockResolvedValueOnce({ id: 'm-moi', code: 'CT-9' });
  const close = vi.fn();
  render(<MeterForm open onOpenChange={close} meter={null} />);
  fillMeter();
  fireEvent.click(button('Lưu'));
  await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('Chưa xác nhận được kết quả tạo công tơ'));
  expect(button('Lưu').disabled).toBe(false);
  fireEvent.click(button('Lưu'));
  await waitFor(() => expect(close).toHaveBeenCalledWith(false));
  expect(io.createMeter).toHaveBeenCalledTimes(2);
  expect(io.createMeter.mock.calls[1]?.[0]).toEqual(io.createMeter.mock.calls[0]?.[0]);
  expect(io.createMeter.mock.calls[0]?.[0]).toMatchObject({ building_id: BUILDING, room_id: 'r1', meter_type: 'ELECTRICITY', code: 'CT-9' });
});

it('tạo công tơ trùng mã công tơ khác: câu báo nêu mã công tơ đó và ô mã báo lỗi', async () => {
  const cause = { code: '23505', message: 'duplicate key value violates unique constraint "meters_user_id_code_key"' };
  io.createMeter.mockRejectedValueOnce(new FinancialWorkflowError('Mã công tơ «CT-9» đã dùng cho công tơ khác (mã cong-to-cu).', 'failure', [], cause));
  render(<MeterForm open onOpenChange={vi.fn()} meter={null} />);
  fillMeter();
  fireEvent.click(button('Lưu'));
  await waitFor(() => expect(screen.getAllByRole('alert').map(node => node.textContent).join(' ')).toContain('cong-to-cu'));
  expect(screen.getByText('Mã công tơ đã tồn tại')).toBeTruthy();
  expect(button('Lưu').disabled).toBe(false);
});

const fillService = () => {
  fireEvent.change(screen.getByPlaceholderText('Nhập tên dịch vụ'), { target: { value: 'Rác' } });
  fireEvent.click(button('Tiền phí dịch vụ'));
  fireEvent.click(button('Đơn giá cố định theo tháng'));
  fireEvent.change(screen.getByPlaceholderText('0'), { target: { value: '50000' } });
  fireEvent.click(screen.getByRole('checkbox'));
};

it('tạo dịch vụ: kết quả chưa rõ (lỗi chưa rõ kiểu cũ) không khoá form; bấm lại gửi lại đúng dữ liệu', async () => {
  io.createService.mockRejectedValueOnce(legacyUnknown('tạo dịch vụ')).mockResolvedValueOnce({ id: 's-moi', name: 'Rác' });
  const close = vi.fn();
  render(<CreateServiceDialog open onOpenChange={close} />);
  fillService();
  fireEvent.click(button('Lưu'));
  await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('Chưa xác nhận được kết quả tạo dịch vụ'));
  expect(button('Lưu').disabled).toBe(false);
  fireEvent.click(button('Lưu'));
  await waitFor(() => expect(close).toHaveBeenCalledWith(false));
  expect(io.createService).toHaveBeenCalledTimes(2);
  expect(io.createService.mock.calls[1]?.[0]).toEqual(io.createService.mock.calls[0]?.[0]);
  expect(io.createService.mock.calls[0]?.[0]).toMatchObject({ name: 'Rác', fee_type: 'TIEN_PHI_DICH_VU', unit_price: 50000, building_ids: [BUILDING] });
});

it('tạo dịch vụ: đã tạo nhưng chưa gán đủ tòa thì báo mã, khoá ô thông tin dịch vụ (vẫn chọn tòa được); bấm Lưu lại làm tiếp trên đúng mã đó', async () => {
  io.createService.mockRejectedValueOnce(new ServiceLinksPartialError('s1', new TypeError('Failed to fetch'))).mockResolvedValueOnce({ id: 's1', name: 'Rác' });
  const close = vi.fn();
  render(<CreateServiceDialog open onOpenChange={close} />);
  fillService();
  fireEvent.click(button('Lưu'));
  await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('s1'));
  expect(button('Lưu').disabled).toBe(false);
  expect((screen.getByPlaceholderText('Nhập tên dịch vụ') as HTMLInputElement).disabled).toBe(true);
  expect((screen.getByPlaceholderText('0') as HTMLInputElement).disabled).toBe(true);
  expect((screen.getByRole('checkbox') as HTMLButtonElement).disabled).toBe(false);
  fireEvent.click(button('Lưu'));
  await waitFor(() => expect(close).toHaveBeenCalledWith(false));
  expect(io.createService).toHaveBeenCalledTimes(2);
  expect(io.createService.mock.calls[0]?.[0]).not.toHaveProperty('continueId');
  expect(io.createService.mock.calls[1]?.[0]).toEqual({ ...io.createService.mock.calls[0]?.[0], continueId: 's1' });
});

it('tạo dịch vụ: đóng hộp khi đang ghi dở thì bỏ mã đã nhớ và xoá nội dung; lần mở sau là lượt mới', async () => {
  io.createService.mockRejectedValueOnce(new ServiceLinksPartialError('s1', new TypeError('Failed to fetch')));
  const close = vi.fn();
  const view = render(<CreateServiceDialog open onOpenChange={close} />);
  fillService();
  fireEvent.click(button('Lưu'));
  await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('s1'));
  view.rerender(<CreateServiceDialog open={false} onOpenChange={close} />);
  view.rerender(<CreateServiceDialog open onOpenChange={close} />);
  expect(screen.queryByText(/mã s1/)).toBeNull();
  const name = screen.getByPlaceholderText('Nhập tên dịch vụ') as HTMLInputElement;
  expect(name.disabled).toBe(false);
  expect(name.value).toBe('');
});
const fillQuota = () => {
  fireEvent.change(screen.getByPlaceholderText('Nhập tên định mức'), { target: { value: 'Bậc điện' } });
  fireEvent.change(screen.getAllByPlaceholderText('0')[1]!, { target: { value: '1800' } });
};

it('tạo định mức: kết quả chưa rõ (lỗi chưa rõ kiểu cũ) không khoá form; bấm lại gửi lại đúng dữ liệu', async () => {
  io.createQuota.mockRejectedValueOnce(legacyUnknown('tạo định mức')).mockResolvedValueOnce({ id: 'q-moi', name: 'Bậc điện' });
  const close = vi.fn();
  render(<CreateQuotaDialog open onOpenChange={close} />);
  fillQuota();
  fireEvent.click(button('Lưu'));
  await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('Chưa xác nhận được kết quả tạo định mức'));
  expect(button('Lưu').disabled).toBe(false);
  fireEvent.click(button('Lưu'));
  await waitFor(() => expect(close).toHaveBeenCalledWith(false));
  expect(io.createQuota).toHaveBeenCalledTimes(2);
  expect(io.createQuota.mock.calls[1]?.[0]).toEqual(io.createQuota.mock.calls[0]?.[0]);
  expect(io.createQuota.mock.calls[0]?.[0]).toMatchObject({ name: 'Bậc điện', tiers: [{ tier_number: 1, from_value: 0, to_value: null, unit_price: 1800 }] });
});

it('tạo định mức: đã tạo nhưng chưa ghi xong bậc giá thì báo mã, khoá tên / mô tả (bậc vẫn sửa được); bấm Lưu lại làm tiếp trên đúng mã đó', async () => {
  io.createQuota.mockRejectedValueOnce(new ServiceQuotaPartialError('q1', new TypeError('Failed to fetch'))).mockResolvedValueOnce({ id: 'q1', name: 'Bậc điện' });
  const close = vi.fn();
  render(<CreateQuotaDialog open onOpenChange={close} />);
  fillQuota();
  fireEvent.click(button('Lưu'));
  await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('q1'));
  expect(button('Lưu').disabled).toBe(false);
  expect((screen.getByPlaceholderText('Nhập tên định mức') as HTMLInputElement).disabled).toBe(true);
  expect((screen.getAllByPlaceholderText('0')[1] as HTMLInputElement).disabled).toBe(false);
  fireEvent.click(button('Lưu'));
  await waitFor(() => expect(close).toHaveBeenCalledWith(false));
  expect(io.createQuota).toHaveBeenCalledTimes(2);
  expect(io.createQuota.mock.calls[0]?.[0]).not.toHaveProperty('continueId');
  expect(io.createQuota.mock.calls[1]?.[0]).toEqual({ ...io.createQuota.mock.calls[0]?.[0], continueId: 'q1' });
});