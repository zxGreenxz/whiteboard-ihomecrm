// @vitest-environment jsdom
import { cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const h = vi.hoisted(() => ({ rpc:vi.fn(), tables:{} as Record<string,unknown>, response: { data: null as unknown, error: null as unknown } }));
vi.mock('@/integrations/supabase/client', () => ({
  supabase: {rpc:h.rpc, from: (table:string) => {
    const b: Record<string, unknown> = {}; let offset=0;
    for (const method of ['select','eq','is','in','order','lte','neq','range','gt','gte','not','or','insert','limit']) b[method] = () => b;
    b.single=()=>Promise.resolve(h.response);
    b.range=(from:number)=>{offset=from;return b;};
    b.then = (done: (value: unknown) => unknown) => Promise.resolve(offset ? {...h.response,data:[]} : (table in h.tables ? {...h.response,data:h.tables[table]} : h.response)).then(done);
    return b;
  } },
}));
vi.mock('@tanstack/react-query', () => ({ useQuery: (o: unknown) => o, useMutation:(o:unknown)=>o, useQueryClient: () => ({}), keepPreviousData: (v: unknown) => v }));
vi.mock('@/contexts/OrganizationContext',()=>({useOrganization:()=>({selectedOrganizationId:'org1'})}));
vi.mock('@/lib/authSession',()=>({getSessionUser:async()=>({id:'u1'})}));
import { usePaymentScheduleReport,useOverpaymentReport,useDepositsReport } from '../reports/financeReports';
import { useInvoice,useInvoiceRentPeriods,useInvoiceTotalsByIds,useInvoicesLegacy,useInvoices,useFirstInvoiceDetails, useContractDepositVouchers } from '../useInvoices';
import {incomeExpensesListQuery,useIncomeExpenseBatches} from '../income-expenses/queries';
import {useCollectionReversalEligibility} from '../useDeletePayment';
import {useFeeConfigMatrix,useSaveFeeConfig} from '../useFeeConfigMatrix';
import {useSpecialFeePrices,useSetSpecialFeePrice} from '../useSpecialFeePrices';
import {useCommissionVoucherFacts,useExistingCommissionVouchers} from '../useCommissionVoucher';
import {useCancelPeriodFee,useAppendFeeAttachment,useUpdatePeriodFee,useFeeAccounts,usePeriodMaintenance,useUpsertFeeAccount} from '../usePeriodFees';
import {useSetReservationHoldTerms,useReservationHoldDeadlines} from '../useReservationHoldDeadlines';
import {useReservationDeposits,useCreateDeposit,useDeposits} from '../useDeposits';
import {useUtilityAccounts,useSaveUtilityMeter,useAddUtilityMeter,useCancelUtilityBill,useDeleteUtilityMeter,useUtilityPayments} from '../useUtilityBills';
import { fetchInvoiceTenders, fetchRecentInvoiceCollections } from '../useCollectionTenders';

function query(hook: () => unknown) {
  const { result } = renderHook(()=>hook() as unknown);
  return (result.current as { queryFn: () => Promise<unknown> }).queryFn();
}
beforeEach(() => {localStorage.clear();vi.clearAllMocks();h.tables={}; h.response = { data: null, error: null }; });
afterEach(cleanup);

it('chi tiết hóa đơn đầu null không thành map không có hóa đơn', async () => {
  await expect(query(() => useFirstInvoiceDetails(['invoice1']))).rejects.toThrow();
});
it('phiếu cọc hợp đồng null không thành danh sách chưa đóng cọc', async () => {
  await expect(query(() => useContractDepositVouchers('contract1'))).rejects.toThrow();
});
it.each([null, 'invalid', ''])('số tiền hóa đơn đầu thiếu %s không thành0', async total_amount => {
  h.response.data = [{ id: 'invoice1', notes: 'Tiền phòng tháng đầu', total_amount, paid_amount: 0,
    contract: { id: 'contract1', total_deposit: 0, deposit_paid: 0 }, invoice_items: [] }];
  await expect(query(() => useFirstInvoiceDetails(['invoice1']))).rejects.toThrow();
});
it('tổng cọc lấy đúng item cọc0, không lấy cả tổng phiếu trộn100', async () => {
  h.response.data = [{ id: 'voucher1', total_amount: 100, income_expense_items: [{ amount: 0 }] }];
  await expect(query(() => useContractDepositVouchers('contract1'))).resolves.toMatchObject([{ totalAmount: 0 }]);
});
it('tiền item cọc thiếu không thành tổng phiếu', async () => {
  h.response.data = [{ id: 'voucher1', total_amount: 100, income_expense_items: [{ amount: null }] }];
  await expect(query(() => useContractDepositVouchers('contract1'))).rejects.toThrow();
});
it('dòng thu null không thành không có khoản thu', async () => { await expect(fetchInvoiceTenders('invoice1')).rejects.toThrow(); });
it('kiểm tra thu gần đây null không cho hiểu là chưa thu', async () => { await expect(fetchRecentInvoiceCollections(['invoice1'])).rejects.toThrow(); });
it('thu gần đây thiếu gross_amount không thành khoản thu0', async () => {
  h.response.data = [{ id: 'collection1', invoice_id: 'invoice1', status: 'ACTIVE', actor_id: 'u1', gross_amount: null, created_at: '2026-09-29T02:00:00Z', tenders: [] }];
  await expect(fetchRecentInvoiceCollections(['invoice1'])).rejects.toThrow();
});

it.each([()=>useInvoices(),()=>useInvoicesLegacy(),()=>useInvoiceTotalsByIds(['i1'])])('nguồn hóa đơn null không được thành danh sách/tổng rỗng',async hook=>{
 await expect(query(hook)).rejects.toThrow();
});
it('tổng hóa đơn theo IDs thiếu số tiền không thành0',async()=>{
 h.response.data=[{id:'i1',total_amount:null,paid_amount:0,remaining_amount:0}];await expect(query(()=>useInvoiceTotalsByIds(['i1']))).rejects.toThrow();
});
it.each([()=>usePaymentScheduleReport(),()=>useOverpaymentReport()])('báo cáo hóa đơn có tiền thiếu phải báo lỗi nguồn',async hook=>{
 h.response.data=[{id:'i1',total_amount:null,paid_amount:100,remaining_amount:0,due_date:'2026-10-01'}];await expect(query(hook)).rejects.toThrow();
});
it('báo cáo cọc thiếu tiền không thành0',async()=>{
 h.response.data=[{id:'d1',amount:null,deposit_date:'2026-09-01'}];await expect(query(()=>useDepositsReport())).rejects.toThrow();
});



const reservationRow={id:'r1',total_amount:100,approval_status:'UNAPPROVED',approval_version:1,income_expense_items:[{amount:0}]};
it.each([{...reservationRow,income_expense_items:null},{...reservationRow,income_expense_items:[{amount:null}]},{...reservationRow,approval_status:'unexpected'}])('cọc giữ chỗ thiếu item/tiền/status không thành0 hoặc state hợp lệ: %s',async data=>{
 h.response.data=[data];await expect(query(()=>useReservationDeposits())).rejects.toThrow();
});
it('cọc giữ chỗ trộn item cọc0 giữ tổng cọc0, không lấy cả phiếu100',async()=>{
 h.response.data=[reservationRow];await expect(query(()=>useReservationDeposits())).resolves.toMatchObject([{total_amount:0}]);
});
it.each([null,[{id:'m1',utility_type:'unexpected'}]])('đồng hồ điện/nước thiếu nguồn/status không thành [] hoặc nước: %s',async data=>{
 h.response.data=data;await expect(query(()=>useUtilityAccounts())).rejects.toThrow();
});
it.each([useSaveUtilityMeter,useAddUtilityMeter])('tạo/sửa đồng hồ thiếu ID không cho tiếp như đã lưu',async hook=>{
 h.rpc.mockResolvedValue({data:null,error:null});const {result}=renderHook(()=>hook() as unknown);
 await expect((result.current as unknown as {mutationFn:(args:unknown)=>Promise<unknown>}).mutationFn({buildingId:'b1',type:'electric',code:'PE1',holder:'A'})).rejects.toThrow();
});
it.each([()=>useCancelUtilityBill('2026-09'),useCancelPeriodFee])('hủy phí thiếu/sai voucher receipt không nói thành công và không gửi lại',async hook=>{
 h.rpc.mockResolvedValue({data:{ok:true,voucher_id:'other'},error:null});const {result}=renderHook(()=>hook() as unknown);
 const mutate=(result.current as unknown as {mutationFn:(id:string)=>Promise<unknown>}).mutationFn;
 await expect(mutate('v1')).rejects.toThrow();const count=h.rpc.mock.calls.length;
 await expect(mutate('v1')).rejects.toThrow();expect(h.rpc).toHaveBeenCalledTimes(count);
});
it('xóa đồng hồ null không xác nhận đã xóa',async()=>{
 h.rpc.mockResolvedValue({data:null,error:null});const {result}=renderHook(useDeleteUtilityMeter);
 await expect((result.current as unknown as {mutationFn:(id:string)=>Promise<unknown>}).mutationFn('m1')).rejects.toThrow();
});
it.each([()=>useFeeConfigMatrix(),()=>useSpecialFeePrices(),()=>useFeeAccounts(),()=>usePeriodMaintenance('2026-09',['b1']),()=>useExistingCommissionVouchers('c1'),()=>useCommissionVoucherFacts('v1')])('nguồn cấu hình/giá/bảo trì/hoa hồng null không thành danh mục trống',async hook=>{
 h.rpc.mockResolvedValue({data:null,error:null});await expect(query(hook)).rejects.toThrow();
});
it('facts hoa hồng [] đúng quyền không có nội dung là null hợp lệ',async()=>{
 h.rpc.mockResolvedValue({data:[],error:null});await expect(query(()=>useCommissionVoucherFacts('v1'))).resolves.toBeNull();
});
it('phiếu bảo trì trạng thái lạ không thành đã duyệt',async()=>{
 h.rpc.mockResolvedValue({data:[{id:'v1',state:'unexpected',total_amount:100}],error:null});await expect(query(()=>usePeriodMaintenance('2026-09',['b1']))).rejects.toThrow();
});
it.each([useSaveFeeConfig,useUpsertFeeAccount,useSetSpecialFeePrice])('lưu cấu hình/công bố giá thiếu receipt không nói đã lưu',async hook=>{
 h.rpc.mockResolvedValue({data:null,error:null});const {result}=renderHook(()=>hook() as unknown);
 await expect((result.current as unknown as {mutationFn:(value:unknown)=>Promise<unknown>}).mutationFn({buildingId:'b1',feeCategory:'internet',amount:100})).rejects.toThrow();
});
it.each([{approval_status:'unexpected',total_amount:100,it:[{income_expense_type_id:'e1',amount:100}]},{approval_status:'APPROVED',total_amount:100,it:[{income_expense_type_id:'e1',amount:null}]}])('phiếu điện nước thiếu amount hoặc status không thành đã đóng: %s',async row=>{
 h.tables={income_expense_types:[{id:'e1',name:'Đóng tiền điện'}],income_expenses:[{id:'v1',...row}]};
 await expect(query(()=>useUtilityPayments('2026-09'))).rejects.toThrow();
});
it('phiếu utility item0 không lấy tổng phiếu100 để báo đã đóng',async()=>{
 h.tables={income_expense_types:[{id:'e1',name:'Đóng tiền điện'}],income_expenses:[{id:'v1',approval_status:'APPROVED',total_amount:100,it:[{income_expense_type_id:'e1',amount:0}]}]};
 await expect(query(()=>useUtilityPayments('2026-09'))).resolves.toMatchObject([{amount:0}]);
});
it.each([useAppendFeeAttachment,useUpdatePeriodFee])('đính/sửa phiếu phí thiếu receipt target không tự báo đã lưu',async hook=>{
 h.rpc.mockResolvedValue({data:null,error:null});const {result}=renderHook(()=>hook() as unknown);
 await expect((result.current as unknown as {mutationFn:(value:unknown)=>Promise<unknown>}).mutationFn({voucherId:'v1',url:'https://files/receipt.png'})).rejects.toThrow();
});
it('lưu kỳ hạn thiếu target receipt không tự báo đã đặt kỳ hạn',async()=>{
 h.rpc.mockResolvedValue({data:null,error:null});const {result}=renderHook(()=>useSetReservationHoldTerms());
 await expect((result.current as unknown as {mutationFn:(value:unknown)=>Promise<unknown>}).mutationFn({incomeExpenseId:'v1',holdUntil:'2026-10-01',topupDueDate:null,depositTarget:null})).rejects.toThrow();
});
it.each([()=>useInvoice('i1'),()=>useInvoiceRentPeriods(['i1']),()=>useCollectionReversalEligibility(['c1']),()=>useIncomeExpenseBatches({},{page:1,pageSize:20})])('đọc invoice/kỳ/điều kiện hoàn tác/phiếu tổng null không thành trống',async hook=>{
 h.rpc.mockResolvedValue({data:null,error:null});await expect(query(hook)).rejects.toThrow();
});
it('list phiếu null không thành không có dữ liệu/tổng0',async()=>{
 await expect(incomeExpensesListQuery({},{page:1,pageSize:20}).queryFn()).rejects.toThrow();
});
it('tạo cọc legacy thiếu ID receipt không cho workflow chuyển khách tiếp',async()=>{
 const {result}=renderHook(()=>useCreateDeposit({silent:true}));
 await expect((result.current as unknown as {mutationFn:(value:unknown)=>Promise<unknown>}).mutationFn({room_id:'r1',tenant_id:'t1',amount:100,deposit_date:'2026-09-30'})).rejects.toThrow();
});
it('danh sách cọc legacy null không là danh sách chưa có cọc',async()=>{await expect(query(()=>useDeposits())).rejects.toThrow();});
it.each(['', 'abc', Infinity])('kỳ hạn số cọc phải đủ sai %s không được thành0/NaN',async amount=>{h.response.data=[{income_expense_id:'v1',hold_until:null,topup_due_date:null,deposit_target:amount}];await expect(query(()=>useReservationHoldDeadlines())).rejects.toThrow();});
it('kỳ hạn deposit_target null hợp lệ là chưa đặt mức cọc',async()=>{h.response.data=[{income_expense_id:'v1',hold_until:null,topup_due_date:null,deposit_target:null}];await expect(query(()=>useReservationHoldDeadlines())).resolves.toMatchObject({v1:{depositTarget:null}});});

it.each([null,'',NaN])('chi tiết hóa đơn total sai %s không thành0',async total_amount=>{h.response.data={id:'i1',total_amount,paid_amount:0,invoice_items:[]};await expect(query(()=>useInvoice('i1'))).rejects.toThrow();});
