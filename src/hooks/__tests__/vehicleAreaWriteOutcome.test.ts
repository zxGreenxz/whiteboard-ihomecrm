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
import {FinancialWorkflowError} from '@/lib/financialWorkflow';
function chain(data:unknown,error:unknown=null){const q:Record<string,unknown>={then:(r:(v:unknown)=>void)=>r({data,error})};for(const m of ['select','eq','is','in','order','insert','update','upsert','delete','single'])q[m]=vi.fn(()=>q);return q;}
const mutation=(hook:()=>unknown)=>(hook() as {mutationFn:(v:unknown)=>Promise<unknown>;onError:(e:unknown)=>void});
beforeEach(()=>{vi.resetAllMocks();localStorage.clear();localStorage.setItem('ihomecrm.selectedOrganizationId','o1');});
it.each([[useCreateVehicle,{}],[useUpdateVehicle,{id:'v1',data:{}}],[useDeleteVehicle,'v1']])('vehicle writes require exact receipts and unknown survives rebuilding hook',async(hook,input)=>{const q=chain(null);io.from.mockReturnValue(q);await expect(mutation(hook).mutationFn(input)).rejects.toBeInstanceOf(FinancialWorkflowError);await expect(mutation(hook).mutationFn(input)).rejects.toBeInstanceOf(FinancialWorkflowError);if(!vi.isMockFunction(q.insert)||!vi.isMockFunction(q.update))throw new Error('Expected mocked insert/update boundary');expect(q.insert.mock.calls.length+q.update.mock.calls.length).toBe(1);});
it('area required list rejects null',async()=>{io.from.mockReturnValue(chain(null));await expect((useAreas() as unknown as {queryFn:()=>Promise<unknown>}).queryFn()).rejects.toThrow();});
it('create area no longer toasts in writer and only onError owns safe feedback',async()=>{const q=chain(null,{code:'23505',message:'SQL detail'});io.from.mockReturnValue(q);const hook=mutation(useCreateArea);let error:unknown;try{await hook.mutationFn({name:'A'});}catch(e){error=e;}expect(io.error).not.toHaveBeenCalled();hook.onError(error);expect(io.error).toHaveBeenCalledTimes(1);expect(JSON.stringify(io.error.mock.calls)).not.toContain('SQL detail');});
it('area update unknown requires matching ID and cannot replay after rebuilding hook',async()=>{const q=chain({id:'wrong'});io.from.mockReturnValue(q);await expect(mutation(useUpdateArea).mutationFn({id:'a1',updates:{name:'A'}})).rejects.toBeInstanceOf(FinancialWorkflowError);await expect(mutation(useUpdateArea).mutationFn({id:'a1',updates:{name:'A'}})).rejects.toBeInstanceOf(FinancialWorkflowError);expect(q.update).toHaveBeenCalledTimes(1);});
it('area main removal precedes addition; partial keeps removed pair and cannot replay',async()=>{
 const read=chain([{area_id:'a1',building_id:'b-old'}]),deleted=chain([{area_id:'a1',building_id:'b-old'}]),failed=chain(null,{code:'42501',message:'SQL detail'});io.from.mockReturnValueOnce(read).mockReturnValueOnce(deleted).mockReturnValue(failed);
 const input={areaId:'a1',toAddIds:['b-new'],toRemoveIds:['b-old']};const error:unknown=await mutation(useAssignBuildingsToArea).mutationFn(input).catch(e=>e);
 expect(error).toBeInstanceOf(FinancialWorkflowError);if(!(error instanceof FinancialWorkflowError))throw error;expect(error.completed.map(v=>v.id)).toContain('a1:b-old');expect(error.completed.map(v=>v.label).join(' ')).toMatch(/gỡ/i);
 await expect(mutation(useAssignBuildingsToArea).mutationFn(input)).rejects.toBeInstanceOf(FinancialWorkflowError);expect(deleted.delete).toHaveBeenCalledOnce();expect(failed.upsert).toHaveBeenCalledOnce();
});
it('area writer retains main removal/addition overlap and original projection',async()=>{
 const read=chain([{area_id:'a1',building_id:'b1'}]),deleted=chain([{area_id:'a1',building_id:'b1'}]),added=chain([{area_id:'a1',building_id:'b1'}]);io.from.mockReturnValueOnce(read).mockReturnValueOnce(deleted).mockReturnValue(added);
 await mutation(useAssignBuildingsToArea).mutationFn({areaId:'a1',toAddIds:['b1','b1'],toRemoveIds:['b1']});
 expect(deleted.in).toHaveBeenCalledWith('building_id',['b1']);expect(added.upsert).toHaveBeenCalledWith([{area_id:'a1',building_id:'b1',user_id:'actor'},{area_id:'a1',building_id:'b1',user_id:'actor'}],{onConflict:'area_id,building_id',ignoreDuplicates:true});
 if(!vi.isMockFunction(deleted.delete)||!vi.isMockFunction(added.upsert))throw new Error('Expected writer mocks');expect(deleted.delete.mock.invocationCallOrder[0]).toBeLessThan(added.upsert.mock.invocationCallOrder[0]);
});

it('area deletion unknown retains root ID and does not retry core update',async()=>{const q=chain(null);io.from.mockImplementation(name=>name==='area_buildings'?chain([]):q);await expect(mutation(useDeleteArea).mutationFn('a1')).rejects.toBeInstanceOf(FinancialWorkflowError);await expect(mutation(useDeleteArea).mutationFn('a1')).rejects.toBeInstanceOf(FinancialWorkflowError);expect(q.update).toHaveBeenCalledTimes(1);});

it.each([useVehicles,useDistinctVehicleValues,()=>useVehicle('v1')])('vehicle required sources reject null rather than reporting empty/loaded',async(hook)=>{io.from.mockReturnValue(chain(null));await expect((hook() as unknown as {queryFn:()=>Promise<unknown>}).queryFn()).rejects.toThrow();});

it('area deletion does not mutate before membership source is known',async()=>{const q=chain(null);io.from.mockReturnValue(q);await expect(mutation(useDeleteArea).mutationFn('a1')).rejects.toThrow();expect(q.update).not.toHaveBeenCalled();});

it.each([{toAddIds:[],toRemoveIds:['absent']},{toAddIds:['b1'],toRemoveIds:[]}])('area null receipt is unknown even when no changed pair was expected: %j',async change=>{
 const read=chain([{area_id:'a1',building_id:'b1'}]),write=chain(null);io.from.mockReturnValueOnce(read).mockReturnValue(write);
 const input={areaId:'a1',...change};await expect(mutation(useAssignBuildingsToArea).mutationFn(input)).rejects.toBeInstanceOf(FinancialWorkflowError);
 await expect(mutation(useAssignBuildingsToArea).mutationFn(input)).rejects.toBeInstanceOf(FinancialWorkflowError);
});
it('area partial pair receipt persists each positive pair before batch validation',async()=>{
 const read=chain([{area_id:'a1',building_id:'b1'},{area_id:'a1',building_id:'b2'}]),write=chain([{area_id:'a1',building_id:'b1'}]);io.from.mockReturnValueOnce(read).mockReturnValue(write);
 const input={areaId:'a1',toAddIds:[],toRemoveIds:['b1','b2']};const error:unknown=await mutation(useAssignBuildingsToArea).mutationFn(input).catch(e=>e);
 expect(error).toBeInstanceOf(FinancialWorkflowError);if(!(error instanceof FinancialWorkflowError))throw error;expect(error.completed.map(v=>v.id)).toContain('a1:b1');
 const markers=Object.keys(localStorage).filter(key=>key.startsWith('ihome:financial-pending:')).map(key=>JSON.parse(localStorage.getItem(key)!));expect(markers[0].completedIds).toContain('a1:b1');
 await expect(mutation(useAssignBuildingsToArea).mutationFn(input)).rejects.toBeInstanceOf(FinancialWorkflowError);expect(write.delete).toHaveBeenCalledOnce();
});
