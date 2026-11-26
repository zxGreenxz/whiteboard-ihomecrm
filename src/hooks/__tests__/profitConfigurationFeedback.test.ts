// @vitest-environment jsdom
import { beforeEach,it,expect,vi } from 'vitest';
const m=vi.hoisted(()=>({from:vi.fn(),success:vi.fn()}));
vi.mock('react',()=>({useRef:(value:unknown)=>({current:value})}));
vi.mock('@tanstack/react-query',()=>({useMutation:(options:unknown)=>options,useQueryClient:()=>({invalidateQueries:vi.fn()})}));
vi.mock('@/lib/authSession',()=>({getSessionUser:async()=>({id:'u'})}));
vi.mock('sonner',()=>({toast:{error:vi.fn(),success:m.success}}));
vi.mock('@/contexts/OrganizationContext',()=>({useOrganization:()=>({selectedOrganizationId:'org-a'})}));
vi.mock('@/integrations/supabase/client',()=>({supabase:{from:m.from}}));
import {useSaveManagerWithSalaries} from '../useProfitManagers';
import {useSyncShareholderBuildings} from '../useShareholders';
import {FinancialWorkflowError} from '@/lib/financialWorkflow';
beforeEach(()=>{vi.clearAllMocks();localStorage.clear();localStorage.setItem('ihomecrm.selectedOrganizationId','org-a');});
// Đợt 8: thêm quản lý tra theo tài khoản trước khi chèn (production: profit_managers duy nhất theo auth_user_id). Lần sau
// thấy hồ sơ đã tạo thì báo mã, không chèn hồ sơ thứ hai; không còn dấu chặn.
it('giữ mã quản lý sau khi xóa quy tắc thất bại; lần sau tra theo tài khoản, báo mã, không tạo lại',async()=>{
 const inserts:unknown[]=[];let existing:{id:string}|null=null;
 m.from.mockImplementation((table:string)=>table==='profit_managers'?{select:()=>({eq:()=>({is:()=>({maybeSingle:async()=>({data:existing,error:null})})})}),insert:(row:unknown)=>{inserts.push(row);return {select:()=>({single:async()=>({data:{id:'m1'},error:null})})};}}:{select:()=>({eq:async()=>({data:[],error:null})}),delete:()=>({eq:()=>({select:async()=>({error:{message:'denied'}})})})});
 const config=useSaveManagerWithSalaries() as unknown as {mutationFn:(value:unknown)=>Promise<unknown>};
 const input={values:{name:'An',auth_user_id:'u'},rules:[]};
 const error=await config.mutationFn(input).catch(e=>e);
 expect(error).toBeInstanceOf(FinancialWorkflowError);expect((error as FinancialWorkflowError).completed).toContainEqual({id:'m1',label:'Đã lưu hồ sơ quản lý'});
 existing={id:'m1'};
 await expect(config.mutationFn(input)).rejects.toMatchObject({alreadyRecorded:true,recordIds:['m1']});expect(inserts).toHaveLength(1);
 expect(m.success).not.toHaveBeenCalled();
});
it('không xóa tỷ lệ nếu không tải được cấu hình hiện tại',async()=>{
 m.from.mockReturnValue({select:()=>({eq:async()=>({data:null,error:{message:'denied'}})})});
 const config=useSyncShareholderBuildings() as unknown as {mutationFn:(value:unknown)=>Promise<unknown>};
 await expect(config.mutationFn({shareholder_id:'s1',rows:[]})).rejects.toEqual({message:'denied'});
 expect(m.from).toHaveBeenCalledTimes(1);
});
