// @vitest-environment jsdom
import {beforeEach,afterEach,expect,it,vi} from 'vitest';
import {cleanup,render,screen,fireEvent,waitFor} from '@testing-library/react';
const h=vi.hoisted(()=>({record:vi.fn(),recent:vi.fn(),close:vi.fn(),accounts:[{id:'book',name:'Sổ thu',is_virtual:false,organization_id:'org'}],books:{collectorUserId:'u1',personalCashBook:{id:'book',name:'Sổ thu'},TK:[],TT:[]}}));
vi.mock('@/hooks/useInvoicePayments',()=>({useRecordPaymentRPC:()=>({mutateAsync:h.record,isPending:false})}));
vi.mock('@/hooks/useAccounts',()=>({useAccounts:()=>({data:h.accounts})}));
vi.mock('@/hooks/useAuth',()=>({useAuth:()=>({data:{id:'u1'}})}));
vi.mock('@/hooks/useReceivingCashbooks',async original=>({...await original<typeof import('@/hooks/useReceivingCashbooks')>(),useReceivingCashbooks:()=>({data:h.books,isError:false})}));
vi.mock('@/hooks/useCollectionTenders',()=>({fetchRecentInvoiceCollections:h.recent}));
vi.mock('@/hooks/useClipboardImagePaste',()=>({useClipboardImagePaste:()=>({})}));
import RecordPaymentDialog from '../RecordPaymentDialog';
const invoice={id:'invoice',organization_id:'org',building_id:'b1',invoice_number:'HD01',total_amount:100000,paid_amount:0,invoice_items:[],payments:[],contract_id:'contract'};
beforeEach(()=>{vi.stubGlobal('ResizeObserver',class {observe(){} unobserve(){} disconnect(){}});vi.clearAllMocks();h.record.mockReset();h.recent.mockResolvedValue([]);HTMLElement.prototype.scrollIntoView=vi.fn();});
afterEach(cleanup);
const show=()=>render(<RecordPaymentDialog open onOpenChange={h.close} invoice={invoice as never}/>);
it('D06 tiền không hợp lệ focus đúng ô và aria-invalid, không gửi',async()=>{
 show();const amount=screen.getByLabelText('Tiền khách đưa *');
 fireEvent.change(amount,{target:{value:'0'}});fireEvent.click(screen.getByRole('button',{name:'Ghi nhận thanh toán'}));
 await waitFor(()=>expect(document.activeElement).toBe(amount));expect(amount.getAttribute('aria-invalid')).toBe('true');expect(h.record).not.toHaveBeenCalled();
});
it('D08 đọc recent lỗi không cho bỏ qua',async()=>{
 h.recent.mockRejectedValueOnce(new TypeError('Failed to fetch'));show();
 fireEvent.click(screen.getByRole('button',{name:'Ghi nhận thanh toán'}));
 expect(await screen.findByText(/Chưa kiểm tra được các khoản thu gần đây/)).toBeTruthy();
 expect(screen.queryByRole('button',{name:'Vẫn thu tiếp'})).toBeNull();expect(h.record).not.toHaveBeenCalled();expect(h.close).not.toHaveBeenCalled();
});
it('D05 timeout sau gửi giữ form và khóa gửi tiếp',async()=>{
 h.record.mockRejectedValueOnce(new TypeError('Failed to fetch'));show();
 fireEvent.click(screen.getByRole('button',{name:'Ghi nhận thanh toán'}));
 expect(await screen.findByText(/Chưa xác nhận được kết quả thu tiền/)).toBeTruthy();
 expect((screen.getByRole('button',{name:'Ghi nhận thanh toán'}) as HTMLButtonElement).disabled).toBe(true);
 expect(h.record).toHaveBeenCalledOnce();expect(h.close).not.toHaveBeenCalled();
});
