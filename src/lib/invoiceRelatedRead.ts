import {financialReadRows,financialReadNumber} from './financialReadValidation';
/** The detail query needs complete voucher items before it may display their total. */
export function readInvoiceRelatedVouchers<T extends {items?:{unit_price?:number|null;quantity?:number|null}[]}>(raw:T[]|null|undefined):T[]{
  return financialReadRows(raw).map(row=>({...row,items:financialReadRows(row.items).map(item=>({...item,unit_price:financialReadNumber(item.unit_price),quantity:financialReadNumber(item.quantity)}))}));
}
/** Force cancellation must never show a missing payment amount as zero. */
export function readForceDeletePaymentRows<T extends {amount:number}>(raw:T[]|null|undefined):T[]{
  return financialReadRows(raw).map(row=>({...row,amount:financialReadNumber(row.amount)}));
}
