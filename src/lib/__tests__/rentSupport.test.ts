import { describe, expect, it } from 'vitest';
import {
  allocateSupportQuote,
  buildSupportMonths,
  sumSupportCommitment,
  supportPlanInputSchema,
  type SupportPlanInput,
  type SupportPayoutSourceInput,
} from '../rentSupport';
import {
  buildFirstInvoiceBillingContext,
  calculateProratedRent,
} from '../firstInvoiceBuilder';

const sale = '11111111-1111-4111-8111-111111111111';
const otherSale = '22222222-2222-4222-8222-222222222222';
const commissionId = '33333333-3333-4333-8333-333333333333';
const bonusId = '44444444-4444-4444-8444-444444444444';
const plan: SupportPlanInput = {
  version: 2,
  start_billing_month: '2026-09',
  payer: 'SALE',
  sale_party_id: sale,
  deduction_policy: 'COMMISSION_ONLY',
  collection_mode: 'UPFRONT_COMMITTED',
  segments: [
    { month_count: 3, monthly_amount: '300000' },
    { month_count: 9, monthly_amount: '100000' },
  ],
};
const commission: SupportPayoutSourceInput = {
  source_id: commissionId,
  sale_party_id: sale,
  kind: 'COMMISSION',
  gross_original: '3000000',
  already_paid: '0',
  prior_withheld: '0',
  available_to_withhold: '3000000',
  route: 'CASHBOOK',
};
const bonus: SupportPayoutSourceInput = {
  source_id: bonusId,
  sale_party_id: sale,
  kind: 'BONUS',
  gross_original: '500000',
  already_paid: '0',
  prior_withheld: '0',
  available_to_withhold: '500000',
  route: 'CASHBOOK',
};

describe('rent support schedule', () => {
  it('keeps the literal 3 × 300000 then 9 × 100000 calendar schedule across the year', () => {
    expect(buildSupportMonths(plan)).toEqual([
      { billing_month: '2026-09', agreed_amount: '300000', invoice_period_label: '09/2026', eligibility: 'PLANNED' },
      { billing_month: '2026-10', agreed_amount: '300000', invoice_period_label: '10/2026', eligibility: 'PLANNED' },
      { billing_month: '2026-11', agreed_amount: '300000', invoice_period_label: '11/2026', eligibility: 'PLANNED' },
      { billing_month: '2026-12', agreed_amount: '100000', invoice_period_label: '12/2026', eligibility: 'PLANNED' },
      { billing_month: '2027-01', agreed_amount: '100000', invoice_period_label: '01/2027', eligibility: 'PLANNED' },
      { billing_month: '2027-02', agreed_amount: '100000', invoice_period_label: '02/2027', eligibility: 'PLANNED' },
      { billing_month: '2027-03', agreed_amount: '100000', invoice_period_label: '03/2027', eligibility: 'PLANNED' },
      { billing_month: '2027-04', agreed_amount: '100000', invoice_period_label: '04/2027', eligibility: 'PLANNED' },
      { billing_month: '2027-05', agreed_amount: '100000', invoice_period_label: '05/2027', eligibility: 'PLANNED' },
      { billing_month: '2027-06', agreed_amount: '100000', invoice_period_label: '06/2027', eligibility: 'PLANNED' },
      { billing_month: '2027-07', agreed_amount: '100000', invoice_period_label: '07/2027', eligibility: 'PLANNED' },
      { billing_month: '2027-08', agreed_amount: '100000', invoice_period_label: '08/2027', eligibility: 'PLANNED' },
    ]);
    expect(sumSupportCommitment(plan)).toBe('1800000');
  });

  it('normalizes decimal strings without rounding or a Number conversion', () => {
    const decimalPlan = { ...plan, segments: [
      { month_count: 3, monthly_amount: '0000.1000' },
      { month_count: 1, monthly_amount: '9007199254740993.123456789012345678' },
    ] };
    expect(supportPlanInputSchema.parse(decimalPlan).segments[0].monthly_amount).toBe('0.1');
    expect(sumSupportCommitment(decimalPlan)).toBe('9007199254740993.423456789012345678');
  });

  it.each([-1, 0, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER])('rejects invalid month count %s', (month_count) => {
    expect(supportPlanInputSchema.safeParse({ ...plan, segments: [{ month_count, monthly_amount: '1' }] }).success).toBe(false);
  });

  it.each(['2026-00', '2026-13', '2026-9', '0000-01', '10000-01', 'NaN-09'])('rejects invalid billing month %s', (start_billing_month) => {
    expect(supportPlanInputSchema.safeParse({ ...plan, start_billing_month }).success).toBe(false);
  });

  it.each(['NaN', 'Infinity', '-1', '1e3', '', ' 1 ', '1,000', '.5', '1.', 300000, NaN])('rejects invalid decimal money %s', (monthly_amount) => {
    expect(supportPlanInputSchema.safeParse({ ...plan, segments: [{ month_count: 1, monthly_amount }] }).success).toBe(false);
  });

  it('rejects an empty schedule and overflow past the supported calendar', () => {
    expect(supportPlanInputSchema.safeParse({ ...plan, segments: [] }).success).toBe(false);
    expect(supportPlanInputSchema.safeParse({ ...plan, start_billing_month: '9999-12', segments: [{ month_count: 2, monthly_amount: '1' }] }).success).toBe(false);
  });

  it('requires stable Sale identity and rejects old policy, version, unknown fields', () => {
    for (const patch of [{ sale_party_id: 'Sale A' }, { version: 1 }, { deduction_policy: 'BONUS_ONLY' }, { collection_mode: 'MONTHLY' }, { payment_cycle: 3 }]) {
      expect(supportPlanInputSchema.safeParse({ ...plan, ...patch }).success).toBe(false);
    }
    expect(supportPlanInputSchema.safeParse({ ...plan, payer: 'BUILDING', sale_party_id: null }).success).toBe(true);
  });

  it('rejects a support month outside either contract boundary without shifting the schedule', () => {
    expect(() => buildSupportMonths(plan, { contract_start_date: '2026-10-01' })).toThrow('OUTSIDE_CONTRACT_TERM');
    expect(() => buildSupportMonths(plan, { contract_end_date: '2027-07-31' })).toThrow('OUTSIDE_CONTRACT_TERM');
    expect(buildSupportMonths(plan, { contract_start_date: '2026-09-20', contract_end_date: '2027-08-19' })).toHaveLength(12);
  });

  it.each(['2026-02-30', '2026-13-01', '2026-09-31', '2026-9-01'])('rejects invalid contract date %s', (contract_end_date) => {
    expect(() => buildSupportMonths(plan, { contract_end_date })).toThrow();
  });

  it('rejects reversed contract bounds and invalid input at every public calculation boundary', () => {
    expect(() => buildSupportMonths(plan, { contract_start_date: '2027-08-01', contract_end_date: '2026-09-01' })).toThrow();
    const invalid = { ...plan, segments: [{ month_count: -1, monthly_amount: '1' }] };
    expect(() => buildSupportMonths(invalid)).toThrow();
    expect(() => sumSupportCommitment(invalid)).toThrow();
    expect(() => allocateSupportQuote(invalid, { sources: [] })).toThrow();
  });

  it.each([
    { from: '2026-09-20', to: '2026-10-05', month: '2026-09', rent: 1636667, label: '20/09/2026–05/10/2026 (09/2026)' },
    { from: '2026-09-28', to: '2026-10-31', month: '2026-10', rent: 3410000, label: '28/09/2026–31/10/2026 (10/2026)' },
  ])('maps $from–$to to $month with full 300000 support and unchanged prorated rent', ({ from, to, month, rent, label }) => {
    const period = buildFirstInvoiceBillingContext(from, to);
    expect(period).toEqual({ billing_month: month, invoice_period_label: label });
    expect(calculateProratedRent(3100000, from, to)).toBe(rent);
    const months = buildSupportMonths(plan, { invoice_periods: [{ ...period, eligible_revenue: '500000' }] });
    expect(months.find((entry) => entry.billing_month === month)).toEqual({
      billing_month: month,
      agreed_amount: '300000',
      invoice_period_label: label,
      eligibility: 'ELIGIBLE',
    });
    if (month === '2026-10') expect(months[0].eligibility).toBe('UNMAPPED');
    expect(months[2].eligibility).toBe('PLANNED');
    expect(sumSupportCommitment(plan)).toBe('1800000');
  });

  it('surfaces a revenue cap without losing the agreed commitment or counting deposit/debt', () => {
    const months = buildSupportMonths(plan, { invoice_periods: [{ billing_month: '2026-09', invoice_period_label: 'Kỳ đầu', eligible_revenue: '299999.99' }] });
    expect(months[0]).toEqual({ billing_month: '2026-09', agreed_amount: '300000', invoice_period_label: 'Kỳ đầu', eligibility: 'REVENUE_CAP_REVIEW' });
    expect(sumSupportCommitment(plan)).toBe('1800000');
  });

  it('maps only explicit canonical periods and rejects ambiguous or invalid period inputs', () => {
    const period = { billing_month: '2026-09', invoice_period_label: 'Kỳ đầu', eligible_revenue: '300000' };
    expect(buildSupportMonths(plan, { invoice_periods: [period] }).filter((month) => month.eligibility === 'ELIGIBLE')).toHaveLength(1);
    expect(() => buildSupportMonths(plan, { invoice_periods: [period, period] })).toThrow();
    expect(() => buildSupportMonths(plan, { invoice_periods: [{ ...period, eligible_revenue: 'NaN' }] })).toThrow();
    expect(() => buildSupportMonths(plan, { invoice_periods: [{ ...period, billing_month: '2026-13' }] })).toThrow();
  });
});

describe('rent support funding preview', () => {
  it('withholds the 1800000 commitment once from commission and preserves bonus', () => {
    const quote = allocateSupportQuote(plan, { sources: [commission, bonus] });
    expect(quote).toMatchObject({ committed_total: '1800000', due_upfront: '1800000', unallocated: '0', state: 'READY', issues: [] });
    expect(quote.sources[0]).toMatchObject({ current_withheld: '1800000', remaining_payable: '3000000', net_this_operation: '1200000' });
    expect(quote.sources[1]).toMatchObject({ current_withheld: '0', net_this_operation: '500000' });
  });

  it('commission only reports a literal 300000 shortfall despite sufficient bonus', () => {
    const quote = allocateSupportQuote(plan, { sources: [{ ...commission, gross_original: '1500000', available_to_withhold: '1500000' }, bonus] });
    expect(quote).toMatchObject({ state: 'NEEDS_REVIEW', unallocated: '300000' });
    expect(quote.sources[1].current_withheld).toBe('0');
    expect(quote.issues.map((issue) => issue.code)).toContain('INSUFFICIENT_SOURCE');
  });

  it('bonus then commission allocates 500000 bonus and 1300000 commission regardless of input order', () => {
    const quote = allocateSupportQuote({ ...plan, deduction_policy: 'BONUS_THEN_COMMISSION' }, { sources: [commission, bonus] });
    expect(quote).toMatchObject({ state: 'READY', unallocated: '0' });
    expect(quote.sources[0]).toMatchObject({ current_withheld: '1300000', net_this_operation: '1700000' });
    expect(quote.sources[1]).toMatchObject({ current_withheld: '500000', net_this_operation: '0' });
  });

  it('reports a 300000 total shortage and never synthesizes Sale debt', () => {
    const quote = allocateSupportQuote({ ...plan, deduction_policy: 'BONUS_THEN_COMMISSION' }, { sources: [{ ...commission, gross_original: '1000000', available_to_withhold: '1000000' }, bonus] });
    expect(quote).toMatchObject({ state: 'NEEDS_REVIEW', committed_total: '1800000', due_upfront: '1800000', unallocated: '300000' });
    expect(quote.sources.map((source) => source.current_withheld)).toEqual(['1000000', '500000']);
  });

  it('building payer leaves every Sale source intact and requires no Sale funding', () => {
    const quote = allocateSupportQuote({ ...plan, payer: 'BUILDING', sale_party_id: null }, { sources: [commission, bonus] });
    expect(quote).toMatchObject({ committed_total: '1800000', due_upfront: '0', state: 'READY', unallocated: '0', issues: [] });
    expect(quote.sources.map((source) => source.current_withheld)).toEqual(['0', '0']);
    expect(quote.sources.map((source) => source.net_this_operation)).toEqual(['3000000', '500000']);
  });

  it('excludes already-paid bonus and falls through to valid commission', () => {
    const quote = allocateSupportQuote({ ...plan, deduction_policy: 'BONUS_THEN_COMMISSION' }, { sources: [commission, { ...bonus, already_paid: '500000', available_to_withhold: '0' }] });
    expect(quote.state).toBe('READY');
    expect(quote.sources[0].current_withheld).toBe('1800000');
    expect(quote.sources[1]).toMatchObject({ remaining_payable: '0', current_withheld: '0', net_this_operation: '0' });
  });

  it('uses original gross minus 700000 paid and 300000 held before retaining another 500000', () => {
    const quote = allocateSupportQuote({ ...plan, segments: [{ month_count: 1, monthly_amount: '500000' }] }, { sources: [{ ...commission, already_paid: '700000', prior_withheld: '300000', available_to_withhold: '2000000', route: 'MANAGER_PAYROLL' }] });
    expect(quote.sources[0]).toEqual({ source_id: commissionId, kind: 'COMMISSION', gross_original: '3000000', already_paid: '700000', prior_withheld: '300000', remaining_payable: '2000000', available_to_withhold: '2000000', current_withheld: '500000', net_this_operation: '1500000', route: 'MANAGER_PAYROLL' });
  });

  it('preserves exact decimal differences above Number safe range', () => {
    const quote = allocateSupportQuote({ ...plan, segments: [{ month_count: 3, monthly_amount: '0.1' }] }, { sources: [{ ...commission, gross_original: '9007199254740993.4', already_paid: '9007199254740993', prior_withheld: '0.1', available_to_withhold: '0.3' }] });
    expect(quote).toMatchObject({ committed_total: '0.3', due_upfront: '0.3', state: 'READY' });
    expect(quote.sources[0]).toMatchObject({ remaining_payable: '0.3', current_withheld: '0.3', net_this_operation: '0' });
  });

  it('counts prior committed funding only once across compatible revisions', () => {
    const quote = allocateSupportQuote(plan, {
      sources: [{ ...commission, prior_withheld: '1300000', available_to_withhold: '1700000' }],
      previous_funding: { payer: 'SALE', sale_party_id: sale, deduction_policy: 'COMMISSION_ONLY', committed_total: '1800000', net_committed_withholding: '1300000' },
    });
    expect(quote).toMatchObject({ due_upfront: '500000', unallocated: '0', state: 'READY' });
    expect(quote.sources[0]).toMatchObject({ current_withheld: '500000', net_this_operation: '1200000' });
  });

  it('returns zero additional withholding when the same commitment was fully funded', () => {
    const quote = allocateSupportQuote(plan, {
      sources: [{ ...commission, prior_withheld: '1800000', available_to_withhold: '1200000' }],
      previous_funding: { payer: 'SALE', sale_party_id: sale, deduction_policy: 'COMMISSION_ONLY', committed_total: '1800000', net_committed_withholding: '1800000' },
    });
    expect(quote).toMatchObject({ due_upfront: '0', unallocated: '0', state: 'READY' });
    expect(quote.sources[0]).toMatchObject({ current_withheld: '0', net_this_operation: '1200000' });
  });

  it.each([
    { payer: 'BUILDING', sale_party_id: null },
    { sale_party_id: otherSale },
    { deduction_policy: 'BONUS_THEN_COMMISSION' },
    { segments: [{ month_count: 1, monthly_amount: '900000' }] },
  ] as const)('requires review after funded identity/policy or commitment changes: %s', (patch) => {
    const quote = allocateSupportQuote({ ...plan, ...patch, segments: patch.segments ? [...patch.segments] : plan.segments }, {
      sources: [commission, bonus],
      previous_funding: { payer: 'SALE', sale_party_id: sale, deduction_policy: 'COMMISSION_ONLY', committed_total: '1800000', net_committed_withholding: '1800000' },
    });
    expect(quote.state).toBe('NEEDS_REVIEW');
    expect(quote.sources.map((source) => source.current_withheld)).toEqual(['0', '0']);
    expect(quote.issues.length).toBeGreaterThan(0);
  });

  it('does not fund from another payee or infer unreconciled legacy gross', () => {
    const mismatch = allocateSupportQuote(plan, { sources: [{ ...commission, sale_party_id: otherSale }] });
    expect(mismatch).toMatchObject({ state: 'NEEDS_REVIEW', unallocated: '1800000' });
    expect(mismatch.sources[0].current_withheld).toBe('0');
    expect(mismatch.issues.map((issue) => issue.code)).toContain('PAYEE_MISMATCH');
    const legacy = allocateSupportQuote(plan, { sources: [{ ...commission, legacy_unreconciled: true }] });
    expect(legacy.state).toBe('LEGACY_REVIEW');
    expect(legacy.sources[0].current_withheld).toBe('0');
  });

  it('requires review for reserved/locked source amounts before net payout', () => {
    const quote = allocateSupportQuote(plan, { sources: [{ ...commission, available_to_withhold: '2000000' }] });
    expect(quote.state).toBe('NEEDS_REVIEW');
    expect(quote.sources[0].current_withheld).toBe('0');
    expect(quote.issues.map((issue) => issue.code)).toContain('SOURCE_UNAVAILABLE');
  });

  it('rejects overpaid, overheld, excessive capacity, invalid money and duplicate economic sources', () => {
    for (const patch of [{ already_paid: '3000001' }, { already_paid: '2800000', prior_withheld: '300000' }, { available_to_withhold: '3000001' }, { gross_original: 'NaN' }, { prior_withheld: '-1' }]) {
      expect(() => allocateSupportQuote(plan, { sources: [{ ...commission, ...patch }] })).toThrow();
    }
    expect(() => allocateSupportQuote(plan, { sources: [commission, commission] })).toThrow();
  });

  it('rejects the same economic UUID source even with different letter case', () => {
    expect(() => allocateSupportQuote(plan, { sources: [
      { ...commission, source_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' },
      { ...commission, source_id: 'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA' },
    ] })).toThrow();
  });

  it('does not mutate plan, source or period inputs', () => {
    const frozenPlan = Object.freeze({ ...plan, segments: Object.freeze(plan.segments.map((segment) => Object.freeze({ ...segment }))) });
    const frozenSources = Object.freeze([Object.freeze({ ...commission }), Object.freeze({ ...bonus })]);
    const snapshot = JSON.stringify({ frozenPlan, frozenSources });
    buildSupportMonths(frozenPlan);
    allocateSupportQuote(frozenPlan, { sources: frozenSources });
    expect(JSON.stringify({ frozenPlan, frozenSources })).toBe(snapshot);
  });
});


it('allows a contract-bound Sale schedule before voucher recipients are entered', () => {
  const unbound = { ...plan, sale_party_id: null };
  expect(supportPlanInputSchema.parse(unbound).sale_party_id).toBeNull();
  expect(sumSupportCommitment(unbound)).toBe('1800000');
  const quote = allocateSupportQuote({ ...unbound, deduction_policy: 'BONUS_THEN_COMMISSION' }, {
    sources: [commission, { ...bonus, sale_party_id: otherSale }],
  });
  expect(quote.state).toBe('READY');
  expect(quote.sources.find(x => x.kind === 'BONUS')?.current_withheld).toBe('500000');
  expect(quote.sources.find(x => x.kind === 'COMMISSION')?.current_withheld).toBe('1300000');
});
it('does not withhold a contract-bound commitment twice', () => {
  const unbound = { ...plan, sale_party_id: null };
  const quote = allocateSupportQuote(unbound, { sources: [], previous_funding: {
    payer: 'SALE', sale_party_id: null, deduction_policy: 'COMMISSION_ONLY',
    committed_total: '1800000', net_committed_withholding: '1800000',
  } });
  expect(quote.state).toBe('READY');
  expect(quote.due_upfront).toBe('0');
});
