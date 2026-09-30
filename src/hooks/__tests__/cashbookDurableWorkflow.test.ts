// @vitest-environment jsdom
import {beforeEach,it,expect,vi} from 'vitest';
const h=vi.hoisted(()=>({rpc:vi.fn()}));
vi.mock('react',async original=>({...await original<typeof import('react')>(),useRef:(current:unknown)=>({current})}));
vi.mock('@tanstack/react-query',()=>({useMutation:(options:unknown)=>options,useQueryClient:()=>({invalidateQueries:vi.fn()})}));
vi.mock('@/lib/authSession',()=>({getSessionUser:async()=>({id:'u'})}));
vi.mock('@/integrations/supabase/client',()=>({supabase:{rpc:h.rpc}}));
import {useConfirmCashbookClosing,useCancelCashbookClosing,useProposeCashbookClosing} from '../useCashbookClosing';
import {useCreateHandover,useConfirmHandover,useRequestCancelHandover,useConfirmCancelHandover,useRejectCancelHandover} from '../useCashHandovers';
import {FinancialWorkflowError} from '@/lib/financialWorkflow';
const writer=(hook:unknown)=>(hook as {mutationFn:(input:unknown)=>Promise<unknown>}).mutationFn;
beforeEach(()=>{localStorage.clear();localStorage.setItem('ihomecrm.selectedOrganizationId','org-a');h.rpc.mockReset();});
it('closing confirmation timeout blocks cancel and another confirmation across remount/org change',async()=>{
 h.rpc.mockResolvedValue({data:null,error:{status:504,message:'timeout'}});
 await expect(writer(useConfirmCashbookClosing())({requestId:'r1',countedBalance:0})).rejects.toBeInstanceOf(FinancialWorkflowError);
 localStorage.setItem('ihomecrm.selectedOrganizationId','org-b');
 await expect(writer(useCancelCashbookClosing())({requestId:'r1',reason:'Kiểm tra'})).rejects.toBeInstanceOf(FinancialWorkflowError);
 await expect(writer(useConfirmCashbookClosing())({requestId:'r1',countedBalance:0})).rejects.toBeInstanceOf(FinancialWorkflowError);expect(h.rpc).toHaveBeenCalledTimes(1);
});
it.each([useRequestCancelHandover,useConfirmCancelHandover,useRejectCancelHandover])('handover timeout blocks a different lifecycle action on the same ID',async next=>{
 h.rpc.mockResolvedValue({data:null,error:{status:504,message:'timeout'}});
 await expect(writer(useConfirmHandover())({handoverId:'h1'})).rejects.toBeInstanceOf(FinancialWorkflowError);
 localStorage.setItem('ihomecrm.selectedOrganizationId','org-b');
 await expect(writer(next())({handoverId:'h1',reason:'Kiểm tra'})).rejects.toBeInstanceOf(FinancialWorkflowError);expect(h.rpc).toHaveBeenCalledTimes(1);
});
it('handover creation timeout is not bypassed by reversing voucher order or changing receiver',async()=>{
 h.rpc.mockResolvedValue({data:null,error:{status:504,message:'timeout'}});
 await expect(writer(useCreateHandover())({receiverId:'receiver',voucherIds:['v1','v2']})).rejects.toBeInstanceOf(FinancialWorkflowError);
 await expect(writer(useCreateHandover())({receiverId:'other',voucherIds:['v2','v1']})).rejects.toBeInstanceOf(FinancialWorkflowError);expect(h.rpc).toHaveBeenCalledTimes(1);
});
it.each([{request_id:'r2',closure_id:1,closed_through:'2026-09-30',status:'CONFIRMED'},{request_id:'r1',closure_id:1,closed_through:'2026-02-31',status:'CONFIRMED'}])('closing receipt must match the exact request and a real date: %j',async data=>{
 h.rpc.mockResolvedValue({data,error:null});await expect(writer(useConfirmCashbookClosing())({requestId:'r1',countedBalance:0})).rejects.toBeInstanceOf(FinancialWorkflowError);
});
it('proposal receipt must match the actual cashbook',async()=>{
 h.rpc.mockResolvedValue({data:{request_id:'r1',cashbook_id:'other',status:'PENDING'},error:null});
 await expect(writer(useProposeCashbookClosing())({cashbookId:'b1',confirmerUserId:'other',countedBalance:0})).rejects.toBeInstanceOf(FinancialWorkflowError);
});

it('a cashbook create timeout retains the exact idempotency key and blocks another create after remount',async()=>{
 h.rpc.mockResolvedValue({data:null,error:{status:504,message:'timeout'}});
 const {useCreateAccount}=await import('../useAccounts');
 const values={name:'Sổ A',initial_amount:0,initial_date:'2026-09-30'};
 await expect(writer(useCreateAccount())(values)).rejects.toBeInstanceOf(FinancialWorkflowError);
 const {financialPending}=await import('@/lib/financialPending');
 const saved=financialPending.read({namespace:'cashbook-create',userId:'u',organizationId:'actor-scope',businessKey:'new'});
 expect(h.rpc.mock.calls[0][1].p_idempotency_key).toBe(saved?.requestKey);
 localStorage.setItem('ihomecrm.selectedOrganizationId','org-b');
 await expect(writer(useCreateAccount())({...values,name:'Sổ B'})).rejects.toBeInstanceOf(FinancialWorkflowError);
 expect(h.rpc).toHaveBeenCalledTimes(1);
});
it('an unknown cashbook metadata update blocks archive on that cashbook after remount',async()=>{
 h.rpc.mockResolvedValue({data:null,error:{status:504,message:'timeout'}});
 const {useUpdateAccount,useDeleteAccount}=await import('../useAccounts');
 await expect(writer(useUpdateAccount())({id:'book1',values:{name:'Sổ A',initial_amount:0,initial_date:'2026-09-30'}})).rejects.toBeInstanceOf(FinancialWorkflowError);
 await expect(writer(useDeleteAccount())('book1')).rejects.toBeInstanceOf(FinancialWorkflowError);
 expect(h.rpc).toHaveBeenCalledTimes(1);
});
