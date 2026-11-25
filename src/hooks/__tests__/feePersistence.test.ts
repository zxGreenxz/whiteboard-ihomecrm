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
import {useContractRoomDeposits} from '../useDeposits';
type Mutation={mutationFn:(input:unknown)=>Promise<unknown>};
beforeEach(()=>{vi.clearAllMocks();localStorage.clear();});
it.each([
 [usePayUtilityBill,{buildingId:'b1',type:'electric',billingMonth:'2026-09',amount:1000,code:'',holder:''}],
 [usePayPeriodFee,{buildingId:'b1',categoryKey:'wifi',periodStart:'2026-09',periodEnd:'2026-09',amount:1000}],
 [useGenerateSpecialFees,{period:'2026-09',buildingIds:['b1']}],
// Đợt 3 đổi: trước đây lần bấm sau bị chặn mãi (/đối chiếu/, không gửi). Nay ba hàm này tự đối chiếu theo cách A:
// máy chủ khoá slot rồi mới đếm phiếu/ô (production 24/11/2026) nên hook tạo mới gửi lại ngay mà không ra phiếu thứ hai.
// Lần gửi lại vẫn rớt mạng thì dấu vẫn giữ. Ba kịch bản đầy đủ ở feePendingRecovery.test.ts.
])('timeout giữ dấu; hook tạo mới gửi lại ngay (máy chủ chống trùng theo slot), dấu không chứa số tiền',async(hook,input)=>{io.rpc.mockRejectedValue(new TypeError('Failed to fetch'));await expect((hook() as unknown as Mutation).mutationFn(input)).rejects.toThrow();await expect((hook() as unknown as Mutation).mutationFn(input)).rejects.toThrow();expect(io.rpc).toHaveBeenCalledTimes(2);expect(Object.keys(localStorage).some(key=>key.startsWith('ihome:financial-pending:v1:'))).toBe(true);expect(JSON.stringify(localStorage)).not.toContain('amount');});
it.each([null,[{id:'v1',income_expense_items:[{amount:'invalid'}],total_amount:1000}]])('không biến cọc mồ côi thiếu số liệu thành zero',async data=>{io.rpc.mockResolvedValue({data,error:null});await expect((useContractRoomDeposits('r1') as unknown as {queryFn:()=>Promise<unknown>}).queryFn()).rejects.toThrow();});
