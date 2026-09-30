import {beforeEach,expect,it,vi} from 'vitest';
const h=vi.hoisted(()=>({result:{data:[] as unknown,error:null as unknown},options:[] as {queryFn:()=>Promise<unknown>;enabled?:boolean}[]}));
vi.mock('@tanstack/react-query',()=>({useQuery:(options:typeof h.options[number])=>{h.options.push(options);return options;}}));
vi.mock('@/integrations/supabase/client',()=>({supabase:{from:()=>{
 const builder:Record<string,unknown>={};for(const method of ['select','eq','in','is','order','limit'])builder[method]=()=>builder;
 builder.then=(resolve:(result:unknown)=>unknown)=>Promise.resolve(h.result).then(resolve);return builder;
}}}));
import {useRoomDetailContracts,useRoomDetailTenants,useRoomDetailInvoices,useRoomDetailAssets,useBuildingDetailContracts,useBuildingDetailInvoices} from '../usePropertyDetailQueries';
const sources=[()=>useRoomDetailContracts('r'),()=>useRoomDetailTenants('r'),()=>useRoomDetailInvoices('r'),()=>useRoomDetailAssets('r'),()=>useBuildingDetailContracts('b'),()=>useBuildingDetailInvoices('b',['r'])];
beforeEach(()=>{h.result={data:[],error:null};h.options=[];});
it.each(sources.map((source,i)=>[i,source] as const))('retains source error for property tab %s',async(_i,source)=>{
 const denied={code:'42501',message:'denied'};h.result={data:null,error:denied};source();await expect(h.options[0].queryFn()).rejects.toBe(denied);
});
it.each(sources.map((source,i)=>[i,source] as const))('does not manufacture an empty property tab %s from missing response',async(_i,source)=>{
 h.result.data=null;source();await expect(h.options[0].queryFn()).rejects.toThrow();
});
it.each(sources.map((source,i)=>[i,source] as const))('allows confirmed empty property tab %s',async(_i,source)=>{
 source();await expect(h.options[0].queryFn()).resolves.toEqual([]);
});
it('does not load building invoices until the room source is known',()=>{useBuildingDetailInvoices('b',undefined);expect(h.options[0].enabled).toBe(false);});
it('a confirmed building with no rooms has no invoices without a writer/read request',async()=>{useBuildingDetailInvoices('b',[]);await expect(h.options[0].queryFn()).resolves.toEqual([]);});
