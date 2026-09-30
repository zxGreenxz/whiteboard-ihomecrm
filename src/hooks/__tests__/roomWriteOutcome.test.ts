// @vitest-environment jsdom
import { beforeEach, expect, it, vi } from 'vitest';
const io=vi.hoisted(()=>({from:vi.fn(),invalidate:vi.fn()}));
vi.mock('@tanstack/react-query',()=>({useMutation:(config:unknown)=>config,useQuery:(config:unknown)=>config,useQueryClient:()=>({invalidateQueries:io.invalidate})}));
vi.mock('@/integrations/supabase/client',()=>({supabase:{from:io.from}}));
vi.mock('@/contexts/OrganizationContext',()=>({useOrganization:()=>({selectedOrganizationId:'org-a'})}));
vi.mock('@/lib/authSession',()=>({getSessionUser:async()=>({id:'actor'})}));
vi.mock('sonner',()=>({toast:{error:vi.fn(),success:vi.fn(),info:vi.fn()}}));
import {useCreateRoom,useUpdateRoom,useDeleteRoom,useBulkCreateRooms,useUpdateRoomStatus} from '../useRooms';
import {toast} from 'sonner';
type Mutation={mutationFn:(input:unknown)=>Promise<unknown>;onSuccess:(data:unknown,input:unknown)=>void;onError:(error:unknown)=>void};
function writer(result:{data:unknown;error:unknown}){
 const chain={insert:vi.fn(),update:vi.fn(),eq:vi.fn(),select:vi.fn(),single:vi.fn().mockResolvedValue(result),then:(resolve:(v:unknown)=>void)=>resolve(result)};
 for(const method of ['insert','update','eq','select'] as const)chain[method].mockReturnValue(chain);
 io.from.mockReturnValue(chain);return chain;
}
beforeEach(()=>{vi.clearAllMocks();localStorage.clear();localStorage.setItem('ihomecrm.selectedOrganizationId','org-a');});
it('create missing receipt blocks retry after remount and keeps safe feedback',async()=>{
 const chain=writer({data:null,error:null});const input={building_id:'b1',name:'P101'};
 const mutation=useCreateRoom() as unknown as Mutation;
 const error=await mutation.mutationFn(input).catch(e=>e);
 expect(error).toMatchObject({outcome:'unknown'});mutation.onError(error);
 await expect((useCreateRoom() as unknown as Mutation).mutationFn(input)).rejects.toMatchObject({outcome:'unknown'});
 expect(chain.insert).toHaveBeenCalledTimes(1);expect(toast.success).not.toHaveBeenCalled();expect(io.invalidate).toHaveBeenCalled();
});
it.each([
 ['update',useUpdateRoom,{id:'r1',updates:{name:'P101'}}],
 ['status',useUpdateRoomStatus,{id:'r1',status:'AVAILABLE'}],
 ['delete',useDeleteRoom,'r1'],
])('%s needs the exact room ID before success',async(_name,hook,input)=>{
 const chain=writer({data:{id:'another',name:'P101',status:'AVAILABLE'},error:null});
 await expect((hook() as unknown as Mutation).mutationFn(input)).rejects.toMatchObject({outcome:'unknown'});
 expect(chain.select).toHaveBeenCalled();expect(toast.success).not.toHaveBeenCalled();
});
it('delete no-row response is not success',async()=>{
 writer({data:null,error:null});await expect((useDeleteRoom() as unknown as Mutation).mutationFn('r1')).rejects.toMatchObject({outcome:'unknown'});
});
it('bulk partial response retains IDs and blocks a second insert after remount',async()=>{
 const chain=writer({data:[{id:'r1',name:'P101',building_id:'b1'}],error:null});
 const input=[{building_id:'b1',name:'P101'},{building_id:'b1',name:'P102'}];
 const error=await (useBulkCreateRooms() as unknown as Mutation).mutationFn(input).catch(e=>e);
 expect(error).toMatchObject({outcome:'partial',completed:[{id:'r1'}]});
 await expect((useBulkCreateRooms() as unknown as Mutation).mutationFn(input)).rejects.toMatchObject({outcome:'partial',completed:[{id:'r1'}]});
 expect(chain.insert).toHaveBeenCalledTimes(1);
});
it('bulk null response does not claim no rooms created',async()=>{
 writer({data:null,error:null});await expect((useBulkCreateRooms() as unknown as Mutation).mutationFn([{building_id:'b1',name:'P101'}])).rejects.toMatchObject({outcome:'unknown'});
});
it('status receipt must show requested status',async()=>{
 writer({data:{id:'r1',name:'P101',status:'UNAVAILABLE'},error:null});
 await expect((useUpdateRoomStatus() as unknown as Mutation).mutationFn({id:'r1',status:'AVAILABLE'})).rejects.toMatchObject({outcome:'unknown'});
});
it('success and failure are emitted once by the hook with context and no SQL text',async()=>{
 writer({data:{id:'r1',name:'P101'},error:null});const mutation=useCreateRoom() as unknown as Mutation;
 const result=await mutation.mutationFn({building_id:'b1',name:'P101'});mutation.onSuccess(result,{});
 expect(toast.success).toHaveBeenCalledTimes(1);expect(vi.mocked(toast.success).mock.calls[0][0]).toContain('P101');
 const error={code:'42501',message:'raw SQL internal'};writer({data:null,error});
 const deletion=useDeleteRoom() as unknown as Mutation;await expect(deletion.mutationFn('r1')).rejects.toBe(error);
 expect(toast.error).not.toHaveBeenCalled();deletion.onError(error);expect(toast.error).toHaveBeenCalledTimes(1);
 expect(JSON.stringify(vi.mocked(toast.error).mock.calls)).not.toContain('raw SQL');
});
