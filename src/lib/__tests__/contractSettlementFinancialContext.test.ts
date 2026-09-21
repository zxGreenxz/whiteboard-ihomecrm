import { describe, expect, it } from 'vitest';
import { parseSettlementFinancialContext } from '../contractSettlementFinancialContext';
const id='aaaaaaaa-0000-4000-8000-000000000001';
const scope={organizationId:id,roomId:id,contractId:id,terminationId:null,voucherId:null,sourceReceiptId:null};
const wire=()=>({schemaVersion:1,organizationId:id,roomId:id,targetContractId:id,terminationId:null,voucherId:null,sourceReceiptId:null,today:'2026-09-21',generatedAt:'2026-09-21T00:00:00Z',receiptsComplete:true,invoicesComplete:true,receipts:[],invoices:[],depositRequired:4000000,termination:null,obligation:null,notes:null});
describe('financial context boundary',()=>{
 it('requires exact requested scope and preserves complete empty vs unavailable',()=>{
  expect(parseSettlementFinancialContext(wire(),scope).depositReceived).toMatchObject({state:'verified',amount:0});
  expect(parseSettlementFinancialContext({...wire(),receiptsComplete:false},scope).depositReceived.state).toBe('unavailable');
  expect(()=>parseSettlementFinancialContext({...wire(),targetContractId:null},scope)).toThrow();
 });
 it('does not substitute current debt for missing termination or generate refund zero without obligation',()=>{
  const context=parseSettlementFinancialContext(wire(),scope);
  expect(context.terminationDebt.state).toBe('unavailable');
  expect(context.refundOwed.state).toBe('unavailable');
  expect(context.refundRemaining.state).toBe('unavailable');
 });
 it('rejects malformed money, days and receipt data rather than coercing zero',()=>{
  for(const patch of [{depositRequired:'invalid'},{today:'2026-02-30'},{receipts:[{}]},{receiptsComplete:null}])expect(()=>parseSettlementFinancialContext({...wire(),...patch},scope)).toThrow();
 });
});
it('does not promote a draft termination record into verified debt or refund obligation',()=>{
 const term={id,contractId:id,date:'2026-09-21',debt:50,status:'DRAFT',notes:null};
 const obligation={id,terminationId:id,version:1,amount:100,status:'OK',fingerprint:'basis'};
 const context=parseSettlementFinancialContext({...wire(),terminationId:id,termination:term,obligation}, {...scope,terminationId:id});
 expect(context.refundOwed.state).toBe('unavailable');
 expect(context.refundRemaining.state).toBe('unavailable');
 expect(context.terminationDebt.state).toBe('unavailable');
 expect(()=>parseSettlementFinancialContext({...wire(),terminationId:id,termination:{...term,contractId:'bbbbbbbb-0000-4000-8000-000000000001'}},scope)).toThrow();
});

it('keeps an exact, complete termination breakdown for the selected termination only',()=>{
 const term={id,contractId:id,date:'2026-09-21',debt:0,status:'COMPLETED',notes:null};
 const obligation={id,terminationId:id,version:1,amount:2_987_600,status:'OK',fingerprint:'basis'};
 const terminationBreakdown={complete:true,terminationId:id,contractId:id,actualMoveOutDate:'2026-09-20',depositUsed:4_200_000,outstandingDebt:0,
  earlyTerminationFee:1_912_400,rentRefundAmount:700_000,totalDeductions:1_912_400,refundAmount:2_287_600,
  excessRent:0,shortfallMode:null,settlementItems:[
   {description:'Tiền điện',amount:1_512_400,type:'SERVICE'},
   {description:'Tiền vệ sinh',amount:400_000,type:'OTHER'},
  ],refundItems:[{description:'Hoàn tiền phòng ngày không ở',amount:700_000,typeName:'Hoàn tiền phòng thanh lý',isDeposit:false}]};
 const context=parseSettlementFinancialContext({...wire(),terminationId:id,termination:term,obligation,terminationBreakdown},{...scope,terminationId:id});
 expect(context.terminationBreakdown).toEqual({state:'verified',value:terminationBreakdown});
 expect(()=>parseSettlementFinancialContext({...wire(),terminationId:id,termination:term,obligation,terminationBreakdown:{...terminationBreakdown,contractId:'bbbbbbbb-0000-4000-8000-000000000001'}},{...scope,terminationId:id})).toThrow('FINANCIAL_SOURCE');
});

it('does not expose a partial termination breakdown as verified',()=>{
 const term={id,contractId:id,date:'2026-09-21',debt:0,status:'COMPLETED',notes:null};
 const context=parseSettlementFinancialContext({...wire(),terminationId:id,termination:term,terminationBreakdown:{complete:false,terminationId:id,contractId:id,reason:'INVOICE_ITEMS_HIDDEN'}},{...scope,terminationId:id});
 expect(context.terminationBreakdown).toEqual({state:'unavailable',reason:'INVOICE_ITEMS_HIDDEN'});
});

it('keeps a negative refund total because it means the customer still owes money',()=>{
 const term={id,contractId:id,date:'2026-09-21',debt:800_000,status:'COMPLETED',notes:null};
 const terminationBreakdown={complete:true,terminationId:id,contractId:id,actualMoveOutDate:'2026-09-20',depositUsed:1_000_000,outstandingDebt:800_000,
  earlyTerminationFee:500_000,rentRefundAmount:0,totalDeductions:1_300_000,refundAmount:-300_000,
  excessRent:0,shortfallMode:'DEBT',settlementItems:[{description:'Phí thanh lý sớm',amount:500_000,type:'OTHER'}],refundItems:[]};
 const context=parseSettlementFinancialContext({...wire(),terminationId:id,termination:term,terminationBreakdown},{...scope,terminationId:id});
 expect(context.terminationBreakdown).toEqual({state:'verified',value:terminationBreakdown});
});
