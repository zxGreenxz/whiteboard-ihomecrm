// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { RentSupportPayoutForm } from './RentSupportPayoutForm';
import type { SupportRead } from '@/lib/rentSupportApi';
import type { PayoutContext } from '@/lib/rentSupportFunding';
const api = vi.hoisted(() => ({ quote: vi.fn(), prepare: vi.fn(), execute: vi.fn(), read: vi.fn(), readRequest: vi.fn(), retry: vi.fn(), refresh: vi.fn(), candidate: vi.fn(), verify: vi.fn() }));
vi.mock('@/lib/rentSupportApi', async original => ({ ...await original<typeof import('@/lib/rentSupportApi')>(), quoteContractRentSupport: api.quote,
  prepareContractPayoutsWithSupport: api.prepare, executeContractPayoutOperation: api.execute, readContractPayoutOperation: api.read, readContractPayoutRequest: api.readRequest,
  readRentSupportDepositCandidate: api.candidate, verifyRentSupportDepositPayee: api.verify }));
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
const sourceId='55555555-5555-4555-8555-555555555555', claimId='66666666-6666-4666-8666-666666666666', depositId='77777777-7777-4777-8777-777777777777', bonusId='88888888-8888-4888-8888-888888888888';
const facts={source_id:sourceId,claim_id:claimId,deposit_voucher_id:depositId,bonus_voucher_id:bonusId,item_ids:[sourceId],approval_version:3,posting_version:4,gross:'500000',proof_hash:'server-proof'};
const template={action:'ADOPT_DEPOSIT_BONUS',kind:'BONUS',source_id:sourceId,party_id:party,gross_amount:'500000',route:'CASHBOOK',manager_id:null,account_id:contract,voucher_date:'2026-09-20',payer_name:'Depositor',recipient_name:'Verified payee',recipient_bank:'Bank',recipient_account:'001',item_description:'Existing bonus',attachments:['existing.pdf'],deposit_claim_id:claimId,deposit_voucher_id:depositId,bonus_voucher_id:bonusId,expected_approval_version:3,expected_posting_version:4,item_ids:[sourceId],source_facts_hash:'server-proof'};
const candidateReady={version:1,state:'READY',plan_revision:2,verification:null,candidate:{...facts,current_net:'500000',already_paid:'0',intent_template:template},issues:[]};
const candidateUnverified={version:1,state:'NEEDS_REVIEW',plan_revision:2,candidate:null,verification:facts,issues:[{code:'PAYEE_UNVERIFIED',message:'private constraint'}]};
function quote(_org: string, input: { payoutContext: PayoutContext }) { return { quote_hash: 'hash', payload_hash: 'payload', plan_revision: 2, payload: plan.financial!.payload, committed_total: '1800000', due_upfront: '1800000', unallocated: '0', state: 'READY', issues: [], months: [], sources: input.payoutContext.intents.map(intent => ({ source_id: intent.source_id ?? (intent.kind === 'BONUS' ? sourceId : party), kind: intent.kind, gross_original: intent.gross_amount, already_paid: '0', prior_withheld: '0', remaining_payable: intent.gross_amount, available_to_withhold: intent.gross_amount, current_withheld: intent.kind === 'BONUS' ? '500000' : '1800000', net_this_operation: intent.kind === 'BONUS' || intent.gross_amount === '1800000' ? '0' : '1200000', origin: intent.source_id ? 'EXISTING' : 'PROPOSED', intent_id: intent.intent_id, route: intent.route })) }; }
function setup(liveRows = rows, currentPlan = plan) { return render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><RentSupportPayoutForm organizationId="org1" contractId={contract} plan={currentPlan} prefill={prefill} rows={liveRows as never} refetchRows={api.refresh} /></QueryClientProvider>); }
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
async function selectParty() { fireEvent.change(screen.getByLabelText('Người hưởng hoa hồng'), { target: { value: party } }); await waitFor(() => expect((screen.getByRole('button', { name: 'Tạo phiếu ròng' }) as HTMLButtonElement).disabled).toBe(false)); }
beforeEach(() => { vi.clearAllMocks(); api.quote.mockReset(); api.prepare.mockReset(); api.execute.mockReset(); api.read.mockReset();
  api.candidate.mockReset(); api.verify.mockReset(); api.candidate.mockResolvedValue({version:1,state:'NO_CANDIDATE',plan_revision:2,candidate:null,verification:null,issues:[]});
  api.verify.mockResolvedValue({binding_id:operation,party_id:party,status:'MANUALLY_VERIFIED',proof_hash:'binding-proof'});
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
it('adopts the exact existing bonus template alongside ISSUE_NEW commission in one durable bundle and settles zero net',async()=>{
 api.candidate.mockResolvedValue(candidateReady);
 api.execute.mockResolvedValue({...receipt(),sources:[{...receipt().sources[0],withheld:'1300000',net:'1700000'},{source_id:sourceId,operation_id:operation,kind:'sale',gross:'500000',withheld:'500000',net:'0',status:'SETTLED_BY_SUPPORT',voucher_id:null,id:null,code:null}]});
 api.quote.mockImplementation((org,input)=>{const result=quote(org,input);return {...result,sources:result.sources.map(source=>source.kind==='COMMISSION'&&input.payoutContext.intents.length===2?{...source,current_withheld:'1300000',net_this_operation:'1700000'}:source)};});
 const existingRows=rows.map(row=>row.kind==='sale'?{...row,state:'VOUCHER_CREATED'}:row);api.refresh.mockResolvedValue({data:{rows:existingRows},isError:false});
 setup(existingRows,{...plan,financial:{...plan.financial!,payload:{...plan.financial!.payload,deduction_policy:'BONUS_THEN_COMMISSION'}}}); await screen.findByLabelText('Sử dụng thưởng cọc hiện có'); await selectParty();
 expect(screen.queryByLabelText('Gross thưởng')).toBeNull();
 fireEvent.click(screen.getByLabelText('Sử dụng thưởng cọc hiện có'));
 fireEvent.change(screen.getByLabelText('Lý do tiếp nhận thưởng cọc'),{target:{value:'Đối chiếu quyền lợi cọc'}});
 await waitFor(()=>expect((screen.getByRole('button',{name:'Tạo phiếu ròng'}) as HTMLButtonElement).disabled).toBe(false));
 expect(screen.getByText('1.300.000 đ')).toBeTruthy();expect(screen.getByText('1.700.000 đ')).toBeTruthy();
 fireEvent.click(screen.getByRole('button',{name:'Tạo phiếu ròng'}));
 await screen.findByText(/Đã xử lý bằng hỗ trợ tiền thuê/);
 const payload=api.prepare.mock.calls[0][1].payload;
 expect(payload.version).toBe(3); expect(payload.intents).toHaveLength(2);
 expect(payload.intents[0]).toMatchObject({action:'ISSUE_NEW',kind:'COMMISSION',source_id:null,gross_amount:'3000000',party_id:party});
 expect(payload.intents[1]).toEqual({...template,intent_id:expect.any(String),reason:'Đối chiếu quyền lợi cọc'});
 expect(api.prepare).toHaveBeenCalledTimes(1);expect(api.verify).not.toHaveBeenCalled(); expect(api.retry).not.toHaveBeenCalled();
});
it('retries a saved uncertain adoption bundle without minting new request, intent or source identities',async()=>{
 api.candidate.mockResolvedValue(candidateReady);api.execute.mockRejectedValueOnce(new Error('lost commit'));api.read.mockResolvedValueOnce({operation_id:operation,status:'READY',sources:[]});
 setup();await screen.findByLabelText('Sử dụng thưởng cọc hiện có');await selectParty();fireEvent.click(screen.getByLabelText('Sử dụng thưởng cọc hiện có'));
 fireEvent.change(screen.getByLabelText('Lý do tiếp nhận thưởng cọc'),{target:{value:'Đối chiếu quyền lợi cọc'}});
 await waitFor(()=>expect((screen.getByRole('button',{name:'Tạo phiếu ròng'}) as HTMLButtonElement).disabled).toBe(false));fireEvent.click(screen.getByRole('button',{name:'Tạo phiếu ròng'}));
 await screen.findByRole('button',{name:'Tạo lại yêu cầu đã lưu'});const saved=api.prepare.mock.calls[0][1];expect(saved.payload.intents[1]).toMatchObject({source_id:sourceId,deposit_claim_id:claimId,bonus_voucher_id:bonusId});
 api.read.mockResolvedValue({operation_id:operation,status:'READY',sources:[]});fireEvent.click(screen.getByRole('button',{name:'Tạo lại yêu cầu đã lưu'}));await screen.findByText(/PC-NET/);
 expect(api.prepare).toHaveBeenCalledTimes(1);expect(api.execute).toHaveBeenCalledTimes(2);expect(api.execute.mock.lastCall).toEqual(['org1',operation]);expect(api.retry).not.toHaveBeenCalled();
});
it('requires an explicit registered party, reason and exact-claim confirmation before verification, without any payout write',async()=>{
 api.candidate.mockResolvedValueOnce(candidateUnverified).mockResolvedValue(candidateReady);
 setup(); const select=await screen.findByLabelText('Người hưởng thưởng cọc');
 expect((select as HTMLSelectElement).value).toBe(''); expect(screen.queryByText('private constraint')).toBeNull();
 const confirm=screen.getByRole('button',{name:'Xác nhận người hưởng thưởng cọc'}) as HTMLButtonElement;
 expect(confirm.disabled).toBe(true);
 fireEvent.change(select,{target:{value:party}});fireEvent.change(screen.getByLabelText('Lý do xác nhận người hưởng'),{target:{value:'Đã đối chiếu người hưởng'}});
 expect(confirm.disabled).toBe(true);fireEvent.click(screen.getByLabelText('Đã đối chiếu đúng yêu cầu và phiếu cọc'));
 fireEvent.click(confirm);await screen.findByLabelText('Sử dụng thưởng cọc hiện có');
 expect(api.verify).toHaveBeenCalledWith('org1',{contractId:contract,claimId,depositVoucherId:depositId,bonusVoucherId:bonusId,partyId:party,expectedApprovalVersion:3,expectedPostingVersion:4,sourceFactsHash:'server-proof',reason:'Đã đối chiếu người hưởng',requestId:expect.any(String)});
 expect(api.prepare).not.toHaveBeenCalled();expect(api.execute).not.toHaveBeenCalled();expect(api.candidate).toHaveBeenCalledTimes(2);
});
it('retains the exact verification request after a lost response and retries it explicitly without creating payouts',async()=>{
 api.candidate.mockResolvedValue(candidateUnverified); api.verify.mockRejectedValueOnce(new Error('constraint private.failed'));
 setup();fireEvent.change(await screen.findByLabelText('Người hưởng thưởng cọc'),{target:{value:party}});
 fireEvent.change(screen.getByLabelText('Lý do xác nhận người hưởng'),{target:{value:'Đã đối chiếu người hưởng'}});fireEvent.click(screen.getByLabelText('Đã đối chiếu đúng yêu cầu và phiếu cọc'));
 fireEvent.click(screen.getByRole('button',{name:'Xác nhận người hưởng thưởng cọc'}));
 const retry=await screen.findByRole('button',{name:'Thử lại xác nhận đã lưu'}); const original=api.verify.mock.calls[0][1];
 expect(screen.queryByText(/private.failed/)).toBeNull();api.candidate.mockResolvedValue(candidateReady);fireEvent.click(retry);
 await screen.findByLabelText('Sử dụng thưởng cọc hiện có');expect(api.verify.mock.calls[1][1]).toEqual(original);expect(api.prepare).not.toHaveBeenCalled();
});
it('does not continue candidate read after verification resolves on a closed form',async()=>{
 api.candidate.mockResolvedValue(candidateUnverified);const verified=deferred<unknown>();api.verify.mockReturnValue(verified.promise);
 const {unmount}=setup();fireEvent.change(await screen.findByLabelText('Người hưởng thưởng cọc'),{target:{value:party}});
 fireEvent.change(screen.getByLabelText('Lý do xác nhận người hưởng'),{target:{value:'Đã đối chiếu người hưởng'}});fireEvent.click(screen.getByLabelText('Đã đối chiếu đúng yêu cầu và phiếu cọc'));
 fireEvent.click(screen.getByRole('button',{name:'Xác nhận người hưởng thưởng cọc'}));await waitFor(()=>expect(api.verify).toHaveBeenCalledTimes(1));unmount();
 await act(async()=>{verified.resolve({binding_id:operation,party_id:party,status:'MANUALLY_VERIFIED',proof_hash:'binding-proof'});});
 expect(api.candidate).toHaveBeenCalledTimes(1);expect(api.prepare).not.toHaveBeenCalled();
});
it('does not turn a failed candidate read into no candidate or allow a financial submit',async()=>{
 api.candidate.mockRejectedValue(new Error('permission private'));setup();fireEvent.change(screen.getByLabelText('Người hưởng hoa hồng'),{target:{value:party}});
 await screen.findByText(/Chưa đọc được thưởng cọc/);expect((screen.getByRole('button',{name:'Tạo phiếu ròng'}) as HTMLButtonElement).disabled).toBe(true);
 expect(screen.queryByText(/permission private/)).toBeNull();expect(api.prepare).not.toHaveBeenCalled();
});
it('does not offer new bonus or block valid commission when the existing deposit bonus is paid',async()=>{
 api.candidate.mockResolvedValue({version:1,state:'NEEDS_REVIEW',plan_revision:2,candidate:null,verification:null,issues:[{code:'DEPOSIT_ALREADY_PAID',message:'private'}]});
 setup();await screen.findByText(/Thưởng cọc đã trả/);expect(screen.queryByLabelText('Gross thưởng')).toBeNull();await selectParty();
 fireEvent.click(screen.getByRole('button',{name:'Tạo phiếu ròng'}));await screen.findByText(/PC-NET/);
 expect(api.prepare.mock.calls[0][1].payload.intents).toHaveLength(1);expect(api.prepare.mock.calls[0][1].payload.intents[0].kind).toBe('COMMISSION');
});
it('blocks stale candidate revisions even when the current commission quote is ready',async()=>{
 api.candidate.mockResolvedValue({...candidateReady,plan_revision:1});setup();fireEvent.change(screen.getByLabelText('Người hưởng hoa hồng'),{target:{value:party}});
 await screen.findByText(/Thưởng cọc chưa khớp phiên bản/);expect((screen.getByRole('button',{name:'Tạo phiếu ròng'}) as HTMLButtonElement).disabled).toBe(true);expect(api.prepare).not.toHaveBeenCalled();
});
it.each(['changed','error'])('does not prepare adoption after the canonical candidate refetch is %s',async state=>{
 api.candidate.mockResolvedValueOnce(candidateReady);
 if(state==='changed')api.candidate.mockResolvedValue({...candidateReady,candidate:{...candidateReady.candidate,posting_version:5,intent_template:{...template,expected_posting_version:5}}});
 else api.candidate.mockRejectedValue(new Error('private read'));
 setup();await screen.findByLabelText('Sử dụng thưởng cọc hiện có');await selectParty();fireEvent.click(screen.getByLabelText('Sử dụng thưởng cọc hiện có'));
 fireEvent.change(screen.getByLabelText('Lý do tiếp nhận thưởng cọc'),{target:{value:'Đối chiếu quyền lợi cọc'}});
 await waitFor(()=>expect((screen.getByRole('button',{name:'Tạo phiếu ròng'}) as HTMLButtonElement).disabled).toBe(false));
 fireEvent.click(screen.getByRole('button',{name:'Tạo phiếu ròng'}));await screen.findByText(/Nguồn thưởng cọc đã thay đổi/);
 expect(api.prepare).not.toHaveBeenCalled();expect(api.execute).not.toHaveBeenCalled();
});
it('does not prepare after the form closes during deferred candidate preflight read',async()=>{
 const reading=deferred<unknown>();api.candidate.mockResolvedValueOnce(candidateReady).mockReturnValue(reading.promise);
 const {unmount}=setup();await screen.findByLabelText('Sử dụng thưởng cọc hiện có');await selectParty();fireEvent.click(screen.getByRole('button',{name:'Tạo phiếu ròng'}));
 await waitFor(()=>expect(api.candidate).toHaveBeenCalledTimes(2));unmount();await act(async()=>{reading.resolve(candidateReady);});expect(api.prepare).not.toHaveBeenCalled();
});
it('requires a new exact-claim confirmation when verification facts change before submitting',async()=>{
 api.candidate.mockResolvedValueOnce(candidateUnverified).mockResolvedValue({...candidateUnverified,verification:{...facts,posting_version:5,proof_hash:'changed-proof'}});
 const client=new QueryClient({defaultOptions:{queries:{retry:false}}});render(<QueryClientProvider client={client}><RentSupportPayoutForm organizationId="org1" contractId={contract} plan={plan} prefill={prefill} rows={rows as never} refetchRows={api.refresh}/></QueryClientProvider>);
 fireEvent.change(await screen.findByLabelText('Người hưởng thưởng cọc'),{target:{value:party}});fireEvent.change(screen.getByLabelText('Lý do xác nhận người hưởng'),{target:{value:'Đã đối chiếu người hưởng'}});fireEvent.click(screen.getByLabelText('Đã đối chiếu đúng yêu cầu và phiếu cọc'));
 await act(async()=>{await client.invalidateQueries({queryKey:['rent-support-deposit-candidate']});});
 await waitFor(()=>expect((screen.getByRole('button',{name:'Xác nhận người hưởng thưởng cọc'}) as HTMLButtonElement).disabled).toBe(true));expect(api.verify).not.toHaveBeenCalled();
});
it('does not apply late verification candidate read to a remounted organization scope',async()=>{
 const reading=deferred<unknown>();api.candidate.mockResolvedValueOnce(candidateUnverified).mockReturnValueOnce(reading.promise).mockResolvedValue({version:1,state:'NO_CANDIDATE',plan_revision:2,candidate:null,verification:null,issues:[]});
 const client=new QueryClient({defaultOptions:{queries:{retry:false}}});const form=(org:string)=><QueryClientProvider client={client}><RentSupportPayoutForm key={org} organizationId={org} contractId={contract} plan={plan} prefill={prefill} rows={rows as never} refetchRows={api.refresh}/></QueryClientProvider>;
 const {rerender}=render(form('org1'));fireEvent.change(await screen.findByLabelText('Người hưởng thưởng cọc'),{target:{value:party}});fireEvent.change(screen.getByLabelText('Lý do xác nhận người hưởng'),{target:{value:'Đã đối chiếu người hưởng'}});fireEvent.click(screen.getByLabelText('Đã đối chiếu đúng yêu cầu và phiếu cọc'));
 fireEvent.click(screen.getByRole('button',{name:'Xác nhận người hưởng thưởng cọc'}));await waitFor(()=>expect(api.candidate).toHaveBeenCalledTimes(2));rerender(form('org2'));await act(async()=>{reading.resolve(candidateReady);});
 expect(screen.queryByLabelText('Sử dụng thưởng cọc hiện có')).toBeNull();expect(screen.queryByRole('button',{name:'Thử lại xác nhận đã lưu'})).toBeNull();expect(api.prepare).not.toHaveBeenCalled();
});
