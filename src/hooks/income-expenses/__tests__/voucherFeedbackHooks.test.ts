// @vitest-environment jsdom
import {renderHook} from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
const h = vi.hoisted(() => ({ rpc: vi.fn(), from: vi.fn(), error: vi.fn(), success: vi.fn(), info: vi.fn(), warning: vi.fn(), invalidate: vi.fn() }));
vi.mock('@tanstack/react-query', () => ({ useMutation: (options: unknown) => options, useQuery: (options: unknown) => options, useQueryClient: () => ({ invalidateQueries: h.invalidate }) }));
vi.mock('@/integrations/supabase/client', () => ({ supabase: { rpc: h.rpc, from: h.from } }));
vi.mock('@/lib/authSession', () => ({ getSessionUser: async () => ({id:'u1'}) }));
vi.mock('@/contexts/OrganizationContext', () => ({ useOrganization: () => ({selectedOrganizationId:'o1'}) }));
vi.mock('@/hooks/useAuth', () => ({useAuth: () => ({data:{id:'u1'}})}));
vi.mock('../accountingClass', () => ({ loadIncomeExpenseAccountingClassResolver: async () => () => 'OTHER' }));
vi.mock('sonner', () => ({ toast: { error:h.error, success:h.success, info:h.info, warning:h.warning } }));
import { useCreateIncomeExpense } from '../mutations';
import { useCreateIncomeExpenseBatch, useImportIncomeExpenses } from '../batch';
import { useDecideApproval } from '@/hooks/useApprovals';
import { useMyCashbookAccessV2, useApproveIncomeExpenseV2, usePostApprovedIncomeExpenseV2 } from '../financeV2Mutations';
import { useCancelIncomeExpense, useVerifyIncomeExpense } from '../statusMutations';
import { useCancelVoucherFlex } from '../flexMutations';
import { useAnnotateIncomeExpense } from '../annotateMutations';
import { useGenerateRecurringVouchers } from '../recurring';
import { VoucherPartialError } from '@/lib/voucherFeedback';
import {useIncomeExpenseFormBuildings,useIncomeExpenseFormRooms} from '@/hooks/useIncomeExpenseFormScope';
import {assignCommissionManager} from '@/hooks/useCommissionManager';
type Mutation<T=unknown> = { mutationFn: (input: unknown) => Promise<T>; onSuccess: (data: unknown, input?: unknown) => unknown; onError: (error: unknown) => unknown };
type ImportMutation=Mutation<Awaited<ReturnType<ReturnType<typeof useImportIncomeExpenses>['mutateAsync']>>>;
type ReadResponse={data?:unknown;error:unknown};
interface VoucherQuery {select:()=>VoucherQuery;eq:()=>VoucherQuery;maybeSingle:()=>Promise<ReadResponse>}
const input = {type:'EXPENSE',name:'Sửa nước', shared_name:'Sửa nước',building_id:'b1',account_id:'a1',voucher_date:'2026-09-30',items:[{income_expense_type_id:'t1',quantity:1,unit_price:100,building_id:'b1',start_date:'2026-09-01',end_date:'2026-09-30'}]};
beforeEach(() => { const values=new Map<string,string>();vi.stubGlobal("localStorage",{getItem:(k:string)=>values.get(k)??null,setItem:(k:string,v:string)=>{values.set(k,v)},removeItem:(k:string)=>{values.delete(k)}}); localStorage.setItem("ihomecrm.selectedOrganizationId","o1"); vi.clearAllMocks(); h.rpc.mockReset(); h.from.mockReset(); });
it('danh mục riêng của form phải giữ lỗi đọc để UI chặn lưu',async()=>{const error={code:'42501',message:'denied'};h.rpc.mockResolvedValue({data:null,error});for(const hook of [useIncomeExpenseFormBuildings,useIncomeExpenseFormRooms])await expect((hook() as unknown as {queryFn:()=>Promise<unknown>}).queryFn()).rejects.toBe(error);});
it('sinh phiếu định kỳ null không phải không có phiếu mới',async()=>{h.rpc.mockResolvedValue({data:null,error:null});await expect((useGenerateRecurringVouchers() as unknown as Mutation).mutationFn(null)).rejects.toThrow(/Chưa xác nhận/);});
it('gán QL trả sai phiếu hoặc thiếu kết quả không được thành công',async()=>{h.rpc.mockResolvedValue({data:{voucher_id:'wrong',manager_id:'m1',account_id:'a1',approval_version:1,lap_lai:false,moved:true},error:null});await expect(assignCommissionManager({voucherId:'v1',managerId:'m1'})).rejects.toBeInstanceOf(TypeError);});

describe('C01/C02/C09 — một thông báo đúng kết quả', () => {
  it('tạo chờ duyệt báo đúng trạng thái, transport exception do onError báo một lần', async () => {
    const mutation = useCreateIncomeExpense() as unknown as Mutation;
    h.rpc.mockResolvedValueOnce({data:{id:'v1',code:'PC01',approval_status:'UNAPPROVED'},error:null});
    const data = await mutation.mutationFn(input); mutation.onSuccess(data);
    expect(h.success).toHaveBeenCalledWith('Đã tạo phiếu PC01. Phiếu đang chờ duyệt, chưa ghi nhận thu/chi.');
    const timeout = new TypeError('Failed to fetch'); h.rpc.mockRejectedValueOnce(timeout);
    await expect(mutation.mutationFn(input)).rejects.toBe(timeout);
    expect(h.error).not.toHaveBeenCalled(); mutation.onError(timeout);
    expect(h.error).toHaveBeenCalledOnce(); expect(h.error.mock.calls[0][0]).toMatch(/Chưa xác nhận.*kiểm tra trạng thái phiếu/);
  });
  it('duyệt quorum còn chờ hiển thị info, không success', async () => {
    const mutation = useDecideApproval() as unknown as Mutation;
    h.rpc.mockResolvedValueOnce({data:{request_id:'r1',state:'PENDING_APPROVAL'},error:null});
    const args = {requestId:'r1',decision:'APPROVE',organizationId:'o1'};
    mutation.onSuccess(await mutation.mutationFn(args),args);
    expect(h.success).not.toHaveBeenCalled(); expect(h.info).toHaveBeenCalledWith(expect.stringContaining('vẫn đang chờ'));
  });
  it('lỗi đọc quyền sổ không bị chuyển thành danh sách rỗng/null', async () => {
    const error = {code:'42501',message:'permission denied'}; h.rpc.mockResolvedValueOnce({data:null,error});
    const query = useMyCashbookAccessV2() as unknown as {queryFn:()=>Promise<unknown>};
    await expect(query.queryFn()).rejects.toBe(error);
  });
  it('duyệt phiếu hệ thống chấp nhận biên nhận SQL và chặn kết quả thiếu trạng thái', async () => {
    const mutation = renderHook(()=>useApproveIncomeExpenseV2()).result.current as unknown as Mutation;
    h.rpc.mockResolvedValueOnce({data:null,error:{code:'42501',message:'owned by system flow'}})
      .mockResolvedValueOnce({data:{refundVoucherId:'v1',approvalStatus:'APPROVED',reservationUnchanged:true},error:null});
    const receipt = await mutation.mutationFn({voucherId:'v1',expectedApprovalVersion:1});
    mutation.onSuccess(receipt);
    expect(h.success).toHaveBeenCalledWith('Đã duyệt phiếu. Chưa ghi nhận thu/chi vào sổ quỹ.');
    h.rpc.mockResolvedValueOnce({data:{},error:null});
    await expect((renderHook(()=>usePostApprovedIncomeExpenseV2()).result.current as unknown as Mutation).mutationFn({})).rejects.toBeInstanceOf(TypeError);
  });
});

describe('C22/C23 — biên nhận thao tác nhiều bước', () => {
  it('import giữ mã phiếu thành công và lỗi từng dòng khi một dòng timeout', async () => {
    h.rpc.mockResolvedValueOnce({data:{id:'v1',code:'PC01'},error:null}).mockRejectedValueOnce(new TypeError('Failed to fetch'));
    const mutation = useImportIncomeExpenses() as unknown as ImportMutation;
    const result = await mutation.mutationFn([{...input,item_name:'A',amount:100},{...input,item_name:'B',amount:200}]);
    expect(result.successCount).toBe(1); expect(result.failedCount).toBe(1);
    expect(result.createdVouchers).toEqual([{row:1,id:'v1',code:'PC01'}]);
    expect(result.errors[0]).toMatchObject({row:2,message:expect.stringContaining('Chưa xác nhận')});
    mutation.onSuccess(result); expect(h.warning).toHaveBeenCalledOnce(); expect(h.success).not.toHaveBeenCalled();
  });
  it('phiếu tổng hỏng dòng hai + huỷ lại hỏng vẫn mang receipt ID của dòng một', async () => {
    type BatchQuery={insert:()=>BatchQuery;select:()=>BatchQuery;delete:()=>BatchQuery;eq:()=>BatchQuery;single:()=>Promise<ReadResponse>;then:(resolve:(response:ReadResponse)=>unknown)=>Promise<unknown>};
    const builder:BatchQuery={insert:vi.fn(()=>builder),select:vi.fn(()=>builder),delete:vi.fn(()=>builder),eq:vi.fn(()=>builder),single:vi.fn().mockResolvedValue({data:{id:'batch1'},error:null}),then:resolve=>Promise.resolve({error:null}).then(resolve)};
    h.from.mockReturnValue(builder);
    h.rpc.mockResolvedValueOnce({data:{id:'v1'},error:null}).mockRejectedValueOnce(new TypeError('Failed to fetch')).mockRejectedValueOnce(new TypeError('Failed to fetch'));
    const mutation = useCreateIncomeExpenseBatch() as unknown as Mutation;
    let caught: unknown; try { await mutation.mutationFn({...input,items:[input.items[0],input.items[0]]}); } catch(error) { caught=error; }
    expect(caught).toBeInstanceOf(VoucherPartialError);
    expect(caught).toMatchObject({completedIds:['v1'],batchId:'batch1'});
    const calls=h.rpc.mock.calls.length; await expect((useCreateIncomeExpenseBatch() as unknown as Mutation).mutationFn(input)).rejects.toThrow(/đối chiếu/);expect(h.rpc).toHaveBeenCalledTimes(calls);
    expect((caught as Error).message).toMatch(/Đã nhận kết quả tạo 1 phiếu.*Chưa xác nhận.*kiểm tra/);
    expect(h.error).not.toHaveBeenCalled(); mutation.onError(caught); expect(h.error).toHaveBeenCalledOnce();
  });
});


describe('C16–C21 — một phần, không thay đổi và kết quả kiểm', () => {
  it('đã hoàn tác nhưng bước huỷ lỗi giữ receipt và báo partial', async () => {
    const builder:VoucherQuery={select:()=>builder,eq:()=>builder,maybeSingle:async()=>({data:{id:'v1',type:'EXPENSE',approval_status:'APPROVED',posting_status:'POSTED',account_id:'a1'},error:null})}; h.from.mockReturnValue(builder);
    const denied={code:'42501',message:'permission denied'};
    h.rpc.mockResolvedValueOnce({data:null,error:{code:'55000',message:'not a termination forfeit pair'}})
      .mockResolvedValueOnce({data:{voucherId:'v1',postingStatus:'REVERSED'},error:null})
      .mockResolvedValueOnce({data:null,error:{code:'0A000',message:'legacy'}})
      .mockResolvedValueOnce({data:null,error:denied});
    const mutation=renderHook(()=>useCancelIncomeExpense()).result.current as unknown as Mutation;
    await expect(mutation.mutationFn('v1')).rejects.toMatchObject({completedIds:['v1'],cause:denied,message:expect.stringContaining('Đã hoàn tác')});
    expect(h.error).not.toHaveBeenCalled();
  });
  it('đã huỷ nhưng xoá payment lỗi không báo như huỷ chưa xảy ra', async () => {
    const denied={code:'42501',message:'permission denied'};
    const reader:VoucherQuery={select:()=>reader,eq:()=>reader,maybeSingle:async()=>({data:{id:'v1',type:'INCOME',payment_id:'p1',approval_status:'APPROVED',posting_status:'UNPOSTED'},error:null})};
    h.from.mockImplementation(table=>table==='payments'?{delete:()=>({eq:async()=>({error:denied})})}:reader);
    h.rpc.mockResolvedValueOnce({data:null,error:{code:'55000',message:'not a termination forfeit pair'}})
      .mockResolvedValueOnce({data:null,error:{code:'0A000',message:'legacy'}}).mockResolvedValueOnce({data:{cancelled:1},error:null});
    const mutation=renderHook(()=>useCancelIncomeExpense()).result.current as unknown as Mutation;
    await expect(mutation.mutationFn('v1')).rejects.toMatchObject({completedIds:['v1'],cause:denied,message:expect.stringContaining('Phiếu đã huỷ nhưng chưa cập nhật được thanh toán')});
  });
  it('hủy lại, ghi chú không đổi và không phiếu định kỳ đều info', () => {
    (useCancelVoucherFlex() as unknown as Mutation).onSuccess({id:'v1',changed:false});
    (useAnnotateIncomeExpense() as unknown as Mutation).onSuccess({id:'v1',changed:false});
    (useGenerateRecurringVouchers() as unknown as Mutation).onSuccess([]);
    expect(h.info).toHaveBeenCalledTimes(3); expect(h.success).not.toHaveBeenCalled();
  });
  it('đánh dấu/bỏ kiểm dựa trạng thái đọc lại; đọc lỗi không cho bấm toggle lần nữa', async () => {
    const reader:VoucherQuery={select:()=>reader,eq:()=>reader,maybeSingle:vi.fn().mockResolvedValueOnce({data:{id:'v1',code:'PT01',verified_at:null},error:null}).mockResolvedValueOnce({data:null,error:{code:'42501'}})};
    h.from.mockReturnValue(reader); h.rpc.mockResolvedValue({data:null,error:null});
    const mutation=renderHook(()=>useVerifyIncomeExpense()).result.current as unknown as Mutation;
    mutation.onSuccess(await mutation.mutationFn({id:'v1',note:null}));
    expect(h.success).toHaveBeenCalledWith('Đã bỏ đánh dấu đã kiểm của phiếu PT01.');
    let caught:unknown;try{await mutation.mutationFn({id:'v1',note:null});}catch(error){caught=error;}
    expect(caught).toBeDefined();mutation.onError(caught);
    expect(h.warning.mock.calls[0][0].toLowerCase()).toContain('không bấm đổi trạng thái thêm lần nữa');
    await expect((renderHook(()=>useVerifyIncomeExpense()).result.current as unknown as Mutation).mutationFn({id:'v1',note:null})).rejects.toThrow(/đối chiếu/);
    expect(h.rpc).toHaveBeenCalledTimes(2);
  });
});

it('C22 unknown giữ khóa toàn import qua lượt gọi mới, kể cả đổi nội dung dòng; mã và dòng gốc còn để đối chiếu',async()=>{
 const rows=[{...input,item_name:'A',amount:100,source_row:2},{...input,item_name:'B',amount:200,source_row:4}];
 h.rpc.mockResolvedValueOnce({data:{id:'v1',code:'PC01'},error:null}).mockRejectedValueOnce(new TypeError('Failed to fetch'));
 const result=await (useImportIncomeExpenses() as unknown as ImportMutation).mutationFn(rows);expect(result.createdVouchers).toEqual([{row:1,id:'v1',code:'PC01'}]);expect(result.errors[0].row).toBe(2);
 await expect((useImportIncomeExpenses() as unknown as ImportMutation).mutationFn([{...rows[1],amount:300}])).rejects.toThrow(/đối chiếu/);expect(h.rpc).toHaveBeenCalledTimes(2);
 const snapshot=JSON.parse(localStorage.getItem('ihome:excel-import-pending:v1:u1:o1')!) as {rows:{sourceRow:number}[];createdVouchers:{id:string}[];unconfirmedRows:number[];failedRows:number[]};expect(snapshot.rows.map((row)=>row.sourceRow)).toEqual([2,4]);expect(snapshot.createdVouchers[0].id).toBe('v1');expect(snapshot.unconfirmedRows).toEqual([4]);
});
it('C22 hai dòng giống nhau vẫn là hai dòng hợp lệ, success giải phóng khóa cho import sau',async()=>{
 h.rpc.mockResolvedValueOnce({data:{id:'v1',code:'PC01'},error:null}).mockResolvedValueOnce({data:{id:'v2',code:'PC02'},error:null}).mockResolvedValueOnce({data:{id:'v3',code:'PC03'},error:null});
 const row={...input,item_name:'A',amount:100};const result=await (useImportIncomeExpenses() as unknown as ImportMutation).mutationFn([row,row]);expect(result.successCount).toBe(2);expect(result.createdVouchers.map((v)=>v.id)).toEqual(['v1','v2']);
 await expect((useImportIncomeExpenses() as unknown as ImportMutation).mutationFn([row])).resolves.toMatchObject({successCount:1});expect(h.rpc).toHaveBeenCalledTimes(3);
});

it('C22 partial known rejection giữ ID đã tạo và dòng lỗi sau mở lại, không nhập lại cả file',async()=>{
 const rows=[{...input,item_name:'A',amount:100,source_row:2},{...input,item_name:'B',amount:200,source_row:7}];
 h.rpc.mockResolvedValueOnce({data:{id:'v1',code:'PC01'},error:null}).mockResolvedValueOnce({data:null,error:{code:'23514',message:'invalid row'}});
 const result=await (useImportIncomeExpenses() as unknown as ImportMutation).mutationFn(rows);expect(result).toMatchObject({successCount:1,failedCount:1});
 await expect((useImportIncomeExpenses() as unknown as ImportMutation).mutationFn(rows)).rejects.toThrow(/Dòng Excel chưa hoàn tất: 7/);expect(h.rpc).toHaveBeenCalledTimes(2);
 const snapshot=JSON.parse(localStorage.getItem('ihome:excel-import-pending:v1:u1:o1')!) as {rows:{sourceRow:number}[];createdVouchers:{id:string}[];unconfirmedRows:number[];failedRows:number[]};expect(snapshot.createdVouchers[0].id).toBe('v1');expect(snapshot.failedRows).toEqual([7]);
});
it('C22 mọi dòng bị từ chối chắc chắn và chưa có phiếu mới cho sửa file rồi gửi lại',async()=>{
 const row={...input,item_name:'A',amount:100,source_row:2};h.rpc.mockResolvedValueOnce({data:null,error:{code:'23514',message:'invalid row'}}).mockResolvedValueOnce({data:{id:'v2',code:'PC02'},error:null});
 await expect((useImportIncomeExpenses() as unknown as ImportMutation).mutationFn([row])).resolves.toMatchObject({successCount:0,failedCount:1});
 expect(localStorage.getItem('ihome:excel-import-pending:v1:u1:o1')).toBeNull();
 await expect((useImportIncomeExpenses() as unknown as ImportMutation).mutationFn([{...row,amount:200}])).resolves.toMatchObject({successCount:1});expect(h.rpc).toHaveBeenCalledTimes(2);
});
