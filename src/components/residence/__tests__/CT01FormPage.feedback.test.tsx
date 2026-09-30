// @vitest-environment jsdom
import {cleanup,fireEvent,render,screen,waitFor} from '@testing-library/react';
import {afterEach,expect,it,vi} from 'vitest';
const io=vi.hoisted(()=>({save:vi.fn(),retry:vi.fn(),sourceError:false,print:vi.fn()}));
vi.mock('react-router-dom',()=>({useParams:()=>({id:'c1'}),useNavigate:()=>vi.fn()}));
vi.mock('@/hooks/useCustomers',()=>({useCustomer:()=>({data:{id:'c1',full_name:'Khách'},isLoading:false,isError:io.sourceError,refetch:io.retry})}));
vi.mock('@/hooks/useCT01Declarations',()=>({useCreateCT01Declaration:()=>({mutateAsync:io.save,isPending:false})}));
vi.mock('@/components/customers/CT01Form',()=>({CT01Form:({onSubmit,isLoading}:{onSubmit:(value:unknown)=>unknown;isLoading?:boolean})=><button disabled={isLoading} onClick={()=>void onSubmit({family_members:[]})}>Lưu và in</button>}));
vi.mock('@/components/customers/CT01PrintLayout',()=>({default:()=>null}));
import CT01FormPage from '@/pages/customers/CT01FormPage';
import {FinancialWorkflowError} from '@/lib/financialWorkflow';
afterEach(()=>{cleanup();vi.resetAllMocks();io.sourceError=false;});
it('unknown CT01 ID remains inline and blocks submit without printing',async()=>{vi.stubGlobal('print',io.print);io.save.mockRejectedValue(new FinancialWorkflowError('Chưa xác nhận tờ khai.','unknown',[{id:'ct01-1',label:'Tờ khai cần đối chiếu'}]));render(<CT01FormPage/>);fireEvent.click(screen.getByRole('button',{name:'Lưu và in'}));await waitFor(()=>expect(screen.getByRole('alert').textContent).toContain('ct01-1'));fireEvent.click(screen.getByRole('button',{name:'Lưu và in'}));expect(io.save).toHaveBeenCalledTimes(1);expect(io.print).not.toHaveBeenCalled();});
it('customer read error is retryable and prevents declaration submission',async()=>{io.sourceError=true;render(<CT01FormPage/>);expect(screen.getByRole('alert').textContent).toContain('Chưa tải');expect(screen.queryByRole('button',{name:'Lưu và in'})).toBeNull();fireEvent.click(screen.getByRole('button',{name:'Tải lại'}));await waitFor(()=>expect(io.retry).toHaveBeenCalledTimes(1));});
