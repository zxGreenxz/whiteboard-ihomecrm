// @vitest-environment jsdom
import {beforeEach,expect,it,vi} from 'vitest';
const h=vi.hoisted(()=>({rpc:vi.fn()}));
vi.mock('react',async original=>({...await original<typeof import('react')>(),useRef:(current:unknown)=>({current})}));
vi.mock('@tanstack/react-query',()=>({useMutation:(o:unknown)=>o,useQuery:(o:unknown)=>o,useQueryClient:()=>({invalidateQueries:vi.fn()})}));
vi.mock('@/lib/authSession',()=>({getSessionUser:async()=>({id:'actor'})}));
vi.mock('@/integrations/supabase/client',()=>({supabase:{rpc:h.rpc}}));
import {useChangeCollectionTenderMethod,useSetPersonalCashBook,useSetBuildingReceivingCashbooks} from '../useReceivingCashbooks';
import {financialPending} from '@/lib/financialPending';
const mutation=(options:unknown)=>(options as {mutationFn:(v:unknown)=>Promise<unknown>}).mutationFn;
const input={tenderId:'tender',method:'TK' as const,accountId:'account',reason:'Chuyển hình thức theo chứng từ'};
beforeEach(()=>{h.rpc.mockReset();localStorage.clear();localStorage.setItem('ihomecrm.selectedOrganizationId','org-a');});
it('blocks a tender change after timeout across remount and organization selection',async()=>{
 h.rpc.mockResolvedValue({data:null,error:{status:504,message:'timeout'}});
 await expect(mutation(useChangeCollectionTenderMethod())(input)).rejects.toThrow();
 localStorage.setItem('ihomecrm.selectedOrganizationId','org-b');
 await expect(mutation(useChangeCollectionTenderMethod())({...input,method:'TM'})).rejects.toThrow();
 expect(h.rpc).toHaveBeenCalledTimes(1);
 const pending=financialPending.read({namespace:'collection-tender-method',userId:'actor',organizationId:'actor-scope',businessKey:'tender'});
 expect(h.rpc.mock.calls[0][1].p_idempotency_key).toBe(pending?.requestKey);
});
it.each([{tenderId:'other',voucherId:'v',changed:true,to:{method:'TK',accountId:'account',accountName:'Q'}},{tenderId:'tender',voucherId:'',changed:true},{tenderId:'tender',voucherId:'v',changed:true,to:{method:'TM',accountId:'account',accountName:'Q'}}])('does not claim the tender changed from a mismatching receipt %j',async data=>{h.rpc.mockResolvedValue({data,error:null});await expect(mutation(useChangeCollectionTenderMethod())(input)).rejects.toThrow();});
it('accepts the exact confirmed tender and account receipt',async()=>{h.rpc.mockResolvedValue({data:{tenderId:'tender',voucherId:'v',changed:true,to:{method:'TK',accountId:'account',accountName:'Q'}},error:null});await expect(mutation(useChangeCollectionTenderMethod())(input)).resolves.toMatchObject({changed:true});});
it('cannot bypass a pending personal-book write by selecting another organization',async()=>{h.rpc.mockResolvedValue({data:null,error:{status:504,message:'timeout'}});await expect(mutation(useSetPersonalCashBook())({membershipId:'m',accountId:'a'})).rejects.toThrow();localStorage.setItem('ihomecrm.selectedOrganizationId','org-b');await expect(mutation(useSetPersonalCashBook())({membershipId:'m',accountId:'b'})).rejects.toThrow();expect(h.rpc).toHaveBeenCalledTimes(1);});
it('cannot bypass a pending building-method write by selecting another organization',async()=>{h.rpc.mockResolvedValue({data:null,error:{status:504,message:'timeout'}});const v={buildingId:'building',method:'TK',defaultAccountId:'a',extraAccountIds:[]};await expect(mutation(useSetBuildingReceivingCashbooks())(v)).rejects.toThrow();localStorage.setItem('ihomecrm.selectedOrganizationId','org-b');await expect(mutation(useSetBuildingReceivingCashbooks())({...v,defaultAccountId:'b'})).rejects.toThrow();expect(h.rpc).toHaveBeenCalledTimes(1);});
