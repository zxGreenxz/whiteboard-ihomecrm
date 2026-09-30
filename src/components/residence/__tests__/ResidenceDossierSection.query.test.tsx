// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';

const io = vi.hoisted(() => ({ files: vi.fn(), retry: vi.fn(), save:vi.fn() }));
const ready = (data: unknown) => ({ data, status: 'success', fetchStatus: 'idle', isLoading: false, isError: false, error: null, refetch: io.retry });
vi.mock('@tanstack/react-query', () => ({ useQuery: () => ready([{ roomId: 'r1', contractId: 'c1', roomNumber: '1', building: { id: 'b1', name: 'Tòa 1', organization_id: 'o1' } }]) }));
vi.mock('@/hooks/useMyPermissions', () => ({ useMyPermissions: () => ({ data: {} }) }));
vi.mock('@/lib/permissionPages', () => ({ canUse: () => true }));
vi.mock('@/hooks/useResidenceDossierFiles', () => ({
  useCustomerDossierFiles: () => io.files(),
  useBuildingOwnershipFiles: () => ready([]),
  useDossierFileMutations: () => ({ upload: { mutateAsync: vi.fn() }, remove: { mutateAsync: vi.fn() }, luuHan: { mutateAsync: io.save } }),
}));
vi.mock('@/hooks/useLeaseTermOcr', () => ({ useLeaseTermOcr: () => ({ han: null, trangThai: 'khong-doc-duoc', docLai: vi.fn() }) }));
vi.mock('@/hooks/useResidenceRegistrations', () => ({ useCustomerRegistrations: () => ready([]), useGhiHoSoTamTru: () => ({ mutateAsync: vi.fn(), isPending: false }) }));
vi.mock('@/components/customers/CT01DownloadButton', () => ({ default: () => <button>Tải CT01</button> }));
vi.mock('../TamTruDvcButton', () => ({ default: () => <button>Gửi DVC</button> }));
vi.mock('../DossierImageUploader', () => ({ default: () => null }));
vi.mock('../LeaseTermBadge', () => ({ default: () => null }));
vi.mock('../RegistrationManualEntry', () => ({ default: () => null }));
vi.mock('../RegistrationHistory', () => ({ default: () => null }));
import {FinancialWorkflowError} from '@/lib/financialWorkflow';
import ResidenceDossierSection from '../ResidenceDossierSection';

afterEach(()=>{cleanup();vi.resetAllMocks();});
it('lỗi đọc ảnh hồ sơ chặn CT01 và DVC, cho tải lại', () => {
  io.files.mockReturnValue({ data: undefined, status: 'error', fetchStatus: 'idle', isLoading: false, isError: true, error: new Error('offline'), refetch: io.retry });
  render(<ResidenceDossierSection customer={{ id: 'u1', full_name: 'Khách' } as never} />);
  expect(screen.getByRole('alert').textContent).toContain('Chưa tải được hồ sơ tạm trú');
  expect(screen.queryByRole('button', { name: 'Gửi DVC' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Tải CT01' })).toBeNull();
  expect(screen.getByRole('button', { name: 'Tải lại' })).toBeTruthy();
});

it('đổi thời hạn bất định giữ giá trị cũ và ID ảnh, không ghi lại',async()=>{
  io.files.mockReturnValue(ready([{id:'lease1',kind:'LEASE',contract_id:'c1',created_at:'2026-09-30'}]));io.save.mockRejectedValue(new FinancialWorkflowError('Chưa xác nhận hạn hợp đồng.','unknown',[{id:'lease1',label:'Ảnh cần đối chiếu'}]));
  render(<ResidenceDossierSection customer={{id:'u1',full_name:'Khách'} as never}/>);await screen.findByLabelText('Thời hạn tạm trú');fireEvent.change(screen.getByLabelText('Thời hạn tạm trú'),{target:{value:'12'}});
  await waitFor(()=>expect(screen.getByRole('alert').textContent).toContain('lease1'));expect((screen.getByLabelText('Thời hạn tạm trú') as HTMLSelectElement).value).toBe('24');fireEvent.change(screen.getByLabelText('Thời hạn tạm trú'),{target:{value:'12'}});expect(io.save).toHaveBeenCalledTimes(1);
});
