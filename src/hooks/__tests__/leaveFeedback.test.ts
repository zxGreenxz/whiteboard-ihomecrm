import { it,expect,vi } from 'vitest';
const m=vi.hoisted(()=>({rpc:vi.fn()}));
vi.mock('@tanstack/react-query',()=>({useMutation:(o:unknown)=>o,useQueryClient:()=>({invalidateQueries:vi.fn()})}));
vi.mock('@/integrations/supabase/client',()=>({supabase:{rpc:m.rpc}}));
import {useApproveLeave,leaveActionErrorMessage} from '../useMyDay';
it('duyệt phép phải xác nhận đúng ngày và quyết định',async()=>{
 m.rpc.mockResolvedValue({data:{approved:false,date:'2026-10-01'},error:null});
 const hook=useApproveLeave() as unknown as {mutationFn:(v:{user:string;date:string;approve:boolean})=>Promise<unknown>};
 await expect(hook.mutationFn({user:'u',date:'2026-10-01',approve:true})).rejects.toThrow();
});
it('giữ tên và ngày trong lỗi trạng thái đã biết, không lộ lỗi kỹ thuật',()=>{
 const context={employeeName:'An',date:'2026-10-01',approve:true};
 expect(leaveActionErrorMessage({message:'Ngày này không ở trạng thái chờ duyệt phép'},context)).toContain('An');
 expect(leaveActionErrorMessage({message:'Ngày này không ở trạng thái chờ duyệt phép'},context)).toContain('2026-10-01');
 expect(leaveActionErrorMessage({message:'relation private_table'},context)).not.toContain('private_table');
});
