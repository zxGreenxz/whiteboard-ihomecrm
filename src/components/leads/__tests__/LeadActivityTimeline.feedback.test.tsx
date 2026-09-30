// @vitest-environment jsdom
import {cleanup,fireEvent,render,screen,waitFor} from '@testing-library/react';
import {afterEach,expect,it,vi} from 'vitest';
const io=vi.hoisted(()=>({save:vi.fn(),sourceError:false,retry:vi.fn()}));
vi.mock('@/hooks/useLeadActivities',()=>({useLeadActivities:()=>({data:[],isLoading:false,isError:io.sourceError,error:io.sourceError?new Error('raw SQL'):null,refetch:io.retry}),useCreateLeadActivity:()=>({mutate:vi.fn(),mutateAsync:io.save,isPending:false}),useDeleteLeadActivity:()=>({mutate:vi.fn(),mutateAsync:vi.fn(),isPending:false})}));
import {LeadActivityTimeline} from '../LeadActivityTimeline';
import {FinancialWorkflowError} from '@/lib/financialWorkflow';
vi.stubGlobal('ResizeObserver',class {observe(){}unobserve(){}disconnect(){}});
afterEach(()=>{cleanup();vi.resetAllMocks();io.sourceError=false;});
it('history source failure shows retry instead of an empty timeline',async()=>{io.sourceError=true;render(<LeadActivityTimeline leadId="l1"/>);expect(screen.getByRole('alert').textContent).not.toContain('raw SQL');expect(screen.queryByText('Chưa có hoạt động nào')).toBeNull();fireEvent.click(screen.getByRole('button',{name:/Thử lại|Tải lại/}));await waitFor(()=>expect(io.retry).toHaveBeenCalled());});
it('unknown activity receipt keeps ID and draft across close with no replay',async()=>{io.save.mockRejectedValue(new FinancialWorkflowError('Chưa xác nhận hoạt động.','unknown',[{id:'a1',label:'Hoạt động cần đối chiếu'}]));render(<LeadActivityTimeline leadId="l1"/>);fireEvent.click(screen.getByRole('button',{name:'Thêm'}));fireEvent.change(screen.getByPlaceholderText('VD: Đã gọi điện tư vấn...'),{target:{value:'Draft gọi'}});fireEvent.click(screen.getByRole('button',{name:'Lưu'}));await waitFor(()=>expect(screen.getByRole('alert').textContent).toContain('a1'));fireEvent.click(screen.getByRole('button',{name:'Hủy'}));fireEvent.click(screen.getByRole('button',{name:'Thêm'}));expect((screen.getByPlaceholderText('VD: Đã gọi điện tư vấn...') as HTMLInputElement).value).toBe('Draft gọi');fireEvent.click(screen.getByRole('button',{name:'Lưu'}));expect(io.save).toHaveBeenCalledTimes(1);});
