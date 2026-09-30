// @vitest-environment jsdom
import {beforeEach,expect,it,vi} from 'vitest';
const io=vi.hoisted(()=>({from:vi.fn()}));
vi.mock('@tanstack/react-query',()=>({useMutation:(config:unknown)=>config,useQuery:(config:unknown)=>config,useQueryClient:()=>({invalidateQueries:vi.fn()})}));
vi.mock('@/integrations/supabase/client',()=>({supabase:io}));
vi.mock('@/lib/authSession',()=>({getSessionUser:async()=>({id:'actor'})}));
vi.mock('sonner',()=>({toast:{error:vi.fn(),success:vi.fn()}}));
import {useLeadActivities,useCreateLeadActivity,useDeleteLeadActivity} from '../useLeadActivities';
type Mutation={mutationFn:(input:unknown)=>Promise<unknown>};
function chain(data:unknown){const writer={insert:vi.fn(),delete:vi.fn(),eq:vi.fn(),select:vi.fn(),order:vi.fn(),single:vi.fn().mockResolvedValue({data,error:null}),then:(resolve:(v:unknown)=>void)=>resolve({data,error:null})};for(const m of ['insert','delete','eq','select','order'] as const)writer[m].mockReturnValue(writer);return writer;}
beforeEach(()=>{vi.resetAllMocks();localStorage.clear();localStorage.setItem('ihomecrm.selectedOrganizationId','org-a');});
it('activity list null is a source error',async()=>{io.from.mockReturnValue(chain(null));await expect((useLeadActivities('l1') as unknown as {queryFn:()=>Promise<unknown>}).queryFn()).rejects.toThrow();});
it('activity creation needs a receipt and holds across remount',async()=>{const writer=chain(null);io.from.mockReturnValue(writer);const input={lead_id:'l1',activity_type:'NOTE'};await expect((useCreateLeadActivity() as unknown as Mutation).mutationFn(input)).rejects.toMatchObject({outcome:'unknown'});await expect((useCreateLeadActivity() as unknown as Mutation).mutationFn(input)).rejects.toThrow();expect(writer.insert).toHaveBeenCalledTimes(1);});
it('activity delete needs exact receipt',async()=>{io.from.mockReturnValue(chain(null));await expect((useDeleteLeadActivity() as unknown as Mutation).mutationFn({leadId:'l1',activityId:'a1'})).rejects.toMatchObject({outcome:'unknown'});});
