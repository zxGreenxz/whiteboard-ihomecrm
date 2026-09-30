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
it.each(invoiceCases)('%s: timeout khóa qua remount và giữ cùng mã yêu cầu',async(namespace,hook)=>{
 h.rpc.mockRejectedValueOnce(new TypeError('Failed to fetch'));const first=mount(hook);await expect(first.mutation.mutationFn('i1')).rejects.toThrow();
 const pending=financialPending.read(scope(namespace));expect(pending).not.toBeNull();expect(pending?.requestKey).toEqual(expect.any(String));first.unmount();
 await expect(mount(hook).mutation.mutationFn('i1')).rejects.toThrow(/đối chiếu/);expect(h.rpc).toHaveBeenCalledTimes(1);expect(financialPending.read(scope(namespace))?.requestKey).toBe(pending?.requestKey);
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
it('hoàn trả đã nhận ID nhưng đọc trạng thái lỗi giữ ID qua remount, không lập lại',async()=>{
 h.rpc.mockResolvedValue({data:{refundVoucherId:'rv1'},error:null});h.read.mockResolvedValue({data:null,error:{code:'42501'}});
 const first=mount(useRecordRefundRPC);await expect(first.mutation.mutationFn(refund)).rejects.toMatchObject({outcome:'partial',completed:[{id:'rv1',label:expect.any(String)}]});
 expect(financialPending.read(scope('invoice-refund'))?.completedIds).toEqual(['rv1']);first.unmount();await expect(mount(useRecordRefundRPC).mutation.mutationFn(refund)).rejects.toThrow(/đối chiếu/);expect(h.rpc).toHaveBeenCalledTimes(1);
});
it('hoàn trả gửi đúng key đã lưu trước RPC và thành công chờ duyệt xóa pending',async()=>{
 h.rpc.mockImplementation((_name:string,args:{p_idempotency_key:string;input:{idempotencyKey:string}})=>{expect(args.p_idempotency_key).toBe(financialPending.read(scope('invoice-refund'))?.requestKey);return Promise.resolve({data:{refundVoucherId:'rv1'},error:null});});
 h.read.mockResolvedValue({data:{code:'PC01',approval_status:'UNAPPROVED',posting_status:'UNPOSTED'},error:null});const receipt=await mount(useRecordRefundRPC).mutation.mutationFn(refund);expect(receipt.id).toBe('rv1');expect(financialPending.read(scope('invoice-refund'))).toBeNull();
});
it.each([NaN,Infinity,-1,0])('hoàn trả số tiền sai %s chặn trước writer',async amount=>{await expect(mount(useRecordRefundRPC).mutation.mutationFn({...refund,amount})).rejects.toThrow();expect(h.rpc).not.toHaveBeenCalled();});
const posting={subjectKind:'VOUCHER',subjectId:'v1',cashbookId:'a1',postedOn:'2026-09-30',evidenceIds:[],expectedApprovalVersion:1,expectedPostingVersion:1,idempotencyKey:'ui-key'};
const v2Cases=[['voucher-v2-approve',useApproveIncomeExpenseV2,{voucherId:'v1'}],['voucher-v2-post',usePostApprovedIncomeExpenseV2,posting],['voucher-v2-approve-post',useApproveAndPostIncomeExpenseV2,posting],['voucher-v2-reverse',useReversePostingV2,{voucherId:'v1',cashbookId:'a1'}]] as const;
it.each(v2Cases)('%s: timeout giữ key và chặn gửi lại qua remount',async(namespace,hook,input)=>{
 h.rpc.mockRejectedValueOnce(new TypeError('Failed to fetch'));const first=mount(hook);await expect(first.mutation.mutationFn(input)).rejects.toThrow();const prior=financialPending.read(scope(namespace,'v1'));expect(prior?.requestKey).toEqual(expect.any(String));first.unmount();await expect(mount(hook).mutation.mutationFn(input)).rejects.toThrow(/đối chiếu/);expect(h.rpc).toHaveBeenCalledTimes(1);expect(financialPending.read(scope(namespace,'v1'))?.requestKey).toBe(prior?.requestKey);
});
it.each(v2Cases)('%s: trạng thái đúng nhưng receipt của phiếu khác vẫn khóa',async(namespace,hook,input)=>{
 h.rpc.mockResolvedValue({data:{voucherId:'other',approvalStatus:'APPROVED',postingStatus:namespace.endsWith('reverse')?'REVERSED':'POSTED'},error:null});await expect(mount(hook).mutation.mutationFn(input)).rejects.toThrow();expect(financialPending.read(scope(namespace,'v1'))).not.toBeNull();
});
it.each(v2Cases)('%s: đúng receipt dùng key bền vững và gỡ pending',async(namespace,hook,input)=>{
 h.rpc.mockImplementation((_name:string,args:{p_idempotency_key:string;input:{idempotencyKey:string}})=>{expect(args.p_idempotency_key??args.input.idempotencyKey).toBe(financialPending.read(scope(namespace,'v1'))?.requestKey);return Promise.resolve({data:{voucherId:'v1',approvalStatus:'APPROVED',postingStatus:namespace.endsWith('reverse')?'REVERSED':'POSTED'},error:null});});await expect(mount(hook).mutation.mutationFn(input)).resolves.toBeDefined();expect(financialPending.read(scope(namespace,'v1'))).toBeNull();
});
it('V2 biểu mẫu thuộc org cũ không gọi writer trong org mới',async()=>{const entry=mount(usePostApprovedIncomeExpenseV2);localStorage.setItem('ihomecrm.selectedOrganizationId','org2');await expect(entry.mutation.mutationFn(posting)).rejects.toThrow(/tổ chức/);expect(h.rpc).not.toHaveBeenCalled();});

const approvalCases=[['quyết định',useDecideApproval,{requestId:'req1',decision:'APPROVE',organizationId:'org1'}],['thu hồi',useWithdrawApproval,{requestId:'req1',organizationId:'org1'}]] as const;
it.each(approvalCases)('yêu cầu duyệt %s timeout phải chặn cả approve/reject/withdraw sau remount',async(_label,hook,input)=>{
 h.rpc.mockRejectedValue(new TypeError('Failed to fetch'));const first=mount(hook);await expect(first.mutation.mutationFn(input)).rejects.toThrow();expect(financialPending.read({...scope('approval-request','req1'),organizationId:'actor-scope'})).not.toBeNull();first.unmount();
 await expect(mount(useWithdrawApproval).mutation.mutationFn({requestId:'req1',organizationId:'org1'})).rejects.toThrow(/đối chiếu/);await expect(mount(useDecideApproval).mutation.mutationFn({requestId:'req1',decision:'REJECT',organizationId:'org1'})).rejects.toThrow(/đối chiếu/);expect(h.rpc).toHaveBeenCalledTimes(1);
});
it.each(approvalCases)('yêu cầu duyệt %s state đúng nhưng requestID sai giữ khóa',async(_label,hook,input)=>{
 h.rpc.mockResolvedValue({data:{request_id:'other',state:Object.prototype.hasOwnProperty.call(input,'decision')?'PENDING_APPROVAL':'CANCELLED'},error:null});await expect(mount(hook).mutation.mutationFn(input)).rejects.toThrow();expect(financialPending.read({...scope('approval-request','req1'),organizationId:'actor-scope'})).not.toBeNull();
});
it('quorum PENDING_APPROVAL đúng request là bước đã nhận và gỡ khóa, không đoán toàn yêu cầu đã xong',async()=>{
 h.rpc.mockResolvedValue({data:{request_id:'req1',state:'PENDING_APPROVAL'},error:null});await expect(mount(useDecideApproval).mutation.mutationFn({requestId:'req1',decision:'APPROVE',organizationId:'org1'})).resolves.toMatchObject({state:'PENDING_APPROVAL'});expect(financialPending.read({...scope('approval-request','req1'),organizationId:'actor-scope'})).toBeNull();
});
it('inbox đa tổ chức và org metadata null dùng marker actor stable, metadata cập nhật không vượt khóa',async()=>{
 h.rpc.mockRejectedValue(new TypeError('Failed to fetch'));await expect(mount(useDecideApproval).mutation.mutationFn({requestId:'req1',decision:'APPROVE',organizationId:null})).rejects.toThrow();
 expect(financialPending.read({...scope('approval-request','req1'),organizationId:'actor-scope'})).not.toBeNull();
 await expect(mount(useWithdrawApproval).mutation.mutationFn({requestId:'req1',organizationId:'org2'})).rejects.toThrow(/đối chiếu/);expect(h.rpc).toHaveBeenCalledOnce();
});
it('hoàn tác collection timeout giữ khóa qua remount kể cả gọi bằng payment liên kết',async()=>{
 h.rpc.mockRejectedValue(new TypeError('Failed to fetch'));await expect(mount(useDeletePayment).mutation.mutationFn({collection_id:'c1',reason:'Thu tiền bị trùng'})).rejects.toThrow();expect(financialPending.read(scope('collection-reversal','c1'))).not.toBeNull();
 h.read.mockResolvedValue({data:{id:'p1',collection_id:'c1'},error:null});await expect(mount(useDeletePayment).mutation.mutationFn({payment_id:'p1',reason:'Thu tiền bị trùng'})).rejects.toThrow(/đối chiếu/);expect(h.rpc).toHaveBeenCalledTimes(1);
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
 const result=await mount(useCancelIncomeExpenseBatch).mutation.mutationFn('b1');expect(result).toMatchObject({count:1,completedIds:['v1'],failures:[{id:'v2'}]});expect(financialPending.read(scope('voucher-batch-cancel','b1'))?.completedIds).toEqual(['v1']);
 await expect(mount(useCancelIncomeExpenseBatch).mutation.mutationFn('b1')).rejects.toThrow(/đối chiếu/);expect(h.rpc).toHaveBeenCalledTimes(2);
});
it('đổi sổ đợt giữ ID đổi xong và cùng requestKey qua timeout/remount',async()=>{
 h.tables={income_expense_batch_items:[{income_expense_id:'v1'},{income_expense_id:'v2'}],income_expenses:[{id:'v1',code:'PC01',approval_status:'UNAPPROVED',approval_version:1,account_id:'old'},{id:'v2',code:'PC02',approval_status:'UNAPPROVED',approval_version:1,account_id:'old'}]};
 h.rpc.mockImplementationOnce((_name:string,args:{p_idempotency_key:string;input:{idempotencyKey:string}})=>{expect(args.p_idempotency_key).toContain(financialPending.read(scope('voucher-batch-account','b1'))?.requestKey);return Promise.resolve({data:{id:'v1',changed:true,approval_version:2,changed_fields:['account_id']},error:null});}).mockRejectedValueOnce(new TypeError('Failed to fetch'));
 await expect(mount(useUpdateBatchAccount).mutation.mutationFn({batchId:'b1',accountId:'new',reason:'Đổi sổ ghi phiếu'})).rejects.toThrow();expect(financialPending.read(scope('voucher-batch-account','b1'))?.completedIds).toEqual(['v1']);await expect(mount(useUpdateBatchAccount).mutation.mutationFn({batchId:'b1',accountId:'different',reason:'Đổi sổ ghi phiếu'})).rejects.toThrow(/đối chiếu/);expect(h.rpc).toHaveBeenCalledTimes(2);
});

const voucherLifecycleCases=[['duyệt',useApproveVoucher,{id:'v1',expectedApprovalVersion:1}],['bỏ duyệt',useUnapproveVoucher,'v1'],['huỷ',useCancelIncomeExpense,'v1'],['khôi phục',useRestoreIncomeExpense,'v1'],['đổi kiểm',useVerifyIncomeExpense,{id:'v1',note:null}]] as const;
const voucherLifecycleScope={...scope('voucher-lifecycle','v1'),organizationId:'actor-scope'};
it.each(voucherLifecycleCases)('lifecycle phiếu %s timeout giữ marker chung qua remount và đổi action/org',async(_label,hook,input)=>{
 h.rpc.mockRejectedValue(new TypeError('Failed to fetch'));await expect(mount(hook).mutation.mutationFn(input)).rejects.toThrow();expect(financialPending.read(voucherLifecycleScope)).not.toBeNull();
 localStorage.setItem('ihomecrm.selectedOrganizationId','org2');await expect(mount(useVerifyIncomeExpense).mutation.mutationFn({id:'v1',note:null})).rejects.toThrow(/đối chiếu/);expect(h.rpc).toHaveBeenCalledOnce();
});
it('duyệt checked trả ID khác không đủ bằng chứng duyệt target',async()=>{
 h.rpc.mockResolvedValue({data:{id:'other',approved:true,already:false,mode:'VOUCHER'},error:null});await expect(mount(useApproveVoucher).mutation.mutationFn({id:'v1',expectedApprovalVersion:1})).rejects.toThrow();expect(financialPending.read(voucherLifecycleScope)).not.toBeNull();
});
it.each([null,{id:'other',approval_status:'UNAPPROVED',posting_status:'UNPOSTED'},{id:'v1',approval_status:'NEW_STATE',posting_status:'UNPOSTED'}])('bỏ duyệt RPC void cần readback đúng target/status: %s',async data=>{
 h.rpc.mockResolvedValueOnce({data:null,error:{code:'55000',message:'not a termination forfeit pair'}}).mockResolvedValueOnce({data:null,error:null});h.read.mockResolvedValue({data,error:null});await expect(mount(useUnapproveVoucher).mutation.mutationFn('v1')).rejects.toThrow();expect(financialPending.read(voucherLifecycleScope)).not.toBeNull();
});
it.each([useRestoreIncomeExpense,useVerifyIncomeExpense])('restore/verify không được giải phóng khóa khi readback thiếu',async hook=>{
 h.rpc.mockResolvedValue({data:null,error:null});h.read.mockResolvedValue({data:null,error:{code:'42501'}});await expect(mount(hook).mutation.mutationFn(hook===useRestoreIncomeExpense?'v1':{id:'v1',note:null})).rejects.toThrow();expect(financialPending.read(voucherLifecycleScope)).not.toBeNull();
});
it('huỷ flex receipt thiếu ID/changed không phải thành công',async()=>{
 h.rpc.mockResolvedValueOnce({data:null,error:{code:'55000',message:'not a termination forfeit pair'}}).mockResolvedValueOnce({data:{},error:null});await expect(mount(useCancelIncomeExpense).mutation.mutationFn({id:'v1',reason:'Ghi phiếu bị trùng'})).rejects.toThrow();expect(financialPending.read(voucherLifecycleScope)).not.toBeNull();
});
it('huỷ sau hoàn tác phải dùng requestKey persisted và giữ đúng completed ID nếu huỷ bị từ chối',async()=>{
 h.read.mockResolvedValue({data:{id:'v1',type:'EXPENSE',approval_status:'APPROVED',posting_status:'POSTED',account_id:'a1'},error:null});h.rpc.mockResolvedValueOnce({data:null,error:{code:'55000',message:'not a termination forfeit pair'}}).mockImplementationOnce((_name:string,args:{p_idempotency_key:string;input:{idempotencyKey:string}})=>{expect(args.p_idempotency_key).toBe(financialPending.read(voucherLifecycleScope)?.requestKey);return Promise.resolve({data:{voucherId:'v1',postingStatus:'REVERSED'},error:null});}).mockResolvedValueOnce({data:null,error:{code:'0A000',message:'legacy'}}).mockResolvedValueOnce({data:null,error:{code:'42501',message:'permission denied'}});
 await expect(mount(useCancelIncomeExpense).mutation.mutationFn('v1')).rejects.toMatchObject({completedIds:['v1']});expect(financialPending.read(voucherLifecycleScope)?.completedIds).toEqual(['v1']);
});
it('duyệt và bỏ kiểm có receipt thật giải phóng marker và giữ trạng thái trả về',async()=>{
 h.rpc.mockResolvedValueOnce({data:{id:'v1',approved:true,already:false,mode:'VOUCHER'},error:null});await expect(mount(useApproveVoucher).mutation.mutationFn({id:'v1',expectedApprovalVersion:1})).resolves.toMatchObject({approved:true});expect(financialPending.read(voucherLifecycleScope)).toBeNull();
 h.rpc.mockResolvedValueOnce({data:null,error:null});h.read.mockResolvedValue({data:{id:'v1',code:'PT01',verified_at:null},error:null});await expect(mount(useVerifyIncomeExpense).mutation.mutationFn({id:'v1',note:null})).resolves.toMatchObject({verified_at:null});expect(financialPending.read(voucherLifecycleScope)).toBeNull();
});

it('huỷ canonical RETURNS void cần readback CANCELLED đúng phiếu trước khi gỡ khóa',async()=>{
 h.read.mockResolvedValueOnce({data:{id:'v1',type:'EXPENSE',approval_status:'UNAPPROVED',posting_status:'UNPOSTED'},error:null}).mockResolvedValueOnce({data:{id:'v1',code:'PC01',approval_status:'CANCELLED',posting_status:'UNPOSTED',verified_at:null},error:null});
 h.rpc.mockResolvedValueOnce({data:null,error:{code:'55000',message:'not a termination forfeit pair'}}).mockResolvedValueOnce({data:null,error:null});await expect(mount(useCancelIncomeExpense).mutation.mutationFn('v1')).resolves.toBe(false);expect(financialPending.read(voucherLifecycleScope)).toBeNull();
});

it.each([useCancelVoucherFlex,useCancelIncomeVoucher])('cửa huỷ chuyên trách giữ cùng marker lifecycle, không đổi action để vượt timeout',async hook=>{
 h.rpc.mockRejectedValue(new TypeError('Failed to fetch'));await expect(mount(hook).mutation.mutationFn({voucherId:'v1',reason:'Ghi phiếu bị trùng'})).rejects.toThrow();expect(financialPending.read(voucherLifecycleScope)).not.toBeNull();await expect(mount(useRestoreIncomeExpense).mutation.mutationFn('v1')).rejects.toThrow(/đối chiếu/);expect(h.rpc).toHaveBeenCalledOnce();
});
it.each([useCancelVoucherFlex,useCancelIncomeVoucher])('cửa huỷ chuyên trách receipt ID khác phải giữ khóa',async hook=>{
 h.rpc.mockResolvedValue({data:{id:'other',changed:true,mode:'MANUAL',cancellation_kind:'CANCELLED_UNPOSTED'},error:null});await expect(mount(hook).mutation.mutationFn({voucherId:'v1',reason:'Ghi phiếu bị trùng'})).rejects.toThrow();expect(financialPending.read(voucherLifecycleScope)).not.toBeNull();
});
it.each([useCancelVoucherFlex,useCancelIncomeVoucher])('cửa huỷ chuyên trách receipt đúng/noop giải phóng marker',async hook=>{
 h.rpc.mockResolvedValue({data:{id:'v1',changed:false},error:null});await expect(mount(hook).mutation.mutationFn({voucherId:'v1',reason:'Ghi phiếu bị trùng'})).resolves.toMatchObject({changed:false});expect(financialPending.read(voucherLifecycleScope)).toBeNull();
});

it('ảnh payment đã gắn nhưng nguồn voucher lỗi giữ completed paymentID và khóa qua remount',async()=>{
 h.upload.mockResolvedValue('https://storage.test/receipt.png');h.read.mockResolvedValueOnce({data:{id:'p1',collection_id:null},error:null}).mockResolvedValueOnce({data:{id:'p1'},error:null}).mockResolvedValueOnce({data:null,error:{code:'42501',message:'permission denied'}});
 await expect(mount(useUploadPaymentReceipt).mutation.mutationFn({payment_id:'p1',file:new File(['x'],'receipt.png',{type:'image/png'})})).rejects.toMatchObject({completed:[{id:'p1',label:expect.any(String)}]});expect(financialPending.read({...scope('payment-receipt-upload','p1'),organizationId:'actor-scope'})?.completedIds).toEqual(['p1']);
 await expect(mount(useUploadPaymentReceipt).mutation.mutationFn({payment_id:'p1',file:new File(['x'],'other.png',{type:'image/png'})})).rejects.toThrow(/đối chiếu/);expect(h.upload).toHaveBeenCalledOnce();
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
