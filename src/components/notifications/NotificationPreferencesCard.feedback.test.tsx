// @vitest-environment jsdom
import {cleanup,fireEvent,render,screen} from '@testing-library/react';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
const row=(in_app:boolean,push:boolean)=>({in_app,push,cadence:'IMMEDIATE'});
const m=vi.hoisted(()=>({mutate:vi.fn(),prefs:{} as Record<string,unknown>}));
vi.mock('@/integrations/supabase/client',()=>({supabase:{}}));
vi.mock('@/hooks/useNotificationSettings',async original=>({...await original<typeof import('@/hooks/useNotificationSettings')>(),
 useMyNotificationPreferences:()=>({data:{prefs:m.prefs,available:true},isLoading:false,isError:false,refetch:vi.fn()}),
 useSetMyNotificationPreference:()=>({mutate:m.mutate,isPending:false,error:null,reset:vi.fn()})}));
import NotificationPreferencesCard from './NotificationPreferencesCard';
beforeEach(()=>{vi.clearAllMocks();
 m.prefs={E1:{event_key:'E1',...row(false,true)},E2:{event_key:'E2',...row(true,true)},E3:{event_key:'E3',...row(true,true)},E4:{event_key:'E4',...row(true,true)},E5:{event_key:'E5',...row(true,true)},E6:{event_key:'E6',...row(true,true)},LIFECYCLE:{event_key:'LIFECYCLE',...row(false,true)},CONTRACT_EXPIRY:{event_key:'CONTRACT_EXPIRY',...row(true,false)}};});
afterEach(cleanup);
const sw=(name:string)=>screen.getByRole('switch',{name}) as HTMLButtonElement;

it('gạt một công tắc chỉ gửi đúng khoá × trường đó',()=>{
 render(<NotificationPreferencesCard organizationId="org-a"/>);
 fireEvent.click(sw('Đẩy về máy · Phiếu của tôi được duyệt / bị từ chối'));
 expect(m.mutate).toHaveBeenCalledTimes(1);
 expect(m.mutate.mock.calls[0][0]).toEqual({key:'E2',field:'push',value:false});
});
it('"Đẩy về máy" bị khoá khi "Trong app" tắt ở họ E1–E6, kèm giải thích; lane lifecycle không khoá',()=>{
 render(<NotificationPreferencesCard organizationId="org-a"/>);
 const e1=sw('Đẩy về máy · Phiếu chờ tôi duyệt');
 expect(e1.disabled).toBe(true);expect(e1.getAttribute('aria-checked')).toBe('false');
 expect(document.getElementById(e1.getAttribute('aria-describedby') ?? '')?.textContent).toMatch(/bật "Trong app" trước/);
 fireEvent.click(e1);expect(m.mutate).not.toHaveBeenCalled();
 const life=sw('Đẩy về máy · Việc cần theo dõi khi trả phòng');
 expect(life.disabled).toBe(false);expect(life.getAttribute('aria-checked')).toBe('true');
 expect(sw('Đẩy về máy · Hợp đồng sắp hết hạn').disabled).toBe(false);
});
it('họ nhắc mới máy chủ chưa trả thì hiện "chưa hỗ trợ", không dựng công tắc giả',()=>{
 render(<NotificationPreferencesCard organizationId="org-a"/>);
 expect(screen.getByText('Hoá đơn sắp đến hạn / quá hạn')).toBeTruthy();
 expect(screen.queryByRole('switch',{name:'Trong app · Hoá đơn sắp đến hạn / quá hạn'})).toBeNull();
 expect(screen.getAllByText(/Máy chủ chưa hỗ trợ loại này/)).toHaveLength(2); // BILLING + DEPOSIT
});
it('nhãn E4 nêu cả nhắc hạn/quá hạn việc Hermes giao',()=>{
 render(<NotificationPreferencesCard organizationId="org-a"/>);
 expect(screen.getByText(/nhắc việc sắp tới hạn \/ quá hạn/)).toBeTruthy();
});
