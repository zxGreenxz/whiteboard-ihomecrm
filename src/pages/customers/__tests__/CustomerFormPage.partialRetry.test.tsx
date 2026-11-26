// @vitest-environment jsdom
// Đợt 8: sửa khách mà xe chưa đồng bộ xong (khách ĐÃ cập nhật) thì báo và cho LƯU LẠI: lần lưu sau nhận xe đã lưu theo
// biển số nên không tạo trùng. Tạo khách hỏng xe (đường tạo mới, đợt 4/9) vẫn khoá form như trước: lưu lại sẽ tạo khách thứ hai.
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
const io = vi.hoisted(() => ({ update: vi.fn(), create: vi.fn(), navigate: vi.fn(), params: { id: 'c1' } as { id?: string } }));
vi.mock('react-router-dom', () => ({ useParams: () => io.params, useNavigate: () => io.navigate, Link: ({ children }: { children: unknown }) => children }));
vi.mock('@/components/layout/MainLayout', () => ({ default: ({ children }: { children: unknown }) => children }));
vi.mock('@/components/loading/LoadingState', () => ({ LoadingState: () => null }));
vi.mock('@/components/errors/QueryRegion', () => ({ refetchStartedSources: vi.fn() }));
vi.mock('@/components/customers/CustomerForm', () => ({
  default: ({ onSubmit, isSubmitting }: { onSubmit: (data: unknown) => unknown; isSubmitting: boolean }) => (
    <button type="button" disabled={isSubmitting} onClick={() => { void onSubmit({ full_name: 'An', vehicles: [{ vehicle_type: 'CAR', license_plate: '51F-222.22' }] }); }}>Lưu</button>
  ),
}));
vi.mock('@/hooks/useCustomers', () => ({
  useCustomer: () => ({ data: { id: 'c1', full_name: 'An', customer_type: 'INDIVIDUAL', phone: '0900000001', is_foreign: false }, isLoading: false, isError: false }),
  useCreateCustomer: () => ({ mutateAsync: io.create, isPending: false }),
  useUpdateCustomer: () => ({ mutateAsync: io.update, isPending: false }),
}));
vi.mock('@/hooks/useVehicles', () => ({ useVehicles: () => ({ data: { data: [] }, isLoading: false, isError: false }) }));
import CustomerFormPage from '../CustomerFormPage';
import { FinancialWorkflowError } from '@/lib/financialWorkflow';

afterEach(() => { cleanup(); vi.resetAllMocks(); io.params = { id: 'c1' }; });
const vehicleError = () => new FinancialWorkflowError('Khách hàng đã cập nhật nhưng phương tiện chưa đồng bộ xong.', 'partial', [{ id: 'c1', label: 'Đã cập nhật khách hàng' }]);

it('sửa khách, xe chưa xong: báo, form không khoá, lưu lại đồng bộ tiếp rồi về danh sách', async () => {
  io.update.mockResolvedValueOnce({ customer: { id: 'c1', full_name: 'An' }, vehicleError: vehicleError() }).mockResolvedValueOnce({ customer: { id: 'c1', full_name: 'An' } });
  render(<CustomerFormPage />);
  fireEvent.click(screen.getByRole('button', { name: 'Lưu' }));
  await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('c1'));
  expect(io.navigate).not.toHaveBeenCalled();
  const again = screen.getByRole('button', { name: 'Lưu' });
  expect((again as HTMLButtonElement).disabled).toBe(false);
  fireEvent.click(again);
  await waitFor(() => expect(io.navigate).toHaveBeenCalledWith('/customers'));
  expect(io.update).toHaveBeenCalledTimes(2);
});

it('tạo khách, xe chưa xong: form vẫn khoá (lưu lại sẽ tạo khách thứ hai)', async () => {
  io.params = {};
  io.create.mockResolvedValueOnce({ customer: { id: 'c9', full_name: 'Bình' }, vehicleError: vehicleError() });
  render(<CustomerFormPage />);
  fireEvent.click(screen.getByRole('button', { name: 'Lưu' }));
  await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('c9'));
  expect((screen.getByRole('button', { name: 'Lưu' }) as HTMLButtonElement).disabled).toBe(true);
  expect(io.create).toHaveBeenCalledTimes(1);
});
