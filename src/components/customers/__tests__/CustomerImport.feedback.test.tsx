// @vitest-environment jsdom
import {cleanup,fireEvent,render,screen,waitFor} from '@testing-library/react';
import {afterEach,expect,it,vi} from 'vitest';
const io=vi.hoisted(()=>({parse:vi.fn()}));
vi.mock('@/lib/customerExcelHelpers',()=>({parseCustomerExcel:io.parse,downloadCustomerImportTemplate:vi.fn()}));
import {CustomerImportExportDialog} from '../CustomerImportExportDialog';
import {FinancialWorkflowError} from '@/lib/financialWorkflow';
afterEach(()=>{cleanup();vi.resetAllMocks();});
it('unknown import retains the file and parsed rows across reopening and blocks another batch',async()=>{
 io.parse.mockResolvedValue({validRows:[{full_name:'Khách',phone:'0900'}],errors:[],warnings:[]});
 const onImport=vi.fn().mockRejectedValue(new FinancialWorkflowError('Đã nhập một phần.','partial',[{id:'c1',label:'Khách đã nhận mã'}]));const props={open:true,onOpenChange:vi.fn(),onImport};const view=render(<CustomerImportExportDialog {...props}/>);
 fireEvent.change(document.querySelector('input[type=file]')!,{target:{files:[new File(['x'],'khach.xlsx')]}});
 fireEvent.click(screen.getByRole('button',{name:'Nhập dữ liệu'}));await screen.findByRole('button',{name:'Xác nhận nhập (1 dòng)'});
 fireEvent.click(screen.getByRole('button',{name:'Xác nhận nhập (1 dòng)'}));await waitFor(()=>expect(screen.getAllByRole('alert').some(e=>e.textContent?.includes('c1'))).toBe(true));
 expect(props.onOpenChange).not.toHaveBeenCalled();view.rerender(<CustomerImportExportDialog {...props} open={false}/>);view.rerender(<CustomerImportExportDialog {...props}/>);
 expect(screen.getByText('khach.xlsx')).toBeTruthy();expect(screen.getByText(/1 dòng hợp lệ/)).toBeTruthy();expect(screen.queryByRole('button',{name:'Xác nhận nhập (1 dòng)'})).toBeNull();
 fireEvent.click(screen.getByRole('button',{name:'Nhập dữ liệu'}));expect(onImport).toHaveBeenCalledTimes(1);expect(io.parse).toHaveBeenCalledTimes(1);
});

it('fully confirmed import closes the dialog after the writer finishes',async()=>{
 io.parse.mockResolvedValue({validRows:[{full_name:'Khách',phone:'0900'}],errors:[],warnings:[]});
 const props={open:true,onOpenChange:vi.fn(),onImport:vi.fn().mockResolvedValue(undefined)};render(<CustomerImportExportDialog {...props}/>);
 fireEvent.change(document.querySelector('input[type=file]')!,{target:{files:[new File(['x'],'khach.xlsx')]}});fireEvent.click(screen.getByRole('button',{name:'Nhập dữ liệu'}));await screen.findByRole('button',{name:'Xác nhận nhập (1 dòng)'});
 fireEvent.click(screen.getByRole('button',{name:'Xác nhận nhập (1 dòng)'}));await waitFor(()=>expect(props.onOpenChange).toHaveBeenCalledWith(false));
});
