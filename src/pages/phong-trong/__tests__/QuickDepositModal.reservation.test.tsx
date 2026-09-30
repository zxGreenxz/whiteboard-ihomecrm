// @vitest-environment jsdom
import {cleanup,fireEvent,render,screen,waitFor} from '@testing-library/react';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {QuickDepositModal} from '../QuickDepositModal';
import type {Room} from '../sampleData';
const m=vi.hoisted(()=>({create:vi.fn(),legacy:vi.fn(),rpc:vi.fn(),error:vi.fn(),options:vi.fn()}));
vi.mock('@/hooks/useRoomReservations',()=>({useCreateRoomReservation:(options:unknown)=>{m.options(options);return{mutateAsync:m.create,isPending:false};}}));
vi.mock('@/hooks/useAccounts',()=>({useAccounts:()=>({data:[{id:'account1',user_id:'user1',name:'Sổ thu',is_default:true}]})}));
vi.mock('@/lib/authSession',()=>({getSessionUser:async()=>({id:'user1'})}));
vi.mock('@/hooks/useIncomeExpenses',()=>({useCreateIncomeExpense:()=>({mutateAsync:m.legacy})}));
vi.mock('@/integrations/supabase/client',()=>({supabase:{rpc:m.rpc}}));
vi.mock('@/components/contracts/CustomerSelectionDialog',()=>({CustomerSelectionDialog:({open,onSelect}:{open:boolean;onSelect:(v:unknown[])=>void})=>open?<button onClick={()=>onSelect([{id:'customer1',full_name:'Khách A',phone:'0900',id_number:null}])}>Chọn Khách A</button>:null}));
vi.mock('../useTracking',()=>({useTrack:()=>({track:vi.fn(),trackError:vi.fn()})}));
vi.mock('sonner',()=>({toast:{error:m.error}}));
vi.mock('@tanstack/react-query',()=>({useQueryClient:()=>({invalidateQueries:vi.fn()})}));
const room={id:'room1',buildingId:'building1',buildingName:'Tòa A',no:101,code:'101',price:5} as Room;
afterEach(cleanup);beforeEach(()=>{vi.clearAllMocks();m.create.mockResolvedValue({status:'HOLD',receipts:[]});});
describe('quick hold and receipt are separate actions',()=>{
 it('requires concrete customer and zero hold never creates a money voucher',async()=>{
  render(<QuickDepositModal room={room} onClose={vi.fn()} onDone={vi.fn()}/>);
  fireEvent.click(screen.getByRole('button',{name:'Giữ chỗ 0 đồng'}));expect(m.create).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button',{name:'Chọn khách hàng'}));fireEvent.click(screen.getByRole('button',{name:'Chọn Khách A'}));fireEvent.click(screen.getByRole('button',{name:'Giữ chỗ 0 đồng'}));expect(m.create).not.toHaveBeenCalled();
  fireEvent.change(screen.getByLabelText(/Giữ chỗ đến/),{target:{value:'2026-09-29'}});fireEvent.click(screen.getByRole('button',{name:'Giữ chỗ 0 đồng'}));
  await waitFor(()=>expect(m.create).toHaveBeenCalledOnce());expect(m.create.mock.calls[0][0]).toMatchObject({roomId:'room1',customerId:'customer1'});expect(m.create.mock.calls[0][0]).not.toHaveProperty('receipt');expect(m.legacy).not.toHaveBeenCalled();expect(m.rpc).not.toHaveBeenCalled();
 });
 it('positive deposit requires an explicit amount and retry preserves the intent key',async()=>{
  m.create.mockRejectedValue({message:'Timeout'});render(<QuickDepositModal room={room} onClose={vi.fn()} onDone={vi.fn()}/>);
  fireEvent.click(screen.getByRole('button',{name:'Chọn khách hàng'}));fireEvent.click(screen.getByRole('button',{name:'Chọn Khách A'}));fireEvent.click(screen.getByLabelText('Có nhận cọc'));
  fireEvent.click(screen.getByRole('button',{name:'Tạo cọc & giữ chỗ'}));expect(m.create).not.toHaveBeenCalled();
  fireEvent.change(screen.getByLabelText('Số tiền cọc'),{target:{value:'100000'}});fireEvent.change(screen.getByLabelText('Sổ quỹ nhận cọc'),{target:{value:'account1'}});fireEvent.click(screen.getByRole('button',{name:'Tạo cọc & giữ chỗ'}));await waitFor(()=>expect(m.create).toHaveBeenCalledOnce());
  fireEvent.click(screen.getByRole('button',{name:'Tạo cọc & giữ chỗ'}));await waitFor(()=>expect(m.create).toHaveBeenCalledTimes(2));expect(m.create.mock.calls[0][0].idempotencyKey).toBe(m.create.mock.calls[1][0].idempotencyKey);expect(m.create.mock.calls[0][0].receipt).toMatchObject({amount:100000,accountId:'account1'});
 });
});

it('marks each required field inline and focuses the first invalid field before writing', async()=>{
 render(<QuickDepositModal room={room} onClose={vi.fn()} onDone={vi.fn()}/>);
 fireEvent.click(screen.getByRole('button',{name:'Giữ chỗ 0 đồng'}));
 const customer=screen.getByRole('button',{name:'Chọn khách hàng'});
 expect(customer.getAttribute('aria-invalid')).toBe('true');expect(document.activeElement).toBe(customer);
 fireEvent.click(customer);fireEvent.click(screen.getByRole('button',{name:'Chọn Khách A'}));
 fireEvent.click(screen.getByRole('button',{name:'Giữ chỗ 0 đồng'}));
 const deadline=screen.getByLabelText(/Giữ chỗ đến/);expect(deadline.getAttribute('aria-invalid')).toBe('true');expect(document.activeElement).toBe(deadline);
 fireEvent.click(screen.getByLabelText('Có nhận cọc'));fireEvent.click(screen.getByRole('button',{name:'Tạo cọc & giữ chỗ'}));
 const amount=screen.getByLabelText('Số tiền cọc');expect(amount.getAttribute('aria-invalid')).toBe('true');expect(document.activeElement).toBe(amount);
 fireEvent.change(amount,{target:{value:'100000'}});
 const account=screen.getByLabelText('Sổ quỹ nhận cọc');fireEvent.change(account,{target:{value:''}});
 fireEvent.click(screen.getByRole('button',{name:'Tạo cọc & giữ chỗ'}));expect(account.getAttribute('aria-invalid')).toBe('true');expect(document.activeElement).toBe(account);
 expect(m.create).not.toHaveBeenCalled();
});
it.each(['-100000','12abc','1,5'])('retains invalid money %s and never rewrites it into another amount',async raw=>{
 render(<QuickDepositModal room={room} onClose={vi.fn()} onDone={vi.fn()}/>);
 fireEvent.click(screen.getByRole('button',{name:'Chọn khách hàng'}));fireEvent.click(screen.getByRole('button',{name:'Chọn Khách A'}));fireEvent.click(screen.getByLabelText('Có nhận cọc'));
 const amount=screen.getByLabelText('Số tiền cọc');fireEvent.change(amount,{target:{value:raw}});
 fireEvent.click(screen.getByRole('button',{name:'Tạo cọc & giữ chỗ'}));
 expect((amount as HTMLInputElement).value).toBe(raw);expect(amount.getAttribute('aria-invalid')).toBe('true');expect(document.activeElement).toBe(amount);expect(m.create).not.toHaveBeenCalled();
});
it('lets the modal own one safe inline failure and retains the entered deposit',async()=>{
 m.create.mockRejectedValue({code:'42501',message:'permission denied for relation secret_table'});
 const close=vi.fn();render(<QuickDepositModal room={room} onClose={close} onDone={vi.fn()}/>);
 fireEvent.click(screen.getByRole('button',{name:'Chọn khách hàng'}));fireEvent.click(screen.getByRole('button',{name:'Chọn Khách A'}));fireEvent.click(screen.getByLabelText('Có nhận cọc'));
 fireEvent.change(screen.getByLabelText('Số tiền cọc'),{target:{value:'100000'}});
 await waitFor(()=>expect((screen.getByLabelText('Sổ quỹ nhận cọc') as HTMLSelectElement).value).toBe('account1'));
 fireEvent.click(screen.getByRole('button',{name:'Tạo cọc & giữ chỗ'}));
 await waitFor(()=>expect(screen.getByRole('alert').textContent).toMatch(/không có quyền/i));
 expect(m.options).toHaveBeenCalledWith({silent:true});expect(m.error).not.toHaveBeenCalled();expect(close).not.toHaveBeenCalled();
 expect((screen.getByLabelText('Số tiền cọc') as HTMLInputElement).value).toBe('100.000');expect(screen.getByRole('alert').textContent).not.toContain('secret_table');
});
