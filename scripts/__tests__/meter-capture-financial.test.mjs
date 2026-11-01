import { describe, expect, it } from 'vitest';
import { financialSource, monthlyInvoiceRequest, zeroMoveOutRequest, assertMonthlyInvoice, assertZeroMoveOut } from '../../.e2e-fleet/support/meter-capture-financial';

const id=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const f={fixtureId:id(1),organizationId:id(2),contractId:id(3),buildingId:id(4),roomId:id(5),meterId:id(6),serviceId:id(7),internalAccountId:id(8),
 marker:`E2E-METER-${id(1)}`,readingDate:'2026-10-23',previousValue:'100.00',currentValue:'120.25'};
const point=(value,reading,version)=>({value,readingId:reading,version,captureId:reading? id(20):null,readingDate:f.readingDate});
const meter={meterId:f.meterId,meterName:f.marker,meterType:'ELECTRICITY',serviceId:f.serviceId,decimalPlaces:2,registerCode:'1.8.0',issues:[],
 start:point('100.00',null,'contract:2026-10-01T00:00:00Z'),end:point('120.25',id(10),'approved-reading-version')};

describe('actual writer smoke intents',()=>{
 it('preserves resolver CAS and passes the production rounded total, not the raw electricity subtotal',()=>{
  const source=financialSource(f,meter,'MONTHLY');const request=monthlyInvoiceRequest(f,source);
  expect(source.startVersion).toBe(meter.start.version);expect(source.endVersion).toBe(meter.end.version);
  expect(request.arguments).toMatchObject({p_subtotal:20250,p_total_amount:20000,p_discount_amount:0,p_previous_debt:0,p_applied_credit:0,p_kind:'MONTHLY'});
  expect(request.arguments.p_items[0]).toMatchObject({quantity:20.25,amount:20250,previous_reading:100,current_reading:120.25,meter_source:source});
  expect(()=>financialSource(f,{...meter,issues:['BILLED_READING_REPLACED']},'MONTHLY')).toThrow();
  expect(()=>monthlyInvoiceRequest(f,{...source,contractId:id(99)})).toThrow();
 });
 it('zero MOVE_OUT starts at the invoice endpoint and uses DEBT without cash, credit or refund operations',()=>{
  const source=financialSource(f,{...meter,start:point('120.25',id(10),'invoice-end-version'),end:point('120.25',id(11),'exit-version')},'MOVE_OUT');
  const request=zeroMoveOutRequest(f,source,'2026-10-23T01:00:00Z',20000);
  expect(request).toMatchObject({action:'exit',rpcName:'confirm_contract_return_v1'});
  expect(request.arguments.p_settlement).toMatchObject({shortfall_mode:'DEBT',outstanding_debt:20000,deposit_refund:0,penalty_fee:0,excess_rent:0,receipt_account_id:null,refund_items:[],extra_charges:[{amount:0,previous_reading:120.25,current_reading:120.25,meter_source:source}]});
  expect(request.arguments.p_meter_boundary).toMatchObject({state:'VERIFIED',readings:[{meter_id:f.meterId,reading:120.25}]});
  expect(()=>financialSource(f,meter,'MOVE_OUT')).toThrow();
 });
 it('assertions reject a paid bill, duplicate settlement invoice, or unrelated internal account',()=>{
  const invoice={id:id(30),organization_id:f.organizationId,contract_id:f.contractId,building_id:f.buildingId,room_id:f.roomId,billing_month:'2026-10',kind:'MONTHLY',status:'APPROVED',subtotal:'20250',total_amount:'20000',paid_amount:'0'};
  expect(assertMonthlyInvoice(f,invoice).total_amount).toBe(20000);
  expect(()=>assertMonthlyInvoice(f,{...invoice,paid_amount:'20000'})).toThrow();
  const termination={contract_id:f.contractId,settlement_invoice_id:null,extra_charges_total:0,applied:0,applied_deposit:0,refund_deposit:0,refund_excess:0,refund_customer:0,shortfall_mode:'DEBT',receipt_account_id:null,acc_internal:f.internalAccountId,charges:20000};
  const exit={id:id(31),organization_id:f.organizationId,contract_id:f.contractId,room_at_handover_id:f.roomId,state:'FINALIZED',actual_move_out_on:f.readingDate,settlement_result:{termination}};
  expect(assertZeroMoveOut(f,exit,20000).id).toBe(exit.id);
  expect(()=>assertZeroMoveOut(f,{...exit,settlement_result:{termination:{...termination,acc_internal:id(99)}}},20000)).toThrow();
  expect(()=>assertZeroMoveOut(f,{...exit,settlement_result:{termination:{...termination,settlement_invoice_id:id(32)}}},20000)).toThrow();
 });
});
