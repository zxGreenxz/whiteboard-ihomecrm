// @vitest-environment jsdom
import { beforeEach,it,expect,vi } from 'vitest';
const m=vi.hoisted(()=>({from:vi.fn(),success:vi.fn()}));
vi.mock('react',()=>({useRef:(value:unknown)=>({current:value})}));
vi.mock('@tanstack/react-query',()=>({useMutation:(options:unknown)=>options,useQueryClient:()=>({invalidateQueries:vi.fn()})}));
vi.mock('@/lib/authSession',()=>({getSessionUser:async()=>({id:'u'})}));
vi.mock('sonner',()=>({toast:{error:vi.fn(),success:m.success}}));
vi.mock('@/integrations/supabase/client',()=>({supabase:{from:m.from}}));
import {useSaveManagerWithSalaries} from '../useProfitManagers';
import {useSyncShareholderBuildings} from '../useShareholders';
import {FinancialWorkflowError} from '@/lib/financialWorkflow';
beforeEach(()=>{vi.clearAllMocks();localStorage.clear();localStorage.setItem('ihomecrm.selectedOrganizationId','org-a');});
it('giữ mã quản lý sau khi xóa quy tắc thất bại, không ghi lại toàn bộ',async()=>{
 m.from.mockImplementation((table:string)=>table==='profit_managers'?{insert:()=>({select:()=>({single:async()=>({data:{id:'m1'},error:null})})})}:{select:()=>({eq:async()=>({data:[],error:null})}),delete:()=>({eq:()=>({select:async()=>({error:{message:'denied'}})})})});
 const config=useSaveManagerWithSalaries() as unknown as {mutationFn:(value:unknown)=>Promise<unknown>};
 const input={values:{name:'An',auth_user_id:'u'},rules:[]};
 const error=await config.mutationFn(input).catch(e=>e);
 expect(error).toBeInstanceOf(FinancialWorkflowError);expect((error as FinancialWorkflowError).completed).toContainEqual({id:'m1',label:'Đã lưu hồ sơ quản lý'});
 const count=m.from.mock.calls.length;await expect(config.mutationFn(input)).rejects.toMatchObject({outcome:'partial',completed:expect.arrayContaining([{id:'m1',label:expect.any(String)}])});expect(m.from).toHaveBeenCalledTimes(count);
 expect(m.success).not.toHaveBeenCalled();
});
it('không xóa tỷ lệ nếu không tải được cấu hình hiện tại',async()=>{
 m.from.mockReturnValue({select:()=>({eq:async()=>({data:null,error:{message:'denied'}})})});
 const config=useSyncShareholderBuildings() as unknown as {mutationFn:(value:unknown)=>Promise<unknown>};
 await expect(config.mutationFn({shareholder_id:'s1',rows:[]})).rejects.toEqual({message:'denied'});
 expect(m.from).toHaveBeenCalledTimes(1);
});
