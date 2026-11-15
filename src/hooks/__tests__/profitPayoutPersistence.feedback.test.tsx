// @vitest-environment jsdom
// Dấu chờ đối chiếu của hai lệnh chi tiền theo sổ tổng: lập phiếu chi lợi nhuận (E5, khoá theo công ty
// CỦA CỔ ĐÔNG) và lập phiếu lương điều hành (manager_salary_payout_v1, khoá theo công ty đang chọn).
import {act,cleanup,renderHook} from '@testing-library/react';
import {QueryClient,QueryClientProvider} from '@tanstack/react-query';
import type {ReactNode} from 'react';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
const m=vi.hoisted(()=>({rpc:vi.fn(),actor:'actor-a',success:vi.fn(),warning:vi.fn()}));
vi.mock('@/lib/authSession',()=>({getSessionUser:async()=>({id:m.actor})}));
vi.mock('sonner',()=>({toast:{success:m.success,info:vi.fn(),error:vi.fn(),warning:m.warning}}));
vi.mock('@/integrations/supabase/client',()=>({supabase:{rpc:m.rpc,from:()=>({select(){return this;},eq(){return this;},maybeSingle:async()=>({data:null,error:null})})}}));
import {useCreateManagerSalaryPayout} from '../income-expenses/specialized';
import {useCreateProfitLedgerPayout} from '../profit-ledger/useProfitLedgerMutations';
const wrapper=({children}:{children:ReactNode})=><QueryClientProvider client={new QueryClient({defaultOptions:{mutations:{retry:false}}})}>{children}</QueryClientProvider>;
const pending=()=>Object.keys(localStorage).filter(k=>k.startsWith('ihome:financial-pending:'));
const ledgerReceipt={voucher_id:'voucher-a',approval_request_id:'req-a',shareholder_id:'person-a',amount:500000,within_amount:500000,advance_amount:0,balance_before:900000,warnings:[],maker_kind:'OWNER',state:'PENDING_APPROVAL'};
const managerReceipt={voucher_id:'voucher-a',manager_salary_voucher_id:'voucher-a',approval_request_id:'req-a',manager_id:'person-a',state:'PENDING_APPROVAL'};
type Variant={name:string;receipt:Record<string,unknown>;useHook:()=>{mutateAsync:()=>Promise<unknown>}};
const variants:Variant[]=[
 {name:'profit-ledger',receipt:ledgerReceipt,useHook:()=>{const h=useCreateProfitLedgerPayout();return {mutateAsync:()=>h.mutateAsync({organizationId:'org-a',shareholderId:'person-a',amount:500000,accountId:'account-a',voucherDate:'2026-09-30',note:null,allowAdvance:false})};}},
 {name:'manager',receipt:managerReceipt,useHook:()=>{const h=useCreateManagerSalaryPayout();return {mutateAsync:()=>h.mutateAsync({amount:500000,account_id:'account-a',voucher_date:'2026-09-30',organizationId:'org-a',manager_id:'person-a'})};}},
];
beforeEach(()=>{vi.clearAllMocks();m.actor='actor-a';localStorage.clear();localStorage.setItem('ihomecrm.selectedOrganizationId','org-a');m.rpc.mockResolvedValue({data:null,error:null});});afterEach(cleanup);
for(const v of variants){
 describe(v.name,()=>{
  it('dấu chờ đối chiếu lưu ĐÚNG khoá gửi máy chủ trước khi ghi, xong thì nhả',async()=>{
   m.rpc.mockImplementation(async(_name,args)=>{const records=pending().map(k=>JSON.parse(localStorage.getItem(k)!));expect(records).toHaveLength(1);expect(args.p_idempotency_key).toBe(records[0].requestKey);expect(records[0]).toMatchObject({userId:'actor-a',organizationId:'org-a'});return {data:v.receipt,error:null};});
   const h=renderHook(v.useHook,{wrapper});
   await act(async()=>{await expect(h.result.current.mutateAsync()).resolves.toMatchObject({voucher_id:'voucher-a'});});
   expect(pending()).toEqual([]);
  });
  it('biên nhận hỏng ⇒ chưa rõ kết quả: dấu còn sau khi tải lại, giữ khoá',async()=>{
   const h=renderHook(v.useHook,{wrapper});
   await act(async()=>{await expect(h.result.current.mutateAsync()).rejects.toBeTruthy();});
   const key=m.rpc.mock.calls[0]![1].p_idempotency_key;h.unmount();
   expect(pending()).toHaveLength(1);
   expect(JSON.parse(localStorage.getItem(pending()[0]!)!).requestKey).toBe(key);
  });
  it('máy chủ từ chối chắc chắn ⇒ giữ mã lỗi, lần sửa sau gửi được',async()=>{
   const failure={code:'42501',message:'SQL_PRIVATE'};m.rpc.mockResolvedValueOnce({data:null,error:failure}).mockResolvedValueOnce({data:v.receipt,error:null});
   const h=renderHook(v.useHook,{wrapper});
   await act(async()=>{await expect(h.result.current.mutateAsync()).rejects.toBe(failure);await expect(h.result.current.mutateAsync()).resolves.toMatchObject({voucher_id:'voucher-a'});});
   expect(m.rpc).toHaveBeenCalledTimes(2);
   expect(m.rpc.mock.calls[0]![1].p_idempotency_key).not.toBe(m.rpc.mock.calls[1]![1].p_idempotency_key);
  });
 });
}
it('manager: biên nhận cũ (thiếu voucher_id) ⇒ không coi là thành công',async()=>{
 m.rpc.mockResolvedValue({data:{manager_salary_voucher_id:'voucher-a',approval_request_id:'req-a',manager_id:'person-a',state:'PENDING_APPROVAL'},error:null});
 const h=renderHook(variants[1]!.useHook,{wrapper});
 await act(async()=>{await expect(h.result.current.mutateAsync()).rejects.toMatchObject({outcome:'unknown'});});
});
it('manager: đổi công ty đang chọn ⇒ từ chối trước khi lưu dấu và gọi máy chủ',async()=>{
 localStorage.setItem('ihomecrm.selectedOrganizationId','org-b');
 const h=renderHook(variants[1]!.useHook,{wrapper});
 await act(async()=>{await expect(h.result.current.mutateAsync()).rejects.toMatchObject({outcome:'failure'});});
 expect(m.rpc).not.toHaveBeenCalled();expect(pending()).toEqual([]);
});
it('profit-ledger: khoá theo công ty của cổ đông, không theo công ty đang chọn',async()=>{
 localStorage.setItem('ihomecrm.selectedOrganizationId','org-b');m.rpc.mockResolvedValue({data:ledgerReceipt,error:null});
 const h=renderHook(variants[0]!.useHook,{wrapper});
 await act(async()=>{await expect(h.result.current.mutateAsync()).resolves.toMatchObject({voucher_id:'voucher-a'});});
});
it('manager: số còn lại sau phiếu (route sổ tổng chạy thật) vào câu báo',async()=>{
 m.rpc.mockResolvedValue({data:{...managerReceipt,balance_before:800000},error:null});
 const h=renderHook(variants[1]!.useHook,{wrapper});
 await act(async()=>{await expect(h.result.current.mutateAsync()).resolves.toMatchObject({balance_before:800000});});
 expect([...m.success.mock.calls,...m.warning.mock.calls].map(c=>String(c[0])).join(' ')).toMatch(/còn lại sau phiếu này: 300\.000/);
});
