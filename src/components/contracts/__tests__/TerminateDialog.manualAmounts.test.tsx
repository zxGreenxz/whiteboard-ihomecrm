// @vitest-environment jsdom
// Lỗi dựng lại trên TEST 23/11/2026: ở bước quyết toán, số gõ tay ở "Tiền phòng ngày không ở" bị thay bằng số tự tính khi
// con trỏ rời ô ngày, nên hộp xác nhận và phiếu chi dùng số tự tính. Test này chạy hai mục tiền THẬT bên trong hộp Thanh lý
// và dựng tham số RPC bằng đúng hàm của luồng thật, để số gõ tay phải đi nguyên vẹn tới hộp xác nhận và payload.
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ContractWithRelations } from '@/types/contract';
import { buildFinalizeContractExitCaseArgs, type ContractExitCase, type FinalizeContractExitCaseInput } from '@/lib/contractExitCases';

const spies = vi.hoisted(() => ({ finalize: vi.fn(), confirm: vi.fn(), resolve: vi.fn() }));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
// Hồ sơ trả phòng trước hạn trong các bài này: chủ nhà hỗ trợ (không giữ phòng, không phí môi giới).
vi.mock('@/hooks/contracts/useContractExitEarlyTerms', async () => {
  const { exitTermsRow } = await import('./exitEarlyTermsFixture');
  const row = exitTermsRow({ early_reason: 'LANDLORD_AGREEMENT', sale_name: null, broker_fee: 0, hold_until: null, pending_link: false, hold_open: false });
  return {
    useContractExitEarlyTerms: () => ({ data: [row], isPending: false, isError: false, refetch: vi.fn() }),
    useSetContractExitEarlyTerms: () => ({ mutateAsync: vi.fn(), isPending: false }),
    useUpdateContractExitBrokerFee: () => ({ mutateAsync: vi.fn(), isPending: false }),
    useCreateContractExitCommission: () => ({ mutateAsync: vi.fn(), isPending: false }),
  };
});
vi.mock('@/hooks/useContractExitSettlementDrafts', () => ({
  useContractExitSettlementDraft: () => ({ data: null, isPending: false, isError: false, isSuccess: true, isFetching: false, isFetchedAfterMount: true, refetch: vi.fn() }),
  useSaveContractExitSettlementDraft: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useDiscardContractExitSettlementDraft: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));
vi.mock('@/hooks/useContractExitCases', () => ({
  useConfirmContractReturn: () => ({ mutateAsync: spies.confirm, isPending: false }),
  useFinalizeContractExitCase: () => ({ mutateAsync: spies.finalize, isPending: false }),
  useUpdateContractExitKind: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));
vi.mock('@/hooks/useContracts', () => ({ useUnpaidInvoices: () => ({ data: [], isError: false, isPending: false }) }));
vi.mock('@/hooks/useInvoices', () => ({ useExcessAmount: () => ({ data: 0, isError: false, isPending: false }) }));
vi.mock('@/hooks/useAccounts', () => ({ useAccounts: () => ({ data: [], isSuccess: true }) }));
vi.mock('@/hooks/useBuildingServices', () => ({ useBuildingServices: () => ({ data: [] }) }));
vi.mock('@/contexts/OrganizationContext', () => ({ useOrganization: () => ({ selectedOrganizationId: 'e1111111-1111-4111-8111-111111111111' }) }));
vi.mock('@/lib/meter-capture/service', () => ({ resolveMeterBilling: spies.resolve, readLatestApprovedReading: vi.fn(), readActiveElectricMeter: vi.fn() }));
vi.mock('@/components/meter-readings/MeterEvidenceThumb', () => ({ MeterEvidenceThumb: () => null }));
import { TerminateDialog } from '../TerminateDialog';

const ORG = 'e1111111-1111-4111-8111-111111111111';
const contract = { id: 'a1111111-1111-4111-8111-111111111111', updated_at: '2026-09-27T03:00:00.123456+00:00', room_id: 'b1111111-1111-4111-8111-111111111111',
  status: 'TERMINATED', start_date: '2026-01-01', end_date: '2026-12-31', rent_price: 3_100_000, contract_services: [], contract_customers: [],
  total_deposit: 4_000_000, deposit_paid: 4_000_000, room: { building_id: 'f1111111-1111-4111-8111-111111111111' },
} as unknown as ContractWithRelations;
const exitCase = (kind: 'EARLY_RETURN' | 'FORFEIT') => ({ id: 'd1111111-1111-4111-8111-111111111111', current_kind: kind, initial_kind: kind,
  actual_move_out_on: '2026-10-03', version: 2, state: 'PENDING', kind_history: [], return_note: 'Khách trả sớm.' }) as unknown as ContractExitCase;

/** Ô tiền nằm cùng hàng với nhãn của nó. */
const amountOf = (label: string) => within(screen.getByText(label).parentElement as HTMLElement).getByRole('textbox') as HTMLInputElement;
/** Hai ô ngày nằm cùng hàng với chữ dẫn ("Không ở từ" / "Ở từ"). */
const datesOf = (lead: string) => within(screen.getByText(lead).parentElement as HTMLElement).getAllByPlaceholderText('dd/mm/yyyy') as HTMLInputElement[];
const passThrough = (inputs: HTMLInputElement[]) => { for (const input of inputs) { fireEvent.focus(input); fireEvent.blur(input); } };
const rowAmount = (scope: HTMLElement, label: string) => within(scope).getByText(label).parentElement?.querySelector('b')?.textContent;
const settlementOf = (input: FinalizeContractExitCaseInput) =>
  buildFinalizeContractExitCaseArgs(input, ORG).p_settlement as { refund_items?: { kind: string; amount: number }[]; extra_charges: { kind: string; amount: number }[] };
const openSettlement = async (kind: 'EARLY_RETURN' | 'FORFEIT') => {
  render(<TerminateDialog open onOpenChange={vi.fn()} contract={contract} exitCase={exitCase(kind)} />);
  fireEvent.click(screen.getByRole('button', { name: 'Tiếp tục quyết toán' }));
  await waitFor(() => expect(screen.getByRole('button', { name: /Lập hoá đơn & thanh lý/i }).hasAttribute('disabled')).toBe(false));
};

beforeEach(() => { vi.clearAllMocks(); spies.resolve.mockResolvedValue([]); spies.finalize.mockResolvedValue({ state: 'FINALIZED' }); });
afterEach(cleanup);

describe('hộp Thanh lý: số gõ tay đi nguyên vẹn tới hộp xác nhận và payload', () => {
  it('rời phòng: gõ số hoàn và số thu, đi qua các ô ngày, hộp xác nhận và refund_items / extra_charges mang đúng số gõ', async () => {
    await openSettlement('EARLY_RETURN');
    await waitFor(() => expect(datesOf('Không ở từ').map(input => input.value)).toEqual(['04/10/2026', '31/10/2026']));
    expect(amountOf('Tiền phòng ngày không ở').value).not.toBe('500.000');

    fireEvent.change(amountOf('Tiền phòng ngày không ở'), { target: { value: '500000' } });
    passThrough(datesOf('Không ở từ'));
    fireEvent.change(datesOf('Ở từ')[0], { target: { value: '01/10/2026' } });
    fireEvent.change(amountOf('Tiền phòng + Nước + PDV'), { target: { value: '350000' } });
    passThrough(datesOf('Ở từ'));
    passThrough(datesOf('Không ở từ'));
    expect(amountOf('Tiền phòng ngày không ở').value).toBe('500.000');
    expect(amountOf('Tiền phòng + Nước + PDV').value).toBe('350.000');

    fireEvent.click(screen.getByRole('button', { name: /Lập hoá đơn & thanh lý/i }));
    const confirm = await screen.findByRole('alertdialog');
    expect(rowAmount(confirm, 'Hoàn lại khách')).toBe('500.000 đ');
    // Thu thêm = 350.000 gõ tay + 200.000 vệ sinh mặc định.
    expect(rowAmount(confirm, 'Thu thêm')).toBe('550.000 đ');

    fireEvent.click(within(confirm).getByRole('button', { name: 'Xác nhận thanh lý' }));
    await waitFor(() => expect(spies.finalize).toHaveBeenCalledOnce());
    const settlement = settlementOf(spies.finalize.mock.calls[0][0]);
    expect(settlement.refund_items).toEqual([expect.objectContaining({ kind: 'PRORATED_REFUND', amount: 500_000 })]);
    expect(settlement.extra_charges).toEqual([
      expect.objectContaining({ kind: 'PRORATED', amount: 350_000 }), expect.objectContaining({ kind: 'CLEANING', amount: 200_000 })]);
  });

  it('rời phòng: gõ 0 (không hoàn tiền ngày không ở) rồi đi qua ô ngày thì không có khoản hoàn nào được gửi', async () => {
    await openSettlement('EARLY_RETURN');
    await waitFor(() => expect(datesOf('Không ở từ').map(input => input.value)).toEqual(['04/10/2026', '31/10/2026']));
    fireEvent.change(amountOf('Tiền phòng ngày không ở'), { target: { value: '0' } });
    passThrough(datesOf('Không ở từ'));

    fireEvent.click(screen.getByRole('button', { name: /Lập hoá đơn & thanh lý/i }));
    const confirm = await screen.findByRole('alertdialog');
    expect(within(confirm).queryByText('Hoàn lại khách')).toBeNull();
    fireEvent.click(within(confirm).getByRole('button', { name: 'Xác nhận thanh lý' }));
    await waitFor(() => expect(spies.finalize).toHaveBeenCalledOnce());
    expect(settlementOf(spies.finalize.mock.calls[0][0]).refund_items).toEqual([]);
  });

  it('bỏ cọc: số thu gõ tay còn nguyên sau khi đi qua ô ngày, tới hộp xác nhận và extra_charges', async () => {
    await openSettlement('FORFEIT');
    fireEvent.change(datesOf('Ở từ')[0], { target: { value: '01/10/2026' } });
    fireEvent.change(amountOf('Tiền phòng + Nước + PDV'), { target: { value: '350000' } });
    passThrough(datesOf('Ở từ'));

    fireEvent.click(screen.getByRole('button', { name: /Lập hoá đơn & thanh lý/i }));
    const confirm = await screen.findByRole('alertdialog');
    expect(rowAmount(confirm, 'Thu thêm (hoá đơn công nợ riêng)')).toBe('550.000 đ');
    fireEvent.click(within(confirm).getByRole('button', { name: 'Xác nhận thanh lý' }));
    await waitFor(() => expect(spies.finalize).toHaveBeenCalledOnce());
    const settlement = settlementOf(spies.finalize.mock.calls[0][0]);
    expect(settlement.refund_items).toBeUndefined();
    expect(settlement.extra_charges).toEqual([
      expect.objectContaining({ kind: 'PRORATED', amount: 350_000 }), expect.objectContaining({ kind: 'CLEANING', amount: 200_000 })]);
  });
});
