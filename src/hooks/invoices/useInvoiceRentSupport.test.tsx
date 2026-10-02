// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useForm } from 'react-hook-form';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { InvoiceEntryValues } from '@/lib/invoiceEntry';
import type { InvoiceFormData } from '@/types/invoice';
import { useInvoiceRentSupport } from './useInvoiceRentSupport';

const api=vi.hoisted(()=>({plan:vi.fn(),quote:vi.fn(),read:vi.fn()}));
vi.mock('@/lib/invoiceRentSupport',async original=>({...await original<typeof import('@/lib/invoiceRentSupport')>(),readInvoiceRentSupportPlan:api.plan,quoteInvoiceRentSupport:api.quote,readSavedInvoiceSupportRequest:api.read}));
const items:InvoiceFormData['items']=[{type:'RENT',accounting_class:'REVENUE',description:'Rent',unit_price:1000000,quantity:1,coefficient:1,sort_order:0}];
afterEach(()=>{cleanup();vi.restoreAllMocks();});
beforeEach(()=>{
 api.read.mockReset().mockResolvedValue(null);
 api.plan.mockResolvedValue({revision:2,schedule:{version:2,start_billing_month:'2026-09',segments:[{month_count:3,monthly_amount:'300000'},{month_count:9,monthly_amount:'100000'}]}});
 api.quote.mockImplementation(async (_org,_contract,month)=>({state:'READY',plan_revision:2,billing_month:month,invoice_support:month==='2026-12'?'100000':'300000',quote_hash:'quote'}));
});
function open(){
 const query=new QueryClient({defaultOptions:{queries:{retry:false}}});
 return renderHook(()=>{
  const form=useForm<InvoiceEntryValues>({defaultValues:{billing_month:'2026-11',discount_amount:0,applied_credit:0}});
  return {form,support:useInvoiceRentSupport(form,{organizationId:'org1',contractId:'contract1',invoiceId:'invoice1',enabled:true,items,credit:0})};
 },{wrapper:({children})=><QueryClientProvider client={query}>{children}</QueryClientProvider>});
}
const payload=(month='2026-11'):InvoiceFormData=>({building_id:'building1',room_id:'room1',contract_id:'contract1',billing_month:month,issue_date:month+'-01',due_date:month+'-05',discount_amount:month==='2026-12'?100000:300000,prepaid_amount:0,previous_debt:0,items});

it('blocked readback preserves the old UUID after a changed ready form returns no receipt',async()=>{
 const {result}=open();await waitFor(()=>expect(result.current.support.ready).toBe(true));
 let request:string;await act(async()=>{request=(await result.current.support.prepare(payload())).context!.request_id;});
 await act(async()=>{result.current.form.setValue('billing_month','2026-12');});
 await waitFor(()=>expect(result.current.support.ready).toBe(true));
 let blocked;await act(async()=>{blocked=await result.current.support.prepare(payload('2026-12'),{readbackOnly:true});});
 expect(blocked).toEqual({context:undefined,saved:null});expect(result.current.support.hasPending).toBe(true);
 await act(async()=>{await result.current.support.prepare(payload('2026-12'),{readbackOnly:true});});
 expect(api.read.mock.calls).toEqual([['org1','contract1',request!,'invoice1'],['org1','contract1',request!,'invoice1']]);
 const receipt={id:'invoice1',invoice_number:'INV-NOV',billing_month:'2026-11'};api.read.mockResolvedValue(receipt);
 let recovered;await act(async()=>{recovered=await result.current.support.prepare(payload('2026-12'),{readbackOnly:true});});
 expect(recovered).toEqual({context:undefined,saved:receipt});expect(api.read).toHaveBeenLastCalledWith('org1','contract1',request!,'invoice1');
});
it('readbackOnly without a durable attempt never allocates a request even when ready',async()=>{
 const {result}=open();await waitFor(()=>expect(result.current.support.ready).toBe(true));
 let prepared;await act(async()=>{prepared=await result.current.support.prepare(payload(),{readbackOnly:true});});
 expect(prepared).toEqual({context:undefined,saved:null});expect(api.read).not.toHaveBeenCalled();expect(result.current.support.hasPending).toBe(false);
});
it('ordinary definitive failure can retry the unchanged payload with the same UUID',async()=>{
 const {result}=open();await waitFor(()=>expect(result.current.support.ready).toBe(true));
 let first,second;await act(async()=>{first=await result.current.support.prepare(payload());});
 await act(async()=>{second=await result.current.support.prepare(payload());});
 expect(second.context!.request_id).toBe(first.context!.request_id);expect(api.read).toHaveBeenCalledWith('org1','contract1',first.context!.request_id,'invoice1');
 await act(async()=>{result.current.form.setValue('billing_month','2026-12');});await waitFor(()=>expect(result.current.support.ready).toBe(true));
 let changed;await act(async()=>{changed=await result.current.support.prepare(payload('2026-12'));});
 expect(changed.context!.request_id).not.toBe(first.context!.request_id);
});
it('failed blocked readback keeps the durable request for the next verification',async()=>{
 const {result}=open();await waitFor(()=>expect(result.current.support.ready).toBe(true));
 let first;await act(async()=>{first=await result.current.support.prepare(payload());});
 api.read.mockRejectedValueOnce(new Error('cannot verify'));
 await act(async()=>{await expect(result.current.support.prepare(payload('2026-12'),{readbackOnly:true})).rejects.toThrow('cannot verify');});
 await act(async()=>{await result.current.support.prepare(payload('2026-12'),{readbackOnly:true});});
 expect(api.read.mock.calls).toEqual([['org1','contract1',first.context!.request_id,'invoice1'],['org1','contract1',first.context!.request_id,'invoice1']]);
});
// Review PR #116: vạch xám "đang kiểm" chỉ khi còn lượt đọc chạy. Số máy chủ lệch số trên
// màn (không còn gì chạy) thì phải hiện câu chữ, không để nút Lưu khoá mà không lời giải thích.
it('checking is only shown while a read is in flight, not for a settled mismatch',async()=>{
 let tra:()=>void=()=>{};
 api.quote.mockClear();
 api.quote.mockImplementationOnce((_org,_contract,month)=>new Promise(resolve=>{tra=()=>resolve({state:'READY',plan_revision:2,billing_month:month,invoice_support:'999',quote_hash:'quote'});}));
 const {result}=open();
 await waitFor(()=>expect(api.quote).toHaveBeenCalledOnce());
 expect(result.current.support.checking).toBe(true);
 expect(result.current.support.ready).toBe(false);
 await act(async()=>{tra();});
 await waitFor(()=>expect(result.current.support.checking).toBe(false));
 expect(result.current.support.ready).toBe(false);
 expect(result.current.support.error).toBe('Chưa xác nhận được hỗ trợ của tháng và các khoản thu; vui lòng tải lại trước khi lưu.');
});
