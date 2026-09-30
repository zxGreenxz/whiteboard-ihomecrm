// @vitest-environment jsdom
import { it,expect,vi } from 'vitest';
import { render,screen,fireEvent,waitFor } from '@testing-library/react';
vi.mock('@/hooks/use-mobile',()=>({usePhoneViewport:()=>false}));
vi.mock('@/components/layout/MainLayout',()=>({default:({children}: {children:React.ReactNode})=><>{children}</>}));
vi.mock('@/components/account/AccountOrganizationCard',()=>({default:()=>null}));
vi.mock('@/components/notifications/PushNotificationSettings',()=>({default:()=>null}));
vi.mock('@/components/notifications/NotificationPreferencesCard',()=>({default:()=>null}));
vi.mock('@/hooks/useClipboardImagePaste',()=>({useClipboardImagePaste:()=>({})}));
const change=vi.hoisted(()=>vi.fn());
vi.mock('@/hooks/useProfile',()=>({useProfile:()=>({data:{full_name:'Test',email:'test@example.com'},isLoading:false,isError:false,status:'success',fetchStatus:'idle',refetch:vi.fn()}),useUpdateProfile:()=>({mutate:vi.fn()}),useUploadAvatar:()=>({mutate:vi.fn()}),useChangePassword:()=>({mutate:change})}));
import ProfilePage from './ProfilePage';
it('đổi mật khẩu trống giữ form, đỏ cả hai ô và focus ô đầu',async()=>{
 render(<ProfilePage/>);fireEvent.click(screen.getByRole('button',{name:'Đổi mật khẩu'}));
 await waitFor(()=>expect(document.activeElement?.getAttribute('name')).toBe('newPassword'));
 expect(document.querySelector('[name="newPassword"]')?.getAttribute('aria-invalid')).toBe('true');
 expect(document.querySelector('[name="confirmPassword"]')?.getAttribute('aria-invalid')).toBe('true');
 expect(change).not.toHaveBeenCalled();
});
