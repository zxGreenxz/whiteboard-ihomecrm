// @vitest-environment jsdom
import {cleanup,fireEvent,render,screen,waitFor} from '@testing-library/react';
import {afterEach,describe,expect,it,vi} from 'vitest';
import {useForm} from 'react-hook-form';
import {zodResolver} from '@hookform/resolvers/zod';
import {invoiceEntrySchema,makeEntryValues,type InvoiceEntryValues} from '@/lib/invoiceEntry';
import {useInvoiceEntry} from '../invoice-entry/useInvoiceEntry';
import {InvoiceEntryShell} from '../invoice-entry/InvoiceEntryShell';
const device=vi.hoisted(()=>({phone:false}));
vi.mock('@/hooks/use-mobile',()=>({usePhoneViewport:()=>device.phone}));
const submit=vi.fn();
function Form(){const defaults=makeEntryValues({billing_month:'2026-09',issue_date:'2026-09-01',due_date:'2026-09-05',custom_items:[{type:'OTHER',description:'',quantity:0,unit_price:0}]});const form=useForm<InvoiceEntryValues>({defaultValues:defaults,resolver:zodResolver(invoiceEntrySchema) as never});const pricing={elec:0,water:0,pdv:0,waterApplicable:false,pdvApplicable:false,hasContractServices:false};const ctl=useInvoiceEntry(form,{baseline:defaults,pricing});return <InvoiceEntryShell open onOpenChange={()=>{}} onSubmit={form.handleSubmit(submit)} mode="create" ctl={ctl} header={{title:'Tạo hoá đơn',invoiceNo:'Mới',building:'A',room:'101',rep:'Khách',lockNote:''}} pricing={pricing} meterId="m1" debt={{sources:[],loading:false,canReload:false,onReload:()=>{}}} creditBalance={0} defaultDepositAmount={0} ready onResetAll={()=>{}} onCancel={()=>{}} footNote="" submit={{label:'Lưu hoá đơn',pendingLabel:'Đang lưu',pending:false,disabled:false}}/>;}
afterEach(()=>{cleanup();vi.clearAllMocks();});
describe.each([false,true])('lỗi từng dòng hoá đơn mobile=%s',phone=>{it('focus mô tả trước số lượng và đánh đỏ đúng hai ô',async()=>{device.phone=phone;render(<Form/>);fireEvent.click(screen.getByRole('button',{name:'Lưu hoá đơn'}));await waitFor(()=>expect(document.activeElement?.getAttribute('name')).toBe('custom_items.0.description'));expect(screen.getByRole('textbox',{name:'Mô tả khoản thu'}).getAttribute('aria-invalid')).toBe('true');expect(screen.getByText('Số lượng phải lớn hơn 0.')).toBeTruthy();expect(submit).not.toHaveBeenCalled();});});
