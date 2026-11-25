import {beforeEach,describe,expect,it,vi} from 'vitest';
const h=vi.hoisted(()=>({rpc:vi.fn(),freeVouchers:()=>{const q={select:()=>q,in:(_c:string,ids:string[])=>Promise.resolve({data:ids.map(id=>({id,handover_id:null})),error:null})};return q;}}));
vi.mock('react',async original=>({...await original<typeof import('react')>(),useRef:(value:unknown)=>({current:value})}));
vi.mock('@tanstack/react-query',()=>({useQuery:(options:unknown)=>options,useMutation:(options:unknown)=>options,useQueryClient:()=>({invalidateQueries:vi.fn()})}));
// Lập phiên đọc phiên của các phiếu trước khi gửi (đợt 4): phiếu giả đều còn trống.
vi.mock('@/integrations/supabase/client',()=>({supabase:{rpc:h.rpc,from:()=>h.freeVouchers()}}));
vi.mock('@/hooks/useAuth',()=>({useAuth:()=>({data:{id:'u'}})}));
vi.mock('@/hooks/useReceivingCashbooks',()=>({useReceivingCashbooks:()=>({data:{}})}));
vi.mock('@/contexts/OrganizationContext',()=>({useOrganization:()=>({selectedOrganizationId:'o'})}));
import {useCreateHandover,useConfirmHandover} from '../useCashHandovers';
beforeEach(()=>{h.rpc.mockReset();});
describe('handover result validation',()=>{
  it('does not accept null or create again after an unconfirmed response',async()=>{
    h.rpc.mockResolvedValue({data:null,error:null});
    const mutation=useCreateHandover() as unknown as {mutationFn:(args:unknown)=>Promise<unknown>};
    const args={receiverId:'u2',voucherIds:['v']};
    await expect(mutation.mutationFn(args)).rejects.toMatchObject({outcome:'unknown'});
    await expect(mutation.mutationFn(args)).rejects.toMatchObject({outcome:'unknown'});
    expect(h.rpc).toHaveBeenCalledTimes(1);
  });
  it('rejects a confirmation belonging to another handover',async()=>{
    h.rpc.mockResolvedValue({data:{id:'other',code:'BG2'},error:null});
    const mutation=useConfirmHandover() as unknown as {mutationFn:(args:unknown)=>Promise<unknown>};
    await expect(mutation.mutationFn({handoverId:'one',toAccountId:'b'})).rejects.toMatchObject({outcome:'unknown'});
  });
});

vi.mock('@/lib/persistentFinancialWorkflow',async()=>{const {FinancialWorkflowGuard}=await import('@/lib/financialWorkflow');return {persistentFinancialWorkflow:()=>new FinancialWorkflowGuard()};});
