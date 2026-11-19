// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const m=vi.hoisted(()=>({reset:vi.fn(),refetch:vi.fn(),error:new TypeError('fetch failed')}));
vi.mock('@/hooks/useNotificationSettings',()=>{
 class NotificationSettingsReceiptError extends Error {}
 class NotificationOrgConfigConflictError extends Error {}
 const prefs={E1:{event_key:'E1',in_app:true,push:true,cadence:'IMMEDIATE'}};
 const personalData={prefs,available:true}; const orgData={organizationId:'org-a',organizationName:'Công ty A',events:{E1:{enabled:true,min_amount:null}},quietStart:21,quietEnd:7,updatedAt:null,updatedBy:null};
 return {NotificationSettingsReceiptError,NotificationOrgConfigConflictError,NOTIFICATION_EVENT_KEYS:['E1'],NOTIFICATION_EVENT_LABELS:{E1:{title:'Phiếu chờ duyệt',desc:'Thông báo thử'}},
 PUSH_FOLLOWS_IN_APP_KEYS:new Set(['E1']),ORG_MIN_AMOUNT_KEYS:new Set(),diffOrgEvents:()=>({}),
 useMyNotificationPreferences:()=>({data:personalData,isLoading:false,isError:false,refetch:m.refetch}),
 useNotificationOrgConfig:()=>({data:orgData,isLoading:false,isError:false,refetch:m.refetch}),
 useSetMyNotificationPreference:()=>({isPending:false,error:m.error,reset:m.reset}),
 useSetNotificationOrgConfig:()=>({isPending:false,error:m.error,reset:m.reset})};
});
import NotificationPreferencesCard from './NotificationPreferencesCard';
import NotificationOrgConfigCard from './NotificationOrgConfigCard';
afterEach(cleanup);beforeEach(()=>{vi.clearAllMocks();m.refetch.mockResolvedValue({isError:false,data:{}})});
it.each(['personal','org'])('kết quả lưu %s chưa xác nhận khóa thay đổi đến khi đọc lại thành công',async kind=>{
 render(kind==='personal'?<NotificationPreferencesCard organizationId="org-a"/>:<NotificationOrgConfigCard organizationId="org-a" canEdit/>);
 expect(screen.getByRole('alert').textContent).toContain('Chưa xác nhận');
 for(const toggle of screen.getAllByRole('switch')) expect((toggle as HTMLButtonElement).disabled).toBe(true);
 m.refetch.mockResolvedValueOnce({isError:true,data:undefined});
 fireEvent.click(screen.getByRole('button',{name:'Đọc lại trạng thái'}));await waitFor(()=>expect(m.refetch).toHaveBeenCalledTimes(1));expect(m.reset).not.toHaveBeenCalled();
 fireEvent.click(screen.getByRole('button',{name:'Đọc lại trạng thái'}));await waitFor(()=>expect(m.reset).toHaveBeenCalledTimes(1));
});
