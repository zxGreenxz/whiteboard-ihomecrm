// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { ContractCommissionFollowup } from '@/lib/contractCommissionFollowup';

const mocks = vi.hoisted(() => ({
  query: { data: undefined as { rows: ContractCommissionFollowup[]; total: number } | undefined, isPending: false, isError: false, refetch: vi.fn() },
  retry: vi.fn(), read: vi.fn(), record: vi.fn(),
}));
vi.mock('@/lib/contractCommissionFollowup', async original => ({ ...await original<typeof import('@/lib/contractCommissionFollowup')>(), readContractCommissionFollowups: (...args: unknown[]) => mocks.read(...args) }));
vi.mock('@/hooks/useContractCommissionFollowup', () => ({ useContractCommissionFollowups: () => mocks.query,
  useRecordContractCommissionEvent: () => ({ mutateAsync: mocks.record, isPending: false }) }));
vi.mock('@/contexts/OrganizationContext', () => ({ useOrganization: () => ({ selectedOrganizationId: 'org-1' }) }));
vi.mock('@/hooks/useCommissionVoucher', () => ({ useRetryCommissionVoucher: () => ({ mutateAsync: mocks.retry, isPending: false }) }));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), info: vi.fn(), error: vi.fn() } }));
vi.mock('@/components/contracts/CommissionVoucherModal', () => ({
  CommissionVoucherModal: ({ open, contractId, onlyKind, replacementRequestId, onOpenChange }: { open: boolean; contractId: string; onlyKind?: string; replacementRequestId?: string; onOpenChange: (open: boolean) => void }) =>
    open ? <div role="dialog" aria-label="Tạo phiếu hoa hồng">{contractId} {onlyKind} {replacementRequestId}<button onClick={() => onOpenChange(false)}>Đóng popup</button></div> : null,
}));
import { ContractCommissionFollowupPanel } from '../ContractCommissionFollowupPanel';
it('shows a zero-net completed support outcome without a voucher or failure retry', () => {
  mocks.query.data = { rows: [row({ state: 'SETTLED_BY_SUPPORT', voucher_id: null })], total: 1 };
  render(<ContractCommissionFollowupPanel contractId="contract-1" />);
  expect(screen.getByText(/Đã xử lý bằng hỗ trợ tiền thuê/)).toBeTruthy();
  expect(screen.queryByRole('alert')).toBeNull(); expect(screen.queryByRole('button', { name: 'Tạo lại' })).toBeNull();
});
const row = (overrides: Partial<ContractCommissionFollowup> = {}): ContractCommissionFollowup => ({
  contract_id: 'contract-1', contract_number: 'HD-001', building_id: 'building-1', building_name: 'Toà A', room_name: '101',
  kind: 'broker', state: 'PENDING', last_reason: null, last_actor: null, last_at: null, attempted_amount: null,
  voucher_id: null, voucher_code: null, voucher_status: null, can_manage: true, events: [], ...overrides,
});
it.each(['FAILED', 'UNKNOWN', 'PROCESSING'] as const)('shows saved reason and original actor/time for %s without a voucher', async state => {
  mocks.query.data = { rows: [row({ state, request_id: 'saved-request', can_retry: state !== 'PROCESSING', last_reason: 'Lần tạo phiếu chưa hoàn tất',
    preparation: { request_id: 'saved-request', reason: 'Hai bên thống nhất mức hoa hồng riêng', actor_name: 'Người lập ban đầu', created_at: '2026-10-11T03:00:00Z', stage: 'PREPARE' } })], total: 1 };
  const { rerender } = render(<ContractCommissionFollowupPanel contractId="contract-1" />);
  const evidence = screen.getByLabelText('Thông tin lập yêu cầu đã lưu');
  expect(evidence.textContent).toContain('Hai bên thống nhất mức hoa hồng riêng');
  expect(evidence.textContent).toContain('Người lập ban đầu'); expect(evidence.textContent).toContain('11/10/2026');
  if (state !== 'PROCESSING') {
    fireEvent.click(screen.getByRole('button', { name: 'Tạo lại' }));
    await waitFor(() => expect(mocks.retry).toHaveBeenCalledWith({ contract_id: 'contract-1', kind: 'broker', request_id: 'saved-request' }));
    expect(screen.getByLabelText('Thông tin lập yêu cầu đã lưu').textContent).toContain('Người lập ban đầu');
  }
  mocks.query.data.rows[0].can_manage = false;
  rerender(<ContractCommissionFollowupPanel contractId="contract-1" />);
  expect(screen.queryByLabelText('Thông tin lập yêu cầu đã lưu')).toBeNull();
  expect(screen.queryByText(/Hai bên thống nhất mức hoa hồng riêng|Người lập ban đầu/)).toBeNull();
});
it.each(['NOT_APPLICABLE', 'REOPENED'] as const)('requires an explicit reason and saves %s after checking current state', async action => {
  mocks.query.data = { rows: [row({ state: action === 'REOPENED' ? 'NOT_APPLICABLE' : 'PENDING' })], total: 1 };
  render(<ContractCommissionFollowupPanel contractId="contract-1" />);
  fireEvent.click(screen.getByRole('button', { name: `${action === 'REOPENED' ? 'Mở lại' : 'Không phát sinh'} hoa hồng môi giới` }));
  const save = screen.getByRole('button', { name: 'Lưu quyết định' }) as HTMLButtonElement;
  expect(save.disabled).toBe(true);
  fireEvent.change(screen.getByLabelText('Lý do quyết định *'), { target: { value: 'ngắn' } });
  expect(save.disabled).toBe(true);
  fireEvent.change(screen.getByLabelText('Lý do quyết định *'), { target: { value: '  Hai bên xác nhận quyết định này  ' } });
  fireEvent.click(save);
  await waitFor(() => expect(mocks.record).toHaveBeenCalledWith({ contractId: 'contract-1', kind: 'broker', action, reason: 'Hai bên xác nhận quyết định này' }));
  expect(mocks.retry).not.toHaveBeenCalled();
});
it('does not record a no-commission decision after a voucher appears during preflight', async () => {
  render(<ContractCommissionFollowupPanel contractId="contract-1" />);
  fireEvent.click(screen.getByRole('button', { name: 'Không phát sinh hoa hồng môi giới' }));
  fireEvent.change(screen.getByLabelText('Lý do quyết định *'), { target: { value: 'Hai bên không yêu cầu hoa hồng' } });
  mocks.query.refetch.mockResolvedValue({ data: { rows: [row({ state: 'VOUCHER_CREATED' })] }, isError: false });
  fireEvent.click(screen.getByRole('button', { name: 'Lưu quyết định' }));
  await screen.findByRole('alert'); expect(mocks.record).not.toHaveBeenCalled();
});
it('opens replacement only for the reconciled failed request and does not retry it automatically', async () => {
  mocks.query.data = { rows: [row({ state: 'UNKNOWN', request_id: 'old-request', can_retry: true })], total: 1 };
  render(<ContractCommissionFollowupPanel contractId="contract-1" />);
  fireEvent.click(screen.getByRole('button', { name: 'Lập lại yêu cầu' }));
  expect((await screen.findByRole('dialog')).textContent).toContain('old-request');
  expect(mocks.retry).not.toHaveBeenCalled(); expect(mocks.record).not.toHaveBeenCalled();
});
it('shows who made a decision, when, and why', () => {
  mocks.query.data = { rows: [row({ state: 'NOT_APPLICABLE', events: [{ action: 'NOT_APPLICABLE', reason: 'Không có đơn vị môi giới', amount: null, actor_name: 'Người kiểm thử', created_at: '2026-10-10T05:00:00Z' }] })], total: 1 };
  render(<ContractCommissionFollowupPanel contractId="contract-1" />);
  expect(screen.getByText(/Người kiểm thử/)).toBeTruthy();
  expect(screen.getByText(/Không có đơn vị môi giới/)).toBeTruthy();
  expect(screen.getByText(/10\/10\/2026/)).toBeTruthy();
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
  mocks.query.refetch.mockImplementation(async () => {
    mocks.query.data = { rows: [row({ state: 'VOUCHER_CREATED', voucher_id: 'live', voucher_code: 'PC-LIVE' })], total: 1 };
    return { data: mocks.query.data, isError: false };
  });
  const { rerender } = render(<ContractCommissionFollowupPanel contractId="contract-1" />);
  fireEvent.click(screen.getByRole('button', { name: 'Tạo lại' }));
  await waitFor(() => expect(mocks.read).toHaveBeenCalledWith('org-1', { contractId: 'contract-1' }));
  expect(mocks.retry).not.toHaveBeenCalled(); expect(screen.queryByRole('dialog')).toBeNull();
  await waitFor(() => expect(mocks.query.refetch).toHaveBeenCalledOnce());
  rerender(<ContractCommissionFollowupPanel contractId="contract-1" />);
  expect(screen.queryByRole('button', { name: 'Tạo lại' })).toBeNull();
  expect(screen.queryByRole('alert')).toBeNull();
  expect(screen.getByText(/PC-LIVE/)).toBeTruthy();
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

it.each([{code:'42501',message:'permission denied income_expenses'},new TypeError('Failed to fetch')])('D17 retry failure safe inline một owner và giữ saved request %j',async error=>{
 mocks.query.data={rows:[row({state:'UNKNOWN',request_id:'saved',can_retry:true})],total:1};mocks.retry.mockRejectedValue(error);
 render(<ContractCommissionFollowupPanel contractId="contract-1"/>);
 fireEvent.click(screen.getByRole('button',{name:'Tạo lại'}));
 await waitFor(()=>expect(mocks.retry).toHaveBeenCalledWith({contract_id:'contract-1',kind:'broker',request_id:'saved'}));
 await waitFor(()=>expect(screen.getAllByRole('alert').some(node=>/Không đủ quyền|Chưa xác nhận/.test(node.textContent||''))).toBe(true));
 expect(screen.queryByText(/permission denied|income_expenses|Failed to fetch/)).toBeNull();expect(screen.queryByRole('dialog')).toBeNull();
 expect(screen.getByRole('button',{name:'Tạo lại'})).toBeTruthy();
});
