// @vitest-environment jsdom
import {cleanup,fireEvent,render,screen,waitFor} from '@testing-library/react';
import {afterEach,expect,it,vi} from 'vitest';
const io=vi.hoisted(()=>({parse:vi.fn()}));
vi.mock('@/lib/customerExcelHelpers',()=>({parseCustomerExcel:io.parse,downloadCustomerImportTemplate:vi.fn()}));
import {CustomerImportExportDialog} from '../CustomerImportExportDialog';
import {FinancialWorkflowError} from '@/lib/financialWorkflow';
afterEach(()=>{cleanup();vi.resetAllMocks();});
// Đợt 4: lượt nhập không giữ dấu chung nữa. Dòng chưa xong được giữ lại (cùng mã khách của từng dòng) để nhập lại;
// hộp không bị khoá tới khi tải lại trang như trước.
it('dòng chưa xong: hộp giữ đúng các dòng đó qua đóng/mở lại và cho nhập lại cùng mã, không khoá',async()=>{
 const row={full_name:'Khách',phone:'0900',client_id:'id-1'};
 io.parse.mockResolvedValue({validRows:[row,{full_name:'Khách 2',phone:'0901',client_id:'id-2'}],errors:[],warnings:[]});
 const onImport=vi.fn().mockResolvedValueOnce([row]).mockResolvedValueOnce([]);const props={open:true,onOpenChange:vi.fn(),onImport};const view=render(<CustomerImportExportDialog {...props}/>);
 fireEvent.change(document.querySelector('input[type=file]')!,{target:{files:[new File(['x'],'khach.xlsx')]}});
 fireEvent.click(screen.getByRole('button',{name:'Nhập dữ liệu'}));await screen.findByRole('button',{name:'Xác nhận nhập (2 dòng)'});
 fireEvent.click(screen.getByRole('button',{name:'Xác nhận nhập (2 dòng)'}));
 await screen.findByRole('button',{name:'Nhập lại (1 dòng chưa xong)'});
 expect(screen.getAllByRole('alert').some(e=>e.textContent?.includes('Còn 1 dòng'))).toBe(true);
 expect(props.onOpenChange).not.toHaveBeenCalled();view.rerender(<CustomerImportExportDialog {...props} open={false}/>);view.rerender(<CustomerImportExportDialog {...props}/>);
 fireEvent.click(screen.getByRole('button',{name:'Nhập lại (1 dòng chưa xong)'}));
 await waitFor(()=>expect(props.onOpenChange).toHaveBeenCalledWith(false));
 expect(onImport).toHaveBeenCalledTimes(2);
 expect(onImport.mock.calls[1][0]).toEqual([expect.objectContaining({client_id:'id-1'})]);
});

it('đọc lại cùng file trong phiên này giữ đúng mã khách của từng dòng',async()=>{
 io.parse.mockResolvedValueOnce({validRows:[{full_name:'Khách',phone:'0900',client_id:'id-1'}],errors:[],warnings:[]})
  .mockResolvedValueOnce({validRows:[{full_name:'Khách',phone:'0900',client_id:'id-moi'}],errors:[],warnings:[]});
 const onImport=vi.fn().mockRejectedValue(new FinancialWorkflowError('Lỗi lạ.','unknown',[]));render(<CustomerImportExportDialog open onOpenChange={vi.fn()} onImport={onImport}/>);
 fireEvent.change(document.querySelector('input[type=file]')!,{target:{files:[new File(['x'],'khach.xlsx')]}});
 fireEvent.click(screen.getByRole('button',{name:'Nhập dữ liệu'}));await screen.findByRole('button',{name:'Xác nhận nhập (1 dòng)'});
 fireEvent.click(screen.getByRole('button',{name:'Xác nhận nhập (1 dòng)'}));await waitFor(()=>expect(onImport).toHaveBeenCalledTimes(1));
 fireEvent.click(screen.getByRole('button',{name:'Nhập dữ liệu'}));await waitFor(()=>expect(io.parse).toHaveBeenCalledTimes(2));
 fireEvent.click(await screen.findByRole('button',{name:'Xác nhận nhập (1 dòng)'}));await waitFor(()=>expect(onImport).toHaveBeenCalledTimes(2));
 expect(onImport.mock.calls[1][0]).toEqual([expect.objectContaining({client_id:'id-1'})]);
});

it('fully confirmed import closes the dialog after the writer finishes',async()=>{
 io.parse.mockResolvedValue({validRows:[{full_name:'Khách',phone:'0900'}],errors:[],warnings:[]});
 const props={open:true,onOpenChange:vi.fn(),onImport:vi.fn().mockResolvedValue(undefined)};render(<CustomerImportExportDialog {...props}/>);
 fireEvent.change(document.querySelector('input[type=file]')!,{target:{files:[new File(['x'],'khach.xlsx')]}});fireEvent.click(screen.getByRole('button',{name:'Nhập dữ liệu'}));await screen.findByRole('button',{name:'Xác nhận nhập (1 dòng)'});
 fireEvent.click(screen.getByRole('button',{name:'Xác nhận nhập (1 dòng)'}));await waitFor(()=>expect(props.onOpenChange).toHaveBeenCalledWith(false));
});
