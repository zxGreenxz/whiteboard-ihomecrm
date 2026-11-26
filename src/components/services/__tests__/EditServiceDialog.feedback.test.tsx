// @vitest-environment jsdom
import {cleanup,fireEvent,render,screen,waitFor} from '@testing-library/react';
import {afterEach,expect,it,vi} from 'vitest';
const io=vi.hoisted(()=>({update:vi.fn(),sourceError:false,retry:vi.fn()}));
vi.mock('@/hooks/useServices',()=>({useUpdateService:()=>({mutateAsync:io.update,isPending:false}),useServiceQuotas:()=>({data:[],isLoading:false,isError:false,refetch:io.retry}),ServiceLinksPartialError:class extends Error {},FEE_TYPE_LABELS:{RENT:'Tiền thuê'},PRICING_TYPE_LABELS:{FIXED:'Cố định'},UNIT_OPTIONS:[]}));
vi.mock('@/hooks/useBuildings',()=>({useBuildings:()=>({data:[{id:'b1',name:'Tòa A'}],isLoading:false,isError:io.sourceError,refetch:io.retry})}));
import {EditServiceDialog} from '../EditServiceDialog';
import {FinancialWorkflowError,RepeatableWriteUnknownError} from '@/lib/financialWorkflow';
vi.stubGlobal('ResizeObserver',class {observe(){}unobserve(){}disconnect(){}});
afterEach(()=>{cleanup();vi.resetAllMocks();io.sourceError=false;});
const service={id:'s1',name:'Điện',fee_type:'RENT',pricing_type:'FIXED',unit_price:100,unit:'',quota_id:null,description:null,building_services:[{building_id:'b1',is_active:true}]} as never;
// Đợt 8: sửa dịch vụ lặp lại được ⇒ kết quả chưa rõ giữ bản nháp và mã qua tải lại nguồn, nhưng không khoá nút Cập nhật.
it.each([
 ['lặp lại được',()=>new RepeatableWriteUnknownError('lưu tòa áp dụng (thông tin dịch vụ đã lưu)',undefined,[{id:'s1',label:'Dịch vụ đã lưu'}])],
 ['chưa rõ kiểu cũ',()=>new FinancialWorkflowError('Chưa xác nhận dịch vụ.','unknown',[{id:'s1',label:'Dịch vụ đã lưu'}])],
])('unknown (%s) retains draft and receipt ID across source refresh, and allows saving again',async(_label,failure)=>{
 io.update.mockRejectedValueOnce(failure()).mockResolvedValueOnce({id:'s1'});
 const close=vi.fn();const view=render(<EditServiceDialog open onOpenChange={close} service={service}/>);
 fireEvent.change(screen.getByPlaceholderText('Nhập tên dịch vụ'),{target:{value:'Draft dịch vụ'}});fireEvent.click(screen.getByRole('button',{name:'Cập nhật'}));await screen.findByRole('alert');
 view.rerender(<EditServiceDialog open={false} onOpenChange={close} service={{...service as object,name:'Reloaded'} as never}/>);view.rerender(<EditServiceDialog open onOpenChange={close} service={{...service as object,name:'Reloaded'} as never}/>);
 expect((screen.getByPlaceholderText('Nhập tên dịch vụ') as HTMLInputElement).value).toBe('Draft dịch vụ');expect(screen.getByRole('alert').textContent).toContain('s1');
 const submit=screen.getByRole('button',{name:'Cập nhật'}) as HTMLButtonElement;expect(submit.disabled).toBe(false);fireEvent.click(submit);
 await waitFor(()=>expect(io.update).toHaveBeenCalledTimes(2));expect(io.update).toHaveBeenLastCalledWith(expect.objectContaining({id:'s1',updates:expect.objectContaining({name:'Draft dịch vụ'})}));await waitFor(()=>expect(close).toHaveBeenCalledWith(false));
});
it('source failure explains retry and blocks writer',async()=>{
 io.sourceError=true;render(<EditServiceDialog open onOpenChange={vi.fn()} service={service}/>);
 expect(screen.getByRole('alert').textContent).toContain('Chưa tải đủ tòa');fireEvent.click(screen.getByRole('button',{name:'Cập nhật'}));expect(io.update).not.toHaveBeenCalled();fireEvent.click(screen.getByRole('button',{name:'Tải lại dữ liệu'}));await waitFor(()=>expect(io.retry).toHaveBeenCalledTimes(2));
});