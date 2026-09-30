import { it,expect,vi } from 'vitest';
const m=vi.hoisted(()=>({remove:vi.fn().mockResolvedValue({error:null}),upload:vi.fn().mockResolvedValue({error:null}),single:vi.fn().mockResolvedValue({data:null,error:{message:'timeout'}})}));
vi.mock('@tanstack/react-query',()=>({useMutation:(options:unknown)=>options,useQueryClient:()=>({invalidateQueries:vi.fn()})}));
vi.mock('@/lib/authSession',()=>({getSessionUser:async()=>({id:'u'})}));
vi.mock('@/contexts/OrganizationContext',()=>({useOrganization:()=>({selectedOrganizationId:'org'})}));
vi.mock('sonner',()=>({toast:{error:vi.fn(),success:vi.fn()}}));
vi.mock('@/integrations/supabase/client',()=>({supabase:{storage:{from:()=>({upload:m.upload,getPublicUrl:()=>({data:{publicUrl:'https://example.test/template.docx'}}),remove:m.remove})},from:()=>({select:()=>({eq:()=>({order:()=>({limit:async()=>({data:[],error:null})})})}),insert:()=>({select:()=>({single:m.single})})})}}));
import { useCreateDocumentTemplate } from '../useDocumentTemplates';
it('không xóa tệp đã tải khi chưa biết server có tạo mẫu hay không',async()=>{
 const config=useCreateDocumentTemplate() as unknown as {mutationFn:(v:unknown)=>Promise<unknown>};
 await expect(config.mutationFn({name:'Mẫu A',category:'CONTRACT_NEW',is_default:false,file:{name:'a.docx',size:100,type:'application/docx'}})).rejects.toBeTruthy();
 expect(m.remove).not.toHaveBeenCalled();
});
