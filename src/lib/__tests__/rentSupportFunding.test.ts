import { expect, it } from 'vitest';
import { parseSaleBonusStatus, fundingSourceQuoteSchema } from '../rentSupportFunding';
const id='00000000-0000-4000-8000-000000000001';
it('keeps existing voucher evidence separate from any claim of cash paid',()=>{
 const result=parseSaleBonusStatus({contractId:id,alreadyPaid:true,voucherId:id,amount:'500000',status:'APPROVED',via:'DEPOSIT',note:'Có phiếu'});
 expect(result).toMatchObject({hasVoucher:true,alreadyPaid:true,cashPaymentStatus:'UNVERIFIED',amount:500000});
});
it('rejects malformed bonus responses instead of coercing them into financial success',()=>{
 expect(()=>parseSaleBonusStatus({contractId:id,alreadyPaid:'true',voucherId:id})).toThrow();
 expect(()=>parseSaleBonusStatus({contractId:id,alreadyPaid:true,voucherId:null})).toThrow();
 expect(()=>parseSaleBonusStatus({contractId:id,alreadyPaid:false,amount:'NaN'})).toThrow();
});
it('preserves a no-voucher response without claiming zero cash paid',()=>{
 expect(parseSaleBonusStatus({contractId:id,alreadyPaid:false,voucherId:null})).toMatchObject({hasVoucher:false,cashPaymentStatus:'UNVERIFIED',amount:null});
});
it('requires exact decimal text at funding money boundaries',()=>{
 const row={source_id:id,kind:'COMMISSION',gross_original:'3000000',already_paid:'700000',prior_withheld:'300000',remaining_payable:'2000000',available_to_withhold:'2000000',current_withheld:'500000',net_this_operation:'1500000',route:'CASHBOOK',origin:'EXISTING',intent_id:null};
 expect(fundingSourceQuoteSchema.parse(row)).toEqual(row);
 expect(()=>fundingSourceQuoteSchema.parse({...row,gross_original:3000000})).toThrow();
 expect(()=>fundingSourceQuoteSchema.parse({...row,already_paid:'Infinity'})).toThrow();
});
