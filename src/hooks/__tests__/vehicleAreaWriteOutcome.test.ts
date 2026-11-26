// @vitest-environment jsdom
import {beforeEach,expect,it,vi} from 'vitest';
const io=vi.hoisted(()=>({from:vi.fn(),error:vi.fn(),success:vi.fn()}));
vi.mock('@/integrations/supabase/client',()=>({supabase:{from:io.from}}));
vi.mock('@/lib/authSession',()=>({getSessionUser:async()=>({id:'actor'})}));
vi.mock('@/contexts/OrganizationContext',()=>({useOrganization:()=>({selectedOrganizationId:'o1'})}));
vi.mock('@tanstack/react-query',()=>({useQuery:(v:unknown)=>v,useMutation:(v:unknown)=>v,useQueryClient:()=>({invalidateQueries:vi.fn()})}));
vi.mock('sonner',()=>({toast:{error:io.error,success:io.success}}));
import {useVehicles,useVehicle,useDistinctVehicleValues,useCreateVehicle,useUpdateVehicle,useDeleteVehicle} from '../useVehicles';
import {useAreas,useCreateArea,useUpdateArea,useAssignBuildingsToArea,useDeleteArea} from '../useAreas';
import {FinancialWorkflowError,RepeatableWriteUnknownError} from '@/lib/financialWorkflow';
import {recordWriteBlocked} from '@/lib/recordWriteOutcome';
function chain(data:unknown,error:unknown=null){const q:Record<string,unknown>={then:(r:(v:unknown)=>void)=>r({data,error})};for(const m of ['select','eq','is','in','order','insert','update','upsert','delete','single','maybeSingle'])q[m]=vi.fn(()=>q);return q;}
const mutation=(hook:()=>unknown)=>(hook() as {mutationFn:(v:unknown)=>Promise<unknown>;onError:(e:unknown)=>void});
const pendingMarkers=()=>Object.keys(localStorage).filter(key=>key.startsWith('ihome:financial-pending:'));
beforeEach(()=>{vi.resetAllMocks();localStorage.clear();localStorage.setItem('ihomecrm.selectedOrganizationId','o1');});
// Đường TẠO xe là đợt 9: biên nhận sai vẫn giữ dấu và chặn gửi lại.
it('vehicle create requires exact receipts and unknown survives rebuilding hook',async()=>{const q=chain(null);io.from.mockReturnValue(q);await expect(mutation(useCreateVehicle).mutationFn({})).rejects.toBeInstanceOf(FinancialWorkflowError);await expect(mutation(useCreateVehicle).mutationFn({})).rejects.toBeInstanceOf(FinancialWorkflowError);if(!vi.isMockFunction(q.insert))throw new Error('Expected mocked insert boundary');expect(q.insert).toHaveBeenCalledTimes(1);});
// Đợt 8 (luật 5): sửa / xoá xe lặp lại được — biên nhận sai vẫn không được coi là xong (hàng rào giữ nguyên), nhưng kết
// quả chưa rõ không giữ dấu, không khoá: dựng lại hook rồi bấm lại thì gửi lại lệnh ghi.
it.each([[useUpdateVehicle,{id:'v1',data:{}}],[useDeleteVehicle,'v1']])('vehicle edit/delete require exact receipts; unknown is repeatable and re-sends after rebuilding hook',async(hook,input)=>{const q=chain(null);io.from.mockReturnValue(q);for(let attempt=0;attempt<2;attempt++){const error=await mutation(hook).mutationFn(input).catch((e:unknown)=>e);expect(error).toBeInstanceOf(RepeatableWriteUnknownError);expect(recordWriteBlocked(error)).toBe(false);}if(!vi.isMockFunction(q.update))throw new Error('Expected mocked update boundary');expect(q.update).toHaveBeenCalledTimes(2);expect(pendingMarkers()).toEqual([]);});
it('area required list rejects null',async()=>{io.from.mockReturnValue(chain(null));await expect((useAreas() as unknown as {queryFn:()=>Promise<unknown>}).queryFn()).rejects.toThrow();});
it('create area no longer toasts in writer and only onError owns safe feedback',async()=>{const q=chain(null,{code:'23505',message:'SQL detail'});io.from.mockReturnValue(q);const hook=mutation(useCreateArea);let error:unknown;try{await hook.mutationFn({name:'A'});}catch(e){error=e;}expect(io.error).not.toHaveBeenCalled();hook.onError(error);expect(io.error).toHaveBeenCalledTimes(1);expect(JSON.stringify(io.error.mock.calls)).not.toContain('SQL detail');});
// Đợt 8: biên nhận sai mã vẫn là chưa rõ (không báo xong), nhưng không khoá — dựng lại hook thì lưu lại được.
it('area update unknown requires matching ID and re-sends after rebuilding hook (no lock)',async()=>{const q=chain({id:'wrong'});io.from.mockReturnValue(q);for(let attempt=0;attempt<2;attempt++){const error=await mutation(useUpdateArea).mutationFn({id:'a1',updates:{name:'A'}}).catch((e:unknown)=>e);expect(error).toBeInstanceOf(RepeatableWriteUnknownError);expect(recordWriteBlocked(error)).toBe(false);}expect(q.update).toHaveBeenCalledTimes(2);expect(pendingMarkers()).toEqual([]);});
it('area main removal precedes addition; partial keeps removed pair and the retry only re-sends what is missing',async()=>{
 const read=chain([{area_id:'a1',building_id:'b-old'}]),deleted=chain([{area_id:'a1',building_id:'b-old'}]),failed=chain(null,{code:'42501',message:'SQL detail'});io.from.mockReturnValueOnce(read).mockReturnValueOnce(deleted).mockReturnValueOnce(failed);
 const input={areaId:'a1',toAddIds:['b-new'],toRemoveIds:['b-old']};const error:unknown=await mutation(useAssignBuildingsToArea).mutationFn(input).catch(e=>e);
 expect(error).toBeInstanceOf(FinancialWorkflowError);if(!(error instanceof FinancialWorkflowError))throw error;expect(error.completed.map(v=>v.id)).toContain('a1:b-old');expect(error.completed.map(v=>v.label).join(' ')).toMatch(/gỡ/i);
 expect(recordWriteBlocked(error)).toBe(false);expect(pendingMarkers()).toEqual([]);
 // Bấm lại: đọc lại thấy b-old đã gỡ ⇒ lệnh gỡ khớp 0 dòng là đúng, chỉ còn gán b-new.
 const reread=chain([]),noop=chain([]),added=chain([{area_id:'a1',building_id:'b-new'}]);io.from.mockReturnValueOnce(reread).mockReturnValueOnce(noop).mockReturnValueOnce(added);
 await mutation(useAssignBuildingsToArea).mutationFn(input);expect(deleted.delete).toHaveBeenCalledOnce();expect(failed.upsert).toHaveBeenCalledOnce();expect(added.upsert).toHaveBeenCalledOnce();
});
it('area writer retains main removal/addition overlap and original projection',async()=>{
 const read=chain([{area_id:'a1',building_id:'b1'}]),deleted=chain([{area_id:'a1',building_id:'b1'}]),added=chain([{area_id:'a1',building_id:'b1'}]);io.from.mockReturnValueOnce(read).mockReturnValueOnce(deleted).mockReturnValue(added);
 await mutation(useAssignBuildingsToArea).mutationFn({areaId:'a1',toAddIds:['b1','b1'],toRemoveIds:['b1']});
 expect(deleted.in).toHaveBeenCalledWith('building_id',['b1']);expect(added.upsert).toHaveBeenCalledWith([{area_id:'a1',building_id:'b1',user_id:'actor',organization_id:'o1'},{area_id:'a1',building_id:'b1',user_id:'actor',organization_id:'o1'}],{onConflict:'area_id,building_id',ignoreDuplicates:true});
 if(!vi.isMockFunction(deleted.delete)||!vi.isMockFunction(added.upsert))throw new Error('Expected writer mocks');expect(deleted.delete.mock.invocationCallOrder[0]).toBeLessThan(added.upsert.mock.invocationCallOrder[0]);
});

// Đợt 8: xoá mềm khu chỉ khớp khu còn sống nên gửi lại an toàn — chưa rõ thì giữ mã khu để đối chiếu, không khoá.
it('area deletion unknown retains root ID and retries the core update (no lock)',async()=>{const q=chain(null);io.from.mockImplementation(name=>name==='area_buildings'?chain([]):q);for(let attempt=0;attempt<2;attempt++){const error=await mutation(useDeleteArea).mutationFn('a1').catch((e:unknown)=>e);expect(error).toBeInstanceOf(RepeatableWriteUnknownError);expect(error).toMatchObject({completed:[{id:'a1'}]});expect(recordWriteBlocked(error)).toBe(false);}expect(q.update).toHaveBeenCalledTimes(2);expect(q.is).toHaveBeenCalledWith('deleted_at',null);expect(pendingMarkers()).toEqual([]);});

it.each([useVehicles,useDistinctVehicleValues,()=>useVehicle('v1')])('vehicle required sources reject null rather than reporting empty/loaded',async(hook)=>{io.from.mockReturnValue(chain(null));await expect((hook() as unknown as {queryFn:()=>Promise<unknown>}).queryFn()).rejects.toThrow();});

it('area deletion does not mutate before membership source is known',async()=>{const q=chain(null);io.from.mockReturnValue(q);await expect(mutation(useDeleteArea).mutationFn('a1')).rejects.toThrow();expect(q.update).not.toHaveBeenCalled();});

it.each([{toAddIds:[],toRemoveIds:['absent']},{toAddIds:['b1'],toRemoveIds:[]}])('area null receipt is unknown even when no changed pair was expected: %j',async change=>{
 const read=chain([{area_id:'a1',building_id:'b1'}]),write=chain(null);io.from.mockReturnValueOnce(read).mockReturnValue(write);
 const input={areaId:'a1',...change};await expect(mutation(useAssignBuildingsToArea).mutationFn(input)).rejects.toBeInstanceOf(FinancialWorkflowError);
 await expect(mutation(useAssignBuildingsToArea).mutationFn(input)).rejects.toBeInstanceOf(FinancialWorkflowError);
});
// Đợt 8: biên nhận gỡ có cặp lạ (ngoài danh sách cần gỡ) vẫn là chưa rõ và giữ mã các cặp đã nhận trong câu báo — nhưng
// không ghi dấu nào; bấm lại thì đọc lại các tòa hiện có và gửi lại.
it('area pair receipt with an unexpected pair stays unknown, keeps the received pairs, writes no marker and can be re-sent',async()=>{
 const read=chain([{area_id:'a1',building_id:'b1'},{area_id:'a1',building_id:'b2'}]),write=chain([{area_id:'a1',building_id:'b1'},{area_id:'a1',building_id:'b9'}]);io.from.mockReturnValueOnce(read).mockReturnValueOnce(write);
 const input={areaId:'a1',toAddIds:[],toRemoveIds:['b1','b2']};const error:unknown=await mutation(useAssignBuildingsToArea).mutationFn(input).catch(e=>e);
 expect(error).toBeInstanceOf(RepeatableWriteUnknownError);if(!(error instanceof FinancialWorkflowError))throw error;expect(error.completed.map(v=>v.id)).toContain('a1:b1');
 expect(recordWriteBlocked(error)).toBe(false);expect(pendingMarkers()).toEqual([]);
 const reread=chain([{area_id:'a1',building_id:'b2'}]),again=chain([{area_id:'a1',building_id:'b2'}]);io.from.mockReturnValueOnce(reread).mockReturnValueOnce(again);
 await mutation(useAssignBuildingsToArea).mutationFn(input);expect(again.delete).toHaveBeenCalledOnce();
});
// Đợt 8: gỡ khớp THIẾU cặp thì đọc lại đúng cặp chưa nhận — còn nguyên là RLS không cho gỡ ⇒ từ chối rõ, không gán gì thêm.
it('area removal that matches fewer pairs re-reads them; still present means a clear permission refusal',async()=>{
 const read=chain([{area_id:'a1',building_id:'b1'},{area_id:'a1',building_id:'b2'}]),write=chain([{area_id:'a1',building_id:'b1'}]),check=chain([{area_id:'a1',building_id:'b2'}]),add=chain([]);io.from.mockReturnValueOnce(read).mockReturnValueOnce(write).mockReturnValueOnce(check).mockReturnValue(add);
 const error:unknown=await mutation(useAssignBuildingsToArea).mutationFn({areaId:'a1',toAddIds:['b3'],toRemoveIds:['b1','b2']}).catch(e=>e);
 expect(error).toBeInstanceOf(FinancialWorkflowError);expect(error).not.toBeInstanceOf(RepeatableWriteUnknownError);expect(error).toMatchObject({outcome:'failure'});
 expect(check.in).toHaveBeenCalledWith('building_id',['b2']);expect(add.upsert).not.toHaveBeenCalled();
});
