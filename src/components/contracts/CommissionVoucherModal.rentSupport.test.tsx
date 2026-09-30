// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { RentSupportPayoutForm } from './RentSupportPayoutForm';
import type { SupportRead } from '@/lib/rentSupportApi';
import type { PayoutContext } from '@/lib/rentSupportFunding';
const api = vi.hoisted(() => ({ quote: vi.fn(), prepare: vi.fn(), execute: vi.fn(), read: vi.fn(), readRequest: vi.fn(), retry: vi.fn(), refresh: vi.fn() }));
vi.mock('@/lib/rentSupportApi', async original => ({ ...await original<typeof import('@/lib/rentSupportApi')>(), quoteContractRentSupport: api.quote,
  prepareContractPayoutsWithSupport: api.prepare, executeContractPayoutOperation: api.execute, readContractPayoutOperation: api.read, readContractPayoutRequest: api.readRequest }));
vi.mock('@/hooks/useRentSupportParties', () => ({ useRentSupportParties: () => ({ data: [{ party_id: '11111111-1111-4111-8111-111111111111', kind: 'EXTERNAL', profile_id: null, display_name: 'Sale đã xác minh' }], isFetching: false, isError: false }) }));
vi.mock('@/hooks/useAccounts', () => ({ useAccounts: () => ({ data: [{ id: '22222222-2222-4222-8222-222222222222', name: 'Sổ quỹ' }] }) }));
vi.mock('@/hooks/useCommissionVoucher', () => ({ useRetryCommissionVoucher: () => ({ mutateAsync: api.retry, isPending: false }) }));
vi.mock('@/components/income-expenses/AttachmentUpload', () => ({ default: () => null }));
const party = '11111111-1111-4111-8111-111111111111', contract = '33333333-3333-4333-8333-333333333333', operation = '44444444-4444-4444-8444-444444444444';
const plan: SupportRead['rows'][number] = { contract_id: contract, kind: 'V2', revision: 2, customer_hash: 'customer', legacy: null,
  schedule: { version: 2, start_billing_month: '2026-09', segments: [{ month_count: 3, monthly_amount: '300000' }, { month_count: 9, monthly_amount: '100000' }] },
  months: [], financial: { payload: { version: 2, start_billing_month: '2026-09', payer: 'SALE', sale_party_id: party, deduction_policy: 'COMMISSION_ONLY', collection_mode: 'UPFRONT_COMMITTED', segments: [{ month_count: 3, monthly_amount: '300000' }, { month_count: 9, monthly_amount: '100000' }] }, committed_total: '1800000', reason: null, review: null } };
const rows = ['broker', 'sale'].map(kind => ({ kind, contract_id: contract, state: 'PENDING', can_manage: true }));
const prefill = { contract_id: contract, contract_number: 'HD1', building_id: 'building1', building_name: 'Building', signed_date: '2026-09-30', rent_price: 3000000, months: 12, matched_tier: { min_months: 1, max_months: 12, rate_percent: 100 }, start_date: '2026-09-01', end_date: '2027-08-31', room_id: null, room_name: 'Room', tenant_id: null, tenant_name: null };
const receipt = (net = '1200000') => ({ operation_id: operation, status: 'COMPLETED', sources: [{ source_id: party, operation_id: operation, kind: 'broker', gross: net === '0' ? '1800000' : '3000000', withheld: '1800000', net, status: net === '0' ? 'SETTLED_BY_SUPPORT' : 'COMPLETED', id: net === '0' ? null : contract, voucher_id: net === '0' ? null : contract, code: net === '0' ? null : 'PC-NET' }] });
function quote(_org: string, input: { payoutContext: PayoutContext }) { return { quote_hash: 'hash', payload_hash: 'payload', plan_revision: 2, payload: plan.financial!.payload, committed_total: '1800000', due_upfront: '1800000', unallocated: '0', state: 'READY', issues: [], months: [], sources: input.payoutContext.intents.map(intent => ({ source_id: party, kind: intent.kind, gross_original: intent.gross_amount, already_paid: '0', prior_withheld: '0', remaining_payable: intent.gross_amount, available_to_withhold: intent.gross_amount, current_withheld: '1800000', net_this_operation: intent.gross_amount === '1800000' ? '0' : '1200000', origin: 'PROPOSED', intent_id: intent.intent_id, route: intent.route })) }; }
function setup() { return render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><RentSupportPayoutForm organizationId="org1" contractId={contract} plan={plan} prefill={prefill} rows={rows as never} refetchRows={api.refresh} /></QueryClientProvider>); }
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
async function selectParty() { fireEvent.change(screen.getByLabelText('Người hưởng hoa hồng'), { target: { value: party } }); await waitFor(() => expect((screen.getByRole('button', { name: 'Tạo phiếu ròng' }) as HTMLButtonElement).disabled).toBe(false)); }
beforeEach(() => { vi.clearAllMocks(); api.quote.mockReset(); api.prepare.mockReset(); api.execute.mockReset(); api.read.mockReset();
  api.quote.mockImplementation(quote); api.prepare.mockResolvedValue({ operation_id: operation, status: 'READY' }); api.execute.mockResolvedValue(receipt()); api.read.mockResolvedValue(receipt());
  api.refresh.mockResolvedValue({ data: { rows }, isError: false }); });
afterEach(cleanup);
it.each(['amount', 'party'])('does not submit an old %s intent after a deferred preflight and locks duplicate clicks', async field => {
  const refreshed = deferred<{ data: { rows: typeof rows }; isError: boolean }>(); api.refresh.mockReturnValue(refreshed.promise);
  setup(); await selectParty(); fireEvent.click(screen.getByRole('button', { name: 'Tạo phiếu ròng' }));
  await waitFor(() => expect(api.refresh).toHaveBeenCalledTimes(1));
  const submit = screen.getByRole('button', { name: 'Tạo phiếu ròng' }) as HTMLButtonElement;
  expect(submit.disabled).toBe(true); fireEvent.click(submit); expect(api.refresh).toHaveBeenCalledTimes(1);
  // Programmatic changes also exercise the fingerprint guard even with a disabled fieldset.
  if (field === 'amount') fireEvent.change(screen.getByLabelText('Gross hoa hồng'), { target: { value: '1800000' } });
  else fireEvent.change(screen.getByLabelText('Người hưởng hoa hồng'), { target: { value: '' } });
  await act(async () => { refreshed.resolve({ data: { rows }, isError: false }); });
  expect(api.prepare).not.toHaveBeenCalled(); expect(api.execute).not.toHaveBeenCalled();
});
it('does not start prepare after closing the form while authoritative preflight is pending', async () => {
  const refreshed = deferred<{ data: { rows: typeof rows }; isError: boolean }>(); api.refresh.mockReturnValue(refreshed.promise);
  const { unmount } = setup(); await selectParty(); fireEvent.click(screen.getByRole('button', { name: 'Tạo phiếu ròng' }));
  await waitFor(() => expect(api.refresh).toHaveBeenCalledTimes(1)); unmount();
  await act(async () => { refreshed.resolve({ data: { rows }, isError: false }); });
  expect(api.prepare).not.toHaveBeenCalled(); expect(api.execute).not.toHaveBeenCalled();
});
it('does not submit a previous quote after the support plan revision changes during preflight', async () => {
  const refreshed = deferred<{ data: { rows: typeof rows }; isError: boolean }>(); api.refresh.mockReturnValue(refreshed.promise);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const form = (revision: number) => <QueryClientProvider client={client}><RentSupportPayoutForm organizationId="org1" contractId={contract} plan={{ ...plan, revision }} prefill={prefill} rows={rows as never} refetchRows={api.refresh} /></QueryClientProvider>;
  const { rerender } = render(form(2)); await selectParty(); fireEvent.click(screen.getByRole('button', { name: 'Tạo phiếu ròng' }));
  await waitFor(() => expect(api.refresh).toHaveBeenCalledTimes(1)); rerender(form(3));
  await act(async () => { refreshed.resolve({ data: { rows }, isError: false }); });
  expect(api.prepare).not.toHaveBeenCalled(); expect(api.execute).not.toHaveBeenCalled();
});
it('does not execute a prepared old operation after a parent keyed scope remount', async () => {
  const prepared = deferred<{ operation_id: string; status: string }>(); api.prepare.mockReturnValue(prepared.promise);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const form = (org: string) => <QueryClientProvider client={client}><RentSupportPayoutForm key={org} organizationId={org} contractId={contract} plan={plan} prefill={prefill} rows={rows as never} refetchRows={api.refresh} /></QueryClientProvider>;
  const { rerender } = render(form('org1')); await selectParty(); fireEvent.click(screen.getByRole('button', { name: 'Tạo phiếu ròng' }));
  await waitFor(() => expect(api.prepare).toHaveBeenCalledTimes(1)); rerender(form('org2'));
  await act(async () => { prepared.resolve({ operation_id: operation, status: 'READY' }); });
  expect(api.execute).not.toHaveBeenCalled(); expect(screen.queryByText(/PC-NET/)).toBeNull();
});
it('blocks a stale quote after changing revenue intent until the matching quote resolves', async () => {
  let first!: () => void, second!: () => void;
  api.quote.mockImplementationOnce((org, input) => new Promise(resolve => { first = () => resolve(quote(org, input)); }))
    .mockImplementationOnce((org, input) => new Promise(resolve => { second = () => resolve(quote(org, input)); }));
  setup(); fireEvent.change(screen.getByLabelText('Người hưởng hoa hồng'), { target: { value: party } });
  await waitFor(() => expect(api.quote).toHaveBeenCalledTimes(1));
  fireEvent.change(screen.getByLabelText('Gross hoa hồng'), { target: { value: '1800000' } });
  await waitFor(() => expect(api.quote).toHaveBeenCalledTimes(2));
  first();
  await waitFor(() => expect((screen.getByRole('button', { name: 'Tạo phiếu ròng' }) as HTMLButtonElement).disabled).toBe(true));
  fireEvent.click(screen.getByRole('button', { name: 'Tạo phiếu ròng' })); expect(api.prepare).not.toHaveBeenCalled();
  second(); await waitFor(() => expect((screen.getByRole('button', { name: 'Tạo phiếu ròng' }) as HTMLButtonElement).disabled).toBe(false));
});
it('requires explicit registered payee selection and shows the full upfront commitment and monthly schedule with gross/held/net', async () => {
  setup(); expect((screen.getByLabelText('Người hưởng hoa hồng') as HTMLSelectElement).value).toBe('');
  expect((screen.getByRole('button', { name: 'Tạo phiếu ròng' }) as HTMLButtonElement).disabled).toBe(true);
  await selectParty();
  expect(screen.getByText(/Thu toàn bộ cam kết một lần/)).toBeTruthy(); expect(screen.getByText(/09\/2026/)).toBeTruthy(); expect(screen.getByText(/08\/2027/)).toBeTruthy();
  expect(screen.getByText('Theo thỏa thuận')).toBeTruthy(); expect(screen.getByText('Đã trả hoặc giữ trước')).toBeTruthy(); expect(screen.getByText('Khấu trừ lần này')).toBeTruthy(); expect(screen.getByText('Thực nhận lần này')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Tạo phiếu ròng' }));
  await waitFor(() => expect(api.execute).toHaveBeenCalledWith('org1', operation));
  expect(api.prepare.mock.calls[0][1].payload.intents[0]).toMatchObject({ party_id: party, gross_amount: '3000000' });
  expect(screen.getByText(/PC-NET/)).toBeTruthy();
});
it('blocks review or quote errors and never records an attempt for preview alone', async () => {
  api.quote.mockResolvedValue({ ...quote('org1', { payoutContext: { version: 2, intents: [] } }), state: 'NEEDS_REVIEW', issues: [{ code: 'INSUFFICIENT_CAPACITY', message: 'constraint private' }] });
  setup(); fireEvent.change(screen.getByLabelText('Người hưởng hoa hồng'), { target: { value: party } });
  await screen.findByRole('alert'); expect(screen.queryByText(/constraint private/)).toBeNull();
  expect((screen.getByRole('button', { name: 'Tạo phiếu ròng' }) as HTMLButtonElement).disabled).toBe(true); expect(api.prepare).not.toHaveBeenCalled(); expect(api.execute).not.toHaveBeenCalled();
});
it('shows net zero as settled by support and never asks the legacy writer to create a zero voucher', async () => {
  api.execute.mockResolvedValue(receipt('0'));
  setup(); fireEvent.change(screen.getByLabelText('Gross hoa hồng'), { target: { value: '1800000' } }); await selectParty();
  fireEvent.click(screen.getByRole('button', { name: 'Tạo phiếu ròng' }));
  await screen.findByText(/Đã xử lý bằng hỗ trợ tiền thuê/); expect(api.prepare).toHaveBeenCalledTimes(1); expect(api.retry).not.toHaveBeenCalled();
});
it('keeps a deferred COMMIT result pending in the dialog and explicitly retries the same saved operation', async () => {
  api.execute.mockRejectedValueOnce(new Error('constraint app_private.failed')); api.read.mockResolvedValue({ operation_id: operation, status: 'READY', sources: [] });
  setup(); await selectParty(); fireEvent.click(screen.getByRole('button', { name: 'Tạo phiếu ròng' }));
  await screen.findByRole('alert'); expect(screen.queryByText(/constraint app_private/)).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Tạo lại yêu cầu đã lưu' }));
  await screen.findByText(/PC-NET/); expect(api.prepare).toHaveBeenCalledTimes(1); expect(api.execute.mock.lastCall).toEqual(['org1', operation]);
});
