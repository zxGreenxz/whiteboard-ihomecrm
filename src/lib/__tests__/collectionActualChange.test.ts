import { describe, expect, it } from 'vitest';
import { buildRecordInvoiceCollectionRpcArgs, planInvoiceCollection, type InvoiceCollectionPlanningInput } from '../paymentRecordRpc';
import { planCollect } from '../collectPlan';

const input = (change: number, total = 4_805_000): InvoiceCollectionPlanningInput => ({
  invoice_id: 'invoice', collection_date: '2026-09-08', invoice_total_amount: total,
  expected_paid_amount: 0, deposit_due: 0, has_contract: true,
  overpay_action: 'REFUND', actual_change_amount: change, allow_rounding: true,
  tenders: [{ payment_method: 'TM', gross_amount: 5_000_000, account_id: 'cash',
    change_account_id: 'change', rounding_account_id: 'rounding' }],
});

describe('actual change and waived shortfall', () => {
  it.each([0, 1, 100, 4_999, 5_000, 9_999, 10_000, 10_001])('accounts for %i shortfall after change', (shortfall) => {
    const p = planInvoiceCollection(input(195_000 + shortfall));
    expect(p.change_amount).toBe(195_000 + shortfall);
    expect(p.applied_amount).toBe(4_805_000 - shortfall);
    expect(p.retained_amount).toBe(p.applied_amount);
    expect(p.rounding_amount).toBe(shortfall > 0 && shortfall < 10_000 ? shortfall : 0);
    expect(p.gross_amount).toBe(p.retained_amount + p.change_amount);
    expect(p.tenders.reduce((s,t) => s + t.applied_amount,0)).toBe(p.applied_amount);
  });

  it('uses the same net money rule in Thu tiền', () => {
    expect(planCollect({ lines: [{ method: 'TM', amount: 5_000_000 }], remaining: 4_805_000,
      changeAmount: 200_000 })).toMatchObject({ ok: true, plan: { change: 200_000, rounding: 5_000 } });
  });

  it.each([194_999, -1, NaN, Infinity, 195_000.001, 5_000_000, 5_000_001])('rejects invalid or unbalanced change %s', (change) => {
    expect(() => planInvoiceCollection(input(change))).toThrow();
    expect(planCollect({ lines: [{ method: 'TM', amount: 5_000_000 }], remaining: 4_805_000, changeAmount: change }).ok).toBe(false);
  });

  it('does not waive unpaid deposit', () => {
    expect(() => planInvoiceCollection({ ...input(200_000), deposit_due: 1_000_000 })).toThrow(/cọc/);
  });

  it('keeps shortage as debt when rounding is disabled', () => {
    expect(planInvoiceCollection({ ...input(200_000), allow_rounding: false }).rounding_amount).toBe(0);
  });

  it('does not combine explicit change with credit', () => {
    expect(() => planInvoiceCollection({ ...input(200_000), overpay_action: 'CREDIT' })).toThrow();
  });

  it('splits actual change from last TM backwards without touching bank money', () => {
    const i = { ...input(200_000), tenders: [
      { payment_method: 'TM' as const, gross_amount: 500_000, account_id: 'cash1', change_account_id: 'change' },
      { payment_method: 'TK' as const, gross_amount: 4_400_000, account_id: 'bank' },
      { payment_method: 'TM' as const, gross_amount: 100_000, account_id: 'cash2', change_account_id: 'change', rounding_account_id: 'rounding' },
    ] };
    const p = planInvoiceCollection(i);
    expect(p.tenders.map(t => t.change_amount)).toEqual([100_000, 0, 100_000]);
    expect(p.tenders.map(t => t.applied_amount)).toEqual([400_000, 4_400_000, 0]);
    expect(p.rounding_amount).toBe(5_000);
    expect(p.tenders.map(t => t.rounding_amount)).toEqual([0, 5_000, 0]);
    const args = buildRecordInvoiceCollectionRpcArgs(i, 'change-test-0001');
    expect(args.p_tenders).toMatchObject([
      { requested_change_amount: 100_000 }, { payment_method: 'TK' }, { requested_change_amount: 100_000 },
    ]);
    expect(args.p_tenders[1]).not.toHaveProperty('requested_change_amount');
  });

  it('rejects change exceeding cash even when gross includes TK', () => {
    expect(() => planInvoiceCollection({ ...input(200_000), tenders: [
      { payment_method: 'TK', gross_amount: 4_900_000, account_id: 'bank' },
      { payment_method: 'TM', gross_amount: 100_000, account_id: 'cash', change_account_id: 'change' },
    ] })).toThrow();
  });

  it('does not add optional tender fields to legacy payloads', () => {
    const i = input(195_000);
    delete i.actual_change_amount;
    const args = buildRecordInvoiceCollectionRpcArgs(i, 'legacy-test-0001');
    expect(args.p_tenders[0]).not.toHaveProperty('requested_change_amount');
    expect(planInvoiceCollection(i).change_amount).toBe(195_000);
  });

  it('supports refund from an exact gross payment without discarding debt', () => {
    const p = planInvoiceCollection(input(5_000, 5_000_000));
    expect(p).toMatchObject({ applied_amount: 4_995_000, change_amount: 5_000, rounding_amount: 5_000 });
  });
});
