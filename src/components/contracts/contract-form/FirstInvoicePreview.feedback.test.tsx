// @vitest-environment jsdom
import {useEffect,useState} from 'react';
import {cleanup,fireEvent,render,screen,waitFor} from '@testing-library/react';
import {afterEach,expect,it,vi} from 'vitest';
import {useForm} from 'react-hook-form';
import {Form} from '@/components/ui/form';
import {applyFeedbackToForm} from '@/lib/formErrors';
import {FirstInvoicePreview} from './FirstInvoicePreview';
import type {FirstInvoiceItem} from '@/lib/firstInvoiceBuilder';
afterEach(cleanup);
it('focuses the erroneous read-only deposit row and offers a repair using the confirmed shortfall',async()=>{
 const saved=vi.fn();
 function Fixture(){
  const form=useForm({defaultValues:{start_date:'2026-09-01'}});
  const [items,setItems]=useState<FirstInvoiceItem[]>([{id:'rent',type:'RENT',accounting_class:'REVENUE',description:'Tiền thuê đã sửa',unit_price:200,quantity:1},{id:'deposit',type:'OTHER',accounting_class:'DEPOSIT',description:'Tiền cọc',unit_price:10,quantity:1}]);
  useEffect(()=>{void applyFeedbackToForm(form,{description:'Kiểm tra cọc',fieldErrors:{'invoice_items.deposit.unit_price':'Dòng tiền cọc phải bằng 100 đồng.'}},{root:document.querySelector('form')});},[form]);
  return <Form {...form}><form><FirstInvoicePreview form={form as never} startBilling="2026-09-01" endBilling="2026-09-30" invoiceItems={items} invoiceSubtotal={210} firstInvoiceDiscount={{amount:0,notes:null}} invoiceTotal={210} addInvoiceItem={()=>{}} updateInvoiceItem={()=>{}} removeInvoiceItem={()=>{}} sourceIssues={[]} depositRemaining={100} setInvoiceItems={next=>{setItems(next);saved(next);}}/></form></Form>;
 }
 render(<Fixture/>);
 await waitFor(()=>expect(document.activeElement?.getAttribute('data-field-name')).toBe('invoice_items.deposit.unit_price'));
 expect(document.activeElement?.getAttribute('aria-invalid')).toBe('true');
 fireEvent.click(screen.getByRole('button',{name:'Cập nhật dòng tiền cọc theo phần còn thiếu'}));
 expect(saved).toHaveBeenCalledWith(expect.arrayContaining([expect.objectContaining({id:'deposit',unit_price:100,quantity:1}),expect.objectContaining({id:'rent',unit_price:200,description:'Tiền thuê đã sửa'})]));
 await waitFor(()=>expect(screen.queryByText('Dòng tiền cọc phải bằng 100 đồng.')).toBeNull());
});
