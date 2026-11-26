// @vitest-environment jsdom
// Đợt 8 (luật 5): hộp lưu cổ đông và hộp lưu quản lý điều hành không khoá nút Lưu sau một lần chưa rõ kết quả. Hồ sơ
// sửa theo mã, tỷ lệ toà đặt cả bộ (duy nhất theo toà × cổ đông), quy tắc lương xoá rồi chèn lại cả bộ: bấm lại ghi lại
// đúng nội dung đó. Hồ sơ vừa tạo ở lượt trước của chính hộp này thì lần bấm sau SỬA hồ sơ đó, không tạo thêm.
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { seedLegacyPending, pendingKeys } from '@/hooks/__tests__/fakeRecordServer';

const m = vi.hoisted(() => ({ save: vi.fn(), create: vi.fn(), update: vi.fn(), sync: vi.fn(), rules: [] as unknown[] }));
const q = (data: unknown[] = []) => ({ data, status: 'success', fetchStatus: 'idle', isLoading: false, isError: false, error: null, refetch: vi.fn() });
vi.mock('@/lib/authSession', () => ({ getSessionUser: async () => ({ id: 'u' }) }));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));
vi.mock('@/hooks/useAdminUsers', () => ({ useAdminUsers: () => q([{ id: 'u', full_name: 'An' }]) }));
vi.mock('@/hooks/useBuildings', () => ({ useBuildings: () => q([{ id: 'b1', name: 'Toà 1' }]) }));
vi.mock('@/hooks/useAreas', () => ({ useAreas: () => q() }));
vi.mock('@/hooks/useProfitManagers', () => ({
  PROFIT_MANAGER_SAVED_STEP: 'Đã lưu hồ sơ quản lý',
  useProfitManagers: () => q(), useManagerSalaries: () => q(m.rules), useSaveManagerWithSalaries: () => ({ mutateAsync: m.save, isPending: false }),
}));
vi.mock('@/hooks/useShareholders', () => ({
  useShareholders: () => q(), useBuildingShareholders: () => q(),
  useCreateShareholder: () => ({ mutateAsync: m.create, isPending: false }), useUpdateShareholder: () => ({ mutateAsync: m.update, isPending: false }), useSyncShareholderBuildings: () => ({ mutateAsync: m.sync, isPending: false }),
}));
vi.mock('@/components/buildings/BuildingMultiSelect', () => ({ BuildingMultiSelect: ({ onChange }: { onChange: (ids: string[]) => void }) => <button type="button" onClick={() => onChange(['b1'])}>Chọn nhà</button> }));
// Ô chọn tài khoản thay bằng select gốc để chọn được trong jsdom.
vi.mock('@/components/ui/searchable-select', () => ({
  SearchableSelect: ({ options, value, onValueChange, name }: { options: { value: string; label: ReactNode }[]; value?: string; onValueChange: (value: string) => void; name?: string }) => (
    <select name={name} aria-label={name ?? 'chọn'} value={value} onChange={event => onValueChange(event.target.value)}>
      <option value="">Chưa chọn</option>
      {options.map(option => <option key={option.value} value={option.value}>{String(option.label)}</option>)}
    </select>
  ),
}));

import ShareholderForm from '../ShareholderForm';
import ProfitManagerForm from '../ProfitManagerForm';
import { FinancialWorkflowError, RepeatableWriteUnknownError } from '@/lib/financialWorkflow';

const shareholder = { id: 's1', name: 'An', auth_user_id: 'u', note: null, is_active: true } as never;
const manager = { id: 'm1', name: 'An', auth_user_id: 'u', note: null, is_active: true } as never;
const saveButton = () => screen.getByRole('button', { name: 'Lưu' }) as HTMLButtonElement;
const chooseAccount = () => fireEvent.change(document.querySelector('select[name="authUserId"]') as HTMLSelectElement, { target: { value: 'u' } });

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem('ihomecrm.selectedOrganizationId', 'org-a');
  m.rules = [];
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
});
afterEach(() => { cleanup(); vi.clearAllMocks(); vi.unstubAllGlobals(); });

it('cổ đông: tỷ lệ toà chưa rõ kết quả ⇒ báo rõ kèm mã hồ sơ, nút Lưu không khoá, bấm lại ghi lại cả hai bước', async () => {
  m.update.mockResolvedValue(undefined);
  m.sync.mockRejectedValueOnce(new RepeatableWriteUnknownError('lưu tỷ lệ cổ đông')).mockResolvedValueOnce(undefined);
  const close = vi.fn();
  render(<ShareholderForm open onOpenChange={close} shareholder={shareholder} />);
  fireEvent.click(saveButton());
  await screen.findByText('s1');
  expect(screen.getByRole('alert').textContent).toContain('Lưu lại');
  expect(saveButton().disabled).toBe(false);
  fireEvent.click(saveButton());
  await waitFor(() => expect(close).toHaveBeenCalledWith(false));
  expect(m.update).toHaveBeenCalledTimes(2);
  expect(m.sync).toHaveBeenCalledTimes(2);
});

it('cổ đông mới: hồ sơ đã tạo mà tỷ lệ chưa xong ⇒ lần bấm sau sửa đúng hồ sơ vừa tạo, không tạo thêm', async () => {
  m.create.mockResolvedValue({ id: 's-new' });
  m.update.mockResolvedValue(undefined);
  m.sync.mockRejectedValueOnce(new RepeatableWriteUnknownError('lưu tỷ lệ cổ đông')).mockResolvedValueOnce(undefined);
  const close = vi.fn();
  render(<ShareholderForm open onOpenChange={close} shareholder={null} />);
  chooseAccount();
  fireEvent.click(saveButton());
  await screen.findByText('s-new');
  expect(saveButton().disabled).toBe(false);
  fireEvent.click(saveButton());
  await waitFor(() => expect(close).toHaveBeenCalledWith(false));
  expect(m.create).toHaveBeenCalledTimes(1);
  expect(m.update).toHaveBeenCalledWith(expect.objectContaining({ id: 's-new' }));
  expect(m.sync).toHaveBeenLastCalledWith({ shareholder_id: 's-new', rows: [] });
});

it('cổ đông: dấu lồng bản trước (shareholder-save) không chặn; lưu xong thì gỡ', async () => {
  seedLegacyPending({ namespace: 'shareholder-save', userId: 'u', organizationId: 'org-a', businessKey: 's1' }, new Date(Date.now() - 10 * 60_000));
  m.update.mockResolvedValue(undefined);
  m.sync.mockResolvedValue(undefined);
  const close = vi.fn();
  render(<ShareholderForm open onOpenChange={close} shareholder={shareholder} />);
  fireEvent.click(saveButton());
  await waitFor(() => expect(close).toHaveBeenCalledWith(false));
  await waitFor(() => expect(pendingKeys()).toEqual([]));
});

it('quản lý: lần lưu chưa rõ kết quả ⇒ nút Lưu không khoá, bấm lại gửi lại', async () => {
  m.rules = [{ id: 'r1', manager_id: 'm1', label: 'Lương', form: 'FIXED', basis: 'PER_BUILDING', amount: 100, percent: 0, is_active: true, building_ids: ['b1'] }];
  m.save.mockRejectedValueOnce(new RepeatableWriteUnknownError('lưu quản lý và lương điều hành', undefined, [{ id: 'm1', label: 'Đã lưu hồ sơ quản lý' }])).mockResolvedValueOnce({ managerId: 'm1' });
  const close = vi.fn();
  render(<ProfitManagerForm open onOpenChange={close} manager={manager} />);
  fireEvent.click(saveButton());
  await screen.findByRole('alert');
  expect(saveButton().disabled).toBe(false);
  fireEvent.click(saveButton());
  await waitFor(() => expect(close).toHaveBeenCalledWith(false));
  expect(m.save).toHaveBeenCalledTimes(2);
  expect(m.save.mock.calls[1]![0]).toMatchObject({ id: 'm1' });
});

it('quản lý mới: hồ sơ đã tạo mà quy tắc lương bị từ chối ⇒ lần bấm sau sửa đúng hồ sơ vừa tạo', async () => {
  m.save.mockRejectedValueOnce(new FinancialWorkflowError('Đã lưu hồ sơ quản lý nhưng chưa ghi đủ quy tắc lương. Bấm Lưu lại.', 'failure', [{ id: 'm-new', label: 'Đã lưu hồ sơ quản lý' }])).mockResolvedValueOnce({ managerId: 'm-new' });
  const close = vi.fn();
  render(<ProfitManagerForm open onOpenChange={close} manager={null} />);
  chooseAccount();
  fireEvent.click(screen.getByRole('button', { name: 'Chọn nhà' }));
  fireEvent.click(saveButton());
  await screen.findByText('m-new');
  expect(m.save.mock.calls[0]![0]).toMatchObject({ id: undefined });
  expect(saveButton().disabled).toBe(false);
  fireEvent.click(saveButton());
  await waitFor(() => expect(close).toHaveBeenCalledWith(false));
  expect(m.save.mock.calls[1]![0]).toMatchObject({ id: 'm-new' });
});
