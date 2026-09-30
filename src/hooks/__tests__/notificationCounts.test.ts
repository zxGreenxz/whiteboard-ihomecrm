import {beforeEach,expect,it,vi} from 'vitest';
interface DatabaseReply { data: unknown; error: unknown }
interface NotificationQueryMock extends PromiseLike<DatabaseReply> {
 update: () => NotificationQueryMock; delete: () => NotificationQueryMock;
 eq: () => NotificationQueryMock; neq: () => NotificationQueryMock;
 select: () => Promise<DatabaseReply>;
}
const m=vi.hoisted(()=>({result:{data:[] as unknown,error:null as unknown},success:vi.fn(),info:vi.fn(),select:vi.fn()}));
vi.mock('@tanstack/react-query',()=>({useMutation:(v:unknown)=>v,useQueryClient:()=>({invalidateQueries:vi.fn()})}));
vi.mock('@/integrations/supabase/client',()=>{const chain:NotificationQueryMock={update:()=>chain,delete:()=>chain,eq:()=>chain,neq:()=>chain,select:m.select,then:(resolve,reject)=>Promise.resolve(m.result).then(resolve,reject)};return {supabase:{from:()=>chain}}});
vi.mock('../useAuth',()=>({useAuth:()=>({data:{id:'user-a'}})}));
vi.mock('sonner',()=>({toast:{success:m.success,info:m.info,error:vi.fn()}}));
import {useMarkAllAsRead,useDeleteAllRead} from '../useNotifications';
beforeEach(()=>{vi.clearAllMocks();m.result={data:[],error:null};m.select.mockImplementation(()=>Promise.resolve(m.result));});
it.each([useMarkAllAsRead,useDeleteAllRead])('không đổi dòng nào là thông tin, không báo xóa/đánh dấu thành công',async hook=>{
 const config=hook() as unknown as {mutationFn:()=>Promise<unknown>;onSuccess:(value:unknown)=>void};
 const value=await config.mutationFn();config.onSuccess(value);expect(m.select).toHaveBeenCalledWith('id');expect(m.success).not.toHaveBeenCalled();expect(m.info).toHaveBeenCalled();
});
it.each([useMarkAllAsRead,useDeleteAllRead])('số dòng đã xác nhận xuất hiện trong thông báo',async hook=>{
 m.result.data=[{id:'n1'},{id:'n2'}];const config=hook() as unknown as {mutationFn:()=>Promise<unknown>;onSuccess:(value:unknown)=>void};
 config.onSuccess(await config.mutationFn());expect(m.success).toHaveBeenCalledWith(expect.stringContaining('2 thông báo'));
});
