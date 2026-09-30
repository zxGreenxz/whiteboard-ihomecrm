import { z } from 'zod';
import { buildCustomerSupportMonths, type SupportCustomerSchedule } from './rentSupport';
import type { Json } from '@/integrations/supabase/types';
import { readContractRentSupport } from './rentSupportApi';
import { rpcNullable } from './rpcNullable';

export const invoiceRentSupportContextSchema = z.object({
  version: z.literal(1),
  expected_plan_revision: z.number().int().positive().safe(),
  manual_discount_amount: z.string().regex(/^\d+(?:\.\d{1,2})?$/),
  request_id: z.string().uuid(),
}).strict();
export type InvoiceRentSupportContext = z.infer<typeof invoiceRentSupportContextSchema>;
export async function readInvoiceRentSupportPlan(organizationId: string, contractId: string) {
  const result = await readContractRentSupport(organizationId, { contractIds: [contractId], limit: 1 });
  const row = result.rows.find(value => value.contract_id === contractId);
  if (!row) throw new Error('Không đọc được lịch hỗ trợ của hợp đồng.');
  if (row.kind === 'LEGACY') return null;
  if (!row.schedule || !row.revision) throw new Error('Lịch hỗ trợ thiếu phiên bản.');
  return { schedule: row.schedule, revision: row.revision };
}
const invoiceQuoteSchema = z.object({ invoice_support: z.string().regex(/^\d+(?:\.\d+)?$/), agreed_amount: z.string().regex(/^\d+(?:\.\d+)?$/),
  plan_revision: z.number().int().positive(), billing_month: z.string(), quote_hash: z.string().min(1),
  state: z.enum(['READY', 'NEEDS_REVIEW']), issue: z.string().optional(),
}).strict();
export async function quoteInvoiceRentSupport(organizationId: string, contractId: string, billingMonth: string, items: Json[], credit: number, context: InvoiceRentSupportContext) {
  const parsed = invoiceRentSupportContextSchema.parse(context);
  if (!Number.isFinite(credit) || credit < 0) throw new Error('Credit không hợp lệ.');
  const { supabase } = await import('@/integrations/supabase/client');
  const { data, error } = await supabase.rpc('quote_contract_rent_support_v1', { p_organization_id: organizationId, p_contract_id: contractId,
    p_draft_id: rpcNullable(null), p_payload: null, p_payout_context: null,
    p_invoice_context: { version: 1, billing_month: billingMonth, kind: 'MONTHLY', items,
      manual_discount_amount: parsed.manual_discount_amount, credit_discount_amount: String(credit), expected_plan_revision: parsed.expected_plan_revision } });
  if (error) throw error;
  return invoiceQuoteSchema.parse(data);
}

export interface InvoiceSupportPreview {
  amount: number;
  agreed_amount: string;
  notes: string;
  state: 'READY' | 'NEEDS_REVIEW';
  issue?: 'REVENUE_CAP_REVIEW' | 'BILLING_MONTH_REQUIRED';
}

/** Preview only; canonical writers independently recompute and claim the month. */
export function previewInvoiceRentSupport(schedule: SupportCustomerSchedule, billingMonth: string, eligibleRevenue: number, kind = 'MONTHLY'): InvoiceSupportPreview {
  if (!billingMonth) return { amount: 0, agreed_amount: '0', notes: '', state: 'NEEDS_REVIEW', issue: 'BILLING_MONTH_REQUIRED' };
  if (kind !== 'MONTHLY') return { amount: 0, agreed_amount: '0', notes: '', state: 'READY' };
  if (!Number.isFinite(eligibleRevenue) || eligibleRevenue < 0) throw new Error('Doanh thu đủ điều kiện không hợp lệ.');
  const month = buildCustomerSupportMonths(schedule, { invoice_periods: [{ billing_month: billingMonth, invoice_period_label: billingMonth, eligible_revenue: String(eligibleRevenue) }] })
    .find(value => value.billing_month === billingMonth);
  if (!month) return { amount: 0, agreed_amount: '0', notes: '', state: 'READY' };
  if (month.eligibility === 'REVENUE_CAP_REVIEW') return { amount: 0, agreed_amount: month.agreed_amount, notes: 'Hỗ trợ vượt doanh thu đủ điều kiện; cần đối chiếu.', state: 'NEEDS_REVIEW', issue: 'REVENUE_CAP_REVIEW' };
  return { amount: Number(month.agreed_amount), agreed_amount: month.agreed_amount, notes: `Hỗ trợ tiền thuê ${billingMonth.slice(5)}/${billingMonth.slice(0, 4)} — ${Number(month.agreed_amount).toLocaleString('vi-VN')}đ`, state: 'READY' };
}
