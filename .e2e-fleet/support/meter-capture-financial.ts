import assert from 'node:assert/strict';
import { z } from 'zod';
import { buildConfirmContractReturnArgs } from '../../src/lib/contractExitCases';
import { roundInvoiceTotal } from '../../src/lib/invoiceUtils';
import { meterSourceReference, type MeterBillingSource, type MeterSourceReference } from '../../src/lib/meter-capture/types';
import type { MeterLiveFixture } from './meter-capture-live-fixture';

type Fixture = Pick<MeterLiveFixture, 'fixtureId' | 'organizationId' | 'contractId' | 'buildingId' | 'roomId' | 'meterId' | 'serviceId' | 'marker' | 'readingDate' | 'previousValue' | 'currentValue'>;
const number = z.union([z.number(), z.string()]).transform(Number).refine(Number.isFinite);
const uuid = z.string().uuid();

/** Preserve the actual resolver's CAS versions; never reconstruct them from a capture. */
export function financialSource(fixture: Fixture, meter: MeterBillingSource, purpose: 'MONTHLY' | 'MOVE_OUT'): MeterSourceReference {
  assert.equal(meter.meterId, fixture.meterId);
  assert.equal(meter.serviceId, fixture.serviceId);
  const source = meterSourceReference(meter, { contractId: fixture.contractId, month: fixture.readingDate.slice(0, 7),
    readingDate: fixture.readingDate, purpose, sortOrder: 1 });
  assert.equal(Number(source.currentReading), Number(fixture.currentValue));
  assert.equal(Number(source.previousReading), Number(purpose === 'MONTHLY' ? fixture.previousValue : fixture.currentValue));
  return source;
}

export function monthlyInvoiceRequest(fixture: Fixture, source: MeterSourceReference) {
  assert.equal(source.purpose, 'MONTHLY');assert.equal(source.contractId, fixture.contractId);assert.equal(source.meterId, fixture.meterId);
  assert.equal(Number(source.previousReading), Number(fixture.previousValue));assert.equal(Number(source.currentReading), Number(fixture.currentValue));
  const quantity = Number(source.currentReading) - Number(source.previousReading);
  assert(quantity > 0);
  const subtotal = quantity * 1000;
  return { action: 'invoice', organizationId: fixture.organizationId, sources: [source], arguments: {
    p_contract_id: fixture.contractId, p_building_id: fixture.buildingId, p_room_id: fixture.roomId,
    p_billing_month: source.month, p_issue_date: fixture.readingDate, p_due_date: fixture.readingDate,
    p_kind: 'MONTHLY', p_subtotal: subtotal, p_discount_amount: 0, p_total_amount: roundInvoiceTotal(subtotal), p_previous_debt: 0,
    p_items: [{ service_id: fixture.serviceId, type: 'SERVICE', description: fixture.marker, sort_order: 1,
      previous_reading: Number(source.previousReading), current_reading: Number(source.currentReading),
      unit_price: 1000, quantity, coefficient: 1, amount: subtotal,
      from_date: `${source.month}-01`, to_date: fixture.readingDate, accounting_class: 'REVENUE', meter_source: source }],
    p_idempotency_key: `meter-invoice-${fixture.fixtureId}`, p_prepaid_amount: 0, p_applied_credit: 0,
    p_previous_debt_sources: [], p_notes: fixture.marker,
  } };
}

/** The bill stays unpaid. DEBT with no deposit/credit prevents an implicit CT payment. */
export function zeroMoveOutRequest(fixture: Fixture, source: MeterSourceReference, contractUpdatedAt: string, outstandingDebt: number) {
  assert.equal(source.purpose, 'MOVE_OUT');assert.equal(source.contractId, fixture.contractId);assert.equal(source.meterId, fixture.meterId);
  assert.equal(Number(source.previousReading), Number(fixture.currentValue));assert.equal(Number(source.currentReading), Number(fixture.currentValue));
  assert(Number.isFinite(outstandingDebt) && outstandingDebt >= 0);
  const args = buildConfirmContractReturnArgs({ contractId: fixture.contractId, expectedContractUpdatedAt: contractUpdatedAt,
    idempotencyKey: `meter-exit-${fixture.fixtureId}`, actualMoveOutOn: fixture.readingDate,
    initialKind: 'EARLY_RETURN', settlementMode: 'IMMEDIATE', returnNote: fixture.marker,
    meterBoundary: { state: 'VERIFIED', readings: [{ meterId: fixture.meterId, reading: Number(fixture.currentValue),
      measuredAt: `${fixture.readingDate}T00:00:00Z`, evidence: fixture.marker }] },
    settlement: { depositRefund: 0, penaltyFee: 0, excessRent: 0, outstandingDebt,
      notes: fixture.marker, shortfallMode: 'DEBT', receiptAccountId: null, refundItems: [], extraCharges: [{
        kind: 'ELECTRIC', description: fixture.marker, amount: 0, unit_price: 1000, meter_id: fixture.meterId,
        previous_reading: Number(fixture.currentValue), current_reading: Number(fixture.currentValue), meter_source: source,
      }] },
  }, fixture.organizationId);
  return { action: 'exit', organizationId: fixture.organizationId, rpcName: 'confirm_contract_return_v1', arguments: args, sources: [source] };
}

export function assertMonthlyInvoice(fixture: Fixture, raw: unknown) {
  const row = z.object({ id: uuid, organization_id: uuid, contract_id: uuid, building_id: uuid, room_id: uuid,
    billing_month: z.string(), kind: z.string(), status: z.string(), subtotal: number, total_amount: number, paid_amount: number }).parse(raw);
  assert.equal(row.organization_id, fixture.organizationId);assert.equal(row.contract_id, fixture.contractId);
  assert.equal(row.building_id, fixture.buildingId);assert.equal(row.room_id, fixture.roomId);
  assert.equal(row.billing_month, fixture.readingDate.slice(0, 7));assert.equal(row.kind, 'MONTHLY');
  // TEST preflight reads the real org setting; this fixture's org currently auto-approves.
  assert.equal(row.status, 'APPROVED');
  const subtotal = (Number(fixture.currentValue) - Number(fixture.previousValue)) * 1000;
  assert.equal(row.subtotal, subtotal);assert.equal(row.total_amount, roundInvoiceTotal(subtotal));assert.equal(row.paid_amount, 0);
  return row;
}

export function assertZeroMoveOut(fixture: Fixture & { internalAccountId: string }, raw: unknown, outstandingDebt: number) {
  const result = z.object({ id: uuid, organization_id: uuid, contract_id: uuid, room_at_handover_id: uuid,
    state: z.literal('FINALIZED'), actual_move_out_on: z.string(), settlement_result: z.object({ termination: z.object({
      contract_id: uuid, settlement_invoice_id: uuid.nullable(), extra_charges_total: number, applied: number,
      applied_deposit: number, refund_deposit: number, refund_excess: number, refund_customer: number,
      shortfall_mode: z.literal('DEBT'), receipt_account_id: uuid.nullable(), acc_internal: uuid, charges: number,
    }) }) }).parse(raw);
  assert.equal(result.organization_id, fixture.organizationId);assert.equal(result.contract_id, fixture.contractId);
  assert.equal(result.room_at_handover_id, fixture.roomId);assert.equal(result.actual_move_out_on, fixture.readingDate);
  const settlement = result.settlement_result.termination;
  assert.equal(settlement.contract_id, fixture.contractId);assert.equal(settlement.acc_internal, fixture.internalAccountId);
  assert.equal(settlement.settlement_invoice_id, null);assert.equal(settlement.receipt_account_id, null);
  assert.equal(settlement.charges, outstandingDebt);
  for (const value of [settlement.extra_charges_total, settlement.applied, settlement.applied_deposit, settlement.refund_deposit, settlement.refund_excess, settlement.refund_customer]) assert.equal(value, 0);
  return result;
}
