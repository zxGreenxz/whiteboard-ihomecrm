// @vitest-environment jsdom
import {beforeEach,it,expect,vi} from 'vitest';
const h=vi.hoisted(()=>{const state={rpc:vi.fn(),handovers:{} as Record<string,string|null>,readChain:(table:string)=>{
  // Đọc theo tập mã (lập phiên bàn giao, đợt 4) và đọc một dòng theo mã (đợt 5: trạng thái phiên, sổ quỹ trước khi ghi dấu).
  const q={select:()=>q,in:(_c:string,ids:string[])=>Promise.resolve({data:table==='income_expenses'?ids.map(id=>({id,handover_id:state.handovers[id]??null})):ids.map(id=>({id,code:`BG-${id}`,status:'PENDING'})),error:null}),
    eq:(_c:string,id:string)=>({maybeSingle:async()=>({data:table==='cash_handovers'?{id,code:`BG-${id}`,status:'PENDING',cancel_requested_by:null,cancel_requested_at:null}:{id,deleted_at:null},error:null})})};
  return q;}};return state;});
vi.mock('react',async original=>({...await original<typeof import('react')>(),useRef:(current:unknown)=>({current})}));
vi.mock('@tanstack/react-query',()=>({useMutation:(options:unknown)=>options,useQueryClient:()=>({invalidateQueries:vi.fn()})}));
vi.mock('@/lib/authSession',()=>({getSessionUser:async()=>({id:'u'})}));
// Lập phiên bàn giao đọc phiên của các phiếu trước khi gửi (đợt 4): bảng phiếu giả theo `h.handovers`.
vi.mock('@/integrations/supabase/client',()=>({supabase:{rpc:h.rpc,from:(table:string)=>h.readChain(table)}}));
import {useConfirmCashbookClosing,useCancelCashbookClosing,useProposeCashbookClosing} from '../useCashbookClosing';
import {useCreateHandover,useConfirmHandover,useRequestCancelHandover,useConfirmCancelHandover,useRejectCancelHandover} from '../useCashHandovers';
import {FinancialWorkflowError} from '@/lib/financialWorkflow';
const writer=(hook:unknown)=>(hook as {mutationFn:(input:unknown)=>Promise<unknown>}).mutationFn;
const timeout={data:null,error:{status:504,message:'timeout'}};
// Danh sách chốt sổ (đợt 5): một đề nghị đang chờ của sổ b1.
const closingList={data:{pending:[{request_id:'r1',cashbook_id:'b1',cashbook_name:'Quỹ',closed_through:'2026-09-30'}],closures:[]},error:null};
const writes=(name:string)=>h.rpc.mock.calls.filter(call=>call[0]===name).length;
beforeEach(()=>{localStorage.clear();localStorage.setItem('ihomecrm.selectedOrganizationId','org-a');h.rpc.mockReset();});
// Đợt 5: xác nhận và huỷ chốt sổ không còn chung một dấu. Xác nhận kẹt không chặn huỷ; xác nhận lần sau đọc danh sách,
// đề nghị còn chờ thì ký lại (máy chủ khoá đề nghị rồi mới xét).
it('closing confirmation timeout no longer blocks cancel; the next confirmation reads the list and resends',async()=>{
 h.rpc.mockImplementation(async(name:string)=>name==='list_cashbook_closings_v1'?closingList:timeout);
 await expect(writer(useConfirmCashbookClosing())({requestId:'r1',countedBalance:0})).rejects.toBeInstanceOf(FinancialWorkflowError);
 localStorage.setItem('ihomecrm.selectedOrganizationId','org-b');
 await expect(writer(useCancelCashbookClosing())({requestId:'r1',reason:'Kiểm tra'})).rejects.toBeInstanceOf(FinancialWorkflowError);
 expect(writes('cancel_cashbook_closing_v1')).toBe(1);
 await expect(writer(useConfirmCashbookClosing())({requestId:'r1',countedBalance:0})).rejects.toBeInstanceOf(FinancialWorkflowError);
 expect(writes('confirm_cashbook_closing_v1')).toBe(2);
});
it.each([useRequestCancelHandover,useConfirmCancelHandover,useRejectCancelHandover])('handover timeout no longer blocks a different lifecycle action on the same ID',async next=>{
 h.rpc.mockResolvedValue(timeout);
 await expect(writer(useConfirmHandover())({handoverId:'h1'})).rejects.toBeInstanceOf(FinancialWorkflowError);
 localStorage.setItem('ihomecrm.selectedOrganizationId','org-b');
 await expect(writer(next())({handoverId:'h1',reason:'Kiểm tra'})).rejects.toBeInstanceOf(FinancialWorkflowError);expect(h.rpc).toHaveBeenCalledTimes(2);
});
// Đợt 4: lập phiên chưa rõ kết quả không còn chặn mãi. Lần sau đọc phiên của các phiếu: đã vào phiên ⇒ báo mã, không
// gửi (kể cả đảo thứ tự phiếu, đổi người nhận); còn trống ⇒ gửi lại, vì máy chủ khoá phiếu rồi mới xét handover_id.
it('handover creation timeout is resolved by reading the vouchers: taken ones are reported, free ones are resent',async()=>{
 h.handovers={};
 h.rpc.mockResolvedValue(timeout);
 await expect(writer(useCreateHandover())({receiverId:'receiver',voucherIds:['v1','v2']})).rejects.toBeInstanceOf(FinancialWorkflowError);
 h.handovers={v1:'h1',v2:'h1'};
 await expect(writer(useCreateHandover())({receiverId:'other',voucherIds:['v2','v1']})).rejects.toMatchObject({outcome:'failure',message:expect.stringContaining('BG-h1')});expect(h.rpc).toHaveBeenCalledTimes(1);
 h.handovers={};
 h.rpc.mockResolvedValue({data:{id:'h2',code:'BG2',total_amount:1,voucher_count:2},error:null});
 await expect(writer(useCreateHandover())({receiverId:'other',voucherIds:['v2','v1']})).resolves.toMatchObject({id:'h2'});expect(h.rpc).toHaveBeenCalledTimes(2);
});
it.each([{request_id:'r2',closure_id:1,closed_through:'2026-09-30',status:'CONFIRMED'},{request_id:'r1',closure_id:1,closed_through:'2026-02-31',status:'CONFIRMED'}])('closing receipt must match the exact request and a real date: %j',async data=>{
 h.rpc.mockImplementation(async(name:string)=>name==='list_cashbook_closings_v1'?closingList:{data,error:null});await expect(writer(useConfirmCashbookClosing())({requestId:'r1',countedBalance:0})).rejects.toBeInstanceOf(FinancialWorkflowError);
});
it('proposal receipt must match the actual cashbook',async()=>{
 h.rpc.mockResolvedValue({data:{request_id:'r1',cashbook_id:'other',status:'PENDING'},error:null});
 await expect(writer(useProposeCashbookClosing())({cashbookId:'b1',confirmerUserId:'other',countedBalance:0})).rejects.toBeInstanceOf(FinancialWorkflowError);
});

// Đợt 6 (cách B): lần bấm sau gửi lại ĐÚNG mã cũ (create_cashbook_v1 khoá công ty rồi tra mã); tên khác là nội dung khác nên
// máy chủ báo trùng mã nếu lần trước đã tạo. Không bao giờ gửi mã mới khi dấu còn đó, kể cả sau khi đổi tổ chức đang chọn.
it('a cashbook create timeout retains the exact idempotency key; the next create after remount resends that key',async()=>{
 h.rpc.mockResolvedValue(timeout);
 const {useCreateAccount}=await import('../useAccounts');
 const values={name:'Sổ A',initial_amount:0,initial_date:'2026-09-30'};
 await expect(writer(useCreateAccount())(values)).rejects.toBeInstanceOf(FinancialWorkflowError);
 const {financialPending}=await import('@/lib/financialPending');
 const saved=financialPending.read({namespace:'cashbook-create',userId:'u',organizationId:'actor-scope',businessKey:'new'});
 expect(h.rpc.mock.calls[0][1].p_idempotency_key).toBe(saved?.requestKey);
 localStorage.setItem('ihomecrm.selectedOrganizationId','org-b');
 h.rpc.mockResolvedValue({data:null,error:{code:'23505',message:'idempotency_key đã dùng với nội dung khác'}});
 await expect(writer(useCreateAccount())({...values,name:'Sổ B'})).rejects.toMatchObject({alreadyRecorded:true});
 expect(h.rpc).toHaveBeenCalledTimes(2);
 expect(h.rpc.mock.calls[1][1].p_idempotency_key).toBe(saved?.requestKey);
});
// Đợt 5: lưu trữ tách khỏi dấu `cashbook-lifecycle` của sửa sổ; dấu bản trước ở đó vẫn chặn lưu trữ đúng sổ đó (hộp cảnh
// báo). Đợt 8: sửa sổ đặt giá trị tuyệt đối (update_cashbook_metadata_v1) nên không ghi dấu nào nữa; lần sửa chưa rõ kết
// quả không còn chặn lưu trữ (archive_cashbook_v1 khoá sổ rồi mới xét, đòi sổ hết phiếu; sửa sổ không thêm phiếu nào).
it('an unknown cashbook metadata update leaves no marker and no longer blocks archive on that cashbook',async()=>{
 h.rpc.mockResolvedValue(timeout);
 const {useUpdateAccount,useDeleteAccount}=await import('../useAccounts');
 const {RepeatableWriteUnknownError}=await import('@/lib/financialWorkflow');
 const {financialPending}=await import('@/lib/financialPending');
 await expect(writer(useUpdateAccount())({id:'book1',values:{name:'Sổ A',initial_amount:0,initial_date:'2026-09-30'}})).rejects.toBeInstanceOf(RepeatableWriteUnknownError);
 expect(financialPending.read({namespace:'cashbook-lifecycle',userId:'u',organizationId:'actor-scope',businessKey:'book1'})).toBeNull();
 await expect(writer(useDeleteAccount())('book1')).rejects.toBeInstanceOf(FinancialWorkflowError);
 expect(h.rpc.mock.calls.map(call=>call[0])).toEqual(['update_cashbook_metadata_v1','archive_cashbook_v1']);
});
