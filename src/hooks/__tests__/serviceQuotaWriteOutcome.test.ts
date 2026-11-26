// @vitest-environment jsdom
import {beforeEach,expect,it,vi} from 'vitest';
const io=vi.hoisted(()=>({from:vi.fn()}));
vi.mock('@tanstack/react-query',()=>({useMutation:(config:unknown)=>config,useQuery:(config:unknown)=>config,useQueryClient:()=>({invalidateQueries:vi.fn()})}));
vi.mock('@/integrations/supabase/client',()=>({supabase:{from:io.from}}));
vi.mock('@/contexts/OrganizationContext',()=>({useOrganization:()=>({selectedOrganizationId:'org-a'})}));vi.mock('@/lib/authSession',()=>({getSessionUser:async()=>({id:'actor'})}));vi.mock('sonner',()=>({toast:{success:vi.fn(),error:vi.fn()}}));
import {useCreateService,useUpdateService,useCreateServiceQuota,useUpdateServiceQuota} from '../useServices';
import {RepeatableWriteUnknownError} from '@/lib/financialWorkflowError';
import {recordWriteMessage} from '@/lib/recordWriteOutcome';
type Mutation={mutationFn:(input:unknown)=>Promise<unknown>};
// Đợt 8: sửa dịch vụ / định mức lặp lại được, không còn giữ dấu «chờ đối chiếu» nào.
const markerKeys=()=>Object.keys(localStorage).filter(key=>key.startsWith('ihome:financial-pending:'));
function chain(result:{data:unknown;error:unknown}){const b={insert:vi.fn(),update:vi.fn(),upsert:vi.fn(),delete:vi.fn(),select:vi.fn(),eq:vi.fn(),in:vi.fn(),single:vi.fn().mockResolvedValue(result),then:(resolve:(value:unknown)=>void)=>resolve(result)};for(const method of ['insert','update','upsert','delete','select','eq','in'] as const)b[method].mockReturnValue(b);return b;}
beforeEach(()=>{vi.clearAllMocks();io.from.mockReset();localStorage.clear();localStorage.setItem('ihomecrm.selectedOrganizationId','org-a');});
// Đợt 9 (luật 5): tạo dịch vụ / định mức không giữ dấu nữa. Thiếu biên nhận lõi vẫn là chưa rõ (hàng rào giữ nguyên); lần sau gửi
// lại ĐÚNG mã cũ (khoá chính chặn bản thứ hai). Trước đợt 9: «core null blocks a repeat after remount».
it.each([['service',useCreateService,{name:'Điện',unit_price:100}],['quota',useCreateServiceQuota,{name:'Điện',tiers:[]}]])('%s core null stays unknown and the retry after remount re-sends the same client ID',async(_name,hook,input)=>{const b=chain({data:null,error:null});io.from.mockReturnValue(b);await expect((hook() as unknown as Mutation).mutationFn(input)).rejects.toMatchObject({outcome:'unknown'});await expect((hook() as unknown as Mutation).mutationFn(input)).rejects.toMatchObject({outcome:'unknown'});expect(b.insert).toHaveBeenCalledTimes(2);expect(b.insert.mock.calls[1]?.[0].id).toBe(b.insert.mock.calls[0]?.[0].id);expect(markerKeys()).toEqual([]);});
it.each([['service',useUpdateService,{id:'s1',updates:{name:'Điện'},building_ids:[]}],['quota',useUpdateServiceQuota,{id:'q1',name:'Điện',tiers:[]}]])('%s update needs a core receipt before syncing children',async(_name,hook,input)=>{const core=chain({data:null,error:null});io.from.mockReturnValue(core);await expect((hook() as unknown as Mutation).mutationFn(input)).rejects.toMatchObject({outcome:'unknown'});expect(core.delete).not.toHaveBeenCalled();expect(core.upsert).not.toHaveBeenCalled();});
// Đợt 9: lần bấm sau một lần gán tòa dở làm tiếp trên đúng dịch vụ đã tạo (không khoá, không dấu), vẫn không tạo lõi lần hai.
// Trước đợt 9 lần bấm sau bị chặn bằng dấu («… persists ID and never creates core twice»).
it('service links null after confirmed core is partial; the retry (with the created ID) works on the same service and never creates core twice',async()=>{const core=Object.assign(chain({data:{id:'s1'},error:null}),{maybeSingle:vi.fn().mockResolvedValue({data:{id:'s1',deleted_at:null},error:null})});const links=chain({data:null,error:null});io.from.mockImplementation(table=>table==='services'?core:links);const input={name:'Điện',unit_price:100,building_ids:['b1']};await expect((useCreateService() as unknown as Mutation).mutationFn(input)).rejects.toMatchObject({serviceId:'s1'});await expect((useCreateService() as unknown as Mutation).mutationFn({...input,continueId:'s1'})).rejects.toMatchObject({serviceId:'s1'});expect(core.eq).toHaveBeenCalledWith('id','s1');expect(core.insert).toHaveBeenCalledTimes(1);expect(markerKeys()).toEqual([]);});
it('service read null cannot remove or insert links; reports unknown without a marker',async()=>{const core=chain({data:{id:'s1'},error:null});const links=chain({data:null,error:null});io.from.mockImplementation(table=>table==='services'?core:links);await expect((useUpdateService() as unknown as Mutation).mutationFn({id:'s1',updates:{name:'Điện'},building_ids:['b1']})).rejects.toBeInstanceOf(RepeatableWriteUnknownError);expect(links.delete).not.toHaveBeenCalled();expect(links.insert).not.toHaveBeenCalled();expect(markerKeys()).toEqual([]);});
it('service follows main removal before insertion; refusal after removal is reported clearly, no marker, retry re-syncs',async()=>{
 const core=chain({data:{id:'s1'},error:null}),links=chain({data:[{id:'old',building_id:'old-building',is_active:true}],error:null});
 links.insert.mockReturnValue({select:()=>Promise.resolve({data:null,error:{code:'42501',message:'raw SQL'}})});io.from.mockImplementation(table=>table==='services'?core:links);
 const input={id:'s1',updates:{name:'Điện'},building_ids:['new-building']};
 const failure:unknown=await (useUpdateService() as unknown as Mutation).mutationFn(input).catch(error=>error);
 expect(failure).toMatchObject({outcome:'failure'});expect((failure as Error).message).toMatch(/Dịch vụ đã lưu nhưng chưa lưu xong tòa áp dụng/);expect((failure as Error).message).not.toContain('raw SQL');
 expect(links.delete).toHaveBeenCalledOnce();expect(links.delete.mock.invocationCallOrder[0]).toBeLessThan(links.insert.mock.invocationCallOrder[0]);
 expect(markerKeys()).toEqual([]);
 await expect((useUpdateService() as unknown as Mutation).mutationFn(input)).rejects.toMatchObject({outcome:'failure'});expect(core.update).toHaveBeenCalledTimes(2);expect(links.insert).toHaveBeenCalledTimes(2);
});
// Đợt 9: lần bấm sau một lần ghi bậc dở làm tiếp trên đúng định mức đã tạo (gỡ bậc của nó rồi ghi lại), không tạo lõi lần hai,
// không dấu. Trước đợt 9: «quota tiers null retains core ID and blocks remount retry».
it('quota tiers null retains core ID; the retry (with the created ID) rewrites tiers of the same quota and never creates the header twice',async()=>{const row={id:'q1',name:'Điện',description:null,user_id:'actor',organization_id:'org-a'};const core=Object.assign(chain({data:row,error:null}),{maybeSingle:vi.fn().mockResolvedValue({data:{...row,deleted_at:null},error:null})});const tiers=chain({data:null,error:null});io.from.mockImplementation(table=>table==='service_quotas'?core:tiers);const input={name:'Điện',tiers:[{tier_number:1,from_value:0,to_value:null,unit_price:100}]};await expect((useCreateServiceQuota() as unknown as Mutation).mutationFn(input)).rejects.toMatchObject({quotaId:'q1'});await expect((useCreateServiceQuota() as unknown as Mutation).mutationFn({...input,continueId:'q1'})).rejects.toMatchObject({quotaId:'q1'});expect(core.insert).toHaveBeenCalledTimes(1);expect(tiers.delete).toHaveBeenCalledOnce();expect(tiers.eq).toHaveBeenCalledWith('quota_id','q1');expect(markerKeys()).toEqual([]);});
it('quota missing delete receipt blocks insert; reports unknown without a marker and a retry runs again',async()=>{
 const core=chain({data:{id:'q1',name:'Điện',description:null},error:null}),tiers=chain({data:null,error:null});io.from.mockImplementation(table=>table==='service_quotas'?core:tiers);
 const input={id:'q1',name:'Điện',tiers:[{tier_number:1,from_value:0,to_value:null,unit_price:100}]};
 await expect((useUpdateServiceQuota() as unknown as Mutation).mutationFn(input)).rejects.toBeInstanceOf(RepeatableWriteUnknownError);
 expect(tiers.delete).toHaveBeenCalledOnce();expect(tiers.insert).not.toHaveBeenCalled();expect(tiers.upsert).not.toHaveBeenCalled();expect(markerKeys()).toEqual([]);
 await expect((useUpdateServiceQuota() as unknown as Mutation).mutationFn(input)).rejects.toBeInstanceOf(RepeatableWriteUnknownError);expect(core.update).toHaveBeenCalledTimes(2);expect(tiers.delete).toHaveBeenCalledTimes(2);expect(tiers.insert).not.toHaveBeenCalled();
});

// Đợt 9: lõi thêm `id` do trình duyệt sinh; không còn dấu nào trong suốt lần ghi (trước đợt 9: «… selected org remains marker-only»).
it('quota create keeps the main header three fields (plus the client ID) and tier five fields; no marker at any point',async()=>{
 const core=chain({data:{id:'q1',name:'Điện',description:null,user_id:'actor',organization_id:'org-a'},error:null});const tiers=chain({data:[{id:'t1',quota_id:'q1',tier_number:1,from_value:0,to_value:null,unit_price:100}],error:null});io.from.mockImplementation(table=>table==='service_quotas'?core:tiers);
 tiers.insert.mockImplementation(()=>{expect(markerKeys()).toEqual([]);return tiers;});
 await (useCreateServiceQuota() as unknown as Mutation).mutationFn({name:'Điện',tiers:[{tier_number:1,from_value:0,to_value:null,unit_price:100}]});
 expect(core.insert).toHaveBeenCalledWith({name:'Điện',description:null,user_id:'actor',organization_id:'org-a',id:expect.any(String)});expect(tiers.insert).toHaveBeenCalledWith([{quota_id:'q1',tier_number:1,from_value:0,to_value:null,unit_price:100,organization_id:'org-a'}]);
 expect(tiers.delete).not.toHaveBeenCalled();
});

type UpdateQuotaInput=Parameters<ReturnType<typeof useUpdateServiceQuota>['mutateAsync']>[0];
const updateInput:UpdateQuotaInput={id:'q1',name:'Điện',description:'Giá điện',tiers:[{tier_number:1,from_value:0,to_value:null,unit_price:100}]};
const header={id:'q1',name:'Điện',description:'Giá điện',organization_id:'org-a'};
const oldTier={id:'old-tier',quota_id:'q1',tier_number:2};
const newTier={id:'new-tier',quota_id:'q1',...updateInput.tiers[0]};
const useUpdateConfig=()=>useUpdateServiceQuota() as unknown as Mutation;
it('quota update follows main UPDATE then DELETE-all then INSERT with only original IDs and fields',async()=>{
 const core=chain({data:header,error:null}),del=chain({data:[oldTier],error:null}),insert=chain({data:[newTier],error:null});io.from.mockReturnValueOnce(core).mockReturnValueOnce(del).mockReturnValue(insert);
 await expect(useUpdateConfig().mutationFn(updateInput)).resolves.toEqual(header);
 expect(core.update).toHaveBeenCalledWith({name:'Điện',description:'Giá điện'});expect(core.eq.mock.calls).toEqual([['id','q1']]);
 expect(del.delete).toHaveBeenCalledOnce();expect(del.eq.mock.calls).toEqual([['quota_id','q1']]);expect(del.in).not.toHaveBeenCalled();
 expect(insert.insert).toHaveBeenCalledWith([{quota_id:'q1',tier_number:1,from_value:0,to_value:null,unit_price:100,organization_id:'org-a'}]);expect(insert.upsert).not.toHaveBeenCalled();
 expect(core.update.mock.invocationCallOrder[0]).toBeLessThan(del.delete.mock.invocationCallOrder[0]);expect(del.delete.mock.invocationCallOrder[0]).toBeLessThan(insert.insert.mock.invocationCallOrder[0]);
 expect(del.delete.mock.invocationCallOrder[0]).toBeLessThan(del.select.mock.invocationCallOrder[0]);
});
it('quota deleted tiers stay known when insert receipt is missing; no marker, a retry writes the whole set again',async()=>{
 const core=chain({data:header,error:null}),del=chain({data:[oldTier],error:null}),insert=chain({data:null,error:null});io.from.mockReturnValueOnce(core).mockReturnValueOnce(del).mockReturnValueOnce(insert);
 const failure:unknown=await useUpdateConfig().mutationFn(updateInput).catch(error=>error);
 expect(failure).toBeInstanceOf(RepeatableWriteUnknownError);if(!(failure instanceof RepeatableWriteUnknownError))throw new Error('Expected repeatable error');
 expect(failure.message).toMatch(/chưa xác nhận.*đã gỡ bậc giá cũ/i);expect(failure.completed).toEqual([{id:'old-tier',label:'Đã gỡ bậc giá cũ'}]);expect(recordWriteMessage(failure,'cập nhật định mức')).toContain('old-tier');
 expect(markerKeys()).toEqual([]);
 const core2=chain({data:header,error:null}),del2=chain({data:[],error:null}),insert2=chain({data:[newTier],error:null});io.from.mockReturnValueOnce(core2).mockReturnValueOnce(del2).mockReturnValueOnce(insert2);
 await expect(useUpdateConfig().mutationFn(updateInput)).resolves.toEqual(header);expect(core2.update).toHaveBeenCalledOnce();expect(del2.delete).toHaveBeenCalledOnce();expect(insert2.insert).toHaveBeenCalledOnce();
});
it('quota incomplete inserted values are not trusted; every positive ID is reported, no marker',async()=>{
 const core=chain({data:header,error:null}),del=chain({data:[oldTier],error:null}),insert=chain({data:[{...newTier,unit_price:999}],error:null});io.from.mockReturnValueOnce(core).mockReturnValueOnce(del).mockReturnValue(insert);
 const failure:unknown=await useUpdateConfig().mutationFn(updateInput).catch(error=>error);expect(failure).toBeInstanceOf(RepeatableWriteUnknownError);
 expect((failure as RepeatableWriteUnknownError).completed.map(step=>step.id)).toEqual(['old-tier','new-tier']);expect(markerKeys()).toEqual([]);
});
it('quota header values must match before deleting tiers; positive ID is reported, no marker',async()=>{
 const core=chain({data:{...header,name:'Old name'},error:null});io.from.mockReturnValue(core);
 const failure:unknown=await useUpdateConfig().mutationFn(updateInput).catch(error=>error);expect(failure).toBeInstanceOf(RepeatableWriteUnknownError);expect(core.delete).not.toHaveBeenCalled();
 expect((failure as RepeatableWriteUnknownError).completed.map(step=>step.id)).toContain('q1');expect(markerKeys()).toEqual([]);
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
 await expect((useCreateServiceQuota() as unknown as Mutation).mutationFn(input)).rejects.toBe(error);expect(core.insert).toHaveBeenCalledWith({name:input.name,description:null,user_id:'actor',organization_id:'org-a',id:expect.any(String)});
});
// Hàng rào giữ nguyên: biên nhận bậc giá sai giá trị không được coi là xong; câu báo nêu mã định mức và mã bậc đã nhận. Đợt 9:
// không còn dấu; lần bấm sau gỡ bậc của đúng định mức đó rồi ghi lại, không tạo lại lõi.
it('quota create wrong tier values retain positive header/tier IDs and never recreate the header',async()=>{
 const row={id:'q1',name:'Điện',description:null,user_id:'actor',organization_id:'org-a'};const core=Object.assign(chain({data:row,error:null}),{maybeSingle:vi.fn().mockResolvedValue({data:{...row,deleted_at:null},error:null})}),tiers=chain({data:[{id:'t1',quota_id:'q1',tier_number:1,from_value:0,to_value:null,unit_price:999}],error:null});io.from.mockImplementation(table=>table==='service_quotas'?core:tiers);
 const input={name:'Điện',tiers:[{tier_number:1,from_value:0,to_value:null,unit_price:100}]};
 const failure:unknown=await (useCreateServiceQuota() as unknown as Mutation).mutationFn(input).catch(error=>error);
 expect(failure).toMatchObject({quotaId:'q1'});expect((failure as Error).message).toContain('q1');expect((failure as Error).message).toContain('t1');
 expect(markerKeys()).toEqual([]);
 await expect((useCreateServiceQuota() as unknown as Mutation).mutationFn({...input,continueId:'q1'})).rejects.toMatchObject({quotaId:'q1'});expect(core.insert).toHaveBeenCalledOnce();expect(tiers.delete).toHaveBeenCalledOnce();expect(tiers.insert).toHaveBeenCalledTimes(2);
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
 io.from.mockImplementation(table=>table==='services'?core:io.from.mock.calls.filter(([table])=>table==='building_services').length===1?read:insert);
 const input=hook===useCreateService?{name:'Điện',building_ids:['b1','b1']}:{id:'s1',updates:{name:'Điện'},building_ids:['b1','b1']};
 // Tạo (đợt 9: đồng bộ tòa theo phần chênh như sửa) báo ghi dở theo mã dịch vụ; sửa (đợt 8) báo từ chối rõ, lưu lại được.
 await expect((hook() as unknown as Mutation).mutationFn(input)).rejects.toMatchObject(hook===useCreateService?{serviceId:'s1'}:{outcome:'failure'});
 expect(insert.insert).toHaveBeenCalledWith([{service_id:'s1',building_id:'b1',is_active:true,organization_id:'org-a'},{service_id:'s1',building_id:'b1',is_active:true,organization_id:'org-a'}]);
});
