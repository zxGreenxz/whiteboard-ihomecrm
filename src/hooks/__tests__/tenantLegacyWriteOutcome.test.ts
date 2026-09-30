// @vitest-environment jsdom
import {beforeEach,expect,it,vi} from 'vitest';
const io=vi.hoisted(()=>({from:vi.fn(),error:vi.fn()}));
vi.mock('@tanstack/react-query',()=>({useMutation:(config:unknown)=>config,useQuery:(config:unknown)=>config,useQueryClient:()=>({invalidateQueries:vi.fn()})}));
vi.mock('@/integrations/supabase/client',()=>({supabase:{from:io.from}}));
vi.mock('@/contexts/OrganizationContext',()=>({useOrganization:()=>({selectedOrganizationId:'org-a'})}));
vi.mock('@/lib/authSession',()=>({getSessionUser:async()=>({id:'actor'})}));
vi.mock('sonner',()=>({toast:{error:io.error,success:vi.fn()}}));
import {useCreateTenant} from '../useTenants';
type Mutation={mutationFn:(input:unknown)=>Promise<unknown>;onError:(error:unknown)=>void};
function chain(data:unknown){const writer={insert:vi.fn(),select:vi.fn(),single:vi.fn().mockResolvedValue({data,error:null})};writer.insert.mockReturnValue(writer);writer.select.mockReturnValue(writer);return writer;}
beforeEach(()=>{vi.clearAllMocks();localStorage.clear();localStorage.setItem('ihomecrm.selectedOrganizationId','org-a');});
it('live legacy creation needs a positive receipt and cannot repeat after remount',async()=>{const writer=chain(null);io.from.mockReturnValue(writer);const input={full_name:'An',phone:'0900'};await expect((useCreateTenant({silent:true}) as unknown as Mutation).mutationFn(input)).rejects.toMatchObject({outcome:'unknown'});await expect((useCreateTenant({silent:true}) as unknown as Mutation).mutationFn(input)).rejects.toThrow();expect(writer.insert).toHaveBeenCalledTimes(1);});
it('silent legacy creation leaves error feedback to its live caller',()=>{(useCreateTenant({silent:true}) as unknown as Mutation).onError({code:'23505',message:'raw SQL'});expect(io.error).not.toHaveBeenCalled();});
