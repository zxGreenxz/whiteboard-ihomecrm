// @vitest-environment jsdom
import {cleanup,fireEvent,render,screen} from '@testing-library/react';
import {afterAll,afterEach,beforeAll,beforeEach,expect,it,vi} from 'vitest';
const m=vi.hoisted(()=>({mutate:vi.fn(),reset:vi.fn(),refetch:vi.fn(),error:null as unknown,query:{} as Record<string,unknown>}));
vi.mock('@/integrations/supabase/client',()=>({supabase:{}}));
vi.mock('@/hooks/useNotificationSettings',async original=>({...await original<typeof import('@/hooks/useNotificationSettings')>(),
 useMyQuietHours:()=>m.query,
 useSetMyQuietHours:()=>({mutate:m.mutate,isPending:false,error:m.error,reset:m.reset})}));
import NotificationQuietHoursCard from './NotificationQuietHoursCard';
// Radix Select cần các API trình duyệt jsdom không có (khuôn ReceivingCashbookSettings.test).
beforeAll(()=>{vi.stubGlobal('PointerEvent',MouseEvent);vi.stubGlobal('ResizeObserver',class{observe(){}unobserve(){}disconnect(){}});HTMLElement.prototype.scrollIntoView=vi.fn();HTMLElement.prototype.hasPointerCapture=vi.fn(()=>false);HTMLElement.prototype.releasePointerCapture=vi.fn();});
afterAll(()=>{vi.unstubAllGlobals();});
beforeEach(()=>{vi.clearAllMocks();m.error=null;m.query={data:{enabled:false,quietStart:21,quietEnd:7,updatedAt:null},isLoading:false,isError:false,error:null,refetch:m.refetch};});
afterEach(cleanup);
// Truy theo nhãn/chữ thay vì getByRole trên danh sách mở: getByRole tính khả kiến từng phần tử nên rất chậm với 24 lựa chọn.
const pick=(label:string,hour:string)=>{fireEvent.keyDown(screen.getByLabelText(label),{key:'ArrowDown'});fireEvent.keyDown(screen.getByText(hour,{selector:'[role="option"] *'}),{key:'Enter'});};

it('lưu đủ ba giá trị đang sửa; biên nhận do hook kiểm',()=>{
 render(<NotificationQuietHoursCard organizationId="org-a"/>);
 fireEvent.click(screen.getByRole('switch',{name:'Bật giờ yên'}));
 pick('Giờ bắt đầu yên của tôi','22:00');
 fireEvent.click(screen.getByRole('button',{name:'Lưu giờ yên'}));
 expect(m.mutate).toHaveBeenCalledWith({enabled:true,quietStart:22,quietEnd:7},expect.any(Object));
});
it('từ = đến khi đang bật thì chặn lưu; khung quá dài thì cảnh báo',()=>{
 m.query={...m.query,data:{enabled:true,quietStart:7,quietEnd:7,updatedAt:null}};
 render(<NotificationQuietHoursCard organizationId="org-a"/>);
 expect(screen.getByRole('alert').textContent).toContain('phải khác nhau');
 expect((screen.getByRole('button',{name:'Lưu giờ yên'}) as HTMLButtonElement).disabled).toBe(true);
 cleanup();m.query={...m.query,data:{enabled:true,quietStart:18,quietEnd:9,updatedAt:'2026-10-21T01:00:00Z'}};
 render(<NotificationQuietHoursCard organizationId="org-a"/>);
 expect(screen.getByText(/Khung yên dài 15 giờ/)).toBeTruthy();
 expect(screen.getByText(/Lưu lần cuối/)).toBeTruthy();
});
it('biên nhận chưa xác nhận khoá và đòi đọc lại trước khi sửa tiếp',()=>{
 m.error=new TypeError('fetch failed');
 render(<NotificationQuietHoursCard organizationId="org-a"/>);
 expect(screen.getByRole('alert').textContent).toContain('Chưa xác nhận được giờ yên đã lưu');
 expect((screen.getByRole('switch',{name:'Bật giờ yên'}) as HTMLButtonElement).disabled).toBe(true);
 expect(screen.getByRole('button',{name:'Đọc lại trạng thái'})).toBeTruthy();
});
it('máy chủ chưa có RPC thì nói rõ, không dựng giờ yên mặc định giả',()=>{
 m.query={data:undefined,isLoading:false,isError:true,error:{code:'PGRST202',message:'not found'},refetch:m.refetch};
 render(<NotificationQuietHoursCard organizationId="org-a"/>);
 expect(screen.getByRole('alert').textContent).toContain('Máy chủ chưa hỗ trợ giờ yên cá nhân');
 expect(screen.queryByRole('switch')).toBeNull();
});
