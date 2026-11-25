import { describe, it, expect, vi } from 'vitest';
const state=vi.hoisted(()=>({org:'a',queries:[] as Array<{table:string;org?:string;statuses?:string[]}>}));
vi.mock('@/contexts/OrganizationContext',()=>({useOrganization:()=>({selectedOrganizationId:state.org})}));
vi.mock('@tanstack/react-query',()=>({useQuery:(options:unknown)=>options}));
vi.mock('@/integrations/supabase/client',()=>({supabase:{rpc:vi.fn(),from:(table:string)=>{
  const entry:{table:string;org?:string;statuses?:string[]}={table};
  state.queries.push(entry);
  const q={select:()=>q,order:()=>q,is:()=>q,not:()=>q,
    eq:(field:string,value:string)=>{if(field==='organization_id')entry.org=value;return q;},
    in:(field:string,values:string[])=>{if(field==='status')entry.statuses=values;return q;},
    range:async(from:number)=>{
      const fixture=table==='income_expenses'?[
        {contract_id:entry.org,code:'posted',total_amount:150,approval_status:'APPROVED',posting_status:'POSTED',active_posting_id_v2:'posting',
          income_expense_items:[{accounting_class:'DEPOSIT',amount:100},{accounting_class:'PNL',amount:50}]},
        {contract_id:entry.org,code:'awaiting',total_amount:30,approval_status:'UNAPPROVED',posting_status:'UNPOSTED',
          income_expense_items:[{accounting_class:'DEPOSIT',amount:30}]},
      ]:table==='contract_terminations'?[{id:entry.org,contract_id:entry.org,refund_amount:100,total_deposit:100,total_deductions:0}]:
        [{id:entry.org,total_deposit:100,deposit_paid:100,deposit_remaining:0}];
      return {data:from?[]:fixture,error:null};
    }};
  return q;
}}}));
import {useHeldDeposits,useDepositRefundsForfeits} from '../useDepositDashboard';
type Query<T>={queryKey:unknown[];queryFn:()=>Promise<T[]>};
describe('toàn bộ tòa trong công ty đang chọn',()=>{
  it('đổi công ty đổi khóa cache, lọc mọi nguồn, tách cọc hoàn đã chi và chờ chi',async()=>{
    for(const org of ['a','b']){
      state.org=org;state.queries.length=0;
      const held=useHeldDeposits() as unknown as Query<{contract_id:string}>;
      const refunds=useDepositRefundsForfeits() as unknown as Query<{contract_id:string}>;
      expect(held.queryKey).toContain(org);expect(refunds.queryKey).toContain(org);
      expect(await held.queryFn()).toMatchObject([{contract_id:org}]);
      expect(await refunds.queryFn()).toMatchObject([{contract_id:org,posted_refund:150,posted_deposit_refund:100,pending_deposit_refund:30}]);
      expect(new Set(state.queries.map(q=>q.table))).toEqual(new Set(['contracts','contract_terminations','income_expenses']));
      expect(state.queries.every(q=>q.org===org)).toBe(true);
      expect(state.queries[0].statuses).toContain('EXTENDED');
    }
  });
});
