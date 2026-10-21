// @vitest-environment jsdom
import {cleanup,fireEvent,render,screen,within} from '@testing-library/react';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
const m=vi.hoisted(()=>({mutate:vi.fn(),devices:{} as Record<string,unknown>}));
vi.mock('@/integrations/supabase/client',()=>({supabase:{}}));
vi.mock('@/lib/push',()=>({isPushSupported:()=>true,getExistingSubscription:vi.fn()}));
vi.mock('@/hooks/useNotificationSettings',async original=>({...await original<typeof import('@/hooks/useNotificationSettings')>(),
 useMyPushDevices:()=>m.devices,
 useCurrentPushDevice:()=>({data:{endpoint:'https://push.example/this',serviceWorker:'active'},isLoading:false,isError:false}),
 useRemovePushDevice:()=>({mutate:m.mutate,isPending:false,error:null})}));
import PushDevicesCard from './PushDevicesCard';
const ANDROID='Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Mobile Safari/537.36';
const WINDOWS='Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36';
beforeEach(()=>{vi.clearAllMocks();m.devices={isLoading:false,isError:false,refetch:vi.fn(),data:[
 {id:'dev-this',endpoint:'https://push.example/this',userAgent:WINDOWS,isActive:true,createdAt:'2026-10-01T01:00:00Z',updatedAt:'2026-10-01T01:00:00Z'},
 {id:'dev-old',endpoint:'https://push.example/old',userAgent:ANDROID,isActive:false,createdAt:'2026-09-01T01:00:00Z',updatedAt:'2026-10-05T01:00:00Z'},
]};});
afterEach(cleanup);

it('liệt kê máy, đánh dấu "Máy này", máy đang dùng không có nút gỡ',()=>{
 render(<PushDevicesCard/>);
 const rows=screen.getAllByRole('listitem');
 expect(within(rows[0]).getByText('Chrome · Windows')).toBeTruthy();
 expect(within(rows[0]).getByText('Máy này')).toBeTruthy();
 expect(within(rows[0]).queryByRole('button')).toBeNull();
 expect(within(rows[1]).getByText('Đã ngừng (hết hạn)')).toBeTruthy();
});
it('gỡ máy khác phải xác nhận rồi mới gửi đúng id',()=>{
 render(<PushDevicesCard/>);
 fireEvent.click(screen.getByRole('button',{name:'Gỡ thiết bị Chrome · Android'}));
 expect(m.mutate).not.toHaveBeenCalled();
 fireEvent.click(screen.getByRole('button',{name:'Gỡ thiết bị'}));
 expect(m.mutate).toHaveBeenCalledWith('dev-old',expect.any(Object));
});
it('lỗi đọc danh sách không thành "chưa có thiết bị"',()=>{
 m.devices={isLoading:false,isError:true,error:{code:'42501'},refetch:vi.fn(),data:undefined};
 render(<PushDevicesCard/>);
 expect(screen.getByRole('alert').textContent).toContain('Chưa tải được danh sách thiết bị');
 expect(screen.queryByText(/Chưa có thiết bị nào/)).toBeNull();
});
