// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ContractCommissionFollowup, CommissionFollowupFilter } from '@/lib/contractCommissionFollowup';

const mocks = vi.hoisted(() => ({
  query: { data: undefined as { rows: ContractCommissionFollowup[]; total: number } | undefined, isPending: false, isError: false, refetch: vi.fn() },
  filters: [] as CommissionFollowupFilter[], record: vi.fn(), isPending: false,
}));
vi.mock('@/hooks/useContractCommissionFollowup', () => ({
  useContractCommissionFollowups: (filter: CommissionFollowupFilter) => { mocks.filters.push(filter); return mocks.query; },
  useRecordContractCommissionEvent: () => ({ mutateAsync: mocks.record, isPending: mocks.isPending }),
}));
vi.mock('@/contexts/OrganizationContext', () => ({ useOrganization: () => ({ selectedOrganizationId: 'org-1' }) }));
vi.mock('@/components/contracts/CommissionVoucherModal', () => ({
  CommissionVoucherModal: ({ open, contractId, onOpenChange }: { open: boolean; contractId: string; onOpenChange: (open: boolean) => void }) =>
    open ? <div role="dialog" aria-label="Tạo phiếu hoa hồng">{contractId}<button onClick={() => onOpenChange(false)}>Đóng popup</button></div> : null,
}));
import { ContractCommissionFollowupPanel } from '../ContractCommissionFollowupPanel';

const row = (overrides: Partial<ContractCommissionFollowup> = {}): ContractCommissionFollowup => ({
  contract_id: 'contract-1', contract_number: 'HD-001', building_id: 'building-1', building_name: 'Toà A', room_name: '101',
  kind: 'broker', state: 'PENDING', last_reason: null, last_actor: null, last_at: null, attempted_amount: null,
  voucher_id: null, voucher_code: null, voucher_status: null, can_manage: true, events: [], ...overrides,
});
beforeEach(() => { vi.clearAllMocks(); mocks.filters = []; mocks.isPending = false; mocks.query.isPending = false;
  mocks.query.isError = false; mocks.query.data = { rows: [row()], total: 1 }; mocks.record.mockResolvedValue(undefined); });
afterEach(cleanup);

describe('commission follow-up panel', () => {
  it('keeps broker and sale separate and never presents voucher approval as payment', () => {
    mocks.query.data = { rows: [row({ state: 'UNKNOWN' }), row({ kind: 'sale', state: 'VOUCHER_CREATED', voucher_id: 'voucher-1', voucher_code: 'PC-001', voucher_status: 'APPROVED' })], total: 2 };
    render(<ContractCommissionFollowupPanel contractId="contract-1" />);
    expect(screen.getByText('Hoa hồng môi giới')).toBeTruthy(); expect(screen.getByText('Thưởng Sale')).toBeTruthy();
    expect(screen.getByText('Chưa rõ kết quả tạo phiếu')).toBeTruthy(); expect(screen.getByText(/Đối chiếu phiếu.*trước khi tiếp tục/)).toBeTruthy();
    expect(screen.getByText(/PC-001/)).toBeTruthy(); expect(screen.getByText('Đã duyệt')).toBeTruthy();
    expect(screen.queryByText(/^Đã chi/)).toBeNull();
  });
  it('shows a read failure instead of treating stale or absent data as no work', () => {
    mocks.query.isError = true; render(<ContractCommissionFollowupPanel />);
    expect(screen.getByRole('alert').textContent).toMatch(/Không tải được/);
    expect(screen.queryByText(/0 khoản/)).toBeNull(); expect(screen.queryByText(/HD-001/)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Thử lại' })); expect(mocks.query.refetch).toHaveBeenCalledOnce();
  });
  it('uses the server total while collapsed and paginates within the selected building scope', async () => {
    mocks.query.data = { rows: [row()], total: 25 };
    const { rerender } = render(<ContractCommissionFollowupPanel buildingIds={['building-1']} />);
    expect(screen.getByText('25 khoản cần kiểm tra')).toBeTruthy(); expect(screen.queryByText(/HD-001/)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /Hoa hồng và thưởng Sale/ }));
    expect(screen.getByText(/HD-001/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Trang sau' }));
    expect(mocks.filters.at(-1)).toMatchObject({ page: 1, buildingIds: ['building-1'], unresolvedOnly: true });
    rerender(<ContractCommissionFollowupPanel buildingIds={['building-2']} />);
    await waitFor(() => expect(mocks.filters.at(-1)).toMatchObject({ page: 0, buildingIds: ['building-2'] }));
  });
  it('requires a reason and persists the selected kind before closing a no-obligation decision', async () => {
    render(<ContractCommissionFollowupPanel contractId="contract-1" />);
    fireEvent.click(screen.getByRole('button', { name: 'Không phát sinh' }));
    const dialog = screen.getByRole('dialog', { name: /Không phát sinh/ });
    const save = within(dialog).getByRole('button', { name: 'Lưu quyết định' });
    expect(save.hasAttribute('disabled')).toBe(true);
    fireEvent.change(within(dialog).getByLabelText('Lý do'), { target: { value: '  Khách tự tìm phòng  ' } });
    fireEvent.click(save);
    await waitFor(() => expect(mocks.record).toHaveBeenCalledWith({ contractId: 'contract-1', kind: 'broker', action: 'NOT_APPLICABLE', reason: 'Khách tự tìm phòng' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });
  it('preserves the decision and shows a save error so a failed write cannot appear complete', async () => {
    mocks.record.mockRejectedValue(new Error('database unavailable'));
    render(<ContractCommissionFollowupPanel contractId="contract-1" />);
    fireEvent.click(screen.getByRole('button', { name: 'Không phát sinh' }));
    fireEvent.change(screen.getByLabelText('Lý do'), { target: { value: 'Tự tìm phòng' } });
    fireEvent.click(screen.getByRole('button', { name: 'Lưu quyết định' }));
    await screen.findByText(/Chưa lưu được quyết định/);
    expect((screen.getByLabelText('Lý do') as HTMLTextAreaElement).value).toBe('Tự tìm phòng');
  });
  it('resumes the selected contract and closing the popup records no implicit decision', async () => {
    render(<ContractCommissionFollowupPanel contractId="contract-1" />);
    fireEvent.click(screen.getByRole('button', { name: 'Tiếp tục xử lý' }));
    const dialog = await screen.findByRole('dialog', { name: 'Tạo phiếu hoa hồng' }); expect(dialog.textContent).toContain('contract-1');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Đóng popup' })); expect(mocks.record).not.toHaveBeenCalled();
    expect(screen.getByText('Chưa xử lý')).toBeTruthy();
  });
  it('shows recorded history and can reopen a no-obligation decision', async () => {
    mocks.query.data = { rows: [row({ state: 'NOT_APPLICABLE', last_reason: 'Khách tự tìm phòng', last_actor: 'Lan', last_at: '2026-09-29T10:00:00Z',
      events: [{ action: 'NOT_APPLICABLE', reason: 'Khách tự tìm phòng', amount: null, actor_name: 'Lan', created_at: '2026-09-29T10:00:00Z' }] })], total: 1 };
    render(<ContractCommissionFollowupPanel contractId="contract-1" />);
    fireEvent.click(screen.getByText(/Lịch sử/)); expect(screen.getAllByText(/Khách tự tìm phòng/).length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole('button', { name: 'Mở lại để kiểm tra' }));
    await waitFor(() => expect(mocks.record).toHaveBeenCalledWith({ contractId: 'contract-1', kind: 'broker', action: 'REOPENED' }));
  });
  it('hides write actions when the returned building capability does not allow management', () => {
    mocks.query.data = { rows: [row({ can_manage: false })], total: 1 };
    render(<ContractCommissionFollowupPanel contractId="contract-1" />);
    expect(screen.getByText('Chưa xử lý')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Tiếp tục xử lý' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Không phát sinh' })).toBeNull();
  });
});
