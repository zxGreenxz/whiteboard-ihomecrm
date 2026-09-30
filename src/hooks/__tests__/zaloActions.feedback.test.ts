import {beforeEach,expect,it,vi} from 'vitest';
interface ZaloReadQueryMock {
 select: () => ZaloReadQueryMock; eq: () => ZaloReadQueryMock;
 maybeSingle: () => Promise<{data:unknown;error:unknown}>;
}
const m=vi.hoisted(()=>({rpc:vi.fn(),info:vi.fn(),read:vi.fn()}));
vi.mock('@tanstack/react-query',()=>({useMutation:(v:unknown)=>v,useQuery:(v:unknown)=>v,useQueryClient:()=>({invalidateQueries:vi.fn()})}));
vi.mock('@/contexts/OrganizationContext',()=>({useOrganization:()=>({organization:{id:'org-a'}})}));
vi.mock('@/integrations/supabase/client',()=>{const q:ZaloReadQueryMock={select:()=>q,eq:()=>q,maybeSingle:m.read};return {supabase:{rpc:m.rpc,from:()=>q}}});
vi.mock('sonner',()=>({toast:{info:m.info,error:vi.fn()}}));
import {mapMsg,useRequestConnect,useRecallMessage} from '../useZaloChat';
import {useLinkConversation,useUnlinkConversation} from '../chat-zalo/useZaloCrmProfile';
import { ZaloActionUnknownError } from '@/lib/zaloActionFeedback';
import {useStartChatByPhone} from '../chat-zalo/useZaloConversationActions';
beforeEach(()=>{vi.clearAllMocks();vi.useRealTimers()});
it('dấu thu hồi nội bộ không được đọc như đã thu hồi ở máy người nhận',()=>{expect(mapMsg({id:'m1',msg_type:'sys',body:'(Tin đã được thu hồi)',direction:'out'}).text).toMatch(/yêu cầu thu hồi/)});
it('biên nhận RPC thu hồi void chỉ xác nhận đã tiếp nhận yêu cầu',()=>{const c=useRecallMessage() as unknown as {onSuccess:(data:unknown,v:unknown)=>void};c.onSuccess(null,{messageId:'m1',conversationId:'c1'});expect(m.info).toHaveBeenCalledWith(expect.stringMatching(/yêu cầu thu hồi/));});
it.each([null,{}, {id:'account-b',status:'connected',organization_id:'org-a'}])('kết nối không nhận nhầm payload thiếu/sai trạng thái: %j',async data=>{m.rpc.mockResolvedValue({data,error:null});const c=useRequestConnect() as unknown as {mutationFn:(v:unknown)=>Promise<unknown>};await expect(c.mutationFn({accountId:'account-a'})).rejects.toBeTruthy();});
it.each([useLinkConversation,useUnlinkConversation])('gắn/tháo CRM phải có dòng hội thoại đã xác nhận',async hook=>{m.rpc.mockResolvedValue({data:null,error:null});const c=hook() as unknown as {mutationFn:(v:unknown)=>Promise<unknown>};await expect(c.mutationFn({conversationId:'c1',customerId:'customer-a'})).rejects.toBeTruthy();});
it('lỗi đọc job tìm số giữ ID để đọc tiếp, không coi số không dùng Zalo',async()=>{vi.useFakeTimers();m.rpc.mockResolvedValue({data:{status:'queued',job_id:'job1'},error:null});m.read.mockResolvedValue({data:null,error:{code:'42501',message:'private sql'}});const c=useStartChatByPhone() as unknown as {mutationFn:(v:unknown)=>Promise<unknown>};const pending=c.mutationFn({accountId:'account-a',phone:'0901234567'}).catch(e=>e);await vi.advanceTimersByTimeAsync(15000);const error=await pending;expect(error).toBeInstanceOf(ZaloActionUnknownError);if(!(error instanceof ZaloActionUnknownError))throw new Error('Expected unknown outcome');expect(error.jobId).toBe('job1');expect(error.message).not.toMatch(/private|worker/);vi.useRealTimers();});

it('đọc lại job theo mã chỉ đọc hàng đợi, không tạo yêu cầu tìm kiếm mới',async()=>{vi.useFakeTimers();m.read.mockResolvedValue({data:{status:'sent',result:{conversation_id:'c1'}},error:null});const c=useStartChatByPhone() as unknown as {mutationFn:(v:unknown)=>Promise<unknown>};const pending=c.mutationFn({accountId:'a',phone:'0901234567',jobId:'job1'});await vi.advanceTimersByTimeAsync(1000);await expect(pending).resolves.toBe('c1');expect(m.rpc).not.toHaveBeenCalled();vi.useRealTimers();});
