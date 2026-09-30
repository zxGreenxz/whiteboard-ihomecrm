import {beforeEach,expect,it,vi} from 'vitest';
const h=vi.hoisted(()=>({data:[] as unknown,error:null as unknown}));
vi.mock('@tanstack/react-query',()=>({useQuery:(options:unknown)=>options}));
vi.mock('@/integrations/supabase/client',()=>({supabase:{from:()=>{
 const builder:Record<string,unknown>={};
 for(const method of ['select','eq','order'])builder[method]=()=>builder;
 builder.then=(resolve:(value:unknown)=>void)=>Promise.resolve({data:h.data,error:h.error}).then(resolve);
 return builder;
}}}));
import {useInvoiceItemsLite} from '../useCollectionReport';
const useReadQuery=()=>(useInvoiceItemsLite('invoice') as unknown as {queryFn:()=>Promise<unknown>}).queryFn();
beforeEach(()=>{h.data=[];h.error=null;});
it.each(['bad','',null,Infinity])('does not turn malformed item amount %s into a displayed financial zero',async amount=>{
 h.data=[{id:'item',amount,description:'Điện',type:'OTHER',accounting_class:'REVENUE'}];
 await expect(useReadQuery()).rejects.toThrow();
});
it('normalizes a confirmed numeric database amount without losing a real zero',async()=>{
 h.data=[{id:'one',amount:'1200'},{id:'two',amount:0}];
 await expect(useReadQuery()).resolves.toMatchObject([{id:'one',amount:1200},{id:'two',amount:0}]);
});
