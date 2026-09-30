// @vitest-environment jsdom
import {cleanup,fireEvent,render,screen,waitFor} from '@testing-library/react';
import {afterEach,expect,it,vi} from 'vitest';
const io=vi.hoisted(()=>({remove:vi.fn()}));
vi.mock('@/hooks/useVehicles',()=>({useDeleteVehicle:()=>({mutate:io.remove,isPending:false})}));
import DeleteVehicleDialog from '../DeleteVehicleDialog';
import {FinancialWorkflowError} from '@/lib/financialWorkflow';
afterEach(()=>{cleanup();vi.resetAllMocks();});
it('unknown deletion keeps the vehicle ID visible and blocks replay after reopening',async()=>{
 io.remove.mockImplementation((_id,callbacks)=>callbacks.onError?.(new FinancialWorkflowError('Chưa xác nhận xoá xe.','unknown',[{id:'v1',label:'Xe cần đối chiếu'}])));
 const props={open:true,onOpenChange:vi.fn(),vehicleId:'v1',vehicleName:'Wave'};const view=render(<DeleteVehicleDialog {...props}/>);
 fireEvent.click(screen.getByRole('button',{name:'Xoá'}));await waitFor(()=>expect(screen.getByRole('alert').textContent).toContain('v1'));
 expect(props.onOpenChange).not.toHaveBeenCalled();view.rerender(<DeleteVehicleDialog {...props} open={false}/>);view.rerender(<DeleteVehicleDialog {...props}/>);
 fireEvent.click(screen.getByRole('button',{name:'Xoá'}));expect(io.remove).toHaveBeenCalledTimes(1);
});
