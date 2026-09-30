import {expect,it,vi} from 'vitest';
const m=vi.hoisted(()=>({read:vi.fn()}));
vi.mock('@tanstack/react-query',async()=>({...await vi.importActual('@tanstack/react-query'),useQuery:(v:unknown)=>v}));
vi.mock('@/integrations/supabase/client',()=>({supabase:{from:()=>({select:()=>({in:m.read})})}}));
import {useBuildingCoords} from './MyDayPage';
it('lỗi tải tọa độ nhà phải đi vào trạng thái lỗi thay vì bản đồ rỗng',async()=>{const failure={code:'42501',message:'private coordinates'};m.read.mockResolvedValue({data:null,error:failure});const q=useBuildingCoords(['b1']) as unknown as {queryFn:()=>Promise<unknown>};await expect(q.queryFn()).rejects.toBe(failure);});
