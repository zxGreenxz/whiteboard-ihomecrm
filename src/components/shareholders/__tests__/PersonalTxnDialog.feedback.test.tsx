// @vitest-environment jsdom
import {cleanup,fireEvent,render,screen,waitFor} from '@testing-library/react';
import {afterEach,expect,it,vi} from 'vitest';
const io=vi.hoisted(()=>({create:vi.fn(),update:vi.fn()}));
vi.mock('@/hooks/usePersonalTransactions',()=>({useCreatePersonalTransaction:()=>({mutateAsync:io.create,isPending:false}),useUpdatePersonalTransaction:()=>({mutateAsync:io.update,isPending:false})}));
import PersonalTxnDialog from '../PersonalTxnDialog';
import {FinancialWorkflowError} from '@/lib/financialWorkflow';
afterEach(()=>{cleanup();vi.resetAllMocks();});
function amount(){return screen.getByRole('textbox',{name:'Số tiền'});}
it('manual action blocks an invalid date draft instead of submitting the earlier valid state',async()=>{
 render(<PersonalTxnDialog open onOpenChange={vi.fn()} txn={null}/>);
 fireEvent.change(screen.getByPlaceholderText('0'),{target:{value:'100'}});
 fireEvent.change(screen.getByPlaceholderText('dd/mm/yyyy'),{target:{value:'31/02/2026'}});
 fireEvent.click(screen.getByRole('button',{name:'Lưu'}));
 await waitFor(()=>expect(screen.getByPlaceholderText('dd/mm/yyyy').getAttribute('aria-invalid')).toBe('true'));
 expect(io.create).not.toHaveBeenCalled();
});
it('unknown response shows receipt IDs, retains draft through close/reopen, and blocks repeat',async()=>{
 io.create.mockRejectedValueOnce(new FinancialWorkflowError('Chưa xác nhận ví.','unknown',[{id:'txn-1',label:'Khoản cần đối chiếu'}]));
 const close=vi.fn();const view=render(<PersonalTxnDialog open onOpenChange={close} txn={null}/>);
 fireEvent.change(screen.getByPlaceholderText('0'),{target:{value:'100'}});fireEvent.change(screen.getByPlaceholderText('VD: Ăn uống, Nhà cửa...'),{target:{value:'Draft giữ'}});
 fireEvent.click(screen.getByRole('button',{name:'Lưu'}));await waitFor(()=>expect(io.create).toHaveBeenCalledTimes(1));await screen.findByRole('alert');
 view.rerender(<PersonalTxnDialog open={false} onOpenChange={close} txn={null}/>);view.rerender(<PersonalTxnDialog open onOpenChange={close} txn={null}/>);
 expect((screen.getByPlaceholderText('VD: Ăn uống, Nhà cửa...') as HTMLInputElement).value).toBe('Draft giữ');expect(screen.getByRole('alert').textContent).toContain('txn-1');fireEvent.click(screen.getByRole('button',{name:'Lưu'}));expect(io.create).toHaveBeenCalledTimes(1);expect(close).not.toHaveBeenCalled();
});