// @vitest-environment jsdom
import {cleanup,fireEvent,render,screen,waitFor} from '@testing-library/react';
import {afterEach,expect,it,vi} from 'vitest';
const io=vi.hoisted(()=>({update:vi.fn(),sourceError:false,retry:vi.fn()}));
vi.mock('@/hooks/useServices',()=>({useUpdateService:()=>({mutateAsync:io.update,isPending:false}),useServiceQuotas:()=>({data:[],isLoading:false,isError:false,refetch:io.retry}),ServiceLinksPartialError:class extends Error {},FEE_TYPE_LABELS:{RENT:'Tiền thuê'},PRICING_TYPE_LABELS:{FIXED:'Cố định'},UNIT_OPTIONS:[]}));
vi.mock('@/hooks/useBuildings',()=>({useBuildings:()=>({data:[{id:'b1',name:'Tòa A'}],isLoading:false,isError:io.sourceError,refetch:io.retry})}));
import {EditServiceDialog} from '../EditServiceDialog';
import {FinancialWorkflowError} from '@/lib/financialWorkflow';
vi.stubGlobal('ResizeObserver',class {observe(){}unobserve(){}disconnect(){}});
afterEach(()=>{cleanup();vi.resetAllMocks();io.sourceError=false;});
const service={id:'s1',name:'Điện',fee_type:'RENT',pricing_type:'FIXED',unit_price:100,unit:'',quota_id:null,description:null,building_services:[{building_id:'b1',is_active:true}]} as never;
it('unknown retains draft and receipt ID across source refresh and blocks repeat',async()=>{
 io.update.mockRejectedValueOnce(new FinancialWorkflowError('Chưa xác nhận dịch vụ.','unknown',[{id:'s1',label:'Dịch vụ đã lưu'}]));
 const close=vi.fn();const view=render(<EditServiceDialog open onOpenChange={close} service={service}/>);
 fireEvent.change(screen.getByPlaceholderText('Nhập tên dịch vụ'),{target:{value:'Draft dịch vụ'}});fireEvent.click(screen.getByRole('button',{name:'Cập nhật'}));await screen.findByRole('alert');
 view.rerender(<EditServiceDialog open={false} onOpenChange={close} service={{...service as object,name:'Reloaded'} as never}/>);view.rerender(<EditServiceDialog open onOpenChange={close} service={{...service as object,name:'Reloaded'} as never}/>);
 expect((screen.getByPlaceholderText('Nhập tên dịch vụ') as HTMLInputElement).value).toBe('Draft dịch vụ');expect(screen.getByRole('alert').textContent).toContain('s1');fireEvent.click(screen.getByRole('button',{name:'Cập nhật'}));expect(io.update).toHaveBeenCalledTimes(1);expect(close).not.toHaveBeenCalled();
});
it('source failure explains retry and blocks writer',async()=>{
 io.sourceError=true;render(<EditServiceDialog open onOpenChange={vi.fn()} service={service}/>);
 expect(screen.getByRole('alert').textContent).toContain('Chưa tải đủ tòa');fireEvent.click(screen.getByRole('button',{name:'Cập nhật'}));expect(io.update).not.toHaveBeenCalled();fireEvent.click(screen.getByRole('button',{name:'Tải lại dữ liệu'}));await waitFor(()=>expect(io.retry).toHaveBeenCalledTimes(2));
});