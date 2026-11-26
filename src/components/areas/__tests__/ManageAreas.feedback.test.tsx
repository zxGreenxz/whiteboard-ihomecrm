// @vitest-environment jsdom
import {cleanup,fireEvent,render,screen,waitFor} from '@testing-library/react';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
const io=vi.hoisted(()=>({create:vi.fn(),rename:vi.fn(),remove:vi.fn(),assign:vi.fn(),retry:vi.fn().mockResolvedValue({isError:false})}));
vi.mock('@/hooks/useAreas',async()=>{
  const {RepeatableWriteUnknownError}=await import('@/lib/financialWorkflowError');
  class AreaDeletePartialError extends RepeatableWriteUnknownError{constructor(readonly areaId:string,cause?:unknown,readonly softDeleted=true){super('xoá khu vực',cause,softDeleted?[{id:areaId,label:'Khu vực đã xoá mềm'}]:[]);}}
  return {useAreas:()=>({data:[{id:'a1',name:'Khu A'}],isError:false,isLoading:false,refetch:io.retry}),useCreateArea:()=>({mutate:io.create,isPending:false}),useUpdateArea:()=>({mutate:io.rename,isPending:false}),useDeleteArea:()=>({mutate:io.remove,isPending:false}),useAssignBuildingsToArea:()=>({mutate:io.assign,isPending:false}),AreaDeletePartialError,AreaMembershipPartialError:class extends Error{}};
});
vi.mock('@/hooks/useBuildings',()=>({useBuildings:()=>({data:[{id:'b1',area_ids:['a1']}],isError:false,isLoading:false,refetch:io.retry})}));
vi.mock('@/components/buildings/BuildingMultiSelect',()=>({BuildingMultiSelect:({onChange}:{onChange:(value:string[])=>void})=><button onClick={()=>onChange(['b2'])}>Đổi tòa</button>}));
import ManageAreasDialog from '../ManageAreasDialog';
import {AreaDeletePartialError} from '@/hooks/useAreas';
import {FinancialWorkflowError} from '@/lib/financialWorkflow';
// Hộp mở qua portal nên tìm trên cả trang; nút biểu tượng không có tên, tìm theo lớp của biểu tượng.
const iconButton=(icon:string)=>{const button=document.body.querySelector(`.lucide-${icon}`)?.closest('button');if(!button)throw new Error(`Không thấy nút ${icon}`);return button;};
beforeEach(()=>{vi.stubGlobal('confirm',vi.fn(()=>true));});
afterEach(()=>{cleanup();vi.clearAllMocks();vi.unstubAllGlobals();});

// Đợt 8 (luật 5): gán tòa / sửa tên / xoá khu ghi lặp lại được — kết quả chưa rõ chỉ báo (kèm mã), hộp không tự khoá.
it('unknown membership keeps the IDs visible and choosing again re-sends (no lock)',async()=>{
  io.assign.mockImplementation((_input,options)=>options.onError(new FinancialWorkflowError('Chưa hoàn tất gán tòa.','partial',[{id:'a1:b2',label:'Liên kết đã lưu'}])));
  const props={open:true,onOpenChange:vi.fn()};const view=render(<ManageAreasDialog {...props}/>);
  fireEvent.click(screen.getByRole('button',{name:'Đổi tòa'}));await waitFor(()=>expect(screen.getByRole('alert').textContent).toContain('a1:b2'));
  view.rerender(<ManageAreasDialog {...props} open={false}/>);view.rerender(<ManageAreasDialog {...props}/>);
  fireEvent.click(screen.getByRole('button',{name:'Đổi tòa'}));expect(io.assign).toHaveBeenCalledTimes(2);
});

it('unknown rename shows the message and the name can be saved again',async()=>{
  io.rename.mockImplementation((_input,options)=>options.onError(new FinancialWorkflowError('Chưa xác nhận đổi tên khu.','unknown',[{id:'a1',label:'Khu cần đối chiếu'}])));
  const view=render(<ManageAreasDialog open onOpenChange={vi.fn()}/>);
  fireEvent.click(iconButton('pencil'));fireEvent.change(screen.getByRole('textbox',{name:'Tên khu vực'}),{target:{value:'Khu B'}});
  fireEvent.click(iconButton('check'));await waitFor(()=>expect(screen.getByRole('alert').textContent).toContain('Chưa xác nhận đổi tên khu'));
  expect((screen.getByRole('textbox',{name:'Tên khu vực'}) as HTMLInputElement).disabled).toBe(false);
  fireEvent.click(iconButton('check'));expect(io.rename).toHaveBeenCalledTimes(2);expect(io.rename.mock.calls[1][0]).toEqual({id:'a1',updates:{name:'Khu B'}});
});

it('area soft-deleted but not yet removed from buildings offers «Xoá lại» (no second confirm, no lock)',async()=>{
  io.remove.mockImplementationOnce((_id,options)=>options.onError(new AreaDeletePartialError('a1',new TypeError('Failed to fetch'),true)));
  const view=render(<ManageAreasDialog open onOpenChange={vi.fn()}/>);
  fireEvent.click(iconButton('trash2'));await waitFor(()=>expect(screen.getByRole('alert').textContent).toContain('a1'));
  // Làm việc khác (gán tòa) không làm mất nút «Xoá lại»: khu đã xoá mềm không còn trong danh sách để bấm xoá lần nữa.
  fireEvent.click(screen.getByRole('button',{name:'Đổi tòa'}));expect(io.assign).toHaveBeenCalledTimes(1);
  io.remove.mockImplementationOnce((_id,options)=>options.onSuccess());
  fireEvent.click(screen.getByRole('button',{name:'Xoá lại «Khu A»'}));
  expect(io.remove).toHaveBeenCalledTimes(2);expect(io.remove.mock.calls[1][0]).toBe('a1');expect(confirm).toHaveBeenCalledTimes(1);
  await waitFor(()=>expect(screen.queryByRole('button',{name:'Xoá lại «Khu A»'})).toBeNull());
});

// Đợt 9 (luật 5): TẠO khu vực không còn khoá ô thêm — kết quả chưa rõ chỉ báo, giữ tên đang nhập; bấm «Thêm» lại gửi lại (hook
// gửi lại đúng mã khu cũ nên không ra khu thứ hai). Trước đợt 9: «unknown create still locks the add box …».
it('unknown create reports, keeps the name and lets «Thêm» re-send (no lock since đợt 9)',async()=>{
  io.create.mockImplementationOnce((_input,options)=>options.onError(new FinancialWorkflowError('Chưa xác nhận tạo khu.','unknown',[])));
  render(<ManageAreasDialog open onOpenChange={vi.fn()}/>);
  fireEvent.change(screen.getByRole('textbox',{name:'Tên khu vực mới'}),{target:{value:'Khu mới'}});fireEvent.click(screen.getByRole('button',{name:'Thêm'}));
  await waitFor(()=>expect(screen.getByRole('alert').textContent).toContain('Chưa xác nhận tạo khu'));
  expect((screen.getByRole('button',{name:'Thêm'}) as HTMLButtonElement).disabled).toBe(false);expect((screen.getByRole('textbox',{name:'Tên khu vực mới'}) as HTMLInputElement).disabled).toBe(false);
  expect((screen.getByRole('textbox',{name:'Tên khu vực mới'}) as HTMLInputElement).value).toBe('Khu mới');
  expect(screen.queryByRole('button',{name:'Tải lại để đối chiếu'})).toBeNull();
  io.create.mockImplementationOnce((_input,options)=>{options.onSuccess();options.onSettled?.();});
  fireEvent.click(screen.getByRole('button',{name:'Thêm'}));
  expect(io.create).toHaveBeenCalledTimes(2);expect(io.create.mock.calls[1][0]).toEqual({name:'Khu mới'});
  await waitFor(()=>expect((screen.getByRole('textbox',{name:'Tên khu vực mới'}) as HTMLInputElement).value).toBe(''));
});
