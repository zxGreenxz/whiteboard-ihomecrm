// @vitest-environment jsdom
import { afterEach,it,expect,vi } from 'vitest';
import { cleanup,render,screen,fireEvent,waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
vi.mock('@/hooks/use-mobile',()=>({usePhoneViewport:()=>false}));
vi.mock('@/components/layout/MainLayout',()=>({default:({children}: {children:React.ReactNode})=><>{children}</>}));
vi.mock('@/components/account/AccountOrganizationCard',()=>({default:()=>null}));
vi.mock('@/hooks/useClipboardImagePaste',()=>({useClipboardImagePaste:()=>({})}));
const change=vi.hoisted(()=>vi.fn());
vi.mock('@/hooks/useProfile',()=>({useProfile:()=>({data:{full_name:'Test',email:'test@example.com'},isLoading:false,isError:false,status:'success',fetchStatus:'idle',refetch:vi.fn()}),useUpdateProfile:()=>({mutate:vi.fn()}),useUploadAvatar:()=>({mutate:vi.fn()}),useChangePassword:()=>({mutate:change})}));
import ProfilePage from './ProfilePage';
afterEach(cleanup);
const renderPage=()=>render(<MemoryRouter future={{v7_startTransition:true,v7_relativeSplatPath:true}}><ProfilePage/></MemoryRouter>);
it('đổi mật khẩu trống giữ form, đỏ cả hai ô và focus ô đầu',async()=>{
 renderPage();fireEvent.click(screen.getByRole('button',{name:'Đổi mật khẩu'}));
 await waitFor(()=>expect(document.activeElement?.getAttribute('name')).toBe('newPassword'));
 expect(document.querySelector('[name="newPassword"]')?.getAttribute('aria-invalid')).toBe('true');
 expect(document.querySelector('[name="confirmPassword"]')?.getAttribute('aria-invalid')).toBe('true');
 expect(change).not.toHaveBeenCalled();
});
it('thông báo không còn dựng tại Hồ sơ; một liên kết sang /account/notifications',()=>{
 renderPage();
 expect(screen.getByRole('link',{name:/Mở Cài đặt thông báo/}).getAttribute('href')).toBe('/account/notifications');
 expect(screen.queryByRole('switch')).toBeNull();
});
