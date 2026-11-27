// @vitest-environment jsdom
import {beforeEach,it,expect,vi} from 'vitest';
const h=vi.hoisted(()=>({rpc:vi.fn()}));
vi.mock('react',async original=>({...await original<typeof import('react')>(),useRef:(current:unknown)=>({current})}));
vi.mock('@tanstack/react-query',()=>({useQuery:(options:unknown)=>options,useQueryClient:()=>({invalidateQueries:vi.fn()})}));
vi.mock('@/lib/authSession',()=>({getSessionUser:async()=>({id:'u'})}));
vi.mock('@/integrations/supabase/client',()=>({supabase:{rpc:h.rpc}}));
import {useIeAutoApproveThreshold,useSetIeAutoApproveThreshold} from '../useIeAutoApproveThreshold';
import {FinancialWorkflowError,RepeatableWriteUnknownError} from '@/lib/financialWorkflow';
const useReadQuery=()=>(useIeAutoApproveThreshold() as unknown as {queryFn:()=>Promise<unknown>}).queryFn();
beforeEach(()=>{h.rpc.mockReset();localStorage.clear();});
it.each([undefined,'bad',''])('rejects a missing/malformed threshold %s instead of claiming automatic approval is enabled',async data=>{
 h.rpc.mockResolvedValue({data,error:null});await expect(useReadQuery()).rejects.toThrow();
});
it('keeps the exact server error code when threshold read is denied',async()=>{
 const error={code:'42501',message:'denied'};h.rpc.mockResolvedValue({data:null,error});await expect(useReadQuery()).rejects.toBe(error);
});
it.each([null,{}, {organization_id:'org',threshold:200}])('does not claim saved threshold from mismatching receipt %j',async data=>{
 h.rpc.mockResolvedValue({data,error:null});await expect(useSetIeAutoApproveThreshold()(100)).rejects.toBeInstanceOf(FinancialWorkflowError);
});
it('keeps a real null threshold as the confirmed disabled state',async()=>{
 h.rpc.mockResolvedValue({data:null,error:null});await expect(useReadQuery()).resolves.toBeNull();
 h.rpc.mockResolvedValue({data:{organization_id:'org',threshold:null},error:null});await expect(useSetIeAutoApproveThreshold()(null)).resolves.toBeUndefined();
});
// Đợt 8 (luật 5): ngưỡng đặt tuyệt đối nên không giữ dấu. Hết giờ chờ ⇒ lỗi lặp lại được; sau remount lần đặt kế tiếp được
// gửi thật (trước đợt 8: bị chặn mãi bởi dấu «chờ đối chiếu»).
it('timeout does not block the next threshold change after remount',async()=>{
 h.rpc.mockResolvedValueOnce({data:null,error:{status:504,message:'timeout'}}).mockResolvedValueOnce({data:{organization_id:'org',threshold:200},error:null});
 await expect(useSetIeAutoApproveThreshold()(100)).rejects.toBeInstanceOf(RepeatableWriteUnknownError);
 await expect(useSetIeAutoApproveThreshold()(200)).resolves.toBeUndefined();
 expect(h.rpc).toHaveBeenCalledTimes(2);
 expect(h.rpc.mock.calls.map(call=>call[1])).toEqual([{p_threshold:100},{p_threshold:200}]);
});
