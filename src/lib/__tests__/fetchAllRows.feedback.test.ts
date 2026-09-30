import {expect,it,vi} from 'vitest';
import {fetchAllRows} from '../supabaseFetchAll';
it('keeps original error code by default even when a later page fails',async()=>{
 const denied={code:'42501',message:'denied'};const query=vi.fn().mockResolvedValueOnce({data:[{id:'a'}],error:null}).mockResolvedValueOnce({data:null,error:denied});
 await expect(fetchAllRows(query)).rejects.toBe(denied);
});
it.each([null,undefined,{},'[]'])('does not interpret malformed page %s as an empty list',async data=>{
 await expect(fetchAllRows(async()=>({data,error:null}))).rejects.toThrow();
});
it('accepts a confirmed empty array',async()=>{expect(await fetchAllRows(async()=>({data:[],error:null}))).toEqual([]);});
