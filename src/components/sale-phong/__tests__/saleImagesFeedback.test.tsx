// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const io=vi.hoisted(()=>({ buildings:[{id:'building-a',name:'Toà A',images:[]}], rooms:[] as Array<Record<string,unknown>>,reply:vi.fn(),success:vi.fn(),error:vi.fn() }));
vi.mock('@/integrations/supabase/client',()=>({supabase:{from:()=>{
 let patch:Record<string,unknown>={};let ids:string[]=[];
 const invoke=()=>io.reply({patch,ids});
 const q={update:(value:Record<string,unknown>)=>{patch=value;return q;},eq:(_key:string,id:string)=>{ids=[id];return q;},in:(_key:string,value:string[])=>{ids=value;return q;},select:()=>q,
 single:async()=>{const result=await invoke();return {...result,data:Array.isArray(result.data)?result.data[0]??null:result.data};},
 then:(resolve:(value:unknown)=>unknown,reject:(error:unknown)=>unknown)=>Promise.resolve(invoke()).then(resolve,reject)};
 return q;
}}}));
vi.mock('@/hooks/useBuildings',()=>({useBuildings:()=>({data:io.buildings}),useUpdateBuilding:()=>({mutate:vi.fn(),isPending:false})}));
vi.mock('@/hooks/useRooms',()=>({useRooms:()=>({data:io.rooms})}));
vi.mock('@/components/ui/searchable-select',()=>({SearchableSelect:({value,onValueChange,options,placeholder,disabled}:{value:string;onValueChange:(value:string)=>void;options:Array<{value:string;label:string}>;placeholder:string;disabled?:boolean})=><select aria-label={placeholder} value={value} onChange={event=>onValueChange(event.target.value)} disabled={disabled}><option value="">{placeholder}</option>{options.map(option=><option key={option.value} value={option.value}>{option.label}</option>)}</select>}));
const imageEditor=({value,onChange}:{value:string[];onChange:(value:string[])=>void})=><input aria-label="Ảnh test" value={value.join(',')} onChange={event=>onChange(event.target.value?[event.target.value]:[])}/>;
vi.mock('../SaleImageManager',()=>({default:(props:Parameters<typeof imageEditor>[0])=>imageEditor(props)}));
vi.mock('../mobile/MobileImageGrid',()=>({default:(props:Parameters<typeof imageEditor>[0])=>imageEditor(props)}));
vi.mock('sonner',()=>({toast:{success:io.success,error:io.error}}));
import SaleImagesTab from '../SaleImagesTab';
import MobileSaleInfo from '../mobile/MobileSaleInfo';
beforeEach(()=>{vi.clearAllMocks();io.rooms=[{id:'room-a',name:'Phòng A',code:'A',floor:1,images:[],amenities:['Giường']},{id:'room-b',name:'Phòng B',code:'B',floor:1,images:[],amenities:[]}];io.reply.mockImplementation(({patch,ids}:{patch:Record<string,unknown>;ids:string[]})=>Promise.resolve({data:ids.map(id=>({id,...patch})),error:null}));});
afterEach(cleanup);
async function setup(mobile:boolean,similar=true){
 const client=new QueryClient();const node=<QueryClientProvider client={client}>{mobile?<MobileSaleInfo/>:<SaleImagesTab/>}</QueryClientProvider>;
 const view=render(node);
 if(mobile){
  fireEvent.click(screen.getByRole('button',{name:/Toà nhà Chọn toà nhà/}));
  fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button',{name:/Toà A/}));
  fireEvent.click(screen.getByRole('button',{name:'Thông tin phòng'}));
  fireEvent.click(screen.getByRole('button',{name:/Phòng Chọn phòng/}));
  fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button',{name:/Phòng A/}));
 }else{
  fireEvent.change(screen.getByLabelText('Chọn toà nhà'),{target:{value:'building-a'}});
  fireEvent.change(screen.getByLabelText('Chọn phòng'),{target:{value:'room-a'}});
 }
 await waitFor(()=>expect(screen.getAllByLabelText('Ảnh test').length).toBeGreaterThan(0));
 const imageInputs=screen.getAllByLabelText('Ảnh test');const image=imageInputs[imageInputs.length-1];
 fireEvent.change(image,{target:{value:'new.jpg'}});
 if(similar){
  if(mobile){
   fireEvent.click(screen.getByRole('button',{name:/Đồng bộ ảnh sang phòng tương tự/}));
   fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button',{name:/Phòng B/}));
  }else fireEvent.change(screen.getByLabelText('Thêm phòng tương tự…'),{target:{value:'room-b'}});
 }
 return {view,node,image,save:()=>fireEvent.click(screen.getByRole('button',{name:similar?'Lưu & đồng bộ (2 phòng)':'Lưu thông tin phòng'}))};
}
it.each([false,true])('secondary error explicitly retains primary receipt/name/ID and drafts mobile=%s',async mobile=>{
 io.reply.mockImplementation(({patch,ids}:{patch:Record<string,unknown>;ids:string[]})=>Promise.resolve(ids[0]==='room-a'?{data:[{id:'room-a',...patch}],error:null}:{data:null,error:{code:'42501',message:'PRIVATE_ROOM_SCHEMA'}}));
 const state=await setup(mobile);state.save();
 await waitFor(()=>expect(io.error).toHaveBeenCalledTimes(1));
 expect(JSON.stringify(io.error.mock.calls)).toContain('Phòng A');
 expect(JSON.stringify(io.error.mock.calls)).toContain('room-a');
 expect(JSON.stringify(io.error.mock.calls)).toContain('Đã lưu');
 expect(JSON.stringify(io.error.mock.calls)).not.toContain('PRIVATE_ROOM_SCHEMA');
 expect(io.success).not.toHaveBeenCalled();expect(state.image).toHaveProperty('value','new.jpg');
 io.rooms=io.rooms.map(room=>({...room,images:[]}));
 state.view.rerender(state.node);
 expect(state.image).toHaveProperty('value','new.jpg');
 expect(screen.getByRole('alert').textContent).toContain('room-a');
});
it.each([false,true])('primary denial is safe and does not claim any room was saved mobile=%s',async mobile=>{
 io.reply.mockResolvedValue({data:null,error:{code:'42501',message:'PRIVATE_ROOM_SCHEMA'}});
 const state=await setup(mobile);state.save();
 await waitFor(()=>expect(io.error).toHaveBeenCalledTimes(1));
 expect(JSON.stringify(io.error.mock.calls)).not.toContain('PRIVATE_ROOM_SCHEMA');
 expect(JSON.stringify(io.error.mock.calls)).not.toContain('Đã lưu');
 expect(io.reply).toHaveBeenCalledTimes(1);expect(io.success).not.toHaveBeenCalled();
 expect(state.image).toHaveProperty('value','new.jpg');
});
it.each([false,true])('primary zero-row receipt never starts image replication or succeeds mobile=%s',async mobile=>{
 io.reply.mockResolvedValue({data:[],error:null});const state=await setup(mobile);state.save();
 await waitFor(()=>expect(io.error).toHaveBeenCalledTimes(1));
 expect(io.reply).toHaveBeenCalledTimes(1);expect(io.success).not.toHaveBeenCalled();expect(state.image).toHaveProperty('value','new.jpg');
});
it.each([false,true])('missing secondary rows is partial rather than full success mobile=%s',async mobile=>{
 io.reply.mockImplementation(({patch,ids}:{patch:Record<string,unknown>;ids:string[]})=>Promise.resolve({data:ids[0]==='room-a'?[{id:'room-a',...patch}]:[],error:null}));
 const state=await setup(mobile);state.save();await waitFor(()=>expect(io.error).toHaveBeenCalledTimes(1));
 expect(JSON.stringify(io.error.mock.calls)).toContain('Đã lưu');
 expect(JSON.stringify(io.error.mock.calls)).toContain('room-a');
 expect(io.success).not.toHaveBeenCalled();
});
it.each([false,true])('positive receipts announce the actual primary name and verified room count mobile=%s',async mobile=>{
 const state=await setup(mobile);state.save();
 await waitFor(()=>expect(io.success).toHaveBeenCalledTimes(1));
 expect(JSON.stringify(io.success.mock.calls)).toContain('Phòng A');
 expect(JSON.stringify(io.success.mock.calls)).toContain('2 phòng');
 expect(io.error).not.toHaveBeenCalled();
});
