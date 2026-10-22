// @vitest-environment jsdom
import {beforeEach,describe,expect,it,vi} from 'vitest';
import {cleanup,fireEvent,render,screen,waitFor} from '@testing-library/react';
const h=vi.hoisted(()=>({rpc:vi.fn(),close:vi.fn()}));
vi.mock('@/hooks/useReservationHoldDeadlines',()=>({useSetReservationHoldTerms:()=>({isPending:false,mutate:h.rpc})}));
import {HoldDeadlineDialog} from '../HoldDeadlineDialog';
const target={voucherId:'voucher1',buildingId:'b1',label:'Cọc phòng 101',holdUntil:'2026-10-03',topupDueDate:'2026-10-01',depositTarget:1000000,paidAmount:500000};
beforeEach(()=>{cleanup();vi.clearAllMocks();});
const view=()=>render(<HoldDeadlineDialog target={target} onOpenChange={h.close}/>);
describe('D16 kỳ hạn giữ draft invalid trước nút manual',()=>{
 it.each(['Hạn phải làm hợp đồng','Hạn bổ sung'])('ngày31/02 tại %s không gửi ngày state cũ',async label=>{
  view();const input=screen.getByRole('textbox',{name:label});
  fireEvent.change(input,{target:{value:'31022026'}});
  fireEvent.click(screen.getByRole('button',{name:'Lưu kỳ hạn'}));
  expect(h.rpc).not.toHaveBeenCalled();expect(h.close).not.toHaveBeenCalled();
  expect(input.getAttribute('aria-invalid')).toBe('true');expect((input as HTMLInputElement).value).toBe('31/02/2026');
  await waitFor(()=>expect(document.activeElement).toBe(input));
 });
 it('tiền raw âm không thành0 khi state nhận Number(v)||0',async()=>{
  view();const input=screen.getByRole('textbox',{name:'Cọc cần đủ'});
  fireEvent.change(input,{target:{value:'-1000'}});fireEvent.click(screen.getByRole('button',{name:'Lưu kỳ hạn'}));
  expect(h.rpc).not.toHaveBeenCalled();expect((input as HTMLInputElement).value).toBe('-1000');expect(input.getAttribute('aria-invalid')).toBe('true');
  await waitFor(()=>expect(document.activeElement).toBe(input));
 });
 it('xóa toàn bộ kỳ hạn vẫn gửi null chủ ý khi draft ngày invalid',()=>{
  view();fireEvent.change(screen.getByRole('textbox',{name:'Hạn bổ sung'}),{target:{value:'31022026'}});
  fireEvent.click(screen.getByRole('button',{name:/Bỏ hết kỳ hạn/}));
  expect(h.rpc).toHaveBeenCalledWith({incomeExpenseId:'voucher1',holdUntil:null,topupDueDate:null,depositTarget:null},expect.any(Object));
 });
 it.each([null,0])('thực nhận %s không được diễn giải thành mệnh giá hay tiền của cả phòng',paidAmount=>{
  render(<HoldDeadlineDialog target={{...target,paidAmount,receivedFactStatus:paidAmount===null?'UNKNOWN':'VERIFIED'}} onOpenChange={h.close}/>);
  expect(screen.queryByText(/Đã thu trên phòng này/)).toBeNull();
  if(paidAmount===null){
   expect(screen.queryByText(/Đã xác nhận thực nhận của hồ sơ/)).toBeNull();
   expect(screen.getByText(/Còn phiếu chưa đối chiếu được tiền thực nhận/)).toBeTruthy();
  }else{
   expect(screen.getByText(/Đã xác nhận thực nhận của hồ sơ: 0/)).toBeTruthy();
  }
 });
});
