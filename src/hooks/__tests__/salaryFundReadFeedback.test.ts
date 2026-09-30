import { beforeEach, describe, expect, it, vi } from 'vitest';
const h=vi.hoisted(()=>({responses:[] as unknown[]}));
vi.mock('@tanstack/react-query',()=>({useQuery:(options:unknown)=>options}));
vi.mock('@/hooks/useSpecialFeePrices',()=>({useSpecialFeePrices:vi.fn()}));
vi.mock('@/integrations/supabase/client',()=>({supabase:{from:()=>{
 const builder:Record<string,unknown>={}; for(const method of ['select','eq','in','not']) builder[method]=()=>builder;
 builder.then=(resolve:(value:unknown)=>void)=>Promise.resolve(h.responses.shift()).then(resolve); return builder;
}}}));
import {useSalaryPendingPayouts} from '../useSalaryFund';
beforeEach(()=>{h.responses=[];});
describe('pending salary payouts require complete data',()=>{
 it('does not turn null source into no pending salary',async()=>{
  h.responses=[{data:null,error:null}];
  const query=useSalaryPendingPayouts('2026-09-01',['staff']) as unknown as {queryFn:()=>Promise<unknown>};
  await expect(query.queryFn()).rejects.toThrow();
 });
 it('does not replace malformed voucher money with zero',async()=>{
  h.responses=[{data:[{staff_id:'staff',payout_voucher_id:'voucher'}],error:null},{data:[{id:'voucher',approval_status:'UNAPPROVED',total_amount:null,deleted_at:null}],error:null},{data:[],error:null}];
  const query=useSalaryPendingPayouts('2026-09-01',['staff']) as unknown as {queryFn:()=>Promise<unknown>};
  await expect(query.queryFn()).rejects.toThrow();
 });
});
