// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { ContractWithRelations } from '@/types/contract';
import { CT01InputError } from '@/lib/ct01Document';
import { PrintContractDialog } from '../PrintContractDialog';

const spy = vi.hoisted(() => ({
  canPrintCustomers: true,
  bundle: vi.fn(),
  downloadContract: vi.fn(),
  downloadWord: vi.fn(),
  success: vi.fn(),
  warning: vi.fn(),
  error: vi.fn(),
}));

vi.mock('sonner', () => ({ toast: { success: spy.success, warning: spy.warning, error: spy.error } }));
vi.mock('@/hooks/useDocumentTemplates', () => ({ useDocumentTemplatesByType: () => ({ data: [
  { id: 't-1', name: 'HĐ Hiệp 3K9', file_name: 'hd.docx', file_url: 'tpl/hd.docx', is_default: true, is_active: true },
], isLoading: false }) }));
vi.mock('@/hooks/useContractRentSupport', () => ({ useContractRentSupport: () => ({ data: undefined, isPending: false, isError: false }) }));
vi.mock('@/hooks/useMyPermissions', () => ({ useMyPermissions: () => ({ data: {} }) }));
vi.mock('@/lib/permissionPages', () => ({
  canUse: (_permissions: unknown, page: string, action: string) => page === 'customers' && action === 'print' ? spy.canPrintCustomers : true,
}));
vi.mock('@/lib/contractTemplateEngine', () => ({
  buildContractTemplateData: () => ({}),
  renderContractDocx: async () => new Blob(['hop-dong']),
  downloadDocxBlob: spy.downloadContract,
}));
vi.mock('@/integrations/supabase/client', () => ({ supabase: { from: () => {
  const chain = { select: () => chain, in: () => chain, is: () => Promise.resolve({ data: [], error: null }) };
  return chain;
} } }));
vi.mock('@/lib/ct01RoomBundle', () => ({ buildCT01RoomBundle: spy.bundle }));
vi.mock('@/lib/ct01Document', async importOriginal => ({
  ...(await importOriginal<typeof import('@/lib/ct01Document')>()),
  downloadWordBlob: spy.downloadWord,
}));

const contract = {
  id: 'k-1', contract_number: 'HD-2026-00381', discounts: null,
  room: { id: 'r-1', name: '201', building_id: 'b-1', building: { id: 'b-1', name: '44TL', type: 'APARTMENT' } },
  contract_customers: [
    { id: 'cc-1', contract_id: 'k-1', customer_id: 'c-1', is_representative: false, notes: null, created_at: '', updated_at: '', customer: { id: 'c-1', full_name: 'Nguyễn Văn An', phone: '', email: null, id_number: null } },
    { id: 'cc-2', contract_id: 'k-1', customer_id: 'c-2', is_representative: true, notes: null, created_at: '', updated_at: '', customer: { id: 'c-2', full_name: 'Chúng Mẫu Hoa', phone: '', email: null, id_number: null } },
  ],
} as unknown as ContractWithRelations;

beforeEach(() => {
  spy.canPrintCustomers = true;
  for (const fn of [spy.bundle, spy.downloadContract, spy.downloadWord, spy.success, spy.warning, spy.error]) fn.mockReset();
  spy.bundle.mockResolvedValue({ blob: new Blob(['ct01']), included: ['Chúng Mẫu Hoa', 'Nguyễn Văn An'], skipped: [] });
});
afterEach(cleanup);

const download = () => fireEvent.click(screen.getByRole('button', { name: 'Tải xuống .docx' }));

it('mặc định tải hợp đồng kèm một tệp CT01 + HĐ ở nhờ cho mọi khách trong phòng', async () => {
  const onOpenChange = vi.fn();
  render(<PrintContractDialog open onOpenChange={onOpenChange} contract={contract} />);
  expect(screen.getByText(/Kèm tệp CT01 \+ HĐ ở nhờ cho 2 khách trong phòng/)).toBeTruthy();
  fireEvent.change(screen.getByRole('combobox', { name: 'Thời hạn tạm trú' }), { target: { value: '12' } });
  download();
  await waitFor(() => expect(spy.downloadWord).toHaveBeenCalledTimes(1));
  expect(spy.bundle).toHaveBeenCalledWith({
    buildingId: 'b-1', roomNumber: '201', durationMonths: 12,
    members: [
      { customerId: 'c-1', isRepresentative: false, fallbackName: 'Nguyễn Văn An' },
      { customerId: 'c-2', isRepresentative: true, fallbackName: 'Chúng Mẫu Hoa' },
    ],
  });
  expect(spy.downloadContract).toHaveBeenCalledWith(expect.any(Blob), 'HĐ Hiệp 3K9_HD-2026-00381');
  expect(spy.downloadWord).toHaveBeenCalledWith(expect.any(Blob), 'CT01 + HĐ ở nhờ_HD-2026-00381.docx');
  expect(spy.success).toHaveBeenCalledWith('Đã tải hợp đồng và tệp CT01 + HĐ ở nhờ của 2 khách');
  expect(spy.warning).not.toHaveBeenCalled();
  expect(onOpenChange).toHaveBeenCalledWith(false);
});

it('hai tệp đặt tên cùng một cách khi mã hợp đồng có ký tự cấm', async () => {
  render(<PrintContractDialog open onOpenChange={vi.fn()} contract={{ ...contract, contract_number: 'HĐT-093855/05032026' }} />);
  download();
  await waitFor(() => expect(spy.downloadWord).toHaveBeenCalledWith(expect.any(Blob), 'CT01 + HĐ ở nhờ_HĐT-093855_05032026.docx'));
  expect(spy.downloadContract).toHaveBeenCalledWith(expect.any(Blob), 'HĐ Hiệp 3K9_HĐT-093855_05032026');
});

it('bỏ chọn thì chỉ tải hợp đồng', async () => {
  render(<PrintContractDialog open onOpenChange={vi.fn()} contract={contract} />);
  fireEvent.click(screen.getByRole('checkbox'));
  expect(screen.queryByRole('combobox', { name: 'Thời hạn tạm trú' })).toBeNull();
  download();
  await waitFor(() => expect(spy.downloadContract).toHaveBeenCalledTimes(1));
  expect(spy.bundle).not.toHaveBeenCalled();
  expect(spy.downloadWord).not.toHaveBeenCalled();
});

it('tệp CT01 lỗi vẫn tải hợp đồng và báo đúng lý do', async () => {
  spy.bundle.mockRejectedValue(new CT01InputError('Tòa nhà chưa có thông tin người đứng tên chủ quyền.'));
  render(<PrintContractDialog open onOpenChange={vi.fn()} contract={contract} />);
  download();
  await waitFor(() => expect(spy.warning).toHaveBeenCalledWith('Đã tải hợp đồng, chưa tạo được tệp CT01',
    expect.objectContaining({ description: 'Tòa nhà chưa có thông tin người đứng tên chủ quyền.' })));
  expect(spy.downloadContract).toHaveBeenCalledTimes(1);
  expect(spy.downloadWord).not.toHaveBeenCalled();
  expect(spy.error).not.toHaveBeenCalled();
});

it('nêu tên khách bị thiếu trong tệp CT01', async () => {
  spy.bundle.mockResolvedValue({ blob: new Blob(['ct01']), included: ['Chúng Mẫu Hoa'], skipped: [{ name: 'Nguyễn Văn An', reason: 'Số định danh sai.' }] });
  render(<PrintContractDialog open onOpenChange={vi.fn()} contract={contract} />);
  download();
  await waitFor(() => expect(spy.warning).toHaveBeenCalledWith('Tệp CT01 còn thiếu 1 khách',
    expect.objectContaining({ description: 'Nguyễn Văn An: Số định danh sai.' })));
  expect(spy.downloadWord).toHaveBeenCalledTimes(1);
});

it('không có quyền in hồ sơ khách thì không hiện lựa chọn và không dựng CT01', async () => {
  spy.canPrintCustomers = false;
  render(<PrintContractDialog open onOpenChange={vi.fn()} contract={contract} />);
  expect(screen.queryByText(/Kèm tệp CT01/)).toBeNull();
  download();
  await waitFor(() => expect(spy.downloadContract).toHaveBeenCalledTimes(1));
  expect(spy.bundle).not.toHaveBeenCalled();
});
