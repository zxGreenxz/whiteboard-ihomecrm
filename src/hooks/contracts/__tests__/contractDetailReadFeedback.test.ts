import {beforeEach,it,expect,vi} from 'vitest';
const h=vi.hoisted(()=>({responses:[] as Array<{data:unknown;error:unknown}>}));
vi.mock('@tanstack/react-query',()=>({useQuery:(options:unknown)=>options}));
vi.mock('@/integrations/supabase/client',()=>({supabase:{from:()=>{const builder:Record<string,unknown>={};for(const method of ['select','eq','in','is','not','order','limit','maybeSingle'])builder[method]=()=>builder;builder.then=(resolve:(result:unknown)=>void)=>Promise.resolve(h.responses.shift()??{data:null,error:null}).then(resolve);return builder;}}}));
vi.mock('@/hooks/useDepositDashboard',()=>({TERMINATION_REFUND_SOURCE:'termination.refund'}));
import {useContractDepositVouchers,useContractPendingTermination,useContractTerminationInfo,useContractVehicles,useContractServices,useContractHistory} from '../useContractDetailData';
const read=(hook:unknown)=>(hook as {queryFn:()=>Promise<unknown>}).queryFn();
beforeEach(()=>{h.responses=[];});
it.each([useContractDepositVouchers,useContractPendingTermination,useContractServices])('rejects a null list rather than reporting no contract data',async hook=>{h.responses=[{data:null,error:null}];await expect(read(hook('contract'))).rejects.toThrow();});
it('rejects a null vehicle list',async()=>{await expect(read(useContractVehicles('contract',['customer']))).rejects.toThrow();});
it('rejects a missing history source rather than silently omitting events',async()=>{h.responses=[{data:[],error:null},{data:null,error:null},{data:[],error:null}];await expect(read(useContractHistory('contract'))).rejects.toThrow();});
it('rejects a null refund list even when the termination record is absent',async()=>{h.responses=[{data:null,error:null},{data:null,error:null}];await expect(read(useContractTerminationInfo('contract','TERMINATED'))).rejects.toThrow();});
it('rejects an invalid posted refund amount rather than reporting 0 paid back',async()=>{h.responses=[{data:{},error:null},{data:[{id:'refund',code:'PC1',total_amount:'bad'}],error:null}];await expect(read(useContractTerminationInfo('contract','TERMINATED'))).rejects.toThrow();});
it('retains real empty lists and an absent termination record',async()=>{
 for(const hook of [useContractDepositVouchers,useContractServices,useContractPendingTermination]){h.responses=[{data:[],error:null}];expect(await read(hook('contract'))).toEqual(hook===useContractPendingTermination?{forfeit:0,refund:0}:[]);}
 h.responses=[{data:null,error:null},{data:[],error:null}];expect(await read(useContractTerminationInfo('contract','TERMINATED'))).toBeNull();
});
