// @vitest-environment jsdom
import {beforeEach,expect,it,vi} from 'vitest';
const io=vi.hoisted(()=>({from:vi.fn()}));
vi.mock('@tanstack/react-query',()=>({useMutation:(config:unknown)=>config,useQuery:(config:unknown)=>config,useQueryClient:()=>({invalidateQueries:vi.fn()})}));
vi.mock('@/integrations/supabase/client',()=>({supabase:{from:io.from}}));
vi.mock('@/lib/authSession',()=>({getSessionUser:async()=>({id:'actor'})}));
vi.mock('sonner',()=>({toast:{error:vi.fn(),success:vi.fn()}}));
import {useCreatePersonalTransaction,usePersonalTransactions} from '../usePersonalTransactions';
type Mutation={mutationFn:(input:unknown)=>Promise<unknown>};
const input={type:'EXPENSE',amount:100,txn_date:'2026-09-30'};
beforeEach(()=>{vi.clearAllMocks();localStorage.clear();});
it('create missing ID blocks another create after a new hook instance without needing an organization',async()=>{
 const writer={insert:vi.fn(),select:vi.fn(),single:vi.fn().mockResolvedValue({data:null,error:null})};writer.insert.mockReturnValue(writer);writer.select.mockReturnValue(writer);io.from.mockReturnValue(writer);
 await expect((useCreatePersonalTransaction() as unknown as Mutation).mutationFn(input)).rejects.toMatchObject({outcome:'unknown'});
 await expect((useCreatePersonalTransaction() as unknown as Mutation).mutationFn(input)).rejects.toMatchObject({outcome:'unknown'});expect(writer.insert).toHaveBeenCalledTimes(1);
});
it.each([{...input,amount:NaN},{...input,amount:0},{...input,txn_date:'2026-02-30'}])('invalid payload rejects before any writer: %j',async(values)=>{
 await expect((useCreatePersonalTransaction() as unknown as Mutation).mutationFn(values)).rejects.toThrow();expect(io.from).not.toHaveBeenCalled();
});
it.each([null,'', '  '])('read amount %j never becomes a zero balance',async amount=>{
 const writer={select:vi.fn(),is:vi.fn(),order:vi.fn(),then:(resolve:(v:unknown)=>void)=>resolve({data:[{amount}],error:null})};for(const method of ['select','is','order'] as const)writer[method].mockReturnValue(writer);io.from.mockReturnValue(writer);
 await expect((usePersonalTransactions() as unknown as {queryFn:()=>Promise<unknown>}).queryFn()).rejects.toThrow();
});