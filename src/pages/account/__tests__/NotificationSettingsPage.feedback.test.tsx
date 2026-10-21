// @vitest-environment jsdom
import {cleanup,render,screen} from '@testing-library/react';
import {MemoryRouter} from 'react-router-dom';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
const m=vi.hoisted(()=>({perms:{} as Record<string,unknown>,phone:false,org:{} as Record<string,unknown>,cards:[] as string[]}));
const {stub}=vi.hoisted(()=>({stub:(name:string)=>({default:(props:Record<string,unknown>)=>{m.cards.push(`${name}:${JSON.stringify(props)}`);return <section aria-label={name}/>;}})}));
vi.mock('@/hooks/use-mobile',()=>({usePhoneViewport:()=>m.phone}));
vi.mock('@/components/layout/MainLayout',()=>({default:({children,title}:{children:React.ReactNode;title?:string})=><main><h1>{title}</h1>{children}</main>}));
vi.mock('@/hooks/useMyPermissions',()=>({useMyPermissions:()=>({data:m.perms})}));
vi.mock('@/contexts/OrganizationContext',()=>({useOrganization:()=>m.org}));
vi.mock('@/components/notifications/PushNotificationSettings',()=>stub('Thiết bị này'));
vi.mock('@/components/notifications/PushDevicesCard',()=>stub('Thiết bị đã đăng ký'));
vi.mock('@/components/notifications/NotificationPreferencesCard',()=>stub('Loại thông báo'));
vi.mock('@/components/notifications/NotificationQuietHoursCard',()=>stub('Giờ yên của tôi'));
vi.mock('@/components/notifications/NotificationOrgConfigCard',()=>stub('Cấu hình công ty'));
vi.mock('@/components/notifications/NotificationDeliveryHealthCard',()=>stub('Sức khoẻ giao thông báo'));
import NotificationSettingsPage from '../NotificationSettingsPage';
beforeEach(()=>{m.cards=[];m.phone=false;m.perms={};m.org={selectedOrganizationId:'org-a',organization:{id:'org-a',name:'Công ty A'},isLoading:false,isError:false,isMultiOrg:false,refetchOrganizations:vi.fn()};});
afterEach(cleanup);
const renderPage=()=>render(<MemoryRouter future={{v7_startTransition:true,v7_relativeSplatPath:true}}><NotificationSettingsPage/></MemoryRouter>);

it('mọi thành viên thấy mục thiết bị, loại thông báo, giờ yên và nhắc cục bộ; không có settings.view thì không thấy mục công ty',()=>{
 renderPage();
 for(const name of ['Thiết bị này','Thiết bị đã đăng ký','Loại thông báo','Giờ yên của tôi']) expect(screen.getByRole('region',{name})).toBeTruthy();
 expect(screen.queryByRole('region',{name:'Cấu hình công ty'})).toBeNull();
 expect(screen.queryByRole('region',{name:'Sức khoẻ giao thông báo'})).toBeNull();
 expect(screen.getByText(/nhắc cục bộ trên thiết bị này/)).toBeTruthy();
 expect(screen.getByRole('link',{name:/Mở cài đặt nhắc hẹn/}).getAttribute('href')).toBe('/viec-cua-toi?mo=nhac-hen');
 expect(m.cards).toContain('Loại thông báo:{"organizationId":"org-a"}');
});
it('có settings.view thì thấy cấu hình công ty theo công ty đang chọn; sửa cần settings.edit',()=>{
 m.perms={settings:{view:true}};renderPage();
 expect(screen.getByRole('region',{name:'Cấu hình công ty'})).toBeTruthy();
 expect(screen.getByRole('region',{name:'Sức khoẻ giao thông báo'})).toBeTruthy();
 expect(m.cards).toContain('Cấu hình công ty:{"organizationId":"org-a","organizationName":"Công ty A","canEdit":false}');
});
it('điện thoại dùng vỏ app toàn màn hình, nội dung giữ nguyên',()=>{
 m.phone=true;const {container}=renderPage();
 expect(container.querySelector('.cm-app')).toBeTruthy();
 expect(screen.getByRole('heading',{name:'Cài đặt thông báo'})).toBeTruthy();
 expect(screen.getByRole('region',{name:'Thiết bị này'})).toBeTruthy();
});
it('chưa tải được danh sách công ty thì báo lỗi, không dựng sở thích cho công ty rỗng',()=>{
 m.org={...m.org,selectedOrganizationId:null,organization:null,isError:true};renderPage();
 expect(screen.getByRole('alert').textContent).toContain('Chưa tải được danh sách công ty');
 expect(screen.queryByRole('region',{name:'Loại thông báo'})).toBeNull();
});
