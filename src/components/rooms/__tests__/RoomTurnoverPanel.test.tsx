// @vitest-environment jsdom
import { cleanup,fireEvent,render,screen,waitFor } from '@testing-library/react';
import { afterEach,beforeEach,expect,it,vi } from 'vitest';
import { RoomTurnoverPanel } from '../RoomTurnoverPanel';

const actions=vi.hoisted(()=>({snapshot:{},refetch:vi.fn(),save:vi.fn()}));
vi.mock('@/hooks/rooms/useRoomTurnover',()=>({
  useRoomTurnover:()=>({data:actions.snapshot,isPending:false,isError:false,refetch:actions.refetch}),
  useSaveRoomTurnover:()=>({mutateAsync:actions.save,isPending:false}),
}));
vi.mock('@/hooks/useMyPermissions',()=>({useMyPermissions:()=>({data:{rooms:{edit:true}}})}));
vi.mock('@/hooks/useStaffUsers',()=>({useStaffUsers:()=>({data:[{id:'00000000-0000-4000-8000-000000000015',full_name:'Nguyễn An'}],isPending:false,isError:false})}));
vi.mock('@/components/ui/date-input',()=>({DateInput:({value,onChange,disabled}:{value:string;onChange:(value:string)=>void;disabled?:boolean})=>
  <input aria-label="Ngày dự kiến xong" value={value} disabled={disabled} onChange={e=>onChange(e.target.value)} />}));

const room='00000000-0000-4000-8000-000000000012';
const empty={today:'2026-09-28',can_start_new_cycle:true,turnover:null,history:[]};
const pending={...empty,can_start_new_cycle:false,turnover:{id:room,organization_id:'dddd0000-0000-4000-8000-000000000001',room_id:room,
  version:7,epoch:1,source_contract_id:null,status:'PENDING',expected_ready_on:'2026-09-27',responsible_user_id:null,reason:'Dọn phòng',updated_at:'2026-09-28T01:00:00Z'}};
afterEach(cleanup);
beforeEach(()=>{actions.snapshot=empty;actions.refetch.mockReset().mockResolvedValue({data:empty,error:null});actions.save.mockReset().mockResolvedValue(empty);});

it('creates tracking with no date or assignee and a reason without calling a room-status writer',async()=>{
  render(<RoomTurnoverPanel roomId={room} />);
  fireEvent.click(screen.getByRole('button',{name:'Theo dõi dọn/sửa'}));
  fireEvent.change(await screen.findByLabelText('Lý do / ghi chú'),{target:{value:'Dọn sau trả phòng'}});
  fireEvent.click(screen.getByRole('button',{name:'Lưu theo dõi'}));
  await waitFor(()=>expect(actions.save).toHaveBeenCalledWith({roomId:room,expectedVersion:0,status:'PENDING',expectedReadyOn:null,responsibleUserId:null,sourceContractId:null,reason:'Dọn sau trả phòng',startNewCycle:false}));
});
it('shows overdue work and captures the fresh version on editing',async()=>{
  actions.snapshot={...pending,history:[{id:room,epoch:1,actor_id:'00000000-0000-4000-8000-000000000015',created_at:'2026-09-28T01:00:00Z',previous_state:null,new_state:pending.turnover,reason:'Dọn phòng'}]};actions.refetch.mockResolvedValue({data:{...pending,turnover:{...pending.turnover,version:8}},error:null});
  render(<RoomTurnoverPanel roomId={room} />);
  screen.getByText(/Cần xác nhận ngày nhận/);
  screen.getByText('Người thay đổi: Nguyễn An');
  fireEvent.click(screen.getByRole('button',{name:'Cập nhật dọn/sửa'}));
  fireEvent.change(await screen.findByLabelText('Ngày dự kiến xong'),{target:{value:''}});
  fireEvent.change(screen.getByLabelText('Lý do / ghi chú'),{target:{value:'Chưa hẹn lại ngày'}});
  fireEvent.click(screen.getByRole('button',{name:'Lưu theo dõi'}));
  await waitFor(()=>expect(actions.save).toHaveBeenCalledWith(expect.objectContaining({expectedVersion:8,expectedReadyOn:null,reason:'Chưa hẹn lại ngày'})));
});
it('does not open stale data after a fresh-read failure and keeps conflict work open for reload',async()=>{
  actions.snapshot=pending;actions.refetch.mockResolvedValueOnce({data:pending,error:{code:'42501'}}).mockResolvedValue({data:pending,error:null});
  render(<RoomTurnoverPanel roomId={room} />);
  fireEvent.click(screen.getByRole('button',{name:'Cập nhật dọn/sửa'}));
  await screen.findByRole('alert');expect(screen.queryByLabelText('Ngày dự kiến xong')).toBeNull();
  fireEvent.click(screen.getByRole('button',{name:'Cập nhật dọn/sửa'}));
  await screen.findByLabelText('Ngày dự kiến xong');
  fireEvent.change(screen.getByLabelText('Lý do / ghi chú'),{target:{value:'Cập nhật ngày'}});
  actions.save.mockRejectedValueOnce({code:'PT409'});
  fireEvent.click(screen.getByRole('button',{name:'Lưu theo dõi'}));
  await screen.findByRole('button',{name:'Tải lại việc dọn/sửa'});
});
it('preserves a legacy null source while editing instead of attaching a later contract',async()=>{
  actions.snapshot=pending;actions.refetch.mockResolvedValue({data:pending,error:null});
  render(<RoomTurnoverPanel roomId={room} sourceContractId="00000000-0000-4000-8000-000000000014" />);
  fireEvent.click(screen.getByRole('button',{name:'Cập nhật dọn/sửa'}));
  fireEvent.change(await screen.findByLabelText('Lý do / ghi chú'),{target:{value:'Giữ việc dọn cũ'}});
  fireEvent.click(screen.getByRole('button',{name:'Lưu theo dõi'}));
  await waitFor(()=>expect(actions.save).toHaveBeenCalledWith(expect.objectContaining({sourceContractId:null,startNewCycle:false})));
});
