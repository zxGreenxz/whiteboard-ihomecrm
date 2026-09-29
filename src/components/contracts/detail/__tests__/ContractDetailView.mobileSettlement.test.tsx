// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import ContractDetailView from '../ContractDetailView';
import type { ContractTerminationInfo } from '@/hooks/contracts/useContractDetailData';

const state = vi.hoisted(() => ({
  invoices: { data: [] as unknown[], isLoading: false, isFetching: false, isError: false },
  deposits: { data: [], isLoading: false, isFetching: false, isError: false },
  pending: { data: { refund: 0, forfeit: 0 }, isLoading: false, isFetching: false, isError: false },
  termination: { data: null as ContractTerminationInfo | null, isLoading: false, isFetching: false, isError: false },
  history: { data: [], isLoading: false, isFetching: false, isError: false },
}));
const viewport = vi.hoisted(() => ({ mobile: true }));
vi.mock('@/hooks/use-mobile', () => ({ usePhoneViewport: () => viewport.mobile }));
vi.mock('@/contexts/OrganizationContext', () => ({ useOrganization: () => ({ selectedOrganizationId: 'org-1' }) }));
vi.mock('@/hooks/useContractCommissionFollowup', () => ({
  useContractCommissionFollowups: () => ({ data: undefined, isError: true, isPending: false, refetch: vi.fn() }),
  useRecordContractCommissionEvent: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));
vi.mock('@/hooks/useMyPermissions', () => ({ useMyPermissions: () => ({ data: {} }) }));
vi.mock('@/hooks/useContracts', () => ({ useContract: () => ({ data: { id: 'contract', contract_number: 'DEMO',
  status: 'TERMINATED', start_date: '2026-01-01', end_date: '2026-12-31', contract_customers: [],
  total_deposit: 2_000, deposit_paid: 2_000, deposit_remaining: 0 }, isLoading: false }) }));
vi.mock('@/hooks/useInvoices', () => ({ useInvoicesLegacy: () => state.invoices }));
vi.mock('@/hooks/useBuildingServices', () => ({ useBuildingServices: () => ({ data: [], isLoading: false }) }));
vi.mock('@/hooks/contracts/useContractDetailData', () => ({
  useContractDepositVouchers: () => state.deposits, useContractPendingTermination: () => state.pending,
  useContractTerminationInfo: () => state.termination, useContractVehicles: () => ({ data: [], isError: false }),
  useContractServices: () => ({ data: [], isError: false, isLoading: false }),
  useContractHistory: () => state.history,
}));
vi.mock('../ContractMobileActions', () => ({ ContractMobileActions: () => null }));
vi.mock('../ContractInfoTab', () => ({ ContractInfoTab: () => null }));
vi.mock('../ContractInvoicesTab', () => ({ ContractInvoicesTab: () => null }));
vi.mock('../ContractPaymentsTab', () => ({ ContractPaymentsTab: () => null }));
vi.mock('../ContractHistoryTab', () => ({ ContractHistoryTab: () => null }));
vi.mock('../desktop/ContractDetailDesktop', () => ({ ContractDetailDesktop: () => null }));
vi.mock('@/components/contracts/RenewDialog', () => ({ RenewDialog: () => null }));
vi.mock('@/components/contracts/TransferContractDialog', () => ({ TransferContractDialog: () => null }));
vi.mock('@/components/contracts/TransferRoomDialog', () => ({ TransferRoomDialog: () => null }));
vi.mock('@/components/contracts/TerminateDialog', () => ({ TerminateDialog: () => null }));
vi.mock('@/components/contracts/ContractExitCasePanel', () => ({ ContractExitCasePanel: () => null }));
vi.mock('@/components/contracts/RegisterMoveOutDialog', () => ({ default: () => null }));
vi.mock('@/components/contracts/ContractQRDialog', () => ({ default: () => null }));
vi.mock('@/components/contracts/ContractFormDialog', () => ({ ContractFormDialog: () => null }));
vi.mock('@/components/contracts/PrintContractDialog', () => ({ PrintContractDialog: () => null }));
vi.mock('@/components/contracts/DeleteContractDialog', () => ({ DeleteContractDialog: () => null }));

beforeEach(() => {
  viewport.mobile = true;
  state.invoices.data = [];
  state.pending.data = { refund: 0, forfeit: 0 };
  for (const query of Object.values(state)) { query.isLoading = false; query.isFetching = false; query.isError = false; }
  state.termination.data = { termination_type: 'MOVE_OUT', actual_move_out_date: '2026-09-28',
    total_deposit: 2_000, total_deductions: 0, outstanding_debt: 0, early_termination_fee: 0,
    refund_amount: 2_000, posted_refund: 2_000, posted_refund_count: 1, posted_refund_codes: ['REFUND'] };
});
afterEach(cleanup);
function show() {
  render(<MemoryRouter><ContractDetailView id="contract" onBack={() => {}} /></MemoryRouter>);
  return within(screen.getByRole('region', { name: 'Trạng thái sau trả phòng' }));
}
it('maps actual View reader data and both pending counts into the real mobile status', () => {
  state.invoices.data = [{ id: 'invoice', total_amount: 1_000, paid_amount: 0 }];
  state.termination.data!.posted_refund = 0;
  state.pending.data = { refund: 1, forfeit: 2 };
  const status = show();
  expect(status.getByText(/Nợ hoá đơn.*1\.000/)).toBeTruthy();
  expect(status.getByText(/Chưa hoàn khách.*2\.000/)).toBeTruthy();
  expect(status.getByText('Phiếu hoàn chờ xử lý (1)')).toBeTruthy();
  expect(status.getByText('Phiếu bỏ cọc chờ xử lý (2)')).toBeTruthy();
});
it.each(['invoices', 'deposits', 'pending', 'termination'] as const)('maps %s loading before displaying completion', key => {
  state[key].isLoading = true;
  const status = show();
  expect(status.getByRole('status').textContent).toContain('Đang tải trạng thái thanh lý');
  expect(status.queryByText('Không còn khoản nào treo')).toBeNull();
});
it.each(['invoices', 'deposits', 'pending', 'termination'] as const)('maps %s reader errors instead of a completed state', key => {
  state[key].isError = true;
  const status = show();
  expect(status.getByRole('alert').textContent).toContain('Không tải được');
  expect(status.queryByText('Không còn khoản nào treo')).toBeNull();
});
it.each(['invoices', 'deposits', 'pending', 'termination'] as const)('waits for %s refresh even when cached totals are settled', key => {
  state[key].isFetching = true;
  const status = show();
  expect(status.getByRole('status').textContent).toContain('Đang tải trạng thái thanh lý');
  expect(status.queryByText('Không còn khoản nào treo')).toBeNull();
});
it('preserves missing termination information through View and mobile', () => {
  state.termination.data = null;
  const status = show();
  expect(status.getByText('Chưa chốt quyết toán')).toBeTruthy();
  expect(status.queryByText('Không còn khoản nào treo')).toBeNull();
});
it('keeps a loaded settlement status available when unrelated history fails', () => {
  state.history.isError = true;
  expect(show().getByText('Không còn khoản nào treo')).toBeTruthy();
});
it.each([true, false])('keeps commission read failures visible in the %s mobile detail branch', mobile => {
  viewport.mobile = mobile;
  render(<MemoryRouter><ContractDetailView id="contract" onBack={() => {}} /></MemoryRouter>);
  const panel = screen.getByRole('region', { name: 'Theo dõi hoa hồng và thưởng Sale' });
  expect(within(panel).getByRole('alert').textContent).toContain('Không tải được');
  if (mobile) expect(panel.closest('.mbody')).toBeTruthy();
});
