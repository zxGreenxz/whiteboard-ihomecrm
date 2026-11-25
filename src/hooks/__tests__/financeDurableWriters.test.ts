// @vitest-environment jsdom
import {renderHook,cleanup} from '@testing-library/react';
import {afterEach,beforeEach,it,expect,vi} from 'vitest';
const h=vi.hoisted(()=>({rpc:vi.fn(),read:vi.fn(),upload:vi.fn(),toast:vi.fn(),organization:'org1',tables:{} as Record<string,unknown>}));
vi.mock('@/integrations/supabase/client',()=>({supabase:{rpc:h.rpc,from:(table:string)=>{type QueryFixture={select:()=>QueryFixture;eq:()=>QueryFixture;update:()=>QueryFixture;in:()=>QueryFixture;neq:()=>QueryFixture;delete:()=>QueryFixture;limit:()=>QueryFixture;single:typeof h.read;maybeSingle:typeof h.read;then:(done:(response:{data:unknown;error:null})=>unknown)=>Promise<unknown>};const b:QueryFixture={select:()=>b,eq:()=>b,update:()=>b,in:()=>b,neq:()=>b,delete:()=>b,limit:()=>b,single:h.read,maybeSingle:h.read,then:done=>Promise.resolve({data:h.tables[table]??null,error:null}).then(done)};return b;}}}));
vi.mock('@tanstack/react-query',()=>({useMutation:(o:unknown)=>o,useQueryClient:()=>({invalidateQueries:vi.fn()})}));
vi.mock('@/contexts/OrganizationContext',()=>({useOrganization:()=>({selectedOrganizationId:h.organization})}));
vi.mock('@/lib/authSession',()=>({getSessionUser:async()=>({id:'u1'})}));
vi.mock('sonner',()=>({toast:{error:vi.fn(),warning:vi.fn(),success:vi.fn(),info:vi.fn()}}));
import {useApproveInvoice,useUnapproveInvoice,useCancelInvoice,useForceCancelInvoice,useRestoreInvoice} from '../useInvoices';
import {useRecordRefundRPC} from '../useInvoicePayments';
import {useApproveIncomeExpenseV2,usePostApprovedIncomeExpenseV2,useApproveAndPostIncomeExpenseV2,useReversePostingV2} from '../income-expenses/financeV2Mutations';
import {useDecideApproval,useWithdrawApproval} from '../useApprovals';
import {useDeletePayment} from '../useDeletePayment';
import {useCancelIncomeExpenseBatch,useUpdateBatchAccount} from '../income-expenses/batch';
vi.mock('@/lib/receiptUpload',()=>({validateReceiptFile:()=>null,uploadReceiptToStorage:h.upload}));
vi.mock('@/hooks/use-toast',()=>({useToast:()=>({toast:h.toast})}));
import {useUploadPaymentReceipt} from '../useUploadPaymentReceipt';
import {useGenerateRecurringVouchers,useStopRecurring} from '../income-expenses/recurring';
import {useSetForfeitVoucherKqkd} from '../income-expenses/forfeitKqkd';
import {financialPending} from '@/lib/financialPending';
import {useApproveVoucher,useUnapproveVoucher,useCancelIncomeExpense,useRestoreIncomeExpense,useVerifyIncomeExpense} from '../income-expenses/statusMutations';
import {useCancelVoucherFlex} from '../income-expenses/flexMutations';
import {useCancelIncomeVoucher} from '../income-expenses/incomeVoucherCancel';
type Mutation<T=unknown>={mutationFn:(input:unknown)=>Promise<T>};
type HookReceipt<T>=T extends {mutateAsync:(...args:never[])=>Promise<infer R>}?R:unknown;
const mount=<H extends()=>unknown>(hook:H)=>{const result=renderHook(hook);return {...result,mutation:result.result.current as unknown as Mutation<HookReceipt<ReturnType<H>>>};};
const scope=(namespace:string,businessKey='i1')=>({namespace,businessKey,userId:'u1',organizationId:'org1'});
afterEach(cleanup);
beforeEach(()=>{vi.clearAllMocks();h.rpc.mockReset();h.read.mockReset();h.upload.mockReset();localStorage.clear();localStorage.setItem('ihomecrm.selectedOrganizationId','org1');h.organization='org1';h.tables={};h.read.mockResolvedValue({data:{id:'i1',status:'DRAFT',paid_amount:0,deleted_at:null},error:null});});
const invoiceCases=[
 ['invoice-approve',useApproveInvoice,'APPROVED'],['invoice-unapprove',useUnapproveInvoice,'DRAFT'],['invoice-cancel',useCancelInvoice,'CANCELLED'],['invoice-force-cancel',useForceCancelInvoice,'CANCELLED'],['invoice-restore',useRestoreInvoice,'APPROVED'],
] as const;
// Duyệt / bỏ duyệt hoá đơn là mã chết (đợt 11): vẫn khoá như cũ.
it.each(invoiceCases.slice(0,2))('%s: timeout khóa qua remount và giữ cùng mã yêu cầu',async(namespace,hook)=>{
 h.rpc.mockRejectedValueOnce(new TypeError('Failed to fetch'));const first=mount(hook);await expect(first.mutation.mutationFn('i1')).rejects.toThrow();
 const pending=financialPending.read(scope(namespace));expect(pending).not.toBeNull();expect(pending?.requestKey).toEqual(expect.any(String));first.unmount();
 await expect(mount(hook).mutation.mutationFn('i1')).rejects.toThrow(/đối chiếu/);expect(h.rpc).toHaveBeenCalledTimes(1);expect(financialPending.read(scope(namespace))?.requestKey).toBe(pending?.requestKey);
});
// Đợt 5: huỷ / buộc huỷ / khôi phục đọc trạng thái hoá đơn; còn như lúc bấm thì gửi lại NGAY đúng mã cũ (máy chủ khoá hoá
// đơn rồi trả noop), không chặn mãi.
it.each(invoiceCases.slice(2))('%s: timeout qua remount gửi lại đúng mã yêu cầu cũ khi hoá đơn còn như lúc bấm',async(namespace,hook,state)=>{
 h.rpc.mockRejectedValueOnce(new TypeError('Failed to fetch')).mockResolvedValueOnce({data:{invoice:{id:'i1',status:state}},error:null});
 const first=mount(hook);await expect(first.mutation.mutationFn('i1')).rejects.toThrow();
 const pending=financialPending.read(scope(namespace));expect(pending?.requestKey).toEqual(expect.any(String));first.unmount();
 await expect(mount(hook).mutation.mutationFn('i1')).resolves.toMatchObject({invoice:{status:state}});
 expect(h.rpc).toHaveBeenCalledTimes(2);expect(h.rpc.mock.calls.map(call=>call[1].p_idempotency_key)).toEqual([pending?.requestKey,pending?.requestKey]);
 expect(financialPending.read(scope(namespace))).toBeNull();
});
it.each(invoiceCases)('%s: chỉ trạng thái đúng hóa đơn mới giải phóng pending',async(namespace,hook,state)=>{
 h.rpc.mockResolvedValueOnce({data:{invoice:{id:'i1',status:state}},error:null});await expect(mount(hook).mutation.mutationFn('i1')).resolves.toBeDefined();expect(financialPending.read(scope(namespace))).toBeNull();
});
it('duyệt trả DRAFT không nói thành công hoặc bỏ dấu đối chiếu',async()=>{
 h.rpc.mockResolvedValue({data:{invoice:{id:'i1',status:'DRAFT'}},error:null});await expect(mount(useApproveInvoice).mutation.mutationFn('i1')).rejects.toThrow();expect(financialPending.read(scope('invoice-approve'))).not.toBeNull();
});
it('biểu mẫu hóa đơn org cũ phải chặn trước writer',async()=>{
 const entry=mount(useApproveInvoice);localStorage.setItem('ihomecrm.selectedOrganizationId','org2');await expect(entry.mutation.mutationFn('i1')).rejects.toThrow(/tổ chức/);expect(h.rpc).not.toHaveBeenCalled();
});
const refund={invoice_id:'i1',amount:100,payment_date:'2026-09-30',account_id:'a1'};
// Đợt 2 (24/11/2026): phép đọc trạng thái nằm SAU khi gỡ dấu; trước đây nó hỏng thì giữ dấu và chặn mãi.
it('hoàn trả đã nhận ID nhưng đọc trạng thái lỗi: không giữ dấu, trả mã phiếu để báo cần kiểm tra, không lập lại',async()=>{
 h.rpc.mockResolvedValue({data:{refundVoucherId:'rv1'},error:null});h.read.mockResolvedValue({data:null,error:{code:'42501'}});
 await expect(mount(useRecordRefundRPC).mutation.mutationFn(refund)).resolves.toMatchObject({id:'rv1',approval_status:null});
 expect(financialPending.read(scope('invoice-refund'))).toBeNull();expect(h.rpc).toHaveBeenCalledTimes(1);
});
it('hoàn trả gửi đúng key đã lưu trước RPC và thành công chờ duyệt xóa pending',async()=>{
 h.rpc.mockImplementation((_name:string,args:{p_idempotency_key:string;input:{idempotencyKey:string}})=>{expect(args.p_idempotency_key).toBe(financialPending.read(scope('invoice-refund'))?.requestKey);return Promise.resolve({data:{refundVoucherId:'rv1'},error:null});});
 h.read.mockResolvedValue({data:{code:'PC01',approval_status:'UNAPPROVED',posting_status:'UNPOSTED'},error:null});const receipt=await mount(useRecordRefundRPC).mutation.mutationFn(refund);expect(receipt.id).toBe('rv1');expect(financialPending.read(scope('invoice-refund'))).toBeNull();
});
it.each([NaN,Infinity,-1,0])('hoàn trả số tiền sai %s chặn trước writer',async amount=>{await expect(mount(useRecordRefundRPC).mutation.mutationFn({...refund,amount})).rejects.toThrow();expect(h.rpc).not.toHaveBeenCalled();});
const posting={subjectKind:'VOUCHER',subjectId:'v1',cashbookId:'a1',postedOn:'2026-09-30',evidenceIds:[],expectedApprovalVersion:1,expectedPostingVersion:1,idempotencyKey:'ui-key'};
const v2Cases=[['voucher-v2-approve',useApproveIncomeExpenseV2,{voucherId:'v1'}],['voucher-v2-post',usePostApprovedIncomeExpenseV2,posting],['voucher-v2-approve-post',useApproveAndPostIncomeExpenseV2,posting],['voucher-v2-reverse',useReversePostingV2,{voucherId:'v1',cashbookId:'a1'}]] as const;
it('hoàn tác hoa hồng không được tự sinh lý do thay cho người dùng',async()=>{
 h.rpc.mockResolvedValue({data:{voucherId:'v1',approvalStatus:'APPROVED',postingStatus:'REVERSED'},error:null});
 await expect(mount(useReversePostingV2).mutation.mutationFn({voucherId:'v1',cashbookId:'a1',isCommission:true,reason:'  '})).rejects.toThrow(/lý do/);
 expect(h.rpc).not.toHaveBeenCalled();
 await mount(useReversePostingV2).mutation.mutationFn({voucherId:'v1',cashbookId:'a1',isCommission:true,reason:'  Hoàn tác do chuyển sai sổ quỹ  '});
 expect(h.rpc).toHaveBeenCalledWith('reverse_posted_income_expense_v2',expect.objectContaining({p_reason:'Hoàn tác do chuyển sai sổ quỹ'}));
});
// Đợt 5 (cách B): cùng nội dung ⇒ gửi lại NGAY đúng mã cũ qua remount (máy chủ khoá phiếu rồi tra mã, trả kết quả cũ).
it.each(v2Cases)('%s: timeout giữ key; lần sau cùng nội dung gửi lại đúng key cũ qua remount',async(namespace,hook,input)=>{
 const receipt={data:{voucherId:'v1',approvalStatus:'APPROVED',postingStatus:namespace.endsWith('reverse')?'REVERSED':'POSTED'},error:null};
 h.rpc.mockRejectedValueOnce(new TypeError('Failed to fetch')).mockResolvedValueOnce(receipt);const first=mount(hook);await expect(first.mutation.mutationFn(input)).rejects.toThrow();const prior=financialPending.read(scope(namespace,'v1'));expect(prior?.requestKey).toEqual(expect.any(String));first.unmount();
 await expect(mount(hook).mutation.mutationFn(input)).resolves.toBeDefined();expect(h.rpc).toHaveBeenCalledTimes(2);
 const keys=h.rpc.mock.calls.map(call=>(call[1] as {p_idempotency_key?:string;input?:{idempotencyKey:string}}).p_idempotency_key??(call[1] as {input:{idempotencyKey:string}}).input.idempotencyKey);
 expect(keys).toEqual([prior?.requestKey,prior?.requestKey]);expect(financialPending.read(scope(namespace,'v1'))).toBeNull();
});
it.each(v2Cases)('%s: trạng thái đúng nhưng receipt của phiếu khác vẫn khóa',async(namespace,hook,input)=>{
 h.rpc.mockResolvedValue({data:{voucherId:'other',approvalStatus:'APPROVED',postingStatus:namespace.endsWith('reverse')?'REVERSED':'POSTED'},error:null});await expect(mount(hook).mutation.mutationFn(input)).rejects.toThrow();expect(financialPending.read(scope(namespace,'v1'))).not.toBeNull();
});
it.each(v2Cases)('%s: đúng receipt dùng key bền vững và gỡ pending',async(namespace,hook,input)=>{
 h.rpc.mockImplementation((_name:string,args:{p_idempotency_key:string;input:{idempotencyKey:string}})=>{expect(args.p_idempotency_key??args.input.idempotencyKey).toBe(financialPending.read(scope(namespace,'v1'))?.requestKey);return Promise.resolve({data:{voucherId:'v1',approvalStatus:'APPROVED',postingStatus:namespace.endsWith('reverse')?'REVERSED':'POSTED'},error:null});});await expect(mount(hook).mutation.mutationFn(input)).resolves.toBeDefined();expect(financialPending.read(scope(namespace,'v1'))).toBeNull();
});
it('V2 biểu mẫu thuộc org cũ không gọi writer trong org mới',async()=>{const entry=mount(usePostApprovedIncomeExpenseV2);localStorage.setItem('ihomecrm.selectedOrganizationId','org2');await expect(entry.mutation.mutationFn(posting)).rejects.toThrow(/tổ chức/);expect(h.rpc).not.toHaveBeenCalled();});

const approvalCases=[['quyết định',useDecideApproval,{requestId:'req1',decision:'APPROVE',organizationId:'org1'}],['thu hồi',useWithdrawApproval,{requestId:'req1',organizationId:'org1'}]] as const;
// Đợt 5: quyết định đọc ảnh trạng thái yêu cầu (get_approval_request_detail_compat_v2) trước khi ghi dấu. Máy chủ giả trả
// yêu cầu còn chờ; mọi lệnh ghi rớt mạng.
const pendingRequestDetail=()=>h.rpc.mockImplementation(async(name:string)=>name==='get_approval_request_detail_compat_v2'
 ?{data:{id:'req1',state:'PENDING_APPROVAL',version:1,can_decide:true,steps:[{step_no:1,status:'PENDING',current_generation:1}]},error:null}
 :Promise.reject(new TypeError('Failed to fetch')));
const writes=()=>h.rpc.mock.calls.filter(call=>call[0]!=='get_approval_request_detail_compat_v2').length;
it.each(approvalCases)('yêu cầu duyệt %s timeout chặn cả approve/reject/withdraw sau remount khi yêu cầu còn như lúc bấm (dưới 2 phút)',async(_label,hook,input)=>{
 pendingRequestDetail();const first=mount(hook);await expect(first.mutation.mutationFn(input)).rejects.toThrow();expect(financialPending.read({...scope('approval-request','req1'),organizationId:'actor-scope'})).not.toBeNull();first.unmount();
 await expect(mount(useWithdrawApproval).mutation.mutationFn({requestId:'req1',organizationId:'org1'})).rejects.toThrow(/đối chiếu/);await expect(mount(useDecideApproval).mutation.mutationFn({requestId:'req1',decision:'REJECT',organizationId:'org1'})).rejects.toThrow(/đối chiếu/);expect(writes()).toBe(1);
});
it.each(approvalCases)('yêu cầu duyệt %s state đúng nhưng requestID sai giữ khóa',async(_label,hook,input)=>{
 h.rpc.mockResolvedValue({data:{request_id:'other',state:Object.prototype.hasOwnProperty.call(input,'decision')?'PENDING_APPROVAL':'CANCELLED'},error:null});await expect(mount(hook).mutation.mutationFn(input)).rejects.toThrow();expect(financialPending.read({...scope('approval-request','req1'),organizationId:'actor-scope'})).not.toBeNull();
});
it('quorum PENDING_APPROVAL đúng request là bước đã nhận và gỡ khóa, không đoán toàn yêu cầu đã xong',async()=>{
 h.rpc.mockResolvedValue({data:{request_id:'req1',state:'PENDING_APPROVAL'},error:null});await expect(mount(useDecideApproval).mutation.mutationFn({requestId:'req1',decision:'APPROVE',organizationId:'org1'})).resolves.toMatchObject({state:'PENDING_APPROVAL'});expect(financialPending.read({...scope('approval-request','req1'),organizationId:'actor-scope'})).toBeNull();
});
it('inbox đa tổ chức và org metadata null dùng marker actor stable, metadata cập nhật không vượt khóa',async()=>{
 pendingRequestDetail();await expect(mount(useDecideApproval).mutation.mutationFn({requestId:'req1',decision:'APPROVE',organizationId:null})).rejects.toThrow();
 expect(financialPending.read({...scope('approval-request','req1'),organizationId:'actor-scope'})).not.toBeNull();
 await expect(mount(useWithdrawApproval).mutation.mutationFn({requestId:'req1',organizationId:'org2'})).rejects.toThrow(/đối chiếu/);expect(writes()).toBe(1);
});
// Đợt 2 (24/11/2026): máy chủ chống trùng theo khoá nên lần sau gửi lại CÙNG mã thay vì chặn mãi.
it('hoàn tác collection timeout giữ dấu qua remount; gọi lại bằng payment liên kết gửi lại đúng mã cũ của collection',async()=>{
 h.rpc.mockRejectedValue(new TypeError('Failed to fetch'));await expect(mount(useDeletePayment).mutation.mutationFn({collection_id:'c1',reason:'Thu tiền bị trùng'})).rejects.toThrow();
 const prior=financialPending.read(scope('collection-reversal','c1'));expect(prior).not.toBeNull();
 h.read.mockResolvedValue({data:{id:'p1',collection_id:'c1'},error:null});h.rpc.mockResolvedValue({data:{collection_id:'c1',status:'REVERSED',reversal_mode:'IN_PLACE_CANCEL'},error:null});
 await expect(mount(useDeletePayment).mutation.mutationFn({payment_id:'p1',reason:'Thu tiền bị trùng'})).resolves.toMatchObject({mode:'COLLECTION_REVERSED'});
 expect(h.rpc.mock.calls.map(call=>call[1].p_idempotency_key)).toEqual([prior?.requestKey,prior?.requestKey]);
 expect(financialPending.read(scope('collection-reversal','c1'))).toBeNull();
});
it.each([null,{collection_id:'other',status:'REVERSED',reversal_mode:'IN_PLACE_CANCEL'},{collection_id:'c1',status:'REVERSED',reversal_mode:'NEW_MODE'}])('hoàn tác thiếu/sai receipt không báo đã hoàn tác: %s',async data=>{
 h.rpc.mockResolvedValue({data,error:null});await expect(mount(useDeletePayment).mutation.mutationFn({collection_id:'c1',reason:'Thu tiền bị trùng'})).rejects.toThrow();expect(financialPending.read(scope('collection-reversal','c1'))).not.toBeNull();
});
it('hoàn tác receipt đúng source/state/mode dùng pkey lưu trước RPC',async()=>{
 h.rpc.mockImplementation((_name:string,args:{p_idempotency_key:string;input:{idempotencyKey:string}})=>{expect(args.p_idempotency_key).toBe(financialPending.read(scope('collection-reversal','c1'))?.requestKey);return Promise.resolve({data:{collection_id:'c1',status:'REVERSED',reversal_mode:'IN_PLACE_CANCEL'},error:null});});
 await expect(mount(useDeletePayment).mutation.mutationFn({collection_id:'c1',reason:'Thu tiền bị trùng'})).resolves.toMatchObject({reversalMode:'IN_PLACE_CANCEL'});expect(financialPending.read(scope('collection-reversal','c1'))).toBeNull();
});
it('hủy đợt dòng một thành công dòng hai timeout giữ ID và khóa cả đợt qua remount',async()=>{
 h.tables={income_expense_batch_items:[{income_expense_id:'v1'},{income_expense_id:'v2'}],income_expenses:[{id:'v1',type:'INCOME',payment_id:null},{id:'v2',type:'INCOME',payment_id:null}]};
 h.rpc.mockResolvedValueOnce({data:{id:'v1',changed:true},error:null}).mockRejectedValueOnce(new TypeError('Failed to fetch'));
 const result=await mount(useCancelIncomeExpenseBatch).mutation.mutationFn({batchId:'b1',reason:'Huỷ đợt phiếu lập nhầm'});expect(result).toMatchObject({count:1,completedIds:['v1'],failures:[{id:'v2'}]});expect(financialPending.read(scope('voucher-batch-cancel','b1'))?.completedIds).toEqual(['v1']);
 await expect(mount(useCancelIncomeExpenseBatch).mutation.mutationFn({batchId:'b1',reason:'Huỷ đợt phiếu lập nhầm'})).rejects.toThrow(/đối chiếu/);expect(h.rpc).toHaveBeenCalledTimes(2);
});
it('đổi sổ đợt giữ ID đổi xong và cùng requestKey qua timeout/remount, rồi chạy lại cùng requestKey',async()=>{
 h.tables={income_expense_batch_items:[{income_expense_id:'v1'},{income_expense_id:'v2'}],income_expenses:[{id:'v1',code:'PC01',approval_status:'UNAPPROVED',approval_version:1,account_id:'old'},{id:'v2',code:'PC02',approval_status:'UNAPPROVED',approval_version:1,account_id:'old'}]};
 h.rpc.mockImplementationOnce((_name:string,args:{p_idempotency_key:string;input:{idempotencyKey:string}})=>{expect(args.p_idempotency_key).toContain(financialPending.read(scope('voucher-batch-account','b1'))?.requestKey);return Promise.resolve({data:{id:'v1',changed:true,approval_version:2,changed_fields:['account_id']},error:null});}).mockRejectedValueOnce(new TypeError('Failed to fetch'));
 await expect(mount(useUpdateBatchAccount).mutation.mutationFn({batchId:'b1',accountId:'new',reason:'Đổi sổ ghi phiếu'})).rejects.toThrow();expect(financialPending.read(scope('voucher-batch-account','b1'))?.completedIds).toEqual(['v1']);
 // Đợt 6 (cách A): lần bấm sau chạy lại ngay với CÙNG mã yêu cầu của dấu (mã từng phiếu gồm cả sổ đích), không bị khoá.
 const requestKey=financialPending.read(scope('voucher-batch-account','b1'))?.requestKey;
 h.rpc.mockImplementation((_name:string,args:{p_voucher:string})=>Promise.resolve({data:{id:args.p_voucher,changed:true,approval_version:2,changed_fields:['account_id']},error:null}));
 await expect(mount(useUpdateBatchAccount).mutation.mutationFn({batchId:'b1',accountId:'different',reason:'Đổi sổ ghi phiếu'})).resolves.toMatchObject({count:2});
 expect(h.rpc.mock.calls.slice(2).map(call=>call[1].p_idempotency_key)).toEqual([`${requestKey}:v1:different`,`${requestKey}:v2:different`]);
 expect(financialPending.read(scope('voucher-batch-account','b1'))).toBeNull();
});

// Đợt 5: mỗi thao tác phiếu một namespace riêng (trước: chung `voucher-lifecycle`). Dấu vẫn theo phạm vi người dùng
// (đổi công ty đang chọn không vượt được); thao tác khác trên cùng phiếu không còn bị chặn.
const voucherLifecycleCases=[['duyệt','voucher-approve',useApproveVoucher,{id:'v1',expectedApprovalVersion:1}],['bỏ duyệt','voucher-unapprove',useUnapproveVoucher,'v1'],['huỷ','voucher-cancel',useCancelIncomeExpense,'v1'],['khôi phục','voucher-restore',useRestoreIncomeExpense,'v1'],['đổi kiểm','voucher-verify',useVerifyIncomeExpense,{id:'v1',note:null}]] as const;
const voucherScope=(namespace:string)=>({...scope(namespace,'v1'),organizationId:'actor-scope'});
const voucherLifecycleScope=voucherScope('voucher-lifecycle');
it.each(voucherLifecycleCases)('lifecycle phiếu %s timeout giữ dấu ở namespace riêng (phạm vi người dùng), không ghi dấu chung',async(_label,namespace,hook,input)=>{
 h.rpc.mockRejectedValue(new TypeError('Failed to fetch'));await expect(mount(hook).mutation.mutationFn(input)).rejects.toThrow();
 localStorage.setItem('ihomecrm.selectedOrganizationId','org2');
 expect(financialPending.read(voucherScope(namespace))).not.toBeNull();expect(financialPending.read(voucherLifecycleScope)).toBeNull();
});
it('dấu chung `voucher-lifecycle` bản trước chặn mọi thao tác trên đúng phiếu đó, kể cả sau khi đổi công ty',async()=>{
 localStorage.setItem('ihome:financial-pending:v1:voucher-lifecycle:u1:actor-scope:v1',JSON.stringify({...voucherLifecycleScope,attemptId:'old',requestKey:'old',completedIds:[],startedAt:'2026-11-20T01:00:00.000Z'}));
 localStorage.setItem('ihomecrm.selectedOrganizationId','org2');
 for(const [,,hook,input] of voucherLifecycleCases)await expect(mount(hook).mutation.mutationFn(input)).rejects.toThrow(/đối chiếu/);
 expect(h.rpc).not.toHaveBeenCalled();
});
it('duyệt checked trả ID khác không đủ bằng chứng duyệt target',async()=>{
 h.rpc.mockResolvedValue({data:{id:'other',approved:true,already:false,mode:'VOUCHER'},error:null});await expect(mount(useApproveVoucher).mutation.mutationFn({id:'v1',expectedApprovalVersion:1})).rejects.toThrow();expect(financialPending.read(voucherScope('voucher-approve'))).not.toBeNull();
});
it.each([null,{id:'other',approval_status:'UNAPPROVED',posting_status:'UNPOSTED'},{id:'v1',approval_status:'NEW_STATE',posting_status:'UNPOSTED'}])('bỏ duyệt RPC void cần readback đúng target/status: %s',async data=>{
 h.rpc.mockResolvedValueOnce({data:null,error:{code:'55000',message:'not a termination forfeit pair'}}).mockResolvedValueOnce({data:null,error:null});h.read.mockResolvedValue({data,error:null});await expect(mount(useUnapproveVoucher).mutation.mutationFn('v1')).rejects.toThrow();expect(financialPending.read(voucherScope('voucher-unapprove'))).not.toBeNull();
});
it.each([['voucher-restore',useRestoreIncomeExpense],['voucher-verify',useVerifyIncomeExpense]] as const)('%s không được giải phóng khóa khi readback thiếu',async(namespace,hook)=>{
 // Phép đọc trước khi ghi dấu thấy phiếu; phép đọc xác nhận sau lệnh ghi hỏng.
 h.rpc.mockResolvedValue({data:null,error:null});h.read.mockResolvedValueOnce({data:{id:'v1',code:'PT01',approval_status:'CANCELLED',verified_at:null},error:null}).mockResolvedValue({data:null,error:{code:'42501'}});await expect(mount(hook).mutation.mutationFn(hook===useRestoreIncomeExpense?'v1':{id:'v1',note:null})).rejects.toThrow();expect(financialPending.read(voucherScope(namespace))).not.toBeNull();
});
it.each([useRestoreIncomeExpense,useVerifyIncomeExpense])('đọc phiếu hỏng TRƯỚC khi ghi dấu: không ghi dấu, không gửi',async hook=>{
 h.read.mockResolvedValue({data:null,error:{code:'',message:'Failed to fetch'}});await expect(mount(hook).mutation.mutationFn(hook===useRestoreIncomeExpense?'v1':{id:'v1',note:null})).rejects.toBeTruthy();
 expect(h.rpc).not.toHaveBeenCalled();expect(financialPending.read(voucherScope('voucher-restore'))).toBeNull();expect(financialPending.read(voucherScope('voucher-verify'))).toBeNull();
});
it('huỷ flex receipt thiếu ID/changed không phải thành công',async()=>{
 h.rpc.mockResolvedValueOnce({data:null,error:{code:'55000',message:'not a termination forfeit pair'}}).mockResolvedValueOnce({data:{},error:null});await expect(mount(useCancelIncomeExpense).mutation.mutationFn({id:'v1',reason:'Ghi phiếu bị trùng'})).rejects.toThrow();expect(financialPending.read(voucherScope('voucher-cancel'))).not.toBeNull();
});
it('huỷ sau hoàn tác phải dùng requestKey persisted và giữ đúng completed ID nếu huỷ bị từ chối',async()=>{
 h.read.mockResolvedValue({data:{id:'v1',type:'EXPENSE',approval_status:'APPROVED',posting_status:'POSTED',account_id:'a1'},error:null});h.rpc.mockResolvedValueOnce({data:null,error:{code:'55000',message:'not a termination forfeit pair'}}).mockImplementationOnce((_name:string,args:{p_idempotency_key:string;input:{idempotencyKey:string}})=>{expect(args.p_idempotency_key).toBe(financialPending.read(voucherScope('voucher-cancel'))?.requestKey);return Promise.resolve({data:{voucherId:'v1',postingStatus:'REVERSED'},error:null});}).mockResolvedValueOnce({data:null,error:{code:'0A000',message:'legacy'}}).mockResolvedValueOnce({data:null,error:{code:'42501',message:'permission denied'}});
 await expect(mount(useCancelIncomeExpense).mutation.mutationFn('v1')).rejects.toMatchObject({completedIds:['v1']});expect(financialPending.read(voucherScope('voucher-cancel'))?.completedIds).toEqual(['v1']);
});
it('duyệt và bỏ kiểm có receipt thật giải phóng marker và giữ trạng thái trả về',async()=>{
 h.rpc.mockResolvedValueOnce({data:{id:'v1',approved:true,already:false,mode:'VOUCHER'},error:null});await expect(mount(useApproveVoucher).mutation.mutationFn({id:'v1',expectedApprovalVersion:1})).resolves.toMatchObject({approved:true});expect(financialPending.read(voucherScope('voucher-approve'))).toBeNull();
 h.rpc.mockResolvedValueOnce({data:null,error:null});h.read.mockResolvedValue({data:{id:'v1',code:'PT01',verified_at:null},error:null});await expect(mount(useVerifyIncomeExpense).mutation.mutationFn({id:'v1',note:null})).resolves.toMatchObject({verified_at:null});expect(financialPending.read(voucherScope('voucher-verify'))).toBeNull();
});

it('huỷ canonical RETURNS void cần readback CANCELLED đúng phiếu trước khi gỡ khóa',async()=>{
 // Lần đọc đầu là phép đọc trạng thái trước khi ghi dấu (đợt 5).
 h.read.mockResolvedValueOnce({data:{id:'v1',type:'EXPENSE',approval_status:'UNAPPROVED',posting_status:'UNPOSTED'},error:null}).mockResolvedValueOnce({data:{id:'v1',type:'EXPENSE',approval_status:'UNAPPROVED',posting_status:'UNPOSTED'},error:null}).mockResolvedValueOnce({data:{id:'v1',code:'PC01',approval_status:'CANCELLED',posting_status:'UNPOSTED',verified_at:null},error:null});
 h.rpc.mockResolvedValueOnce({data:null,error:{code:'55000',message:'not a termination forfeit pair'}}).mockResolvedValueOnce({data:null,error:null});await expect(mount(useCancelIncomeExpense).mutation.mutationFn('v1')).resolves.toBe(false);expect(financialPending.read(voucherScope('voucher-cancel'))).toBeNull();
});

it.each([['voucher-flex-cancel',useCancelVoucherFlex],['voucher-income-cancel',useCancelIncomeVoucher]] as const)('%s: timeout ghi dấu riêng; thao tác khác trên cùng phiếu không bị chặn',async(namespace,hook)=>{
 h.rpc.mockRejectedValue(new TypeError('Failed to fetch'));await expect(mount(hook).mutation.mutationFn({voucherId:'v1',reason:'Ghi phiếu bị trùng'})).rejects.toThrow();expect(financialPending.read(voucherScope(namespace))).not.toBeNull();expect(financialPending.read(voucherLifecycleScope)).toBeNull();
 h.read.mockResolvedValue({data:{id:'v1',code:'PT01',approval_status:'CANCELLED'},error:null});
 // Lệnh khôi phục tới được máy chủ (lần gọi thứ hai), không bị dấu huỷ chặn.
 await expect(mount(useRestoreIncomeExpense).mutation.mutationFn('v1')).rejects.toBeTruthy();expect(h.rpc).toHaveBeenCalledTimes(2);expect(h.rpc.mock.calls[1][0]).toBe('restore_income_expense');
});
it.each([['voucher-flex-cancel',useCancelVoucherFlex],['voucher-income-cancel',useCancelIncomeVoucher]] as const)('%s: receipt ID khác phải giữ khóa',async(namespace,hook)=>{
 h.rpc.mockResolvedValue({data:{id:'other',changed:true,mode:'MANUAL',cancellation_kind:'CANCELLED_UNPOSTED'},error:null});await expect(mount(hook).mutation.mutationFn({voucherId:'v1',reason:'Ghi phiếu bị trùng'})).rejects.toThrow();expect(financialPending.read(voucherScope(namespace))).not.toBeNull();
});
it.each([['voucher-flex-cancel',useCancelVoucherFlex],['voucher-income-cancel',useCancelIncomeVoucher]] as const)('%s: receipt đúng/noop giải phóng marker',async(namespace,hook)=>{
 h.rpc.mockResolvedValue({data:{id:'v1',changed:false},error:null});await expect(mount(hook).mutation.mutationFn({voucherId:'v1',reason:'Ghi phiếu bị trùng'})).resolves.toMatchObject({changed:false});expect(financialPending.read(voucherScope(namespace))).toBeNull();
});

// Đợt 2 (24/11/2026): ô ảnh của phiếu thanh toán đã có = lần trước đã gắn; báo đã ghi và gỡ dấu thay vì chặn mãi.
it('ảnh payment đã gắn nhưng nguồn voucher lỗi giữ completed paymentID; lần sau thấy ô ảnh đã có thì báo đã gắn, không tải lại',async()=>{
 h.upload.mockResolvedValue('https://storage.test/receipt.png');h.read.mockResolvedValueOnce({data:{id:'p1',collection_id:null,receipt_image_url:null},error:null}).mockResolvedValueOnce({data:{id:'p1'},error:null}).mockResolvedValueOnce({data:null,error:{code:'42501',message:'permission denied'}});
 await expect(mount(useUploadPaymentReceipt).mutation.mutationFn({payment_id:'p1',file:new File(['x'],'receipt.png',{type:'image/png'})})).rejects.toMatchObject({completed:[{id:'p1',label:expect.any(String)}]});expect(financialPending.read({...scope('payment-receipt-upload','p1'),organizationId:'actor-scope'})?.completedIds).toEqual(['p1']);
 h.read.mockResolvedValueOnce({data:{id:'p1',collection_id:null,receipt_image_url:'https://storage.test/receipt.png'},error:null});
 await expect(mount(useUploadPaymentReceipt).mutation.mutationFn({payment_id:'p1',file:new File(['x'],'other.png',{type:'image/png'})})).rejects.toThrow(/lần gửi trước/);expect(h.upload).toHaveBeenCalledOnce();
 expect(financialPending.read({...scope('payment-receipt-upload','p1'),organizationId:'actor-scope'})).toBeNull();
});
it('upload raw SQL error không xuất hiện trong description người dùng',()=>{
 const mutation=mount(useUploadPaymentReceipt).result.current as unknown as {onError:(error:unknown,variables:Parameters<ReturnType<typeof useUploadPaymentReceipt>['mutateAsync']>[0])=>void};mutation.onError({code:'42501',message:'private_policy_name SQL leaked'},{payment_id:'p1',file:new File(['x'],'receipt.png')});expect(h.toast.mock.calls[0][0].description).not.toContain('private_policy_name');
});

it('sinh định kỳ timeout giữ marker actor toàn lượt, reload/orgchange không sinh lại',async()=>{
 h.rpc.mockRejectedValue(new TypeError('Failed to fetch'));await expect(mount(useGenerateRecurringVouchers).mutation.mutationFn(undefined)).rejects.toThrow();expect(financialPending.read({...scope('voucher-recurring-generate','generate'),organizationId:'actor-scope'})).not.toBeNull();localStorage.setItem('ihomecrm.selectedOrganizationId','org2');await expect(mount(useGenerateRecurringVouchers).mutation.mutationFn(undefined)).rejects.toThrow(/đối chiếu/);expect(h.rpc).toHaveBeenCalledOnce();
});
it('dừng lặp receipt cần exact ID/changed từ RPC',async()=>{
 h.rpc.mockResolvedValue({data:null,error:null});h.read.mockResolvedValue({data:{id:'other',is_recurring:false},error:null});await expect(mount(useStopRecurring).mutation.mutationFn('v1')).rejects.toThrow();expect(financialPending.read({...scope('voucher-recurring-stop','v1'),organizationId:'actor-scope'})).not.toBeNull();
});
it('KQKD changed thật nhưng thiếu/sai flag không khẳng định trạng thái và giữ marker',async()=>{
 h.rpc.mockResolvedValue({data:{id:'v1',changed:true,business_result_accounting:null},error:null});await expect(mount(useSetForfeitVoucherKqkd).mutation.mutationFn({voucherId:'v1',kqkd:true,reason:'Bổ sung báo cáo'})).rejects.toThrow();expect(financialPending.read({...scope('voucher-kqkd','v1'),organizationId:'actor-scope'})).not.toBeNull();
});
