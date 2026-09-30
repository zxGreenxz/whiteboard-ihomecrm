// @vitest-environment jsdom
import {beforeEach,expect,it,vi} from 'vitest';
const io=vi.hoisted(()=>({rpc:vi.fn(),from:vi.fn()}));
vi.mock('@tanstack/react-query',()=>({useMutation:(o:unknown)=>o,useQuery:(o:unknown)=>o,useQueryClient:()=>({invalidateQueries:vi.fn()})}));
vi.mock('@/integrations/supabase/client',()=>({supabase:io}));
vi.mock('@/lib/authSession',()=>({getSessionUser:async()=>({id:'u1'})}));
vi.mock('@/contexts/OrganizationContext',()=>({useOrganization:()=>({selectedOrganizationId:'o1'})}));
import {usePayUtilityBill} from '../useUtilityBills';
import {usePayPeriodFee} from '../usePeriodFees';
import {useGenerateSpecialFees} from '../useSpecialFeeBatch';
import {useOrphanDepositVouchers} from '../useDeposits';
type Mutation={mutationFn:(input:unknown)=>Promise<unknown>};
beforeEach(()=>{vi.clearAllMocks();localStorage.clear();});
it.each([
 [usePayUtilityBill,{buildingId:'b1',type:'electric',billingMonth:'2026-09',amount:1000,code:'',holder:''}],
 [usePayPeriodFee,{buildingId:'b1',categoryKey:'wifi',periodStart:'2026-09',periodEnd:'2026-09',amount:1000}],
 [useGenerateSpecialFees,{period:'2026-09',buildingIds:['b1']}],
])('timeout không mở quyền ghi lại phí khi hook được tạo mới',async(hook,input)=>{io.rpc.mockRejectedValue(new TypeError('Failed to fetch'));await expect((hook() as unknown as Mutation).mutationFn(input)).rejects.toThrow();await expect((hook() as unknown as Mutation).mutationFn(input)).rejects.toThrow(/đối chiếu/);expect(io.rpc).toHaveBeenCalledTimes(1);expect(JSON.stringify(localStorage)).not.toContain('amount');});
it.each([null,[{id:'v1',income_expense_items:[{amount:'invalid'}],total_amount:1000}]])('không biến cọc mồ côi thiếu số liệu thành zero',async data=>{type QueryFixture={select:()=>QueryFixture;is:()=>QueryFixture;eq:()=>QueryFixture;in:()=>QueryFixture;then:(resolve:(response:{data:unknown;error:null})=>unknown)=>Promise<unknown>};const q:QueryFixture={select:()=>q,is:()=>q,eq:()=>q,in:()=>q,then:resolve=>Promise.resolve({data,error:null}).then(resolve)};io.from.mockReturnValue(q);await expect((useOrphanDepositVouchers('r1') as unknown as {queryFn:()=>Promise<unknown>}).queryFn()).rejects.toThrow();});
