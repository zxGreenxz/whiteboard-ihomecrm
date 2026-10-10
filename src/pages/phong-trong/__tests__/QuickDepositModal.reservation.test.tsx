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
const room={id:'room1',buildingId:'building1',buildingName:'Tòa A',no:101,code:'101',price:5,status:'free'} as Room;
const submit=()=>fireEvent.click(screen.getByRole('button',{name:'Lưu cọc & giữ phòng'}));
const pickCustomer=()=>{fireEvent.click(screen.getByRole('button',{name:'Chọn khách trong danh bạ'}));fireEvent.click(screen.getByRole('button',{name:'Chọn Khách A'}));};
afterEach(cleanup);beforeEach(()=>{vi.clearAllMocks();m.create.mockResolvedValue({status:'HOLD',receipts:[]});});
describe('nhận cọc: luôn có tiền, khách trong danh bạ hoặc tên gợi nhớ',()=>{
 it('a typed reminder name is sent as customerHint with a positive receipt and no customer id',async()=>{
  const done=vi.fn();render(<QuickDepositModal room={room} onClose={vi.fn()} onDone={done}/>);
  expect(screen.queryByText(/Giữ chỗ 0 đồng/)).toBeNull();
  fireEvent.change(screen.getByLabelText('Tên khách gợi nhớ'),{target:{value:'  anh Tuấn xem 18h '}});
  fireEvent.change(screen.getByLabelText('Số tiền cọc'),{target:{value:'500000'}});
  await waitFor(()=>expect((screen.getByLabelText('Sổ quỹ nhận cọc') as HTMLSelectElement).value).toBe('account1'));
  submit();await waitFor(()=>expect(m.create).toHaveBeenCalledOnce());
  const input=m.create.mock.calls[0][0];
  expect(input).toMatchObject({roomId:'room1',customerHint:'anh Tuấn xem 18h',receipt:{amount:500000,accountId:'account1'}});
  expect(input).not.toHaveProperty('customerId');
  expect(done.mock.calls[0][0]).toMatch(/nhớ gắn khách/);expect(m.legacy).not.toHaveBeenCalled();expect(m.rpc).not.toHaveBeenCalled();
 });
 it('a picked customer replaces the reminder name and retry preserves the intent key',async()=>{
  m.create.mockRejectedValue({message:'Timeout'});render(<QuickDepositModal room={room} onClose={vi.fn()} onDone={vi.fn()}/>);
  fireEvent.change(screen.getByLabelText('Tên khách gợi nhớ'),{target:{value:'Chị Lan'}});pickCustomer();
  expect(screen.queryByLabelText('Tên khách gợi nhớ')).toBeNull();
  fireEvent.change(screen.getByLabelText('Số tiền cọc'),{target:{value:'100000'}});fireEvent.change(screen.getByLabelText('Sổ quỹ nhận cọc'),{target:{value:'account1'}});
  submit();await waitFor(()=>expect(m.create).toHaveBeenCalledOnce());
  submit();await waitFor(()=>expect(m.create).toHaveBeenCalledTimes(2));
  expect(m.create.mock.calls[0][0]).toMatchObject({customerId:'customer1',receipt:{amount:100000,accountId:'account1'}});expect(m.create.mock.calls[0][0]).not.toHaveProperty('customerHint');
  expect(m.create.mock.calls[0][0].idempotencyKey).toBe(m.create.mock.calls[1][0].idempotencyKey);
 });
 it('tells staff that saving a deposit on a locked room releases the lock',()=>{
  render(<QuickDepositModal room={{...room,status:'locked',saleLock:{id:'l1',hours:24,note:null,lockedAt:'2026-10-10T00:00:00Z',expiresAt:new Date(Date.now()+5*3600_000).toISOString(),lockedByName:'Sale A',lockedByMe:false}}} onClose={vi.fn()} onDone={vi.fn()}/>);
  expect(screen.getByText(/lock tạm bởi Sale A \(còn 5 giờ\)\. Lưu phiếu cọc sẽ gỡ lock/)).toBeTruthy();
 });
});

it('marks each required field inline and focuses the first invalid field before writing', async()=>{
 render(<QuickDepositModal room={room} onClose={vi.fn()} onDone={vi.fn()}/>);
 submit();
 const customer=screen.getByLabelText('Tên khách gợi nhớ');
 expect(customer.getAttribute('aria-invalid')).toBe('true');expect(document.activeElement).toBe(customer);
 fireEvent.change(customer,{target:{value:'Chị Lan'}});submit();
 const amount=screen.getByLabelText('Số tiền cọc');expect(amount.getAttribute('aria-invalid')).toBe('true');expect(document.activeElement).toBe(amount);
 fireEvent.change(amount,{target:{value:'100000'}});
 const account=screen.getByLabelText('Sổ quỹ nhận cọc');fireEvent.change(account,{target:{value:''}});
 submit();expect(account.getAttribute('aria-invalid')).toBe('true');expect(document.activeElement).toBe(account);
 expect(m.create).not.toHaveBeenCalled();
});
it.each(['-100000','12abc','1,5'])('retains invalid money %s and never rewrites it into another amount',async raw=>{
 render(<QuickDepositModal room={room} onClose={vi.fn()} onDone={vi.fn()}/>);
 pickCustomer();
 const amount=screen.getByLabelText('Số tiền cọc');fireEvent.change(amount,{target:{value:raw}});
 submit();
 expect((amount as HTMLInputElement).value).toBe(raw);expect(amount.getAttribute('aria-invalid')).toBe('true');expect(document.activeElement).toBe(amount);expect(m.create).not.toHaveBeenCalled();
});
it('lets the modal own one safe inline failure and retains the entered deposit',async()=>{
 m.create.mockRejectedValue({code:'42501',message:'permission denied for relation secret_table'});
 const close=vi.fn();render(<QuickDepositModal room={room} onClose={close} onDone={vi.fn()}/>);
 pickCustomer();
 fireEvent.change(screen.getByLabelText('Số tiền cọc'),{target:{value:'100000'}});
 await waitFor(()=>expect((screen.getByLabelText('Sổ quỹ nhận cọc') as HTMLSelectElement).value).toBe('account1'));
 submit();
 await waitFor(()=>expect(screen.getByRole('alert').textContent).toMatch(/không có quyền/i));
 expect(m.options).toHaveBeenCalledWith({silent:true});expect(m.error).not.toHaveBeenCalled();expect(close).not.toHaveBeenCalled();
 expect((screen.getByLabelText('Số tiền cọc') as HTMLInputElement).value).toBe('100.000');expect(screen.getByRole('alert').textContent).not.toContain('secret_table');
});
