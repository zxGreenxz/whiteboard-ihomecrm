// @vitest-environment jsdom
import {beforeEach,expect,it,vi} from 'vitest';
const io=vi.hoisted(()=>({from:vi.fn(),invalidate:vi.fn(),rpc:vi.fn()}));
vi.mock('@tanstack/react-query',()=>({useMutation:(config:unknown)=>config,useQuery:(config:unknown)=>config,useQueryClient:()=>({invalidateQueries:io.invalidate})}));
vi.mock('@/integrations/supabase/client',()=>({supabase:{from:io.from,rpc:io.rpc}}));
vi.mock('@/contexts/OrganizationContext',()=>({useOrganization:()=>({selectedOrganizationId:'org-a'})}));
vi.mock('@/lib/authSession',()=>({getSessionUser:async()=>({id:'actor'})}));
vi.mock('sonner',()=>({toast:{error:vi.fn(),success:vi.fn(),info:vi.fn()}}));
import {useCreateCustomer,useUpdateCustomer,useDeleteCustomer} from '../useCustomers';
import {useCreateBuilding,useUpdateBuilding,useUpdateBuildingStatus} from '../useBuildings';
type Mutation={mutationFn:(input:unknown)=>Promise<unknown>};
function chain(result:{data:unknown;error:unknown}){
 const writer={insert:vi.fn(),update:vi.fn(),eq:vi.fn(),is:vi.fn(),in:vi.fn(),select:vi.fn(),single:vi.fn().mockResolvedValue(result),then:(resolve:(v:unknown)=>void)=>resolve(result)};
 for(const method of ['insert','update','eq','is','in','select'] as const)writer[method].mockReturnValue(writer);return writer;
}
beforeEach(()=>{vi.clearAllMocks();io.from.mockReset();localStorage.clear();localStorage.setItem('ihomecrm.selectedOrganizationId','org-a');});
it.each([['customer',useCreateCustomer,{full_name:'An',phone:'0900000000'}],['building',useCreateBuilding,{name:'Tòa A'}]])('%s create needs an ID and blocks uncertain repeat across remount',async(_label,hook,input)=>{
 const writer=chain({data:null,error:null});io.from.mockReturnValue(writer);
 await expect((hook() as unknown as Mutation).mutationFn(input)).rejects.toMatchObject({outcome:'unknown'});
 await expect((hook() as unknown as Mutation).mutationFn(input)).rejects.toMatchObject({outcome:'unknown'});
 expect(writer.insert).toHaveBeenCalledTimes(1);
});
it.each([['customer',useUpdateCustomer,{id:'c1',data:{full_name:'An'}}],['building',useUpdateBuilding,{id:'b1',updates:{name:'Tòa A'}}],['building status',useUpdateBuildingStatus,{id:'b1',status:'ACTIVE'}]])('%s update needs exact target ID',async(_label,hook,input)=>{
 io.from.mockReturnValue(chain({data:{id:'other',status:'ACTIVE'},error:null}));
 await expect((hook() as unknown as Mutation).mutationFn(input)).rejects.toMatchObject({outcome:'unknown'});
});
it('customer vehicle partial preserves core receipt and prevents a second core after remount',async()=>{
 const core=chain({data:{id:'c1',full_name:'An'},error:null});const vehicles=chain({data:null,error:{code:'42501',message:'raw SQL'}});
 io.from.mockImplementation(table=>table==='customers'?core:vehicles);
 const input={full_name:'An',phone:'0900000000',vehicles:[{vehicle_type:'MOTORBIKE',license_plate:'59A1'}]};
 const result=await (useCreateCustomer() as unknown as Mutation).mutationFn(input);
 expect(result).toMatchObject({customer:{id:'c1'},vehicleError:{outcome:'partial',completed:[{id:'c1'}]}});
 await expect((useCreateCustomer() as unknown as Mutation).mutationFn(input)).rejects.toMatchObject({outcome:'partial',completed:[{id:'c1'}]});expect(core.insert).toHaveBeenCalledTimes(1);
});
it('customer vehicle read null never removes old rows',async()=>{
 const core=chain({data:{id:'c1',full_name:'An'},error:null});const vehicles=chain({data:null,error:null});io.from.mockImplementation(table=>table==='customers'?core:vehicles);
 const result=await (useUpdateCustomer() as unknown as Mutation).mutationFn({id:'c1',data:{full_name:'An',vehicles:[]}});
 expect(result).toMatchObject({customer:{id:'c1'},vehicleError:{outcome:'partial'}});expect(vehicles.update).not.toHaveBeenCalled();
});
it('customer main removal remains completed when adding vehicles fails',async()=>{
 const core=chain({data:{id:'c1',full_name:'An'},error:null});
 const vehicles=chain({data:[{id:'old'}],error:null});vehicles.insert.mockReturnValue({select:vi.fn().mockResolvedValue({data:null,error:{code:'42501',message:'raw SQL'}})});
 io.from.mockImplementation(table=>table==='customers'?core:vehicles);
 const result=await (useUpdateCustomer() as unknown as Mutation).mutationFn({id:'c1',data:{full_name:'An',vehicles:[{vehicle_type:'MOTORBIKE',license_plate:'59A1'}]}});
 expect(result).toMatchObject({customer:{id:'c1'},vehicleError:{outcome:'partial'}});expect(vehicles.update).toHaveBeenCalledOnce();expect(vehicles.update.mock.invocationCallOrder[0]).toBeLessThan(vehicles.insert.mock.invocationCallOrder[0]);
 const markers=Object.keys(localStorage).filter(key=>key.startsWith('ihome:financial-pending:')).map(key=>JSON.parse(localStorage.getItem(key)!));expect(markers[0].completedIds).toContain('old');
});

it('invalid vehicle type is rejected before saving any customer core',async()=>{
 const core=chain({data:{id:'c1',full_name:'An'},error:null});io.from.mockReturnValue(core);
 await expect((useCreateCustomer() as unknown as Mutation).mutationFn({full_name:'An',phone:'0900000000',vehicles:[{vehicle_type:'UNKNOWN',license_plate:'59A1'}]})).rejects.toThrow('Loại phương tiện');
 expect(io.from).not.toHaveBeenCalled();
});
it('customer delete null links stop before RPC',async()=>{io.from.mockReturnValue(chain({data:null,error:null}));await expect((useDeleteCustomer() as unknown as Mutation).mutationFn('c1')).rejects.toThrow();expect(io.rpc).not.toHaveBeenCalled();});
it('customer delete needs a positively deleted row after the void RPC',async()=>{io.rpc.mockResolvedValue({data:null,error:null});const read=chain({data:[],error:null});const confirmation=chain({data:null,error:null});Object.assign(confirmation,{maybeSingle:vi.fn().mockResolvedValue({data:null,error:null})});io.from.mockReturnValueOnce(read).mockReturnValue(confirmation);await expect((useDeleteCustomer() as unknown as Mutation).mutationFn('c1')).rejects.toMatchObject({outcome:'unknown'});});

it('uncertain customer delete cannot replay RPC after hook remount',async()=>{
 const read=chain({data:[],error:null});Object.assign(read,{maybeSingle:vi.fn().mockResolvedValue({data:null,error:null})});io.from.mockReturnValue(read);io.rpc.mockResolvedValue({data:null,error:null});
 await expect((useDeleteCustomer() as unknown as Mutation).mutationFn('c1')).rejects.toMatchObject({outcome:'unknown'});
 await expect((useDeleteCustomer() as unknown as Mutation).mutationFn('c1')).rejects.toMatchObject({outcome:'partial',completed:[{id:'c1'}]});expect(io.rpc).toHaveBeenCalledTimes(1);
});

it('customer delete pending releases only after a positive deleted-state read, without replay',async()=>{
 const read=chain({data:[],error:null});const receipt=vi.fn().mockResolvedValueOnce({data:null,error:null}).mockResolvedValue({data:{id:'c1',deleted_at:'2026-09-30T04:00:00Z'},error:null});Object.assign(read,{maybeSingle:receipt});io.from.mockReturnValue(read);io.rpc.mockResolvedValue({data:null,error:null});
 await expect((useDeleteCustomer() as unknown as Mutation).mutationFn('c1')).rejects.toMatchObject({outcome:'unknown'});
 await expect((useDeleteCustomer() as unknown as Mutation).mutationFn('c1')).resolves.toMatchObject({id:'c1'});expect(io.rpc).toHaveBeenCalledTimes(1);
});

it('customer vehicle writer follows main remove-update-insert and original filters',async()=>{
 const core=chain({data:{id:'c1',full_name:'An'},error:null}),read=chain({data:[{id:'old'},{id:'kept'}],error:null}),removed=chain({data:[{id:'old'}],error:null}),updated=chain({data:{id:'kept'},error:null}),added=chain({data:[{id:'new'}],error:null});io.from.mockReturnValueOnce(core).mockReturnValueOnce(read).mockReturnValueOnce(removed).mockReturnValueOnce(updated).mockReturnValue(added);
 const result=await (useUpdateCustomer() as unknown as Mutation).mutationFn({id:'c1',data:{full_name:'An',vehicles:[{id:'kept',vehicle_type:'MOTORBIKE',license_plate:'59-kept'},{vehicle_type:'CAR',license_plate:'59-new'}]}});
 expect(result).toMatchObject({customer:{id:'c1'}});expect(result).not.toHaveProperty('vehicleError');
 expect(removed.in).toHaveBeenCalledWith('id',['old']);expect(removed.eq).not.toHaveBeenCalled();expect(updated.eq.mock.calls).toEqual([['id','kept']]);
 expect(removed.update.mock.invocationCallOrder[0]).toBeLessThan(updated.update.mock.invocationCallOrder[0]);expect(updated.update.mock.invocationCallOrder[0]).toBeLessThan(added.insert.mock.invocationCallOrder[0]);
});
