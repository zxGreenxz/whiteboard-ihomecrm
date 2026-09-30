import {beforeEach,expect,it,vi} from 'vitest';
const h=vi.hoisted(()=>({read:vi.fn(),rpc:vi.fn()}));
vi.mock('@/integrations/supabase/client',()=>({supabase:{from:()=>({select:()=>({eq:()=>({maybeSingle:h.read})})}),rpc:h.rpc}}));
import {loadBuildingLegalOwner,saveBuildingLegalOwner,emptyBuildingLegalOwner,buildingLegalOwnerSchema} from '../buildingLegalOwner';
beforeEach(()=>vi.clearAllMocks());
it('retains permission and conflict codes through owner read/write',async()=>{
 const denied={code:'42501',message:'permission denied for relation building_legal_owners'};
 h.read.mockResolvedValue({data:null,error:denied});h.rpc.mockResolvedValue({data:null,error:denied});
 await expect(loadBuildingLegalOwner('b')).rejects.toBe(denied);
 await expect(saveBuildingLegalOwner('b',emptyBuildingLegalOwner)).rejects.toBe(denied);
});
it('rejects missing owner response rather than replacing it with an empty owner',async()=>{
 h.read.mockResolvedValue({data:undefined,error:null});
 await expect(loadBuildingLegalOwner('b')).rejects.toThrow();
 h.read.mockResolvedValue({data:null,error:null});expect(await loadBuildingLegalOwner('b')).toBeNull();
});
it('each invalid field explains the exact limit in Vietnamese',()=>{
 const result=buildingLegalOwnerSchema.safeParse({...emptyBuildingLegalOwner,full_name:'a'.repeat(201),birth_year:1980.5,id_number:'1'.repeat(51)});
 expect(result.success).toBe(false);if(result.success)return;
 expect(result.error.issues.map(issue=>issue.message)).toEqual(['Họ tên chủ sở hữu không được quá 200 ký tự.','Năm sinh chủ sở hữu phải là số nguyên.','CCCD/CMND chủ sở hữu không được quá 50 ký tự.']);
});

it('owner RPC success still needs a positive matching read before complete',async()=>{
 h.rpc.mockResolvedValue({data:null,error:null});h.read.mockResolvedValue({data:null,error:null});
 await expect(saveBuildingLegalOwner('b',emptyBuildingLegalOwner)).rejects.toMatchObject({outcome:'unknown'});
 h.read.mockResolvedValue({data:{...emptyBuildingLegalOwner,full_name:'Another'},error:null});
 await expect(saveBuildingLegalOwner('b',emptyBuildingLegalOwner)).rejects.toMatchObject({outcome:'unknown'});
 h.read.mockResolvedValue({data:emptyBuildingLegalOwner,error:null});
 await expect(saveBuildingLegalOwner('b',emptyBuildingLegalOwner)).resolves.toBeUndefined();
});