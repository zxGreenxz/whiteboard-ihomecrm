// @vitest-environment jsdom
import {beforeEach,expect,it,vi} from 'vitest';
const h=vi.hoisted(()=>({rpc:vi.fn()}));
vi.mock('react',async original=>({...await original<typeof import('react')>(),useRef:(current:unknown)=>({current})}));
vi.mock('@tanstack/react-query',()=>({useMutation:(o:unknown)=>o,useQuery:(o:unknown)=>o,useQueryClient:()=>({invalidateQueries:vi.fn()})}));
vi.mock('@/lib/authSession',()=>({getSessionUser:async()=>({id:'actor'})}));
vi.mock('@/integrations/supabase/client',()=>({supabase:{rpc:h.rpc}}));
import {useChangeCollectionTenderMethod,useSetPersonalCashBook,useSetBuildingReceivingCashbooks} from '../useReceivingCashbooks';
import {financialPending} from '@/lib/financialPending';
import {RepeatableWriteUnknownError} from '@/lib/financialWorkflow';
const mutation=(options:unknown)=>(options as {mutationFn:(v:unknown)=>Promise<unknown>}).mutationFn;
const input={tenderId:'tender',method:'TK' as const,accountId:'account',reason:'Chuyển hình thức theo chứng từ'};
beforeEach(()=>{h.rpc.mockReset();localStorage.clear();localStorage.setItem('ihomecrm.selectedOrganizationId','org-a');});
// Đợt 2 (24/11/2026): máy chủ trả `replayed` theo khoá nên lần sau gửi lại CÙNG mã thay vì chặn mãi.
it('keeps the same request key for a tender change after timeout across remount and organization selection',async()=>{
 h.rpc.mockResolvedValue({data:null,error:{status:504,message:'timeout'}});
 await expect(mutation(useChangeCollectionTenderMethod())(input)).rejects.toThrow();
 localStorage.setItem('ihomecrm.selectedOrganizationId','org-b');
 await expect(mutation(useChangeCollectionTenderMethod())({...input,method:'TM'})).rejects.toThrow();
 expect(h.rpc).toHaveBeenCalledTimes(2);
 const pending=financialPending.read({namespace:'collection-tender-method',userId:'actor',organizationId:'actor-scope',businessKey:'tender'});
 expect(h.rpc.mock.calls.map(call=>call[1].p_idempotency_key)).toEqual([pending?.requestKey,pending?.requestKey]);
});
it.each([{tenderId:'other',voucherId:'v',changed:true,to:{method:'TK',accountId:'account',accountName:'Q'}},{tenderId:'tender',voucherId:'',changed:true},{tenderId:'tender',voucherId:'v',changed:true,to:{method:'TM',accountId:'account',accountName:'Q'}}])('does not claim the tender changed from a mismatching receipt %j',async data=>{h.rpc.mockResolvedValue({data,error:null});await expect(mutation(useChangeCollectionTenderMethod())(input)).rejects.toThrow();});
it('accepts the exact confirmed tender and account receipt',async()=>{h.rpc.mockResolvedValue({data:{tenderId:'tender',voucherId:'v',changed:true,to:{method:'TK',accountId:'account',accountName:'Q'}},error:null});await expect(mutation(useChangeCollectionTenderMethod())(input)).resolves.toMatchObject({changed:true});});
// Đợt 8 (luật 5): hai hàm đặt sổ nhận tiền khoá công ty rồi đặt giá trị tuyệt đối (công ty suy từ thành viên / toà, không
// từ công ty đang chọn), chạy lại cho cùng kết quả. Hết giờ chờ là chưa rõ nhưng không giữ dấu: lần lưu sau, kể cả sau khi
// đổi công ty đang chọn, gửi lại bình thường.
it('a timed-out personal-book write leaves no marker; the next save (even after switching organization) is sent',async()=>{h.rpc.mockResolvedValue({data:null,error:{status:504,message:'timeout'}});await expect(mutation(useSetPersonalCashBook())({membershipId:'m',accountId:'a'})).rejects.toBeInstanceOf(RepeatableWriteUnknownError);localStorage.setItem('ihomecrm.selectedOrganizationId','org-b');await expect(mutation(useSetPersonalCashBook())({membershipId:'m',accountId:'b'})).rejects.toBeInstanceOf(RepeatableWriteUnknownError);expect(h.rpc).toHaveBeenCalledTimes(2);expect(financialPending.read({namespace:'receiving-personal',userId:'actor',organizationId:'actor-scope',businessKey:'m'})).toBeNull();});
it('a timed-out building-method write leaves no marker; the next save (even after switching organization) is sent',async()=>{h.rpc.mockResolvedValue({data:null,error:{status:504,message:'timeout'}});const v={buildingId:'building',method:'TK',defaultAccountId:'a',extraAccountIds:[]};await expect(mutation(useSetBuildingReceivingCashbooks())(v)).rejects.toBeInstanceOf(RepeatableWriteUnknownError);localStorage.setItem('ihomecrm.selectedOrganizationId','org-b');await expect(mutation(useSetBuildingReceivingCashbooks())({...v,defaultAccountId:'b'})).rejects.toBeInstanceOf(RepeatableWriteUnknownError);expect(h.rpc).toHaveBeenCalledTimes(2);expect(financialPending.read({namespace:'receiving-building',userId:'actor',organizationId:'actor-scope',businessKey:v.buildingId+v.method})).toBeNull();});
