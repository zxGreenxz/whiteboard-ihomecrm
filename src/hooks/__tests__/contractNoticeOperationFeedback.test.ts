// @vitest-environment jsdom
import {beforeEach,expect,it,vi} from 'vitest';
const id=(n:number)=>`00000000-0000-4000-8000-${n.toString().padStart(12,'0')}`;
const h=vi.hoisted(()=>({rpc:vi.fn(),responses:[] as (()=>{data:unknown;error:unknown})[],org:'00000000-0000-4000-8000-000000000001',toast:{success:vi.fn(),error:vi.fn()},reads:[] as string[]}));
vi.mock('react',async original=>({...await original<typeof import('react')>(),useRef:(current:unknown)=>({current})}));
vi.mock('@tanstack/react-query',()=>({useMutation:(options:unknown)=>options,useQueryClient:()=>({invalidateQueries:vi.fn()})}));
vi.mock('@/contexts/OrganizationContext',()=>({useOrganization:()=>({selectedOrganizationId:h.org})}));
vi.mock('@/lib/authSession',()=>({getSessionUser:async()=>({id:'actor'})}));
vi.mock('sonner',()=>({toast:h.toast}));
vi.mock('@/integrations/supabase/client',()=>({supabase:{rpc:h.rpc,from:(table:string)=>{h.reads.push(table);const builder:Record<string,unknown>={};for(const method of ['select','eq','maybeSingle'])builder[method]=()=>builder;builder.then=(resolve:(result:unknown)=>void)=>Promise.resolve(h.responses.shift()?.()??{data:null,error:null}).then(resolve);return builder;}}}));
import {useRenewContract,useTransferRoom} from '../useContractOperations';
import {FinancialWorkflowError} from '@/lib/financialWorkflow';
import {financialPending} from '@/lib/financialPending';
const renew={contractId:id(2),expectedUpdatedAt:'2026-09-28T00:00:00Z',requestId:id(3),newEndDate:'2027-12-31',newRentPrice:100,newDeposit:200,noticeChoice:'KEEP' as const};
const transfer={contractId:id(2),expectedUpdatedAt:'2026-09-28T00:00:00Z',requestId:id(3),newRoomId:id(4),transferDate:'2026-10-01',newRentPrice:100};
const useNoticeOptions=(action:'renew'|'transfer')=>{const renewOptions=useRenewContract();const transferOptions=useTransferRoom();return (action==='renew'?renewOptions:transferOptions) as unknown as {mutationFn:(input:unknown)=>Promise<unknown>;onSuccess:(result:unknown,input:unknown)=>void;onError:(error:unknown)=>void};};
const input=(action:'renew'|'transfer')=>action==='renew'?renew:transfer;
const core=(action:'renew'|'transfer')=>({id:id(2),organization_id:id(1),contract_number:'HĐ26-009',status:'ACTIVE',end_date:'2027-12-31',rent_price:100,total_deposit:200,room_id:id(4),room:{id:id(4),name:'P203'},expected_move_out_date:action==='renew'?'2026-11-01':null});
const event=(action:'renew'|'transfer')=>({id:id(5),organization_id:id(1),contract_id:id(2),result_contract_id:id(2),request_id:h.rpc.mock.calls[0][1].p_request_id,operation:action==='renew'?'RENEW':'TRANSFER_ROOM',notice_choice:action==='renew'?'KEEP':'CANCEL',previous_notice_date:'2026-11-01',expected_updated_at:'2026-09-28T00:00:00Z'});
beforeEach(()=>{localStorage.clear();h.org=id(1);h.rpc.mockReset();h.responses=[];h.reads=[];h.toast.success.mockReset();h.toast.error.mockReset();});
it.each(['renew','transfer'] as const)('B16 %s does not succeed from a null RPC receipt',async action=>{h.rpc.mockResolvedValue({data:null,error:null});await expect(useNoticeOptions(action).mutationFn(input(action))).rejects.toBeInstanceOf(FinancialWorkflowError);});
it.each(['renew','transfer'] as const)('B16 %s retains the positive contract ID if the authoritative read fails and blocks another operation after remount',async action=>{
 h.rpc.mockResolvedValue({data:id(2),error:null});h.responses=[()=>({data:null,error:{code:'42501',message:'denied'}})];
 await expect(useNoticeOptions(action).mutationFn(input(action))).rejects.toMatchObject({outcome:'partial',completed:expect.arrayContaining([expect.objectContaining({id:id(2)})])});
 h.org=id(9);await expect(useNoticeOptions(action==='renew'?'transfer':'renew').mutationFn(input(action==='renew'?'transfer':'renew'))).rejects.toBeInstanceOf(FinancialWorkflowError);expect(h.rpc).toHaveBeenCalledTimes(1);
});
it.each(['renew','transfer'] as const)('B16 %s confirms exact core and request event, then reports the contract and actual date/room',async action=>{
 h.rpc.mockResolvedValue({data:id(2),error:null});h.responses=[()=>({data:core(action),error:null}),()=>({data:event(action),error:null})];
 const hook=useNoticeOptions(action);const result=await hook.mutationFn(input(action));expect(result).toMatchObject({contractId:id(2),contractNumber:'HĐ26-009'});hook.onSuccess(result,input(action));
 expect(h.toast.success.mock.calls[0][0]).toContain('HĐ26-009');expect(h.toast.success.mock.calls[0][0]).toContain(action==='renew'?'31/12/2027':'P203');
 expect(h.reads).toEqual(['contracts','contract_notice_transition_events']);
 expect(h.rpc.mock.calls[0][1].p_request_id).not.toBe(id(3));expect(financialPending.read({namespace:'contract-notice-transition',userId:'actor',organizationId:'actor-scope',businessKey:id(2)})).toBeNull();
});
it.each(['renew','transfer'] as const)('B16 %s cannot accept a current contract without the matching request event',async action=>{
 h.rpc.mockResolvedValue({data:id(2),error:null});h.responses=[()=>({data:core(action),error:null}),()=>({data:null,error:null})];await expect(useNoticeOptions(action).mutationFn(input(action))).rejects.toMatchObject({outcome:'partial'});
});
it.each(['renew','transfer'] as const)('B16 %s cannot accept a mismatched requested field',async action=>{
 h.rpc.mockResolvedValue({data:id(2),error:null});h.responses=[()=>({data:{...core(action),...(action==='renew'?{end_date:'2026-12-31'}:{room_id:id(7)})},error:null}),()=>({data:event(action),error:null})];await expect(useNoticeOptions(action).mutationFn(input(action))).rejects.toMatchObject({outcome:'partial'});
});
