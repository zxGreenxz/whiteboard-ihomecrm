// @vitest-environment jsdom
import {beforeEach,expect,it,vi} from 'vitest';
const io=vi.hoisted(()=>({from:vi.fn()}));
vi.mock('@tanstack/react-query',()=>({useMutation:(config:unknown)=>config,useQuery:(config:unknown)=>config,useQueryClient:()=>({invalidateQueries:vi.fn()})}));
vi.mock('@/integrations/supabase/client',()=>({supabase:{from:io.from}}));
vi.mock('@/contexts/OrganizationContext',()=>({useOrganization:()=>({selectedOrganizationId:'org-a'})}));vi.mock('@/lib/authSession',()=>({getSessionUser:async()=>({id:'actor'})}));vi.mock('sonner',()=>({toast:{success:vi.fn(),error:vi.fn()}}));
import {useCreateService,useUpdateService,useCreateServiceQuota,useUpdateServiceQuota} from '../useServices';
type Mutation={mutationFn:(input:unknown)=>Promise<unknown>};
function chain(result:{data:unknown;error:unknown}){const b={insert:vi.fn(),update:vi.fn(),upsert:vi.fn(),delete:vi.fn(),select:vi.fn(),eq:vi.fn(),in:vi.fn(),single:vi.fn().mockResolvedValue(result),then:(resolve:(value:unknown)=>void)=>resolve(result)};for(const method of ['insert','update','upsert','delete','select','eq','in'] as const)b[method].mockReturnValue(b);return b;}
beforeEach(()=>{vi.clearAllMocks();io.from.mockReset();localStorage.clear();localStorage.setItem('ihomecrm.selectedOrganizationId','org-a');});
it.each([['service',useCreateService,{name:'Điện',unit_price:100}],['quota',useCreateServiceQuota,{name:'Điện',tiers:[]}]])('%s core null blocks a repeat after remount',async(_name,hook,input)=>{const b=chain({data:null,error:null});io.from.mockReturnValue(b);await expect((hook() as unknown as Mutation).mutationFn(input)).rejects.toMatchObject({outcome:'unknown'});await expect((hook() as unknown as Mutation).mutationFn(input)).rejects.toMatchObject({outcome:'unknown'});expect(b.insert).toHaveBeenCalledTimes(1);});
it.each([['service',useUpdateService,{id:'s1',updates:{name:'Điện'},building_ids:[]}],['quota',useUpdateServiceQuota,{id:'q1',name:'Điện',tiers:[]}]])('%s update needs a core receipt before syncing children',async(_name,hook,input)=>{const core=chain({data:null,error:null});io.from.mockReturnValue(core);await expect((hook() as unknown as Mutation).mutationFn(input)).rejects.toMatchObject({outcome:'unknown'});expect(core.delete).not.toHaveBeenCalled();expect(core.upsert).not.toHaveBeenCalled();});
it('service links null after confirmed core is partial, persists ID and never creates core twice',async()=>{const core=chain({data:{id:'s1'},error:null});const links=chain({data:null,error:null});io.from.mockImplementation(table=>table==='services'?core:links);const input={name:'Điện',unit_price:100,building_ids:['b1']};await expect((useCreateService() as unknown as Mutation).mutationFn(input)).rejects.toMatchObject({serviceId:'s1'});await expect((useCreateService() as unknown as Mutation).mutationFn(input)).rejects.toMatchObject({outcome:'partial',completed:[{id:'s1'}]});expect(core.insert).toHaveBeenCalledTimes(1);});
it('service read null cannot remove or insert links',async()=>{const core=chain({data:{id:'s1'},error:null});const links=chain({data:null,error:null});io.from.mockImplementation(table=>table==='services'?core:links);await expect((useUpdateService() as unknown as Mutation).mutationFn({id:'s1',updates:{name:'Điện'},building_ids:['b1']})).rejects.toMatchObject({serviceId:'s1'});expect(links.delete).not.toHaveBeenCalled();expect(links.insert).not.toHaveBeenCalled();});
it('service follows main removal before insertion; failure preserves removed IDs and blocks replay',async()=>{
 const core=chain({data:{id:'s1'},error:null}),links=chain({data:[{id:'old',building_id:'old-building',is_active:true}],error:null});
 links.insert.mockReturnValue({select:()=>Promise.resolve({data:null,error:{code:'42501',message:'raw SQL'}})});io.from.mockImplementation(table=>table==='services'?core:links);
 const input={id:'s1',updates:{name:'Điện'},building_ids:['new-building']};
 await expect((useUpdateService() as unknown as Mutation).mutationFn(input)).rejects.toMatchObject({serviceId:'s1'});
 expect(links.delete).toHaveBeenCalledOnce();expect(links.delete.mock.invocationCallOrder[0]).toBeLessThan(links.insert.mock.invocationCallOrder[0]);
 const markers=Object.keys(localStorage).filter(key=>key.startsWith('ihome:financial-pending:')).map(key=>JSON.parse(localStorage.getItem(key)!));expect(markers[0].completedIds).toEqual(['s1','old']);
 await expect((useUpdateService() as unknown as Mutation).mutationFn(input)).rejects.toMatchObject({outcome:'partial'});expect(core.update).toHaveBeenCalledOnce();expect(links.delete).toHaveBeenCalledOnce();
});
it('quota tiers null retains core ID and blocks remount retry',async()=>{const core=chain({data:{id:'q1',name:'Điện',description:null,user_id:'actor'},error:null});const tiers=chain({data:null,error:null});io.from.mockImplementation(table=>table==='service_quotas'?core:tiers);const input={name:'Điện',tiers:[{tier_number:1,from_value:0,to_value:null,unit_price:100}]};await expect((useCreateServiceQuota() as unknown as Mutation).mutationFn(input)).rejects.toMatchObject({quotaId:'q1'});await expect((useCreateServiceQuota() as unknown as Mutation).mutationFn(input)).rejects.toMatchObject({outcome:'partial',completed:[{id:'q1'}]});expect(core.insert).toHaveBeenCalledTimes(1);});
it('quota missing delete receipt keeps core ID, blocks insert and never replays after remount',async()=>{
 const core=chain({data:{id:'q1',name:'Điện',description:null},error:null}),tiers=chain({data:null,error:null});io.from.mockImplementation(table=>table==='service_quotas'?core:tiers);
 const input={id:'q1',name:'Điện',tiers:[{tier_number:1,from_value:0,to_value:null,unit_price:100}]};
 await expect((useUpdateServiceQuota() as unknown as Mutation).mutationFn(input)).rejects.toMatchObject({quotaId:'q1'});
 expect(tiers.delete).toHaveBeenCalledOnce();expect(tiers.insert).not.toHaveBeenCalled();expect(tiers.upsert).not.toHaveBeenCalled();
 await expect((useUpdateServiceQuota() as unknown as Mutation).mutationFn(input)).rejects.toMatchObject({outcome:'partial'});expect(core.update).toHaveBeenCalledOnce();expect(tiers.delete).toHaveBeenCalledOnce();
});

it('quota create keeps the main header three fields and tier five fields; selected org remains marker-only',async()=>{
 const core=chain({data:{id:'q1',name:'Điện',description:null,user_id:'actor'},error:null});const tiers=chain({data:[{id:'t1',quota_id:'q1',tier_number:1,from_value:0,to_value:null,unit_price:100}],error:null});io.from.mockImplementation(table=>table==='service_quotas'?core:tiers);
 tiers.insert.mockImplementation(()=>{const markers=Object.keys(localStorage).filter(key=>key.startsWith('ihome:financial-pending:')).map(key=>JSON.parse(localStorage.getItem(key)!));expect(markers).toHaveLength(1);expect(markers[0].organizationId).toBe('org-a');return tiers;});
 await (useCreateServiceQuota() as unknown as Mutation).mutationFn({name:'Điện',tiers:[{tier_number:1,from_value:0,to_value:null,unit_price:100}]});
 expect(core.insert).toHaveBeenCalledWith({name:'Điện',description:null,user_id:'actor'});expect(tiers.insert).toHaveBeenCalledWith([{quota_id:'q1',tier_number:1,from_value:0,to_value:null,unit_price:100}]);
});

type UpdateQuotaInput=Parameters<ReturnType<typeof useUpdateServiceQuota>['mutateAsync']>[0];
const updateInput:UpdateQuotaInput={id:'q1',name:'Điện',description:'Giá điện',tiers:[{tier_number:1,from_value:0,to_value:null,unit_price:100}]};
const header={id:'q1',name:'Điện',description:'Giá điện'};
const oldTier={id:'old-tier',quota_id:'q1',tier_number:2};
const newTier={id:'new-tier',quota_id:'q1',...updateInput.tiers[0]};
const useUpdateConfig=()=>useUpdateServiceQuota() as unknown as Mutation;
it('quota update follows main UPDATE then DELETE-all then INSERT with only original IDs and fields',async()=>{
 const core=chain({data:header,error:null}),del=chain({data:[oldTier],error:null}),insert=chain({data:[newTier],error:null});io.from.mockReturnValueOnce(core).mockReturnValueOnce(del).mockReturnValue(insert);
 await expect(useUpdateConfig().mutationFn(updateInput)).resolves.toEqual(header);
 expect(core.update).toHaveBeenCalledWith({name:'Điện',description:'Giá điện'});expect(core.eq.mock.calls).toEqual([['id','q1']]);
 expect(del.delete).toHaveBeenCalledOnce();expect(del.eq.mock.calls).toEqual([['quota_id','q1']]);expect(del.in).not.toHaveBeenCalled();
 expect(insert.insert).toHaveBeenCalledWith([{quota_id:'q1',tier_number:1,from_value:0,to_value:null,unit_price:100}]);expect(insert.upsert).not.toHaveBeenCalled();
 expect(core.update.mock.invocationCallOrder[0]).toBeLessThan(del.delete.mock.invocationCallOrder[0]);expect(del.delete.mock.invocationCallOrder[0]).toBeLessThan(insert.insert.mock.invocationCallOrder[0]);
 expect(del.delete.mock.invocationCallOrder[0]).toBeLessThan(del.select.mock.invocationCallOrder[0]);
});
it('quota deleted tiers remain known when insert receipt is missing, and retry cannot repeat primary/delete',async()=>{
 const core=chain({data:header,error:null}),del=chain({data:[oldTier],error:null}),insert=chain({data:null,error:null});io.from.mockReturnValueOnce(core).mockReturnValueOnce(del).mockReturnValue(insert);
 const failure:unknown=await useUpdateConfig().mutationFn(updateInput).catch(error=>error);
 expect(failure).toMatchObject({quotaId:'q1'});if(!(failure instanceof Error))throw new Error('Expected partial error');
 expect(failure.message).toMatch(/đã gỡ.*bậc/i);expect(failure.message).toContain('old-tier');expect(failure.message).toMatch(/chưa xác nhận/i);
 await expect(useUpdateConfig().mutationFn(updateInput)).rejects.toMatchObject({outcome:'partial'});expect(core.update).toHaveBeenCalledOnce();expect(del.delete).toHaveBeenCalledOnce();expect(insert.insert).toHaveBeenCalledOnce();
});
it('quota incomplete inserted values keep every positive ID before validating the whole batch',async()=>{
 const core=chain({data:header,error:null}),del=chain({data:[oldTier],error:null}),insert=chain({data:[{...newTier,unit_price:999}],error:null});io.from.mockReturnValueOnce(core).mockReturnValueOnce(del).mockReturnValue(insert);
 const failure:unknown=await useUpdateConfig().mutationFn(updateInput).catch(error=>error);expect(failure).toMatchObject({quotaId:'q1'});
 const markers=Object.keys(localStorage).filter(key=>key.startsWith('ihome:financial-pending:')).map(key=>JSON.parse(localStorage.getItem(key)!));expect(markers).toHaveLength(1);expect(markers[0].completedIds).toEqual(['q1','old-tier','new-tier']);
});
it('quota header values must match before deleting tiers; positive ID remains for reconciliation',async()=>{
 const core=chain({data:{...header,name:'Old name'},error:null});io.from.mockReturnValue(core);
 await expect(useUpdateConfig().mutationFn(updateInput)).rejects.toBeTruthy();expect(core.delete).not.toHaveBeenCalled();
 const markers=Object.keys(localStorage).filter(key=>key.startsWith('ihome:financial-pending:')).map(key=>JSON.parse(localStorage.getItem(key)!));expect(markers).toHaveLength(1);expect(markers[0].completedIds).toContain('q1');
});
it.each([{...updateInput,name:''},{...updateInput,tiers:[{...updateInput.tiers[0],unit_price:-1.5}]},{...updateInput,tiers:[...updateInput.tiers,...updateInput.tiers]}])('quota hook does not add main-absent sign/empty/uniqueness limits before the server: %j',async input=>{
 const error={code:'42501',message:'SQL refusal'};const core=chain({data:null,error});io.from.mockReturnValue(core);
 await expect(useUpdateConfig().mutationFn(input)).rejects.toBe(error);expect(core.update).toHaveBeenCalledWith({name:input.name,description:input.description||null});expect(core.delete).not.toHaveBeenCalled();
});
it('quota empty tiers still delete all old tiers then complete without inserting',async()=>{
 const core=chain({data:header,error:null}),del=chain({data:[],error:null});io.from.mockReturnValueOnce(core).mockReturnValue(del);
 await expect(useUpdateConfig().mutationFn({...updateInput,tiers:[]})).resolves.toEqual(header);expect(del.delete).toHaveBeenCalledOnce();expect(del.insert).not.toHaveBeenCalled();
 expect(Object.keys(localStorage).filter(key=>key.startsWith('ihome:financial-pending:'))).toEqual([]);
});

it.each([{name:'',tiers:[]},{name:'Điện',tiers:[{tier_number:1,from_value:0,to_value:null,unit_price:-1.5}]},{name:'Điện',tiers:[{tier_number:1,from_value:0,to_value:null,unit_price:100},{tier_number:1,from_value:0,to_value:null,unit_price:100}]}])('quota create delegates original input rules to the existing server/form: %j',async input=>{
 const error={code:'42501',message:'SQL refusal'};const core=chain({data:null,error});io.from.mockReturnValue(core);
 await expect((useCreateServiceQuota() as unknown as Mutation).mutationFn(input)).rejects.toBe(error);expect(core.insert).toHaveBeenCalledWith({name:input.name,description:null,user_id:'actor'});
});
it('quota create wrong tier values retain positive header/tier IDs and never recreate the header',async()=>{
 const core=chain({data:{id:'q1',name:'Điện',description:null,user_id:'actor'},error:null}),tiers=chain({data:[{id:'t1',quota_id:'q1',tier_number:1,from_value:0,to_value:null,unit_price:999}],error:null});io.from.mockImplementation(table=>table==='service_quotas'?core:tiers);
 const input={name:'Điện',tiers:[{tier_number:1,from_value:0,to_value:null,unit_price:100}]};
 await expect((useCreateServiceQuota() as unknown as Mutation).mutationFn(input)).rejects.toMatchObject({quotaId:'q1'});
 const markers=Object.keys(localStorage).filter(key=>key.startsWith('ihome:financial-pending:')).map(key=>JSON.parse(localStorage.getItem(key)!));expect(markers).toHaveLength(1);expect(markers[0].completedIds).toEqual(['q1','t1']);
 await expect((useCreateServiceQuota() as unknown as Mutation).mutationFn(input)).rejects.toMatchObject({outcome:'partial'});expect(core.insert).toHaveBeenCalledOnce();expect(tiers.insert).toHaveBeenCalledOnce();
});

it('service link writes keep main delete-activate-insert order and original filters',async()=>{
 const core=chain({data:{id:'s1'},error:null}),read=chain({data:[{id:'old',building_id:'b-old',is_active:true},{id:'kept',building_id:'b-kept',is_active:false}],error:null}),del=chain({data:[{id:'old'}],error:null}),activate=chain({data:[{id:'kept'}],error:null}),insert=chain({data:[{id:'added'}],error:null});
 io.from.mockReturnValueOnce(core).mockReturnValueOnce(read).mockReturnValueOnce(del).mockReturnValueOnce(activate).mockReturnValue(insert);
 await (useUpdateService() as unknown as Mutation).mutationFn({id:'s1',updates:{name:'Điện'},building_ids:['b-kept','b-new']});
 expect(del.delete).toHaveBeenCalledOnce();expect(del.in).toHaveBeenCalledWith('id',['old']);expect(del.eq).not.toHaveBeenCalled();
 expect(activate.update).toHaveBeenCalledWith({is_active:true});expect(activate.in).toHaveBeenCalledWith('id',['kept']);expect(activate.eq).not.toHaveBeenCalled();
 expect(insert.insert).toHaveBeenCalledWith([{service_id:'s1',building_id:'b-new',is_active:true,organization_id:'org-a'}]);
 expect(del.delete.mock.invocationCallOrder[0]).toBeLessThan(activate.update.mock.invocationCallOrder[0]);expect(activate.update.mock.invocationCallOrder[0]).toBeLessThan(insert.insert.mock.invocationCallOrder[0]);
});
it.each([useCreateService,useUpdateService])('service does not silently deduplicate the main building input',async hook=>{
 const core=chain({data:{id:'s1'},error:null}),read=chain({data:[],error:null}),insert=chain({data:null,error:{code:'23505',message:'SQL refusal'}});
 io.from.mockImplementation(table=>table==='services'?core:hook===useCreateService?insert:io.from.mock.calls.filter(([table])=>table==='building_services').length===1?read:insert);
 const input=hook===useCreateService?{name:'Điện',building_ids:['b1','b1']}:{id:'s1',updates:{name:'Điện'},building_ids:['b1','b1']};
 await expect((hook() as unknown as Mutation).mutationFn(input)).rejects.toMatchObject({serviceId:'s1'});
 expect(insert.insert).toHaveBeenCalledWith([{service_id:'s1',building_id:'b1',is_active:true,organization_id:'org-a'},{service_id:'s1',building_id:'b1',is_active:true,organization_id:'org-a'}]);
});
