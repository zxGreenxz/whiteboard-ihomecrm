// @vitest-environment jsdom
import {cleanup,fireEvent,render,screen,waitFor} from '@testing-library/react';
import {afterEach,expect,it,vi} from 'vitest';
const io=vi.hoisted(()=>({remove:vi.fn()}));
vi.mock('@/hooks/useCustomers',()=>({useDeleteCustomer:()=>({mutate:vi.fn(),mutateAsync:io.remove,isPending:false})}));
import DeleteCustomerDialog from '../DeleteCustomerDialog';
import {RepeatableWriteUnknownError} from '@/lib/financialWorkflow';
afterEach(()=>{cleanup();vi.resetAllMocks();});
// Đợt 8 (luật 5): xoá khách là xoá mềm theo mã, bấm lại an toàn (hàm xoá chỉ xoá khách còn sống; đã xoá thì báo thành
// công). Kết quả chưa rõ: hộp giữ mở, báo mã, KHÔNG khoá nút Xoá.
it('unconfirmed deletion keeps the dialog open with the ID and lets the user delete again',async()=>{
 io.remove.mockRejectedValueOnce(new RepeatableWriteUnknownError('xoá khách hàng',new TypeError('Failed to fetch'),[{id:'c1',label:'Khách hàng cần đối chiếu'}])).mockResolvedValueOnce({id:'c1',alreadyDeleted:true});
 const close=vi.fn();const props={open:true,onOpenChange:close,customerId:'c1',customerName:'An'};const view=render(<DeleteCustomerDialog {...props}/>);
 fireEvent.click(screen.getByRole('button',{name:'Xoá'}));await waitFor(()=>expect(screen.getByRole('alert').textContent).toContain('c1'));expect(close).not.toHaveBeenCalled();
 expect(screen.getByRole('alert').textContent).toContain('Bấm lại');
 view.rerender(<DeleteCustomerDialog {...props} open={false}/>);view.rerender(<DeleteCustomerDialog {...props}/>);
 const again=screen.getByRole('button',{name:'Xoá'});expect((again as HTMLButtonElement).disabled).toBe(false);
 fireEvent.click(again);await waitFor(()=>expect(close).toHaveBeenCalledWith(false));expect(io.remove).toHaveBeenCalledTimes(2);
});
// Bước đọc trước lệnh xoá (trạng thái khách, hợp đồng hiệu lực) hỏng mạng: chưa ghi gì, hộp không khoá.
it('a network failure before the delete leaves the delete button usable',async()=>{
 io.remove.mockRejectedValueOnce(new TypeError('Failed to fetch')).mockResolvedValueOnce({id:'c1'});
 const close=vi.fn();render(<DeleteCustomerDialog open onOpenChange={close} customerId="c1" customerName="An"/>);
 fireEvent.click(screen.getByRole('button',{name:'Xoá'}));await waitFor(()=>expect(screen.getByRole('alert')).toBeTruthy());
 const again=screen.getByRole('button',{name:'Xoá'});expect((again as HTMLButtonElement).disabled).toBe(false);
 fireEvent.click(again);await waitFor(()=>expect(close).toHaveBeenCalledWith(false));expect(io.remove).toHaveBeenCalledTimes(2);
});
