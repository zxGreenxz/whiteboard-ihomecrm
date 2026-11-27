// @vitest-environment jsdom
import {act,cleanup,renderHook,waitFor} from '@testing-library/react';
import {QueryClient,QueryClientProvider} from '@tanstack/react-query';
import type {ReactNode} from 'react';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
const m=vi.hoisted(()=>({reply:vi.fn(),rpc:vi.fn(),from:vi.fn(),success:vi.fn(),info:vi.fn(),error:vi.fn(),org:'org-1' as string|null}));
vi.mock('@/contexts/OrganizationContext',()=>({useOrganization:()=>({selectedOrganizationId:m.org})}));
vi.mock('@/lib/authSession',()=>({getSessionUser:async()=>({id:'actor-a'})}));
vi.mock('sonner',()=>({toast:{success:m.success,info:m.info,error:m.error}}));
// Đợt 2 Sale phòng (20261125034429): cài đặt chung + quản link đi qua RPC theo công ty. Chỉ «Thống kê» còn đọc thẳng bảng link
// của chính mình (RLS) — builder giả không có update/upsert/delete nên mọi lệnh ghi thẳng bảng sẽ ném lỗi.
vi.mock('@/integrations/supabase/client',()=>({supabase:{rpc:m.rpc,from:(table:string)=>{
 m.from(table);const b={select:()=>b,eq:()=>b,gte:()=>b,order:()=>b,then:(resolve:(x:unknown)=>unknown,reject:(x:unknown)=>unknown)=>Promise.resolve().then(()=>m.reply(table)).then(resolve,reject)};return b;
}}}));
import {usePublicRoomTokens,useOwnPublicRoomTokens,useCreatePublicRoomToken,useUpdateTokenLabel,useSetTokenRevoked,useDeletePublicRoomToken} from '../usePublicRoomTokens';
import {usePublicRoomSettings,useUpsertPublicRoomSettings} from '../usePublicRoomSettings';
import {saveSettingsErrorMessage} from '@/lib/publicRoomFeedback';
const row={token:'room-a',owner_id:'actor-a',organization_id:null,label:'Sale A',revoked:false,created_at:'2026-09-30T00:00:00Z'};
// Link mới luôn mang công ty đang chọn (20261124171545).
const created={...row,organization_id:'org-1'};
// Link của công ty do người khác tạo, kèm tên người tạo (list_public_room_tokens_v1).
const listed={...created,owner_id:'actor-b',owner_name:'Chị B'};
const settings={soon_days:30,show_rented:false,hotline_id:null,sale_policy:null};
const T1='2026-11-25T01:00:00+00:00';
const hotline={id:'hot-1',name:'Hotline chung',phone_number:'0900000000',is_active:true,created_at:'2026-11-01T00:00:00+00:00'};
/** Phản hồi get/save_public_room_settings_v1: cài đặt chung của người đứng tên chung các toà (owner-b, không phải người sửa). */
const company=(over:Record<string,unknown>={})=>({organization_id:'org-1',owner_id:'owner-b',exists:true,...settings,updated_at:T1,can_manage:true,hotlines:[hotline],...over});
type SaveArgs={p_soon_days:number;p_show_rented:boolean;p_hotline_id:string|null;p_sale_policy:string|null};
/** Máy chủ lưu đúng giá trị gửi lên và trả lại dòng mới. */
const echo=(_name:string,args:SaveArgs)=>({data:company({soon_days:args.p_soon_days,show_rented:args.p_show_rented,hotline_id:args.p_hotline_id,sale_policy:args.p_sale_policy,updated_at:'2026-11-25T02:00:00+00:00',changed:true}),error:null});
const saves=()=>m.rpc.mock.calls.filter(([name])=>name==='save_public_room_settings_v1').length;
const wrapper=({children}:{children:ReactNode})=><QueryClientProvider client={new QueryClient({defaultOptions:{queries:{retry:false},mutations:{retry:false}}})}>{children}</QueryClientProvider>;
beforeEach(()=>{vi.clearAllMocks();localStorage.clear();m.org='org-1';m.reply.mockResolvedValue({data:[],error:null});m.rpc.mockResolvedValue({data:null,error:null});});afterEach(cleanup);

// Danh sách link của CÔNG TY (cần sale_phong.manage_tokens, máy chủ kiểm).
it.each([null,{},[{}],[{...listed,revoked:'false'}],[{...listed,created_at:'BAD'}],[{...listed,organization_id:'org-2'}],[row],[listed,listed],[{...listed,owner_name:1}]])('company token list rejects malformed source %j',async data=>{m.rpc.mockResolvedValue({data,error:null});const h=renderHook(usePublicRoomTokens,{wrapper});await waitFor(()=>expect(h.result.current.isError).toBe(true));expect(h.result.current.data).toBeUndefined();});
it('company token list reads by the selected company and keeps links of other members with their creator name',async()=>{m.rpc.mockResolvedValue({data:[listed,{...created,token:'room-b',owner_name:null}],error:null});const h=renderHook(usePublicRoomTokens,{wrapper});await waitFor(()=>expect(h.result.current.isSuccess).toBe(true));expect(h.result.current.data).toEqual([listed,{...created,token:'room-b',owner_name:null}]);expect(m.rpc).toHaveBeenCalledWith('list_public_room_tokens_v1',{p_organization_id:'org-1'});expect(m.from).not.toHaveBeenCalled();});
it('legitimate token empty list remains success',async()=>{m.rpc.mockResolvedValue({data:[],error:null});const h=renderHook(usePublicRoomTokens,{wrapper});await waitFor(()=>expect(h.result.current.isSuccess).toBe(true));expect(h.result.current.data).toEqual([]);});
it.each([[{enabled:false},'org-1'],[{},null]])('company token list does not read when disabled or without a company %j org=%s',async(options,org)=>{m.org=org;const h=renderHook(()=>usePublicRoomTokens(options),{wrapper});await waitFor(()=>expect(h.result.current.fetchStatus).toBe('idle'));expect(h.result.current.data).toBeUndefined();expect(m.rpc).not.toHaveBeenCalled();});
// Link của chính mình (RLS) cho «Thống kê».
it.each([null,{},[{}],[{...row,revoked:'false'}],[{...row,created_at:'BAD'}],[row,row]])('own token list rejects malformed source %j',async data=>{m.reply.mockResolvedValue({data,error:null});const h=renderHook(useOwnPublicRoomTokens,{wrapper});await waitFor(()=>expect(h.result.current.isError).toBe(true));expect(h.result.current.data).toBeUndefined();});
it('own token list reads the RLS table without the company RPC',async()=>{m.reply.mockResolvedValue({data:[row],error:null});const h=renderHook(useOwnPublicRoomTokens,{wrapper});await waitFor(()=>expect(h.result.current.isSuccess).toBe(true));expect(h.result.current.data).toEqual([row]);expect(m.from).toHaveBeenCalledWith('public_room_share_tokens');expect(m.rpc).not.toHaveBeenCalled();});

// Cài đặt chung của công ty.
it.each([null,{},company({soon_days:'30'}),company({soon_days:366}),company({show_rented:null}),company({sale_policy:'x'.repeat(2001)}),company({sale_policy:1}),company({hotline_id:''}),
 company({organization_id:'org-2'}),company({exists:'true'}),company({can_manage:undefined}),company({updated_at:5}),company({owner_id:7}),company({hotlines:null}),company({hotlines:[{...hotline,phone_number:null}]})])('settings reject malformed reply %j',async data=>{m.rpc.mockResolvedValue({data,error:null});const h=renderHook(usePublicRoomSettings,{wrapper});await waitFor(()=>expect(h.result.current.isError).toBe(true));expect(h.result.current.data).toBeUndefined();});
it('settings are read for the selected company with the CAS key, the shared owner and the owner hotlines',async()=>{m.rpc.mockResolvedValue({data:company({sale_policy:'Nước 100k'}),error:null});const h=renderHook(usePublicRoomSettings,{wrapper});await waitFor(()=>expect(h.result.current.isSuccess).toBe(true));
 expect(h.result.current.data).toEqual({settings:{...settings,sale_policy:'Nước 100k'},ownerId:'owner-b',exists:true,updatedAt:T1,canManage:true,hotlines:[hotline]});
 expect(m.rpc).toHaveBeenCalledWith('get_public_room_settings_v1',{p_organization_id:'org-1'});expect(m.from).not.toHaveBeenCalled();});
it('settings defaults apply only to confirmed missing row',async()=>{m.rpc.mockResolvedValue({data:company({exists:false,soon_days:30,show_rented:true,hotline_id:null,sale_policy:null,updated_at:null,can_manage:false,hotlines:[]}),error:null});const h=renderHook(usePublicRoomSettings,{wrapper});await waitFor(()=>expect(h.result.current.isSuccess).toBe(true));expect(h.result.current.data).toEqual({settings:{soon_days:30,show_rented:true,hotline_id:null,sale_policy:null},ownerId:'owner-b',exists:false,updatedAt:null,canManage:false,hotlines:[]});});
it('settings are not read without a selected company',async()=>{m.org=null;const h=renderHook(usePublicRoomSettings,{wrapper});await waitFor(()=>expect(h.result.current.fetchStatus).toBe('idle'));expect(h.result.current.data).toBeUndefined();expect(m.rpc).not.toHaveBeenCalled();});

it.each([null,{}, {...created,owner_id:'other'},{...created,label:'different'},{...created,organization_id:'org-2'},row])('create validates actual actor, label and organization %j',async data=>{m.rpc.mockResolvedValue({data,error:null});const h=renderHook(useCreatePublicRoomToken,{wrapper});await act(async()=>{await expect(h.result.current.mutateAsync(' Sale A ')).rejects.toBeTruthy();});expect(m.success).not.toHaveBeenCalled();});
it('create receipt exact label/actor/organization succeeds and returns actual token',async()=>{m.rpc.mockResolvedValue({data:created,error:null});const h=renderHook(useCreatePublicRoomToken,{wrapper});await act(async()=>{await expect(h.result.current.mutateAsync(' Sale A ')).resolves.toEqual(created);});expect(m.success).toHaveBeenCalledOnce();// Đợt 8: gửi nhãn ĐÃ cắt (máy chủ btrim() chỉ cắt dấu cách; nhãn có tab ở hai đầu từng làm biên nhận lệch mãi).
 expect(m.rpc).toHaveBeenCalledWith('create_public_room_token',{p_label:'Sale A',p_organization_id:'org-1'});});
it('create without a selected organization never calls the server',async()=>{m.org=null;m.rpc.mockResolvedValue({data:created,error:null});const h=renderHook(useCreatePublicRoomToken,{wrapper});await act(async()=>{await expect(h.result.current.mutateAsync('Sale A')).rejects.toMatchObject({outcome:'failure',message:expect.stringContaining('Chưa chọn công ty')});});expect(m.rpc).not.toHaveBeenCalled();expect(m.success).not.toHaveBeenCalled();});
// Đợt 8 (luật 4, 5): tạo link chưa rõ KHÔNG để dấu khoá; lần bấm sau (kể cả sau remount) tìm link vừa tạo của lần đó: thấy thì báo mã,
// không tạo thêm (trước đây: khoá mãi tới khi tự gỡ dấu).
it('create unknown does not lock; after remount the next create finds the link of the unclear attempt and does not create another',async()=>{m.rpc.mockResolvedValue({data:{...created,label:'different'},error:null});const h=renderHook(useCreatePublicRoomToken,{wrapper});await act(async()=>{await expect(h.result.current.mutateAsync('Sale A')).rejects.toMatchObject({outcome:'unknown'});});expect(Object.keys(localStorage).filter(key=>key.startsWith('ihome:financial-pending:'))).toEqual([]);h.unmount();m.reply.mockResolvedValue({data:[created],error:null});const h2=renderHook(useCreatePublicRoomToken,{wrapper});await act(async()=>{await expect(h2.result.current.mutateAsync('Sale A')).rejects.toMatchObject({outcome:'failure',message:expect.stringContaining('room-a')});});expect(m.rpc).toHaveBeenCalledOnce();expect(m.from).toHaveBeenCalledWith('public_room_share_tokens');});

// Đổi nhãn / thu hồi / khôi phục / xoá qua manage_public_room_token_v1 — kể cả link người khác tạo.
it.each([null,{...created,token:'other'},{...created,label:'old'}])('label update verifies token and patch %j',async data=>{m.rpc.mockResolvedValue({data,error:null});const h=renderHook(useUpdateTokenLabel,{wrapper});await act(async()=>{await expect(h.result.current.mutateAsync({token:'room-a',label:'New'})).rejects.toBeTruthy();});expect(m.success).not.toHaveBeenCalled();});
it('label update of a link created by another member goes through the company RPC with the trimmed label',async()=>{m.rpc.mockResolvedValue({data:{...listed,label:'New',removed:false},error:null});const h=renderHook(useUpdateTokenLabel,{wrapper});await act(async()=>{await expect(h.result.current.mutateAsync({token:'room-a',label:' New '})).resolves.toMatchObject({token:'room-a',owner_id:'actor-b',label:'New'});});
 expect(m.rpc).toHaveBeenCalledWith('manage_public_room_token_v1',{p_organization_id:'org-1',p_token:'room-a',p_action:'rename',p_label:'New'});expect(m.success).toHaveBeenCalledOnce();expect(m.from).not.toHaveBeenCalled();});
it.each([null,{...created,token:'other'},{...created,revoked:false}])('revoke verifies token and boolean %j',async data=>{m.rpc.mockResolvedValue({data,error:null});const h=renderHook(useSetTokenRevoked,{wrapper});await act(async()=>{await expect(h.result.current.mutateAsync({token:'room-a',revoked:true})).rejects.toBeTruthy();});expect(m.success).not.toHaveBeenCalled();});
it.each([[true,'revoke'],[false,'restore']] as const)('revoked=%s is sent as action %s and confirmed by the returned row',async(revoked,action)=>{m.rpc.mockResolvedValue({data:{...listed,revoked,removed:false},error:null});const h=renderHook(useSetTokenRevoked,{wrapper});await act(async()=>{await expect(h.result.current.mutateAsync({token:'room-a',revoked})).resolves.toMatchObject({token:'room-a',revoked});});
 expect(m.rpc).toHaveBeenCalledWith('manage_public_room_token_v1',{p_organization_id:'org-1',p_token:'room-a',p_action:action});expect(m.success).toHaveBeenCalledOnce();});
it.each([null,[{token:'other'}],{},{token:'other',removed:true},{token:'room-a'},{token:'room-a',removed:'false'}])('delete rejects missing or wrong receipt %j',async data=>{m.rpc.mockResolvedValue({data,error:null});const h=renderHook(useDeletePublicRoomToken,{wrapper});await act(async()=>{await expect(h.result.current.mutateAsync('room-a')).rejects.toBeTruthy();});expect(m.success).not.toHaveBeenCalled();});
it('verified delete zero rows describes no change',async()=>{m.rpc.mockResolvedValue({data:{token:'room-a',removed:false},error:null});const h=renderHook(useDeletePublicRoomToken,{wrapper});await act(async()=>{await expect(h.result.current.mutateAsync('room-a')).resolves.toMatchObject({token:'room-a',removed:0});});expect(m.success).not.toHaveBeenCalled();expect(m.info).toHaveBeenCalledOnce();});
it('verified delete of a company link removes it',async()=>{m.rpc.mockResolvedValue({data:{...listed,removed:true},error:null});const h=renderHook(useDeletePublicRoomToken,{wrapper});await act(async()=>{await expect(h.result.current.mutateAsync('room-a')).resolves.toEqual({token:'room-a',removed:1});});
 expect(m.rpc).toHaveBeenCalledWith('manage_public_room_token_v1',{p_organization_id:'org-1',p_token:'room-a',p_action:'delete'});expect(m.success).toHaveBeenCalledOnce();expect(m.info).not.toHaveBeenCalled();});
it('link admin without a selected company never calls the server',async()=>{m.org=null;const h=renderHook(useSetTokenRevoked,{wrapper});await act(async()=>{await expect(h.result.current.mutateAsync({token:'room-a',revoked:true})).rejects.toMatchObject({outcome:'failure',message:expect.stringContaining('Chưa chọn công ty')});});expect(m.rpc).not.toHaveBeenCalled();});

// Lưu cài đặt chung: theo công ty, CAS bằng updated_at của bản đã đọc; biên nhận phải lặp lại đúng giá trị đã gửi.
it.each([null,company({organization_id:'org-2'}),company({exists:false}),company({soon_days:25}),company({show_rented:true}),company({hotline_id:'hot-1'}),company({sale_policy:'khác'}),company({hotlines:'none'})])('settings require the selected company and exact values %j',async data=>{m.rpc.mockResolvedValue({data,error:null});const h=renderHook(useUpsertPublicRoomSettings,{wrapper});await act(async()=>{await expect(h.result.current.mutateAsync({...settings,expectedUpdatedAt:T1})).rejects.toBeTruthy();});expect(m.success).not.toHaveBeenCalled();});
it('settings save sends the CAS key and trimmed policy for the selected company; a member who is not the owner may save',async()=>{m.rpc.mockImplementation(echo);const h=renderHook(useUpsertPublicRoomSettings,{wrapper});
 await act(async()=>{await expect(h.result.current.mutateAsync({...settings,sale_policy:'  Nước 100k  ',expectedUpdatedAt:T1})).resolves.toMatchObject({ownerId:'owner-b',settings:{...settings,sale_policy:'Nước 100k'}});});
 expect(m.rpc).toHaveBeenCalledWith('save_public_room_settings_v1',{p_organization_id:'org-1',p_expected_updated_at:T1,p_soon_days:30,p_show_rented:false,p_hotline_id:null,p_sale_policy:'Nước 100k'});
 expect(m.success).toHaveBeenCalledOnce();expect(m.from).not.toHaveBeenCalled();});
it('first save of a company without a settings row sends a null CAS key',async()=>{m.rpc.mockImplementation(echo);const h=renderHook(useUpsertPublicRoomSettings,{wrapper});await act(async()=>{await expect(h.result.current.mutateAsync({...settings,expectedUpdatedAt:null})).resolves.toMatchObject({exists:true});});expect(m.rpc).toHaveBeenCalledWith('save_public_room_settings_v1',expect.objectContaining({p_expected_updated_at:null}));});
it('settings save without a selected company never calls the server',async()=>{m.org=null;const h=renderHook(useUpsertPublicRoomSettings,{wrapper});await act(async()=>{await expect(h.result.current.mutateAsync({...settings,expectedUpdatedAt:T1})).rejects.toMatchObject({outcome:'failure',message:expect.stringContaining('Chưa chọn công ty')});});expect(m.rpc).not.toHaveBeenCalled();});
it('PT409 (someone else saved first) is a confirmed rejection with the reload advice, not an unconfirmed save',async()=>{const failure={code:'PT409',message:'public_room_settings_conflict',hint:'SQL_PRIVATE_DIAGNOSTIC'};m.rpc.mockResolvedValue({data:null,error:failure});const h=renderHook(useUpsertPublicRoomSettings,{wrapper});
 await act(async()=>{await expect(h.result.current.mutateAsync({...settings,expectedUpdatedAt:T1})).rejects.toBe(failure);});
 expect(saveSettingsErrorMessage(failure)).toContain('Đã có người sửa cài đặt chung');expect(saveSettingsErrorMessage(failure)).not.toContain('Chưa xác nhận');
 expect(String(m.error.mock.calls[0]?.[0])).toContain('Chưa lưu được cài đặt hiển thị');expect(JSON.stringify(m.error.mock.calls[0]?.[1])).toContain('Đã có người sửa cài đặt chung');expect(JSON.stringify(m.error.mock.calls)).not.toContain('SQL_PRIVATE');
 // Bị từ chối hẳn: lần lưu sau (sau khi đọc lại) gửi ngay, không bị chặn chờ đối chiếu.
 m.rpc.mockImplementation(echo);await act(async()=>{await expect(h.result.current.mutateAsync({...settings,expectedUpdatedAt:'2026-11-25T03:00:00+00:00'})).resolves.toBeTruthy();});expect(saves()).toBe(2);});
it('unconfirmed settings save is retried and verified on the next save instead of blocking forever',async()=>{
 m.rpc.mockResolvedValue({data:company({soon_days:99}),error:null});
 const first=renderHook(useUpsertPublicRoomSettings,{wrapper});await act(async()=>{await expect(first.result.current.mutateAsync({...settings,expectedUpdatedAt:T1})).rejects.toBeTruthy();});
 m.rpc.mockImplementation(echo);
 const second=renderHook(useUpsertPublicRoomSettings,{wrapper});await act(async()=>{await expect(second.result.current.mutateAsync({...settings,expectedUpdatedAt:T1})).resolves.toMatchObject({ownerId:'owner-b',settings});});
 expect(saves()).toBe(2);
 const third=renderHook(useUpsertPublicRoomSettings,{wrapper});await act(async()=>{await expect(third.result.current.mutateAsync({...settings,expectedUpdatedAt:T1})).resolves.toBeTruthy();});
 expect(saves()).toBe(3);
});
it('settings confirmed row returns persisted values',async()=>{m.rpc.mockImplementation(echo);const h=renderHook(useUpsertPublicRoomSettings,{wrapper});await act(async()=>{await expect(h.result.current.mutateAsync({...settings,expectedUpdatedAt:T1})).resolves.toMatchObject({ownerId:'owner-b',exists:true,settings});});expect(m.success).toHaveBeenCalledOnce();});
it('server permission code stays on mutation and is hidden in feedback',async()=>{const failure={code:'42501',message:'SQL_PRIVATE_DIAGNOSTIC'};m.rpc.mockResolvedValue({data:null,error:failure});const h=renderHook(useUpdateTokenLabel,{wrapper});await act(async()=>{await expect(h.result.current.mutateAsync({token:'room-a',label:'New'})).rejects.toBe(failure);});expect(JSON.stringify(m.error.mock.calls)).not.toContain('SQL_PRIVATE');});
