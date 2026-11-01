// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ContractWithRelations } from '@/types/contract';
import type { ContractExitCase } from '@/lib/contractExitCases';
import type { ExitSettlementDraft, ExtraChargesDraft, RefundItemsDraft } from '@/lib/contractExitSettlementDrafts';

const spies = vi.hoisted(() => ({ finalize: vi.fn(), save: vi.fn(), discard: vi.fn(), refetch: vi.fn(), extraProps: [] as Record<string, unknown>[], refundProps: [] as Record<string, unknown>[] }));
const drafts = vi.hoisted(() => ({ data: null as ExitSettlementDraft | null, isPending: false, isError: false }));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('@/hooks/contracts/useContractTransferLinks', () => ({
  useContractTransferLinks: () => ({ data: [], isPending: false, isError: false }),
  useFinalizeContractTransferExit: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));
vi.mock('@/hooks/useContractExitCases', () => ({
  useConfirmContractReturn: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useFinalizeContractExitCase: () => ({ mutateAsync: spies.finalize, isPending: false }),
}));
vi.mock('@/hooks/useContractExitSettlementDrafts', () => ({
  useContractExitSettlementDraft: () => ({ data: drafts.data, isPending: drafts.isPending, isError: drafts.isError, isSuccess: !drafts.isPending && !drafts.isError,
    isFetching: false, isFetchedAfterMount: !drafts.isPending, refetch: spies.refetch }),
  useSaveContractExitSettlementDraft: () => ({ mutateAsync: spies.save, isPending: false }),
  useDiscardContractExitSettlementDraft: () => ({ mutateAsync: spies.discard, isPending: false }),
}));
vi.mock('@/hooks/useContracts', () => ({ useUnpaidInvoices: () => ({ data: [], isError: false, isPending: false }) }));
vi.mock('@/hooks/useInvoices', () => ({ useExcessAmount: () => ({ data: 0, isError: false, isPending: false }) }));
const accounts = vi.hoisted(() => ({ data: [] as { id: string; name: string; is_virtual: boolean }[], isSuccess: false }));
vi.mock('@/hooks/useAccounts', () => ({ useAccounts: () => accounts }));
const extra: ExtraChargesDraft = { fromDate: '2026-10-01', toDate: '2026-10-03', proratedAmount: 300_000, proratedTouched: true, cleaningAmount: 150_000,
  customRows: [{ name: 'Sửa khoá', amount: 80_000 }], meter: { meterId: '11111111-1111-4111-8111-000000000004', currentReading: 3950 } };
const refund: RefundItemsDraft = { fromDate: '2026-10-04', toDate: '2026-10-31', proratedAmount: 3_948_000, proratedTouched: false, customRows: [] };
vi.mock('../TerminationExtraCharges', async () => {
  const React = await import('react');
  return { TerminationExtraCharges: (props: { onValidityChange?: (valid: boolean) => void; onDraftChange?: (draft: ExtraChargesDraft) => void }) => {
    spies.extraProps.push(props as Record<string, unknown>);
    React.useEffect(() => { props.onValidityChange?.(true); }, [props.onValidityChange]);
    return <button type="button" onClick={() => props.onDraftChange?.(extra)}>gõ khoản thu thêm</button>;
  } };
});
vi.mock('../TerminationRefundItems', () => ({ TerminationRefundItems: (props: { onDraftChange?: (draft: RefundItemsDraft) => void }) => {
  spies.refundProps.push(props as Record<string, unknown>);
  return <button type="button" onClick={() => props.onDraftChange?.(refund)}>gõ khoản hoàn</button>;
} }));
import { TerminateDialog } from '../TerminateDialog';

const contract = { id: 'a1111111-1111-4111-8111-111111111111', updated_at: '2026-09-27T03:00:00.123456+00:00', room_id: 'b1111111-1111-4111-8111-111111111111',
  status: 'TERMINATED', start_date: '2026-01-01', end_date: '2026-12-31', contract_customers: [], total_deposit: 4_000_000, deposit_paid: 4_000_000,
} as unknown as ContractWithRelations;
const caseId = 'd1111111-1111-4111-8111-111111111111';
const exitCase = { id: caseId, current_kind: 'EARLY_RETURN', initial_kind: 'EARLY_RETURN', actual_move_out_on: '2026-10-03', version: 2, state: 'PENDING',
  kind_history: [], return_note: 'Khách trả sớm.' } as unknown as ContractExitCase;
const saved = (payload: ExitSettlementDraft['payload'], version = 3): ExitSettlementDraft =>
  ({ caseId, version, updatedAt: '2026-10-30T03:45:00Z', updatedByName: 'Người A', payload });
const lastExtra = () => spies.extraProps[spies.extraProps.length - 1];
const lastRefund = () => spies.refundProps[spies.refundProps.length - 1];
beforeEach(() => {
  vi.clearAllMocks(); spies.extraProps.length = 0; spies.refundProps.length = 0; drafts.data = null; drafts.isPending = false; drafts.isError = false; accounts.data = []; accounts.isSuccess = false;
  spies.save.mockImplementation(async (input: { payload: unknown }) => saved(input.payload as ExitSettlementDraft['payload']));
});
afterEach(cleanup);

describe('lưu nháp ở bước quyết toán', () => {
  it('lưu đủ loại, cọc hoàn, khoản thu/hoàn và ghi chú; không quyết toán; hồ sơ vẫn chờ', async () => {
    const close = vi.fn();
    render(<TerminateDialog open onOpenChange={close} contract={contract} exitCase={exitCase} />);
    fireEvent.click(screen.getByRole('button', { name: 'Tiếp tục quyết toán' }));
    fireEvent.click(screen.getByRole('button', { name: 'gõ khoản thu thêm' }));
    fireEvent.click(screen.getByRole('button', { name: 'gõ khoản hoàn' }));
    fireEvent.change(screen.getByPlaceholderText('Ghi chú thanh lý...'), { target: { value: 'Khách hẹn chuyển khoản tối nay' } });
    fireEvent.click(screen.getByRole('button', { name: 'Lưu nháp' }));
    await waitFor(() => expect(close).toHaveBeenCalledWith(false));
    expect(spies.save).toHaveBeenCalledWith({ caseId, expectedVersion: null, payload: { schema: 1, kind: 'EARLY_RETURN', changeReason: '', extra, refund,
      moveOut: { depositRefund: 4_000_000, excessRent: 0, notes: 'Khách hẹn chuyển khoản tối nay', shortfallMode: 'PAID', receiptAccountId: '' } } });
    expect(spies.finalize).not.toHaveBeenCalled();
  });

  it('mở bản nháp bỏ cọc: vào thẳng bước quyết toán, điền lại khoản thu thêm, điện không bắt buộc; lưu tiếp ghi đè đúng version', async () => {
    drafts.data = saved({ schema: 1, kind: 'FORFEIT', changeReason: 'Khách báo bỏ cọc', extra, refund: null, moveOut: null });
    render(<TerminateDialog open onOpenChange={vi.fn()} contract={contract} exitCase={exitCase} resumeDraft />);
    await waitFor(() => expect(screen.getByText('Quyết toán — Khách bỏ cọc')).toBeTruthy());
    expect(screen.getByTestId('exit-draft-banner').textContent).toContain('Đang mở bản nháp lưu lúc');
    expect(screen.getByTestId('exit-draft-banner').textContent).toContain('bởi Người A');
    expect(lastExtra()).toMatchObject({ initialDraft: extra, meterOptional: true });
    fireEvent.click(screen.getByRole('button', { name: 'Lưu nháp' }));
    await waitFor(() => expect(spies.save).toHaveBeenCalledOnce());
    expect(spies.save.mock.calls[0][0]).toMatchObject({ expectedVersion: 3, payload: { kind: 'FORFEIT', changeReason: 'Khách báo bỏ cọc', extra } });
  });

  it('mở bản nháp rời phòng: cọc hoàn, ghi chú và khoản hoàn hiện đúng số đã lưu', async () => {
    drafts.data = saved({ schema: 1, kind: 'EARLY_RETURN', changeReason: '', extra, refund,
      moveOut: { depositRefund: 3_000_000, excessRent: 0, notes: 'Đã trừ tiền vệ sinh', shortfallMode: 'DEBT', receiptAccountId: '' } });
    render(<TerminateDialog open onOpenChange={vi.fn()} contract={contract} exitCase={exitCase} resumeDraft />);
    await waitFor(() => expect(screen.getByText('Quyết toán — Khách rời phòng')).toBeTruthy());
    expect((screen.getByPlaceholderText('Ghi chú thanh lý...') as HTMLTextAreaElement).value).toBe('Đã trừ tiền vệ sinh');
    expect((screen.getByLabelText('Tiền cọc hoàn trả') as HTMLInputElement).value).toBe('3.000.000');
    expect(lastExtra()).toMatchObject({ initialDraft: extra });
    expect(lastExtra().meterOptional).toBeFalsy();
    expect(lastRefund()).toMatchObject({ initialDraft: refund });
  });

  it('sổ nhận tiền trong nháp không có trong danh sách sổ của người mở thì về "Tự chọn"; có thì giữ', async () => {
    const book = 'a2222222-2222-4222-8222-222222222222';
    const moveOut = { depositRefund: 0, excessRent: 0, notes: '', shortfallMode: 'PAID' as const, receiptAccountId: book };
    drafts.data = saved({ schema: 1, kind: 'EARLY_RETURN', changeReason: '', extra: null, refund: null, moveOut });
    accounts.isSuccess = true;
    const view = render(<TerminateDialog open onOpenChange={vi.fn()} contract={contract} exitCase={exitCase} resumeDraft />);
    await waitFor(() => expect(screen.getByText('Quyết toán — Khách rời phòng')).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: 'Lưu nháp' }));
    await waitFor(() => expect(spies.save).toHaveBeenCalledOnce());
    expect(spies.save.mock.calls[0][0].payload.moveOut.receiptAccountId).toBe('');
    view.unmount(); spies.save.mockClear();
    accounts.data = [{ id: book, name: 'Sổ thu toà', is_virtual: false }];
    render(<TerminateDialog open onOpenChange={vi.fn()} contract={contract} exitCase={exitCase} resumeDraft />);
    await waitFor(() => expect(screen.getByText('Quyết toán — Khách rời phòng')).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: 'Lưu nháp' }));
    await waitFor(() => expect(spies.save).toHaveBeenCalledOnce());
    expect(spies.save.mock.calls[0][0].payload.moveOut.receiptAccountId).toBe(book);
  });

  it('nháp đổi loại mà thiếu lý do thì dừng ở bước 1 để nhập lý do', async () => {
    drafts.data = saved({ schema: 1, kind: 'FORFEIT', changeReason: '', extra: null, refund: null, moveOut: null });
    render(<TerminateDialog open onOpenChange={vi.fn()} contract={contract} exitCase={exitCase} resumeDraft />);
    await waitFor(() => expect(screen.getByLabelText(/Lý do đổi loại thanh lý/)).toBeTruthy());
    expect((screen.getByLabelText('Bỏ cọc') as HTMLInputElement).checked).toBe(true);
  });

  it('chờ đọc nháp xong mới hiện form, không cho điền vào form trống rồi bị ghi đè', () => {
    drafts.isPending = true;
    render(<TerminateDialog open onOpenChange={vi.fn()} contract={contract} exitCase={exitCase} resumeDraft />);
    expect(screen.queryByRole('button', { name: 'Tiếp tục quyết toán' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Lưu nháp' })).toBeNull();
  });

  it('quay lại bước 1 rồi tiếp tục vẫn giữ số đang điền', async () => {
    render(<TerminateDialog open onOpenChange={vi.fn()} contract={contract} exitCase={exitCase} />);
    fireEvent.click(screen.getByRole('button', { name: 'Tiếp tục quyết toán' }));
    fireEvent.click(screen.getByRole('button', { name: 'gõ khoản thu thêm' }));
    fireEvent.change(screen.getByPlaceholderText('Ghi chú thanh lý...'), { target: { value: 'Giữ lại' } });
    fireEvent.click(screen.getByRole('button', { name: 'Quay lại' }));
    fireEvent.click(screen.getByRole('button', { name: 'Tiếp tục quyết toán' }));
    expect((screen.getByPlaceholderText('Ghi chú thanh lý...') as HTMLTextAreaElement).value).toBe('Giữ lại');
    expect(lastExtra()).toMatchObject({ initialDraft: extra });
  });

  it('người khác vừa lưu (PT409): hỏi ghi đè, ghi đè dùng version mới nhất', async () => {
    spies.save.mockRejectedValueOnce({ code: 'PT409', message: 'Settlement draft changed; reload' });
    spies.refetch.mockImplementation(async () => { drafts.data = { ...saved(null, 5), updatedByName: 'Người B' }; });
    const close = vi.fn();
    render(<TerminateDialog open onOpenChange={close} contract={contract} exitCase={exitCase} />);
    fireEvent.click(screen.getByRole('button', { name: 'Tiếp tục quyết toán' }));
    fireEvent.click(screen.getByRole('button', { name: 'Lưu nháp' }));
    const dialog = await screen.findByRole('alertdialog');
    expect(dialog.textContent).toContain('bởi Người B');
    expect(close).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Ghi đè nháp' }));
    await waitFor(() => expect(spies.save).toHaveBeenCalledTimes(2));
    expect(spies.save.mock.calls[1][0]).toMatchObject({ expectedVersion: 5 });
    await waitFor(() => expect(close).toHaveBeenCalledWith(false));
  });

  it('bấm Quyết toán (mở mới) khi đã có nháp: báo sẽ thay bản đó, form trống, lưu dùng version nháp đang có', async () => {
    drafts.data = saved({ schema: 1, kind: 'FORFEIT', changeReason: 'x', extra, refund: null, moveOut: null }, 2);
    render(<TerminateDialog open onOpenChange={vi.fn()} contract={contract} exitCase={exitCase} />);
    expect(screen.getByTestId('exit-draft-banner').textContent).toContain('Bấm Lưu nháp sẽ thay bản đó');
    fireEvent.click(screen.getByRole('button', { name: 'Tiếp tục quyết toán' }));
    expect(screen.getByText('Quyết toán — Khách rời phòng')).toBeTruthy();
    expect(lastExtra().initialDraft).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Lưu nháp' }));
    await waitFor(() => expect(spies.save).toHaveBeenCalledOnce());
    expect(spies.save.mock.calls[0][0]).toMatchObject({ expectedVersion: 2, payload: { kind: 'EARLY_RETURN', extra: null } });
  });

  it('bỏ nháp phải xác nhận rồi bỏ đúng bản đang hiện; hộp thoại vẫn mở, số đang điền còn, lưu lại là tạo nháp mới', async () => {
    drafts.data = saved({ schema: 1, kind: 'EARLY_RETURN', changeReason: '', extra: null, refund: null, moveOut: null }, 4);
    spies.discard.mockImplementation(async () => { drafts.data = null; });
    const close = vi.fn();
    render(<TerminateDialog open onOpenChange={close} contract={contract} exitCase={exitCase} resumeDraft />);
    await waitFor(() => expect(screen.getByText('Quyết toán — Khách rời phòng')).toBeTruthy());
    fireEvent.change(screen.getByPlaceholderText('Ghi chú thanh lý...'), { target: { value: 'Còn giữ sau khi bỏ nháp' } });
    fireEvent.click(within(screen.getByTestId('exit-draft-banner')).getByRole('button', { name: 'Bỏ nháp' }));
    expect(spies.discard).not.toHaveBeenCalled();
    fireEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Bỏ nháp' }));
    await waitFor(() => expect(spies.discard).toHaveBeenCalledWith({ caseId, expectedVersion: 4 }));
    await waitFor(() => expect(screen.queryByTestId('exit-draft-banner')).toBeNull());
    expect(close).not.toHaveBeenCalled();
    expect(screen.queryByText(/Bản nháp không còn/)).toBeNull();
    expect((screen.getByPlaceholderText('Ghi chú thanh lý...') as HTMLTextAreaElement).value).toBe('Còn giữ sau khi bỏ nháp');
    fireEvent.click(screen.getByRole('button', { name: 'Lưu nháp' }));
    await waitFor(() => expect(spies.save).toHaveBeenCalledOnce());
    expect(spies.save.mock.calls[0][0]).toMatchObject({ expectedVersion: null, payload: { moveOut: { notes: 'Còn giữ sau khi bỏ nháp' } } });
  });

  it('người khác lưu sau khi mình mở (dữ liệu sống đổi): vẫn lưu theo version form đang dựa vào để máy chủ báo xung đột', async () => {
    drafts.data = saved({ schema: 1, kind: 'EARLY_RETURN', changeReason: '', extra: null, refund: null, moveOut: null }, 2);
    const view = render(<TerminateDialog open onOpenChange={vi.fn()} contract={contract} exitCase={exitCase} />);
    fireEvent.click(screen.getByRole('button', { name: 'Tiếp tục quyết toán' }));
    drafts.data = { ...saved(null, 9), updatedByName: 'Người B' };
    view.rerender(<TerminateDialog open onOpenChange={vi.fn()} contract={contract} exitCase={exitCase} />);
    fireEvent.click(screen.getByRole('button', { name: 'Lưu nháp' }));
    await waitFor(() => expect(spies.save).toHaveBeenCalledOnce());
    expect(spies.save.mock.calls[0][0]).toMatchObject({ expectedVersion: 2 });
  });

  it('đổi từ rời phòng sang bỏ cọc: mở form bỏ cọc mới, nháp bỏ cọc không mang cọc hoàn / hoàn lại khách', async () => {
    drafts.data = saved({ schema: 1, kind: 'EARLY_RETURN', changeReason: '', extra, refund,
      moveOut: { depositRefund: 3_000_000, excessRent: 0, notes: 'x', shortfallMode: 'PAID', receiptAccountId: '' } });
    render(<TerminateDialog open onOpenChange={vi.fn()} contract={contract} exitCase={exitCase} resumeDraft />);
    await waitFor(() => expect(screen.getByText('Quyết toán — Khách rời phòng')).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: 'Quay lại' }));
    fireEvent.click(screen.getByLabelText('Bỏ cọc'));
    fireEvent.change(screen.getByLabelText(/Lý do đổi loại thanh lý/), { target: { value: 'Khách không nhận lại cọc' } });
    fireEvent.click(screen.getByRole('button', { name: 'Tiếp tục quyết toán' }));
    expect(screen.getByText('Quyết toán — Khách bỏ cọc')).toBeTruthy();
    expect(lastExtra().initialDraft).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Lưu nháp' }));
    await waitFor(() => expect(spies.save).toHaveBeenCalledOnce());
    expect(spies.save.mock.calls[0][0].payload).toEqual({ schema: 1, kind: 'FORFEIT', changeReason: 'Khách không nhận lại cọc', extra: null, refund: null, moveOut: null });
  });

  it('nháp bỏ cọc mà payload còn mục rời phòng (bản cũ): lưu lại chỉ giữ khoản thu thêm', async () => {
    drafts.data = saved({ schema: 1, kind: 'FORFEIT', changeReason: 'Khách bỏ cọc', extra, refund,
      moveOut: { depositRefund: 3_000_000, excessRent: 0, notes: 'x', shortfallMode: 'PAID', receiptAccountId: '' } });
    render(<TerminateDialog open onOpenChange={vi.fn()} contract={contract} exitCase={exitCase} resumeDraft />);
    await waitFor(() => expect(screen.getByText('Quyết toán — Khách bỏ cọc')).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: 'Lưu nháp' }));
    await waitFor(() => expect(spies.save).toHaveBeenCalledOnce());
    expect(spies.save.mock.calls[0][0].payload).toEqual({ schema: 1, kind: 'FORFEIT', changeReason: 'Khách bỏ cọc', extra, refund: null, moveOut: null });
  });

  it('đọc nháp lỗi: không điền từ bản cũ trong cache, báo lỗi và khoá Lưu nháp', async () => {
    drafts.isError = true;
    drafts.data = saved({ schema: 1, kind: 'FORFEIT', changeReason: 'cũ', extra, refund: null, moveOut: null });
    render(<TerminateDialog open onOpenChange={vi.fn()} contract={contract} exitCase={exitCase} resumeDraft />);
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('Không tải được bản nháp'));
    fireEvent.click(screen.getByRole('button', { name: 'Tiếp tục quyết toán' }));
    expect(screen.getByText('Quyết toán — Khách rời phòng')).toBeTruthy();
    expect(lastExtra().initialDraft).toBeNull();
    expect(screen.getByRole('button', { name: 'Lưu nháp' }).hasAttribute('disabled')).toBe(true);
  });

  it('mở nháp mà lần đọc đầu lỗi, đọc lại sau mới được: form vẫn trống nên lưu là tạo mới (máy chủ sẽ hỏi trước khi thay nháp của người khác)', async () => {
    drafts.isError = true;
    const view = render(<TerminateDialog open onOpenChange={vi.fn()} contract={contract} exitCase={exitCase} resumeDraft />);
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('Không tải được bản nháp'));
    drafts.isError = false;
    drafts.data = { ...saved({ schema: 1, kind: 'FORFEIT', changeReason: 'của B', extra, refund: null, moveOut: null }, 7), updatedByName: 'Người B' };
    view.rerender(<TerminateDialog open onOpenChange={vi.fn()} contract={contract} exitCase={exitCase} resumeDraft />);
    expect(screen.getByTestId('exit-draft-banner').textContent).toContain('chưa có trong form này');
    fireEvent.click(screen.getByRole('button', { name: 'Tiếp tục quyết toán' }));
    expect(lastExtra().initialDraft).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Lưu nháp' }));
    await waitFor(() => expect(spies.save).toHaveBeenCalledOnce());
    expect(spies.save.mock.calls[0][0]).toMatchObject({ expectedVersion: null, payload: { kind: 'EARLY_RETURN' } });
  });

  it('thanh lý mới (chưa có hồ sơ): quay lại bước 1 thì bước quyết toán dựng lại theo ngày mới, không giữ số theo ngày cũ', () => {
    render(<TerminateDialog open onOpenChange={vi.fn()} contract={{ ...contract, status: 'ACTIVE' } as ContractWithRelations} />);
    fireEvent.click(screen.getByLabelText('Hết hạn hợp đồng'));
    fireEvent.click(screen.getByRole('button', { name: 'Dùng nội dung mẫu' }));
    fireEvent.click(screen.getByRole('button', { name: 'Tiếp tục quyết toán ngay' }));
    fireEvent.click(screen.getByRole('button', { name: 'gõ khoản thu thêm' }));
    fireEvent.click(screen.getByRole('button', { name: 'Quay lại' }));
    fireEvent.change(screen.getByLabelText(/Ngày khách thực tế trả phòng/), { target: { value: '2026-10-15' } });
    fireEvent.click(screen.getByRole('button', { name: 'Tiếp tục quyết toán ngay' }));
    expect(lastExtra().initialDraft).toBeNull();
    expect(lastRefund().initialDraft).toBeNull();
  });

  it('nháp không đọc được thì mở form mới và nói rõ', () => {
    drafts.data = saved(null, 7);
    render(<TerminateDialog open onOpenChange={vi.fn()} contract={contract} exitCase={exitCase} resumeDraft />);
    expect(screen.getByTestId('exit-draft-banner').textContent).toContain('không đọc được');
    expect(screen.getByRole('button', { name: 'Tiếp tục quyết toán' })).toBeTruthy();
  });

  it('quyết toán ngay từ hợp đồng chưa có hồ sơ: không có nút Lưu nháp', () => {
    render(<TerminateDialog open onOpenChange={vi.fn()} contract={{ ...contract, status: 'ACTIVE' } as ContractWithRelations} />);
    fireEvent.click(screen.getByLabelText('Hết hạn hợp đồng'));
    fireEvent.click(screen.getByRole('button', { name: 'Dùng nội dung mẫu' }));
    fireEvent.click(screen.getByRole('button', { name: 'Tiếp tục quyết toán ngay' }));
    expect(screen.getByText('Quyết toán — Khách rời phòng')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Lưu nháp' })).toBeNull();
  });
});
