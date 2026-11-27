// @vitest-environment jsdom
import {beforeEach,expect,it,vi} from 'vitest';
import type {Tables} from '@/integrations/supabase/types';
const io=vi.hoisted(()=>({from:vi.fn(),rpc:vi.fn(),toastError:vi.fn(),toastSuccess:vi.fn(),invalidate:vi.fn()}));
vi.mock('@tanstack/react-query',()=>({useMutation:(config:unknown)=>config,useQuery:(config:unknown)=>config,useQueryClient:()=>({invalidateQueries:io.invalidate})}));
vi.mock('@/contexts/OrganizationContext',()=>({useOrganization:()=>({selectedOrganizationId:'org-a'})}));
vi.mock('@/integrations/supabase/client',()=>({supabase:{from:io.from,rpc:io.rpc}}));
vi.mock('@/lib/authSession',()=>({getSessionUser:async()=>({id:'actor-a'})}));
vi.mock('sonner',()=>({toast:{error:io.toastError,success:io.toastSuccess}}));
import {useUpsertBuildingServices,useBuildingServices} from '../useBuildingServices';
import {FinancialWorkflowError,RepeatableWriteUnknownError} from '@/lib/financialWorkflowError';

type ReceiptRow=Pick<Tables<'building_services'>,'id'|'building_id'|'service_id'|'is_active'|'unit_price_override'>;
type Input=Parameters<ReturnType<typeof useUpsertBuildingServices>['mutateAsync']>[0];
interface Mutation {mutationFn:(input:Input)=>Promise<unknown>;onError:(error:unknown,variables:Input)=>void;meta:{handlesFeedback:boolean}}
const input:Input={buildingId:'b1',services:[{service_id:'s1',is_active:true,unit_price_override:12}]};
const saved:ReceiptRow={id:'new',building_id:'b1',...input.services[0]};
const useMutationConfig=()=>useUpsertBuildingServices() as unknown as Mutation;
beforeEach(()=>{vi.clearAllMocks();io.rpc.mockReset();localStorage.clear();});
// Đợt 8: dịch vụ mặc định của tòa ghi lặp lại được ⇒ kết quả chưa rõ không giữ dấu, lần lưu sau chạy lại.
// Đợt 10b: «xoá rồi chèn lại» gộp vào MỘT hàm máy chủ (replace_building_services_v1) thay nguyên tử cả bộ. Trước đợt 10b
// các test ở tệp này chốt thứ tự DELETE rồi INSERT và câu «Đã gỡ danh sách dịch vụ cũ … chưa lưu được danh sách mới»; nay
// không còn trạng thái dở đó. Hàng rào giữ: biên nhận lệch không bao giờ là đã lưu; lỗi máy chủ không lộ ra màn hình.
const markerKeys=()=>Object.keys(localStorage).filter(key=>key.startsWith('ihome:financial-pending:'));
it('missing receipt is unknown (one atomic call, nothing to clean up); a retry runs again',async()=>{
 io.rpc.mockResolvedValue({data:null,error:null});const config=useMutationConfig();
 const failure=await config.mutationFn(input).catch(error=>error);
 expect(failure).toBeInstanceOf(RepeatableWriteUnknownError);expect(failure).toMatchObject({outcome:'unknown',completed:[]});
 expect((failure as Error).message).toMatch(/một lần/);expect((failure as Error).message).not.toMatch(/thiếu dịch vụ|Đã gỡ/);
 config.onError(failure,input);expect(io.rpc).toHaveBeenCalledOnce();expect(io.from).not.toHaveBeenCalled();expect(io.toastSuccess).not.toHaveBeenCalled();expect(markerKeys()).toEqual([]);
 await expect(useMutationConfig().mutationFn(input)).rejects.toMatchObject({outcome:'unknown'});expect(io.rpc).toHaveBeenCalledTimes(2);
});
it('one atomic call carries only the original four-field payload (no organization_id) and returns the saved IDs',async()=>{
 io.rpc.mockResolvedValue({data:[saved],error:null});
 await expect(useMutationConfig().mutationFn(input)).resolves.toEqual(['new']);
 expect(io.rpc).toHaveBeenCalledWith('replace_building_services_v1',{p_building_id:'b1',p_services:[{service_id:'s1',is_active:true,unit_price_override:12}]});
 expect(io.from).not.toHaveBeenCalled();
});
it('incomplete receipt is not trusted; keeps no marker, and a retry sends the whole set again',async()=>{
 io.rpc.mockResolvedValueOnce({data:[saved],error:null});
 const two:Input={...input,services:[...input.services,{service_id:'s2',is_active:false,unit_price_override:null}]};
 const failure=await useMutationConfig().mutationFn(two).catch(error=>error);
 expect(failure).toBeInstanceOf(RepeatableWriteUnknownError);expect(markerKeys()).toEqual([]);
 io.rpc.mockResolvedValueOnce({data:[saved,{id:'new-2',building_id:'b1',service_id:'s2',is_active:false,unit_price_override:null}],error:null});
 await expect(useMutationConfig().mutationFn(two)).resolves.toEqual(['new','new-2']);
 expect(io.rpc).toHaveBeenLastCalledWith('replace_building_services_v1',{p_building_id:'b1',p_services:two.services});
});
it('a refusal of the atomic call is reported plainly: no «đã gỡ … chưa lưu», no SQL detail, no marker',async()=>{
 const error={code:'23505',message:'PRIVATE SQL DETAIL'};io.rpc.mockResolvedValue({data:null,error});
 const config=useMutationConfig();const failure=await config.mutationFn(input).catch(caught=>caught);
 expect(failure).toBe(error);config.onError(failure,input);
 const shown=JSON.stringify(io.toastError.mock.calls);expect(shown).not.toContain('PRIVATE SQL DETAIL');expect(shown).not.toMatch(/Đã gỡ|thiếu dịch vụ/);expect(markerKeys()).toEqual([]);
});
it('server-worded refusal (42501 of the function) shows the server sentence',async()=>{
 io.rpc.mockResolvedValue({data:null,error:{code:'42501',message:'Chưa gỡ được dịch vụ cũ của toà: tài khoản chưa có quyền gỡ dịch vụ này. Chưa lưu thay đổi nào.'}});
 const failure=await useMutationConfig().mutationFn(input).catch(caught=>caught);
 expect(failure).toBeInstanceOf(FinancialWorkflowError);expect(failure).toMatchObject({outcome:'failure'});expect(failure).not.toBeInstanceOf(RepeatableWriteUnknownError);
 expect((failure as Error).message).toContain('Chưa lưu thay đổi nào');
});
it('the empty set is one atomic call with an empty list',async()=>{
 io.rpc.mockResolvedValue({data:[],error:null});
 await expect(useMutationConfig().mutationFn({...input,services:[]})).resolves.toEqual([]);
 expect(io.rpc).toHaveBeenCalledWith('replace_building_services_v1',{p_building_id:'b1',p_services:[]});expect(markerKeys()).toEqual([]);
});
it('original signed decimal payload is forwarded unchanged without a new client business limit',async()=>{
 const negative:Input={...input,services:[{...input.services[0],unit_price_override:-1.5}]};
 io.rpc.mockResolvedValue({data:[{...saved,unit_price_override:-1.5}],error:null});
 await expect(useMutationConfig().mutationFn(negative)).resolves.toEqual(['new']);expect(io.rpc).toHaveBeenCalledWith('replace_building_services_v1',{p_building_id:'b1',p_services:negative.services});
});
it('source read keeps the server error and never substitutes an empty list',async()=>{
 const error={code:'42501',message:'PRIVATE SQL DETAIL'};
 const chain:Record<string,unknown>={select:()=>chain,eq:()=>chain,then:(resolve:(value:unknown)=>unknown)=>Promise.resolve({data:null,error}).then(resolve)};io.from.mockReturnValue(chain);
 const query=useBuildingServices('b1') as unknown as {queryFn:()=>Promise<unknown>};await expect(query.queryFn()).rejects.toBe(error);
});

it('a form-owned silent caller keeps receipts and diagnostics without a second toast',async()=>{
 const error={code:'42501',message:'PRIVATE SQL DETAIL'};io.rpc.mockResolvedValue({data:null,error});
 const config=useUpsertBuildingServices({silent:true}) as unknown as Mutation;
 await expect(config.mutationFn(input)).rejects.toBe(error);config.onError(error,input);
 expect(io.toastError).not.toHaveBeenCalled();expect(io.toastSuccess).not.toHaveBeenCalled();expect(config.meta?.handlesFeedback).toBe(true);
});
