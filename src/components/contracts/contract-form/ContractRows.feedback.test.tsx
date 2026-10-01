// @vitest-environment jsdom
import {useEffect} from 'react';
import {cleanup,render,screen,waitFor} from '@testing-library/react';
import {afterEach,it,expect,vi} from 'vitest';
import {useForm} from 'react-hook-form';
import {QueryClient,QueryClientProvider} from '@tanstack/react-query';
import {Form} from '@/components/ui/form';
import {applyFeedbackToForm} from '@/lib/formErrors';
import {validateContractDepositRows,validateContractServiceRows} from '@/lib/contractRowFeedback';
import {RentDepositSection} from './RentDepositSection';
import {ServicesSection} from './ServicesSection';
import {CustomersSection} from './CustomersSection';
import type {ContractFormData} from '@/lib/contractValidation';
vi.mock('@/components/income-expenses/AttachmentUpload',()=>({default:()=>null}));
vi.mock('@/contexts/OrganizationContext',()=>({useOrganization:()=>({selectedOrganizationId:null,isLoading:false})}));
vi.stubGlobal('ResizeObserver',class{observe(){} unobserve(){} disconnect(){}});
afterEach(cleanup);
it('shows both incomplete deposit rows and focuses the amount of the second row',async()=>{
 const rows=[{uid:'r1',amount:100,account_id:'',received_date:'',images:[]},{uid:'r2',amount:0,account_id:'',received_date:'',images:[]},{uid:'r3',amount:0,account_id:'',received_date:'2026-02-31',images:[]}];
 function Fixture(){const form=useForm<ContractFormData>({defaultValues:{rent_price:100,total_deposit:100,payment_cycle:'MONTHLY'}});
  useEffect(()=>{void applyFeedbackToForm(form,{description:'Kiểm tra cọc',fieldErrors:validateContractDepositRows(rows)},{root:document.querySelector('form')});},[form]);
  return <Form {...form}><form><RentDepositSection form={form} contractId={undefined} selectedBuildingId="" readonlySupportSchedule={undefined} hasPersistedRentSupport={false} isEditMode={false} roomDefaultRent={0} rentDiffersFromRoom={false} rentUnlocked depositUnlocked unlockRent={()=>{}} unlockDeposit={()=>{}} depositAdjustment={{direction:'NONE',diff:0,rentPrice:100,totalDeposit:100}} depositRemaining={0} depositShortfall={false} depositDebtMode={undefined} depositRows={rows} depositPaidTotal={100} orphanDepositVouchers={[]} accounts={[]} authUser={null} addDepositRow={()=>{}} updateDepositRow={()=>{}} removeDepositRow={()=>{}}/></form></Form>;}
 render(<QueryClientProvider client={new QueryClient()}><Fixture/></QueryClientProvider>);const amount=screen.getByLabelText('Lần cọc 2: số tiền');
 await waitFor(()=>expect(document.activeElement).toBe(amount));expect(amount.getAttribute('aria-invalid')).toBe('true');
 for(const label of ['Lần cọc 3: số tiền','Lần cọc 3: ngày nhận'])expect(screen.getByLabelText(label).getAttribute('aria-invalid')).toBe('true');
 expect(screen.getByText(/Lần cọc 3: chọn ngày/)).toHaveProperty('id','deposit-r3-date-error');
 expect(screen.getByLabelText('Lần cọc 1: sổ quỹ').getAttribute('aria-invalid')).toBe('false');
});
it('marks all service columns and focuses the first column in displayed order',async()=>{
 const rows=[{id:'s1',name:'Nước',unit_price:NaN,initial_reading:-1,quantity:0}];
 function Fixture(){const form=useForm<ContractFormData>();useEffect(()=>{void applyFeedbackToForm(form,{description:'Kiểm tra dịch vụ',fieldErrors:validateContractServiceRows(rows)},{root:document.querySelector('form')});},[form]);
  return <Form {...form}><form><ServicesSection form={form} useCustomServices handleToggleCustomServices={()=>{}} setServiceDialogOpen={()=>{}} buildingActiveServices={[]} buildingServicesAsSelected={[]} selectedBuildingId="b" selectedServices={rows as never} handleServiceFieldChange={()=>{}} handleRemoveService={()=>{}} sourceIssues={[]}/></form></Form>;}
 render(<Fixture/>);await waitFor(()=>expect(document.activeElement).toBe(screen.getByLabelText('Nước: chỉ số đầu')));
 for(const label of ['Nước: chỉ số đầu','Nước: số lượng','Nước: đơn giá'])expect(screen.getByLabelText(label).getAttribute('aria-invalid')).toBe('true');
 expect(screen.getAllByRole('alert')).toHaveLength(3);
});
it('makes the customer picker red and focuses its visible add button',async()=>{
 function Fixture(){const form=useForm<ContractFormData>();useEffect(()=>{void applyFeedbackToForm(form,{description:'Chọn khách',fieldErrors:{customers:'Chọn ít nhất một khách hàng.'}},{root:document.querySelector('form')});},[form]);
  return <Form {...form}><form><CustomersSection form={form} selectedCustomers={[]} setCustomerDialogOpen={()=>{}} handleRepresentativeChange={()=>{}} handleRemoveCustomer={()=>{}} handleCustomerNotesChange={()=>{}}/></form></Form>;}
 render(<Fixture/>);const button=screen.getByRole('button',{name:'Thêm khách hàng'});await waitFor(()=>expect(document.activeElement).toBe(button));
 expect(button.getAttribute('aria-invalid')).toBe('true');expect(button.getAttribute('aria-describedby')).toBe(screen.getByRole('alert').id);
});
