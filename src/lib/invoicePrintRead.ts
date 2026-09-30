import {z} from 'zod';
import {financialReadNumber} from './financialReadValidation';
const money=z.union([z.number(),z.string()]).transform(financialReadNumber);
const date=z.string().refine(value=>{
 if(!/^\d{4}-\d{2}-\d{2}$/.test(value))return false;
 const parsed=new Date(`${value}T00:00:00Z`);
 return Number.isFinite(parsed.getTime())&&parsed.toISOString().slice(0,10)===value;
},'Chưa xác nhận được ngày của hóa đơn.');
const invoicePrintSchema=z.object({
 id:z.string().min(1),invoice_number:z.string().nullable().optional(),billing_month:z.string().nullable().optional(),
 total_amount:money,paid_amount:money,subtotal:money,discount_amount:money,previous_debt:money,
 issue_date:date.nullable().optional(),due_date:date.nullable().optional(),creator_name:z.string().nullable().optional(),
 invoice_items:z.array(z.object({id:z.string().min(1),type:z.string().optional(),description:z.string().nullable().optional(),unit_price:money,quantity:money,amount:money,sort_order:money.optional()})),
 payments:z.array(z.object({id:z.string().min(1),amount:money})),
 contract:z.object({contract_number:z.string().nullable().optional(),tenant:z.object({full_name:z.string().nullable().optional(),phone:z.string().nullable().optional()}).nullable().optional()}).nullable().optional(),
 building:z.object({name:z.string().nullable().optional(),address:z.string().nullable().optional()}).nullable().optional(),
 room:z.object({name:z.string().nullable().optional()}).nullable().optional(),
});
export function invoiceForPrint(value:unknown,expectedId:string){
 const invoice=invoicePrintSchema.parse(value);
 if(invoice.id!==expectedId)throw new TypeError('Chưa xác nhận được đúng hóa đơn cần in.');
 return invoice;
}
export function invoicePrintItemLabel(type:string|undefined):string {
 return ({RENT:'Tiền thuê phòng',SERVICE:'Phí dịch vụ',PENALTY:'Tiền phạt',DISCOUNT:'Giảm trừ',OTHER:'Khoản khác'} as Record<string,string>)[type??'']??'Khoản trên hóa đơn';
}
