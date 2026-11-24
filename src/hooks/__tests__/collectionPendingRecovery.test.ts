// @vitest-environment jsdom
// Thu tiền hoá đơn sau rớt mạng (đợt 2, 24/11/2026): hai nơi gọi kho dấu thu tiền — hộp thu một hoá đơn
// (`useRecordPaymentRPC`) và thu hàng loạt (`useBulkRecordPayment`) — không còn khoá mãi khi tra chưa thấy khoản thu
// hoặc khoản thu đã bị hoàn tác; gửi lại đúng khoá của dấu; một hoá đơn kẹt không chặn hoá đơn khác.
import {cleanup,renderHook} from '@testing-library/react';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import type {RecordPaymentRPCData} from '../useInvoicePayments';
import type {BulkPaymentParams,BulkPaymentResult} from '../useBulkRecordPayment';

const m=vi.hoisted(()=>({rpc:vi.fn(),lookup:vi.fn(),invalidateQueries:vi.fn(),toast:vi.fn()}));
vi.mock('@tanstack/react-query',()=>({useMutation:(options:unknown)=>options,useQueryClient:()=>({invalidateQueries:m.invalidateQueries})}));
vi.mock('@/lib/authSession',()=>({getSessionUser:async()=>({id:'actor'})}));
vi.mock('@/hooks/use-toast',()=>({useToast:()=>({toast:m.toast})}));
vi.mock('@/integrations/supabase/client',()=>({supabase:{rpc:m.rpc,from:(table:string)=>{
 const filters:Record<string,unknown>={};
 const q={
  select:()=>q,
  eq:(column:string,value:unknown)=>{filters[column]=value;return q;},
  in:async()=>({data:[{id:'cash',is_virtual:false}],error:null}),
  single:async()=>({data:{id:filters.id,organization_id:'org1',total_amount:1_000_000,paid_amount:0,contract_id:'contract',invoice_items:[]},error:null}),
  maybeSingle:async()=>{if(table!=='invoice_payment_collections')throw new Error(`unexpected ${table}`);return m.lookup({...filters});},
 };
 return q;
}}}));
import {useRecordPaymentRPC} from '../useInvoicePayments';
import {useBulkRecordPayment} from '../useBulkRecordPayment';
import {PriorCollectionSettledError} from '@/lib/pendingCollection';
import {pendingValve} from '@/lib/pendingValve';

const markerKey=(invoiceId:string)=>`ihome:pending-collection:v1:actor:org1:${invoiceId}`;
const marker=(invoiceId:string)=>JSON.parse(localStorage.getItem(markerKey(invoiceId))??'null') as {idempotencyKey:string}|null;
const seed=(invoiceId:string,idempotencyKey:string,startedAt='2026-11-20T01:00:00.000Z')=>localStorage.setItem(markerKey(invoiceId),JSON.stringify({userId:'actor',organizationId:'org1',invoiceId,idempotencyKey,startedAt}));
const collectionRow=(invoiceId:string,key:string,status='ACTIVE')=>({id:`col-${invoiceId}`,organization_id:'org1',invoice_id:invoiceId,actor_id:'actor',idempotency_key:key,status,applied_amount:500_000});
const okResponse=(invoiceId:string,collectionId=`col-${invoiceId}`)=>({data:{collection_id:collectionId,invoice_id:invoiceId,applied_amount:500_000,tenders:[],invoice:{id:invoiceId,remaining_amount:500_000}},error:null});
const sentKeys=()=>m.rpc.mock.calls.map(call=>(call[1] as {p_idempotency_key:string}).p_idempotency_key);
const sentInvoices=()=>m.rpc.mock.calls.map(call=>(call[1] as {p_invoice_id:string}).p_invoice_id);

const single=(key:string):RecordPaymentRPCData=>({invoice_id:'inv-a',collection_date:'2026-11-24',expected_paid_amount:0,invoice_total_amount:1_000_000,
 overpay_action:'REJECT',allow_rounding:false,tenders:[{payment_method:'TM',gross_amount:500_000,account_id:'cash'}],idempotency_key:key});
const runSingle=(input:RecordPaymentRPCData)=>(renderHook(()=>useRecordPaymentRPC()).result.current as unknown as {mutationFn:(i:RecordPaymentRPCData)=>Promise<Record<string,unknown>>}).mutationFn(input);
const item=(invoice_id:string)=>({invoice_id,amount_tm:500_000,amount_tk:0,amount_tt:0,change_amount:0,account_id:'cash',change_account_id:null});
const bulk=(invoices:string[]):BulkPaymentParams=>({payment_date:'2026-11-24',items:invoices.map(item)});
const mountBulk=()=>renderHook(()=>useBulkRecordPayment());
const runBulk=(hook:ReturnType<typeof mountBulk>,params:BulkPaymentParams)=>(hook.result.current as unknown as {mutationFn:(i:BulkPaymentParams)=>Promise<BulkPaymentResult>}).mutationFn(params);

beforeEach(()=>{
 vi.clearAllMocks();localStorage.clear();m.rpc.mockReset();m.lookup.mockReset();
 m.lookup.mockResolvedValue({data:null,error:null});
 m.rpc.mockImplementation((_fn:string,args:{p_invoice_id:string})=>Promise.resolve(okResponse(args.p_invoice_id)));
});
afterEach(cleanup);

describe('hộp thu một hoá đơn',()=>{
 it('lệnh không tới máy chủ: lần bấm sau (sau tải lại, khoá mới) gửi lại ĐÚNG khoá của dấu và xong',async()=>{
  m.rpc.mockRejectedValueOnce(new TypeError('Failed to fetch'));
  await expect(runSingle(single('collect-first-key'))).rejects.toThrow();
  expect(marker('inv-a')?.idempotencyKey).toBe('collect-first-key');
  await expect(runSingle(single('collect-second-key'))).resolves.toMatchObject({collection_id:'col-inv-a'});
  expect(sentKeys()).toEqual(['collect-first-key','collect-first-key']);
  expect(marker('inv-a')).toBeNull();
 });
 it('tới máy chủ nhưng mất phản hồi: tra thấy khoản thu thì trả biên nhận cũ, không gửi lệnh thu thứ hai',async()=>{
  m.rpc.mockRejectedValueOnce(new TypeError('Failed to fetch'));
  await expect(runSingle(single('collect-first-key'))).rejects.toThrow();
  m.lookup.mockResolvedValue({data:collectionRow('inv-a','collect-first-key'),error:null});
  await expect(runSingle(single('collect-second-key'))).resolves.toMatchObject({collection_id:'col-inv-a',recovered:true});
  expect(m.rpc).toHaveBeenCalledTimes(1);expect(marker('inv-a')).toBeNull();
 });
 it('dấu cũ gieo sẵn: tra chưa thấy thì gửi lại đúng khoá của dấu cũ',async()=>{
  seed('inv-a','collect-seeded-key');
  await runSingle(single('collect-new-key'));
  expect(sentKeys()).toEqual(['collect-seeded-key']);expect(marker('inv-a')).toBeNull();
 });
 it('khoản thu trước đã bị hoàn tác: báo rõ, gỡ dấu, không gửi; bấm lại cùng hộp thu thì thu bằng khoá mới',async()=>{
  seed('inv-a','collect-reversed-key');
  m.lookup.mockResolvedValueOnce({data:collectionRow('inv-a','collect-reversed-key','REVERSED'),error:null});
  const error=await runSingle(single('collect-reversed-key')).catch(e=>e);
  expect(error).toBeInstanceOf(PriorCollectionSettledError);expect(error.message).toMatch(/hoàn tác/);
  expect(m.rpc).not.toHaveBeenCalled();expect(marker('inv-a')).toBeNull();
  await runSingle(single('collect-reversed-key'));
  expect(sentKeys()).toHaveLength(1);expect(sentKeys()[0]).not.toBe('collect-reversed-key');
 });
 it('máy chủ báo khoá đã dùng với nội dung khác: báo đã thu, gỡ dấu, KHÔNG gửi lệnh thu nào nữa',async()=>{
  seed('inv-a','collect-used-key');
  // Tra trước khi tính nợ, tra trước khi gửi lại: chưa thấy (ví dụ chưa đọc được). Tra lại sau 23505: thấy.
  m.lookup.mockResolvedValueOnce({data:null,error:null}).mockResolvedValueOnce({data:null,error:null}).mockResolvedValueOnce({data:collectionRow('inv-a','collect-used-key'),error:null});
  m.rpc.mockResolvedValueOnce({data:null,error:{code:'23505',message:'idempotency_key đã dùng với nội dung khác'}});
  const error=await runSingle(single('collect-other-key')).catch(e=>e);
  expect(error).toBeInstanceOf(PriorCollectionSettledError);expect(error).toMatchObject({reversed:false,collectionId:'col-inv-a'});
  expect(sentKeys()).toEqual(['collect-used-key']);expect(marker('inv-a')).toBeNull();
 });
});

describe('thu hàng loạt',()=>{
 it('lệnh không tới máy chủ: lượt sau (sau tải lại) gửi lại đúng khoá của dấu cho từng hoá đơn',async()=>{
  m.rpc.mockRejectedValueOnce(new TypeError('Failed to fetch'));
  const first=mountBulk();
  expect((await runBulk(first,bulk(['inv-a']))).failures).toEqual([expect.objectContaining({invoice_id:'inv-a',outcomeUnknown:true})]);
  const originalKey=marker('inv-a')!.idempotencyKey;first.unmount();
  const result=await runBulk(mountBulk(),bulk(['inv-a']));
  expect(result).toMatchObject({ok:['inv-a'],failures:[]});
  expect(sentKeys()).toEqual([originalKey,originalKey]);expect(marker('inv-a')).toBeNull();
 });
 it('một hoá đơn kẹt (phép tra hỏng) không chặn hoá đơn khác; hoá đơn kẹt báo hộp cảnh báo',async()=>{
  const report=vi.spyOn(pendingValve,'report').mockImplementation(()=>undefined);
  seed('inv-a','collect-stuck-key');
  m.lookup.mockImplementation(async(filters:{invoice_id:string})=>{if(filters.invoice_id==='inv-a')throw new TypeError('Failed to fetch');return {data:null,error:null};});
  const result=await runBulk(mountBulk(),bulk(['inv-a','inv-b']));
  expect(result.ok).toEqual(['inv-b']);
  expect(result.failures).toEqual([expect.objectContaining({invoice_id:'inv-a',outcomeUnknown:true,message:expect.stringMatching(/thu tiền hoá đơn/)})]);
  expect(sentInvoices()).toEqual(['inv-b']);expect(marker('inv-a')?.idempotencyKey).toBe('collect-stuck-key');
  expect(report).toHaveBeenCalledWith(expect.objectContaining({pending:expect.objectContaining({namespace:'pending-collection',businessKey:'inv-a',attemptId:'collect-stuck-key'})}));
  report.mockRestore();
 });
 it('dấu cũ gieo sẵn: hoá đơn có dấu gửi khoá cũ, hoá đơn khác gửi khoá của mình',async()=>{
  seed('inv-a','collect-seeded-key');
  const result=await runBulk(mountBulk(),bulk(['inv-a','inv-b']));
  expect(result.ok).toEqual(['inv-a','inv-b']);
  expect(sentKeys()[0]).toBe('collect-seeded-key');expect(sentKeys()[1]).not.toBe('collect-seeded-key');
 });
 it('khoản thu trước đã hoàn tác: dòng đó báo rõ, không khoá dòng; lượt sau thu bằng khoá mới',async()=>{
  seed('inv-a','collect-reversed-key');
  m.lookup.mockResolvedValueOnce({data:collectionRow('inv-a','collect-reversed-key','REVERSED'),error:null});
  const hook=mountBulk();
  const result=await runBulk(hook,bulk(['inv-a']));
  expect(result.failures).toEqual([expect.objectContaining({invoice_id:'inv-a',outcomeUnknown:false,message:expect.stringMatching(/hoàn tác/)})]);
  expect(m.rpc).not.toHaveBeenCalled();expect(marker('inv-a')).toBeNull();
  await expect(runBulk(hook,bulk(['inv-a']))).resolves.toMatchObject({ok:['inv-a']});
  expect(sentKeys()).toHaveLength(1);expect(sentKeys()[0]).not.toBe('collect-reversed-key');
 });
 it('lần trước đã thu (khoá đã dùng): dòng đó bị khoá trong hộp, không gửi lệnh thu mới',async()=>{
  seed('inv-a','collect-used-key');
  m.lookup.mockResolvedValueOnce({data:null,error:null}).mockResolvedValueOnce({data:null,error:null}).mockResolvedValueOnce({data:collectionRow('inv-a','collect-used-key'),error:null});
  m.rpc.mockResolvedValueOnce({data:null,error:{code:'23505',message:'idempotency_key đã dùng với nội dung khác'}});
  const result=await runBulk(mountBulk(),bulk(['inv-a']));
  expect(result.failures).toEqual([expect.objectContaining({invoice_id:'inv-a',outcomeUnknown:true,message:expect.stringMatching(/đã được ghi/)})]);
  expect(sentKeys()).toEqual(['collect-used-key']);expect(marker('inv-a')).toBeNull();
 });
});
