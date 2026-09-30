// @vitest-environment jsdom
import {cleanup,fireEvent,render,screen,waitFor,within} from '@testing-library/react';
import {afterEach,expect,it,vi} from 'vitest';
const io=vi.hoisted(()=>({save:vi.fn(),remove:vi.fn(),sourceError:false,retry:vi.fn()}));
vi.mock('@/hooks/useLeads',()=>({useCreateLead:()=>({mutateAsync:io.save,isPending:false}),useUpdateLead:()=>({mutateAsync:io.save,isPending:false}),useDeleteLead:()=>({mutateAsync:io.remove,isPending:false})}));
vi.mock('@/hooks/useBuildings',()=>({useBuildings:()=>({data:[],isLoading:false,isError:io.sourceError,refetch:io.retry})}));
vi.mock('@/hooks/useRooms',()=>({useRooms:()=>({data:[],isLoading:false,isError:false,refetch:io.retry})}));
import {CreateLeadDialog} from '../CreateLeadDialog';
import {EditLeadDialog} from '../EditLeadDialog';
import {FinancialWorkflowError} from '@/lib/financialWorkflow';
vi.stubGlobal('ResizeObserver',class {observe(){}unobserve(){}disconnect(){}});
afterEach(()=>{cleanup();vi.resetAllMocks();io.sourceError=false;});
const lead={id:'l1',customer_name:'An',phone:'0900',source:'PHONE',status:'B1_LEAD'} as never;
it('lead creation is blocked on source failure with retry',()=>{io.sourceError=true;render(<CreateLeadDialog open onOpenChange={vi.fn()}/>);expect(screen.getByRole('alert').textContent).toContain('Chưa tải đủ');fireEvent.click(screen.getByRole('button',{name:'Tạo khách hẹn'}));expect(io.save).not.toHaveBeenCalled();fireEvent.click(screen.getByRole('button',{name:'Tải lại dữ liệu'}));expect(io.retry).toHaveBeenCalled();});
it('unknown lead update keeps ID and edited draft through refresh and blocks replay',async()=>{io.save.mockRejectedValue(new FinancialWorkflowError('Chưa xác nhận khách hẹn.','unknown',[{id:'l1',label:'Khách hẹn cần đối chiếu'}]));const props={open:true,onOpenChange:vi.fn(),lead};const view=render(<EditLeadDialog {...props}/>);fireEvent.change(screen.getByPlaceholderText('Nguyễn Văn A'),{target:{value:'Draft An'}});fireEvent.click(screen.getByRole('button',{name:'Lưu thay đổi'}));await waitFor(()=>expect(screen.getByRole('alert').textContent).toContain('l1'));view.rerender(<EditLeadDialog {...props} lead={{...lead as object,customer_name:'Reloaded'} as never}/>);expect((screen.getByPlaceholderText('Nguyễn Văn A') as HTMLInputElement).value).toBe('Draft An');fireEvent.click(screen.getByRole('button',{name:'Lưu thay đổi'}));expect(io.save).toHaveBeenCalledTimes(1);});
it('lead delete unknown keeps confirmation open and blocks another delete',async()=>{io.remove.mockRejectedValue(new FinancialWorkflowError('Chưa xác nhận xoá.','unknown',[{id:'l1',label:'Khách hẹn cần đối chiếu'}]));render(<EditLeadDialog open onOpenChange={vi.fn()} lead={lead}/>);fireEvent.click(screen.getByRole('button',{name:'Xóa'}));fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button',{name:'Xóa'}));await waitFor(()=>expect(within(screen.getByRole('alertdialog')).getByRole('alert').textContent).toContain('l1'));fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button',{name:'Xóa'}));expect(io.remove).toHaveBeenCalledTimes(1);});
