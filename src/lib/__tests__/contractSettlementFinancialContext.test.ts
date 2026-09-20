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
