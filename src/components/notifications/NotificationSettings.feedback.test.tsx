// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const m=vi.hoisted(()=>({reset:vi.fn(),refetch:vi.fn(),error:new TypeError('fetch failed')}));
vi.mock('@/hooks/useMyPermissions',()=>({useMyPermissions:()=>({data:{}})}));
vi.mock('@/lib/permissionPages',()=>({canUse:()=>true}));
vi.mock('@/hooks/useNotificationSettings',()=>{
 class NotificationSettingsReceiptError extends Error {}
 const prefs={E1:{event_key:'E1',in_app:true,push:true,cadence:'IMMEDIATE'}};
 const personalData={prefs,available:true}; const orgData={events:{E1:{enabled:true,min_amount:null}},quiet_start:21,quiet_end:7,available:true};
 return {NotificationSettingsReceiptError,NOTIFICATION_EVENT_KEYS:['E1'],NOTIFICATION_EVENT_LABELS:{E1:{title:'Phiếu chờ duyệt',desc:'Thông báo thử'}},
 useMyOrgOptions:()=>({options:[{id:'org-a',name:'Tổ chức A'}],isLoading:false,isError:false}),
 useMyNotificationPreferences:()=>({data:personalData,isLoading:false,isError:false,refetch:m.refetch}),
 useNotificationOrgConfig:()=>({data:orgData,isLoading:false,isError:false,refetch:m.refetch}),
 useSetMyNotificationPreferences:()=>({isPending:false,error:m.error,reset:m.reset}),
 useSetNotificationOrgConfig:()=>({isPending:false,error:m.error,reset:m.reset})};
});
import NotificationPreferencesCard from './NotificationPreferencesCard';
import NotificationOrgConfigCard from './NotificationOrgConfigCard';
afterEach(cleanup);beforeEach(()=>{vi.clearAllMocks();m.refetch.mockResolvedValue({isError:false,data:{}})});
it.each(['personal','org'])('kết quả lưu %s chưa xác nhận khóa thay đổi đến khi đọc lại thành công',async kind=>{
 render(kind==='personal'?<NotificationPreferencesCard/>:<NotificationOrgConfigCard/>);
 expect(screen.getByRole('alert').textContent).toContain('Chưa xác nhận');
 for(const toggle of screen.getAllByRole('switch')) expect((toggle as HTMLButtonElement).disabled).toBe(true);
 m.refetch.mockResolvedValueOnce({isError:true,data:undefined});
 fireEvent.click(screen.getByRole('button',{name:'Đọc lại trạng thái'}));await waitFor(()=>expect(m.refetch).toHaveBeenCalledTimes(1));expect(m.reset).not.toHaveBeenCalled();
 fireEvent.click(screen.getByRole('button',{name:'Đọc lại trạng thái'}));await waitFor(()=>expect(m.reset).toHaveBeenCalledTimes(1));
});
