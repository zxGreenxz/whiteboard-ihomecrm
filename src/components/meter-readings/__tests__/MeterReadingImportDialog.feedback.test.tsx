// @vitest-environment jsdom
import {cleanup,fireEvent,render,screen,waitFor} from '@testing-library/react';
import {afterEach,expect,it,vi} from 'vitest';
const io=vi.hoisted(()=>({save:vi.fn(),parse:vi.fn()}));
vi.mock('@/hooks/useMeterReadings',()=>({useImportMeterReadings:()=>({mutateAsync:io.save,isPending:false})}));
vi.mock('@/lib/excelHelpers',()=>({parseMeterReadingExcel:io.parse,downloadMeterReadingImportTemplate:vi.fn()}));
vi.mock('sonner',()=>({toast:{error:vi.fn()}}));
import MeterReadingImportDialog from '../MeterReadingImportDialog';
import {FinancialWorkflowError} from '@/lib/financialWorkflow';
vi.stubGlobal('ResizeObserver',class {observe(){}unobserve(){}disconnect(){}});
afterEach(()=>{cleanup();vi.resetAllMocks();});
// Đợt 9: nhập chỉ số đi qua hàm ghi v2 có mã chống trùng (gửi lại cùng mã thì máy chủ trả phần đã ghi, không ghi hai
// lần), nên kết quả chưa rõ KHÔNG còn khoá hộp: giữ bản xem trước và mã đã xác nhận qua đóng/mở, bấm lại gửi lại đúng tệp.
it('nhập chỉ số chưa rõ kết quả: giữ bản xem trước và mã đã xác nhận qua đóng/mở, không khoá; bấm lại gửi lại đúng các dòng đó',async()=>{
  io.parse.mockResolvedValue([{meter_code:'M1',reading_date:'2026-09-30',current_reading:12}]);
  io.save.mockRejectedValueOnce(new FinancialWorkflowError('Nhập chỉ số chưa xác nhận đủ.','partial',[{id:'reading-1',label:'Chỉ số đã nhận mã'}]))
    .mockResolvedValueOnce([{reading_id:'reading-1',reading_code:'CS1',success:true,error_message:null}]);
  const props={open:true,onOpenChange:vi.fn()};
  const view=render(<MeterReadingImportDialog {...props}/>);
  fireEvent.change(document.querySelector('input[type=file]')!,{target:{files:[new File(['data'],'chiso.xlsx')]}});
  await screen.findByText('chiso.xlsx');
  fireEvent.click(screen.getByRole('button',{name:'Nhập dữ liệu (1 dòng)'}));
  await waitFor(()=>expect(screen.getByRole('alert').textContent).toContain('reading-1'));
  view.rerender(<MeterReadingImportDialog {...props} open={false}/>);
  view.rerender(<MeterReadingImportDialog {...props}/>);
  expect(screen.getByText('chiso.xlsx')).toBeTruthy();
  expect(screen.getByText('M1')).toBeTruthy();
  expect((screen.getByRole('button',{name:'Chọn file khác'}) as HTMLButtonElement).disabled).toBe(false);
  const retry=screen.getByRole('button',{name:'Nhập dữ liệu (1 dòng)'}) as HTMLButtonElement;
  expect(retry.disabled).toBe(false);
  fireEvent.click(retry);
  await screen.findByText('Kết quả nhập dữ liệu');
  expect(io.save).toHaveBeenCalledTimes(2);
  expect(io.save.mock.calls[1][0]).toEqual(io.save.mock.calls[0][0]);
});
it('kết quả chưa rõ rồi chọn file khác: quay về bước tải tệp, không khoá',async()=>{
  io.parse.mockResolvedValue([{meter_code:'M1',reading_date:'2026-09-30',current_reading:12}]);
  io.save.mockRejectedValue(new FinancialWorkflowError('Nhập chỉ số chưa xác nhận đủ.','unknown',[]));
  render(<MeterReadingImportDialog open onOpenChange={vi.fn()}/>);
  fireEvent.change(document.querySelector('input[type=file]')!,{target:{files:[new File(['data'],'chiso.xlsx')]}});
  await screen.findByText('chiso.xlsx');
  fireEvent.click(screen.getByRole('button',{name:'Nhập dữ liệu (1 dòng)'}));
  await screen.findByRole('alert');
  fireEvent.click(screen.getByRole('button',{name:'Chọn file khác'}));
  expect(screen.getByText('Kéo thả file vào đây hoặc nhấn để chọn file')).toBeTruthy();
});
