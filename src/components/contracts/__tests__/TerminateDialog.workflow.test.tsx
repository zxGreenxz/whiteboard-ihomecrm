// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ContractWithRelations } from '@/types/contract';

const spies = vi.hoisted(() => ({ confirm: vi.fn(), finalize: vi.fn(), invoices: vi.fn(), credit: vi.fn() }));
const meters = vi.hoisted(() => ({ data: [], isPending: false, isError: false }));
const transfers = vi.hoisted(() => ({ data: [] as unknown[], isPending: false, isError: false, finalize: vi.fn() }));
vi.mock('@/hooks/contracts/useContractTransferLinks', () => ({
  useContractTransferLinks: () => transfers,
  useFinalizeContractTransferExit: () => ({ mutateAsync: transfers.finalize, isPending: false }),
}));
vi.mock('@/hooks/useMeters', () => ({ useMeters: () => meters }));
vi.mock('@/hooks/useContractExitCases', () => ({
  useConfirmContractReturn: () => ({ mutateAsync: spies.confirm, isPending: false }),
  useFinalizeContractExitCase: () => ({ mutateAsync: spies.finalize, isPending: false }),
}));
vi.mock('@/hooks/useContracts', () => ({ useUnpaidInvoices: (id?: string) => { spies.invoices(id); return { data: [] }; } }));
vi.mock('@/hooks/useInvoices', () => ({ useExcessAmount: (id?: string) => { spies.credit(id); return { data: 0 }; } }));
vi.mock('@/hooks/useAccounts', () => ({ useAccounts: () => ({ data: [] }) }));
vi.mock('../TerminationExtraCharges', () => ({ TerminationExtraCharges: () => null }));
vi.mock('../TerminationRefundItems', () => ({ TerminationRefundItems: () => null }));
import { TerminateDialog } from '../TerminateDialog';

const contract = { id: 'a1111111-1111-4111-8111-111111111111', updated_at: '2026-09-27T03:00:00.123456+00:00',
  room_id: 'b1111111-1111-4111-8111-111111111111',
  status: 'ACTIVE', start_date: '2026-01-01', end_date: '2026-12-31', expected_move_out_date: null,
  contract_customers: [], total_deposit: 4_000_000, deposit_paid: 4_000_000,
} as ContractWithRelations;
beforeEach(() => { vi.clearAllMocks(); transfers.data=[]; spies.confirm.mockResolvedValue({ state: 'PENDING' }); });
afterEach(cleanup);

describe('thanh lý tách bước trả phòng', () => {
  it('phí nhượng chưa xác định giữ hồ sơ mở và báo rõ, không vỡ form', () => {
    transfers.data=[{id:'c1111111-1111-4111-8111-111111111111',state:'LINKED',mode:'BROKER',broker_fee:null,deposit_base:null,version:1}];
    render(<TerminateDialog open onOpenChange={vi.fn()} contract={contract} exitCase={{id:'d1111111-1111-4111-8111-111111111111',current_kind:'EARLY_RETURN',initial_kind:'EARLY_RETURN',actual_move_out_on:'2026-09-28',version:1,state:'PENDING',kind_history:[]} as import('@/lib/contractExitCases').ContractExitCase} />);
    expect(screen.getByText(/Chưa xác định được phí nhượng hợp lệ/)).toBeTruthy();
    expect(screen.getByRole('button',{name:/Tiếp tục quyết toán/}).hasAttribute('disabled')).toBe(true);
  });
  it('phí nhượng hiện riêng đúng 50% cọc và nằm trong bản xem trước', () => {
    transfers.data=[{id:'c1111111-1111-4111-8111-111111111111',state:'LINKED',mode:'BROKER',broker_fee:2_000_000,deposit_base:4_000_000,version:1}];
    render(<TerminateDialog open onOpenChange={vi.fn()} contract={contract} exitCase={{id:'d1111111-1111-4111-8111-111111111111',current_kind:'EARLY_RETURN',initial_kind:'EARLY_RETURN',actual_move_out_on:'2026-09-28',version:1,state:'PENDING',kind_history:[]} as import('@/lib/contractExitCases').ContractExitCase} />);
    fireEvent.click(screen.getByRole('button',{name:/Tiếp tục quyết toán/}));
    expect(screen.getByText(/Phí nhượng qua môi giới · 50% cọc cũ/)).toBeTruthy();
    expect(screen.getByText(/2.000.000 đ/, {selector:'strong'})).toBeTruthy();
    expect(spies.finalize).not.toHaveBeenCalled();
    expect(transfers.finalize).not.toHaveBeenCalled();
  });
  it('nhánh quyết toán sau chỉ gửi ngày/loại/phiên bản, không mở form tiền', async () => {
    const close = vi.fn();
    render(<TerminateDialog open onOpenChange={close} contract={contract} />);
    expect(spies.invoices.mock.calls.every(([id]) => id === undefined)).toBe(true);
    expect(spies.credit.mock.calls.every(([id]) => id === undefined)).toBe(true);
    fireEvent.change(screen.getByLabelText(/Ngày khách thực tế trả phòng/), { target: { value: '2026-09-28' } });
    fireEvent.click(screen.getByLabelText('Bỏ cọc'));
    fireEvent.click(screen.getByRole('button', { name: 'Trả phòng, quyết toán sau' }));
    await waitFor(() => expect(close).toHaveBeenCalledWith(false));
    expect(spies.confirm).toHaveBeenCalledOnce();
    const request = spies.confirm.mock.calls[0][0];
    expect(request).toEqual({ contractId: contract.id, expectedContractUpdatedAt: contract.updated_at,
      actualMoveOutOn: '2026-09-28', initialKind: 'FORFEIT', settlementMode: 'DEFERRED', idempotencyKey: expect.any(String),
      meterBoundary: { state: 'MISSING', reason: expect.any(String) } });
    expect('settlement' in request).toBe(false);
    expect(spies.finalize).not.toHaveBeenCalled();
    expect(spies.invoices.mock.calls.every(([id]) => id === undefined)).toBe(true);
  });
  it('bấm lại cùng ý định sau lỗi dùng lại mã yêu cầu, giữ form để sửa', async () => {
    spies.confirm.mockRejectedValue(new Error('Mất kết nối'));
    const close = vi.fn();
    render(<TerminateDialog open onOpenChange={close} contract={contract} />);
    fireEvent.click(screen.getByLabelText('Hết hạn hợp đồng'));
    const save = screen.getByRole('button', { name: 'Trả phòng, quyết toán sau' });
    fireEvent.click(save);
    await waitFor(() => expect(spies.confirm).toHaveBeenCalledTimes(1));
    fireEvent.click(save);
    await waitFor(() => expect(spies.confirm).toHaveBeenCalledTimes(2));
    expect(spies.confirm.mock.calls[0][0].idempotencyKey).toBe(spies.confirm.mock.calls[1][0].idempotencyKey);
    expect(close).not.toHaveBeenCalled();
  });
});
