// @vitest-environment jsdom
import {cleanup,fireEvent,render,screen,waitFor} from '@testing-library/react';
import {afterEach,expect,it,vi} from 'vitest';
const io=vi.hoisted(()=>({remove:vi.fn()}));
vi.mock('@/hooks/useVehicles',()=>({useDeleteVehicle:()=>({mutate:io.remove,isPending:false})}));
import DeleteVehicleDialog from '../DeleteVehicleDialog';
import {FinancialWorkflowError,RepeatableWriteUnknownError} from '@/lib/financialWorkflow';
afterEach(()=>{cleanup();vi.resetAllMocks();});
// Đợt 8 (luật 5): xoá mềm xe lặp lại được — kết quả chưa rõ chỉ báo (kèm mã), nút Xoá không khoá, bấm lại gửi lần nữa.
it('unknown deletion keeps the vehicle ID visible and lets the user retry (no lock)',async()=>{
 io.remove.mockImplementation((_id,callbacks)=>callbacks.onError?.(new RepeatableWriteUnknownError('xoá phương tiện',new TypeError('Failed to fetch'),[{id:'v1',label:'Xe cần đối chiếu'}])));
 const props={open:true,onOpenChange:vi.fn(),vehicleId:'v1',vehicleName:'Wave'};const view=render(<DeleteVehicleDialog {...props}/>);
 fireEvent.click(screen.getByRole('button',{name:'Xoá'}));await waitFor(()=>expect(screen.getByRole('alert').textContent).toContain('v1'));
 expect(props.onOpenChange).not.toHaveBeenCalled();view.rerender(<DeleteVehicleDialog {...props} open={false}/>);view.rerender(<DeleteVehicleDialog {...props}/>);
 expect((screen.getByRole('button',{name:'Xoá'}) as HTMLButtonElement).disabled).toBe(false);
 fireEvent.click(screen.getByRole('button',{name:'Xoá'}));expect(io.remove).toHaveBeenCalledTimes(2);
});
it('a legacy unknown error (before đợt 8) also no longer locks the delete button',async()=>{
 io.remove.mockImplementation((_id,callbacks)=>callbacks.onError?.(new FinancialWorkflowError('Chưa xác nhận xoá xe.','unknown',[{id:'v1',label:'Xe cần đối chiếu'}])));
 render(<DeleteVehicleDialog open onOpenChange={vi.fn()} vehicleId="v1" vehicleName="Wave"/>);
 fireEvent.click(screen.getByRole('button',{name:'Xoá'}));await waitFor(()=>expect(screen.getByRole('alert').textContent).toContain('v1'));
 fireEvent.click(screen.getByRole('button',{name:'Xoá'}));expect(io.remove).toHaveBeenCalledTimes(2);
});
