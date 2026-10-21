// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
const mocks = vi.hoisted(() => ({ send: vi.fn(), subscribed: vi.fn(), success: vi.fn(), warning: vi.fn(), error: vi.fn(), info: vi.fn(), env: { supported: true, ios: false, standalone: true } }));
vi.mock('@/lib/push', () => ({ isPushSupported:()=>mocks.env.supported,isIOS:()=>mocks.env.ios,isStandalone:()=>mocks.env.standalone,getPermission:()=> mocks.env.supported?'granted':'unsupported',isSubscribed:mocks.subscribed,enablePush:vi.fn(),disablePush:vi.fn(),sendTestPush:mocks.send,getExistingSubscription:vi.fn() }));
vi.mock('@/integrations/supabase/client', () => ({ supabase: {} }));
vi.mock('@/contexts/OrganizationContext', () => ({ useOrganization: () => ({ selectedOrganizationId: 'org-a' }) }));
vi.mock('sonner', () => ({ toast: {success:mocks.success,warning:mocks.warning,error:mocks.error,info:mocks.info} }));
vi.mock('@/hooks/useNotificationSettings', async original => ({ ...await original<typeof import('@/hooks/useNotificationSettings')>(),
  useCurrentPushDevice: () => ({ data: { endpoint: 'https://push.example/me', serviceWorker: 'active' }, isLoading: false, isError: false }),
  useMyPushLog: () => ({ data: [{ createdAt: '2026-10-21T01:00:00Z', outcome: 'SENT', sent: 1 }], isLoading: false, isError: false, refetch: vi.fn() }) }));
import PushNotificationSettings from './PushNotificationSettings';
const renderCard = () => render(<QueryClientProvider client={new QueryClient()}><PushNotificationSettings/></QueryClientProvider>);
afterEach(cleanup);
describe('phản hồi gửi thử push', () => {
 beforeEach(()=>{vi.clearAllMocks();mocks.env={supported:true,ios:false,standalone:true};mocks.subscribed.mockResolvedValue(true);});
 it('một phần được tiếp nhận không báo tất cả thành công hay lộ lỗi nhà cung cấp', async()=>{
 mocks.send.mockResolvedValue({sent:1,total:2,failed:1,pruned:0,errors:[{status:500,host:'private-host',body:'SQLSTATE'}]});
 renderCard();
 const button=screen.getByRole('button',{name:'Gửi thông báo thử'});
 await waitFor(()=>expect(button.hasAttribute('disabled')).toBe(false));fireEvent.click(button);
 await waitFor(()=>expect(mocks.warning).toHaveBeenCalled());expect(mocks.success).not.toHaveBeenCalled();
 expect(JSON.stringify(mocks.warning.mock.calls)).not.toMatch(/SQLSTATE|private-host/);
 expect(document.body.textContent).not.toMatch(/SQLSTATE|private-host/);
 });
 it('outcome NO_DEVICE (không ném nữa — C8) hiện ngay trên thẻ, không báo thành công', async()=>{
 mocks.send.mockResolvedValue({sent:0,total:0,failed:0,pruned:0,errors:[],outcome:'NO_DEVICE'});
 renderCard();
 const button=screen.getByRole('button',{name:'Gửi thông báo thử'});
 await waitFor(()=>expect(button.hasAttribute('disabled')).toBe(false));fireEvent.click(button);
 await waitFor(()=>expect(screen.getByRole('status').textContent).toMatch(/Chưa có thiết bị nào đang bật nhận thông báo/));
 expect(mocks.warning).toHaveBeenCalledTimes(1);expect(mocks.success).not.toHaveBeenCalled();
 });
 it('chẩn đoán hiện service worker, đăng ký máy chủ khớp và nhật ký gửi gần nhất', async()=>{
 renderCard();
 await waitFor(()=>expect(screen.getByText('Khớp, máy chủ đang gửi tới máy này')).toBeTruthy());
 expect(screen.getByText('Đang chạy')).toBeTruthy();
 expect(screen.getByText(/Dịch vụ push đã nhận · 1 máy/)).toBeTruthy();
 });
});
describe('nhánh iPhone/iPad chưa thêm vào màn hình chính', () => {
 beforeEach(()=>{vi.clearAllMocks();mocks.subscribed.mockResolvedValue(false);});
 it('Safari iOS ngoài màn hình chính thấy hướng dẫn 3 bước thay vì "không hỗ trợ"', async()=>{
 mocks.env={supported:false,ios:true,standalone:false};
 renderCard();
 expect(screen.getByText(/Thêm vào MH chính/)).toBeTruthy();
 expect(screen.getByText(/biểu tượng trên màn hình chính/)).toBeTruthy();
 expect(screen.getByText('Cần thêm vào màn hình chính')).toBeTruthy();
 expect(screen.queryByText(/Trình duyệt này không hỗ trợ thông báo đẩy/)).toBeNull();
 expect(screen.queryByRole('switch')).toBeNull();
 expect(mocks.subscribed).not.toHaveBeenCalled();
 });
 it('trình duyệt khác không hỗ trợ vẫn báo không hỗ trợ', ()=>{
 mocks.env={supported:false,ios:false,standalone:false};
 renderCard();
 expect(screen.getByText(/Trình duyệt này không hỗ trợ thông báo đẩy/)).toBeTruthy();
 expect(screen.queryByText(/Thêm vào MH chính/)).toBeNull();
 });
});
