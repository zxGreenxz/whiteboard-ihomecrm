// @vitest-environment jsdom
import {act,cleanup,renderHook,waitFor} from '@testing-library/react';
import {QueryClient,QueryClientProvider} from '@tanstack/react-query';
import type {ReactNode} from 'react';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
const m=vi.hoisted(()=>({rpc:vi.fn(),from:vi.fn(),success:vi.fn(),warning:vi.fn()}));
vi.mock('@/integrations/supabase/client',()=>({supabase:{rpc:m.rpc,from:m.from}}));
vi.mock('@/lib/authSession',()=>({getSessionUserId:async()=> 'actor-a'}));
vi.mock('sonner',()=>({toast:{success:m.success,warning:m.warning,error:vi.fn()}}));
import {LEGACY_NOTIFICATION_EVENT_KEYS,NotificationOrgConfigConflictError,diffOrgEvents,useMyNotificationPreferences,useSetMyNotificationPreference,useNotificationOrgConfig,useSetNotificationOrgConfig,useSetMyQuietHours,useRemovePushDevice} from '../useNotificationSettings';
const events=Object.fromEntries(LEGACY_NOTIFICATION_EVENT_KEYS.map(k=>[k,{enabled:false,min_amount:0}]));
const preferences=Object.fromEntries(LEGACY_NOTIFICATION_EVENT_KEYS.map(k=>[k,{in_app:false,push:false,cadence:'OFF'}]));
const orgData={organization_id:'org-a',organization_name:'Công ty A',events,quiet_start:0,quiet_end:7,updated_at:'2026-10-21T01:00:00Z',updated_by:'actor-b'};
const prefData={organization_id:'org-a',user_id:'actor-a',preferences};
const wrapper=({children}:{children:ReactNode})=><QueryClientProvider client={new QueryClient({defaultOptions:{queries:{retry:false},mutations:{retry:false}}})}>{children}</QueryClientProvider>;
beforeEach(()=>{vi.clearAllMocks();m.rpc.mockResolvedValue({data:null,error:null});});afterEach(cleanup);
it('read preserves actual zero amount rather than replacing it with null',async()=>{m.rpc.mockResolvedValue({data:orgData,error:null});const h=renderHook(()=>useNotificationOrgConfig('org-a'),{wrapper});await waitFor(()=>expect(h.result.current.isSuccess).toBe(true));expect(h.result.current.data?.events.E1.min_amount).toBe(0);expect(h.result.current.data).toHaveProperty('organizationId','org-a');expect(m.rpc).toHaveBeenCalledWith('get_notification_org_config_v2',{p_organization_id:'org-a'});});
it('personal read verifies actual actor',async()=>{m.rpc.mockResolvedValue({data:{...prefData,user_id:'other'},error:null});const h=renderHook(()=>useMyNotificationPreferences('org-a'),{wrapper});await waitFor(()=>expect(h.result.current.isError).toBe(true));});
it('personal read: máy chủ chưa có khoá nhắc mới vẫn đọc được 7 khoá cũ; khoá mới sai hình dạng là lỗi',async()=>{
 m.rpc.mockResolvedValue({data:prefData,error:null});const h=renderHook(()=>useMyNotificationPreferences('org-a'),{wrapper});await waitFor(()=>expect(h.result.current.isSuccess).toBe(true));
 expect(h.result.current.data?.prefs.BILLING).toBeUndefined();expect(h.result.current.data?.prefs.E1.in_app).toBe(false);
 m.rpc.mockResolvedValue({data:{...prefData,preferences:{...preferences,BILLING:{in_app:'x'}}},error:null});const bad=renderHook(()=>useMyNotificationPreferences('org-b'),{wrapper});await waitFor(()=>expect(bad.result.current.isError).toBe(true));
});
it.each([{quiet_start:1},{organization_id:'org-b'},{events:{...events,E2:{enabled:false,min_amount:0}}}])('org config receipt verifies target and every submitted value %j',async patch=>{m.rpc.mockResolvedValue({data:{...orgData,...patch},error:null});const h=renderHook(()=>useSetNotificationOrgConfig('org-a'),{wrapper});await act(async()=>{await expect(h.result.current.mutateAsync({events:{E2:{enabled:true}},quietStart:0,quietEnd:7,expectedUpdatedAt:'2026-10-21T01:00:00Z'})).rejects.toBeInstanceOf(Error);});expect(m.success).not.toHaveBeenCalled();});
it('org config exact receipt reports successful actual write và chỉ gửi họ vừa đổi',async()=>{m.rpc.mockResolvedValue({data:{...orgData,events:{...events,E2:{enabled:true,min_amount:0}}},error:null});const h=renderHook(()=>useSetNotificationOrgConfig('org-a'),{wrapper});await act(async()=>{await expect(h.result.current.mutateAsync({events:{E2:{enabled:true}},quietStart:0,quietEnd:7,expectedUpdatedAt:'2026-10-21T01:00:00Z'})).resolves.toBeTruthy();});expect(m.success).toHaveBeenCalledOnce();expect(m.rpc).toHaveBeenCalledWith('set_notification_org_config_v2',{p_organization_id:'org-a',p_events:{E2:{enabled:true}},p_quiet_start:0,p_quiet_end:7,p_expected_updated_at:'2026-10-21T01:00:00Z'});});
it('PT409: báo "đã tải lại" chỉ sau khi đọc lại xong, không báo thành công',async()=>{
 m.rpc.mockImplementation(async(name:string)=>name==='set_notification_org_config_v2'?{data:null,error:{code:'PT409',message:'stale'}}:{data:{...orgData,quiet_start:22,updated_at:'2026-10-21T02:00:00Z'},error:null});
 const h=renderHook(()=>({read:useNotificationOrgConfig('org-a'),save:useSetNotificationOrgConfig('org-a')}),{wrapper});
 await waitFor(()=>expect(h.result.current.read.isSuccess).toBe(true));const reads=m.rpc.mock.calls.filter(c=>c[0]==='get_notification_org_config_v2').length;
 await act(async()=>{await expect(h.result.current.save.mutateAsync({events:{},quietStart:0,quietEnd:7,expectedUpdatedAt:'2026-10-21T01:00:00Z'})).rejects.toBeInstanceOf(NotificationOrgConfigConflictError);});
 expect(m.rpc.mock.calls.filter(c=>c[0]==='get_notification_org_config_v2').length).toBe(reads+1);
 expect(m.warning).toHaveBeenCalledWith('Cấu hình vừa được người khác sửa — đã tải lại');expect(m.success).not.toHaveBeenCalled();
 await waitFor(()=>expect(h.result.current.read.data?.quietStart).toBe(22));
});
it('diffOrgEvents chỉ giữ họ × trường khác nhau',()=>{
 const base={...events} as Parameters<typeof diffOrgEvents>[0];const draft={...base,E2:{enabled:true,min_amount:0},E3:{enabled:false,min_amount:500000}};
 expect(diffOrgEvents(base,draft)).toEqual({E2:{enabled:true},E3:{min_amount:500000}});expect(diffOrgEvents(base,base)).toEqual({});
});
it('personal write gửi ĐÚNG một khoá × một trường (không gửi lại 7 khoá từ bản nháp cũ)',async()=>{
 m.rpc.mockResolvedValue({data:{...prefData,preferences:{...preferences,E2:{in_app:false,push:true,cadence:'OFF'}}},error:null});
 const h=renderHook(()=>useSetMyNotificationPreference('org-a'),{wrapper});
 await act(async()=>{await h.result.current.mutateAsync({key:'E2',field:'push',value:true});});
 expect(m.rpc).toHaveBeenCalledTimes(1);expect(m.rpc).toHaveBeenCalledWith('set_my_notification_preferences_v1',{p_organization_id:'org-a',p_prefs:{E2:{push:true}}});
});
it.each([{user_id:'other'},{organization_id:'org-b'},{preferences:{...preferences,E1:{in_app:false,push:false,cadence:'OFF'}}}])('personal receipt verifies actor/org/changed field %j',async patch=>{m.rpc.mockResolvedValue({data:{...prefData,...patch},error:null});const h=renderHook(()=>useSetMyNotificationPreference('org-a'),{wrapper});await act(async()=>{await expect(h.result.current.mutateAsync({key:'E1',field:'in_app',value:true})).rejects.toBeInstanceOf(Error);});});
it('giờ yên: biên nhận lệch là chưa xác nhận, khớp mới báo đã lưu',async()=>{
 m.rpc.mockResolvedValueOnce({data:{enabled:true,quiet_start:21,quiet_end:7,updated_at:'2026-10-21T01:00:00Z'},error:null});
 const h=renderHook(()=>useSetMyQuietHours('org-a'),{wrapper});
 await act(async()=>{await expect(h.result.current.mutateAsync({enabled:true,quietStart:22,quietEnd:7})).rejects.toBeInstanceOf(Error);});expect(m.success).not.toHaveBeenCalled();
 m.rpc.mockResolvedValueOnce({data:{enabled:true,quiet_start:22,quiet_end:7,updated_at:'2026-10-21T01:00:00Z'},error:null});
 await act(async()=>{await h.result.current.mutateAsync({enabled:true,quietStart:22,quietEnd:7});});expect(m.success).toHaveBeenCalledWith('Đã lưu giờ yên của bạn');
});
function deleteChain(result:{data:unknown;error:unknown}){const calls:unknown[][]=[];const chain={delete:()=>chain,eq:(...a:unknown[])=>{calls.push(a);return chain;},select:async()=>result};m.from.mockReturnValue(chain);return calls;}
it('gỡ thiết bị: xoá theo id + user_id của chính mình và đọc biên nhận đúng một dòng',async()=>{
 const calls=deleteChain({data:[{id:'dev-1',user_id:'actor-a',endpoint:'https://push/1'}],error:null});
 const h=renderHook(()=>useRemovePushDevice(),{wrapper});await act(async()=>{await h.result.current.mutateAsync('dev-1');});
 expect(m.from).toHaveBeenCalledWith('push_subscriptions');expect(calls).toEqual([['id','dev-1'],['user_id','actor-a']]);expect(m.success).toHaveBeenCalledOnce();
});
it('gỡ thiết bị: không xoá được dòng nào thì không báo đã gỡ',async()=>{
 deleteChain({data:[],error:null});const h=renderHook(()=>useRemovePushDevice(),{wrapper});
 await act(async()=>{await expect(h.result.current.mutateAsync('dev-1')).rejects.toBeInstanceOf(Error);});expect(m.success).not.toHaveBeenCalled();
});
