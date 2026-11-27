// @vitest-environment jsdom
import {beforeEach,expect,it,vi} from 'vitest';
import {toast} from 'sonner';
import {FinancialWorkflowError,RepeatableWriteUnknownError} from '@/lib/financialWorkflow';
const io=vi.hoisted(()=>({from:vi.fn(),rpc:vi.fn()}));
vi.mock('@tanstack/react-query',()=>({useQuery:(value:unknown)=>value,useMutation:(value:unknown)=>value,useQueryClient:()=>({invalidateQueries:vi.fn()})}));
vi.mock('@/contexts/OrganizationContext',()=>({useOrganization:()=>({selectedOrganizationId:'org-a'})}));
vi.mock('@/integrations/supabase/client',()=>({supabase:io}));vi.mock('@/lib/authSession',()=>({getSessionUser:async()=>({id:'actor'})}));vi.mock('sonner',()=>({toast:{error:vi.fn(),success:vi.fn(),info:vi.fn()}}));
import {forgetUnconfirmedCreates} from '@/lib/clientRecordCreate';
import {useCreateMaterialPurchase,useUpdateMaterialPurchase} from '../useMaterialPurchases';import {useCreateMaterialUsage,useUpsertJobMaterialUsage} from '../useMaterialUsages';import {useCreateMaterialAdjustment,useSetMaterialStock} from '../useMaterialAdjustments';
interface Write {table:string;verb:string;payload?:unknown;filters:Array<[string,unknown]>}
type Result={data:unknown;error:unknown};
let writes:Write[]=[];let existing=true;let insertError:unknown=null;let cleanupError:unknown=null;let cleanupMissing=false;let cleanupWrongId=false;let missingInsertReceipt=false;let missingDeleteReceipt=false;
// Đợt 9: tạo phiếu đọc lại dòng của đúng phiếu khi kết quả chèn dòng chưa rõ (mặc định: chưa có dòng nào), đặt tồn đọc tồn
// hiện tại của vật tư trên máy chủ (`materials.on_hand`).
function fixture(table:string){let verb='read';let active:Write|undefined;
 const result=():Result=>{
  if(verb==='read'&&table==='materials')return {data:{id:'m-1',on_hand:1},error:null};
  if(verb==='read'&&table.endsWith('_items'))return {data:[],error:null};
  if(verb==='read')return {data:table==='material_usages'?(existing?{id:'header-1'}:null):[{id:'old-1',material_id:'m-1'}],error:null};
  // Đợt 9: dòng mang mã do trình duyệt sinh thì máy chủ trả đúng mã đó (production giữ `id` gửi lên); dòng không mang mã
  // (vật tư công việc, sửa phiếu nhập) nhận mã máy chủ.
  const sentLines=Array.isArray(active?.payload)?active!.payload as Array<{id?:unknown}>:[];
  if(table.endsWith('_items'))return {data:verb==='delete'?(missingDeleteReceipt?null:[{id:'old-1'}]):(missingInsertReceipt?[]:sentLines.length?sentLines.map(row=>({id:row.id??'new-1'})):[{id:'new-1'}]),error:verb==='insert'?insertError:null};
  return {data:verb==='delete'&&cleanupMissing?null:{id:verb==='delete'&&cleanupWrongId?'other-header':'header-1',organization_id:'org-a'},error:verb==='delete'?cleanupError:null};
 };
 const q={insert:vi.fn(),update:vi.fn(),delete:vi.fn(),upsert:vi.fn(),eq:vi.fn(),in:vi.fn(),select:vi.fn(),single:vi.fn(),maybeSingle:vi.fn(),then:(resolve:(value:Result)=>unknown)=>resolve(result())};
 for(const name of ['insert','update','delete','upsert'] as const)q[name].mockImplementation((payload?:unknown)=>{verb=name;active={table,verb,payload,filters:[]};writes.push(active);return q;});
 q.eq.mockImplementation((column:string,value:unknown)=>{active?.filters.push([column,value]);return q;});q.in.mockImplementation(()=>q);q.select.mockImplementation(()=>q);q.single.mockImplementation(async()=>result());q.maybeSingle.mockImplementation(async()=>result());return q;
}
// Đợt 10b: sửa phiếu nhập và vật tư công việc là MỘT hàm máy chủ thay nguyên tử (replace_material_purchase_v1,
// save_job_material_usage_v1); máy giả trả đúng hình dạng biên nhận của hai hàm đó.
type Row=Record<string,unknown>;
let rpcCalls:Array<{name:string;args:Row}>=[];let rpcError:unknown=null;let rpcReceiptMissing=false;
function rpcFixture(name:string,args:Row):Result{
 rpcCalls.push({name,args});if(rpcError)return {data:null,error:rpcError};
 const items=args.p_items as Row[];
 if(name==='replace_material_purchase_v1')return {data:{purchase:{id:args.p_purchase_id,organization_id:'org-a',code:'PN-1',purchase_date:args.p_purchase_date,supplier_id:args.p_supplier_id,notes:args.p_notes,total:0},items:rpcReceiptMissing?null:items.map((item,index)=>({id:`line-${index}`,purchase_id:args.p_purchase_id,...item}))},error:null};
 if(!existing&&!items.length)return {data:{usage_id:null,usage:null,removed:false,items:[]},error:null};
 const usageId=existing?'header-1':'header-new';
 if(!items.length)return {data:{usage_id:usageId,usage:null,removed:true,items:[]},error:null};
 return {data:{usage_id:usageId,usage:{id:usageId,job_id:args.p_job_id,code:'PX-1',usage_date:args.p_usage_date,notes:args.p_notes,organization_id:'org-a'},removed:false,items:items.map((item,index)=>({id:`line-${index}`,usage_id:usageId,...item}))},error:null};
}
const run=(hook:()=>unknown,input:unknown)=>(hook() as {mutationFn:(value:unknown)=>Promise<unknown>}).mutationFn(input);
const purchase={purchase_date:'2026-09-30',supplier_id:null,notes:null,items:[{material_id:'m-1',quantity:2,unit_price:100}]};const usage={usage_date:'2026-09-30',notes:null,items:[{material_id:'m-1',quantity:2,unit_cost_at_usage:100}]};const adjustment={adjustment_date:'2026-09-30',type:'IN',reason:null,items:[{material_id:'m-1',quantity:2}]};
beforeEach(()=>{vi.clearAllMocks();forgetUnconfirmedCreates();localStorage.clear();localStorage.setItem('ihomecrm.selectedOrganizationId','org-a');writes=[];existing=true;insertError=null;cleanupError=null;cleanupMissing=false;cleanupWrongId=false;missingInsertReceipt=false;missingDeleteReceipt=false;io.from.mockImplementation(fixture);rpcCalls=[];rpcError=null;rpcReceiptMissing=false;io.rpc.mockImplementation(async(name:string,args:Record<string,unknown>)=>rpcFixture(name,args));});
// Đợt 10b: bốn test dưới đây trước đợt 10b tên «purchase UPDATE then DELETE-all then INSERT preserves main projection and
// default server line ID», «job UPDATE then DELETE-all then INSERT preserves main projection/default line identity», «empty
// existing job keeps main UPDATE-header DELETE-items DELETE-header order», «empty purchase update keeps main UPDATE-header
// DELETE-all and no insert» và chốt chuỗi lệnh ghi thẳng bảng. Nay đúng MỘT lời gọi hàm nguyên tử; phép chiếu dòng của bản
// main giữ nguyên (chỉ ba trường của dòng, bỏ `id`/trường lạ của nơi gọi), không gửi organization_id.
it('purchase edit is ONE replace_material_purchase_v1 call with the main projection; no direct table writes',async()=>{await run(useUpdateMaterialPurchase,{id:'header-1',input:{...purchase,items:[{...purchase.items[0],id:'caller-id',extra:'ignored'}]}});expect(writes).toEqual([]);expect(rpcCalls).toEqual([{name:'replace_material_purchase_v1',args:{p_purchase_id:'header-1',p_purchase_date:purchase.purchase_date,p_supplier_id:null,p_notes:null,p_items:[{material_id:'m-1',quantity:2,unit_price:100}]}}]);});
it('job save is ONE save_job_material_usage_v1 call with the main projection; no direct table writes',async()=>{await expect(run(useUpsertJobMaterialUsage,{...usage,job_id:'job-1',items:[{...usage.items[0],id:'caller-id',extra:'ignored'}]})).resolves.toBe('header-1');expect(writes).toEqual([]);expect(rpcCalls).toEqual([{name:'save_job_material_usage_v1',args:{p_job_id:'job-1',p_usage_date:usage.usage_date,p_notes:null,p_items:[{material_id:'m-1',quantity:2,unit_cost_at_usage:100}]}}]);});
it('empty existing job is one call with no items; the server removes the header and the hook resolves its ID',async()=>{await expect(run(useUpsertJobMaterialUsage,{...usage,job_id:'job-1',items:[]})).resolves.toBe('header-1');expect(writes).toEqual([]);expect(rpcCalls.map(call=>call.args.p_items)).toEqual([[]]);});
it('empty purchase update is one call with no items and no direct writes',async()=>{await run(useUpdateMaterialPurchase,{id:'header-1',input:{...purchase,items:[]}});expect(writes).toEqual([]);expect(rpcCalls.map(call=>call.args.p_items)).toEqual([[]]);});
// Đợt 9: dòng phiếu mang mã do trình duyệt sinh (trước đợt 9 test này tên «… and server default ID»); phần còn lại của
// hình dạng dòng giữ đúng như bản main.
it.each([[useCreateMaterialPurchase,purchase,'material_purchases','purchase_id'],[useCreateMaterialUsage,usage,'material_usages','usage_id'],[useCreateMaterialAdjustment,adjustment,'material_adjustments','adjustment_id']])('create preserves main explicit projection with a client line ID',async(hook,input,table,foreignKey)=>{await run(hook,{...input,items:[{...input.items[0],id:'caller-id',extra:'ignored'}]});expect(writes.map(w=>w.verb)).toEqual(['insert','insert']);const row={...input.items[0],[foreignKey]:'header-1',organization_id:'org-a'};expect(writes[1].payload).toEqual([{...row,id:expect.any(String)}]);expect((writes[1].payload as Array<{id:string}>)[0].id).not.toBe('caller-id');expect(writes[0].table).toBe(table);});
it.each([[useCreateMaterialPurchase,purchase],[useCreateMaterialAdjustment,adjustment]])('create empty remains delegated to main writer rather than new hook constraint',async(hook,input)=>{await run(hook,{...input,items:[]});expect(writes).toHaveLength(1);expect(writes[0].verb).toBe('insert');});
// Đợt 9: trước đợt 9 test này tên «SET retains main signed delta/Math.abs and object line payload without client ID» và
// lấy tồn từ số của màn. Nay tồn đọc trên máy chủ (fixture: on_hand 1), số của màn bị bỏ qua; dòng mang mã do trình duyệt sinh.
it('SET derives signed delta/Math.abs from SERVER stock (not the screen) and sends one line with a client ID',async()=>{await run(useSetMaterialStock,{material_id:'m-1',current_quantity:7,target_quantity:-2});expect(writes[0].payload).toMatchObject({type:'OUT',reason:'Kiểm kê — đặt lại tồn'});expect(writes[1].payload).toEqual([{adjustment_id:'header-1',material_id:'m-1',quantity:3,organization_id:'org-a',id:expect.any(String)}]);});
it.each([[useCreateMaterialPurchase,purchase,'material_purchases'],[useCreateMaterialUsage,usage,'material_usages'],[useCreateMaterialAdjustment,adjustment,'material_adjustments'],[useSetMaterialStock,{material_id:'m-1',target_quantity:2},'material_adjustments']])('confirmed main cleanup after known rejection releases retry truthfully',async(hook,input,table)=>{insertError={code:'42501',message:'SQL secret'};const error=await run(hook,input).catch(e=>e);expect(writes.map(w=>w.verb)).toEqual(['insert','insert','delete']);expect(writes[2].table).toBe(table);expect(writes[2].filters).toEqual([['id','header-1']]);expect(error).toMatchObject({outcome:'failure',completed:[]});if(!(error instanceof FinancialWorkflowError))throw new Error('Expected workflow feedback');expect(error.message).toContain('phiếu tạm đã gỡ');expect(error.message).not.toContain('SQL secret');(hook() as unknown as {onError:(error:unknown)=>void}).onError(error);expect(JSON.stringify(vi.mocked(toast.error).mock.calls)).toContain('phiếu tạm đã gỡ');expect(JSON.stringify(vi.mocked(toast.error).mock.calls)).not.toContain('SQL secret');await expect(run(hook,input)).rejects.toMatchObject({outcome:'failure'});expect(writes).toHaveLength(6);});
// Đợt 9 (luật 5): ba test dưới đây trước đợt 9 tên «cleanup uncertainty keeps header ID and blocks remount replay»,
// «unknown original line result stays blocked even when main header cleanup is confirmed», «missing insert receipt does
// not add cleanup beyond main and retains IDs/no-replay» và chốt lần tạo sau bị chặn. Hàng rào giữ: không báo hoàn tất,
// không lộ lỗi gốc, chưa rõ thì KHÔNG gỡ đầu phiếu (dòng có thể đã ghi). Nay không khoá: lần sau gửi lại đúng mã phiếu
// và đúng mã dòng (khoá chính chặn bản thứ hai).
it.each(['missing','error','wrong-ID'])('cleanup uncertainty after a known line rejection: names the kept header, does not lock, retry reuses the same header ID',async(mode)=>{insertError={code:'42501',message:'SQL secret'};cleanupMissing=mode==='missing';cleanupWrongId=mode==='wrong-ID';cleanupError=mode==='error'?{code:'42501',message:'cleanup SQL'}:null;const error=await run(useCreateMaterialPurchase,purchase).catch(e=>e);expect(error).toMatchObject({outcome:'failure'});expect(String((error as Error).message)).toContain('header-1');expect(String((error as Error).message)).not.toContain('SQL');expect(writes.map(w=>w.verb)).toEqual(['insert','insert','delete']);await expect(run(useCreateMaterialPurchase,purchase)).rejects.toMatchObject({outcome:'failure'});expect(writes.map(w=>w.verb)).toEqual(['insert','insert','delete','insert','insert','delete']);expect((writes[3].payload as {id:string}).id).toBe('header-1');});
it('unknown original line result: never removes the header (lines may be written), reads lines back, stays unknown without locking; retry resends the same header and line IDs',async()=>{insertError=new Error('offline');const error=await run(useCreateMaterialPurchase,purchase).catch(error=>error);expect(error).toBeInstanceOf(RepeatableWriteUnknownError);expect(error).toMatchObject({outcome:'unknown',completed:[expect.objectContaining({id:'header-1'})]});expect(writes.map(w=>w.verb)).toEqual(['insert','insert']);await expect(run(useCreateMaterialPurchase,purchase)).rejects.toBeInstanceOf(RepeatableWriteUnknownError);expect(writes.map(w=>w.verb)).toEqual(['insert','insert','insert','insert']);expect((writes[2].payload as {id:string}).id).toBe('header-1');expect((writes[3].payload as Array<{id:string}>)[0].id).toBe((writes[1].payload as Array<{id:string}>)[0].id);});
it('missing insert receipt does not add cleanup beyond main; stays unknown without locking and retry resends the same IDs',async()=>{missingInsertReceipt=true;await expect(run(useCreateMaterialPurchase,purchase)).rejects.toMatchObject({outcome:'unknown'});expect(writes.map(w=>w.verb)).toEqual(['insert','insert']);await expect(run(useCreateMaterialPurchase,purchase)).rejects.toMatchObject({outcome:'unknown'});expect(writes.map(w=>w.verb)).toEqual(['insert','insert','insert','insert']);expect((writes[3].payload as Array<{id:string}>)[0].id).toBe((writes[1].payload as Array<{id:string}>)[0].id);});
// Đợt 8 (luật 5): sửa phiếu nhập ghi lặp lại được nên không còn giữ dấu / khoá. Trước đợt 8 test này tên «unknown deletion
// receipt stops replacement and preserves header/guard»; đợt 10b: trước đó tên «unknown deletion receipt stops replacement on
// every attempt; retry is not locked and reruns the whole edit». Không còn lệnh xoá riêng; hàng rào giữ ở dạng mới: biên nhận
// thiếu dòng không bao giờ là đã lưu, ở mọi lần bấm, và lần bấm sau không bị khoá.
it('missing line receipt is unknown on every attempt; retry is not locked and resends the whole edit',async()=>{rpcReceiptMissing=true;await expect(run(useUpdateMaterialPurchase,{id:'header-1',input:purchase})).rejects.toBeInstanceOf(RepeatableWriteUnknownError);await expect(run(useUpdateMaterialPurchase,{id:'header-1',input:purchase})).rejects.toMatchObject({outcome:'unknown'});rpcReceiptMissing=false;await run(useUpdateMaterialPurchase,{id:'header-1',input:purchase});expect(rpcCalls).toHaveLength(3);expect(writes).toEqual([]);});

// Đợt 10b: trước đợt 10b test này tên «new job preserves main header/line projection with server default ID» (INSERT đầu phiếu
// rồi INSERT dòng). Nay máy chủ tạo đầu phiếu trong cùng hàm.
it('new job is the same single call; the server creates the header and the hook resolves the created ID',async()=>{existing=false;await expect(run(useUpsertJobMaterialUsage,{...usage,job_id:'job-1',items:[{...usage.items[0],id:'caller-id',extra:'ignored'}]})).resolves.toBe('header-new');expect(writes).toEqual([]);expect(rpcCalls).toHaveLength(1);});
// Đợt 8 (luật 5): trước đợt 8 test này tên «new job line rejection does not add cleanup beyond main, empty retry cannot release
// prior»; đợt 10b: trước đó tên «new job line rejection does not add cleanup beyond main; not locked: empty retry removes the
// empty header». Nay từ chối là lùi cả (không còn đầu phiếu rỗng nào để gỡ); không khoá: lần lưu bộ rỗng sau đó là một lời gọi.
it('new job refusal rolls back the whole call (no empty header left, no extra cleanup); not locked: an empty retry is one call',async()=>{existing=false;rpcError={code:'42501',message:'SQL secret'};const error=await run(useUpsertJobMaterialUsage,{...usage,job_id:'job-1'}).catch(e=>e);expect(error).toMatchObject({code:'42501'});expect(error).not.toBeInstanceOf(RepeatableWriteUnknownError);expect(writes).toEqual([]);rpcError=null;await expect(run(useUpsertJobMaterialUsage,{...usage,job_id:'job-1',items:[]})).resolves.toBeNull();expect(rpcCalls).toHaveLength(2);expect(writes).toEqual([]);});
