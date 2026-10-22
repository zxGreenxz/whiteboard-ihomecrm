// @vitest-environment jsdom
import {act,cleanup,fireEvent,render,screen,waitFor} from '@testing-library/react';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
type Cfg={enabled:boolean;min_amount:number|null};
type Data={organizationId:string;organizationName:string|null;events:Record<string,Cfg>;quietStart:number;quietEnd:number;updatedAt:string|null;updatedBy:string|null};
const fresh=():Data=>({organizationId:'org-a',organizationName:'Công ty A',events:{E1:{enabled:true,min_amount:null},E2:{enabled:true,min_amount:null}},quietStart:21,quietEnd:7,updatedAt:'2026-10-21T01:00:00Z',updatedBy:null});
const m=vi.hoisted(()=>({save:vi.fn(),data:null as unknown}));
vi.mock('@/integrations/supabase/client',()=>({supabase:{}}));
vi.mock('@/hooks/useNotificationSettings',async original=>({...await original<typeof import('@/hooks/useNotificationSettings')>(),
 useNotificationOrgConfig:()=>({data:m.data,isLoading:false,isError:false,refetch:vi.fn()}),
 useSetNotificationOrgConfig:()=>({mutate:m.save,isPending:false,error:null,reset:vi.fn()})}));
import NotificationOrgConfigCard from './NotificationOrgConfigCard';
import {NotificationOrgConfigConflictError} from '@/hooks/useNotificationSettings';
beforeEach(()=>{vi.clearAllMocks();m.data=fresh();});afterEach(cleanup);
const threshold=()=>screen.getByRole('textbox',{name:/Ngưỡng tiền · Phiếu của tôi được duyệt/}) as HTMLInputElement;

it('ngưỡng tiền chỉ có ở E2/E3, không có ở phiếu chờ duyệt (E1)',()=>{
 render(<NotificationOrgConfigCard organizationId="org-a" canEdit/>);
 expect(threshold()).toBeTruthy();
 expect(screen.queryByRole('textbox',{name:/Ngưỡng tiền · Phiếu chờ tôi duyệt/})).toBeNull();
 expect(screen.getByText(/Cấu hình công ty · Công ty A/)).toBeTruthy();
});
it('currency invalid raw cannot turn into null then save',async()=>{
 render(<NotificationOrgConfigCard organizationId="org-a" canEdit/>);const field=threshold();
 fireEvent.change(field,{target:{value:'abc2'}});fireEvent.click(screen.getByRole('button',{name:'Lưu cấu hình'}));
 await waitFor(()=>expect(document.activeElement).toBe(field));expect(field.value).toBe('abc2');expect(m.save).not.toHaveBeenCalled();
});
it('lưu chỉ gửi họ vừa đổi, kèm updated_at của bản mà bản nháp dựa trên dù máy chủ vừa đọc lại',()=>{
 const h=render(<NotificationOrgConfigCard organizationId="org-a" canEdit/>);
 fireEvent.change(threshold(),{target:{value:'500000'}});
 m.data={...fresh(),quietStart:22,updatedAt:'2026-10-21T02:00:00Z'};h.rerender(<NotificationOrgConfigCard organizationId="org-a" canEdit/>);
 expect(threshold().value).toBe('500.000');
 fireEvent.click(screen.getByRole('button',{name:'Lưu cấu hình'}));
 expect(m.save).toHaveBeenCalledWith({events:{E2:{min_amount:500000}},quietStart:21,quietEnd:7,expectedUpdatedAt:'2026-10-21T01:00:00Z'},expect.any(Object));
});
it('PT409: báo người khác vừa sửa, bỏ bản nháp và hiện bản mới nhất',async()=>{
 m.save.mockImplementation((_change:unknown,opts:{onError:(e:Error)=>void})=>{m.data={...fresh(),events:{...fresh().events,E1:{enabled:false,min_amount:null}},updatedAt:'2026-10-21T03:00:00Z'};opts.onError(new NotificationOrgConfigConflictError({code:'PT409'}));});
 render(<NotificationOrgConfigCard organizationId="org-a" canEdit/>);
 fireEvent.click(screen.getByRole('switch',{name:'Phiếu của tôi được duyệt / bị từ chối'}));
 await act(async()=>{fireEvent.click(screen.getByRole('button',{name:'Lưu cấu hình'}));});
 expect(screen.getByRole('alert').textContent).toContain('Cấu hình vừa được người khác sửa — đã tải lại');
 await waitFor(()=>expect(screen.getByRole('switch',{name:'Phiếu chờ tôi duyệt'}).getAttribute('aria-checked')).toBe('false'));
 expect(screen.getByRole('switch',{name:'Phiếu của tôi được duyệt / bị từ chối'}).getAttribute('aria-checked')).toBe('true');
 expect((screen.getByRole('button',{name:'Lưu cấu hình'}) as HTMLButtonElement).disabled).toBe(true);
});
it('khung giờ yên công ty quá dài thì cảnh báo; chỉ xem thì khoá công tắc',()=>{
 m.data={...fresh(),quietStart:20,quietEnd:10};render(<NotificationOrgConfigCard organizationId="org-a" canEdit={false}/>);
 expect(screen.getByText(/Khung yên dài 14 giờ/)).toBeTruthy();
 expect(screen.getByText(/chỉ có quyền xem/)).toBeTruthy();
 for(const s of screen.getAllByRole('switch')) expect((s as HTMLButtonElement).disabled).toBe(true);
});
