import { z } from 'zod';
import type { Database, Json } from '@/integrations/supabase/types';
import { rpcNullable } from './rpcNullable';
import { supportPlanInputSchema, type SupportPlanInput } from './rentSupport';
const uuid = z.string().uuid();
const money = z.string().regex(/^\d+(?:\.\d+)?$/);
const month = z.string().regex(/^(?!0000)\d{4}-(?:0[1-9]|1[0-2])$/);
const schedule = z.object({ version: z.literal(2), start_billing_month: month,
  segments: z.array(z.object({ month_count: z.number().int().positive(), monthly_amount: money }).strict()).min(1),
}).strict();
const source = z.object({ source_id: uuid, kind: z.enum(['COMMISSION', 'BONUS']), gross_original: money,
  already_paid: money, prior_withheld: money, remaining_payable: money, available_to_withhold: money,
  current_withheld: money, net_this_operation: money, route: z.enum(['CASHBOOK', 'MANAGER_PAYROLL']),
}).strict();
export const supportQuoteSchema = z.object({ quote_hash: z.string().min(1), payload_hash: z.string().min(1),
  plan_revision: z.number().int().nonnegative(), payload: supportPlanInputSchema,
  committed_total: money, due_upfront: money, sources: z.array(source), unallocated: money,
  state: z.enum(['READY', 'NEEDS_REVIEW', 'LEGACY_REVIEW']), issues: z.array(z.object({ code: z.string(), message: z.string() }).strict()),
  months: z.array(z.object({ billing_month: month, agreed_amount: money, invoice_period_label: z.string(),
    eligibility: z.enum(['PLANNED', 'ELIGIBLE', 'UNMAPPED', 'REVENUE_CAP_REVIEW']),
  }).strict()),
}).strict();
export type SupportQuote = z.infer<typeof supportQuoteSchema>;
export const supportReadSchema = z.object({ total: z.number().int().nonnegative(), rows: z.array(z.object({
  contract_id: uuid, kind: z.enum(['LEGACY', 'V2']), revision: z.number().int().positive().nullable(), customer_hash: z.string().nullable(),
  schedule: schedule.nullable(), legacy: z.unknown(), months: z.array(z.object({ billing_month: month, agreed_amount: money }).strict()),
  financial: z.object({ payload: supportPlanInputSchema, committed_total: money, reason: z.string().nullable(),
    review: z.object({ revision: z.number().int().positive(), reason: z.string().nullable(), payload: supportPlanInputSchema }).strict().nullable(),
  }).strict().nullable().optional(),
}).strict()) }).strict();
export type SupportRead = z.infer<typeof supportReadSchema>;
export const supportRevisionSchema = z.object({ id: uuid, revision: z.number().int().positive(), active_revision: z.number().int().positive(),
  state: z.enum(['ACTIVE', 'NEEDS_REVIEW']), customer_hash: z.string(),
}).strict();
export type SupportRevision = z.infer<typeof supportRevisionSchema>;
export interface SupportReadFilter { contractIds?: string[]; buildingIds?: string[]; offset?: number; limit?: number; enabled?: boolean }
export interface SupportQuoteInput { contractId?: string; draftId?: string; payload: SupportPlanInput }
export interface SupportReviseInput { contractId: string; expectedRevision: number; payload: SupportPlanInput; reason: string; requestId: string }
export function supportPlanJson(input: SupportPlanInput): Json {
  const p = supportPlanInputSchema.parse(input);
  return { ...p, segments: p.segments.map(s => ({ ...s })) };
}
export function buildSupportQuoteArgs(organizationId: string, input: SupportQuoteInput): Database['public']['Functions']['quote_contract_rent_support_v1']['Args'] {
  uuid.parse(organizationId);
  if (!!input.contractId === !!input.draftId) throw new Error('Chọn đúng một hợp đồng hoặc bản nháp.');
  if (input.contractId) uuid.parse(input.contractId);
  if (input.draftId) uuid.parse(input.draftId);
  return { p_organization_id: organizationId, p_contract_id: rpcNullable(input.contractId ?? null), p_draft_id: rpcNullable(input.draftId ?? null),
    p_payload: supportPlanJson(input.payload), p_invoice_context: null, p_payout_context: null };
}
export async function quoteContractRentSupport(organizationId: string, input: SupportQuoteInput): Promise<SupportQuote> {
  const { supabase } = await import('@/integrations/supabase/client');
  const { data, error } = await supabase.rpc('quote_contract_rent_support_v1', buildSupportQuoteArgs(organizationId, input));
  if (error) throw error;
  return supportQuoteSchema.parse(data);
}
export async function readContractRentSupport(organizationId: string, filter: SupportReadFilter = {}): Promise<SupportRead> {
  uuid.parse(organizationId);z.array(uuid).optional().parse(filter.contractIds);z.array(uuid).optional().parse(filter.buildingIds);
  const offset = z.number().int().nonnegative().parse(filter.offset ?? 0);
  const limit = z.number().int().min(1).max(200).parse(filter.limit ?? 50);
  const { supabase } = await import('@/integrations/supabase/client');
  const { data, error } = await supabase.rpc('read_contract_rent_support_v1', { p_organization_id: organizationId,
    p_contract_ids: rpcNullable(filter.contractIds ?? null), p_building_ids: rpcNullable(filter.buildingIds ?? null), p_offset: offset, p_limit: limit });
  if (error) throw error;
  return supportReadSchema.parse(data);
}
export async function reviseContractRentSupport(organizationId: string, input: SupportReviseInput): Promise<SupportRevision> {
  uuid.parse(organizationId);uuid.parse(input.contractId);uuid.parse(input.requestId);
  z.number().int().positive().parse(input.expectedRevision);
  const reason = z.string().trim().min(1).max(2000).parse(input.reason);
  const { supabase } = await import('@/integrations/supabase/client');
  const { data, error } = await supabase.rpc('revise_contract_rent_support_v1', { p_organization_id: organizationId,
    p_contract_id: input.contractId, p_expected_revision: input.expectedRevision, p_payload: supportPlanJson(input.payload),
    p_reason: reason, p_request_id: input.requestId });
  if (error) throw error;
  return supportRevisionSchema.parse(data);
}
