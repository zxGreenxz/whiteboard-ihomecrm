// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
const mocks = vi.hoisted(() => ({ send: vi.fn(), subscribed: vi.fn(), success: vi.fn(), warning: vi.fn(), error: vi.fn() }));
vi.mock('@/lib/push', () => ({ isPushSupported:()=>true,isIOS:()=>false,isStandalone:()=>true,getPermission:()=> 'granted',isSubscribed:mocks.subscribed,enablePush:vi.fn(),disablePush:vi.fn(),sendTestPush:mocks.send }));
vi.mock('sonner', () => ({ toast: {success:mocks.success,warning:mocks.warning,error:mocks.error} }));
import PushNotificationSettings from './PushNotificationSettings';
describe('phản hồi gửi thử push', () => {
 beforeEach(()=>{vi.clearAllMocks();mocks.subscribed.mockResolvedValue(true);});
 it('một phần được tiếp nhận không báo tất cả thành công hay lộ lỗi nhà cung cấp', async()=>{
 mocks.send.mockResolvedValue({sent:1,total:2,failed:1,pruned:0,errors:[{status:500,host:'private-host',body:'SQLSTATE'}]});
 render(<PushNotificationSettings/>);
 const button=screen.getByRole('button',{name:'Gửi thông báo thử'});
 await waitFor(()=>expect(button.hasAttribute('disabled')).toBe(false));fireEvent.click(button);
 await waitFor(()=>expect(mocks.warning).toHaveBeenCalled());expect(mocks.success).not.toHaveBeenCalled();
 expect(JSON.stringify(mocks.warning.mock.calls)).not.toMatch(/SQLSTATE|private-host/);
 });
});
