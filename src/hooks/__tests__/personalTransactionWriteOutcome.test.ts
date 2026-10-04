import {expect,it,vi} from 'vitest';
import {createPersonalFinanceService} from '@/lib/personalFinance/service';
const owner='11111111-1111-4111-8111-111111111111';
const input={action:'transaction.create',data:{type:'EXPENSE',amount:100,txn_date:'2026-09-30',wallet_id:owner,category_id:owner}};
it('missing receipt ID remains unknown across replay rather than success',async()=>{
 const rpc=vi.fn().mockResolvedValue({data:null,error:null});const service=createPersonalFinanceService({rpc},owner);
 await expect(service.mutate(owner,input)).rejects.toMatchObject({outcomeUnknown:true});await expect(service.mutate(owner,input)).rejects.toMatchObject({outcomeUnknown:true});expect(rpc.mock.calls[1]).toEqual(rpc.mock.calls[0]);
});
it.each([{...input.data,amount:NaN},{...input.data,amount:0},{...input.data,txn_date:'2026-02-30'}])('invalid payload rejects before RPC: %j',async(data)=>{
 const rpc=vi.fn();await expect(createPersonalFinanceService({rpc},owner).mutate(owner,{...input,data})).rejects.toThrow();expect(rpc).not.toHaveBeenCalled();
});
it.each([null,'','  '])('read amount %j never becomes a zero balance',async amount=>{
 const rpc=vi.fn().mockResolvedValue({data:{owner_id:owner,schema_version:1,wallets:[],categories:[],transactions:[{amount}],transfers:[],budgets:[],goals:[]},error:null});
 await expect(createPersonalFinanceService({rpc},owner).snapshot()).rejects.toThrow();
});
