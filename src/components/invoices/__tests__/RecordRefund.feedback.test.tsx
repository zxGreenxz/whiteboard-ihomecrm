import type {ComponentProps,ReactNode} from 'react';
// @vitest-environment jsdom
import {cleanup,fireEvent,render,screen,waitFor} from '@testing-library/react';
import {beforeEach,afterEach,it,expect,vi} from 'vitest';
const h=vi.hoisted(()=>({write:vi.fn(),close:vi.fn()}));
vi.mock('@/hooks/useInvoicePayments',()=>({useRecordRefundRPC:()=>({mutateAsync:h.write,isPending:false})}));
vi.mock('@/hooks/useAccounts',()=>({useAccounts:()=>({data:[{id:'a1',name:'Demo'}]})}));
vi.mock('@/components/ui/select',()=>({Select:({children}:{children:ReactNode})=><select>{children}</select>,SelectTrigger:()=>null,SelectValue:()=>null,SelectContent:({children}:{children:ReactNode})=><>{children}</>,SelectItem:({value,children}:{value:string;children:ReactNode})=><option value={value}>{children}</option>}));
import RecordRefundDialog from '../RecordRefundDialog';
import {FinancialWorkflowError} from '@/lib/financialWorkflow';
const view=()=>render(<RecordRefundDialog open onOpenChange={h.close} invoice={{id:'i1',total_amount:-700,paid_amount:0,building:{name:'Demo'}} as unknown as ComponentProps<typeof RecordRefundDialog>['invoice']}/>);
beforeEach(()=>{vi.clearAllMocks();h.write.mockResolvedValue({id:'rv1'});});afterEach(cleanup);
it.each(['-100','100abc','1,5'])('số tiền draft %s giữ nguyên, đỏ và focus, không gửi khoản tiền khác',async value=>{
 view();const amount=screen.getByRole('textbox',{name:'Số tiền hoàn trả *'});fireEvent.change(amount,{target:{value}});fireEvent.click(screen.getByRole('button',{name:'Lập phiếu chi'}));
 await waitFor(()=>expect(amount.getAttribute('aria-invalid')).toBe('true'));expect(amount).toHaveProperty('value',value);await waitFor(()=>expect(document.activeElement).toBe(amount));expect(h.write).not.toHaveBeenCalled();expect(h.close).not.toHaveBeenCalled();
});
it('ngày draft sai không dùng ngày cũ để lập phiếu',async()=>{
 view();const date=screen.getByRole('textbox',{name:'Ngày hoàn trả *'});fireEvent.change(date,{target:{value:'31112026'}});fireEvent.click(screen.getByRole('button',{name:'Lập phiếu chi'}));
 await waitFor(()=>expect(date.getAttribute('aria-invalid')).toBe('true'));await waitFor(()=>expect(document.activeElement).toBe(date));expect(h.write).not.toHaveBeenCalled();
});
it('partial hoàn trả giữ ID và draft, khóa lập lại; không đóng form',async()=>{
 h.write.mockRejectedValue(new FinancialWorkflowError('Đã lập phiếu rv1; cần đối chiếu trạng thái.','partial',[{id:'rv1',label:'Phiếu rv1'}],new TypeError('Failed to fetch')));view();
 fireEvent.change(screen.getByRole('textbox',{name:'Ghi chú'}),{target:{value:'Giữ nội dung hoàn trả'}});fireEvent.click(screen.getByRole('button',{name:'Lập phiếu chi'}));
 await screen.findByRole('alert');expect(screen.getByRole('alert').textContent).toContain('rv1');expect(screen.getByRole('button',{name:'Lập phiếu chi'})).toHaveProperty('disabled',true);expect(screen.getByRole('textbox',{name:'Ghi chú'})).toHaveProperty('value','Giữ nội dung hoàn trả');expect(h.close).not.toHaveBeenCalled();
});
