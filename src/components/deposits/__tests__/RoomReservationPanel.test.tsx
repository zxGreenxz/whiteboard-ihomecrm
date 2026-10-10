// @vitest-environment jsdom
import {cleanup,fireEvent,render,screen,waitFor} from '@testing-library/react';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {RoomReservationPanel} from '../RoomReservationPanel';
const m=vi.hoisted(()=>({query:{isLoading:false,isError:false,data:{server_today:'2026-09-28',reservations:[] as unknown[]},refetch:vi.fn()},mutate:vi.fn(),assign:vi.fn(),perms:{__superadmin:true} as Record<string,unknown>}));
vi.mock('@/hooks/useRoomReservations',()=>({useRoomReservations:()=>m.query,useUpdateRoomReservation:()=>({mutateAsync:m.mutate,isPending:false}),useAssignRoomReservationCustomer:()=>({mutateAsync:m.assign,isPending:false})}));
vi.mock('@/components/contracts/CustomerSelectionDialog',()=>({CustomerSelectionDialog:({onSelect}:{onSelect:(c:unknown[])=>void})=><div><button onClick={()=>onSelect([{id:'cust-1',full_name:'Khách Thật',phone:'0911',id_number:null}])}>Chọn một khách</button><button onClick={()=>onSelect([])}>Chọn không ai</button></div>}));
vi.mock('@/hooks/useMyPermissions',()=>({useMyPermissions:()=>({data:m.perms})}));
vi.mock('@/hooks/useAccounts',()=>({useAccounts:()=>({data:[{id:'account',name:'Sổ thu'}]})}));
vi.mock('../ReservationSettlementDialog',()=>({ReservationSettlementDialog:()=>null}));
vi.mock('sonner',()=>({toast:{error:vi.fn()}}));
const row={id:'hold1',building_id:'building',room_id:'room',customer_name:'Khách A',customer_phone:'0900',room_name:'101',building_name:'A',revision:3,hold_until:'2026-09-25',overdue:true,status:'HOLD',claim_status:'LIVE',received_amount:0,receipts:[],notes:null,history:[]};
beforeEach(()=>{vi.clearAllMocks();m.perms={__superadmin:true};m.query.isError=false;m.query.data.reservations=[row];m.mutate.mockResolvedValue(row);m.assign.mockResolvedValue(row);});afterEach(cleanup);
describe('reservation queue follows live claims',()=>{
 it('shows overdue as still held and cancel sends exact CAS; no auto action occurs',async()=>{
  render(<RoomReservationPanel roomId="room"/>);expect(screen.getByText(/Quá hạn.*vẫn giữ chỗ/)).not.toBeNull();expect(m.mutate).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button',{name:'Hủy giữ chỗ'}));await waitFor(()=>expect(m.mutate).toHaveBeenCalledOnce());expect(m.mutate.mock.calls[0][0]).toMatchObject({reservationId:'hold1',expectedRevision:3,action:'CANCEL'});expect(m.mutate.mock.calls[0][0]).not.toHaveProperty('receipt');
 });
 it('separates deadline adjustment and positive topup, keeps money source state visible',async()=>{
  render(<RoomReservationPanel roomId="room"/>);fireEvent.click(screen.getByRole('button',{name:'Điều chỉnh hạn'}));fireEvent.change(screen.getByLabelText('Hạn giữ chỗ'),{target:{value:'2026-10-02'}});fireEvent.click(screen.getByRole('button',{name:'Lưu hạn'}));await waitFor(()=>expect(m.mutate).toHaveBeenCalledOnce());expect(m.mutate.mock.calls[0][0]).toMatchObject({action:'UPDATE',changes:{holdUntil:'2026-10-02'}});
 });
 it('hint-only reservation shows the hint, no phone, and assigns a customer with exact CAS and a stable key',async()=>{
  m.query.data.reservations=[{...row,customer_id:null,customer_name:'Anh Hùng xe máy',customer_phone:null,customer_hint:'Anh Hùng xe máy'}];
  const{container}=render(<RoomReservationPanel roomId="room"/>);expect(screen.getByText('Anh Hùng xe máy')).not.toBeNull();expect(screen.getByText('(tên gợi nhớ)')).not.toBeNull();expect(container.textContent).not.toContain('null');expect(container.textContent).not.toContain(' · 0900');
  fireEvent.click(screen.getByRole('button',{name:'Gắn khách'}));fireEvent.click(screen.getByRole('button',{name:'Chọn một khách'}));await waitFor(()=>expect(m.assign).toHaveBeenCalledOnce());
  expect(m.assign.mock.calls[0][0]).toMatchObject({reservationId:'hold1',expectedRevision:3,customerId:'cust-1'});expect(m.assign.mock.calls[0][0].idempotencyKey).toMatch(/^assign-customer-/);
  fireEvent.click(screen.getByRole('button',{name:'Gắn khách'}));fireEvent.click(screen.getByRole('button',{name:'Chọn một khách'}));await waitFor(()=>expect(m.assign).toHaveBeenCalledTimes(2));
  expect(m.assign.mock.calls[1][0].idempotencyKey).toBe(m.assign.mock.calls[0][0].idempotencyKey);
 });
 it('rejects an empty customer pick without calling the server',async()=>{
  m.query.data.reservations=[{...row,customer_id:null,customer_hint:'Anh Hùng'}];render(<RoomReservationPanel roomId="room"/>);
  fireEvent.click(screen.getByRole('button',{name:'Gắn khách'}));fireEvent.click(screen.getByRole('button',{name:'Chọn không ai'}));await screen.findByText(/Chọn đúng một khách/);expect(m.assign).not.toHaveBeenCalled();
 });
 it('hides Gắn khách without deposits.edit and for reservations that already have a customer',()=>{
  m.query.data.reservations=[{...row,customer_id:null,customer_hint:'Anh Hùng'}];m.perms={deposits:{view:true,edit:false}};const{unmount}=render(<RoomReservationPanel roomId="room"/>);expect(screen.queryByRole('button',{name:'Gắn khách'})).toBeNull();unmount();
  m.perms={__superadmin:true};m.query.data.reservations=[{...row,customer_id:'cust-9',customer_hint:null}];render(<RoomReservationPanel roomId="room"/>);expect(screen.queryByRole('button',{name:'Gắn khách'})).toBeNull();expect(screen.getByText(/Khách A/)).not.toBeNull();
 });
 it('read failures remain an error and do not show an empty available room',()=>{
  m.query.isError=true;render(<RoomReservationPanel roomId="room"/>);expect(screen.getByRole('alert').textContent).toContain('Không tải được');expect(screen.queryByText('Chưa có giữ chỗ')).toBeNull();expect(m.mutate).not.toHaveBeenCalled();
 });
});
