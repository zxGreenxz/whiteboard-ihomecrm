// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import SalePhongMobilePage from '../SalePhongMobilePage';

const passQuery=vi.hoisted(()=>({data:[] as unknown[]|undefined,status:'success',fetchStatus:'idle',isLoading:false,isError:false,error:null as unknown,refetch:vi.fn(),dataUpdatedAt:Date.now()}));
const tokenQuery=vi.hoisted(()=>({data:[] as unknown[]|undefined,status:'success',fetchStatus:'idle',isLoading:false,isError:false,error:null as unknown,refetch:vi.fn(),dataUpdatedAt:Date.now()}));
vi.mock('@/lib/permissionPages',()=>({canUse:()=>true}));
const query = vi.hoisted(() => ({ data: [{}], isLoading: false, isError: false, refetch: vi.fn() }));
vi.mock('@/hooks/useMyAvailableRooms', () => ({ useMyAvailableRooms: () => query }));
vi.mock('@/hooks/useMyPermissions', () => ({ useMyPermissions: () => ({ data: null }) }));
vi.mock('@/hooks/usePublicRoomTokens', () => ({ usePublicRoomTokens: () => tokenQuery }));
vi.mock('@/hooks/usePassListings', () => ({ usePassListings: () => passQuery }));
vi.mock('@/pages/phong-trong/PhongTrongPage', () => ({ default: () => <div>Danh sách đã cache</div> }));
afterEach(() => { cleanup();Object.assign(query, { data: [{}], isLoading: false, isError: false });query.refetch.mockClear();Object.assign(tokenQuery,{data:[],status:'success',isError:false,error:null});tokenQuery.refetch.mockClear();Object.assign(passQuery,{data:[],status:'success',isError:false,error:null});passQuery.refetch.mockClear(); });
const open = () => render(<MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}><SalePhongMobilePage /></MemoryRouter>);

describe('authenticated sale error state', () => {
  it('does not advertise cached rooms after a refresh failure and provides retry', () => {
    query.isError = true;open();
    expect(screen.queryByText('Danh sách đã cache')).toBeNull();
    expect(screen.getByText('Chưa tải được danh sách phòng. Thử lại để xem tình trạng hiện tại.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Thử lại' }));
    expect(query.refetch).toHaveBeenCalledTimes(1);
  });
  it('retains successful embedded lists including an empty result', () => {
    query.data = [];open();
    expect(screen.getByText('Danh sách đã cache')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Thử lại' })).toBeNull();
  });
});

it('admin token stat reports source failure and never says 0 links',async()=>{Object.assign(tokenQuery,{data:undefined,status:'error',isError:true,error:{code:'42501',message:'SQL_PRIVATE'}});open();fireEvent.click(screen.getByRole('button',{name:'Quản lý'}));expect(screen.getByText('Chưa tải được số link chia sẻ.')).toBeTruthy();expect(screen.queryByText('0 link')).toBeNull();fireEvent.click(screen.getByRole('button',{name:'Tải lại'}));await vi.waitFor(()=>expect(tokenQuery.refetch).toHaveBeenCalled());});

it.each<[unknown[] | undefined]>([[undefined], [[]]])('admin pass stat reports failure without falsely showing zero rooms: %j', async data => {
  Object.assign(passQuery,{data,status:'error',isError:true,error:{code:'42501',message:'PRIVATE_PASS_SQL'}});
  open();fireEvent.click(screen.getByRole('button',{name:'Quản lý'}));
  expect(screen.getByText('Chưa tải được số phòng khách nhờ sale.')).toBeTruthy();
  expect(screen.queryByText('0 phòng')).toBeNull();
  expect(document.body.textContent).not.toContain('PRIVATE_PASS_SQL');
  fireEvent.click(screen.getByRole('button',{name:'Tải lại'}));
  await vi.waitFor(()=>expect(passQuery.refetch).toHaveBeenCalled());
});
it('admin pass stat can show a genuinely successful empty result',()=>{
 open();fireEvent.click(screen.getByRole('button',{name:'Quản lý'}));
 expect(screen.getByText('0 phòng')).toBeTruthy();
});
