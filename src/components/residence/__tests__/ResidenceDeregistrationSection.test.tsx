// @vitest-environment jsdom
// Khối "Huỷ đăng ký tạm trú": thu gọn mặc định, không tải gì khi chưa mở; mở ra thì
// có hai ảnh CT01 huỷ + biên bản, không có ô thời hạn, và sổ chỉ hiện lượt xoá.
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';

const io = vi.hoisted(() => ({ queryOptions: [] as Array<{ enabled?: boolean }>, filesFor: [] as Array<string | undefined>, ghi: vi.fn() }));
const ready = (data: unknown) => ({ data, status: 'success', fetchStatus: 'idle', isLoading: false, isError: false, error: null, refetch: vi.fn() });
const idle = { data: undefined, status: 'pending', fetchStatus: 'idle', isLoading: false, isError: false, error: null, refetch: vi.fn() };
const tenancy = {
  roomId: 'r1', roomNumber: '401', contractId: 'ct1', contractStatus: 'TERMINATED', endDate: '2026-10-05',
  building: { id: 'b1', name: '32PVC', organization_id: 'o1', street_address: '32/28/4 Phạm Văn Chiêu, Khu Phố 21, Phường Thông Tây Hội, TP. Hồ Chí Minh', ward: 'Phường 8', district: '', province: 'Hồ Chí Minh' },
};
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('@tanstack/react-query', () => ({
  useQuery: (options: { enabled?: boolean }) => { io.queryOptions.push(options); return options.enabled ? ready([tenancy]) : idle; },
}));
vi.mock('@/hooks/useResidenceDossierFiles', () => ({
  useCustomerDossierFiles: (id?: string) => { io.filesFor.push(id); return id ? ready([]) : idle; },
  useDossierFileMutations: () => ({ upload: { mutateAsync: vi.fn() }, remove: { mutateAsync: vi.fn() } }),
}));
vi.mock('@/hooks/useResidenceRegistrations', () => ({
  useCustomerRegistrations: (id?: string) => (id ? ready([
    { id: 'x', procedure_code: 'TAMTRU_06', subm_code: 'G01.899.909-261008-000123', submitted_at: '2026-10-08T02:00:00Z', receive_org: '', temp_resident_from: null, temp_resident_to: null },
    { id: 'd', procedure_code: 'TAMTRU_01', subm_code: 'G01.899.909-260916-890028', submitted_at: '2026-09-16T02:00:00Z', receive_org: '', temp_resident_from: '2026-09-16', temp_resident_to: '2028-09-14' },
  ]) : idle),
  useGhiHoSoTamTru: () => ({ mutateAsync: io.ghi, isPending: false }),
}));
vi.mock('../DossierImageUploader', () => ({ default: ({ kind }: { kind: string }) => <div data-testid={`anh-${kind}`} /> }));
vi.mock('../CT01HuyDownloadButton', () => ({ default: () => <button type="button">Tải CT01+BBTL</button> }));
vi.mock('../TamTruXoaDvcButton', () => ({ default: () => <button type="button">Huỷ đăng ký tạm trú trên DVC</button> }));
vi.mock('../RegistrationManualEntry', () => ({
  default: ({ onGhi }: { onGhi: (code: string) => unknown }) => <button type="button" onClick={() => { void onGhi('G01.899.909-261008-000999'); }}>Ghi mã</button>,
}));
import ResidenceDeregistrationSection from '../ResidenceDeregistrationSection';

afterEach(() => { cleanup(); io.queryOptions.length = 0; io.filesFor.length = 0; io.ghi.mockReset(); });
const customer = { id: 'u1', full_name: 'Lê Quốc Duy' } as never;

it('thu gọn mặc định và không tải dữ liệu nào khi chưa mở', () => {
  render(<ResidenceDeregistrationSection customer={customer} />);
  const toggle = screen.getByRole('button', { name: /Huỷ đăng ký tạm trú/ });
  expect(toggle.getAttribute('aria-expanded')).toBe('false');
  expect(screen.queryByTestId('anh-CT01_XOA')).toBeNull();
  expect(io.queryOptions.every(o => o.enabled === false)).toBe(true);
  expect(io.filesFor.every(id => id === undefined)).toBe(true);
});

it('mở ra: hai ảnh huỷ, nút tải giấy và gửi DVC, không có ô thời hạn, sổ chỉ hiện lượt xoá', () => {
  render(<ResidenceDeregistrationSection customer={customer} />);
  fireEvent.click(screen.getByRole('button', { name: /Huỷ đăng ký tạm trú \(Cổng DVC/ }));
  expect(screen.getByRole('button', { name: /Huỷ đăng ký tạm trú \(Cổng DVC/ }).getAttribute('aria-expanded')).toBe('true');
  expect(screen.getByTestId('anh-CT01_XOA')).toBeTruthy();
  expect(screen.getByTestId('anh-THANH_LY')).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Tải CT01+BBTL' })).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Huỷ đăng ký tạm trú trên DVC' })).toBeTruthy();
  expect(screen.queryByLabelText('Thời hạn tạm trú')).toBeNull();
  expect(screen.getByText(/05\/10\/2026 \(theo hợp đồng\)/)).toBeTruthy();
  expect(screen.getByText('Đã huỷ tạm trú')).toBeTruthy();
  expect(screen.getByText('G01.899.909-261008-000123')).toBeTruthy();
  expect(screen.queryByText('G01.899.909-260916-890028')).toBeNull();
  expect(io.queryOptions.at(-1)?.enabled).toBe(true);
});

it('ghi tay mã hồ sơ xoá thì ghi đúng thủ tục TAMTRU_06, không thành đăng ký', () => {
  render(<ResidenceDeregistrationSection customer={customer} />);
  fireEvent.click(screen.getByRole('button', { name: /Huỷ đăng ký tạm trú \(Cổng DVC/ }));
  fireEvent.click(screen.getByRole('button', { name: 'Ghi mã' }));
  expect(io.ghi).toHaveBeenCalledWith(expect.objectContaining({
    customerId: 'u1', buildingId: 'b1', organizationId: 'o1', contractId: 'ct1',
    submCode: 'G01.899.909-261008-000999', procedureCode: 'TAMTRU_06',
  }));
});
