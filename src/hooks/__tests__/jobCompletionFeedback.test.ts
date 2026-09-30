import { describe,it,expect,vi,beforeEach } from 'vitest';
const rpc=vi.hoisted(()=>vi.fn());
vi.mock('@/integrations/supabase/client',()=>({supabase:{rpc,functions:{invoke:vi.fn()}}}));
vi.mock('sonner',()=>({toast:{custom:vi.fn()}}));
vi.mock('@/components/tasks/BonusToast',()=>({default:()=>null,formatBonusK:()=>''}));
import { v5TickFromJob } from '../useV5TickFromJob';
import { awardAndNotifyJobBonus } from '@/lib/salaryBonusNotify';
describe('công việc đã xong nhưng bước thưởng/ngày công chưa xác nhận',()=>{
 beforeEach(()=>rpc.mockReset());
 it('lỗi RPC fulfilled của chấm công không trở thành false khi caller cần tổng kết',async()=>{
 const error={message:'unknown rpc error'};rpc.mockResolvedValue({data:null,error});
 await expect(v5TickFromJob('job-1',{throwOnError:true})).rejects.toBe(error);
 });
 it('lỗi thưởng không trở thành danh sách rỗng',async()=>{
 const error={message:'permission denied'};rpc.mockResolvedValue({data:null,error});
 await expect(awardAndNotifyJobBonus('job-1',{throwOnError:true})).rejects.toBe(error);
 });
});
