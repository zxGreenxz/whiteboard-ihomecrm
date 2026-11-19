// @vitest-environment jsdom
import { cleanup,fireEvent,render,screen,waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach,beforeEach,expect,it,vi } from 'vitest';
const io=vi.hoisted(()=>({subscribed:vi.fn(),enable:vi.fn(),disable:vi.fn(),error:vi.fn(),success:vi.fn(),info:vi.fn(),warning:vi.fn(),profile:{id:'actor-a',full_name:'User',email:'user@example.com'}}));
vi.mock('@/lib/push',()=>({isPushSupported:()=>true,isSubscribed:io.subscribed,enablePush:io.enable,disablePush:io.disable,isIOS:()=>false,isStandalone:()=>true,getPermission:()=>'granted',sendTestPush:vi.fn(),getExistingSubscription:vi.fn()}));
vi.mock('@/integrations/supabase/client',()=>({supabase:{}}));
vi.mock('@/contexts/OrganizationContext',()=>({useOrganization:()=>({selectedOrganizationId:'org-a'})}));
vi.mock('sonner',()=>({toast:{error:io.error,success:io.success,info:io.info,warning:io.warning}}));
vi.mock('@/hooks/useNotificationSettings',async original=>({...await original<typeof import('@/hooks/useNotificationSettings')>(),
 useCurrentPushDevice:()=>({data:{endpoint:null,serviceWorker:'active'},isLoading:false,isError:false}),
 useMyPushLog:()=>({data:[],isLoading:false,isError:false,refetch:vi.fn()})}));
vi.mock('@/hooks/useProfile',()=>({useProfile:()=>({data:io.profile,status:'success',fetchStatus:'idle',isLoading:false,isError:false,error:null,refetch:vi.fn()}),useUpdateProfile:()=>({mutate:vi.fn(),isPending:false}),useUploadAvatar:()=>({mutate:vi.fn(),isPending:false}),useChangePassword:()=>({mutate:vi.fn(),isPending:false})}));
vi.mock('@/hooks/useAuth',()=>({useAuth:()=>({data:{id:'actor-a'}}),useLogout:()=>({mutate:vi.fn(),isPending:false})}));
vi.mock('@/hooks/useMyPermissions',()=>({useMyPermissions:()=>({data:{}})}));
vi.mock('@/lib/permissionPages',()=>({canUse:()=>false}));
vi.mock('@/components/account/AccountOrganizationCard',()=>({default:()=>null}));
import PushNotificationSettings from './PushNotificationSettings';
import AccountMobilePage from '@/pages/account/AccountMobilePage';
import {FinancialWorkflowError} from '@/lib/financialWorkflowError';
beforeEach(()=>{vi.clearAllMocks();io.subscribed.mockResolvedValue(true);io.enable.mockResolvedValue('granted');io.disable.mockResolvedValue('disabled');});
afterEach(cleanup);
async function setup(){
 render(<QueryClientProvider client={new QueryClient()}><PushNotificationSettings/></QueryClientProvider>);
 const toggle=screen.getByRole('switch',{name:'Bật thông báo đẩy trên thiết bị này'});
 await waitFor(()=>expect(toggle).toHaveProperty('disabled',false));return toggle;
}
// Hai nút "Kiểm tra lại" có thể cùng hiện (cảnh báo chưa xác định + nút thường trực); bấm nút đầu.
const retry=()=>screen.getAllByRole('button',{name:'Kiểm tra lại'})[0];
it('partial enable is inline unknown with one owner and read-only recovery',async()=>{
 io.subscribed.mockResolvedValue(false);const pending=new FinancialWorkflowError('Trình duyệt đã đăng ký; chưa xác nhận lưu trên máy chủ.','partial',[],{code:'42501',message:'PRIVATE_PUSH_SCHEMA'});
 io.enable.mockRejectedValue(pending);const toggle=await setup();fireEvent.click(toggle);
 await waitFor(()=>expect(io.error).toHaveBeenCalledTimes(1));
 expect(toggle).toHaveProperty('disabled',true);
 expect(screen.getByText(/Trình duyệt đã đăng ký; chưa xác nhận lưu trên máy chủ/)).toBeTruthy();
 expect(document.body.textContent).not.toContain('PRIVATE_PUSH_SCHEMA');expect(io.success).not.toHaveBeenCalled();
 io.subscribed.mockRejectedValueOnce(new Error('PRIVATE_READ_FAILURE'));fireEvent.click(retry());
 await waitFor(()=>expect(toggle).toHaveProperty('disabled',true));
 expect(io.error).toHaveBeenCalledTimes(1);
 io.subscribed.mockResolvedValue(true);fireEvent.click(retry());
 await waitFor(()=>expect(toggle).toHaveProperty('disabled',false));
 expect(io.subscribed).toHaveBeenLastCalledWith(pending);expect(io.enable).toHaveBeenCalledTimes(1);
});
it('partial disable retains unknown rather than claiming off',async()=>{
 const pending=new FinancialWorkflowError('Thiết bị đã hủy đăng ký; chưa xác nhận dọn đăng ký máy chủ.','partial',[],{code:'42501',message:'PRIVATE_PUSH_SCHEMA'});
 io.disable.mockRejectedValue(pending);const toggle=await setup();fireEvent.click(toggle);
 await waitFor(()=>expect(io.error).toHaveBeenCalledTimes(1));
 expect(toggle).toHaveProperty('disabled',true);expect(io.success).not.toHaveBeenCalled();
 expect(screen.getByText(/Thiết bị đã hủy đăng ký; chưa xác nhận dọn đăng ký máy chủ/)).toBeTruthy();
 io.subscribed.mockResolvedValue(false);fireEvent.click(retry());
 await waitFor(()=>expect(toggle).toHaveProperty('disabled',false));
 expect(io.subscribed).toHaveBeenLastCalledWith(pending);expect(io.disable).toHaveBeenCalledTimes(1);
});
it('known positive enable is successful only after helper resolves',async()=>{
 io.subscribed.mockResolvedValue(false);const toggle=await setup();fireEvent.click(toggle);
 await waitFor(()=>expect(io.success).toHaveBeenCalledTimes(1));expect(io.error).not.toHaveBeenCalled();
});
it('known positive disable updates the confirmed state once',async()=>{
 const toggle=await setup();fireEvent.click(toggle);await waitFor(()=>expect(io.success).toHaveBeenCalledTimes(1));
 expect(io.error).not.toHaveBeenCalled();
});
it('already-disabled is neutral information instead of another success',async()=>{
 io.disable.mockResolvedValue('already-disabled');const toggle=await setup();fireEvent.click(toggle);
 await waitFor(()=>expect(io.info).toHaveBeenCalledTimes(1));expect(io.success).not.toHaveBeenCalled();
});
function Where(){return <p data-testid="where">{useLocation().pathname}</p>;}
it('Tài khoản mobile không còn công tắc push tự dựng; một mục dẫn sang Cài đặt thông báo',()=>{
 render(<MemoryRouter initialEntries={['/account/profile']} future={{v7_startTransition:true,v7_relativeSplatPath:true}}><Routes><Route path="/account/profile" element={<AccountMobilePage/>}/><Route path="*" element={<Where/>}/></Routes></MemoryRouter>);
 expect(screen.queryByRole('button',{name:'Thông báo đẩy'})).toBeNull();
 expect(io.subscribed).not.toHaveBeenCalled();
 fireEvent.click(screen.getByRole('button',{name:/Cài đặt thông báo/}));
 expect(screen.getByTestId('where').textContent).toBe('/account/notifications');
});
