// @vitest-environment jsdom
import {cleanup,fireEvent,render,screen,waitFor} from '@testing-library/react';
import {afterEach,expect,it,vi} from 'vitest';
const io=vi.hoisted(()=>({remove:vi.fn()}));
vi.mock('@/hooks/useCustomers',()=>({useDeleteCustomer:()=>({mutate:vi.fn(),mutateAsync:io.remove,isPending:false})}));
import DeleteCustomerDialog from '../DeleteCustomerDialog';
import {FinancialWorkflowError} from '@/lib/financialWorkflow';
afterEach(()=>{cleanup();vi.resetAllMocks();});
it('unconfirmed deletion keeps the dialog open with the ID and prevents replay',async()=>{
 io.remove.mockRejectedValue(new FinancialWorkflowError('Chưa xác nhận xoá.','unknown',[{id:'c1',label:'Khách hàng cần đối chiếu'}]));const close=vi.fn();const props={open:true,onOpenChange:close,customerId:'c1',customerName:'An'};const view=render(<DeleteCustomerDialog {...props}/>);
 fireEvent.click(screen.getByRole('button',{name:'Xoá'}));await waitFor(()=>expect(screen.getByRole('alert').textContent).toContain('c1'));expect(close).not.toHaveBeenCalled();
 view.rerender(<DeleteCustomerDialog {...props} open={false}/>);view.rerender(<DeleteCustomerDialog {...props}/>);fireEvent.click(screen.getByRole('button',{name:'Xoá'}));expect(io.remove).toHaveBeenCalledTimes(1);
});
