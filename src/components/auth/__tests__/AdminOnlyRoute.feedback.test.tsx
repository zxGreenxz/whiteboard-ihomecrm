// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import type { RegionQuery } from '@/components/errors/QueryRegion';

const io=vi.hoisted(()=>{
 let ready:Promise<void>=Promise.resolve();let release=()=>{};
 const query:RegionQuery&{data:boolean|undefined}={data:undefined,status:'error',fetchStatus:'idle',isLoading:false,isError:true,error:{code:'42501',message:'raw SQL RLS'},dataUpdatedAt:1,refetch:vi.fn<()=>Promise<void>>()};
 return {query,loadCount:0,block:false,wait:()=>ready,hold:()=>{ready=new Promise<void>(resolve=>{release=resolve;});},release:()=>release()};
});
vi.mock('@/hooks/useIsAdmin',()=>({useIsAdmin:()=>io.query}));
beforeEach(()=>{
 vi.resetModules();io.loadCount=0;io.block=false;
 Object.assign(io.query,{data:undefined,status:'error',fetchStatus:'idle',isLoading:false,isError:true,error:{code:'42501',message:'raw SQL RLS'}});
 if(!vi.isMockFunction(io.query.refetch))throw new Error('Expected mocked query refetch');io.query.refetch.mockReset();io.query.refetch.mockResolvedValue(undefined);
 vi.doMock('@/components/errors/QueryRegion',async()=>{
  io.loadCount++;if(io.block)await io.wait();
  return vi.importActual<typeof import('@/components/errors/QueryRegion')>('@/components/errors/QueryRegion');
 });
});
afterEach(async()=>{cleanup();io.release();await vi.dynamicImportSettled();vi.doUnmock('@/components/errors/QueryRegion');});

type AdminGuard=typeof import('../AdminOnlyRoute')['AdminOnlyRoute'];
const renderGuard=(Guard:AdminGuard,fallbackPath?:string)=>render(<MemoryRouter initialEntries={['/admin']} future={{v7_startTransition:true,v7_relativeSplatPath:true}}><Routes>
 <Route path="/admin" element={<Guard fallbackPath={fallbackPath}><p>Nội dung quản trị</p></Guard>}/>
 <Route path="/" element={<p>Trang chủ fallback</p>}/><Route path="/custom" element={<p>Fallback tùy chọn</p>}/>
</Routes></MemoryRouter>);
const expectClosed=()=>{expect(screen.queryByText('Nội dung quản trị')).toBeNull();expect(screen.queryByText('Trang chủ fallback')).toBeNull();expect(screen.queryByText('Fallback tùy chọn')).toBeNull();};

it('failed permission reads retain a retryable alert while lazy details load and never open cached admin content or redirect',async()=>{
 const {AdminOnlyRoute}=await import('../AdminOnlyRoute');const eagerLoads=io.loadCount;
 io.query.data=true;io.block=true;io.hold();renderGuard(AdminOnlyRoute);
 expectClosed();expect(screen.getByRole('alert').textContent).toContain('Chưa tải được quyền quản trị.');expect(screen.queryByText(/Bạn không có quyền/)).toBeNull();expect(eagerLoads).toBe(0);
 fireEvent.click(screen.getByRole('button',{name:'Tải lại'}));await waitFor(()=>expect(io.query.refetch).toHaveBeenCalledOnce());
 await act(async()=>{io.release();await vi.dynamicImportSettled();});await screen.findByText(/Bạn không có quyền/);
 expectClosed();expect(screen.getByRole('alert').textContent).not.toContain('raw SQL');fireEvent.click(screen.getByRole('button',{name:'Tải lại'}));await waitFor(()=>expect(io.query.refetch).toHaveBeenCalledTimes(2));
});
it.each(['reject','throw'] as const)('keeps the pending error alert when retry %s fails without opening or redirecting',async failure=>{
 const {AdminOnlyRoute}=await import('../AdminOnlyRoute');io.block=true;io.hold();renderGuard(AdminOnlyRoute);
 if(!vi.isMockFunction(io.query.refetch))throw new Error('Expected mocked query refetch');
 io.query.refetch.mockImplementationOnce(()=>{if(failure==='throw')throw new Error('retry failed');return Promise.reject(new Error('retry failed'));});
 fireEvent.click(screen.getByRole('button',{name:'Tải lại'}));await waitFor(()=>expect(io.query.refetch).toHaveBeenCalledOnce());
 expectClosed();expect(screen.getByRole('alert').textContent).toContain('Chưa tải được quyền quản trị.');expect(screen.queryByText('retry failed')).toBeNull();
});
it('resolved lazy query feedback explains an expired session and retries only the permission read',async()=>{
 const {AdminOnlyRoute}=await import('../AdminOnlyRoute');io.query.error={code:'PGRST301',message:'JWT expired'};renderGuard(AdminOnlyRoute);
 await screen.findByText('Phiên đăng nhập đã hết hạn. Đăng nhập lại để tiếp tục.');expectClosed();
 fireEvent.click(screen.getByRole('button',{name:'Tải lại'}));await waitFor(()=>expect(io.query.refetch).toHaveBeenCalledOnce());
});
it.each([['empty',undefined],['false',false]] as const)('retains the existing redirect for a successful %s permission result without loading error UI',async(_name,data)=>{
 Object.assign(io.query,{data,status:'success',isError:false,error:null});const {AdminOnlyRoute}=await import('../AdminOnlyRoute');renderGuard(AdminOnlyRoute);
 await screen.findByText('Trang chủ fallback');expect(screen.queryByText('Nội dung quản trị')).toBeNull();expect(screen.queryByRole('alert')).toBeNull();expect(io.loadCount).toBe(0);
});
it('keeps the existing custom fallback path for a confirmed false result',async()=>{
 Object.assign(io.query,{data:false,status:'success',isError:false,error:null});const {AdminOnlyRoute}=await import('../AdminOnlyRoute');renderGuard(AdminOnlyRoute,'/custom');
 await screen.findByText('Fallback tùy chọn');expect(screen.queryByText('Nội dung quản trị')).toBeNull();expect(io.loadCount).toBe(0);
});
it('renders confirmed admin children without loading error UI',async()=>{
 Object.assign(io.query,{data:true,status:'success',isError:false,error:null});const {AdminOnlyRoute}=await import('../AdminOnlyRoute');renderGuard(AdminOnlyRoute);
 expect(screen.getByText('Nội dung quản trị')).toBeTruthy();expect(screen.queryByRole('alert')).toBeNull();expect(screen.queryByText('Trang chủ fallback')).toBeNull();expect(io.loadCount).toBe(0);
});
it.each([undefined,true])('preserves loading priority before admin criteria or error UI, including cached data=%s',async data=>{
 Object.assign(io.query,{data,status:'pending',fetchStatus:'fetching',isLoading:true,isError:false,error:null});const {AdminOnlyRoute}=await import('../AdminOnlyRoute');renderGuard(AdminOnlyRoute);
 expectClosed();expect(screen.queryByRole('alert')).toBeNull();expect(io.loadCount).toBe(0);
});
