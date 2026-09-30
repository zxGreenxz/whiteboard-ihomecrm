// @vitest-environment jsdom
import {cleanup,fireEvent,render,screen,waitFor} from '@testing-library/react';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
const m=vi.hoisted(()=>({searchError:false,retry:vi.fn(),link:vi.fn()}));
vi.mock('@/hooks/useZaloChat',()=>({useZaloOrgId:()=> 'org-a'}));
vi.mock('@/hooks/chat-zalo/useZaloCrmProfile',()=>({useSearchCustomers:()=>({data:m.searchError?undefined:[{id:'customer-a',full_name:'Nguyễn An',phone:'0901234567'}],status:m.searchError?'error':'success',fetchStatus:'idle',isError:m.searchError,isLoading:false,isFetching:false,error:m.searchError?{code:'42501',message:'private sql'}:null,refetch:m.retry}),useLinkConversation:()=>({mutate:m.link,isPending:false}),useUnlinkConversation:()=>({mutate:vi.fn(),isPending:false})}));
import BroadcastDialog from '../BroadcastDialog';
import LinkCustomerDialog from '../LinkCustomerDialog';
import ComposeNewDialog from '../ComposeNewDialog';
import ConnectZaloDialog from '../ConnectZaloDialog';
import {ZaloActionUnknownError} from '@/lib/zaloActionFeedback';
import type {ZaloConversation,ZaloAccount} from '../types';
const conv={id:'c1',name:'Hội thoại An',phone:'0901234567'} as ZaloConversation;
const account={id:'a1',name:'Zalo A',status:'connected'} as ZaloAccount;
afterEach(cleanup);beforeEach(()=>{vi.clearAllMocks();m.searchError=false});
it('lỗi tìm khách không hiện kết quả rỗng và có tải lại',async()=>{m.searchError=true;render(<LinkCustomerDialog open conv={conv} onOpenChange={vi.fn()}/>);fireEvent.change(screen.getByRole('textbox'),{target:{value:'An'}});expect(screen.getByRole('alert').textContent).not.toContain('private sql');expect(screen.queryByText('Không tìm thấy khách hàng nào.')).toBeNull();fireEvent.click(screen.getByRole('button',{name:'Tải lại'}));await waitFor(()=>expect(m.retry).toHaveBeenCalled());});
it('lỗi gắn hồ sơ giữ hộp và từ khóa, hiện lỗi an toàn',async()=>{const close=vi.fn();m.link.mockImplementation((_v,options)=>options.onError?.(new Error('private sql')));render(<LinkCustomerDialog open conv={conv} onOpenChange={close}/>);fireEvent.change(screen.getByRole('textbox'),{target:{value:'An'}});fireEvent.click(screen.getByRole('button',{name:/Nguyễn An/}));expect(screen.getByRole('alert').textContent).not.toContain('private sql');expect((screen.getByRole('textbox') as HTMLInputElement).value).toBe('An');expect(close).not.toHaveBeenCalled();});
it('số điện thoại có chữ không bị loại chữ rồi gửi sang Zalo',async()=>{const start=vi.fn();render(<ComposeNewDialog open onOpenChange={vi.fn()} accounts={[account]} conversations={[]} finding={false} onStart={start} onOpenExisting={vi.fn()}/>);const phone=screen.getByLabelText('Số điện thoại');fireEvent.change(phone,{target:{value:'090abc1234567'}});fireEvent.click(screen.getByRole('button',{name:'Bắt đầu chat'}));await waitFor(()=>expect(phone.getAttribute('aria-invalid')).toBe('true'));expect(document.activeElement).toBe(phone);expect(start).not.toHaveBeenCalled();});
it('kết nối chưa xác nhận chỉ cho đọc trạng thái, không gửi lại',()=>{const refresh=vi.fn();render(<ConnectZaloDialog open onOpenChange={vi.fn()} account={null} onRetry={vi.fn()} requestError={new ZaloActionUnknownError('khởi tạo kết nối Zalo')} onRefresh={refresh}/>);expect(screen.getByRole('alert').textContent).toContain('Chưa xác nhận');expect(screen.queryByRole('button',{name:'Thử lại'})).toBeNull();fireEvent.click(screen.getByRole('button',{name:'Đọc lại trạng thái'}));expect(refresh).toHaveBeenCalled();});

it('broadcast một phần giữ danh sách và nội dung nguyên vẹn qua đóng/mở hộp',async()=>{
 const props={onOpenChange:vi.fn(),onSend:vi.fn().mockResolvedValue(1),labels:[],conversations:[{...conv,id:'c1',name:'Khách A',sub:'',initials:'A',tone:'emerald'},{...conv,id:'c2',name:'Khách B',sub:'',initials:'B',tone:'emerald'}] as ZaloConversation[]};
 const ui=render(<BroadcastDialog open {...props}/>);fireEvent.click(screen.getByRole('button',{name:'Chọn tất cả'}));const body=screen.getByPlaceholderText('Nhập nội dung gửi tới các hội thoại đã chọn…');fireEvent.change(body,{target:{value:'Nội dung còn cần đối chiếu'}});fireEvent.click(screen.getByRole('button',{name:'Gửi tới 2'}));await screen.findByRole('alert');
 expect(screen.getByText(/chưa có kết quả từng hội thoại/)).toBeTruthy();expect((body as HTMLTextAreaElement).disabled).toBe(true);ui.rerender(<BroadcastDialog open={false} {...props}/>);ui.rerender(<BroadcastDialog open {...props}/>);expect((screen.getByPlaceholderText('Nhập nội dung gửi tới các hội thoại đã chọn…') as HTMLTextAreaElement).value).toBe('Nội dung còn cần đối chiếu');expect((screen.getByRole('button',{name:'Gửi tới 2'}) as HTMLButtonElement).disabled).toBe(true);
});
