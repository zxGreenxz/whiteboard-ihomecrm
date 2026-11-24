// @vitest-environment jsdom
// Đợt 2 (24/11/2026): hoàn tác lần thu, lập hoàn trả, đổi hình thức thu, thêm ảnh chứng từ thanh toán cũ không còn
// khoá vĩnh viễn sau rớt mạng. Ba kịch bản cho từng nơi: lệnh không tới máy chủ; tới nhưng mất phản hồi; dấu cũ gieo
// sẵn (dạng ghi trước đợt 1/2, không có tên thao tác).
import {cleanup,renderHook} from '@testing-library/react';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {toast as sonnerToast} from 'sonner';

type Ctx={table:string;op:'select'|'update';payload?:unknown;filters:Record<string,unknown>;columns?:string};
const h=vi.hoisted(()=>({rpc:vi.fn(),db:vi.fn(),upload:vi.fn(),toast:vi.fn(),invalidateQueries:vi.fn()}));
vi.mock('@/integrations/supabase/client',()=>({supabase:{rpc:h.rpc,from:(table:string)=>{
 const ctx:Ctx={table,op:'select',filters:{}};
 const b={
  select:(columns?:string)=>{if(ctx.op==='select')ctx.columns=columns;return b;},
  eq:(column:string,value:unknown)=>{ctx.filters[column]=value;return b;},
  update:(payload:unknown)=>{ctx.op='update';ctx.payload=payload;return b;},
  limit:()=>b,
  single:()=>h.db({...ctx},'single'),
  maybeSingle:()=>h.db({...ctx},'maybeSingle'),
 };
 return b;
}}}));
vi.mock('@tanstack/react-query',()=>({useMutation:(o:unknown)=>o,useQuery:(o:unknown)=>o,useQueryClient:()=>({invalidateQueries:h.invalidateQueries})}));
vi.mock('@/contexts/OrganizationContext',()=>({useOrganization:()=>({selectedOrganizationId:'org1'})}));
vi.mock('@/lib/authSession',()=>({getSessionUser:async()=>({id:'u1'})}));
vi.mock('@/hooks/use-toast',()=>({useToast:()=>({toast:h.toast})}));
vi.mock('sonner',()=>({toast:{error:vi.fn(),warning:vi.fn(),success:vi.fn(),info:vi.fn()}}));
vi.mock('@/lib/receiptUpload',()=>({validateReceiptFile:()=>null,uploadReceiptToStorage:h.upload}));
import {useDeletePayment} from '../useDeletePayment';
import {useRecordRefundRPC} from '../useInvoicePayments';
import {useChangeCollectionTenderMethod} from '../useReceivingCashbooks';
import {useUploadPaymentReceipt} from '../useUploadPaymentReceipt';
import {financialPending,PENDING_SETTLE_MS,type FinancialPendingScope} from '@/lib/financialPending';
import {FinancialAlreadyRecordedError,FinancialWorkflowError} from '@/lib/financialWorkflow';

type Mutation<I,R=unknown>={mutationFn:(input:I)=>Promise<R>;onSuccess?:(result:R)=>unknown;onError?:(error:unknown,input:I)=>unknown};
const mount=<I,R=unknown>(hook:()=>unknown)=>renderHook(hook).result.current as unknown as Mutation<I,R>;
const scope=(namespace:string,businessKey:string,organizationId='org1'):FinancialPendingScope=>({namespace,userId:'u1',organizationId,businessKey});
const offline=()=>Promise.reject(new TypeError('Failed to fetch'));
const keysOf=(fn:string)=>h.rpc.mock.calls.filter(call=>call[0]===fn).map(call=>(call[1] as {p_idempotency_key:string}).p_idempotency_key);
/** Dấu đúng dạng bản trước đợt 1 ghi: không có tên thao tác. */
const seedOld=(target:FinancialPendingScope,requestKey:string,completedIds:string[]=[])=>{
 const row=financialPending.markPending(target,{attemptId:`attempt-${requestKey}`,requestKey});
 if(completedIds.length)financialPending.recordCompleted(target,row.attemptId,completedIds);
 return row;
};

beforeEach(()=>{
 vi.clearAllMocks();h.rpc.mockReset();h.db.mockReset();h.upload.mockReset();
 localStorage.clear();localStorage.setItem('ihomecrm.selectedOrganizationId','org1');
 h.db.mockResolvedValue({data:null,error:null});
});
afterEach(()=>{cleanup();vi.useRealTimers();});

describe('hoàn tác lần thu (collection-reversal)',()=>{
 type Input={payment_id?:string|null;collection_id?:string|null;reason:string};
 const reverse=(input:Input)=>mount<Input,{mode:string;reversalMode:string|null}>(useDeletePayment).mutationFn(input);
 const reason='Thu tiền bị trùng với lần trước';
 const reversed={data:{collection_id:'c1',status:'REVERSED',reversal_mode:'IN_PLACE_CANCEL'},error:null};
 const keyUsed={data:null,error:{code:'23505',message:'idempotency_key đã dùng với nội dung khác'}};

 it('lệnh không tới máy chủ: lần sau gửi lại CÙNG mã yêu cầu và xong',async()=>{
  h.rpc.mockImplementationOnce(offline);
  await expect(reverse({collection_id:'c1',reason})).rejects.toThrow();
  const prior=financialPending.read(scope('collection-reversal','c1'));expect(prior?.requestKey).toEqual(expect.any(String));
  h.rpc.mockResolvedValueOnce(reversed);
  await expect(reverse({collection_id:'c1',reason})).resolves.toMatchObject({mode:'COLLECTION_REVERSED',reversalMode:'IN_PLACE_CANCEL'});
  expect(keysOf('reverse_invoice_collection_v5')).toEqual([prior!.requestKey,prior!.requestKey]);
  expect(financialPending.read(scope('collection-reversal','c1'))).toBeNull();
 });
 it('tới máy chủ nhưng mất phản hồi, thử lại qua ngày/đổi lý do: khoá đã dùng ⇒ xác nhận ALREADY_REVERSED, báo đã hoàn tác, gỡ dấu',async()=>{
  h.rpc.mockImplementationOnce(offline);
  await expect(reverse({collection_id:'c1',reason})).rejects.toThrow();
  h.rpc.mockResolvedValueOnce(keyUsed).mockResolvedValueOnce({data:[{collection_id:'c1',mode:'BLOCKED',reason_code:'ALREADY_REVERSED'}],error:null});
  const error=await reverse({collection_id:'c1',reason:'Đổi lý do khi thử lại hôm sau'}).catch(e=>e);
  expect(error).toBeInstanceOf(FinancialAlreadyRecordedError);expect(error.recordIds).toEqual(['c1']);
  expect(error.message).toMatch(/đã được hoàn tác/);
  expect(h.rpc.mock.calls.map(call=>call[0])).toEqual(['reverse_invoice_collection_v5','reverse_invoice_collection_v5','can_reverse_collection_v1']);
  expect(financialPending.read(scope('collection-reversal','c1'))).toBeNull();
 });
 it('khoá đã dùng mà can_reverse_collection_v1 báo còn hoàn tác được: chưa kết luận, giữ dấu',async()=>{
  seedOld(scope('collection-reversal','c1'),'old-request-key');
  h.rpc.mockResolvedValueOnce(keyUsed).mockResolvedValueOnce({data:[{collection_id:'c1',mode:'IN_PLACE_CANCEL',reason_code:null}],error:null});
  await expect(reverse({collection_id:'c1',reason})).rejects.toMatchObject({outcome:'unknown'});
  expect(financialPending.read(scope('collection-reversal','c1'))).not.toBeNull();
 });
 it('dấu cũ gieo sẵn: gửi lại đúng mã yêu cầu của dấu, xong thì gỡ',async()=>{
  seedOld(scope('collection-reversal','c1'),'old-request-key');
  h.rpc.mockResolvedValueOnce(reversed);
  await expect(reverse({collection_id:'c1',reason})).resolves.toMatchObject({mode:'COLLECTION_REVERSED'});
  expect(keysOf('reverse_invoice_collection_v5')).toEqual(['old-request-key']);
  expect(financialPending.read(scope('collection-reversal','c1'))).toBeNull();
 });

 describe('thanh toán kiểu cũ (không có collection_id)',()=>{
  beforeEach(()=>{h.db.mockImplementation(async(ctx:Ctx)=>ctx.table==='payments'&&ctx.columns==='id, collection_id'?{data:{id:'p1',collection_id:null},error:null}:{data:null,error:null});});
  const normal={data:{payment_id:'p1',mode:'REVERSED',result:{reversal_voucher_id:'rv1',original_payment_id:'p1',reversed_amount:100}},error:null};
  it('máy chủ trả mode REVERSED ở nhánh thường: báo đã hoàn tác và gỡ dấu (trước đây báo lỗi, để lại dấu)',async()=>{
   h.rpc.mockResolvedValueOnce(normal);
   await expect(reverse({payment_id:'p1',reason})).resolves.toMatchObject({mode:'LEGACY_PAYMENT_REVERSED',collection_id:null});
   expect(financialPending.read(scope('collection-reversal','p1'))).toBeNull();
  });
  it('nhánh tách cọc trả mode DELETED vẫn nhận',async()=>{
   h.rpc.mockResolvedValueOnce({data:{payment_id:'p1',invoice_id:'i1',mode:'DELETED',deleted_voucher_count:2},error:null});
   await expect(reverse({payment_id:'p1',reason})).resolves.toMatchObject({mode:'LEGACY_PAYMENT_REVERSED'});
   expect(financialPending.read(scope('collection-reversal','p1'))).toBeNull();
  });
  it.each([
   {payment_id:'other',mode:'REVERSED',result:{reversal_voucher_id:'rv1',original_payment_id:'other'}},
   {payment_id:'p1',mode:'REVERSED',result:{reversal_voucher_id:'rv1',original_payment_id:'other'}},
   {payment_id:'p1',mode:'REVERSED'},
   {payment_id:'p1',mode:'UNKNOWN_MODE'},
  ])('biên nhận không đúng thanh toán/đường chạy thì không nhận: %j',async data=>{
   h.rpc.mockResolvedValueOnce({data,error:null});
   await expect(reverse({payment_id:'p1',reason})).rejects.toThrow();
   expect(financialPending.read(scope('collection-reversal','p1'))).not.toBeNull();
  });
  it('dấu cũ từ lần hoàn tác đã xong nhưng bị báo lỗi (mode REVERSED): gửi lại cùng mã ⇒ máy chủ trả kết quả cũ, gỡ dấu',async()=>{
   seedOld(scope('collection-reversal','p1'),'legacy-request-key');
   h.rpc.mockResolvedValueOnce(normal);
   await expect(reverse({payment_id:'p1',reason})).resolves.toMatchObject({mode:'LEGACY_PAYMENT_REVERSED'});
   expect(keysOf('undo_invoice_payment_compat_v1')).toEqual(['legacy-request-key']);
   expect(financialPending.read(scope('collection-reversal','p1'))).toBeNull();
  });
  it('khoá đã dùng với nội dung khác: thanh toán đã hoàn tác thì báo đã ghi, gỡ dấu',async()=>{
   seedOld(scope('collection-reversal','p1'),'legacy-request-key');
   h.db.mockImplementation(async(ctx:Ctx)=>ctx.table==='payments'&&ctx.columns==='id, collection_id'?{data:{id:'p1',collection_id:null},error:null}:ctx.table==='payments'?{data:{id:'p1',reversed_at:'2026-11-24T02:00:00Z'},error:null}:{data:null,error:null});
   h.rpc.mockResolvedValueOnce({data:null,error:{code:'23505',message:'Idempotency key reused with a different undo payload'}});
   await expect(reverse({payment_id:'p1',reason})).rejects.toBeInstanceOf(FinancialAlreadyRecordedError);
   expect(financialPending.read(scope('collection-reversal','p1'))).toBeNull();
  });
 });

 it('guard bền qua các lần render: bấm lần hai khi lần đầu chưa xong bị chặn ngay, không gửi lần hai',async()=>{
  const hook=renderHook(useDeletePayment);
  const first=(hook.result.current as unknown as Mutation<Input>).mutationFn;
  hook.rerender();
  const second=(hook.result.current as unknown as Mutation<Input>).mutationFn;
  let finish:(value:unknown)=>void=()=>{};
  h.rpc.mockImplementationOnce(()=>new Promise(resolve=>{finish=resolve;}));
  const running=first({collection_id:'c1',reason});
  await expect(second({collection_id:'c1',reason})).rejects.toThrow(/đang được xử lý/);
  await vi.waitFor(()=>expect(h.rpc).toHaveBeenCalledTimes(1));
  finish(reversed);await expect(running).resolves.toMatchObject({mode:'COLLECTION_REVERSED'});
  expect(h.rpc).toHaveBeenCalledTimes(1);
 });
});

describe('lập hoàn trả (invoice-refund)',()=>{
 type Input={invoice_id:string;amount:number;payment_date:string;account_id:string;notes?:string};
 const input:Input={invoice_id:'i1',amount:100,payment_date:'2026-11-24',account_id:'a1'};
 const refund=()=>mount<Input,{id:string}>(useRecordRefundRPC).mutationFn(input);
 const created=(replayed:boolean)=>({data:{reservationId:'rs1',refundVoucherId:'rv1',reservationState:'HELD',stateVersion:1,replayed},error:null});
 const T0=Date.parse('2026-11-24T02:00:00.000Z');
 const at=(ms:number)=>vi.setSystemTime(T0+ms);
 beforeEach(()=>{
  vi.useFakeTimers({toFake:['Date']});at(0);
  h.db.mockResolvedValue({data:{code:'PC01',approval_status:'UNAPPROVED',posting_status:'UNPOSTED'},error:null});
 });

 it('lệnh không tới máy chủ: sau 2 phút gửi lại cùng mã, máy chủ lập phiếu',async()=>{
  h.rpc.mockImplementationOnce(offline);
  await expect(refund()).rejects.toThrow();
  const prior=financialPending.read(scope('invoice-refund','i1'));
  at(PENDING_SETTLE_MS);h.rpc.mockResolvedValueOnce(created(false));
  await expect(refund()).resolves.toMatchObject({id:'rv1',approval_status:'UNAPPROVED'});
  expect(keysOf('create_invoice_refund_obligation_v2')).toEqual([prior!.requestKey,prior!.requestKey]);
  expect(financialPending.read(scope('invoice-refund','i1'))).toBeNull();
 });
 it('lệnh cũ có thể còn chạy trên máy chủ (dưới 2 phút): không gửi lại, báo chờ, giữ dấu',async()=>{
  h.rpc.mockImplementationOnce(offline);
  await expect(refund()).rejects.toThrow();
  // Gửi lại lúc này có thể vấp trần số được hoàn (55000) trước khi thấy phiếu cũ, rồi bị coi là từ chối và gỡ dấu.
  at(30_000);
  await expect(refund()).rejects.toThrow(/đang chờ kết quả/);
  expect(h.rpc).toHaveBeenCalledTimes(1);expect(financialPending.read(scope('invoice-refund','i1'))).not.toBeNull();
 });
 it('tới máy chủ nhưng mất phản hồi: sau 2 phút gửi lại cùng mã, máy chủ trả replayed ⇒ báo đã lập kèm mã, không lập mới',async()=>{
  h.rpc.mockImplementationOnce(offline);
  await expect(refund()).rejects.toThrow();
  at(PENDING_SETTLE_MS);h.rpc.mockResolvedValueOnce(created(true));
  const error=await refund().catch(e=>e);
  expect(error).toBeInstanceOf(FinancialAlreadyRecordedError);expect(error.recordIds).toEqual(['rv1']);
  expect(error.message).toMatch(/lần gửi trước/);
  expect(h.rpc).toHaveBeenCalledTimes(2);expect(financialPending.read(scope('invoice-refund','i1'))).toBeNull();
 });
 it('dấu cũ gieo sẵn có mã phiếu (bản trước để lại khi đọc trạng thái hỏng): gửi lại cùng mã ⇒ báo phiếu đã lập, gỡ dấu',async()=>{
  seedOld(scope('invoice-refund','i1'),'old-refund-key',['rv1']);
  at(PENDING_SETTLE_MS);h.rpc.mockResolvedValueOnce(created(true));
  await expect(refund()).rejects.toMatchObject({alreadyRecorded:true,recordIds:['rv1']});
  expect(keysOf('create_invoice_refund_obligation_v2')).toEqual(['old-refund-key']);
  expect(financialPending.read(scope('invoice-refund','i1'))).toBeNull();
 });
 it('đọc lại trạng thái phiếu hỏng SAU khi đã ghi: không để lại dấu, vẫn trả mã phiếu để báo cần kiểm tra',async()=>{
  h.rpc.mockResolvedValueOnce(created(false));h.db.mockResolvedValue({data:null,error:{code:'42501'}});
  await expect(refund()).resolves.toMatchObject({id:'rv1',approval_status:null});
  expect(financialPending.read(scope('invoice-refund','i1'))).toBeNull();
 });
 it('máy chủ báo trùng khoá (23505): chưa kết luận, giữ dấu cùng mã; lần sau gửi lại mã đó',async()=>{
  h.rpc.mockImplementationOnce(offline);
  await expect(refund()).rejects.toThrow();
  const prior=financialPending.read(scope('invoice-refund','i1'));
  at(PENDING_SETTLE_MS);h.rpc.mockResolvedValueOnce({data:null,error:{code:'23505',message:'duplicate key value violates unique constraint "invoice_refund_reservations_org_idem_uq"'}});
  await expect(refund()).rejects.toMatchObject({outcome:'unknown'});
  expect(financialPending.read(scope('invoice-refund','i1'))?.requestKey).toBe(prior!.requestKey);
  at(2*PENDING_SETTLE_MS);h.rpc.mockResolvedValueOnce(created(true));
  await expect(refund()).rejects.toMatchObject({alreadyRecorded:true,recordIds:['rv1']});
  expect(new Set(keysOf('create_invoice_refund_obligation_v2'))).toEqual(new Set([prior!.requestKey]));
 });
});

describe('đổi hình thức thu (collection-tender-method)',()=>{
 type Input={tenderId:string;method:'TM'|'TK'|'TT';accountId:string|null;reason:string};
 const input:Input={tenderId:'tender',method:'TK',accountId:'account',reason:'Chuyển hình thức theo chứng từ'};
 const change=()=>mount<Input,{replayed?:boolean}>(useChangeCollectionTenderMethod);
 const target=scope('collection-tender-method','tender','actor-scope');
 const changed={data:{tenderId:'tender',voucherId:'v',changed:true,to:{method:'TK',accountId:'account',accountName:'Q'}},error:null};

 it('lệnh không tới máy chủ: lần sau gửi lại cùng mã và xong',async()=>{
  h.rpc.mockImplementationOnce(offline);
  await expect(change().mutationFn(input)).rejects.toThrow();
  const prior=financialPending.read(target);
  h.rpc.mockResolvedValueOnce(changed);
  await expect(change().mutationFn(input)).resolves.toMatchObject({changed:true});
  expect(keysOf('change_collection_tender_method_v1')).toEqual([prior!.requestKey,prior!.requestKey]);
  expect(financialPending.read(target)).toBeNull();
 });
 it('tới máy chủ nhưng mất phản hồi: máy chủ trả replayed ⇒ nhận, báo lần trước đã ghi, không đổi thêm',async()=>{
  h.rpc.mockImplementationOnce(offline);
  await expect(change().mutationFn(input)).rejects.toThrow();
  h.rpc.mockResolvedValueOnce({data:{tenderId:'tender',voucherId:'v',changed:true,replayed:true,revisionNo:2},error:null});
  const mutation=change();
  const result=await mutation.mutationFn({...input,method:'TT'});
  expect(result).toMatchObject({replayed:true});expect(financialPending.read(target)).toBeNull();
  await mutation.onSuccess?.(result);
  expect(sonnerToast.info).toHaveBeenCalledWith(expect.stringMatching(/trước đã được ghi; không đổi thêm/));
  expect(sonnerToast.success).not.toHaveBeenCalled();
 });
 it('dấu cũ gieo sẵn: gửi lại đúng mã của dấu',async()=>{
  seedOld(target,'old-tender-key');
  h.rpc.mockResolvedValueOnce(changed);
  await change().mutationFn(input);
  expect(keysOf('change_collection_tender_method_v1')).toEqual(['old-tender-key']);
  expect(financialPending.read(target)).toBeNull();
 });
});

describe('thêm ảnh chứng từ thanh toán cũ (payment-receipt-upload)',()=>{
 type Input={payment_id:string;file:File};
 const file=()=>new File(['x'],'anh-chuyen-khoan-cua-khach.png',{type:'image/png'});
 const upload=()=>mount<Input,{voucherUpdated:boolean;voucherBlocked?:string|null}>(useUploadPaymentReceipt);
 const target=scope('payment-receipt-upload','p1','actor-scope');
 const url='https://storage.test/receipt.png';
 /** Máy chủ giả: phiếu thanh toán p1 (chưa có ảnh) + phiếu thu chi v1. */
 function serve(over:{payment?:unknown;paymentError?:unknown;voucherAttachments?:string[]}={}){
  let image:string|null=null;let attachments=over.voucherAttachments??[];
  h.db.mockImplementation(async(ctx:Ctx)=>{
   if(ctx.table==='payments'&&ctx.op==='select'){if(over.paymentError)throw over.paymentError;return {data:over.payment??{id:'p1',collection_id:null,receipt_image_url:image},error:null};}
   if(ctx.table==='payments'&&ctx.op==='update'){image=(ctx.payload as {receipt_image_url:string}).receipt_image_url;return {data:{id:'p1'},error:null};}
   if(ctx.table==='income_expenses'&&ctx.filters.payment_id)return {data:{id:'v1',attachments},error:null};
   if(ctx.table==='income_expenses')return {data:{id:'v1',attachments},error:null};
   return {data:null,error:null};
  });
  h.rpc.mockImplementation(async(fn:string,args:{p_patch:{attachments:string[]}})=>{if(fn==='ie_compat_update_pending_v2'){attachments=args.p_patch.attachments;return {data:{id:'v1'},error:null};}return {data:null,error:null};});
  return {image:()=>image};
 }
 beforeEach(()=>{h.upload.mockResolvedValue(url);});

 it('đọc phiếu thanh toán rớt mạng: chưa ghi gì nên không để lại dấu',async()=>{
  serve({paymentError:new TypeError('Failed to fetch')});
  await expect(upload().mutationFn({payment_id:'p1',file:file()})).rejects.toThrow();
  expect(financialPending.read(target)).toBeNull();expect(h.upload).not.toHaveBeenCalled();
 });
 it('tên thao tác lưu trong dấu không chứa tên tệp',async()=>{
  serve();
  h.db.mockImplementation(async(ctx:Ctx)=>ctx.table==='payments'&&ctx.op==='update'?Promise.reject(new TypeError('Failed to fetch')):{data:{id:'p1',collection_id:null,receipt_image_url:null},error:null});
  await expect(upload().mutationFn({payment_id:'p1',file:file()})).rejects.toThrow();
  const prior=financialPending.read(target);
  expect(prior?.operation).toBe('thêm ảnh chứng từ vào phiếu thu');
  expect(JSON.stringify(localStorage)).not.toContain('anh-chuyen-khoan-cua-khach');
 });
 it.each([['0A000','Phiếu chờ duyệt sửa bằng "Sửa phiếu"','PENDING'],['55000','Phiếu đã hủy — không sửa','CANCELLED']])('phiếu thu chi từ chối nối ảnh (%s): báo riêng, không giữ dấu',async(code,message,blocked)=>{
  serve();
  h.rpc.mockResolvedValueOnce({data:null,error:{code,message}});
  const mutation=upload();
  const result=await mutation.mutationFn({payment_id:'p1',file:file()});
  expect(result).toMatchObject({voucherUpdated:false,voucherBlocked:blocked});
  expect(financialPending.read(target)).toBeNull();
  mutation.onSuccess?.(result);
  expect(h.toast).toHaveBeenCalledWith(expect.objectContaining({description:expect.stringMatching(blocked==='PENDING'?/chờ duyệt/:/huỷ/)}));
 });
 it('dấu cũ gieo sẵn mà phiếu thanh toán đã có ảnh ⇒ coi là xong: báo đã gắn ở lần trước, gỡ dấu, không tải lại',async()=>{
  seedOld(target,'old-upload-key',['p1']);
  serve({payment:{id:'p1',collection_id:null,receipt_image_url:'https://storage.test/old.png'}});
  const mutation=upload();
  const error=await mutation.mutationFn({payment_id:'p1',file:file()}).catch(e=>e);
  expect(error).toBeInstanceOf(FinancialAlreadyRecordedError);expect(error.message).toMatch(/lần gửi trước/);
  expect(h.upload).not.toHaveBeenCalled();expect(financialPending.read(target)).toBeNull();
  mutation.onError?.(error,{payment_id:'p1',file:file()});
  expect(h.invalidateQueries).toHaveBeenCalledWith({queryKey:['invoice-payments-summary']});
 });
 it('dấu cũ mà phiếu thanh toán chưa có ảnh: dưới 2 phút thì chờ; quá 2 phút thì làm lại',async()=>{
  vi.useFakeTimers({toFake:['Date']});vi.setSystemTime(Date.parse('2026-11-24T02:00:00.000Z'));
  seedOld(target,'old-upload-key');
  const server=serve();
  await expect(upload().mutationFn({payment_id:'p1',file:file()})).rejects.toBeInstanceOf(FinancialWorkflowError);
  expect(h.upload).not.toHaveBeenCalled();expect(financialPending.read(target)).not.toBeNull();
  vi.setSystemTime(Date.parse('2026-11-24T02:00:00.000Z')+PENDING_SETTLE_MS);
  await expect(upload().mutationFn({payment_id:'p1',file:file()})).resolves.toMatchObject({url,voucherUpdated:true});
  expect(server.image()).toBe(url);expect(financialPending.read(target)).toBeNull();
 });
});
