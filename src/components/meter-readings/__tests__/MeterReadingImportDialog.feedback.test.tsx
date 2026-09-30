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
it('unknown import keeps its file preview and confirmed IDs across closing, without replay',async()=>{
  io.parse.mockResolvedValue([{meter_code:'M1',reading_date:'2026-09-30',current_reading:12}]);
  io.save.mockRejectedValue(new FinancialWorkflowError('Nhập chỉ số chưa xác nhận đủ.','partial',[{id:'reading-1',label:'Chỉ số đã nhận mã'}]));
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
  fireEvent.click(screen.getByRole('button',{name:'Nhập dữ liệu (1 dòng)'}));
  fireEvent.click(screen.getByRole('button',{name:'Chọn file khác'}));
  expect(io.save).toHaveBeenCalledTimes(1);
  expect(screen.getByText('chiso.xlsx')).toBeTruthy();
});
