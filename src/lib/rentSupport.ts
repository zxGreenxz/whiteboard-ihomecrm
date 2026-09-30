import { z } from 'zod';

export type BillingMonth = string;
export type Money = string;

// Preview only. These amounts never authorize an invoice claim or a payout;
// the canonical server quote must validate source identity, locks and revision.
type Decimal = { units: bigint; scale: number };
const ZERO: Decimal = { units: 0n, scale: 0 };

function normalizeMoney(value: string): Money {
  const [integer, fraction = ''] = value.split('.');
  const whole = integer!.replace(/^0+(?=\d)/, ''); // A validated decimal always has its integer part.
  const decimals = fraction.replace(/0+$/, '');
  return decimals ? `${whole}.${decimals}` : whole;
}

function decimal(value: Money): Decimal {
  const [integer, fraction = ''] = value.split('.');
  return { units: BigInt(integer + fraction), scale: fraction.length };
}

function aligned(a: Decimal, b: Decimal): [bigint, bigint, number] {
  const scale = Math.max(a.scale, b.scale);
  return [a.units * 10n ** BigInt(scale - a.scale), b.units * 10n ** BigInt(scale - b.scale), scale];
}

function add(a: Decimal, b: Decimal): Decimal {
  const [left, right, scale] = aligned(a, b);
  return { units: left + right, scale };
}

function subtract(a: Decimal, b: Decimal): Decimal {
  const [left, right, scale] = aligned(a, b);
  return { units: left - right, scale };
}

function compare(a: Decimal, b: Decimal): number {
  const [left, right] = aligned(a, b);
  return left < right ? -1 : left > right ? 1 : 0;
}

function serialize(value: Decimal): Money {
  if (value.units < 0n) throw new RangeError('Số tiền không được âm.');
  const digits = value.units.toString().padStart(value.scale + 1, '0');
  return normalizeMoney(value.scale ? `${digits.slice(0, -value.scale)}.${digits.slice(-value.scale)}` : digits);
}

const moneySchema = z.string().regex(/^\d+(?:\.\d+)?$/, 'Số tiền phải là chuỗi thập phân hữu hạn không âm.').transform(normalizeMoney);
const monthSchema = z.string().regex(/^(?!0000)\d{4}-(?:0[1-9]|1[0-2])$/, 'Tháng phải theo YYYY-MM, từ 0001-01 đến 9999-12.');
const uuidSchema = z.string().uuid().transform((value) => value.toLowerCase());
const payerSchema = z.enum(['BUILDING', 'SALE']);
const policySchema = z.enum(['COMMISSION_ONLY', 'BONUS_THEN_COMMISSION']);

function monthIndex(month: BillingMonth): number {
  return Number(month.slice(0, 4)) * 12 + Number(month.slice(5, 7)) - 1;
}

function monthAt(index: number): BillingMonth {
  return `${String(Math.floor(index / 12)).padStart(4, '0')}-${String(index % 12 + 1).padStart(2, '0')}`;
}

function monthLabel(month: BillingMonth): string {
  return `${month.slice(5, 7)}/${month.slice(0, 4)}`;
}

export const supportPlanInputSchema = z.object({
  version: z.literal(2),
  start_billing_month: monthSchema,
  payer: payerSchema,
  sale_party_id: uuidSchema.nullable(),
  deduction_policy: policySchema,
  collection_mode: z.literal('UPFRONT_COMMITTED'),
  segments: z.array(z.object({
    month_count: z.number().finite().int().min(1).max(119988),
    monthly_amount: moneySchema,
  }).strict()).min(1),
}).strict().superRefine((plan, ctx) => {
  if (plan.payer === 'SALE' && !plan.sale_party_id) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['sale_party_id'], message: 'Phải chọn danh tính Sale chịu hỗ trợ.' });
  }
  const count = plan.segments.reduce((total, segment) => total + segment.month_count, 0);
  if (monthIndex(plan.start_billing_month) + count - 1 > monthIndex('9999-12')) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['segments'], message: 'Lịch hỗ trợ vượt năm 9999.' });
  }
});

/** Public customer agreement. Funding identity is loaded only through a financial read. */
export const supportCustomerScheduleSchema = supportPlanInputSchema.innerType().pick({
  version: true, start_billing_month: true, segments: true,
}).strict().superRefine((schedule, ctx) => {
  const count = schedule.segments.reduce((total, segment) => total + segment.month_count, 0);
  if (monthIndex(schedule.start_billing_month) + count - 1 > monthIndex('9999-12')) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['segments'], message: 'Lịch hỗ trợ vượt năm 9999.' });
  }
});
export type SupportCustomerSchedule = z.infer<typeof supportCustomerScheduleSchema>;
export type SupportPlanInput = z.infer<typeof supportPlanInputSchema>;
export type SupportMonth = {
  billing_month: BillingMonth;
  agreed_amount: Money;
  invoice_period_label: string;
  eligibility: 'PLANNED' | 'ELIGIBLE' | 'UNMAPPED' | 'REVENUE_CAP_REVIEW';
};
export type SupportInvoicePeriod = {
  billing_month: BillingMonth;
  invoice_period_label: string;
  /** Revenue remaining for support after other discounts/credits; no deposit or prior debt. */
  eligible_revenue: Money;
};
export type SupportBillingContext = {
  contract_start_date?: string;
  contract_end_date?: string;
  /** Only canonical periods, never inferred from payment_cycle or invoice count. */
  invoice_periods?: readonly SupportInvoicePeriod[];
};

const dateSchema = z.string().regex(/^(?!0000)\d{4}-(?:0[1-9]|1[0-2])-\d{2}$/).refine((value) => {
  const year = Number(value.slice(0, 4));
  const month = Number(value.slice(5, 7));
  const day = Number(value.slice(8, 10));
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return day >= 1 && day <= days[month - 1]!; // The schema constrains month to 01..12.
}, 'Ngày hợp đồng phải là ngày hợp lệ theo YYYY-MM-DD.');

const billingContextSchema = z.object({
  contract_start_date: dateSchema.optional(),
  contract_end_date: dateSchema.optional(),
  invoice_periods: z.array(z.object({
    billing_month: monthSchema,
    invoice_period_label: z.string().min(1),
    eligible_revenue: moneySchema,
  }).strict()).optional(),
}).strict().superRefine((context, ctx) => {
  if (context.contract_start_date && context.contract_end_date && context.contract_end_date < context.contract_start_date) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['contract_end_date'], message: 'Ngày kết thúc phải sau hoặc bằng ngày bắt đầu hợp đồng.' });
  }
  const seen = new Set<string>();
  context.invoice_periods?.forEach((period, index) => {
    if (seen.has(period.billing_month)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['invoice_periods', index], message: 'Mỗi tháng chỉ được có một ngữ cảnh kỳ hóa đơn.' });
    seen.add(period.billing_month);
  });
});

export function buildSupportMonths(input: unknown, billingContext: SupportBillingContext = {}): SupportMonth[] {
  const plan = supportPlanInputSchema.parse(input);
  return buildCustomerSupportMonths({ version: plan.version, start_billing_month: plan.start_billing_month, segments: plan.segments }, billingContext);
}

/** Customer-only preview; shares month arithmetic without inventing funding identity. */
export function buildCustomerSupportMonths(input: unknown, billingContext: SupportBillingContext = {}): SupportMonth[] {
  const plan = supportCustomerScheduleSchema.parse(input);
  const context = billingContextSchema.parse(billingContext);
  const periods = new Map(context.invoice_periods?.map((period) => [period.billing_month, period]));
  const latestPeriod = context.invoice_periods?.reduce((latest, period) => period.billing_month > latest ? period.billing_month : latest, '');
  const result: SupportMonth[] = [];
  let index = monthIndex(plan.start_billing_month);
  for (const segment of plan.segments) {
    for (let offset = 0; offset < segment.month_count; offset++, index++) {
      const month = monthAt(index);
      if ((context.contract_start_date && month < context.contract_start_date.slice(0, 7)) ||
          (context.contract_end_date && month > context.contract_end_date.slice(0, 7))) {
        throw new RangeError(`OUTSIDE_CONTRACT_TERM: Tháng ${monthLabel(month)} nằm ngoài thời hạn hợp đồng.`);
      }
      const period = periods.get(month);
      const eligibility: SupportMonth['eligibility'] = period
        ? compare(decimal(segment.monthly_amount), decimal(period.eligible_revenue)) > 0 ? 'REVENUE_CAP_REVIEW' : 'ELIGIBLE'
        : latestPeriod !== undefined && (!latestPeriod || month <= latestPeriod) ? 'UNMAPPED' : 'PLANNED';
      result.push({ billing_month: month, agreed_amount: segment.monthly_amount, invoice_period_label: period?.invoice_period_label ?? monthLabel(month), eligibility });
    }
  }
  return result;
}

export function sumSupportCommitment(input: unknown): Money {
  const plan = supportPlanInputSchema.parse(input);
  return sumCustomerSupportCommitment({ version: plan.version, start_billing_month: plan.start_billing_month, segments: plan.segments });
}

export function sumCustomerSupportCommitment(input: unknown): Money {
  const plan = supportCustomerScheduleSchema.parse(input);
  return serialize(plan.segments.reduce((total, segment) => {
    const amount = decimal(segment.monthly_amount);
    return add(total, { units: amount.units * BigInt(segment.month_count), scale: amount.scale });
  }, ZERO));
}

const payoutSourceSchema = z.object({
  source_id: uuidSchema,
  sale_party_id: uuidSchema,
  kind: z.enum(['COMMISSION', 'BONUS']),
  gross_original: moneySchema,
  already_paid: moneySchema,
  prior_withheld: moneySchema,
  available_to_withhold: moneySchema,
  route: z.enum(['CASHBOOK', 'MANAGER_PAYROLL']),
  legacy_unreconciled: z.boolean().optional(),
}).strict().superRefine((source, ctx) => {
  const remaining = subtract(subtract(decimal(source.gross_original), decimal(source.already_paid)), decimal(source.prior_withheld));
  if (compare(remaining, ZERO) < 0) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['gross_original'], message: 'Đã trả và đã giữ không được vượt quyền lợi gốc.' });
  } else if (compare(decimal(source.available_to_withhold), remaining) > 0) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['available_to_withhold'], message: 'Sức chứa khấu trừ không được vượt phần còn được chi.' });
  }
});
const previousFundingSchema = z.object({
  payer: payerSchema,
  sale_party_id: uuidSchema.nullable(),
  deduction_policy: policySchema,
  committed_total: moneySchema,
  net_committed_withholding: moneySchema,
}).strict().superRefine((funding, ctx) => {
  if (funding.payer === 'SALE' && !funding.sale_party_id) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['sale_party_id'], message: 'Funding cũ thiếu danh tính Sale.' });
});
const fundingContextSchema = z.object({
  sources: z.array(payoutSourceSchema),
  previous_funding: previousFundingSchema.optional(),
}).strict().superRefine((context, ctx) => {
  const seen = new Set<string>();
  context.sources.forEach((source, index) => {
    if (seen.has(source.source_id)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['sources', index], message: 'Nguồn quyền lợi bị lặp; không được khấu trừ hai lần.' });
    seen.add(source.source_id);
  });
});

export type SupportPayoutSourceInput = z.infer<typeof payoutSourceSchema>;
export type SupportFundingContext = {
  sources: readonly SupportPayoutSourceInput[];
  /** Server-confirmed net funding for the same org/contract across valid revisions. */
  previous_funding?: z.infer<typeof previousFundingSchema>;
};
export type SourceQuote = Omit<SupportPayoutSourceInput, 'sale_party_id' | 'legacy_unreconciled'> & {
  remaining_payable: Money;
  current_withheld: Money;
  net_this_operation: Money;
};
export type SupportFundingPreview = {
  committed_total: Money;
  due_upfront: Money;
  sources: SourceQuote[];
  unallocated: Money;
  state: 'READY' | 'NEEDS_REVIEW' | 'LEGACY_REVIEW';
  issues: Array<{ code: string; message: string }>;
};

export function allocateSupportQuote(input: unknown, fundingContext: SupportFundingContext): SupportFundingPreview {
  const plan = supportPlanInputSchema.parse(input);
  const context = fundingContextSchema.parse(fundingContext);
  const committed = decimal(sumSupportCommitment(plan));
  const sources: SourceQuote[] = context.sources.map((source) => {
    const remaining = serialize(subtract(subtract(decimal(source.gross_original), decimal(source.already_paid)), decimal(source.prior_withheld)));
    return {
      source_id: source.source_id, kind: source.kind, route: source.route,
      gross_original: source.gross_original, already_paid: source.already_paid,
      prior_withheld: source.prior_withheld, available_to_withhold: source.available_to_withhold,
      remaining_payable: remaining, current_withheld: '0', net_this_operation: remaining,
    };
  });
  const issues: SupportFundingPreview['issues'] = [];
  const previous = context.previous_funding;
  const priorCommitted = previous ? decimal(previous.net_committed_withholding) : ZERO;
  const sameIdentity = previous?.payer === plan.payer && previous.sale_party_id === plan.sale_party_id;
  const hasPriorFunding = compare(priorCommitted, ZERO) > 0;
  let required = plan.payer === 'BUILDING' ? ZERO : subtract(committed, sameIdentity ? priorCommitted : ZERO);
  if (hasPriorFunding) {
    if (!sameIdentity || previous?.deduction_policy !== plan.deduction_policy) {
      issues.push({ code: 'FUNDING_IDENTITY_REVIEW', message: 'Đổi người chịu, người hưởng hoặc cách trừ sau funding cần đối chiếu.' });
    }
    if (previous && compare(committed, decimal(previous.committed_total)) < 0) {
      issues.push({ code: 'FUNDING_REDUCTION_REVIEW', message: 'Giảm cam kết đã funding cần điều chỉnh có đối chiếu.' });
    }
    if (compare(required, ZERO) < 0) issues.push({ code: 'FUNDING_OVERWITHHELD_REVIEW', message: 'Khoản đã giữ vượt cam kết mới; không tự hoàn hoặc thu âm.' });
  }
  if (compare(required, ZERO) < 0) required = ZERO;
  const quote: SupportFundingPreview = { committed_total: serialize(committed), due_upfront: serialize(required), sources, unallocated: serialize(required), state: 'READY', issues };
  if (issues.length) return { ...quote, state: 'NEEDS_REVIEW' };
  if (plan.payer === 'BUILDING') return quote;

  // An unavailable source cannot produce a net voucher. Paid sources with
  // zero remaining are safe; locked/reserved remaining amounts require review.
  context.sources.forEach((source, index) => {
    if (source.sale_party_id !== plan.sale_party_id && (source.kind === 'COMMISSION' || plan.deduction_policy === 'BONUS_THEN_COMMISSION')) {
      issues.push({ code: 'PAYEE_MISMATCH', message: 'Nguồn khấu trừ thuộc người hưởng khác Sale chịu hỗ trợ.' });
    }
    if (source.legacy_unreconciled) issues.push({ code: 'LEGACY_REVIEW', message: 'Nguồn legacy cần chứng từ đối chiếu gross, đã giữ và net.' });
    if (compare(decimal(source.available_to_withhold), decimal(sources[index]!.remaining_payable)) < 0) { // sources maps this same context array one-to-one.
      issues.push({ code: 'SOURCE_UNAVAILABLE', message: 'Nguồn còn bị khóa hoặc giữ chỗ; cần xử lý trước khi lập phiếu ròng.' });
    }
  });
  if (issues.length) return { ...quote, state: issues.some((issue) => issue.code === 'LEGACY_REVIEW') ? 'LEGACY_REVIEW' : 'NEEDS_REVIEW' };

  const ordered = sources.map((source) => ({ source }))
    .filter(({ source }) => source.kind === 'COMMISSION' || plan.deduction_policy === 'BONUS_THEN_COMMISSION')
    .sort((a, b) => {
      if (a.source.kind !== b.source.kind) return a.source.kind === 'BONUS' ? -1 : 1;
      return a.source.source_id.localeCompare(b.source.source_id);
    });
  let unallocated = required;
  for (const { source } of ordered) {
    const available = decimal(source.available_to_withhold);
    const withheld = compare(unallocated, available) < 0 ? unallocated : available;
    source.current_withheld = serialize(withheld);
    source.net_this_operation = serialize(subtract(decimal(source.remaining_payable), withheld));
    unallocated = subtract(unallocated, withheld);
  }
  quote.unallocated = serialize(unallocated);
  if (compare(unallocated, ZERO) > 0) {
    quote.state = 'NEEDS_REVIEW';
    issues.push({ code: 'INSUFFICIENT_SOURCE', message: `Thiếu ${quote.unallocated} từ nguồn được chọn; cần xử lý trước khi hoàn tất phân bổ.` });
  }
  return quote;
}
