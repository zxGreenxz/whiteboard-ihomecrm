import type {MyNotificationPreferences} from '../useNotificationSettings';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({ rpc: vi.fn(), success: vi.fn(), warning: vi.fn(), info: vi.fn(), error: vi.fn(), invalidate: vi.fn() }));
vi.mock('@tanstack/react-query', () => ({ useQuery: (v: unknown) => v, useMutation: (v: unknown) => v, useQueryClient: () => ({ invalidateQueries: m.invalidate }) }));
vi.mock('@/integrations/supabase/client', () => ({ supabase: { rpc: m.rpc, auth:{getSession:async()=>({data:{session:{user:{id:'user-a'}}},error:null})} } }));
vi.mock('@/contexts/OrganizationContext', () => ({ useOrganization: () => ({ selectedOrganizationId: 'org-a' }) }));
vi.mock('sonner', () => ({ toast: { success: m.success, warning: m.warning, info: m.info, error: m.error } }));
import { useBroadcast, useEmergencyStop } from '../useZaloChat';
import { NOTIFICATION_EVENT_KEYS, useSetMyNotificationPreferences, useSetNotificationOrgConfig, useMyNotificationPreferences, useNotificationOrgConfig } from '../useNotificationSettings';

describe('phản hồi không xác nhận kết quả chưa xảy ra', () => {
  beforeEach(() => vi.clearAllMocks());
  it('xếp hàng một phần không báo đã gửi thành công toàn bộ', () => {
    const mutation = useBroadcast() as unknown as { onSuccess: (n: number, v: { conversationIds: string[]; body: string }) => void };
    mutation.onSuccess(1, { conversationIds: ['a', 'b'], body: 'Tin thử trong mock' });
    expect(m.success).not.toHaveBeenCalled();
    expect(m.warning).toHaveBeenCalledWith(expect.stringMatching(/1\/2.*hàng đợi/), expect.anything());
  });
  it('xếp hàng đủ vẫn không khẳng định người nhận đã nhận tin', () => {
    const mutation = useBroadcast() as unknown as { onSuccess: (n: number, v: { conversationIds: string[]; body: string }) => void };
    mutation.onSuccess(2, { conversationIds: ['a', 'b'], body: 'Tin thử trong mock' });
    expect(m.success).not.toHaveBeenCalled();
    expect(m.info).toHaveBeenCalledWith(expect.stringMatching(/2\/2.*hàng đợi/));
  });
  it.each(['org', 'personal'])('lỗi đọc %s không trở thành cấu hình mặc định hợp lệ', async (kind) => {
    const failure = { code: '42501', message: 'permission denied for function private_fn' };
    m.rpc.mockResolvedValue({ data: null, error: failure });
    const query = (kind === 'org' ? useNotificationOrgConfig() : useMyNotificationPreferences('org-a')) as unknown as { queryFn: () => Promise<unknown> };
    await expect(query.queryFn()).rejects.toBe(failure);
  });
});

it.each([null, {}, 'bad', -1, 3])('không biến kết quả broadcast sai thành 0 hoặc thành công: %j',async data=>{
 m.rpc.mockResolvedValue({data,error:null});
 const config=useBroadcast() as unknown as {mutationFn:(v:unknown)=>Promise<unknown>};
 await expect(config.mutationFn({conversationIds:['a','b'],body:'mock'})).rejects.toBeTruthy();
});
it('dừng lịch có payload thiếu không được coi đã tắt mọi công tắc',async()=>{
 m.rpc.mockResolvedValue({data:{},error:null});
 const config=useEmergencyStop() as unknown as {mutationFn:()=>Promise<unknown>};
 await expect(config.mutationFn()).rejects.toBeTruthy();
});

const prefsPayload = () => ({organization_id:'org-a',user_id:'user-a',preferences:Object.fromEntries(NOTIFICATION_EVENT_KEYS.map(key=>[key,{in_app:true,push:false,cadence:'IMMEDIATE'}]))});
it.each(['org','personal'])('malformed read %s không dựng cấu hình mặc định',async kind=>{
 m.rpc.mockResolvedValue({data:null,error:null});
 const query=(kind==='org'?useNotificationOrgConfig():useMyNotificationPreferences('org-a')) as unknown as {queryFn:()=>Promise<unknown>};
 await expect(query.queryFn()).rejects.toBeTruthy();
});
it('sở thích trả sai tổ chức không được dùng cho tổ chức đang chọn',async()=>{
 m.rpc.mockResolvedValue({data:{...prefsPayload(),organization_id:'org-b'},error:null});
 const q=useMyNotificationPreferences('org-a') as unknown as {queryFn:()=>Promise<unknown>};
 await expect(q.queryFn()).rejects.toBeTruthy();
});
it.each(['org','personal'])('malformed save %s không đi đến onSuccess',async kind=>{
 m.rpc.mockResolvedValue({data:null,error:null});
 const save=(kind==='org'?useSetNotificationOrgConfig():useSetMyNotificationPreferences('org-a')) as unknown as {mutationFn:(v:unknown)=>Promise<unknown>};
 await expect(save.mutationFn(kind==='org'?{events:{},quiet_start:21,quiet_end:7}:Object.fromEntries(NOTIFICATION_EVENT_KEYS.map(key=>[key,{event_key:key,in_app:true,push:false,cadence:'IMMEDIATE'}])))).rejects.toBeTruthy();
});
it('sở thích hợp lệ trả đủ trạng thái từng công tắc',async()=>{
 m.rpc.mockResolvedValue({data:prefsPayload(),error:null});
 const q=useMyNotificationPreferences('org-a') as unknown as {queryFn:()=>Promise<MyNotificationPreferences>};
 const result=await q.queryFn();expect(result.prefs.E1.push).toBe(false);expect(result.available).toBe(true);
});
