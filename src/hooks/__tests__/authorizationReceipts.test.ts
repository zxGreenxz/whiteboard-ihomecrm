import { beforeEach, expect, it, vi } from 'vitest';
const m=vi.hoisted(()=>({rpc:vi.fn()}));
vi.mock('@tanstack/react-query',()=>({useQuery:(v:unknown)=>v,useMutation:(v:unknown)=>v,useQueryClient:()=>({invalidateQueries:vi.fn()})}));
vi.mock('@/integrations/supabase/client',()=>({supabase:{rpc:m.rpc}}));
vi.mock('sonner',()=>({toast:{success:vi.fn(),error:vi.fn()}}));
import {useSaveMemberAuthorization,useUpsertOrganizationRole,useInviteMember,useRevokeInvitation,useUpdateOrganizationProfile,useOrganizationMembers} from '../useOrganizationAuthorization';
const cases = [
 ['member',useSaveMemberAuthorization,{membershipId:'m1',expectedVersion:3,reason:'Sửa phạm vi'}],
 ['role',useUpsertOrganizationRole,{name:'Vai trò mới'}],
 ['invite',useInviteMember,{email:'a@example.test',memberType:'STAFF'}],
 ['revoke',useRevokeInvitation,'i1'],
 ['profile',useUpdateOrganizationProfile,'Tổ chức A']
] as const;
beforeEach(()=>vi.clearAllMocks());
it.each(cases)('thiếu biên nhận %s không báo thành công',async(_kind,hook,input)=>{
 m.rpc.mockResolvedValue({data:null,error:null});
 const config=hook() as unknown as {mutationFn:(v:unknown)=>Promise<unknown>};
 await expect(config.mutationFn(input)).rejects.toBeTruthy();
});
it('phân quyền trả sai thành viên/version không phải biên nhận của bản đang sửa',async()=>{
 m.rpc.mockResolvedValue({data:{membershipId:'m2',version:4,permissionsAfter:2,gained:[],lost:[]},error:null});
 const config=useSaveMemberAuthorization() as unknown as {mutationFn:(v:unknown)=>Promise<unknown>};
 await expect(config.mutationFn({membershipId:'m1',expectedVersion:3})).rejects.toBeTruthy();
});
it('danh sách thành viên null không thành danh sách rỗng',async()=>{
 m.rpc.mockResolvedValue({data:null,error:null});
 const config=useOrganizationMembers() as unknown as {queryFn:()=>Promise<unknown>};
 await expect(config.queryFn()).rejects.toBeTruthy();
});
it('vai trò mới có ID và version thật được xác nhận',async()=>{
 const data={roleId:'r1',created:true,version:1,affectedMembers:0};m.rpc.mockResolvedValue({data,error:null});
 const config=useUpsertOrganizationRole() as unknown as {mutationFn:(v:unknown)=>Promise<unknown>};
 await expect(config.mutationFn({name:'Vai trò mới'})).resolves.toEqual(data);
});
