// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { ContractCommissionFollowup } from '@/lib/contractCommissionFollowup';

const mocks = vi.hoisted(() => ({
  query: { data: undefined as { rows: ContractCommissionFollowup[]; total: number } | undefined, isPending: false, isError: false, refetch: vi.fn() },
  retry: vi.fn(), read: vi.fn(),
}));
vi.mock('@/lib/contractCommissionFollowup', () => ({ readContractCommissionFollowups: (...args: unknown[]) => mocks.read(...args) }));
vi.mock('@/hooks/useContractCommissionFollowup', () => ({ useContractCommissionFollowups: () => mocks.query,
  useRecordContractCommissionEvent: () => ({ mutateAsync: vi.fn(), isPending: false }) }));
vi.mock('@/contexts/OrganizationContext', () => ({ useOrganization: () => ({ selectedOrganizationId: 'org-1' }) }));
vi.mock('@/hooks/useCommissionVoucher', () => ({ useRetryCommissionVoucher: () => ({ mutateAsync: mocks.retry, isPending: false }) }));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), info: vi.fn(), error: vi.fn() } }));
vi.mock('@/components/contracts/CommissionVoucherModal', () => ({
  CommissionVoucherModal: ({ open, contractId, onlyKind, onOpenChange }: { open: boolean; contractId: string; onlyKind?: string; onOpenChange: (open: boolean) => void }) =>
    open ? <div role="dialog" aria-label="Tạo phiếu hoa hồng">{contractId} {onlyKind}<button onClick={() => onOpenChange(false)}>Đóng popup</button></div> : null,
}));
import { ContractCommissionFollowupPanel } from '../ContractCommissionFollowupPanel';
const row = (overrides: Partial<ContractCommissionFollowup> = {}): ContractCommissionFollowup => ({
  contract_id: 'contract-1', contract_number: 'HD-001', building_id: 'building-1', building_name: 'Toà A', room_name: '101',
  kind: 'broker', state: 'PENDING', last_reason: null, last_actor: null, last_at: null, attempted_amount: null,
  voucher_id: null, voucher_code: null, voucher_status: null, can_manage: true, events: [], ...overrides,
});
beforeEach(() => { vi.clearAllMocks(); mocks.query.isPending = false; mocks.query.isError = false;
  mocks.query.data = { rows: [row(), row({ kind: 'sale' })], total: 2 };
  mocks.query.refetch.mockImplementation(async () => ({ data: mocks.query.data, isError: mocks.query.isError }));
  mocks.read.mockImplementation(async () => mocks.query.data);
  mocks.retry.mockResolvedValue({ status: 'COMPLETED', id: 'voucher-1', code: 'PC-001' }); });
afterEach(cleanup);

it('empty history and legacy PENDING do not become failures below the creation action', () => {
  const { rerender } = render(<ContractCommissionFollowupPanel contractId="contract-1" />);
  expect(screen.getByRole('button', { name: 'Tạo phiếu hoa hồng' })).toBeTruthy();
  expect(screen.queryByRole('alert')).toBeNull(); expect(screen.queryByText(/Chưa xử lý|khoản nợ|cần kiểm tra/)).toBeNull();
  mocks.query.data = { rows: [], total: 0 };
  rerender(<ContractCommissionFollowupPanel contractId="contract-1" />);
  expect(screen.queryByRole('alert')).toBeNull();
});
it('actual failure is directly below creation action and retries only saved Sale intent', async () => {
  mocks.query.data = { rows: [row({ state: 'VOUCHER_CREATED', voucher_id: 'broker-voucher', voucher_code: 'PC-BROKER' }),
    row({ kind: 'sale', state: 'FAILED', last_reason: 'Sổ quỹ chưa khả dụng.', request_id: 'request-sale', can_retry: true })], total: 2 };
  render(<ContractCommissionFollowupPanel contractId="contract-1" />);
  const note = screen.getByRole('alert');
  expect(note.textContent).toContain('HD-001'); expect(note.textContent).toContain('Thưởng Sale');
  expect(note.textContent).toContain('Sổ quỹ chưa khả dụng.');
  expect(screen.getByRole('button', { name: 'Tạo phiếu hoa hồng' }).parentElement?.nextElementSibling).toBe(note);
  fireEvent.click(within(note).getByRole('button', { name: 'Tạo lại' }));
  await waitFor(() => expect(mocks.retry).toHaveBeenCalledWith({ contract_id: 'contract-1', kind: 'sale', request_id: 'request-sale' }));
  expect(screen.queryByRole('dialog')).toBeNull();
});
it('legacy failure opens only failed kind and closing never records an implicit failure', async () => {
  mocks.query.data = { rows: [row({ state: 'FAILED', request_id: 'legacy-event-request', can_retry: false }), row({ kind: 'sale' })], total: 2 };
  render(<ContractCommissionFollowupPanel contractId="contract-1" />);
  fireEvent.click(screen.getByRole('button', { name: 'Tạo lại' }));
  const modal = await screen.findByRole('dialog'); expect(modal.textContent).toContain('contract-1 broker');
  fireEvent.click(within(modal).getByRole('button', { name: 'Đóng popup' }));
  expect(mocks.retry).not.toHaveBeenCalled(); expect(screen.getByRole('alert')).toBeTruthy();
});
it('fresh reconciliation removes obsolete retry instead of retrying an existing voucher', async () => {
  mocks.query.data = { rows: [row({ state: 'FAILED', request_id: 'old', can_retry: true })], total: 1 };
  mocks.read.mockResolvedValue({ rows: [row({ state: 'VOUCHER_CREATED', voucher_id: 'live', voucher_code: 'PC-LIVE' })] });
  render(<ContractCommissionFollowupPanel contractId="contract-1" />);
  fireEvent.click(screen.getByRole('button', { name: 'Tạo lại' }));
  await waitFor(() => expect(mocks.read).toHaveBeenCalledWith('org-1', { contractId: 'contract-1' }));
  expect(mocks.retry).not.toHaveBeenCalled(); expect(screen.queryByRole('dialog')).toBeNull();
});
it('reads exact contract before retry even if a refreshed queue page no longer contains that target', async () => {
  mocks.query.data = { rows: [row({ state: 'FAILED', request_id: 'saved', can_retry: true })], total: 25 };
  mocks.query.refetch.mockResolvedValue({ data: { rows: [], total: 25 }, isError: false });
  render(<ContractCommissionFollowupPanel contractId="contract-1" />);
  fireEvent.click(screen.getByRole('button', { name: 'Tạo lại' }));
  await waitFor(() => expect(mocks.retry).toHaveBeenCalledWith({ contract_id: 'contract-1', kind: 'broker', request_id: 'saved' }));
});
it('missing exact-contract source never claims the request is resolved', async () => {
  mocks.query.data = { rows: [row({ state: 'FAILED', request_id: 'saved', can_retry: true })], total: 1 };
  mocks.read.mockResolvedValue({ rows: [], total: 0 });
  render(<ContractCommissionFollowupPanel contractId="contract-1" />);
  fireEvent.click(screen.getByRole('button', { name: 'Tạo lại' }));
  await screen.findByText(/Chưa xác minh được kết quả tạo phiếu/);
  expect(mocks.retry).not.toHaveBeenCalled();
});
it('existing vouchers disable creation and present only returned verified identity', () => {
  mocks.query.data = { rows: [row({ state: 'VOUCHER_CREATED', voucher_id: 'live', voucher_code: 'PC-001' }),
    row({ kind: 'sale', state: 'VOUCHER_CREATED', can_manage: false })], total: 2 };
  render(<ContractCommissionFollowupPanel contractId="contract-1" />);
  expect(screen.getByRole('button', { name: 'Tạo phiếu hoa hồng' }).hasAttribute('disabled')).toBe(true);
  expect(screen.getByText(/PC-001/)).toBeTruthy(); expect(screen.getByText(/Thưởng Sale: Đã có phiếu/)).toBeTruthy();
});
it('contract-only users cannot see financial reasons, amounts or retry actions', () => {
  mocks.query.data = { rows: [row({ state: 'FAILED', can_manage: false, last_reason: 'secret-bank', attempted_amount: 999999, can_retry: false })], total: 1 };
  render(<ContractCommissionFollowupPanel contractId="contract-1" />);
  expect(screen.queryByText(/secret-bank|999/)).toBeNull(); expect(screen.queryByRole('button', { name: 'Tạo lại' })).toBeNull();
});
it('technical database failure details are not exposed as the user-facing reason', () => {
  mocks.query.data = { rows: [row({ state: 'FAILED', can_retry: true, request_id: 'request-1',
    last_reason: 'insert or update on table "income_expenses" violates foreign key constraint account_id 1234' })], total: 1 };
  render(<ContractCommissionFollowupPanel contractId="contract-1" />);
  expect(screen.queryByText(/foreign key|income_expenses|1234/)).toBeNull();
  expect(screen.getByRole('alert').textContent).toMatch(/kiểm tra sổ quỹ|dữ liệu/);
});
it('read failures show load retry and never report zero success or open issuance', () => {
  mocks.query.isError = true; render(<ContractCommissionFollowupPanel contractId="contract-1" />);
  expect(screen.getByRole('alert').textContent).toMatch(/Không tải được/);
  expect(screen.getByRole('button', { name: 'Tạo phiếu hoa hồng' }).hasAttribute('disabled')).toBe(true);
  fireEvent.click(screen.getByRole('button', { name: 'Tải lại' })); expect(mocks.query.refetch).toHaveBeenCalledOnce();
});
