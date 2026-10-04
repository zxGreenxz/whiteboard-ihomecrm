// @vitest-environment jsdom
vi.mock('@/contexts/OrganizationContext',()=>({useOrganization:()=>({selectedOrganizationId:'o1'})}));
//
// Form SỬA phiếu Chờ duyệt (đợt 1 sửa phiếu, 25/09/2026): lưu đi qua
// revise_pending_income_expense_v1. Chốt bốn điều người dùng thấy được:
//   1. chỉ gửi ô đã đổi (mở form rồi Lưu không sinh "lần sửa" ma);
//   2. hạng mục chưa ghi kỳ giữ kỳ trống, không bị gán tháng hiện tại;
//   3. đổi số tiền ⇒ phải ghi lý do ≥ 8 ký tự mới bấm Lưu được;
//   4. phiếu hệ thống (hoa hồng) khoá khung, lệch phiên bản ⇒ khoá Lưu + báo.
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { IncomeExpenseWithRelations } from '@/hooks/useIncomeExpenses';

const h = vi.hoisted(() => ({ revise: vi.fn(), create: vi.fn(), detail: null as unknown, fetching: false, error: false,contractError:false, slots:{} as Record<string,unknown>, retrySlots:vi.fn() }));

vi.mock("@/hooks/income-expenses/detailRead", () => ({ useIncomeExpenseDetail: () => ({data:h.detail,isFetching:h.fetching,isError:h.error,isSuccess:!h.error,isFetchedAfterMount:true,refetch:vi.fn()}) }));
vi.mock('@/integrations/supabase/client', () => ({
  supabase: { from: vi.fn(), rpc: vi.fn(), auth: { getUser: vi.fn() } },
}));
vi.mock('@/hooks/useIncomeExpenses', () => ({
  useCreateIncomeExpense: () => ({ mutateAsync: h.create, isPending: false }),
}));
vi.mock('@/hooks/income-expenses/revisions', () => ({
  useReviseIncomeExpense: () => ({ mutateAsync: h.revise, isPending: false }),
}));
vi.mock('@/hooks/income-expenses/forfeitKqkd', () => ({
  useSetForfeitVoucherKqkd: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));
vi.mock('@/hooks/income-expenses/financeV2Mutations', () => ({
  useMyCashbookAccessV2: () => ({ data: undefined }),
}));
vi.mock('@/hooks/useAuth', () => ({ useAuth: () => ({ data: { id: 'u1' } }) }));
vi.mock('@/hooks/useIsAdmin', () => ({ useIsAdmin: () => ({ data: false }) }));
vi.mock('@/hooks/useIsCompanyOwner', () => ({ useIsCompanyOwner: () => ({ data: false }) }));
vi.mock('@/hooks/use-mobile', () => ({ useIsMobile: () => false }));
vi.mock('@/hooks/useIncomeExpenseFormScope', () => ({
  useIncomeExpenseFormBuildings: () => ({ data: [{ id: 'b1', name: 'Toà A', managed: true }] }),
  useIncomeExpenseFormRooms: () => ({ data: [] }),
}));
vi.mock('@/hooks/useAccounts', () => ({
  useAccounts: () => ({ data: [{ id: 'a1', name: 'Sổ Hiệp', bank_name: null, is_virtual: false }] }),
}));
vi.mock('@/hooks/useContracts', () => ({ useContractsLegacy: () => ({ data: h.contractError?undefined:[],isError:h.contractError,refetch:vi.fn() }) }));
vi.mock('@/hooks/useIncomeExpenseTypes', () => ({ useIncomeExpenseTypes: () => ({ data: [] }) }));
vi.mock('@/hooks/useVoucherSlotWarning', () => ({ useVoucherSlotWarning: () => h.slots }));
vi.mock('../IncomeExpenseItemSelector', () => ({ default: () => null }));
vi.mock('../AttachmentUpload', () => ({ default: () => null }));

import IncomeExpenseForm from '../IncomeExpenseForm';

// jsdom không có ResizeObserver; Radix Switch/Checkbox đo kích thước bằng nó.
if (!('ResizeObserver' in globalThis)) {
  class ResizeObserverGia {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = ResizeObserverGia;
}

const phieu =(over: Partial<IncomeExpenseWithRelations> = {}): IncomeExpenseWithRelations =>
  ({
    detail_read:{complete:true,expected_item_count:1},
    id: 'v1', code: 'PC2609001', type: 'EXPENSE', name: 'Chi sửa ống nước', building_id: 'b1',
    building_name: 'Toà A', room_id: null, tenant_id: null, contract_id: null, payer_name: null,
    receive_bank_account: null, receive_bank_name: null, account_id: 'a1', voucher_date: '2026-09-20',
    business_result_accounting: null, repeat_cycle: 'NONE', repeat_infinity: false, repeat_count: 0,
    attachments: [], approval_status: 'UNAPPROVED', posting_status: 'UNPOSTED', approval_version: 5,
    system_source: null, invoice_id: null, shareholder_id: null, total_amount: 500000,
    items: [{
      id: 'i1', income_expense_id: 'v1', income_expense_type_id: 't1', type_name: 'Sửa chữa',
      category: null, is_deposit: false, description: null, quantity: 1, unit_price: 500000,
      amount: 500000, start_date: null, end_date: null,
    }],
    ...over,
  }) as unknown as IncomeExpenseWithRelations;

const moForm = (v: IncomeExpenseWithRelations) =>
  { h.detail=v; return render(<IncomeExpenseForm open onOpenChange={() => {}} voucher={v} />); };

const nutLuu = () => screen.getByTestId('ie-form-save') as HTMLButtonElement;

beforeEach(() => {
  h.retrySlots.mockReset();h.slots={data:[],status:'success',fetchStatus:'idle',isLoading:false,isError:false,error:null,refetch:h.retrySlots};
  h.fetching=false; h.error=false;h.contractError=false; h.create.mockReset();
  h.revise.mockReset().mockResolvedValue({ id: 'v1', changed: true, approval_version: 6, changed_fields: [] });
});
afterEach(cleanup);

describe('Form sửa phiếu Chờ duyệt', () => {
  it('Gmail prefill sets name/date/amount but no account, and only supports one expense', () => {
    render(<IncomeExpenseForm open onOpenChange={() => {}} defaultType="EXPENSE"
      emailBillSource={{ provider: 'grab', mailbox: 'test@gmail.com', message_id: 'abc123', receipt_id: 'GRAB123' }}
      defaultPrefill={{ name: 'Chi Grab từ Gmail', voucher_date: '2026-08-04', items: [{ income_expense_type_id: 't1', type_name: 'Đi lại', quantity: 1, unit_price: 85000 }] }} />);
    expect(screen.getByDisplayValue('Chi Grab từ Gmail')).toBeTruthy();
    expect(screen.getByPlaceholderText('Số tiền')).toHaveProperty('value', '85.000');
    expect(screen.queryByText('Cài đặt lặp lại')).toBeNull();
    expect(screen.getByRole('tab', { name: 'Phiếu thu' })).toHaveProperty('disabled', true);
    expect(h.create).not.toHaveBeenCalled();
  });
  it('chỉ đổi tên ⇒ gửi đúng khoá name, không gửi hạng mục, kèm phiên bản lúc mở', async () => {
    moForm(phieu());
    fireEvent.change(screen.getByDisplayValue('Chi sửa ống nước'), { target: { value: 'Chi thay vòi nước' } });
    fireEvent.click(nutLuu());
    await waitFor(() => expect(h.revise).toHaveBeenCalledOnce());
    expect(h.revise).toHaveBeenCalledWith({
      voucherId: 'v1', expectedApprovalVersion: 5, patch: { name: 'Chi thay vòi nước' }, items: null, reason: null,
    });
  });

  it('mở rồi Lưu không đổi gì ⇒ không gọi máy chủ', async () => {
    const dong = vi.fn();
    render(<IncomeExpenseForm open onOpenChange={dong} voucher={phieu()} />);
    fireEvent.click(nutLuu());
    await waitFor(() => expect(dong).toHaveBeenCalledWith(false));
    expect(h.revise).not.toHaveBeenCalled();
  });

  it('hạng mục chưa ghi kỳ: báo rõ và lưu vẫn giữ kỳ trống', async () => {
    moForm(phieu());
    expect(screen.getByText(/Phiếu gốc chưa ghi kỳ/)).toBeTruthy();
    const tien = screen.getByPlaceholderText('Số tiền');
    fireEvent.focus(tien);
    fireEvent.change(tien, { target: { value: '600000' } });
    fireEvent.change(screen.getByTestId('revision-reason'), { target: { value: 'Thợ báo giá lại' } });
    fireEvent.click(nutLuu());
    await waitFor(() => expect(h.revise).toHaveBeenCalledOnce());
    const goi = h.revise.mock.calls[0][0];
    expect(goi.items).toEqual([{
      income_expense_type_id: 't1', description: null, quantity: 1, unit_price: 600000, start_date: null, end_date: null,
    }]);
    expect(goi.reason).toBe('Thợ báo giá lại');
  });

  it('đổi số tiền thiếu lý do ⇒ báo đỏ và focus lý do, không gọi máy chủ', async () => {
    moForm(phieu());
    expect(screen.queryByTestId('revision-reason')).toBeNull();
    const tien = screen.getByPlaceholderText('Số tiền');
    fireEvent.focus(tien);
    fireEvent.change(tien, { target: { value: '700000' } });
    const lyDo = screen.getByTestId('revision-reason');
    fireEvent.click(nutLuu());
    await waitFor(() => expect(document.activeElement).toBe(lyDo));
    expect(lyDo.getAttribute('aria-invalid')).toBe('true');
    expect(h.revise).not.toHaveBeenCalled();
    fireEvent.change(lyDo, { target: { value: 'ngắn' } });
    fireEvent.click(nutLuu());
    expect(h.revise).not.toHaveBeenCalled();
    fireEvent.change(lyDo, { target: { value: 'Sai đơn giá lúc lập' } });
    expect(nutLuu().disabled).toBe(false);
  });

  it('phiếu hoa hồng chưa có sổ: khoá khung, không cho thêm hạng mục, sổ để trống vẫn lưu được', async () => {
    moForm(phieu({ system_source: 'contract.commission', account_id: null }));
    expect(screen.getByText(/Phiếu do hệ thống lập \(hoa hồng/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Thêm hạng mục/ })).toBeNull();
    expect(screen.getByText('Sổ quỹ (chọn lúc duyệt)')).toBeTruthy();
    fireEvent.change(screen.getByDisplayValue('Chi sửa ống nước'), { target: { value: 'Hoa hồng P101' } });
    fireEvent.click(nutLuu());
    await waitFor(() => expect(h.revise).toHaveBeenCalledOnce());
    expect(h.revise.mock.calls[0][0].patch).toEqual({ name: 'Hoa hồng P101' });
  });

  it('phiếu vừa bị người khác sửa (PT409) ⇒ báo mở lại và khoá Lưu', async () => {
    h.revise.mockRejectedValueOnce({ code: 'PT409', message: 'Phiếu vừa được người khác sửa' });
    moForm(phieu());
    fireEvent.change(screen.getByDisplayValue('Chi sửa ống nước'), { target: { value: 'Chi thay vòi nước' } });
    fireEvent.click(nutLuu());
    await waitFor(() => expect(screen.getByRole('alert').textContent).toMatch(/vừa được người khác sửa hoặc duyệt/));
    expect(nutLuu().disabled).toBe(true);
  });

  it('phiếu đã duyệt ⇒ chỉ xem, không có nút Lưu', () => {
    moForm(phieu({ approval_status: 'APPROVED', posting_status: 'POSTED' }));
    expect(screen.getByText('CHI TIẾT PHIẾU')).toBeTruthy();
    expect(screen.queryByTestId('ie-form-save')).toBeNull();
  });
});

describe("Complete detail baseline",()=>{
 it("blocks submit until detail is verified",()=>{const v=phieu({detail_read:undefined});moForm(v);expect(nutLuu().disabled).toBe(true);fireEvent.click(nutLuu());expect(h.revise).not.toHaveBeenCalled();});
 it("does not reset a typed edit on realtime refresh and blocks a changed version",()=>{const v=phieu();const view=moForm(v);fireEvent.change(screen.getByDisplayValue("Chi sửa ống nước"),{target:{value:"Đang sửa dở"}});h.detail={...v,approval_version:6,name:"Đã đổi trên máy khác"};view.rerender(<IncomeExpenseForm open onOpenChange={()=>{}} voucher={v}/>);expect(screen.getByDisplayValue("Đang sửa dở")).toBeTruthy();expect(nutLuu().disabled).toBe(true);});
});

describe('Lỗi biểu mẫu theo trường', () => {
  it('phiếu trống báo đúng Toà nhà, Sổ quỹ và focus Toà nhà trước Tên phiếu', async () => {
    render(<IncomeExpenseForm open onOpenChange={() => {}} />);
    fireEvent.click(nutLuu());
    await screen.findByText('Chọn toà nhà cho phiếu.');
    expect(screen.getByText('Chọn sổ quỹ ghi nhận phiếu.')).toBeTruthy();
    const toa = screen.getByRole('combobox', { name: /Tòa nhà/ });
    await waitFor(() => expect(document.activeElement).toBe(toa));
    expect(toa.getAttribute('aria-invalid')).toBe('true');
    expect(h.create).not.toHaveBeenCalled();
  });

  it('kỳ áp dụng sai ở dòng hạng mục hiển thị tại dòng và focus tháng kết thúc', async () => {
    const source = phieu();
    source.items = [{ ...source.items[0], start_date: '2026-10-01', end_date: '2026-09-30' }];
    h.detail = source;
    render(<IncomeExpenseForm open onOpenChange={() => {}} copyFrom={source} />);
    fireEvent.click(nutLuu());
    await screen.findByText('Ngày bắt đầu không được sau ngày kết thúc');
    const denThang = document.querySelector('[name="items.0.end_date"]');
    expect(denThang).not.toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(denThang));
    expect(denThang?.getAttribute('aria-invalid')).toBe('true');
    expect(h.create).not.toHaveBeenCalled();
  });
});

it('không coi lỗi đọc hợp đồng phòng là danh sách trống và khóa lưu',async()=>{h.contractError=true;moForm(phieu({room_id:'r1'}));expect(nutLuu().disabled).toBe(true);expect(screen.getByRole('alert').textContent).toMatch(/Chưa tải được|Chưa tải đủ/);fireEvent.click(nutLuu());expect(h.revise).not.toHaveBeenCalled();});

it('slot read failure stays beside items, has retry and does not block saving an otherwise valid voucher',async()=>{
 h.slots={data:undefined,status:'error',fetchStatus:'idle',isLoading:false,isError:true,error:new Error('Failed to fetch'),refetch:h.retrySlots};
 const v=phieu();v.items=[{...v.items[0],start_date:'2026-09-01',end_date:'2026-09-30'}];moForm(v);
 expect(screen.getByRole('alert').textContent).toContain('Chưa tải được các phiếu cùng hạng mục trong kỳ');
 expect(nutLuu().disabled).toBe(false);
 fireEvent.click(screen.getByRole('button',{name:'Tải lại'}));await waitFor(()=>expect(h.retrySlots).toHaveBeenCalledOnce());
 fireEvent.change(screen.getByDisplayValue('Chi sửa ống nước'),{target:{value:'Chi sửa mới'}});
 fireEvent.click(nutLuu());await waitFor(()=>expect(h.revise).toHaveBeenCalledOnce());
});
it('a slot query not enabled before choosing a building and period does not show a false source error',()=>{
 h.slots={data:undefined,status:'pending',fetchStatus:'idle',isLoading:false,isError:false,error:null,refetch:h.retrySlots};
 render(<IncomeExpenseForm open onOpenChange={()=>{}}/>);expect(screen.queryByText(/Chưa tải được các phiếu cùng hạng mục/)).toBeNull();
});
