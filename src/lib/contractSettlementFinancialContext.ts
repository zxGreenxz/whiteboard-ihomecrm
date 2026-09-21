import { z } from 'zod';
import { aggregateSettlementCash, calculateSettlementCurrentDebt, type SettlementCashReceipt, type SettlementDebtInvoice, type SettlementMoneyFact } from './contractSettlementFinancialFacts';
import type { VerifiedTerminationBreakdown } from './terminationRefundNote';
const id=z.string().uuid();
const day=z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(s=>{const d=new Date(s+'T00:00:00Z');return Number.isFinite(+d)&&d.toISOString().slice(0,10)===s;});
const money=z.number().refine(Number.isSafeInteger);
const receipt=z.object({id,organizationId:id,type:z.enum(['INCOME','EXPENSE']),amount:money,approvalStatus:z.enum(['UNAPPROVED','APPROVED','CANCELLED']),postingStatus:z.enum(['UNPOSTED','POSTED','REVERSED','NOT_APPLICABLE']),postingMode:z.enum(['CASHBOOK','NON_CASH']),accountId:id.nullable(),activePostingId:id.nullable(),sourceVerified:z.boolean(),itemsComplete:z.boolean(),isTargetRefund:z.boolean(),items:z.array(z.object({id,accountingClass:z.string(),amount:money})),ledger:z.object({netEffect:money,allPostingsVirtual:z.boolean(),active:z.object({id,voucherId:id,organizationId:id,accountId:id,amount:money,netEffect:money,virtual:z.boolean(),reversed:z.boolean()}).nullable()})});
const invoice=z.object({id,status:z.string(),total:money,paid:money,remaining:money,previousDebt:money,previousSources:z.array(z.object({type:z.string(),id:z.string(),amount:money}))});
const nonnegativeMoney=z.number().int().safe().nonnegative();
const breakdownItem=z.object({description:z.string().min(1),amount:nonnegativeMoney,type:z.string().nullable()});
const refundItem=z.object({description:z.string(),amount:nonnegativeMoney,typeName:z.string().nullable(),isDeposit:z.boolean()});
const breakdownIdentity=z.object({terminationId:id,contractId:id});
const terminationBreakdown=z.discriminatedUnion('complete',[
 breakdownIdentity.extend({complete:z.literal(false),reason:z.string().min(1)}),
 breakdownIdentity.extend({complete:z.literal(true),actualMoveOutDate:day.nullable(),depositUsed:nonnegativeMoney,outstandingDebt:nonnegativeMoney,earlyTerminationFee:nonnegativeMoney,
  rentRefundAmount:nonnegativeMoney,totalDeductions:nonnegativeMoney.nullable(),refundAmount:money.nullable(),excessRent:nonnegativeMoney,
  shortfallMode:z.enum(['PAID','DEBT']).nullable(),settlementItems:z.array(breakdownItem),refundItems:z.array(refundItem)}),
]);
const schema=z.object({schemaVersion:z.literal(1),organizationId:id,roomId:id.nullable(),targetContractId:id.nullable(),terminationId:id.nullable(),voucherId:id.nullable(),sourceReceiptId:id.nullable(),today:day,generatedAt:z.string().datetime({offset:true}),receiptsComplete:z.boolean(),invoicesComplete:z.boolean(),receipts:z.array(receipt),invoices:z.array(invoice),depositRequired:money.nullable(),termination:z.object({id,contractId:id,date:day.nullable(),debt:money.nullable(),status:z.string(),notes:z.string().nullable()}).nullable(),terminationBreakdown:terminationBreakdown.nullable().optional(),obligation:z.object({id,terminationId:id,version:z.number().int().positive(),amount:money,status:z.string(),fingerprint:z.string()}).nullable(),notes:z.object({contractNumber:z.string().nullable(),roomName:z.string().nullable(),signedDate:day.nullable(),startDate:day.nullable(),endDate:day.nullable(),rentPrice:money.nullable(),voucherNotes:z.string().nullable()}).nullable()});
export interface SettlementFinancialScope { organizationId:string; roomId:string|null; contractId:string|null; terminationId:string|null; voucherId:string|null; sourceReceiptId:string|null }
type VerifiedBreakdownWire=VerifiedTerminationBreakdown&{complete:true;terminationId:string;contractId:string};
type UnavailableBreakdownWire={complete:false;terminationId:string;contractId:string;reason:string};
const unknown=(reason:string):SettlementMoneyFact=>({state:'unavailable',reason});
const fact=(amount:number|null,basis:string):SettlementMoneyFact=>amount!==null&&Number.isSafeInteger(amount)&&amount>=0?{state:'verified',amount,basis}:unknown('SOURCE_UNVERIFIED');
export function parseSettlementFinancialContext(input:unknown,scope:SettlementFinancialScope){
 // Complete runtime schema validation precedes this assertion (app strictNullChecks is disabled).
 const value=schema.parse(input) as z.output<typeof schema> & {receipts:SettlementCashReceipt[];invoices:SettlementDebtInvoice[]};
 if(value.organizationId!==scope.organizationId||value.voucherId!==scope.voucherId||value.sourceReceiptId!==scope.sourceReceiptId
 ||(scope.roomId!==null&&value.roomId!==scope.roomId)||(scope.contractId!==null&&value.targetContractId!==scope.contractId)
 ||(scope.terminationId!==null&&value.terminationId!==scope.terminationId))throw Error('FINANCIAL_SCOPE');
 if(value.receipts.some(r=>r.organizationId!==scope.organizationId)||value.termination&&(value.termination.id!==value.terminationId||value.termination.contractId!==value.targetContractId)
 ||value.obligation&&value.obligation.terminationId!==value.terminationId
 ||value.terminationBreakdown&&(value.terminationBreakdown.terminationId!==value.terminationId||value.terminationBreakdown.contractId!==value.targetContractId||!value.termination))throw Error('FINANCIAL_SOURCE');
 const cash=aggregateSettlementCash(value.receipts,value.receiptsComplete);
 const refundOwed=value.obligation&&value.termination&&['APPROVED','COMPLETED'].includes(value.termination.status)&&['OK'].includes(value.obligation.status)?fact(value.obligation.amount,'EXACT_REFUND_OBLIGATION'):unknown('OBLIGATION_UNVERIFIED');
 const refunded=value.terminationId?cash.refunded:unknown('TERMINATION_UNAVAILABLE');
 const refundRemaining=refundOwed.state==='verified'&&refunded.state==='verified'?fact(refundOwed.amount-refunded.amount,'OBLIGATION_MINUS_EFFECTIVE_REFUNDS'):unknown('REFUND_COVERAGE_UNVERIFIED');
 const parsedBreakdown=value.terminationBreakdown as VerifiedBreakdownWire|UnavailableBreakdownWire|null|undefined;
 const verifiedBreakdown=parsedBreakdown?.complete===true
  ? {state:'verified' as const,value:parsedBreakdown}
  : {state:'unavailable' as const,reason:parsedBreakdown?.complete===false?parsedBreakdown.reason:'TERMINATION_BREAKDOWN_UNAVAILABLE'};
 return {...value,terminationBreakdown:verifiedBreakdown,depositRequired:fact(value.depositRequired,'CONTRACT_REQUIRED_DEPOSIT'),...cash,refunded,refundOwed,refundRemaining,
 currentDebt:value.targetContractId?calculateSettlementCurrentDebt(value.invoices,value.invoicesComplete):unknown('CONTRACT_UNAVAILABLE'),
 terminationDebt:value.termination&&['APPROVED','COMPLETED'].includes(value.termination.status)?fact(value.termination.debt,'TERMINATION_RECORD_SNAPSHOT'):unknown('TERMINATION_SNAPSHOT_UNAVAILABLE')};
}
export type SettlementFinancialContext=ReturnType<typeof parseSettlementFinancialContext>;
