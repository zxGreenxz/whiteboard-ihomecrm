// @vitest-environment jsdom
vi.mock('@/contexts/OrganizationContext',()=>({useOrganization:()=>({selectedOrganizationId:'org1'})}));
vi.mock('@/lib/authSession',()=>({getSessionUser:async()=>({id:'user1'})}));
import {beforeEach,describe,expect,it,vi} from 'vitest';
const io=vi.hoisted(()=>({rpc:vi.fn()}));
vi.mock('@/integrations/supabase/client',()=>({supabase:{rpc:(name:string,args:unknown)=>io.rpc(name,args)}}));
vi.mock('@tanstack/react-query',()=>({useMutation:(options:unknown)=>options,useQueryClient:()=>({invalidateQueries:vi.fn()})}));
import {useProposeReconciliation} from '../useReconciliations';
const useReconciliationCall=(input:unknown={accountId:'a1',asOf:'2026-09-01',countedBalance:0})=>(useProposeReconciliation() as unknown as {mutationFn:(input:unknown)=>Promise<unknown>}).mutationFn(input);
beforeEach(()=>{vi.clearAllMocks();localStorage.clear();});
describe('biên nhận đối soát',()=>{
 it('giữ mã lỗi quyền để phân loại đúng',async()=>{const error={code:'42501',message:'permission denied'};io.rpc.mockResolvedValue({error});await expect(useReconciliationCall()).rejects.toBe(error);});
 it('phản hồi không có mã là chưa xác nhận, không chờ giả',async()=>{io.rpc.mockResolvedValue({data:{},error:null});await expect(useReconciliationCall()).rejects.toThrow('Chưa xác nhận');});
 it('giữ số dư thực 0 và trạng thái chờ',async()=>{io.rpc.mockResolvedValue({data:{id:'r1',status:'PENDING',system_balance:0,diff:0},error:null});await expect(useReconciliationCall()).resolves.toMatchObject({id:'r1',status:'PENDING',diff:0});});
});
