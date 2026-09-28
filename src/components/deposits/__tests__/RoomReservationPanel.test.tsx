// @vitest-environment jsdom
import {cleanup,fireEvent,render,screen,waitFor} from '@testing-library/react';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {RoomReservationPanel} from '../RoomReservationPanel';
const m=vi.hoisted(()=>({query:{isLoading:false,isError:false,data:{server_today:'2026-09-28',reservations:[] as unknown[]},refetch:vi.fn()},mutate:vi.fn()}));
vi.mock('@/hooks/useRoomReservations',()=>({useRoomReservations:()=>m.query,useUpdateRoomReservation:()=>({mutateAsync:m.mutate,isPending:false})}));
vi.mock('@/hooks/useMyPermissions',()=>({useMyPermissions:()=>({data:{__superadmin:true}})}));
vi.mock('@/hooks/useAccounts',()=>({useAccounts:()=>({data:[{id:'account',name:'Sổ thu'}]})}));
vi.mock('../ReservationSettlementDialog',()=>({ReservationSettlementDialog:()=>null}));
vi.mock('sonner',()=>({toast:{error:vi.fn()}}));
const row={id:'hold1',building_id:'building',room_id:'room',customer_name:'Khách A',customer_phone:'0900',room_name:'101',building_name:'A',revision:3,hold_until:'2026-09-25',overdue:true,status:'HOLD',claim_status:'LIVE',received_amount:0,receipts:[],notes:null,history:[]};
beforeEach(()=>{vi.clearAllMocks();m.query.isError=false;m.query.data.reservations=[row];m.mutate.mockResolvedValue(row);});afterEach(cleanup);
describe('reservation queue follows live claims',()=>{
 it('shows overdue as still held and cancel sends exact CAS; no auto action occurs',async()=>{
  render(<RoomReservationPanel roomId="room"/>);expect(screen.getByText(/Quá hạn.*vẫn giữ chỗ/)).not.toBeNull();expect(m.mutate).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button',{name:'Hủy giữ chỗ'}));await waitFor(()=>expect(m.mutate).toHaveBeenCalledOnce());expect(m.mutate.mock.calls[0][0]).toMatchObject({reservationId:'hold1',expectedRevision:3,action:'CANCEL'});expect(m.mutate.mock.calls[0][0]).not.toHaveProperty('receipt');
 });
 it('separates deadline adjustment and positive topup, keeps money source state visible',async()=>{
  render(<RoomReservationPanel roomId="room"/>);fireEvent.click(screen.getByRole('button',{name:'Điều chỉnh hạn'}));fireEvent.change(screen.getByLabelText('Hạn giữ chỗ'),{target:{value:'2026-10-02'}});fireEvent.click(screen.getByRole('button',{name:'Lưu hạn'}));await waitFor(()=>expect(m.mutate).toHaveBeenCalledOnce());expect(m.mutate.mock.calls[0][0]).toMatchObject({action:'UPDATE',changes:{holdUntil:'2026-10-02'}});
 });
 it('read failures remain an error and do not show an empty available room',()=>{
  m.query.isError=true;render(<RoomReservationPanel roomId="room"/>);expect(screen.getByRole('alert').textContent).toContain('Không tải được');expect(screen.queryByText('Chưa có giữ chỗ')).toBeNull();expect(m.mutate).not.toHaveBeenCalled();
 });
});
