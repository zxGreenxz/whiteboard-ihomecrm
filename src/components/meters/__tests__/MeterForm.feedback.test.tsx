// @vitest-environment jsdom
import {cleanup,fireEvent,render,screen} from '@testing-library/react';
import {afterEach,expect,it,vi} from 'vitest';
const io=vi.hoisted(()=>({update:vi.fn(),sourceError:false,retry:vi.fn()}));
vi.mock('@/hooks/useMeters',()=>({useCreateMeter:()=>({mutateAsync:vi.fn(),isPending:false}),useUpdateMeter:()=>({mutateAsync:io.update,isPending:false})}));
vi.mock('@/hooks/useBuildings',()=>({useBuildings:()=>({data:[{id:'b1',name:'Tòa A'}],isLoading:false,isError:io.sourceError,refetch:io.retry})}));
vi.mock('@/hooks/useRooms',()=>({useRooms:()=>({data:[{id:'r1',name:'101'}],isLoading:false,isError:false,refetch:io.retry})}));
import MeterForm from '../MeterForm';
import {FinancialWorkflowError} from '@/lib/financialWorkflow';
vi.stubGlobal('ResizeObserver',class {observe(){}unobserve(){}disconnect(){}});
afterEach(()=>{cleanup();vi.resetAllMocks();io.sourceError=false;});
const meter={id:'m1',building_id:'b1',room_id:'r1',meter_type:'ELECTRICITY',code:'CT-1',initial_reading:0,installation_date:'',location_note:''} as never;
it('unknown meter receipt preserves draft/ID across refresh and blocks retry',async()=>{
 io.update.mockRejectedValueOnce(new FinancialWorkflowError('Chưa xác nhận công tơ.','unknown',[{id:'m1',label:'Công tơ cần đối chiếu'}]));const close=vi.fn();const view=render(<MeterForm open onOpenChange={close} meter={meter}/>);
 fireEvent.change(screen.getByPlaceholderText('VD: CTD-201'),{target:{value:'Draft mã'}});fireEvent.click(screen.getByRole('button',{name:'Lưu'}));await screen.findByRole('alert');
 view.rerender(<MeterForm open={false} onOpenChange={close} meter={{...meter as object,code:'Reloaded'} as never}/>);view.rerender(<MeterForm open onOpenChange={close} meter={{...meter as object,code:'Reloaded'} as never}/>);
 expect((screen.getByPlaceholderText('VD: CTD-201') as HTMLInputElement).value).toBe('Draft mã');expect(screen.getByRole('alert').textContent).toContain('m1');fireEvent.click(screen.getByRole('button',{name:'Lưu'}));expect(io.update).toHaveBeenCalledTimes(1);expect(close).not.toHaveBeenCalled();
});
it('building source failure is shown with retry and blocks stale meter writes',()=>{io.sourceError=true;render(<MeterForm open onOpenChange={vi.fn()} meter={meter}/>);expect(screen.getByRole('alert').textContent).toContain('Chưa tải đủ');fireEvent.click(screen.getByRole('button',{name:'Lưu'}));expect(io.update).not.toHaveBeenCalled();fireEvent.click(screen.getByRole('button',{name:'Tải lại dữ liệu'}));expect(io.retry).toHaveBeenCalledTimes(2);});
