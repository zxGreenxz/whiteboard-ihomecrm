// @vitest-environment jsdom
import {beforeEach,it,expect,vi} from 'vitest';
const h=vi.hoisted(()=>({rpc:vi.fn()}));
vi.mock('react',async original=>({...await original<typeof import('react')>(),useRef:(current:unknown)=>({current})}));
vi.mock('@tanstack/react-query',()=>({useMutation:(options:unknown)=>options,useQueryClient:()=>({invalidateQueries:vi.fn()})}));
vi.mock('@/lib/authSession',()=>({getSessionUser:async()=>({id:'u'})}));
vi.mock('@/integrations/supabase/client',()=>({supabase:{rpc:h.rpc}}));
import {financialPending} from '@/lib/financialPending';
import {useLockSalaryMonth,useUnlockSalaryMonth} from '../useManagerSalary';
import {FinancialWorkflowError} from '@/lib/financialWorkflow';
beforeEach(()=>{localStorage.clear();h.rpc.mockReset();});
// Đợt 6: dấu vẫn lưu đúng mã yêu cầu TRƯỚC lệnh, và đổi tổ chức đang chọn không lách được dấu (phạm vi `actor`). Lần bấm
// sau không còn bị chặn mãi: chốt gửi lại ĐÚNG mã cũ (cách B); mở khoá phải đọc được trạng thái tháng trước (cách C), đọc
// hỏng thì giữ dấu, không gửi.
it.each(['lock','unlock']as const)('stores the exact %s request key before RPC; the next press after remount and organization change never sends a new key',async action=>{
 const namespace=action==='lock'?'salary-lock':'salary-unlock';const key=action==='lock'?'lock-owner-2026-09-01':'unlock-2026-09-01';
 const scope={namespace,userId:'u',organizationId:'actor-scope',businessKey:key};
 h.rpc.mockImplementation(async()=>({data:null,error:{status:504,message:'timeout'}}));
 const useSalaryMutation=action==='lock'?useLockSalaryMonth:useUnlockSalaryMonth;
 const useMutationHarness=()=>useSalaryMutation() as unknown as {mutationFn:(input:unknown)=>Promise<unknown>};
 const args=action==='lock'?{ownerId:'owner',periodMonth:'2026-09-01',managers:[]}:{periodMonth:'2026-09-01',staffIds:['staff']};
 await expect(useMutationHarness().mutationFn(args)).rejects.toBeInstanceOf(FinancialWorkflowError);
 const marker=financialPending.read(scope);expect(marker).not.toBeNull();expect(h.rpc.mock.calls[0][1].p_idempotency_key).toBe(marker?.requestKey);
 localStorage.setItem('ihomecrm.selectedOrganizationId','another');
 await expect(useMutationHarness().mutationFn(args)).rejects.toBeInstanceOf(FinancialWorkflowError);
 const keys=h.rpc.mock.calls.map(call=>call[1].p_idempotency_key);
 expect(new Set(keys)).toEqual(new Set([marker?.requestKey]));
 expect(keys).toHaveLength(action==='lock'?2:1);
 expect(financialPending.read(scope)?.requestKey).toBe(marker?.requestKey);
});
