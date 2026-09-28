// @vitest-environment jsdom
import { cleanup,fireEvent,render,screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach,beforeEach,expect,it,vi } from 'vitest';
import { RoomTurnoverQueue } from '../RoomTurnoverQueue';

const query=vi.hoisted(()=>({state:{},hook:vi.fn(),refetch:vi.fn()}));
vi.mock('@/hooks/rooms/useRoomTurnover',()=>({useRoomTurnoverQueue:(scope:string[],page:number)=>{query.hook(scope,page);return query.state;}}));
vi.mock('@/hooks/useMyPermissions',()=>({useMyPermissions:()=>({data:{rooms:{edit:true}}})}));
vi.mock('@/contexts/OrganizationContext',()=>({useOrganization:()=>({selectedOrganizationId:'org'})}));
vi.mock('../RoomTurnoverPanel',()=>({RoomTurnoverPanel:({roomId}:{roomId:string})=><output>Phòng {roomId}</output>}));
afterEach(cleanup);
beforeEach(()=>{query.hook.mockReset();query.refetch.mockReset();query.state={data:{today:'2026-09-28',total:11,items:[{room_id:'room',room_name:'101',building_name:'Toà A',expected_ready_on:null}]},isPending:false,isError:false,refetch:query.refetch};});
it('keeps missing-date work visible, opens management and paginates the authoritative queue',()=>{
  render(<MemoryRouter><RoomTurnoverQueue buildingIds={['building']} /></MemoryRouter>);
  screen.getByText('Chưa hẹn ngày xong');
  fireEvent.click(screen.getByRole('button',{name:'Cập nhật dọn/sửa 101'}));
  screen.getByText('Phòng room');
  fireEvent.click(screen.getByRole('button',{name:'Close'}));
  fireEvent.click(screen.getByRole('button',{name:'Sau'}));
  expect(query.hook).toHaveBeenLastCalledWith(['building'],1);
});
it('shows a load error and explicit retry instead of interpreting failure as no work',()=>{
  query.state={isPending:false,isError:true,refetch:query.refetch};
  render(<MemoryRouter><RoomTurnoverQueue /></MemoryRouter>);
  screen.getByRole('alert');
  fireEvent.click(screen.getByRole('button',{name:'Thử tải lại'}));
  expect(query.refetch).toHaveBeenCalledOnce();
});
