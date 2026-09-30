import {beforeEach,describe,expect,it,vi} from 'vitest';
const h=vi.hoisted(()=>({response:{data:null as unknown,error:null as unknown}}));
vi.mock('@tanstack/react-query',()=>({useQuery:(o:unknown)=>o,useMutation:(o:unknown)=>o,useQueryClient:()=>({invalidateQueries:vi.fn()})}));
vi.mock('@/lib/authSession',()=>({getSessionUser:async()=>({id:'u'})}));
vi.mock('@/contexts/OrganizationContext',()=>({useOrganization:()=>({selectedOrganizationId:'org'})}));
vi.mock('@/integrations/supabase/client',()=>({supabase:{from:()=>{const b:Record<string,unknown>={};for(const m of ['select','order','eq','insert','update','delete','single'])b[m]=()=>b;b.then=(r:(x:unknown)=>unknown)=>Promise.resolve(h.response).then(r);return b;}}}));
import {useFloors,useUpdateFloor} from '../useFloors';
import {useHotlines,useDeleteHotline} from '../useHotlines';
import {useAutoDebtConfigs,useCreateAutoDebtConfig} from '../useAutoDebtConfig';
import {useAssetWarehouses,useUpdateAssetWarehouse} from '../useAssetWarehouses';
beforeEach(()=>{h.response={data:null,error:null};});
describe('category response feedback',()=>{
 it.each([['tầng',useFloors],['hotline',useHotlines],['gạch nợ',useAutoDebtConfigs],['kho',useAssetWarehouses]] as const)('không biến phản hồi thiếu thành danh sách rỗng: %s',async(_,hook)=>{const q=hook() as unknown as {queryFn:()=>Promise<unknown>};await expect(q.queryFn()).rejects.toThrow();});
 it.each([['tầng',useUpdateFloor,{id:'a',updates:{name:'A'}}],['hotline',useDeleteHotline,'a'],['gạch nợ',useCreateAutoDebtConfig,{bank_account:'123'}],['kho',useUpdateAssetWarehouse,{id:'a',updates:{name:'A'}}]] as const)('không báo đã lưu/xóa khi thiếu kết quả: %s',async(_,hook,input)=>{const m=hook() as unknown as {mutationFn:(x:unknown)=>Promise<unknown>};await expect(m.mutationFn(input)).rejects.toThrow();});
 it('không xác nhận cập nhật tầng từ bản ghi khác',async()=>{h.response.data={id:'other'};const m=useUpdateFloor() as unknown as {mutationFn:(x:unknown)=>Promise<unknown>};await expect(m.mutationFn({id:'a',updates:{name:'A'}})).rejects.toThrow();});
});
