import {normalizeDateOnly} from './firstInvoiceBuilder';

export function validateContractDepositRows(rows:readonly {uid:string;amount:number;received_date:string}[]):Record<string,string>{
 const errors:Record<string,string>={};
 rows.forEach((row,index)=>{
  const name=`Lần cọc ${index+1}`,key=`deposit_rows.${row.uid}`;
  if(!Number.isSafeInteger(row.amount)||row.amount<=0)errors[`${key}.amount`]=`${name}: nhập số tiền nguyên lớn hơn 0 đồng, hoặc xóa lần cọc chưa nhận.`;
  // A blank date uses the signed date, and a blank fund uses the actor's default fund in the existing RPC.
  if(row.received_date&&normalizeDateOnly(row.received_date)!==row.received_date)errors[`${key}.received_date`]=`${name}: chọn ngày nhận cọc hợp lệ.`;
 });
 return errors;
}
export function validateContractServiceRows(rows:readonly {id:string;name:string;unit_price:number;initial_reading:number;quantity:number}[]):Record<string,string>{
 const errors:Record<string,string>={};
 rows.forEach((row,index)=>{
  const name=`Dòng ${index+1} (${row.name})`,key=`services.${row.id}`;
  if(!Number.isSafeInteger(row.unit_price)||row.unit_price<0)errors[`${key}.unit_price`]=`${name}: đơn giá phải là số nguyên từ 0 đồng.`;
  if(!Number.isFinite(row.initial_reading)||row.initial_reading<0)errors[`${key}.initial_reading`]=`${name}: chỉ số đầu phải từ 0 trở lên.`;
  if(!Number.isSafeInteger(row.quantity)||row.quantity<1)errors[`${key}.quantity`]=`${name}: số lượng phải là số nguyên từ 1.`;
 });
 return errors;
}
