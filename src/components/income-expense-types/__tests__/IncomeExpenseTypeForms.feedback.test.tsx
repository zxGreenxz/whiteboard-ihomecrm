// @vitest-environment jsdom
import {cleanup,fireEvent,render,screen,waitFor,within} from '@testing-library/react';
import {afterEach,expect,it,vi} from 'vitest';
const io=vi.hoisted(()=>({save:vi.fn(),remove:vi.fn(),sourceError:false,retry:vi.fn()}));
vi.mock('@/hooks/useIncomeExpenseTypes',()=>({useCreateIncomeExpenseType:()=>({mutateAsync:io.save,isPending:false}),useUpdateIncomeExpenseType:()=>({mutateAsync:io.save,isPending:false}),useDeleteIncomeExpenseType:()=>({mutateAsync:io.remove,isPending:false}),useIncomeExpenseTypeCategories:()=>({data:[],isLoading:false,isError:io.sourceError,refetch:io.retry})}));
vi.mock('@/hooks/useMyPermissions',()=>({useMyPermissions:()=>({data:{}})}));
vi.mock('@/lib/permissionPages',()=>({canUse:()=>false}));
vi.mock('../CategoryCombobox',()=>({default:(props:{value:string;onChange:(value:string)=>void})=><input aria-label="Nhóm" value={props.value} onChange={e=>props.onChange(e.target.value)}/>}));
import IncomeExpenseTypeForm from '../IncomeExpenseTypeForm';
import EditIncomeExpenseTypeDialog from '../EditIncomeExpenseTypeDialog';
import {FinancialWorkflowError} from '@/lib/financialWorkflow';
vi.stubGlobal('ResizeObserver',class {observe(){}unobserve(){}disconnect(){}});
afterEach(()=>{cleanup();vi.resetAllMocks();io.sourceError=false;});
it('create type unknown receipt keeps ID and prevents another save',async()=>{io.save.mockRejectedValue(new FinancialWorkflowError('Chưa xác nhận loại.','unknown',[{id:'type1',label:'Loại cần đối chiếu'}]));render(<IncomeExpenseTypeForm defaultType="expense"/>);fireEvent.change(screen.getByPlaceholderText('VD: Vệ sinh máy lạnh'),{target:{value:'Vệ sinh'}});fireEvent.change(screen.getByLabelText('Nhóm'),{target:{value:'Dịch vụ'}});fireEvent.click(screen.getByRole('button',{name:'Lưu'}));await waitFor(()=>expect(screen.getByRole('alert').textContent).toContain('type1'));fireEvent.click(screen.getByRole('button',{name:'Lưu'}));expect(io.save).toHaveBeenCalledTimes(1);});
it('delete failure keeps type confirmation open with ID and prevents replay',async()=>{io.remove.mockRejectedValue(new FinancialWorkflowError('Chưa xác nhận xoá.','unknown',[{id:'type1',label:'Loại cần đối chiếu'}]));render(<EditIncomeExpenseTypeDialog open onOpenChange={vi.fn()} type={{id:'type1',name:'Vệ sinh',type:'expense',category:'Dịch vụ'} as never}/>);fireEvent.click(screen.getByRole('button',{name:'Xoá'}));fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button',{name:'Xoá'}));await waitFor(()=>expect(within(screen.getByRole('alertdialog')).getByRole('alert').textContent).toContain('type1'));fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button',{name:'Xoá'}));expect(io.remove).toHaveBeenCalledTimes(1);});

it('category source failure stops type creation with a retry action',async()=>{io.sourceError=true;render(<IncomeExpenseTypeForm defaultType="expense"/>);expect(screen.getByRole('alert').textContent).toContain('Chưa tải đủ');fireEvent.click(screen.getByRole('button',{name:'Lưu'}));expect(io.save).not.toHaveBeenCalled();fireEvent.click(screen.getByRole('button',{name:'Tải lại dữ liệu'}));expect(io.retry).toHaveBeenCalledTimes(1);});
