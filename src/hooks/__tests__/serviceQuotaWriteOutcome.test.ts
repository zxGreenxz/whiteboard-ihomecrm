// @vitest-environment jsdom
import {beforeEach,expect,it,vi} from 'vitest';
const io=vi.hoisted(()=>({from:vi.fn(),rpc:vi.fn()}));
vi.mock('@tanstack/react-query',()=>({useMutation:(config:unknown)=>config,useQuery:(config:unknown)=>config,useQueryClient:()=>({invalidateQueries:vi.fn()})}));
vi.mock('@/integrations/supabase/client',()=>({supabase:{from:io.from,rpc:io.rpc}}));
vi.mock('@/contexts/OrganizationContext',()=>({useOrganization:()=>({selectedOrganizationId:'org-a'})}));vi.mock('@/lib/authSession',()=>({getSessionUser:async()=>({id:'actor'})}));vi.mock('sonner',()=>({toast:{success:vi.fn(),error:vi.fn()}}));
import {useCreateService,useUpdateService,useCreateServiceQuota,useUpdateServiceQuota} from '../useServices';
import {RepeatableWriteUnknownError} from '@/lib/financialWorkflowError';
import {recordWriteMessage} from '@/lib/recordWriteOutcome';
type Mutation={mutationFn:(input:unknown)=>Promise<unknown>};
// Đợt 8: sửa dịch vụ / định mức lặp lại được, không còn giữ dấu «chờ đối chiếu» nào.
const markerKeys=()=>Object.keys(localStorage).filter(key=>key.startsWith('ihome:financial-pending:'));
function chain(result:{data:unknown;error:unknown}){const b={insert:vi.fn(),update:vi.fn(),upsert:vi.fn(),delete:vi.fn(),select:vi.fn(),eq:vi.fn(),in:vi.fn(),single:vi.fn().mockResolvedValue(result),then:(resolve:(value:unknown)=>void)=>resolve(result)};for(const method of ['insert','update','upsert','delete','select','eq','in'] as const)b[method].mockReturnValue(b);return b;}
beforeEach(()=>{vi.clearAllMocks();io.from.mockReset();io.rpc.mockReset();localStorage.clear();localStorage.setItem('ihomecrm.selectedOrganizationId','org-a');});
// Đợt 9 (luật 5): tạo dịch vụ / định mức không giữ dấu nữa. Thiếu biên nhận lõi vẫn là chưa rõ (hàng rào giữ nguyên); lần sau gửi
// lại ĐÚNG mã cũ (khoá chính chặn bản thứ hai). Trước đợt 9: «core null blocks a repeat after remount».
it.each([['service',useCreateService,{name:'Điện',unit_price:100}],['quota',useCreateServiceQuota,{name:'Điện',tiers:[]}]])('%s core null stays unknown and the retry after remount re-sends the same client ID',async(_name,hook,input)=>{const b=chain({data:null,error:null});io.from.mockReturnValue(b);await expect((hook() as unknown as Mutation).mutationFn(input)).rejects.toMatchObject({outcome:'unknown'});await expect((hook() as unknown as Mutation).mutationFn(input)).rejects.toMatchObject({outcome:'unknown'});expect(b.insert).toHaveBeenCalledTimes(2);expect(b.insert.mock.calls[1]?.[0].id).toBe(b.insert.mock.calls[0]?.[0].id);expect(markerKeys()).toEqual([]);});
it('service update needs a core receipt before syncing children',async()=>{const core=chain({data:null,error:null});io.from.mockReturnValue(core);await expect((useUpdateService() as unknown as Mutation).mutationFn({id:'s1',updates:{name:'Điện'},building_ids:[]})).rejects.toMatchObject({outcome:'unknown'});expect(core.delete).not.toHaveBeenCalled();expect(core.upsert).not.toHaveBeenCalled();});
// Đợt 10b: sửa định mức là MỘT lệnh replace_service_quota_v1; biên nhận thiếu ⇒ chưa rõ, không lệnh ghi thẳng nào (trước đợt 10b: «quota update needs a core receipt before syncing children» qua it.each chung với dịch vụ).
it('quota update without a receipt stays unknown and never writes the tables directly',async()=>{io.rpc.mockResolvedValue({data:null,error:null});await expect((useUpdateServiceQuota() as unknown as Mutation).mutationFn({id:'q1',name:'Điện',tiers:[]})).rejects.toMatchObject({outcome:'unknown'});expect(io.rpc).toHaveBeenCalledOnce();expect(io.from).not.toHaveBeenCalled();});
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
const newTier={id:'new-tier',quota_id:'q1',...updateInput.tiers[0]};
const useUpdateConfig=()=>useUpdateServiceQuota() as unknown as Mutation;
// Đợt 10b: trước đợt 10b các test dưới chốt UPDATE đầu định mức → DELETE mọi bậc → INSERT bậc mới và câu «đã gỡ bậc giá cũ»
// («quota update follows main UPDATE then DELETE-all then INSERT…», «quota deleted tiers stay known when insert receipt is
// missing…», «quota incomplete inserted values…», «quota header values must match before deleting tiers…», «quota empty tiers
// still delete all old tiers…»). Nay cả bộ đi MỘT hàm máy chủ thay nguyên tử; hàng rào biên nhận giữ nguyên.
it('quota update is ONE replace_service_quota_v1 call with the original fields only (no organization_id) and returns the header',async()=>{
 io.rpc.mockResolvedValue({data:{quota:header,tiers:[newTier]},error:null});
 await expect(useUpdateConfig().mutationFn(updateInput)).resolves.toEqual(header);
 expect(io.rpc).toHaveBeenCalledWith('replace_service_quota_v1',{p_quota_id:'q1',p_name:'Điện',p_description:'Giá điện',p_tiers:[{tier_number:1,from_value:0,to_value:null,unit_price:100}]});
 expect(io.from).not.toHaveBeenCalled();
});
it('quota missing tiers receipt is unknown without a marker; a retry sends the whole set again',async()=>{
 io.rpc.mockResolvedValueOnce({data:{quota:header,tiers:null},error:null});
 const failure:unknown=await useUpdateConfig().mutationFn(updateInput).catch(error=>error);
 expect(failure).toBeInstanceOf(RepeatableWriteUnknownError);expect((failure as Error).message).toMatch(/một lần/);expect((failure as Error).message).not.toMatch(/đã gỡ|thiếu bậc/i);
 expect(markerKeys()).toEqual([]);
 io.rpc.mockResolvedValueOnce({data:{quota:header,tiers:[newTier]},error:null});
 await expect(useUpdateConfig().mutationFn(updateInput)).resolves.toEqual(header);expect(io.rpc).toHaveBeenCalledTimes(2);
});
it('quota receipt with wrong tier values is not trusted, no marker',async()=>{
 io.rpc.mockResolvedValue({data:{quota:header,tiers:[{...newTier,unit_price:999}]},error:null});
 await expect(useUpdateConfig().mutationFn(updateInput)).rejects.toBeInstanceOf(RepeatableWriteUnknownError);expect(markerKeys()).toEqual([]);
});
it('quota receipt with wrong header values is not trusted, no marker',async()=>{
 io.rpc.mockResolvedValue({data:{quota:{...header,name:'Old name'},tiers:[newTier]},error:null});
 await expect(useUpdateConfig().mutationFn(updateInput)).rejects.toBeInstanceOf(RepeatableWriteUnknownError);expect(markerKeys()).toEqual([]);
});
it.each([{...updateInput,name:''},{...updateInput,tiers:[{...updateInput.tiers[0],unit_price:-1.5}]},{...updateInput,tiers:[...updateInput.tiers,...updateInput.tiers]}])('quota hook does not add main-absent sign/empty/uniqueness limits before the server: %j',async input=>{
 const error={code:'42501',message:'SQL refusal'};io.rpc.mockResolvedValue({data:null,error});
 await expect(useUpdateConfig().mutationFn(input)).rejects.toBe(error);expect(io.rpc).toHaveBeenCalledWith('replace_service_quota_v1',expect.objectContaining({p_name:input.name,p_description:input.description||null,p_tiers:input.tiers}));
});
it('quota empty tiers is one call with an empty list',async()=>{
 io.rpc.mockResolvedValue({data:{quota:header,tiers:[]},error:null});
 await expect(useUpdateConfig().mutationFn({...updateInput,tiers:[]})).resolves.toEqual(header);expect(io.rpc).toHaveBeenCalledWith('replace_service_quota_v1',expect.objectContaining({p_tiers:[]}));
 expect(Object.keys(localStorage).filter(key=>key.startsWith('ihome:financial-pending:'))).toEqual([]);
});
it('quota not found / not editable (P0002) shows the server sentence as a clear refusal',async()=>{
 io.rpc.mockResolvedValue({data:null,error:{code:'P0002',message:'Không tìm thấy định mức này hoặc tài khoản chưa có quyền sửa. Tải lại danh sách để kiểm tra.'}});
 const failure:unknown=await useUpdateConfig().mutationFn(updateInput).catch(error=>error);
 expect(failure).toMatchObject({outcome:'failure'});expect(failure).not.toBeInstanceOf(RepeatableWriteUnknownError);expect(recordWriteMessage(failure,'cập nhật định mức')).toContain('Không tìm thấy định mức này');
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
