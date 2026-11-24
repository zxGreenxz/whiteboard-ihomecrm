// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ContractWithRelations } from '@/types/contract';

const spies = vi.hoisted(() => ({ confirm: vi.fn(), finalize: vi.fn(), invoices: vi.fn(), credit: vi.fn(), updateKind: vi.fn() }));
const finance = vi.hoisted(() => ({ invoiceError: false, creditError: false }));
const meterValidity = vi.hoisted(() => ({ valid: true }));
const meters = vi.hoisted(() => ({ data: [], isPending: false, isError: false }));
const early = vi.hoisted(() => ({ data: [] as unknown[], isPending: false, isError: false, refetch: vi.fn(),
  setTerms: vi.fn(), updateFee: vi.fn(), createCommission: vi.fn() }));
vi.mock('@/hooks/contracts/useContractExitEarlyTerms', () => ({
  useContractExitEarlyTerms: () => early,
  useSetContractExitEarlyTerms: () => ({ mutateAsync: early.setTerms, isPending: false }),
  useUpdateContractExitBrokerFee: () => ({ mutateAsync: early.updateFee, isPending: false }),
  useCreateContractExitCommission: () => ({ mutateAsync: early.createCommission, isPending: false }),
  useReverseContractExitSupport: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));
vi.mock('@/hooks/useMyPermissions', () => ({ useMyPermissions: () => ({ data: { __superadmin: true } }) }));
vi.mock('@/hooks/useMeters', () => ({ useMeters: () => meters }));
vi.mock('@/hooks/useContractExitSettlementDrafts', () => ({
  useContractExitSettlementDraft: () => ({ data: null, isPending: false, isError: false, isSuccess: true, isFetching: false, isFetchedAfterMount: true, refetch: vi.fn() }),
  useSaveContractExitSettlementDraft: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useDiscardContractExitSettlementDraft: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));
vi.mock('@/hooks/useContractExitCases', () => ({
  useConfirmContractReturn: () => ({ mutateAsync: spies.confirm, isPending: false }),
  useFinalizeContractExitCase: () => ({ mutateAsync: spies.finalize, isPending: false }),
  useUpdateContractExitKind: () => ({ mutateAsync: spies.updateKind, isPending: false }),
}));
vi.mock('@/hooks/useContracts', () => ({ useUnpaidInvoices: (id?: string) => { spies.invoices(id); return { data: finance.invoiceError ? undefined : [], isError: finance.invoiceError }; } }));
vi.mock('@/hooks/useInvoices', () => ({ useExcessAmount: (id?: string) => { spies.credit(id); return { data: finance.creditError ? undefined : 0, isError: finance.creditError }; } }));
vi.mock('@/hooks/useAccounts', () => ({ useAccounts: () => ({ data: [] }) }));
vi.mock('../TerminationExtraCharges', async () => {
  const React = await import('react');
  return { TerminationExtraCharges: ({ onValidityChange }: { onValidityChange?: (valid: boolean) => void }) => {
    React.useEffect(() => { onValidityChange?.(meterValidity.valid); }, [onValidityChange]); return null;
  } };
});
vi.mock('../TerminationRefundItems', () => ({ TerminationRefundItems: () => null }));
import { TerminateDialog } from '../TerminateDialog';
import { exitTermsRow, linkedExitTermsRow, EXIT_FIXTURE_IDS } from './exitEarlyTermsFixture';
const landlordRow = () => exitTermsRow({ early_reason: 'LANDLORD_AGREEMENT', sale_name: null, broker_fee: 0, hold_until: null, pending_link: false, hold_open: false });

const contract = { id: 'a1111111-1111-4111-8111-111111111111', updated_at: '2026-09-27T03:00:00.123456+00:00',
  room_id: 'b1111111-1111-4111-8111-111111111111',
  status: 'ACTIVE', start_date: '2026-01-01', end_date: '2026-12-31', expected_move_out_date: null,
  contract_customers: [], total_deposit: 4_000_000, deposit_paid: 4_000_000,
} as ContractWithRelations;
beforeEach(() => { vi.clearAllMocks(); meterValidity.valid=true; early.data=[]; early.isPending=false; early.isError=false; finance.invoiceError=false; finance.creditError=false; spies.confirm.mockResolvedValue({ state: 'PENDING' }); });
afterEach(cleanup);

describe('thanh lý tách bước trả phòng', () => {
  it('cho đối chiếu và chọn cả phần cọc dư giữ lại sau chuyển phòng', async () => {
    render(<TerminateDialog open onOpenChange={vi.fn()} contract={{ ...contract, total_deposit: 2_000_000, deposit_paid: 4_000_000 }} />);
    fireEvent.click(screen.getByLabelText('Hết hạn hợp đồng'));
    fireEvent.click(screen.getByRole('button', { name: 'Dùng nội dung mẫu' }));
    fireEvent.click(screen.getByRole('button', { name: 'Tiếp tục quyết toán ngay' }));
    const field = await screen.findByLabelText('Tiền cọc hoàn trả');
    expect(screen.getByText(/Sổ cọc ghi nhận cao hơn mức thỏa thuận/)).toBeTruthy();
    expect((field as HTMLInputElement).value).toBe('2.000.000');
    fireEvent.change(field,{target:{value:'4000000'}});
    expect((field as HTMLInputElement).value).toBe('4.000.000');
  });

  it('không mở quyết toán tiền khi truy vấn công nợ hoặc credit lỗi', () => {
    finance.invoiceError = true;
    finance.creditError = true;
    early.data = [landlordRow()];
    render(<TerminateDialog open onOpenChange={vi.fn()} contract={contract} exitCase={{id:'d1111111-1111-4111-8111-111111111111',current_kind:'EARLY_RETURN',initial_kind:'EARLY_RETURN',actual_move_out_on:'2026-09-28',version:1,state:'PENDING',kind_history:[]} as import('@/lib/contractExitCases').ContractExitCase} />);
    fireEvent.click(screen.getByRole('button', { name: /Tiếp tục quyết toán/ }));
    expect(screen.getByText(/Không tải được công nợ và số dư khách hàng/)).toBeTruthy();
    expect(screen.queryByText(/Tổng công nợ chưa thu/)).toBeNull();
    expect(spies.finalize).not.toHaveBeenCalled();
  });
  it('hồ sơ trước hạn chưa có trường hợp (Hermes): bắt chọn trước khi quyết toán, lưu với phiên bản 0 và lý do', async () => {
    render(<TerminateDialog open onOpenChange={vi.fn()} contract={contract} exitCase={{id:EXIT_FIXTURE_IDS.exitCase,current_kind:'EARLY_RETURN',initial_kind:'EARLY_RETURN',actual_move_out_on:'2026-12-01',version:1,state:'PENDING',kind_history:[]} as import('@/lib/contractExitCases').ContractExitCase} />);
    expect(screen.getByText(/Hồ sơ chưa chọn trường hợp trả phòng trước hạn/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Tiếp tục quyết toán' }).hasAttribute('disabled')).toBe(true);
    fireEvent.click(screen.getByLabelText('Chủ nhà hỗ trợ thanh lý sớm'));
    fireEvent.change(screen.getByLabelText(/Ghi chú khi chọn trường hợp/), { target: { value: ' Chủ nhà đồng ý ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Lưu trường hợp' }));
    await waitFor(() => expect(early.setTerms).toHaveBeenCalledOnce());
    expect(early.setTerms.mock.calls[0][0]).toMatchObject({ caseId: EXIT_FIXTURE_IDS.exitCase, expectedVersion: 0,
      earlyReason: 'LANDLORD_AGREEMENT', saleName: null, reason: 'Chủ nhà đồng ý', requestId: expect.any(String) });
    expect(spies.finalize).not.toHaveBeenCalled();
  });
  it('hồ sơ ghi "Hết hạn" mà quyết toán thành trước hạn: ghi loại trước (kèm lý do) rồi mới chọn trường hợp', async () => {
    early.data = [];
    render(<TerminateDialog open onOpenChange={vi.fn()} contract={contract} exitCase={{id:EXIT_FIXTURE_IDS.exitCase,current_kind:'NATURAL_EXPIRY',initial_kind:'NATURAL_EXPIRY',actual_move_out_on:'2026-12-01',version:3,state:'PENDING',kind_history:[]} as import('@/lib/contractExitCases').ContractExitCase} />);
    fireEvent.click(screen.getByLabelText('Trả phòng trước hạn'));
    const record = screen.getByRole('button', { name: 'Ghi loại Trả phòng trước hạn' });
    expect(record.hasAttribute('disabled')).toBe(true);
    expect(screen.queryByLabelText('Chủ nhà hỗ trợ thanh lý sớm')).toBeNull();
    fireEvent.change(screen.getByLabelText(/Lý do đổi loại/), { target: { value: 'Khách báo trả sớm' } });
    fireEvent.click(record);
    await waitFor(() => expect(spies.updateKind).toHaveBeenCalledOnce());
    expect(spies.updateKind.mock.calls[0][0]).toMatchObject({ caseId: EXIT_FIXTURE_IDS.exitCase, expectedVersion: 3, kind: 'EARLY_RETURN',
      reason: 'Khách báo trả sớm', idempotencyKey: expect.any(String) });
  });
  it('đã "Mở bán lại": câu chặn nói rõ hợp đồng mới không tự nối, chỉ đường đổi sang trường hợp 3', () => {
    early.data = [exitTermsRow({ reopened_at: '2026-12-02T03:00:00Z', reopened_by: EXIT_FIXTURE_IDS.actor, hold_open: false, pending_link: false })];
    render(<TerminateDialog open onOpenChange={vi.fn()} contract={contract} exitCase={{id:EXIT_FIXTURE_IDS.exitCase,current_kind:'EARLY_RETURN',initial_kind:'EARLY_RETURN',actual_move_out_on:'2026-12-01',version:1,state:'PENDING',kind_history:[]} as import('@/lib/contractExitCases').ContractExitCase} />);
    const blocked = screen.getByText(/Chưa có hợp đồng của khách nhận phòng/).textContent ?? '';
    expect(blocked).toContain('Phòng đã mở bán lại nên hợp đồng mới không tự nối');
    expect(blocked).not.toContain('hợp đồng sẽ tự nối');
    expect(screen.getByRole('button', { name: 'Đổi sang trường hợp 3' })).toBeTruthy();
  });
  it('nhờ sale chưa có hợp đồng khách nhận: chặn quyết toán, nút "Đổi sang trường hợp 3" mở sẵn lựa chọn', async () => {
    early.data = [exitTermsRow()];
    render(<TerminateDialog open onOpenChange={vi.fn()} contract={contract} exitCase={{id:EXIT_FIXTURE_IDS.exitCase,current_kind:'EARLY_RETURN',initial_kind:'EARLY_RETURN',actual_move_out_on:'2026-12-01',version:1,state:'PENDING',kind_history:[]} as import('@/lib/contractExitCases').ContractExitCase} />);
    expect(screen.getByText(/Chưa có hợp đồng của khách nhận phòng/).textContent).toContain('hợp đồng sẽ tự nối với hồ sơ này');
    expect(screen.getByRole('button', { name: 'Tiếp tục quyết toán' }).hasAttribute('disabled')).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Đổi sang trường hợp 3' }));
    await waitFor(() => expect((screen.getByLabelText('Chủ nhà hỗ trợ thanh lý sớm') as HTMLInputElement).checked).toBe(true));
    fireEvent.change(screen.getByLabelText(/Lý do đổi trường hợp/), { target: { value: 'Khách nhận huỷ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Lưu trường hợp mới' }));
    await waitFor(() => expect(early.setTerms).toHaveBeenCalledOnce());
    expect(early.setTerms.mock.calls[0][0]).toMatchObject({ expectedVersion: 1, earlyReason: 'LANDLORD_AGREEMENT', reason: 'Khách nhận huỷ' });
  });
  it('nhờ sale đã có hợp đồng mới: dòng BROKER_FEE tự có và khoá, cọc hoàn khoá ở cọc đã thu, quyết toán xong mở phiếu hoa hồng', async () => {
    early.data = [linkedExitTermsRow({ new_contract_deposit_paid: 4_000_000, new_contract_total_deposit: 4_000_000 })];
    early.createCommission.mockResolvedValue({});
    spies.finalize.mockResolvedValue({ state: 'FINALIZED' });
    const close = vi.fn();
    render(<TerminateDialog open onOpenChange={close} contract={contract} exitCase={{id:EXIT_FIXTURE_IDS.exitCase,current_kind:'EARLY_RETURN',initial_kind:'EARLY_RETURN',actual_move_out_on:'2026-12-01',version:1,state:'PENDING',kind_history:[]} as import('@/lib/contractExitCases').ContractExitCase} />);
    fireEvent.click(screen.getByRole('button', { name: 'Tiếp tục quyết toán' }));
    expect(screen.getByTestId('broker-fee-line').textContent).toMatch(/Phí môi giới \(50% cọc cũ\): 2\.000\.000 đ/);
    expect(screen.getByRole('button', { name: 'Sửa phí' })).toBeTruthy();
    const refund = screen.getByLabelText('Tiền cọc hoàn trả') as HTMLInputElement;
    expect(refund.disabled).toBe(true);
    expect(refund.value).toBe('4.000.000');
    fireEvent.click(screen.getByRole('button', { name: /Lập hoá đơn & thanh lý/i }));
    fireEvent.click(await screen.findByRole('button', { name: 'Xác nhận thanh lý' }));
    await waitFor(() => expect(spies.finalize).toHaveBeenCalledOnce());
    expect(spies.finalize.mock.calls[0][0]).toMatchObject({ caseId: EXIT_FIXTURE_IDS.exitCase, currentKind: 'EARLY_RETURN',
      settlement: { depositRefund: 4_000_000, extraCharges: [{ kind: 'BROKER_FEE', description: 'Phí môi giới (50% cọc cũ)', amount: 2_000_000 }] } });
    fireEvent.click(await screen.findByRole('button', { name: 'Lập phiếu hoa hồng' }));
    await waitFor(() => expect(early.createCommission).toHaveBeenCalledOnce());
    expect(early.createCommission.mock.calls[0][0]).toMatchObject({ caseId: EXIT_FIXTURE_IDS.exitCase, expectedVersion: 1, requestId: expect.any(String) });
    await waitFor(() => expect(close).toHaveBeenCalledWith(false));
  });
  it('tự tìm đã có hợp đồng mới: không có dòng phí môi giới, quyết toán xong đóng hộp', async () => {
    early.data = [linkedExitTermsRow({ early_reason: 'SELF_FOUND', sale_name: null, broker_fee: 0 })];
    spies.finalize.mockResolvedValue({ state: 'FINALIZED' });
    const close = vi.fn();
    render(<TerminateDialog open onOpenChange={close} contract={contract} exitCase={{id:EXIT_FIXTURE_IDS.exitCase,current_kind:'EARLY_RETURN',initial_kind:'EARLY_RETURN',actual_move_out_on:'2026-12-01',version:1,state:'PENDING',kind_history:[]} as import('@/lib/contractExitCases').ContractExitCase} />);
    fireEvent.click(screen.getByRole('button', { name: 'Tiếp tục quyết toán' }));
    expect(screen.queryByTestId('broker-fee-line')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /Lập hoá đơn & thanh lý/i }));
    fireEvent.click(await screen.findByRole('button', { name: 'Xác nhận thanh lý' }));
    await waitFor(() => expect(close).toHaveBeenCalledWith(false));
    expect(spies.finalize.mock.calls[0][0].settlement.extraCharges).toEqual([]);
    expect(early.createCommission).not.toHaveBeenCalled();
  });
  it('có số khách cũ hỗ trợ: bước 1 hiện số và khoá Đổi trường hợp; quyết toán dùng cọc còn lại, báo đã cấn và ghi vào ghi chú', async () => {
    early.data = [linkedExitTermsRow({ early_reason: 'SELF_FOUND', sale_name: null, broker_fee: 0, support_amount: 1_200_000,
      support_out_code: 'PC2611012', support_in_code: 'PT2611003', old_contract_deposit_paid: 2_800_000 })];
    spies.finalize.mockResolvedValue({ state: 'FINALIZED' });
    render(<TerminateDialog open onOpenChange={vi.fn()} contract={{ ...contract, deposit_paid: 2_800_000 }} exitCase={{id:EXIT_FIXTURE_IDS.exitCase,current_kind:'EARLY_RETURN',initial_kind:'EARLY_RETURN',actual_move_out_on:'2026-12-01',version:1,state:'PENDING',kind_history:[]} as import('@/lib/contractExitCases').ContractExitCase} />);
    expect(screen.getByTestId('exit-support-summary').textContent).toContain('1.200.000 đ');
    expect(screen.getByRole('button', { name: 'Đổi trường hợp' }).hasAttribute('disabled')).toBe(true);
    expect(screen.getByRole('button', { name: 'Đảo số hỗ trợ' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Tiếp tục quyết toán' }));
    expect(screen.getByTestId('exit-support-line').textContent).toContain('Đã cấn sang HD-0202: 1.200.000đ');
    expect((screen.getByLabelText('Tiền cọc hoàn trả') as HTMLInputElement).value).toBe('2.800.000');
    fireEvent.change(screen.getByPlaceholderText('Ghi chú thanh lý...'), { target: { value: 'Bàn giao đủ' } });
    fireEvent.click(screen.getByRole('button', { name: /Lập hoá đơn & thanh lý/i }));
    expect((await screen.findByText('Đã cấn sang cọc hợp đồng khách nhận (khách cũ hỗ trợ)')).parentElement?.textContent).toContain('1.200.000 đ');
    fireEvent.click(screen.getByRole('button', { name: 'Xác nhận thanh lý' }));
    await waitFor(() => expect(spies.finalize).toHaveBeenCalledOnce());
    expect(spies.finalize.mock.calls[0][0].settlement).toMatchObject({ depositRefund: 2_800_000,
      notes: 'Bàn giao đủ\nKhách cũ hỗ trợ khách nhận phòng 1.200.000đ: đã cấn sang cọc hợp đồng mới HD-0202 (phiếu PC2611012 / PT2611003).' });
  });
  it('hồ sơ sang nhượng mà đổi loại khỏi trước hạn thì chặn, chỉ đường đổi trường hợp', () => {
    early.data = [linkedExitTermsRow()];
    render(<TerminateDialog open onOpenChange={vi.fn()} contract={contract} exitCase={{id:EXIT_FIXTURE_IDS.exitCase,current_kind:'EARLY_RETURN',initial_kind:'EARLY_RETURN',actual_move_out_on:'2026-12-01',version:1,state:'PENDING',kind_history:[]} as import('@/lib/contractExitCases').ContractExitCase} />);
    fireEvent.click(screen.getByLabelText('Hết hạn hợp đồng'));
    expect(screen.getByText(/chỉ quyết toán theo "Trả phòng trước hạn"/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Tiếp tục quyết toán' }).hasAttribute('disabled')).toBe(true);
  });
  it('thanh lý mới trước hạn: bắt chọn trường hợp, nhờ sale cần tên sale và chỉ "quyết toán sau"; gửi kèm trường hợp', async () => {
    const close = vi.fn();
    render(<TerminateDialog open onOpenChange={close} contract={contract} />);
    fireEvent.click(screen.getByLabelText('Trả phòng trước hạn'));
    fireEvent.click(screen.getByRole('button', { name: 'Dùng nội dung mẫu' }));
    expect(screen.getByRole('button', { name: 'Trả phòng, quyết toán sau' }).hasAttribute('disabled')).toBe(true);
    fireEvent.click(screen.getByLabelText('Chủ nhà hỗ trợ thanh lý sớm'));
    expect(screen.getByRole('button', { name: 'Tiếp tục quyết toán ngay' })).toBeTruthy();
    fireEvent.click(screen.getByLabelText('Nhờ sale tìm khách sang phòng'));
    expect(screen.queryByRole('button', { name: 'Tiếp tục quyết toán ngay' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Trả phòng, quyết toán sau' }).hasAttribute('disabled')).toBe(true);
    fireEvent.change(screen.getByLabelText(/Tên sale \/ môi giới/), { target: { value: ' Sale Minh ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Trả phòng, quyết toán sau' }));
    await waitFor(() => expect(spies.confirm).toHaveBeenCalledOnce());
    expect(spies.confirm.mock.calls[0][0]).toMatchObject({ initialKind: 'EARLY_RETURN', settlementMode: 'DEFERRED',
      earlyTerms: { earlyReason: 'SALE_ASSISTED', saleName: 'Sale Minh' } });
    await waitFor(() => expect(close).toHaveBeenCalledWith(false));
  });
  it('bước trả phòng không hỏi chỉ số: số điện cuối nhập một lần ở bước quyết toán', () => {
    render(<TerminateDialog open onOpenChange={vi.fn()} contract={contract} />);
    expect(screen.queryByText('Chỉ số điện, nước khi bàn giao')).toBeNull();
    expect(screen.queryByLabelText(/Chưa đủ chỉ số, bổ sung sau/)).toBeNull();
    expect(screen.getByText(/Số điện cuối nhập một lần/)).toBeTruthy();
  });
  it('nhánh quyết toán sau gửi ghi chú đã trim cùng ngày/loại, không mở form tiền', async () => {
    const close = vi.fn();
    render(<TerminateDialog open onOpenChange={close} contract={contract} />);
    expect(spies.invoices.mock.calls.every(([id]) => id === undefined)).toBe(true);
    expect(spies.credit.mock.calls.every(([id]) => id === undefined)).toBe(true);
    fireEvent.change(screen.getByLabelText(/Ngày khách thực tế trả phòng/), { target: { value: '2026-09-28' } });
    fireEvent.click(screen.getByLabelText('Bỏ cọc'));
    fireEvent.change(screen.getByLabelText(/Nội dung thanh lý/), { target: { value: '  Khách chuyển nơi làm việc.\nĐã nhận chìa khóa.  ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Trả phòng, quyết toán sau' }));
    await waitFor(() => expect(close).toHaveBeenCalledWith(false));
    expect(spies.confirm).toHaveBeenCalledOnce();
    const request = spies.confirm.mock.calls[0][0];
    expect(request).toEqual({ contractId: contract.id, expectedContractUpdatedAt: contract.updated_at,
      actualMoveOutOn: '2026-09-28', initialKind: 'FORFEIT', settlementMode: 'DEFERRED', idempotencyKey: expect.any(String),
      returnNote: 'Khách chuyển nơi làm việc.\nĐã nhận chìa khóa.',
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
    fireEvent.click(screen.getByRole('button', { name: 'Dùng nội dung mẫu' }));
    const save = screen.getByRole('button', { name: 'Trả phòng, quyết toán sau' });
    fireEvent.click(save);
    await waitFor(() => expect(spies.confirm).toHaveBeenCalledTimes(1));
    fireEvent.click(save);
    await waitFor(() => expect(spies.confirm).toHaveBeenCalledTimes(2));
    expect(spies.confirm.mock.calls[0][0].idempotencyKey).toBe(spies.confirm.mock.calls[1][0].idempotencyKey);
    expect(close).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText(/Nội dung thanh lý/), { target: { value: 'Khách chuyển nhà.' } });
    fireEvent.click(save);
    await waitFor(() => expect(spies.confirm).toHaveBeenCalledTimes(3));
    expect(spies.confirm.mock.calls[2][0].idempotencyKey).not.toBe(spies.confirm.mock.calls[0][0].idempotencyKey);
  });
  it('giữ nội dung tự nhập khi đổi loại và quay lại từ quyết toán', () => {
    render(<TerminateDialog open onOpenChange={vi.fn()} contract={contract} />);
    fireEvent.click(screen.getByLabelText('Hết hạn hợp đồng'));
    fireEvent.click(screen.getByRole('button', { name: 'Dùng nội dung mẫu' }));
    fireEvent.change(screen.getByLabelText(/Nội dung thanh lý/), { target: { value: 'Nội dung khách đã xác nhận.' } });
    fireEvent.click(screen.getByLabelText('Bỏ cọc'));
    expect((screen.getByLabelText(/Nội dung thanh lý/) as HTMLTextAreaElement).value).toBe('Nội dung khách đã xác nhận.');
    fireEvent.click(screen.getByRole('button', { name: 'Tiếp tục quyết toán ngay' }));
    fireEvent.click(screen.getByRole('button', { name: 'Quay lại' }));
    expect((screen.getByLabelText(/Nội dung thanh lý/) as HTMLTextAreaElement).value).toBe('Nội dung khách đã xác nhận.');
  });
});

it('chặn cả hai nhánh quyết toán khi nguồn chỉ số chưa hợp lệ', async () => {
  meterValidity.valid = false;
  early.data = [landlordRow()];
  const exitCase = { id: 'd1111111-1111-4111-8111-111111111111', current_kind: 'EARLY_RETURN', initial_kind: 'EARLY_RETURN', actual_move_out_on: '2026-09-28', version: 1, state: 'PENDING', kind_history: [] } as import('@/lib/contractExitCases').ContractExitCase;
  render(<TerminateDialog open onOpenChange={vi.fn()} contract={contract} exitCase={exitCase} />);
  fireEvent.click(screen.getByRole('button', { name: /Tiếp tục quyết toán/ }));
  expect(screen.getByRole('button', { name: /Lập hoá đơn & thanh lý/i }).hasAttribute('disabled')).toBe(true);
  fireEvent.submit(screen.getByRole('button', { name: /Lập hoá đơn & thanh lý/i }).closest('form')!);
  expect(screen.queryByText('Xác nhận thanh lý — khách rời phòng')).toBeNull();
  expect(spies.finalize).not.toHaveBeenCalled();
  cleanup();
  render(<TerminateDialog open onOpenChange={vi.fn()} contract={contract} exitCase={{ ...exitCase, current_kind: 'FORFEIT', initial_kind: 'FORFEIT' }} />);
  fireEvent.click(screen.getByRole('button', { name: /Tiếp tục quyết toán/ }));
  const submit = screen.getByRole('button', { name: /Lập hoá đơn & thanh lý/i });
  expect(submit.hasAttribute('disabled')).toBe(true);
  fireEvent.submit(submit.closest('form')!);
  expect(spies.finalize).not.toHaveBeenCalled();
});
