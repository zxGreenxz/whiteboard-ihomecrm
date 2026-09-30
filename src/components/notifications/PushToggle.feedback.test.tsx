// @vitest-environment jsdom
import { cleanup,fireEvent,render,screen,waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach,beforeEach,expect,it,vi } from 'vitest';
const io=vi.hoisted(()=>({subscribed:vi.fn(),enable:vi.fn(),disable:vi.fn(),error:vi.fn(),success:vi.fn(),info:vi.fn(),warning:vi.fn(),profile:{id:'actor-a',full_name:'User',email:'user@example.com'}}));
vi.mock('@/lib/push',()=>({isPushSupported:()=>true,isSubscribed:io.subscribed,enablePush:io.enable,disablePush:io.disable,isIOS:()=>false,isStandalone:()=>true,getPermission:()=>'granted',sendTestPush:vi.fn()}));
vi.mock('sonner',()=>({toast:{error:io.error,success:io.success,info:io.info,warning:io.warning}}));
vi.mock('@/hooks/useProfile',()=>({useProfile:()=>({data:io.profile,status:'success',fetchStatus:'idle',isLoading:false,isError:false,error:null,refetch:vi.fn()}),useUpdateProfile:()=>({mutate:vi.fn(),isPending:false}),useUploadAvatar:()=>({mutate:vi.fn(),isPending:false}),useChangePassword:()=>({mutate:vi.fn(),isPending:false})}));
vi.mock('@/hooks/useAuth',()=>({useAuth:()=>({data:{id:'actor-a'}}),useLogout:()=>({mutate:vi.fn(),isPending:false})}));
vi.mock('@/hooks/useMyPermissions',()=>({useMyPermissions:()=>({data:{}})}));
vi.mock('@/lib/permissionPages',()=>({canUse:()=>false}));
vi.mock('@/components/account/AccountOrganizationCard',()=>({default:()=>null}));
vi.mock('@/components/notifications/NotificationPreferencesCard',()=>({default:()=>null}));
import PushNotificationSettings from './PushNotificationSettings';
import AccountMobilePage from '@/pages/account/AccountMobilePage';
import {FinancialWorkflowError} from '@/lib/financialWorkflowError';
beforeEach(()=>{vi.clearAllMocks();io.subscribed.mockResolvedValue(true);io.enable.mockResolvedValue('granted');io.disable.mockResolvedValue('disabled');});
afterEach(cleanup);
async function setup(mobile:boolean){
 render(<MemoryRouter future={{v7_startTransition:true,v7_relativeSplatPath:true}}>{mobile?<AccountMobilePage/>:<PushNotificationSettings/>}</MemoryRouter>);
 const toggle=mobile?screen.getByRole('button',{name:'Thông báo đẩy'}):screen.getByRole('switch');
 await waitFor(()=>expect(toggle).toHaveProperty('disabled',false));return toggle;
}
const retry=(mobile:boolean)=>screen.getByRole('button',{name:mobile?'Tải lại trạng thái thiết bị':'Kiểm tra lại'});
it.each([false,true])('partial enable is inline unknown with one owner and read-only recovery mobile=%s',async mobile=>{
 io.subscribed.mockResolvedValue(false);const pending=new FinancialWorkflowError('Trình duyệt đã đăng ký; chưa xác nhận lưu trên máy chủ.','partial',[],{code:'42501',message:'PRIVATE_PUSH_SCHEMA'});
 io.enable.mockRejectedValue(pending);const toggle=await setup(mobile);fireEvent.click(toggle);
 await waitFor(()=>expect(io.error).toHaveBeenCalledTimes(1));
 expect(toggle).toHaveProperty('disabled',true);
 expect(screen.getByText(/Trình duyệt đã đăng ký; chưa xác nhận lưu trên máy chủ/)).toBeTruthy();
 expect(document.body.textContent).not.toContain('PRIVATE_PUSH_SCHEMA');expect(io.success).not.toHaveBeenCalled();
 io.subscribed.mockRejectedValueOnce(new Error('PRIVATE_READ_FAILURE'));fireEvent.click(retry(mobile));
 await waitFor(()=>expect(toggle).toHaveProperty('disabled',true));
 expect(io.error).toHaveBeenCalledTimes(1);
 io.subscribed.mockResolvedValue(true);fireEvent.click(retry(mobile));
 await waitFor(()=>expect(toggle).toHaveProperty('disabled',false));
 expect(io.subscribed).toHaveBeenLastCalledWith(pending);expect(io.enable).toHaveBeenCalledTimes(1);
});
it.each([false,true])('partial disable retains unknown rather than claiming off mobile=%s',async mobile=>{
 const pending=new FinancialWorkflowError('Thiết bị đã hủy đăng ký; chưa xác nhận dọn đăng ký máy chủ.','partial',[],{code:'42501',message:'PRIVATE_PUSH_SCHEMA'});
 io.disable.mockRejectedValue(pending);const toggle=await setup(mobile);fireEvent.click(toggle);
 await waitFor(()=>expect(io.error).toHaveBeenCalledTimes(1));
 expect(toggle).toHaveProperty('disabled',true);expect(io.success).not.toHaveBeenCalled();
 expect(screen.getByText(/Thiết bị đã hủy đăng ký; chưa xác nhận dọn đăng ký máy chủ/)).toBeTruthy();
 io.subscribed.mockResolvedValue(false);fireEvent.click(retry(mobile));
 await waitFor(()=>expect(toggle).toHaveProperty('disabled',false));
 expect(io.subscribed).toHaveBeenLastCalledWith(pending);expect(io.disable).toHaveBeenCalledTimes(1);
});
it.each([false,true])('known positive enable is successful only after helper resolves mobile=%s',async mobile=>{
 io.subscribed.mockResolvedValue(false);const toggle=await setup(mobile);fireEvent.click(toggle);
 await waitFor(()=>expect(io.success).toHaveBeenCalledTimes(1));expect(io.error).not.toHaveBeenCalled();
});
it.each([false,true])('known positive disable updates the confirmed state once mobile=%s',async mobile=>{
 const toggle=await setup(mobile);fireEvent.click(toggle);await waitFor(()=>expect(io.success).toHaveBeenCalledTimes(1));
 expect(io.error).not.toHaveBeenCalled();
});
it.each([false,true])('already-disabled is neutral information instead of another success mobile=%s',async mobile=>{
 io.disable.mockResolvedValue('already-disabled');const toggle=await setup(mobile);fireEvent.click(toggle);
 await waitFor(()=>expect(io.info).toHaveBeenCalledTimes(1));expect(io.success).not.toHaveBeenCalled();
});
