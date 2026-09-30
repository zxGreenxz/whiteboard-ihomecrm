// @vitest-environment jsdom
//
// Modal "Tạo phiếu chi hoa hồng" — bug 15/09/2026: tạo HĐ xong modal mở, đang
// gõ thì ~1–2,5 giây sau form tự xoá sạch, có lần kẹt luôn ở dòng "Đang tải
// thông tin hợp đồng...".
//
// Chuỗi thật: create_contract_v2 ghi ≥5 bảng trong publication realtime ⇒ hub
// debounce 800 ms (trần 2,4 s) rồi invalidate hàng loạt key, trong đó có
// ["commission-prefill"] khai nhầm ở descriptor income_expenses ⇒ prefill
// refetch ⇒ trả về OBJECT MỚI ⇒ effect `[open, prefill]` reset MỌI ô người dùng
// đang gõ. Nếu cú refetch đó lỗi thì hook cũ trả null trong trạng thái success
// và modal kẹt ở dòng "Đang tải".
//
// Hai bài đầu khoá đúng hai hệ quả đó ở tầng giao diện.
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { CommissionPrefillData } from "@/hooks/useCommissionVoucher";

const state = vi.hoisted(() => ({
  prefill: undefined as unknown,
  isPending: false,
  isError: false,
  refetch: vi.fn(),
  create: vi.fn(),
  prepare: vi.fn(),
  assign: vi.fn(),
  order: [] as string[],
  accounts: [] as unknown[],
  voucherError: false,
  voucherLoading: false,
  supportKind: 'LEGACY', supportReadEnabled: false,
  followups: [] as { kind: string; state: string; can_manage: boolean; request_id?: string; can_retry?: boolean; last_reason?: string }[],
}));
vi.mock('@/hooks/useContractRentSupport', () => ({ useContractRentSupport: (filter: { enabled?: boolean; contractIds?: string[] }) => {
  state.supportReadEnabled = !!filter.enabled;
  return { data: { rows: [{ contract_id: filter.contractIds?.[0], kind: state.supportKind, financial: { payload: {} } }] }, isLoading: false, isError: false, refetch: vi.fn() };
} }));
vi.mock('../RentSupportPayoutForm', () => ({ RentSupportPayoutForm: () => <div>Phiếu hỗ trợ ròng canonical</div> }));

vi.mock("@/hooks/useCommissionVoucher", () => ({
  useCommissionPrefill: () => ({
    data: state.prefill,
    isPending: state.isPending,
    isLoading: state.isPending,
    isError: state.isError,
    error: state.isError ? new Error("Không đọc được hợp đồng") : null,
    refetch: state.refetch,
  }),
  useCreateCommissionVoucher: () => ({ mutateAsync: state.create, isPending: false }),
  useRetryCommissionVoucher: () => ({ mutateAsync: state.create, isPending: false }),
  usePrepareCommissionVouchers: () => ({ mutateAsync: state.prepare, isPending: false }),
  useExistingCommissionVouchers: () => ({ data: [], isError: state.voucherError, isLoading: state.voucherLoading,
    refetch: async () => ({ data: [], isError: state.voucherError }) }),
}));
vi.mock('@/hooks/useContractCommissionFollowup', () => ({ useContractCommissionFollowups: () => ({
  data: { rows: state.followups }, isError: false, isLoading: false, refetch: state.refetch,
}) }));
vi.mock("@/hooks/useSaleBonus", () => ({ useSaleBonusStatus: () => ({ data: null, refetch: async () => ({ data: null }) }) }));
vi.mock('@/hooks/useCommissionManager', () => ({ assignCommissionManager: state.assign, invalidateAfterCommissionAssign: vi.fn(), useOptionalQueryClient: () => undefined }));
vi.mock('@/components/income-expenses/QlManagerSelect', () => ({ QlManagerSelectForBuilding: ({ id, name, error, onPick }: { id: string; name?:string; error?:string; onPick: (manager: { staffId: string; displayName: string }) => void }) =>
  <div><button id={id} name={name} role="combobox" aria-label="Chọn quản lý nhận hoa hồng" aria-invalid={!!error} onClick={() => onPick({ staffId: id.includes('broker') ? 'manager-broker' : 'manager-sale', displayName: 'Quản lý đã chọn' })}>Chọn quản lý</button>{error&&<p role="alert">{error}</p>}</div> }));
vi.mock("@/hooks/useAccounts", () => ({ useAccounts: () => ({ data: state.accounts }) }));
vi.mock("@/hooks/useAuth", () => ({ useAuth: () => ({ data: { id: "u1" } }) }));
vi.mock('@/contexts/OrganizationContext', () => ({ useOrganization: () => ({ selectedOrganizationId: 'org1' }) }));
vi.mock("@/components/income-expenses/BankSelect", () => ({ default: () => null }));
vi.mock("@/components/income-expenses/AttachmentUpload", () => ({ default: () => null }));
vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn(), info: vi.fn() } }));

import { CommissionVoucherModal } from "../CommissionVoucherModal";
import { toast } from 'sonner';

vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });

/** Mỗi lần gọi trả về một OBJECT MỚI, giá trị y hệt — đúng thứ refetch tạo ra. */
const prefillMoi = (): CommissionPrefillData => ({
  contract_id: "c1",
  contract_number: "HD-001",
  signed_date: "2026-09-15",
  start_date: "2026-09-15",
  end_date: "2027-09-14",
  rent_price: 5_000_000,
  months: 12,
  matched_tier: { min_months: 6, max_months: 12, rate_percent: 50 } as CommissionPrefillData["matched_tier"],
  building_id: "b1",
  building_name: "Toà A",
  room_id: "r1",
  room_name: "P101",
  tenant_id: "k1",
  tenant_name: "Khách A",
});

const oTenMG = () => screen.getByPlaceholderText("Tên công ty / cá nhân môi giới") as HTMLInputElement;

beforeEach(() => {
  state.prefill = prefillMoi();
  state.isPending = false;
  state.isError = false;
  state.voucherError = false;
  state.voucherLoading = false;
  state.supportKind = 'LEGACY'; state.supportReadEnabled = false;
  state.followups = ['broker', 'sale'].map(kind => ({ kind, state: 'PENDING', can_manage: true }));
  state.refetch.mockReset();
  state.refetch.mockImplementation(async () => ({ data: { rows: state.followups }, isError: state.voucherError }));
  state.create.mockReset();
  state.assign.mockReset();
  vi.mocked(toast.error).mockClear();
  state.order = [];
  state.prepare.mockReset();
  state.prepare.mockImplementation(async (inputs: { kind: string; contract_id: string }[]) => {
    state.order.push('prepare'); return inputs.map(input => ({ contract_id: input.contract_id, kind: input.kind, request_id: `request-${input.kind}` }));
  });
  state.accounts = [{ id: "acc-toa-a", name: "Toà A", is_default: false }, { id: "acc-khac", name: "Sổ khác", is_default: true }];
});
afterEach(cleanup);
it('routes a v2 support contract to the net payout form instead of legacy prepare', () => {
  state.supportKind = 'V2';
  render(<CommissionVoucherModal open contractId="c1" onOpenChange={() => {}} />);
  expect(screen.getByText('Phiếu hỗ trợ ròng canonical')).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Tạo phiếu chi' })).toBeNull(); expect(state.prepare).not.toHaveBeenCalled();
});
it('does not request financial support detail or render the net form for a contract-only viewer', () => {
  state.supportKind = 'V2'; state.followups = state.followups.map(row => ({ ...row, can_manage: false }));
  render(<CommissionVoucherModal open contractId="c1" onOpenChange={() => {}} />);
  expect(state.supportReadEnabled).toBe(false); expect(screen.queryByText('Phiếu hỗ trợ ròng canonical')).toBeNull();
});
it('redacts raw database diagnostics from a saved modal request reason', () => {
  state.followups[0] = { kind: 'broker', state: 'FAILED', can_manage: true, can_retry: true, request_id: 'saved', last_reason: 'insert constraint app_private.finance 11111111-1111-4111-8111-111111111111' };
  render(<CommissionVoucherModal open contractId="c1" onOpenChange={() => {}} />);
  expect(screen.queryByText(/insert constraint/)).toBeNull(); expect(screen.getByText(/kiểm tra sổ quỹ hoặc dữ liệu/)).toBeTruthy();
});

it("refetch prefill (object mới) KHÔNG xoá ô người dùng đang gõ", () => {
  const { rerender } = render(<CommissionVoucherModal open contractId="c1" onOpenChange={() => {}} />);

  fireEvent.change(oTenMG(), { target: { value: "MG Bình Minh" } });
  expect(oTenMG().value).toBe("MG Bình Minh");

  // Hub realtime đánh thức prefill: cùng dữ liệu, KHÁC identity.
  state.prefill = prefillMoi();
  rerender(<CommissionVoucherModal open contractId="c1" onOpenChange={() => {}} />);

  expect(oTenMG().value).toBe("MG Bình Minh");
});

it("prefill lỗi thì báo lỗi và cho tải lại, không kẹt ở dòng 'Đang tải'", () => {
  state.prefill = undefined;
  state.isError = true;
  render(<CommissionVoucherModal open contractId="c1" onOpenChange={() => {}} />);

  expect(screen.queryByText(/Đang tải thông tin hợp đồng/)).toBeNull();
  expect(screen.getByText(/Không tải được thông tin hợp đồng/)).toBeTruthy();

  state.refetch.mockClear();
  fireEvent.click(screen.getByRole("button", { name: "Tải lại" }));
  expect(state.refetch).toHaveBeenCalledTimes(1);
});

it("đang tải thì hiện dòng chờ và vẫn bỏ qua được", () => {
  state.prefill = undefined;
  state.isPending = true;
  const close = vi.fn();
  render(<CommissionVoucherModal open contractId="c1" onOpenChange={close} />);

  expect(screen.getByText(/Đang tải thông tin hợp đồng/)).toBeTruthy();
  const boQua = screen.getByRole("button", { name: "Để xử lý sau" }) as HTMLButtonElement;
  expect(boQua.disabled).toBe(false);
  fireEvent.click(boQua);
  expect(close).toHaveBeenCalledWith(false);
});

it('lỗi đọc phiếu hiện có phải chặn tạo và cho đối chiếu lại', () => {
  state.voucherError = true;
  render(<CommissionVoucherModal open contractId="c1" onOpenChange={() => {}} />);
  expect((screen.getByRole('button', { name: 'Tạo phiếu chi' }) as HTMLButtonElement).disabled).toBe(true);
  expect(screen.getByText(/Chưa đối chiếu được phiếu hiện có/)).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Để xử lý sau' })).toBeTruthy();
});

it('không tạo lại môi giới đã quyết định không phát sinh khi đang xử lý Sale', async () => {
  state.followups[0].state = 'NOT_APPLICABLE';
  state.create.mockResolvedValue({ id: 'sale-voucher', code: 'PC-SALE' });
  render(<CommissionVoucherModal open contractId="c1" onOpenChange={() => {}} />);
  fireEvent.change(screen.getByPlaceholderText('Để trống nếu không có'), { target: { value: '500000' } });
  fireEvent.click(screen.getByRole('button', { name: 'Tạo phiếu chi' }));
  await waitFor(() => expect(state.create).toHaveBeenCalledTimes(1));
  expect(state.create.mock.calls[0][0].kind).toBe('sale');
});

it('failure while modal remains open hides saved Sale fields and explicitly retries the same request', async () => {
  state.create.mockResolvedValueOnce({ status:'COMPLETED', id: 'broker-voucher', code: 'PC-BROKER' }).mockImplementationOnce(async () => {
    state.followups=[{kind:'broker',state:'VOUCHER_CREATED',can_manage:true},{kind:'sale',state:'FAILED',can_manage:true,can_retry:true,request_id:'request-sale'}];
    throw new Error('lỗi Sale');
  }).mockResolvedValueOnce({ status:'COMPLETED',id: 'sale-voucher', code: 'PC-SALE' });
  const close=vi.fn();render(<CommissionVoucherModal open contractId="c1" onOpenChange={close} />);
  fireEvent.change(screen.getByPlaceholderText('Để trống nếu không có'),{target:{value:'500000'}});
  fireEvent.click(screen.getByRole('button',{name:'Tạo phiếu chi'}));
  await waitFor(()=>expect(screen.queryByPlaceholderText('Để trống nếu không có')).toBeNull());
  await waitFor(()=>expect(screen.getByRole('button',{name:'Tạo lại thưởng Sale'})).toBeTruthy());
  expect(close).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button',{name:'Tạo lại thưởng Sale'}));
  await waitFor(()=>expect(state.create).toHaveBeenCalledTimes(3));
  expect(state.prepare).toHaveBeenCalledOnce();
  expect(state.create.mock.calls[2][0]).toEqual({contract_id:'c1',kind:'sale',request_id:'request-sale'});
});

it('phản hồi tạo phiếu A không được đánh dấu có phiếu hoặc đóng popup B đang mở', async () => {
  let finish!: (value: { id: string; code: string }) => void;
  state.create.mockReturnValue(new Promise(resolve => { finish = resolve; }));
  const close = vi.fn();
  const { rerender } = render(<CommissionVoucherModal open contractId="c1" onOpenChange={close} />);
  fireEvent.click(screen.getByRole('button', { name: 'Tạo phiếu chi' }));
  await waitFor(() => expect(state.create).toHaveBeenCalledTimes(1));
  rerender(<CommissionVoucherModal open={false} contractId="c1" onOpenChange={close} />);
  state.prefill = { ...prefillMoi(), contract_id: 'c2', contract_number: 'HD-002' };
  rerender(<CommissionVoucherModal open contractId="c2" onOpenChange={close} />);
  await act(async () => { finish({ id: 'broker-a', code: 'PC-A' }); });
  await waitFor(() => expect((screen.getByRole('button', { name: 'Tạo phiếu chi' }) as HTMLButtonElement).disabled).toBe(false));
  expect(close).not.toHaveBeenCalled();
  expect(oTenMG()).toBeTruthy();
});

it("sổ quỹ mặc định lấy từ danh sách sổ quỹ của modal, kể cả khi sổ về sau prefill", () => {
  state.accounts = [];
  const { rerender } = render(<CommissionVoucherModal open contractId="c1" onOpenChange={() => {}} />);

  // Sổ quỹ về sau prefill — vẫn phải chọn được sổ cùng tên toà.
  state.accounts = [{ id: "acc-toa-a", name: "toà a", is_default: false }];
  rerender(<CommissionVoucherModal open contractId="c1" onOpenChange={() => {}} />);

  expect(screen.getByText("Mặc định: sổ quỹ cùng tên với tòa nhà.")).toBeTruthy();
});

it('saves both selected positive intents before executing either kind', async () => {
  state.create.mockImplementation(async (input: { kind: string }) => { state.order.push(input.kind); return { status: 'COMPLETED', id: 'v', code: 'PC' }; });
  render(<CommissionVoucherModal open contractId="c1" onOpenChange={() => {}} />);
  fireEvent.change(screen.getByPlaceholderText('Để trống nếu không có'), { target: { value: '500000' } });
  fireEvent.click(screen.getByRole('button', { name: 'Tạo phiếu chi' }));
  await waitFor(() => expect(state.order).toEqual(['prepare', 'broker', 'sale']));
  expect(state.prepare.mock.calls[0][0].map((input: { kind: string }) => input.kind)).toEqual(['broker', 'sale']);
  expect(state.create.mock.calls[1][0]).toEqual({contract_id:'c1',kind:'sale',request_id:'request-sale'});
});
it('failed prepare cannot execute any voucher', async () => {
  state.prepare.mockRejectedValue(new Error('Không lưu được'));
  render(<CommissionVoucherModal open contractId="c1" onOpenChange={() => {}} />);
  fireEvent.click(screen.getByRole('button', { name: 'Tạo phiếu chi' }));
  await waitFor(() => expect(state.prepare).toHaveBeenCalled());
  expect(state.create).not.toHaveBeenCalled();
});
it('legacy failed-kind modal contains only selected Sale inputs', () => {
  render(<CommissionVoucherModal open contractId="c1" onlyKind="sale" onOpenChange={() => {}} />);
  expect(screen.queryByPlaceholderText('Tên công ty / cá nhân môi giới')).toBeNull();
  expect(screen.getByPlaceholderText('Để trống nếu không có')).toBeTruthy();
});
it('legacy failure with event request id but no saved payload prepares a fresh selected-kind request', async () => {
  state.followups = [{ kind: 'broker', state: 'FAILED', can_manage: true, request_id: 'legacy-event', can_retry: false },
    { kind: 'sale', state: 'PENDING', can_manage: true }];
  state.create.mockResolvedValue({ status: 'COMPLETED', id: 'new-voucher', code: 'PC-NEW' });
  render(<CommissionVoucherModal open contractId="c1" onlyKind="broker" onOpenChange={() => {}} />);
  fireEvent.click(screen.getByRole('button', { name: 'Tạo phiếu chi' }));
  await waitFor(() => expect(state.prepare).toHaveBeenCalledOnce());
  expect(state.prepare.mock.calls[0][0].map((input: { kind: string }) => input.kind)).toEqual(['broker']);
  await waitFor(() => expect(state.create).toHaveBeenCalledOnce());
});
it('fresh failure reading authoritative status on submit prevents issuance', async () => {
  render(<CommissionVoucherModal open contractId="c1" onOpenChange={() => {}} />);
  state.refetch.mockResolvedValue({ isError: true });
  fireEvent.click(screen.getByRole('button', { name: 'Tạo phiếu chi' }));
  await waitFor(() => expect(state.refetch).toHaveBeenCalled());
  expect(state.create).not.toHaveBeenCalled(); expect(state.prepare).not.toHaveBeenCalled();
});
it('missing authoritative kind on submit reports read uncertainty instead of silently closing', async () => {
  const close = vi.fn();
  render(<CommissionVoucherModal open contractId="c1" onOpenChange={close} />);
  state.refetch.mockResolvedValue({ data: { rows: [] }, isError: false });
  fireEvent.click(screen.getByRole('button', { name: 'Tạo phiếu chi' }));
  await waitFor(() => expect(vi.mocked(toast.error)).toHaveBeenCalled());
  expect(state.prepare).not.toHaveBeenCalled(); expect(state.create).not.toHaveBeenCalled(); expect(close).not.toHaveBeenCalled();
});

it('broker durable FAILED + sale PENDING shows immutable retry and submits only new Sale edits', async () => {
  state.followups[0]={kind:'broker',state:'FAILED',can_manage:true,can_retry:true,request_id:'saved-broker'};
  state.create.mockResolvedValue({status:'COMPLETED',id:'v',code:'PC'});
  render(<CommissionVoucherModal open contractId="c1" onOpenChange={()=>{}} />);
  expect(screen.queryByPlaceholderText('Tên công ty / cá nhân môi giới')).toBeNull();
  expect(screen.queryByText('Số tiền hoa hồng *')).toBeNull();
  expect(screen.queryByText('Sổ quỹ (chi hoa hồng MG)')).toBeNull();
  expect(document.getElementById('hh-broker-ql')).toBeNull();
  expect(screen.getByRole('button',{name:'Tạo lại hoa hồng môi giới'})).toBeTruthy();
  fireEvent.change(screen.getByPlaceholderText('Để trống nếu không có'),{target:{value:'700000'}});
  fireEvent.click(screen.getByRole('button',{name:'Tạo phiếu chi'}));
  await waitFor(()=>expect(state.create).toHaveBeenCalledOnce());
  expect(state.prepare.mock.calls[0][0]).toMatchObject([{kind:'sale',amount:700000}]);
  expect(state.create.mock.calls[0][0].kind).toBe('sale');
});
it.each(['broker','sale'])('explicit %s saved retry ignores form and reuses exact identity', async kind=>{
  state.followups=state.followups.map(row=>row.kind===kind?{...row,state:'FAILED',request_id:`saved-${kind}`,can_retry:true}:row);
  state.create.mockResolvedValue({status:'COMPLETED',id:'v',code:'PC'});
  render(<CommissionVoucherModal open contractId="c1" onOpenChange={()=>{}} />);
  fireEvent.click(screen.getByRole('button',{name:kind==='broker'?'Tạo lại hoa hồng môi giới':'Tạo lại thưởng Sale'}));
  await waitFor(()=>expect(state.create).toHaveBeenCalledOnce());
  expect(state.create.mock.calls[0][0]).toEqual({contract_id:'c1',kind,request_id:`saved-${kind}`});
  expect(state.prepare).not.toHaveBeenCalled();expect(state.assign).not.toHaveBeenCalled();
});
it.each(['FAILED','PROCESSING'])('fresh %s transition stops stale edited form and exposes saved state', async status=>{
  render(<CommissionVoucherModal open contractId="c1" onOpenChange={()=>{}} />);
  fireEvent.change(oTenMG(),{target:{value:'Edited recipient'}});
  state.followups[0]={kind:'broker',state:status,can_manage:true,request_id:'other-tab-request',can_retry:status==='FAILED'};
  fireEvent.click(screen.getByRole('button',{name:'Tạo phiếu chi'}));
  await waitFor(()=>expect(screen.queryByPlaceholderText('Tên công ty / cá nhân môi giới')).toBeNull());
  expect(state.create).not.toHaveBeenCalled();expect(state.prepare).not.toHaveBeenCalled();
  expect(toast.error).toHaveBeenCalled();
});
it.each(['COMPLETED','ALREADY_EXISTS'])('saves both selected managers and performs no client assignment on %s',async status=>{
  state.create.mockResolvedValue({status,id:'winning-voucher',code:'PC'});
  render(<CommissionVoucherModal open contractId="c1" onOpenChange={()=>{}} />);
  fireEvent.change(screen.getByPlaceholderText('Để trống nếu không có'),{target:{value:'500000'}});
  for(const id of ['hh-broker-ql','hh-sale-ql']) fireEvent.click(document.getElementById(id)!);
  for(const button of screen.getAllByText('Chọn quản lý')) fireEvent.click(button);
  fireEvent.click(screen.getByRole('button',{name:'Tạo phiếu chi'}));
  await waitFor(()=>expect(state.create).toHaveBeenCalledTimes(2));
  expect(state.prepare.mock.calls[0][0]).toMatchObject([{kind:'broker',manager_id:'manager-broker'},{kind:'sale',manager_id:'manager-sale'}]);
  expect(state.assign).not.toHaveBeenCalled();
});

it('D17 thiếu quản lý đỏ/focus đúng selector trước prepare/execute',async()=>{
 render(<CommissionVoucherModal open contractId="c1" onOpenChange={()=>{}}/>);
 fireEvent.click(screen.getAllByRole('checkbox',{name:'Người nhận là quản lý (QL)'})[0]);
 fireEvent.click(screen.getByRole('button',{name:'Tạo phiếu chi'}));
 const field=screen.getByRole('combobox',{name:'Chọn quản lý nhận hoa hồng'});
 await waitFor(()=>expect(document.activeElement).toBe(field));
 expect(field.getAttribute('aria-invalid')).toBe('true');expect(screen.getByText('Chọn quản lý nhận hoa hồng.')).toBeTruthy();
 expect(state.prepare).not.toHaveBeenCalled();expect(state.create).not.toHaveBeenCalled();
});
it('D17 prepare bị từ chối quyền giữ draft và một lỗi an toàn',async()=>{
 state.prepare.mockRejectedValue({code:'42501',message:'permission denied income_expenses SQLSTATE'});
 const close=vi.fn();render(<CommissionVoucherModal open contractId="c1" onOpenChange={close}/>);
 fireEvent.change(oTenMG(),{target:{value:'Giữ người nhận đang nhập'}});
 fireEvent.click(screen.getByRole('button',{name:'Tạo phiếu chi'}));
 const alert=await screen.findByRole('alert');expect(alert.textContent).toContain('Không đủ quyền');
 expect(alert.textContent).not.toMatch(/SQLSTATE|income_expenses|permission denied/);
 expect(oTenMG().value).toBe('Giữ người nhận đang nhập');expect(close).not.toHaveBeenCalled();
 expect(state.create).not.toHaveBeenCalled();expect(toast.error).toHaveBeenCalledOnce();
});
it('D17 Sale timeout giữ broker receipt rồi retry chỉ request Sale đã lưu',async()=>{
 state.create.mockResolvedValueOnce({status:'COMPLETED',id:'broker-voucher',code:'PC-BROKER'}).mockImplementationOnce(async()=>{
  state.followups=[{kind:'broker',state:'VOUCHER_CREATED',can_manage:true},{kind:'sale',state:'UNKNOWN',can_manage:true,can_retry:true,request_id:'request-sale'}];
  throw new TypeError('Failed to fetch');
 }).mockResolvedValueOnce({status:'ALREADY_EXISTS',id:'sale-voucher',code:'PC-SALE'});
 const close=vi.fn();render(<CommissionVoucherModal open contractId="c1" onOpenChange={close}/>);
 fireEvent.change(screen.getByPlaceholderText('Để trống nếu không có'),{target:{value:'500000'}});
 fireEvent.click(screen.getByRole('button',{name:'Tạo phiếu chi'}));
 await waitFor(()=>expect(state.create).toHaveBeenCalledTimes(2));
 expect((await screen.findByRole('link',{name:'Mở phiếu PC-BROKER'})).getAttribute('href')).toBe('/income-expense/voucher/broker-voucher');
 expect(screen.getByRole('alert').textContent).toContain('Chưa xác nhận');expect(close).not.toHaveBeenCalled();
 fireEvent.click(await screen.findByRole('button',{name:'Tạo lại thưởng Sale'}));
 await waitFor(()=>expect(state.create).toHaveBeenCalledTimes(3));
 expect(state.create.mock.calls[2][0]).toEqual({contract_id:'c1',kind:'sale',request_id:'request-sale'});expect(state.prepare).toHaveBeenCalledOnce();
});
it('D17 reload đọc unknown saved intent, không prepare hoặc execute qua nút tạo mới',()=>{
 state.followups=[{kind:'broker',state:'UNKNOWN',can_manage:true,can_retry:true,request_id:'saved-broker'}, {kind:'sale',state:'NOT_APPLICABLE',can_manage:true}];
 render(<CommissionVoucherModal open contractId="c1" onOpenChange={()=>{}}/>);
 expect(screen.queryByPlaceholderText('Tên công ty / cá nhân môi giới')).toBeNull();
 fireEvent.click(screen.getByRole('button',{name:'Tạo phiếu chi'}));
 expect(state.prepare).not.toHaveBeenCalled();expect(state.create).not.toHaveBeenCalled();
 expect(screen.getByRole('button',{name:'Tạo lại hoa hồng môi giới'})).toBeTruthy();
});
