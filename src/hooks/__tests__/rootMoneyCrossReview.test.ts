// @vitest-environment jsdom
import {beforeEach,expect,it,vi} from 'vitest';
const h=vi.hoisted(()=>({rpc:vi.fn(),responses:[] as {data:unknown;error:unknown}[],writes:[] as string[]}));
vi.mock('react',async original=>({...await original<typeof import('react')>(),useRef:(current:unknown)=>({current})}));
vi.mock('@tanstack/react-query',()=>({useMutation:(options:unknown)=>options,useQueryClient:()=>({invalidateQueries:vi.fn()})}));
vi.mock('@/lib/authSession',()=>({getSessionUser:async()=>({id:'actor',email:'demo'})}));
vi.mock('@/integrations/supabase/client',()=>({supabase:{rpc:h.rpc,from:(table:string)=>{
 const builder:Record<string,unknown>={};
 for(const method of ['select','insert','update','upsert','delete','eq','neq','in','is','not','order','limit','single','maybeSingle'])builder[method]=()=>{if(['insert','update','upsert','delete'].includes(method))h.writes.push(table+':'+method);return builder;};
 builder.then=(resolve:(result:unknown)=>void)=>Promise.resolve(h.responses.shift()??{data:null,error:null}).then(resolve);return builder;
}}}));
import {useSetPersonalCashBook} from '../useReceivingCashbooks';
import {useSalaryPayout} from '../useManagerSalary';
import {FinancialWorkflowError} from '@/lib/financialWorkflow';
import {financialPending} from '@/lib/financialPending';
const mutation=(options:unknown)=>(options as {mutationFn:(input:unknown)=>Promise<unknown>}).mutationFn;
const payout={ownerId:'owner',staffId:'staff',staffName:'An',periodMonth:'2026-09-01',amount:100,account_id:'account',voucher_date:'2026-09-30'};
beforeEach(()=>{localStorage.clear();h.rpc.mockReset();h.responses=[];h.writes=[];});
it.each([{}, {id:undefined}, {id:null}, false, 0, ''])('cross-review: a malformed personal book %j is not proof that the book was removed',async personalCashBook=>{
 h.rpc.mockResolvedValue({data:{membershipId:'member',personalCashBook},error:null});
 await expect(mutation(useSetPersonalCashBook())({membershipId:'member',accountId:null})).rejects.toBeInstanceOf(FinancialWorkflowError);
 expect(financialPending.read({namespace:'receiving-personal',userId:'actor',organizationId:'actor-scope',businessKey:'member'})).not.toBeNull();
});
it.each([null,undefined,'','not-a-number'])('cross-review: unreadable remaining amount %j cannot silently remove the rent offset',async remaining_amount=>{
 h.rpc.mockResolvedValue({data:null,error:{code:'55000',message:'Writer chưa bật'}});
 h.responses=[{data:{id:'invoice',organization_id:'org',user_id:'owner',remaining_amount,total_amount:100},error:null},{data:{id:'building',organization_id:'org'},error:null},{data:[{id:'type',name:'Lương quản lý'}],error:null},{data:null,error:null}];
 await expect(mutation(useSalaryPayout())({...payout,rentInvoice:{invoiceId:'invoice',amount:50}})).rejects.toBeInstanceOf(FinancialWorkflowError);
 expect(h.writes).toEqual([]);
});
it('cross-review: blank paid amount cannot become zero before incrementing the salary payment',async()=>{
 h.rpc.mockResolvedValue({data:null,error:{code:'55000',message:'Writer chưa bật'}});
 h.responses=[{data:{id:'building',organization_id:'org'},error:null},{data:[{id:'type',name:'Lương quản lý'}],error:null},{data:{id:'voucher'},error:null},{data:null,error:null},{data:{id:'monthly'},error:null},{data:{paid:''},error:null},{data:{id:'monthly',paid:100,payout_voucher_id:'voucher'},error:null},{data:{code:'PC1',approval_status:'APPROVED',posting_status:'POSTED'},error:null}];
 await expect(mutation(useSalaryPayout())(payout)).rejects.toBeInstanceOf(FinancialWorkflowError);
 expect(h.writes).not.toContain('salary_monthly:update');
});

it.each([{approval_status:'not-a-state',posting_status:'UNPOSTED'},{approval_status:'APPROVED',posting_status:'not-a-state'}])('cross-review: malformed created salary state %j keeps the voucher identity and blocks another payout',async state=>{
 h.rpc.mockResolvedValue({data:{salary_voucher_id:'voucher'},error:null});h.responses=[{data:{code:'PC1',...state},error:null}];
 await expect(mutation(useSalaryPayout())(payout)).rejects.toMatchObject({outcome:'partial',completed:expect.arrayContaining([expect.objectContaining({id:'voucher'})])});
 await expect(mutation(useSalaryPayout())(payout)).rejects.toMatchObject({outcome:'partial'});expect(h.rpc).toHaveBeenCalledTimes(1);
});
it('cross-review: a real null personal-book receipt confirms removal',async()=>{
 h.rpc.mockResolvedValue({data:{membershipId:'member',personalCashBook:null},error:null});
 await expect(mutation(useSetPersonalCashBook())({membershipId:'member',accountId:null})).resolves.toMatchObject({personalCashBook:null});
 expect(financialPending.read({namespace:'receiving-personal',userId:'actor',organizationId:'actor-scope',businessKey:'member'})).toBeNull();
});
it('cross-review: P0001 with an unconfirmed transport response cannot release the pending marker',async()=>{
 h.rpc.mockResolvedValue({data:null,error:{code:'P0001',status:503,message:'upstream unavailable'}});
 await expect(mutation(useSetPersonalCashBook())({membershipId:'member',accountId:'a'})).rejects.toBeInstanceOf(FinancialWorkflowError);
 await expect(mutation(useSetPersonalCashBook())({membershipId:'member',accountId:'b'})).rejects.toBeInstanceOf(FinancialWorkflowError);expect(h.rpc).toHaveBeenCalledTimes(1);
});
it('cross-review: a confirmed P0001 rejection with zero successful writes permits correction',async()=>{
 const error={code:'P0001',message:'known invalid book'};h.rpc.mockResolvedValueOnce({data:null,error}).mockResolvedValueOnce({data:{membershipId:'member',personalCashBook:{id:'b',name:'Sổ B'}},error:null});
 await expect(mutation(useSetPersonalCashBook())({membershipId:'member',accountId:'a'})).rejects.toBe(error);
 await expect(mutation(useSetPersonalCashBook())({membershipId:'member',accountId:'b'})).resolves.toMatchObject({personalCashBook:{id:'b'}});expect(h.rpc).toHaveBeenCalledTimes(2);
});
