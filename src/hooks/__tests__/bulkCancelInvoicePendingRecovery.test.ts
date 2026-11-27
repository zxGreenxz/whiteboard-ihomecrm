// @vitest-environment jsdom
// Đợt 3: huỷ hoá đơn hàng loạt đọc trạng thái từng hoá đơn (cách C). cancel_invoice_with_credit_v1 (production
// 24/11/2026) khoá hoá đơn FOR UPDATE rồi trả `noop` khi hoá đơn đã huỷ, nên gửi lại cùng mã không huỷ hai lần.
// Không còn khoá trong bộ nhớ chặn lần bấm sau cho tới khi tải lại trang.
import {renderHook,cleanup} from '@testing-library/react';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
const h=vi.hoisted(()=>({invoices:[] as {id:string;organization_id:string;status:string;paid_amount:number;deleted_at:null}[],rpc:vi.fn(),next:'ok' as 'ok'|'drop'|'lost',failRead:false,cancels:0}));
vi.mock('@/integrations/supabase/client',()=>({supabase:{rpc:h.rpc,from:()=>{
  let ids:string[]|null=null;
  const rows=()=>h.invoices.filter(row=>!ids||ids.includes(row.id)).map(row=>({...row}));
  const b:Record<string,unknown>={select:()=>b,
    in:(_c:string,v:string[])=>{ids=v;return b;},eq:(_c:string,v:string)=>{ids=[v];return b;},
    maybeSingle:async()=>h.failRead?{data:null,error:{message:'Failed to fetch'}}:{data:rows()[0]??null,error:null},
    single:async()=>({data:rows()[0]??null,error:rows().length===1?null:{code:'PGRST116'}}),
    then:(ok:(v:unknown)=>unknown)=>Promise.resolve({data:rows(),error:null}).then(ok)};
  return b;
}}}));
vi.mock('@tanstack/react-query',()=>({useMutation:(o:unknown)=>o,useQueryClient:()=>({invalidateQueries:vi.fn()})}));
vi.mock('@/contexts/OrganizationContext',()=>({useOrganization:()=>({selectedOrganizationId:'org1'})}));
vi.mock('@/lib/authSession',()=>({getSessionUser:async()=>({id:'u1'})}));
import {useBulkCancelInvoices} from '../useInvoices';
import {financialPending} from '@/lib/financialPending';
type Result={done:number;skipped:number;failed:number;completedIds:string[];failures:{id:string;outcomeUnknown:boolean}[]};
const run=(ids:string[])=>{const {result}=renderHook(()=>useBulkCancelInvoices());return (result.current as unknown as {mutationFn:(ids:string[])=>Promise<Result>}).mutationFn(ids);};
const scope=(id:string)=>({namespace:'invoice-cancel',userId:'u1',organizationId:'org1',businessKey:id});
const keysSent=()=>h.rpc.mock.calls.map(c=>(c[1] as {p_idempotency_key:string}).p_idempotency_key);
afterEach(cleanup);
beforeEach(()=>{
  vi.clearAllMocks();localStorage.clear();h.next='ok';h.failRead=false;h.cancels=0;
  h.invoices=[{id:'i1',organization_id:'org1',status:'APPROVED',paid_amount:0,deleted_at:null}];
  h.rpc.mockImplementation(async(_fn:string,args:{p_invoice_id:string})=>{
    const mode=h.next;h.next='ok';
    if(mode==='drop')throw new TypeError('Failed to fetch');
    const row=h.invoices.find(r=>r.id===args.p_invoice_id)!;
    const noop=row.status==='CANCELLED';
    if(!noop){row.status='CANCELLED';h.cancels++;}
    if(mode==='lost')throw new TypeError('Failed to fetch');
    return {data:{invoice:{id:row.id,status:'CANCELLED'},credit:null,noop},error:null};
  });
});

it('lệnh không tới máy chủ: lần bấm sau trong cùng phiên đọc trạng thái rồi huỷ, cùng mã yêu cầu',async()=>{
  h.next='drop';
  expect(await run(['i1'])).toMatchObject({done:0,failed:1,failures:[{id:'i1',outcomeUnknown:true}]});
  expect(financialPending.read(scope('i1'))).not.toBeNull();
  expect(await run(['i1'])).toMatchObject({done:1,failed:0,completedIds:['i1']});
  expect(h.cancels).toBe(1);expect(keysSent()).toHaveLength(2);expect(keysSent()[1]).toBe(keysSent()[0]);
  expect(financialPending.read(scope('i1'))).toBeNull();
});
it('tới nhưng mất phản hồi: hoá đơn đã huỷ còn dấu ⇒ đọc trạng thái, tính là xong, gỡ dấu, không gửi lần hai',async()=>{
  h.next='lost';await run(['i1']);
  expect(h.cancels).toBe(1);expect(financialPending.read(scope('i1'))).not.toBeNull();
  expect(await run(['i1'])).toMatchObject({done:1,skipped:0,failed:0,completedIds:['i1']});
  expect(h.rpc).toHaveBeenCalledTimes(1);expect(financialPending.read(scope('i1'))).toBeNull();
  // Hoá đơn đã huỷ mà không còn dấu vẫn bị bỏ qua như cũ.
  expect(await run(['i1'])).toMatchObject({done:0,skipped:1});
});
it('dấu cũ gieo sẵn (không tên thao tác): đọc trạng thái, chưa huỷ thì gửi lại đúng mã cũ',async()=>{
  const old={...scope('i1'),attemptId:'00000000-0000-4000-8000-0000000000aa',requestKey:'00000000-0000-4000-8000-0000000000bb',completedIds:[],startedAt:'2026-11-20T01:00:00.000Z'};
  localStorage.setItem('ihome:financial-pending:v1:invoice-cancel:u1:org1:i1',JSON.stringify(old));
  expect(await run(['i1'])).toMatchObject({done:1,failed:0});
  expect(h.cancels).toBe(1);expect(keysSent()[0]).toContain('00000000-0000-4000-8000-0000000000bb');
});
it('đọc trạng thái hỏng ⇒ giữ dấu, báo chưa rõ, không gửi',async()=>{
  h.next='drop';await run(['i1']);h.failRead=true;
  expect(await run(['i1'])).toMatchObject({done:0,failed:1});
  expect(h.rpc).toHaveBeenCalledTimes(1);expect(financialPending.read(scope('i1'))).not.toBeNull();
});
