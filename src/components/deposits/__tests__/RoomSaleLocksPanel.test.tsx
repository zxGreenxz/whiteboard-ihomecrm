// @vitest-environment jsdom
import {cleanup,fireEvent,render,screen,waitFor} from '@testing-library/react';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {toast} from 'sonner';
import {RoomSaleLocksPanel} from '../RoomSaleLocksPanel';
const m=vi.hoisted(()=>({query:{isLoading:false,isError:false,data:{server_now:'2026-10-10T00:00:00Z',locks:[] as unknown[]} as {server_now:string;locks:unknown[]}|undefined,refetch:vi.fn()},release:vi.fn(),perms:{} as Record<string,unknown>}));
vi.mock('@/hooks/useRoomSaleLocks',()=>({useRoomSaleLocks:()=>m.query,useReleaseRoomSaleLock:()=>({mutateAsync:m.release,isPending:false})}));
vi.mock('@/hooks/useMyPermissions',async()=>{const real=await vi.importActual<typeof import('@/hooks/useMyPermissions')>('@/hooks/useMyPermissions');return{...real,useMyPermissions:()=>({data:m.perms})};});
// Form giả có state riêng: nếu React dựng lại form thì chữ đã gõ mất — đúng lỗi cần chặn.
vi.mock('@/components/deposits/CreateDepositDialog',async()=>{const {useState}=await vi.importActual<typeof import('react')>('react');return{CreateDepositDialog:({initialRoomId}:{initialRoomId?:string|null})=>{const[typed,setTyped]=useState('');return<div>Form tạo cọc {initialRoomId}<input aria-label='Ô đang nhập' value={typed} onChange={e=>setTyped(e.target.value)}/></div>;}};});
vi.mock('sonner',()=>({toast:{error:vi.fn(),success:vi.fn()}}));
const lock={id:'11111111-1111-4111-8111-111111111111',room_id:'22222222-2222-4222-8222-222222222222',room_name:'P301',room_code:'A-301',building_name:'Tòa A',hours:24,note:'Khách đang chuyển khoản',locked_by_name:'Sale Lan',expires_at:new Date(Date.now()+17.5*3600_000).toISOString(),active:true};
beforeEach(()=>{vi.clearAllMocks();m.perms={deposits:{view:true,create:true}};m.query.isLoading=false;m.query.isError=false;m.query.data={server_now:'2026-10-10T00:00:00Z',locks:[lock]};m.release.mockResolvedValue(lock);});afterEach(cleanup);
describe('RoomSaleLocksPanel',()=>{
 it('lists active locks with room, building, remaining time, owner and note',()=>{
  render(<RoomSaleLocksPanel/>);expect(screen.getByText('P301')).not.toBeNull();expect(screen.getByText(/Tòa A/)).not.toBeNull();expect(screen.getByText('còn 18 giờ')).not.toBeNull();expect(screen.getByText(/Sale Lan/)).not.toBeNull();expect(screen.getByText('Khách đang chuyển khoản')).not.toBeNull();
 });
 it('renders nothing when there are no locks',()=>{
  m.query.data={server_now:'2026-10-10T00:00:00Z',locks:[]};const{container}=render(<RoomSaleLocksPanel/>);expect(container.textContent).toBe('');
 });
 it('renders nothing without deposits.view',()=>{
  m.perms={};const{container}=render(<RoomSaleLocksPanel/>);expect(container.textContent).toBe('');
 });
 it('shows a read error instead of hiding silently when nothing was loaded yet',()=>{
  m.query.isError=true;m.query.data=undefined;render(<RoomSaleLocksPanel/>);expect(screen.getByRole('alert').textContent).toContain('Không tải được');
  fireEvent.click(screen.getByRole('button',{name:'Thử lại'}));expect(m.query.refetch).toHaveBeenCalledOnce();
 });
 it('release needs an inline confirm and then calls the mutation with the lock id',async()=>{
  render(<RoomSaleLocksPanel/>);fireEvent.click(screen.getByRole('button',{name:'Gỡ lock'}));expect(m.release).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button',{name:'Xác nhận gỡ'}));await waitFor(()=>expect(m.release).toHaveBeenCalledWith(lock.id));
  await waitFor(()=>expect(toast.success).toHaveBeenCalled());
 });
 it('cancelling the inline confirm does not release; a server error is toasted',async()=>{
  render(<RoomSaleLocksPanel/>);fireEvent.click(screen.getByRole('button',{name:'Gỡ lock'}));fireEvent.click(screen.getByRole('button',{name:'Không'}));expect(m.release).not.toHaveBeenCalled();expect(screen.getByRole('button',{name:'Gỡ lock'})).not.toBeNull();
  m.release.mockRejectedValueOnce({message:'Chỉ người đã lock hoặc người được tạo cọc ở tòa này mới gỡ được lock'});
  fireEvent.click(screen.getByRole('button',{name:'Gỡ lock'}));fireEvent.click(screen.getByRole('button',{name:'Xác nhận gỡ'}));await waitFor(()=>expect(toast.error).toHaveBeenCalled());
 });
 it('hides release and create buttons without deposits.create but still lists the lock',()=>{
  m.perms={deposits:{view:true,create:false}};render(<RoomSaleLocksPanel/>);expect(screen.getByText('P301')).not.toBeNull();expect(screen.queryByRole('button',{name:'Gỡ lock'})).toBeNull();expect(screen.queryByRole('button',{name:'Tạo phiếu cọc'})).toBeNull();
 });
 it('Tạo phiếu cọc opens the shared deposit form prefilled with the locked room',()=>{
  render(<RoomSaleLocksPanel/>);expect(screen.queryByText(/Form tạo cọc/)).toBeNull();fireEvent.click(screen.getByRole('button',{name:'Tạo phiếu cọc'}));expect(screen.getByText(`Form tạo cọc ${lock.room_id}`)).not.toBeNull();
 });
 it('a failed background poll keeps the last good list',()=>{
  m.query.isError=true;render(<RoomSaleLocksPanel/>);expect(screen.getByText('P301')).not.toBeNull();expect(screen.queryByRole('alert')).toBeNull();
 });
 it('the open deposit form survives the last lock disappearing from the list',()=>{
  const view=render(<RoomSaleLocksPanel/>);fireEvent.click(screen.getByRole('button',{name:'Tạo phiếu cọc'}));
  fireEvent.change(screen.getByLabelText('Ô đang nhập'),{target:{value:'đang gõ dở'}});
  m.query.data={server_now:'2026-10-10T01:00:00Z',locks:[]};view.rerender(<RoomSaleLocksPanel/>);
  expect((screen.getByLabelText('Ô đang nhập') as HTMLInputElement).value).toBe('đang gõ dở');
  expect(screen.queryByText('P301')).toBeNull();expect(screen.getByText(`Form tạo cọc ${lock.room_id}`)).not.toBeNull();
 });
});
