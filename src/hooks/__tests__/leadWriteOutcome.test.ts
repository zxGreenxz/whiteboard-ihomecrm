// @vitest-environment jsdom
import {beforeEach,expect,it,vi} from 'vitest';
const io=vi.hoisted(()=>({from:vi.fn()}));
vi.mock('@tanstack/react-query',()=>({useMutation:(config:unknown)=>config,useQuery:(config:unknown)=>config,useQueryClient:()=>({invalidateQueries:vi.fn()})}));
vi.mock('@/integrations/supabase/client',()=>({supabase:io}));
vi.mock('@/contexts/OrganizationContext',()=>({useOrganization:()=>({selectedOrganizationId:'org-a'})}));
vi.mock('@/lib/authSession',()=>({getSessionUser:async()=>({id:'actor'})}));
vi.mock('sonner',()=>({toast:{error:vi.fn(),success:vi.fn()}}));
import {useCreateLead,useUpdateLead,useDeleteLead,useConvertLeadToDeposit,useLead} from '../useLeads';
type Mutation={mutationFn:(input:unknown)=>Promise<unknown>};
function chain(data:unknown){const writer={insert:vi.fn(),update:vi.fn(),eq:vi.fn(),is:vi.fn(),select:vi.fn(),single:vi.fn().mockResolvedValue({data,error:null}),then:(resolve:(v:unknown)=>void)=>resolve({data,error:null})};for(const m of ['insert','update','eq','is','select'] as const)writer[m].mockReturnValue(writer);return writer;}
beforeEach(()=>{vi.resetAllMocks();localStorage.clear();localStorage.setItem('ihomecrm.selectedOrganizationId','org-a');});
it('lead create needs receipt and holds across remount',async()=>{const writer=chain(null);io.from.mockReturnValue(writer);await expect((useCreateLead() as unknown as Mutation).mutationFn({customer_name:'An',phone:'0900'})).rejects.toMatchObject({outcome:'unknown'});await expect((useCreateLead() as unknown as Mutation).mutationFn({customer_name:'An',phone:'0900'})).rejects.toThrow();expect(writer.insert).toHaveBeenCalledTimes(1);});
it.each([['update',useUpdateLead,{id:'l1',customer_name:'An'}],['delete',useDeleteLead,'l1']])('lead %s cannot claim absent receipt',async(_label,hook,input)=>{io.from.mockReturnValue(chain(null));await expect((hook() as unknown as Mutation).mutationFn(input)).rejects.toMatchObject({outcome:'unknown'});});
it('conversion null lead source stops before update',async()=>{const writer=chain(null);io.from.mockReturnValue(writer);await expect((useConvertLeadToDeposit({silent:true}) as unknown as Mutation).mutationFn('l1')).rejects.toThrow();expect(writer.update).not.toHaveBeenCalled();});
it('conversion requires exact CONVERTED receipt',async()=>{const read=chain({id:'l1',status:'B1_LEAD'});const writer=chain({id:'l1',status:'B1_LEAD'});io.from.mockReturnValueOnce(read).mockReturnValue(writer);await expect((useConvertLeadToDeposit({silent:true}) as unknown as Mutation).mutationFn('l1')).rejects.toMatchObject({outcome:'unknown'});});
it('lead detail null is a source error',async()=>{io.from.mockReturnValue(chain(null));await expect((useLead('l1') as unknown as {queryFn:()=>Promise<unknown>}).queryFn()).rejects.toThrow();});
