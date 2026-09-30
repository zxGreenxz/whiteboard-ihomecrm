// @vitest-environment jsdom
import {cleanup,fireEvent,render,screen,waitFor} from '@testing-library/react';
import {afterEach,expect,it,vi} from 'vitest';
const io=vi.hoisted(()=>({save:vi.fn()}));
vi.mock('@/hooks/useIncomeExpenseTemplates',()=>({useCreateIncomeExpenseTemplate:()=>({mutateAsync:io.save,isPending:false}),useUpdateIncomeExpenseTemplate:()=>({mutateAsync:io.save,isPending:false})}));
import IncomeExpenseTemplateForm from '../IncomeExpenseTemplateForm';
import {FinancialWorkflowError} from '@/lib/financialWorkflow';
vi.stubGlobal('ResizeObserver',class {observe(){}unobserve(){}disconnect(){}});
afterEach(()=>{cleanup();vi.resetAllMocks();});
it('unknown template receipt preserves ID and draft after close/refresh and blocks replay',async()=>{io.save.mockRejectedValue(new FinancialWorkflowError('Chưa xác nhận mẫu.','unknown',[{id:'t1',label:'Mẫu cần đối chiếu'}]));const props={open:true,onOpenChange:vi.fn(),template:{id:'t1',name:'Mẫu A'} as never};const view=render(<IncomeExpenseTemplateForm {...props}/>);fireEvent.change(screen.getByPlaceholderText('VD: Mẫu biên lai thu tiền'),{target:{value:'Draft mẫu'}});fireEvent.click(screen.getByRole('button',{name:'Lưu'}));await waitFor(()=>expect(screen.getByRole('alert').textContent).toContain('t1'));view.rerender(<IncomeExpenseTemplateForm {...props} open={false}/>);view.rerender(<IncomeExpenseTemplateForm {...props} template={{id:'t1',name:'Reloaded'} as never}/>);expect((screen.getByPlaceholderText('VD: Mẫu biên lai thu tiền') as HTMLInputElement).value).toBe('Draft mẫu');fireEvent.click(screen.getByRole('button',{name:'Lưu'}));expect(io.save).toHaveBeenCalledTimes(1);});
