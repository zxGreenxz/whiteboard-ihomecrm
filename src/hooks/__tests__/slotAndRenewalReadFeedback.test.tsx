// @vitest-environment jsdom
import { renderHook, cleanup, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type {ReactNode} from 'react';
const h=vi.hoisted(()=>({rpc:vi.fn(),response:{data:[] as unknown,error:null as unknown},filter:vi.fn()}));
vi.mock('@/integrations/supabase/client',()=>({supabase:{rpc:h.rpc,from:()=>({select:()=>({in:(field:string,values:string[])=>{h.filter(field,values);return {in:(field:string,values:string[])=>{h.filter(field,values);return Promise.resolve(h.response);}}}})})}}));
import {useVoucherSlotWarning} from '../useVoucherSlotWarning';
import {useRenewedContractIds} from '../useRenewedContracts';
let client:QueryClient;
beforeEach(()=>{h.rpc.mockReset();h.filter.mockReset();h.response={data:[],error:null};client=new QueryClient({defaultOptions:{queries:{retry:false,gcTime:0}}});});
afterEach(()=>{cleanup();client.clear();});
const wrapper=({children}:{children:ReactNode})=><QueryClientProvider client={client}>{children}</QueryClientProvider>;
const useSlotRead=()=>useVoucherSlotWarning({buildingId:'b1',typeIds:['t1'],start:'2026-09-01',end:'2026-09-30',type:'EXPENSE'});
it('slot read preserves server error code for the inline owner',async()=>{
 const error={code:'42501',message:'permission denied'};
 h.rpc.mockResolvedValue({data:null,error});const {result}=renderHook(useSlotRead,{wrapper});
 await waitFor(()=>expect(result.current.isError).toBe(true));expect(result.current.error).toBe(error);
});
it('missing slot rows are not a confirmed absence of matching vouchers',async()=>{
 h.rpc.mockResolvedValue({data:null,error:null});const {result}=renderHook(useSlotRead,{wrapper});
 await waitFor(()=>expect(result.current.isError).toBe(true));expect(result.current.data).toBeUndefined();
});
it.each(['total_amount','matched_amount'])('missing %s does not appear as zero money in a slot warning',async field=>{
 h.rpc.mockResolvedValue({data:[{voucher_id:'v1',code:'PC1',voucher_name:'Chi phí',total_amount:100,matched_amount:100,voucher_date:'2026-09-01',approval_status:'APPROVED',created_at:'2026-09-01T00:00:00Z',creator_name:'Kế toán',type_names:'Điện',same_amount:false,[field]:null}],error:null});
 const {result}=renderHook(useSlotRead,{wrapper});await waitFor(()=>expect(result.current.isError).toBe(true));
});
it('a successful empty slot response is allowed',async()=>{
 h.rpc.mockResolvedValue({data:[],error:null});const {result}=renderHook(useSlotRead,{wrapper});
 await waitFor(()=>expect(result.current.isSuccess).toBe(true));expect(result.current.data).toEqual([]);
});
it('missing renewal rows do not mean contracts have never been renewed',async()=>{
 h.response={data:null,error:null};const {result}=renderHook(()=>useRenewedContractIds(['c1']),{wrapper});
 await waitFor(()=>expect(result.current.isError).toBe(true));expect(result.current.data).toBeUndefined();
});
it('renewal server errors remain available to the inline owner',async()=>{
 const error={code:'42501',message:'permission denied'};h.response={data:null,error};
 const {result}=renderHook(()=>useRenewedContractIds(['c1']),{wrapper});
 await waitFor(()=>expect(result.current.isError).toBe(true));expect(result.current.error).toBe(error);
});
it('renewal query retains approved/completed predicate and recognizes a valid returned contract',async()=>{
 h.response={data:[{contract_id:'c1'}],error:null};
 const {result}=renderHook(()=>useRenewedContractIds(['c1']),{wrapper});
 await waitFor(()=>expect(result.current.isSuccess).toBe(true));
 expect(result.current.data?.has('c1')).toBe(true);
 expect(h.filter).toHaveBeenCalledWith('status',['APPROVED','COMPLETED']);
});
it('a confirmed empty renewal response remains valid',async()=>{
 const {result}=renderHook(()=>useRenewedContractIds(['c1']),{wrapper});
 await waitFor(()=>expect(result.current.isSuccess).toBe(true));expect(result.current.data?.size).toBe(0);
});
