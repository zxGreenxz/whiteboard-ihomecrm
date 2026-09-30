// @vitest-environment jsdom
import {cleanup,fireEvent,render,screen,waitFor} from '@testing-library/react';
import {afterEach,expect,it,vi} from 'vitest';
import {useFormContext} from 'react-hook-form';
vi.mock('@tanstack/react-query',()=>({useQueryClient:()=>({setQueryData:vi.fn()})}));
vi.mock('../ImageUploadZone',()=>({default:()=>null}));vi.mock('../CCCDQrUpload',()=>({default:()=>null}));vi.mock('../AddressCascadingDropdowns',()=>({default:()=>null}));vi.mock('../CustomerAdministrativeAddress',()=>({default:()=>null}));vi.mock('../CustomerVehiclesSection',()=>({default:()=>null}));vi.mock('../CustomerOrganizationFields',()=>({default:()=>null}));
vi.mock('../CustomerIndividualFields',()=>({default:function MockCustomerIndividualFields(){const {register,formState:{errors}}=useFormContext();return <>{['full_name','phone'].map(name=><label key={name}>{name}<input aria-label={name} {...register(name)}/>{errors[name]?.message&&<span role="alert">{String(errors[name]?.message)}</span>}</label>)}</>;}}));
import CustomerForm from '../CustomerForm';import {FinancialWorkflowError} from '@/lib/financialWorkflow';
afterEach(cleanup);
it('awaits async rejection, keeps entered data/ID and blocks resubmission',async()=>{
 const submit=vi.fn().mockRejectedValue(new FinancialWorkflowError('Khách đã tạo nhưng xe chưa hoàn tất.','partial',[{id:'c1',label:'Khách hàng'}]));
 render(<CustomerForm onSubmit={submit} isSubmitting={false}/>);
 fireEvent.change(screen.getByLabelText('full_name'),{target:{value:'An draft'}});fireEvent.change(screen.getByLabelText('phone'),{target:{value:'0900000000'}});
 fireEvent.click(screen.getByRole('button',{name:'Lưu'}));await waitFor(()=>expect(screen.getByRole('alert').textContent).toContain('c1'));
 expect((screen.getByLabelText('full_name') as HTMLInputElement).value).toBe('An draft');fireEvent.click(screen.getByRole('button',{name:'Lưu'}));expect(submit).toHaveBeenCalledTimes(1);
});
it('does not leak raw server text and supports correcting known field errors',async()=>{
 const submit=vi.fn().mockRejectedValueOnce({code:'42501',message:'raw SQL internal'}).mockResolvedValue(undefined);
 render(<CustomerForm onSubmit={submit} isSubmitting={false} defaultValues={{full_name:'An',phone:'0900000000'}}/>);
 fireEvent.click(screen.getByRole('button',{name:'Lưu'}));await screen.findByRole('alert');expect(document.body.textContent).not.toContain('raw SQL');
 fireEvent.click(screen.getByRole('button',{name:'Lưu'}));await waitFor(()=>expect(submit).toHaveBeenCalledTimes(2));
});
it('shows all client issues and focuses the first without calling writer',async()=>{
 const submit=vi.fn();render(<CustomerForm onSubmit={submit} isSubmitting={false}/>);fireEvent.click(screen.getByRole('button',{name:'Lưu'}));
 await screen.findByText('Họ tên không được để trống');expect(screen.getByText('Số điện thoại phải có 10-11 chữ số')).toBeTruthy();
 await waitFor(()=>expect(document.activeElement).toBe(screen.getByLabelText('full_name')));expect(submit).not.toHaveBeenCalled();
});
