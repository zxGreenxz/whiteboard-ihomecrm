import { describe, expect, it } from 'vitest';
import { aggregateSettlementCash, classifySettlementCash, calculateSettlementCurrentDebt, type SettlementCashReceipt, type SettlementDebtInvoice } from '../contractSettlementFinancialFacts';

const receipt = (patch: Partial<SettlementCashReceipt> = {}): SettlementCashReceipt => ({
 id:'receipt',organizationId:'org',type:'INCOME',amount:6000000,approvalStatus:'APPROVED',postingStatus:'POSTED',postingMode:'CASHBOOK',accountId:'account',activePostingId:'posting',sourceVerified:true,itemsComplete:true,isTargetRefund:false,
 items:[{id:'i1',accountingClass:'DEPOSIT',amount:4000000},{id:'i2',accountingClass:'REVENUE',amount:2000000}],
 ledger:{netEffect:6000000,allPostingsVirtual:false,active:{id:'posting',voucherId:'receipt',organizationId:'org',accountId:'account',amount:6000000,netEffect:6000000,virtual:false,reversed:false}},...patch,
});
const invoice=(id='invoice',patch:Partial<SettlementDebtInvoice>={}):SettlementDebtInvoice=>({id,status:'APPROVED',total:1000000,paid:0,remaining:1000000,previousDebt:0,previousSources:[],...patch});
describe('settlement cash evidence',()=>{
 it('splits mixed posted receipts by items, excluding deposit from other actual cash',()=>{
  expect(classifySettlementCash(receipt())).toEqual({state:'verified',amount:6000000,deposit:4000000,other:2000000});
  const result=aggregateSettlementCash([receipt()],true);
  expect(result.depositReceived).toMatchObject({state:'verified',amount:4000000});
  expect(result.otherReceived).toMatchObject({state:'verified',amount:2000000});
 });
 it('approved-unposted, reversed and noncash are not cash received',()=>{
  for(const r of [receipt({postingStatus:'UNPOSTED',activePostingId:null,ledger:{netEffect:0,allPostingsVirtual:false,active:null}}),
   receipt({postingStatus:'REVERSED',activePostingId:null,ledger:{netEffect:0,allPostingsVirtual:false,active:null}}),
   receipt({postingStatus:'NOT_APPLICABLE',postingMode:'NON_CASH',activePostingId:null,ledger:{netEffect:0,allPostingsVirtual:false,active:null}})])expect(classifySettlementCash(r)).toMatchObject({state:'verified',amount:0});
 });
 it('does not allocate partial or inconsistent postings, hidden items or ambiguous source links',()=>{
  for(const r of [receipt({ledger:{...receipt().ledger,netEffect:5000000}}),receipt({activePostingId:null}),
   receipt({ledger:{...receipt().ledger,active:{...receipt().ledger.active!,netEffect:5000000}}}),
   receipt({ledger:{...receipt().ledger,active:{...receipt().ledger.active!,reversed:true}}}),
   receipt({ledger:{...receipt().ledger,active:{...receipt().ledger.active!,accountId:'wrong'}}}),
   receipt({itemsComplete:false}),receipt({sourceVerified:false}),receipt({items:[{id:'i1',accountingClass:'DEPOSIT',amount:4000000}]})])expect(classifySettlementCash(r).state).toBe('unavailable');
 });
 it('does not count virtual recognition as cash or hide a mixed real/virtual chain',()=>{
  const virtual=receipt({ledger:{...receipt().ledger,allPostingsVirtual:true,active:{...receipt().ledger.active!,virtual:true}}});
  expect(classifySettlementCash(virtual)).toMatchObject({state:'verified',amount:0});
  expect(classifySettlementCash({...virtual,ledger:{...virtual.ledger,allPostingsVirtual:false}}).state).toBe('unavailable');
 });
 it('keeps gross deposit receipts separate from actual target refunds and never treats hidden-empty as zero',()=>{
  const refund=receipt({id:'refund',type:'EXPENSE',amount:2000000,isTargetRefund:true,activePostingId:'p2',items:[{id:'r1',accountingClass:'DEPOSIT',amount:2000000}],
   ledger:{netEffect:-2000000,allPostingsVirtual:false,active:{id:'p2',voucherId:'refund',organizationId:'org',accountId:'account',amount:2000000,netEffect:-2000000,virtual:false,reversed:false}}});
  const result=aggregateSettlementCash([receipt(),refund],true);
  expect(result.depositReceived).toMatchObject({state:'verified',amount:4000000});
  expect(result.refunded).toMatchObject({state:'verified',amount:2000000});
  expect(aggregateSettlementCash([],false).depositReceived.state).toBe('unavailable');
  expect(aggregateSettlementCash([],true).depositReceived).toMatchObject({state:'verified',amount:0});
  expect(aggregateSettlementCash([receipt(),receipt()],true).depositReceived.state).toBe('unavailable');
 });
});
describe('current invoice debt, including carry-forward',()=>{
 it('counts a carried source once and keeps paid/offset semantics separate from cash',()=>{
  const source=invoice('source');const carrier=invoice('carrier',{total:3000000,remaining:2500000,paid:500000,previousDebt:1000000,previousSources:[{type:'invoice',id:'source',amount:1000000}]});
  expect(calculateSettlementCurrentDebt([source,carrier],true)).toMatchObject({state:'verified',amount:2500000});
  expect(calculateSettlementCurrentDebt([invoice('paid',{status:'PAID',paid:1000000,remaining:0})],true)).toMatchObject({state:'verified',amount:0});
 });
 it('does not guess legacy carry-forward, missing sources, cycles, double carriers or changed source balances',()=>{
  const source=invoice('source');const carrier=invoice('carrier',{previousDebt:1000000,previousSources:[{type:'invoice',id:'source',amount:1000000}]});
  for(const rows of [[invoice('legacy',{previousDebt:1000000})],[carrier],
   [source,carrier,invoice('other',{previousDebt:1000000,previousSources:[{type:'invoice',id:'source',amount:1000000}]})],
   [{...source,previousDebt:1000000,previousSources:[{type:'invoice',id:'carrier',amount:1000000}]},carrier],
   [invoice('source',{paid:500000,remaining:500000}),carrier]])expect(calculateSettlementCurrentDebt(rows,true).state).toBe('unavailable');
  expect(calculateSettlementCurrentDebt([],false).state).toBe('unavailable');
 });
 it('retains small actual open debt and rejects inconsistent/overflowing amounts',()=>{
  expect(calculateSettlementCurrentDebt([invoice('small',{total:9000,remaining:9000})],true)).toMatchObject({state:'verified',amount:9000});
  expect(calculateSettlementCurrentDebt([invoice('wrong',{remaining:2})],true).state).toBe('unavailable');
  expect(calculateSettlementCurrentDebt([invoice('huge',{total:Number.MAX_SAFE_INTEGER,remaining:Number.MAX_SAFE_INTEGER}),invoice('more')],true).state).toBe('unavailable');
 });
});
