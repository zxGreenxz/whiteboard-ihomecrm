import {beforeEach,describe,expect,it,vi} from 'vitest';
const h=vi.hoisted(()=>({rpc:vi.fn()}));
vi.mock('@/integrations/supabase/client',()=>({supabase:{rpc:h.rpc}}));
import {fetchFinanceV2ClientFlags} from '../financeV2Route';
beforeEach(()=>h.rpc.mockReset());
describe('finance route query failure',()=>{
 it('keeps an actual load failure separate from known absence of the feature',async()=>{
  const error={code:'42501',message:'denied'};h.rpc.mockResolvedValue({data:null,error});
  await expect(fetchFinanceV2ClientFlags()).rejects.toBe(error);
  h.rpc.mockResolvedValue({data:null,error:{code:'PGRST202'}});
  await expect(fetchFinanceV2ClientFlags()).resolves.toEqual(new Map());
 });
});
