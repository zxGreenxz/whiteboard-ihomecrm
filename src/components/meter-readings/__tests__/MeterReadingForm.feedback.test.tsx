// @vitest-environment jsdom
import {cleanup,fireEvent,render,screen,waitFor} from '@testing-library/react';
import {afterEach,expect,it,vi} from 'vitest';
const io=vi.hoisted(()=>({save:vi.fn(),sourceError:false,retry:vi.fn(),meters:[{meter_id:'m1',meter_code:'M1',meter_name:'Điện P1',room_name:'P1',meter_type_value:'ELECTRICITY',last_reading:5,last_reading_date:null}]}));
vi.mock('@/hooks/useMeterReadings',()=>({useBulkCreateMeterReadings:()=>({mutateAsync:io.save,isPending:false}),useUpdateMeterReading:()=>({mutateAsync:io.save,isPending:false}),MeterReadingBatchPartialError:class extends Error{}}));
vi.mock('@/hooks/useMeters',()=>({useUnrecordedMeters:()=>({data:io.meters,isLoading:false,isError:false,refetch:io.retry})}));
vi.mock('@/hooks/useBuildings',()=>({useBuildings:()=>({data:[{id:'b1',name:'Tòa A'}],isLoading:false,isError:io.sourceError,refetch:io.retry})}));
vi.mock('@/hooks/useRooms',()=>({useRooms:()=>({data:[{id:'r1',name:'P1'}],isLoading:false,isError:false,refetch:io.retry})}));
vi.mock('@/hooks/useAuth',()=>({useAuth:()=>({data:{id:'actor'}})}));
vi.mock('@/lib/storage',()=>({uploadFile:vi.fn(),sanitizeStorageFileName:(v:string)=>v}));
vi.mock('sonner',()=>({toast:{error:vi.fn(),info:vi.fn()}}));
vi.mock('@/components/ui/select',()=>({Select:(p:{children:React.ReactNode;value:string;onValueChange:(value:string)=>void;disabled?:boolean})=><select disabled={p.disabled} value={p.value ?? ''} onChange={e=>p.onValueChange(e.target.value)}><option value=""/>{p.children}</select>,SelectTrigger:()=>null,SelectValue:()=>null,SelectContent:(p:{children:React.ReactNode})=><>{p.children}</>,SelectItem:(p:{value:string;children:React.ReactNode})=><option value={p.value}>{p.children}</option>}));
import MeterReadingForm from '../MeterReadingForm';
import {FinancialWorkflowError,RepeatableWriteUnknownError} from '@/lib/financialWorkflow';
import {MeterReadingsRejectedError} from '@/lib/meterReadingRpc';
vi.stubGlobal('ResizeObserver',class {observe(){}unobserve(){}disconnect(){}});
afterEach(()=>{cleanup();vi.resetAllMocks();io.sourceError=false;});
const reading={id:'r1',meter_id:'m1',building_id:'b1',room_id:'r1',meter_type:'ELECTRICITY',current_reading:10,previous_reading:5,reading_date:'2026-09-30',settlement_month:'2026-09'} as never;
it('required building source error blocks meter reading save with retry',()=>{io.sourceError=true;render(<MeterReadingForm open onOpenChange={vi.fn()} reading={reading}/>);expect(screen.getByRole('alert').textContent).toContain('Chưa tải đủ');fireEvent.click(screen.getByRole('button',{name:'Lưu'}));expect(io.save).not.toHaveBeenCalled();fireEvent.click(screen.getByRole('button',{name:'Tải lại dữ liệu'}));expect(io.retry).toHaveBeenCalled();});
// Đợt 8: sửa một chỉ số là đặt giá trị theo mã, lặp lại được ⇒ kết quả chưa rõ giữ mã và bản nháp qua đóng/tải lại,
// nhưng KHÔNG khoá: bấm Lưu lại gửi lại đúng giá trị đó.
it.each([
  ['lặp lại được',()=>new RepeatableWriteUnknownError('cập nhật chỉ số',undefined,[{id:'r1',label:'Chỉ số cần đối chiếu'}])],
  ['chưa rõ kiểu cũ',()=>new FinancialWorkflowError('Chưa xác nhận chỉ số.','unknown',[{id:'r1',label:'Chỉ số cần đối chiếu'}])],
])('sửa chỉ số chưa rõ kết quả (%s): giữ mã và bản nháp qua đóng/tải lại, không khoá, bấm lại gửi lại',async(_label,failure)=>{io.save.mockRejectedValue(failure());const props={open:true,onOpenChange:vi.fn(),reading};const view=render(<MeterReadingForm {...props}/>);fireEvent.change(screen.getByDisplayValue('10'),{target:{value:'12'}});fireEvent.click(screen.getByRole('button',{name:'Lưu'}));await waitFor(()=>expect(screen.getByRole('alert').textContent).toContain('r1'));view.rerender(<MeterReadingForm {...props} open={false}/>);view.rerender(<MeterReadingForm {...props} reading={{...reading as object,current_reading:99} as never}/>);expect(screen.getByDisplayValue('12')).toBeTruthy();const save=screen.getByRole('button',{name:'Lưu'}) as HTMLButtonElement;expect(save.disabled).toBe(false);fireEvent.click(save);await waitFor(()=>expect(io.save).toHaveBeenCalledTimes(2));expect(io.save).toHaveBeenLastCalledWith(expect.objectContaining({id:'r1',current_reading:12}));expect(props.onOpenChange).not.toHaveBeenCalledWith(false);});

// Đợt 9: ghi hàng loạt gửi lại cùng mã chống trùng (record_meter_readings_v2 khoá toà rồi mới tra mã), nên kết quả chưa rõ
// KHÔNG khoá form: giữ số đã nhập qua làm mới nguồn và đóng/mở, bấm Lưu lại gửi lại đúng các dòng đó.
it('ghi hàng loạt chưa rõ kết quả: giữ số đã nhập qua làm mới nguồn và đóng/mở, không khoá; bấm Lưu lại gửi lại đúng các dòng',async()=>{io.save.mockRejectedValueOnce(new FinancialWorkflowError('Chỉ số mới lưu một phần.','partial',[{id:'r-new',label:'Chỉ số đã nhận mã'}])).mockResolvedValueOnce([]);const props={open:true,onOpenChange:vi.fn(),reading:null};const view=render(<MeterReadingForm {...props}/>);fireEvent.change(screen.getAllByRole('combobox')[0],{target:{value:'b1'}});fireEvent.change(screen.getAllByRole('combobox')[1],{target:{value:'r1'}});const field=await screen.findByLabelText(/Chỉ số mới/);fireEvent.change(field,{target:{value:'12'}});fireEvent.click(screen.getByRole('button',{name:'Lưu'}));await waitFor(()=>expect(screen.getByRole('alert').textContent).toContain('r-new'));io.meters=io.meters.map(row=>({...row,last_reading:7}));view.rerender(<MeterReadingForm {...props} open={false}/>);view.rerender(<MeterReadingForm {...props}/>);expect((screen.getByLabelText(/Chỉ số mới/) as HTMLInputElement).value).toBe('12');const save=screen.getByRole('button',{name:'Lưu'}) as HTMLButtonElement;expect(save.disabled).toBe(false);expect((screen.getByLabelText(/Chỉ số mới/) as HTMLInputElement).disabled).toBe(false);fireEvent.click(save);await waitFor(()=>expect(io.save).toHaveBeenCalledTimes(2));expect(io.save.mock.calls[1][0]).toEqual(io.save.mock.calls[0][0]);await waitFor(()=>expect(props.onOpenChange).toHaveBeenCalledWith(false));});
it('tháng đã có chỉ số: hàm ghi từ chối cả lô ⇒ form nêu lỗi và đánh dấu đúng dòng, không giữ dấu chờ',async()=>{
  io.save.mockRejectedValue(new MeterReadingsRejectedError([{n:1,status:'duplicate_month',roomName:'P1',meterCode:'M1',existingValue:140}]));
  render(<MeterReadingForm open onOpenChange={vi.fn()} reading={null}/>);
  fireEvent.change(screen.getAllByRole('combobox')[0],{target:{value:'b1'}});fireEvent.change(screen.getAllByRole('combobox')[1],{target:{value:'r1'}});
  const field=await screen.findByLabelText(/Chỉ số mới/);fireEvent.change(field,{target:{value:'150'}});
  fireEvent.click(screen.getByRole('button',{name:'Lưu'}));
  await waitFor(()=>expect(screen.getByRole('alert').textContent).toContain('đã có chỉ số tháng này'));
  expect(io.save).toHaveBeenCalledWith([expect.objectContaining({building_id:'b1',meter_id:'m1',current_reading:150})]);
  expect(screen.getAllByText(/P1 \(M1\): đã có chỉ số tháng này \(140\); mở dòng đó để sửa/).length).toBeGreaterThanOrEqual(2);
  // Từ chối đã xác nhận: không khoá form như kết quả chưa rõ, sửa xong lưu lại được.
  fireEvent.click(screen.getByRole('button',{name:'Lưu'}));await waitFor(()=>expect(io.save).toHaveBeenCalledTimes(2));
});
