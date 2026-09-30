// @vitest-environment jsdom
import {beforeEach,expect,it,vi,type Mock} from 'vitest';
import type {Tables,TablesInsert} from '@/integrations/supabase/types';
const io=vi.hoisted(()=>({from:vi.fn(),toastError:vi.fn(),toastSuccess:vi.fn(),invalidate:vi.fn()}));
vi.mock('@tanstack/react-query',()=>({useMutation:(config:unknown)=>config,useQuery:(config:unknown)=>config,useQueryClient:()=>({invalidateQueries:io.invalidate})}));
vi.mock('@/integrations/supabase/client',()=>({supabase:{from:io.from}}));
vi.mock('@/lib/authSession',()=>({getSessionUser:async()=>({id:'actor-a'})}));
vi.mock('sonner',()=>({toast:{error:io.toastError,success:io.toastSuccess}}));
import {useUpsertBuildingServices,useBuildingServices} from '../useBuildingServices';
import {FinancialWorkflowError} from '@/lib/financialWorkflowError';

type InsertRow=Pick<TablesInsert<'building_services'>,'building_id'|'service_id'|'is_active'|'unit_price_override'>;
type ReceiptRow=Pick<Tables<'building_services'>,'id'|'building_id'|'service_id'|'is_active'|'unit_price_override'>;
type Input=Parameters<ReturnType<typeof useUpsertBuildingServices>['mutateAsync']>[0];
interface Mutation {mutationFn:(input:Input)=>Promise<unknown>;onError:(error:unknown,variables:Input)=>void;meta:{handlesFeedback:boolean}}
interface Reply {data:unknown;error:unknown}
interface QueryMock extends PromiseLike<Reply> {
 select:Mock<(columns:string)=>QueryMock>;
 eq:Mock<(key:string,value:string)=>QueryMock>;
 insert:Mock<(rows:InsertRow[])=>QueryMock>;
 upsert:Mock<(rows:InsertRow[])=>QueryMock>;
 delete:Mock<()=>QueryMock>;
}
function chain(result:Reply):QueryMock{
 const writer:QueryMock={select:vi.fn(()=>writer),eq:vi.fn(()=>writer),insert:vi.fn(()=>writer),upsert:vi.fn(()=>writer),delete:vi.fn(()=>writer),then:(resolve,reject)=>Promise.resolve(result).then(resolve,reject)};
 return writer;
}
const input:Input={buildingId:'b1',services:[{service_id:'s1',is_active:true,unit_price_override:12}]};
const deleted={id:'old',building_id:'b1',service_id:'s0'};
const inserted:ReceiptRow={id:'new',building_id:'b1',...input.services[0]};
const useMutationConfig=()=>useUpsertBuildingServices() as unknown as Mutation;
beforeEach(()=>{vi.clearAllMocks();localStorage.clear();});
it('missing delete receipt blocks insert and does not claim old links were removed',async()=>{
 const del=chain({data:null,error:null});io.from.mockReturnValue(del);const config=useMutationConfig();
 const failure=await config.mutationFn(input).catch(error=>error);
 expect(failure).toBeInstanceOf(FinancialWorkflowError);expect(failure).toMatchObject({outcome:'unknown',completed:[]});
 config.onError(failure,input);expect(del.delete).toHaveBeenCalledOnce();expect(del.insert).not.toHaveBeenCalled();expect(io.toastSuccess).not.toHaveBeenCalled();
 await expect(useMutationConfig().mutationFn(input)).rejects.toMatchObject({outcome:'unknown'});expect(del.delete).toHaveBeenCalledOnce();
});
it('confirmed delete followed by missing insert receipt reports partial and keeps removed IDs',async()=>{
 const del=chain({data:[deleted],error:null}),write=chain({data:null,error:null});io.from.mockReturnValueOnce(del).mockReturnValue(write);
 const config=useMutationConfig();const failure=await config.mutationFn(input).catch(error=>error);
 expect(failure).toMatchObject({outcome:'partial',completed:[{id:'old',label:expect.stringMatching(/đã gỡ/i)}]});
 if(!(failure instanceof FinancialWorkflowError))throw new Error('Expected a financial workflow error');
 expect(failure.message).toMatch(/chưa xác nhận.*lưu/i);config.onError(failure,input);expect(io.toastSuccess).not.toHaveBeenCalled();
 expect(io.toastError).toHaveBeenCalledOnce();expect(io.toastError.mock.calls[0][1].description).toContain('old');
});
it('a matching old row still follows original delete-all then insert with only original payload fields',async()=>{
 const del=chain({data:[{...deleted,service_id:'s1'}],error:null}),write=chain({data:[inserted],error:null});io.from.mockReturnValueOnce(del).mockReturnValue(write);
 await expect(useMutationConfig().mutationFn(input)).resolves.toEqual(['new']);
 expect(del.delete).toHaveBeenCalledOnce();expect(del.eq).toHaveBeenCalledWith('building_id','b1');
 expect(write.insert).toHaveBeenCalledWith([{building_id:'b1',service_id:'s1',is_active:true,unit_price_override:12}]);
 expect(del.delete.mock.invocationCallOrder[0]).toBeLessThan(write.insert.mock.invocationCallOrder[0]);expect(write.upsert).not.toHaveBeenCalled();
});
it('incomplete insert preserves positive new and removed IDs before blocking a remounted retry',async()=>{
 const del=chain({data:[deleted],error:null}),write=chain({data:[inserted],error:null});io.from.mockReturnValueOnce(del).mockReturnValue(write);
 const two:Input={...input,services:[...input.services,{service_id:'s2',is_active:false,unit_price_override:null}]};
 const failure=await useMutationConfig().mutationFn(two).catch(error=>error);
 expect(failure).toMatchObject({outcome:'partial',completed:expect.arrayContaining([{id:'old',label:expect.any(String)},{id:'new',label:expect.any(String)}])});
 const records=Object.keys(localStorage).filter(key=>key.startsWith('ihome:financial-pending:')).map(key=>JSON.parse(localStorage.getItem(key)!));
 expect(records).toHaveLength(1);expect(records[0].completedIds).toEqual(['old','new']);
 await expect(useMutationConfig().mutationFn(two)).rejects.toMatchObject({outcome:'partial'});expect(del.delete).toHaveBeenCalledOnce();expect(write.insert).toHaveBeenCalledOnce();
});
it('a genuinely empty delete receipt allows the original empty-set completion without insert',async()=>{
 const del=chain({data:[],error:null});io.from.mockReturnValue(del);
 await expect(useMutationConfig().mutationFn({...input,services:[]})).resolves.toEqual([]);
 expect(del.delete).toHaveBeenCalledOnce();expect(del.insert).not.toHaveBeenCalled();expect(Object.keys(localStorage).filter(key=>key.startsWith('ihome:financial-pending:'))).toEqual([]);
});
it('original signed decimal payload is forwarded unchanged without a new client business limit',async()=>{
 const negative:Input={...input,services:[{...input.services[0],unit_price_override:-1.5}]};
 const del=chain({data:[],error:null}),write=chain({data:[{...inserted,unit_price_override:-1.5}],error:null});io.from.mockReturnValueOnce(del).mockReturnValue(write);
 await expect(useMutationConfig().mutationFn(negative)).resolves.toEqual(['new']);expect(write.insert).toHaveBeenCalledWith([{building_id:'b1',...negative.services[0]}]);
});
it('known delete refusal preserves original cause and does not perform insert',async()=>{
 const error={code:'42501',message:'PRIVATE SQL DETAIL'};const del=chain({data:null,error});io.from.mockReturnValue(del);
 const config=useMutationConfig();await expect(config.mutationFn(input)).rejects.toBe(error);config.onError(error,input);
 expect(del.insert).not.toHaveBeenCalled();expect(JSON.stringify(io.toastError.mock.calls)).not.toContain('PRIVATE SQL DETAIL');expect(Object.keys(localStorage).filter(key=>key.startsWith('ihome:financial-pending:'))).toEqual([]);
});
it('source read keeps the server error and never substitutes an empty list',async()=>{
 const error={code:'42501',message:'PRIVATE SQL DETAIL'};io.from.mockReturnValue(chain({data:null,error}));
 const query=useBuildingServices('b1') as unknown as {queryFn:()=>Promise<unknown>};await expect(query.queryFn()).rejects.toBe(error);
});

it('a form-owned silent caller keeps receipts and diagnostics without a second toast',async()=>{
 const error={code:'42501',message:'PRIVATE SQL DETAIL'};io.from.mockReturnValue(chain({data:null,error}));
 const config=useUpsertBuildingServices({silent:true}) as unknown as Mutation;
 await expect(config.mutationFn(input)).rejects.toBe(error);config.onError(error,input);
 expect(io.toastError).not.toHaveBeenCalled();expect(io.toastSuccess).not.toHaveBeenCalled();expect(config.meta?.handlesFeedback).toBe(true);
});
