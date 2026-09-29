import { z } from 'zod';
import { supabase } from '@/integrations/supabase/client';

const kindSchema = z.enum(['broker', 'sale']);
const eventSchema = z.object({
  action: z.enum(['ATTEMPTED', 'FAILED', 'NOT_APPLICABLE', 'REOPENED', 'COMPLETED']),
  reason: z.string().nullable(), amount: z.number().finite().nonnegative().nullable(),
  actor_name: z.string().nullable(), created_at: z.string(),
});
export const commissionFollowupSchema = z.object({
  contract_id: z.string().uuid(), contract_number: z.string().nullable(),
  building_id: z.string().uuid(), building_name: z.string(), room_name: z.string(), kind: kindSchema,
  state: z.enum(['PENDING', 'UNKNOWN', 'FAILED', 'NOT_APPLICABLE', 'VOUCHER_CREATED', 'PROCESSING']),
  last_reason: z.string().nullable(), last_at: z.string().nullable(), last_actor: z.string().nullable(),
  attempted_amount: z.number().finite().nonnegative().nullable(), can_manage: z.boolean(),
  voucher_id: z.string().uuid().nullable(), voucher_code: z.string().nullable(), voucher_status: z.string().nullable(),
  events: z.array(eventSchema),
  request_id: z.string().uuid().nullable().optional(), attempted_at: z.string().nullable().optional(), can_retry: z.boolean().optional(),
});
export const commissionFollowupCountsSchema = z.object({
  all: z.number().int().nonnegative(), broker: z.number().int().nonnegative(), sale: z.number().int().nonnegative(),
}).refine(counts => counts.all === counts.broker + counts.sale, 'Tổng số lượng theo loại không khớp.');
export type CommissionFollowupCounts = z.infer<typeof commissionFollowupCountsSchema>;
export const commissionFollowupPageSchema = z.object({
  rows: z.array(commissionFollowupSchema), total: z.number().int().nonnegative(), counts_by_kind: commissionFollowupCountsSchema,
});
export type ContractCommissionFollowup = z.infer<typeof commissionFollowupSchema>;
export type CommissionKind = z.infer<typeof kindSchema>;
export interface CommissionEventInput {
  contractId: string; kind: CommissionKind;
  action: 'ATTEMPTED' | 'FAILED' | 'NOT_APPLICABLE' | 'REOPENED';
  requestId: string; amount?: number; reason?: string;
}
export interface CommissionFollowupFilter {
  contractId?: string; buildingIds?: string[]; unresolvedOnly?: boolean; page?: number; enabled?: boolean;
  kind?: CommissionKind; search?: string; periodFrom?: string; periodTo?: string;
}
export const COMMISSION_FOLLOWUP_PAGE_SIZE = 20;

export async function readContractCommissionFollowups(organizationId: string, filter: CommissionFollowupFilter) {
  z.string().uuid().parse(organizationId);
  if (filter.contractId) z.string().uuid().parse(filter.contractId);
  if (filter.buildingIds) z.array(z.string().uuid()).parse(filter.buildingIds);
  const page = z.number().int().min(0).parse(filter.page ?? 0);
  const { data, error } = await supabase.rpc('list_contract_commission_followups_v2', {
    p_organization_id: organizationId, p_contract_ids: filter.contractId ? [filter.contractId] : undefined,
    p_building_ids: filter.buildingIds?.length ? filter.buildingIds : undefined,
    p_offset: page * COMMISSION_FOLLOWUP_PAGE_SIZE, p_limit: COMMISSION_FOLLOWUP_PAGE_SIZE,
    p_unresolved_only: filter.unresolvedOnly ?? !filter.contractId,
    p_kind: filter.kind, p_search: filter.search?.trim(), p_period_from: filter.periodFrom, p_period_to: filter.periodTo,
  });
  if (error) throw error;
  return commissionFollowupPageSchema.parse(data);
}
export async function recordContractCommissionEvent(organizationId: string, input: CommissionEventInput) {
  z.string().uuid().parse(organizationId); z.string().uuid().parse(input.contractId); z.string().uuid().parse(input.requestId);
  kindSchema.parse(input.kind); eventSchema.shape.action.parse(input.action);
  if (input.amount !== undefined) z.number().finite().nonnegative().parse(input.amount);
  if ((input.action === 'FAILED' || input.action === 'NOT_APPLICABLE') && !input.reason?.trim()) throw new Error('Vui lòng nhập lý do.');
  const { data, error } = await supabase.rpc('record_contract_commission_event_v1', {
    p_organization_id: organizationId, p_contract_id: input.contractId, p_kind: input.kind,
    p_action: input.action, p_request_id: input.requestId, p_amount: input.amount,
    p_reason: input.reason?.trim().slice(0, 2000),
  });
  if (error) throw error;
  const receipt = z.object({ id: z.string().uuid(), contract_id: z.literal(input.contractId),
    kind: z.literal(input.kind), action: z.literal(input.action), request_id: z.literal(input.requestId) }).parse(data);
  return receipt;
}

export async function runTrackedCommissionCreation<T>(input: { contractId: string; kind: CommissionKind; amount: number }, operations: {
  record: (event: CommissionEventInput) => Promise<unknown>; create: () => Promise<T>;
}): Promise<T> {
  const attempt = { ...input, requestId: crypto.randomUUID() };
  try {
    await operations.record({ ...attempt, action: 'ATTEMPTED' });
  } catch {
    throw new Error('Chưa ghi nhận được yêu cầu tạo phiếu. Kiểm tra kết nối rồi thử lại; chưa gửi tạo phiếu chi.');
  }
  try {
    return await operations.create();
  } catch (error) {
    const detail = error instanceof Error ? error.message : 'Không nhận được kết quả tạo phiếu.';
    try {
      await operations.record({ ...attempt, action: 'FAILED', reason: detail.slice(0, 1500) });
    } catch {
      throw new Error('Chưa xác nhận được kết quả tạo phiếu, chưa lưu được chi tiết lỗi. Yêu cầu đã được ghi nhận trên hợp đồng; kiểm tra phiếu hiện có trước khi tạo lại.');
    }
    throw new Error(`${detail} Yêu cầu còn được theo dõi trên hợp đồng và Hợp đồng & quyết toán; kiểm tra kết quả trước khi tạo lại.`);
  }
}

const creationPayloadSchema = z.object({
  contract_id: z.string().uuid(), kind: kindSchema, amount: z.number().finite().positive(),
  voucher_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), account_id: z.string().uuid().nullable().optional(),
  manager_id: z.string().uuid().nullable().optional(),
  payer_name: z.string().nullable().optional(), recipient_name: z.string().nullable().optional(),
  recipient_bank: z.string().nullable().optional(), recipient_account: z.string().nullable().optional(),
  item_description: z.string().nullable().optional(), attachments: z.array(z.string()).optional(),
}).strict();
const preparedRequestSchema = z.object({ contract_id: z.string().uuid(), kind: kindSchema, request_id: z.string().uuid() }).strict();
const creationResultSchema = z.object({ status: z.enum(['COMPLETED', 'ALREADY_EXISTS', 'FAILED']), id: z.string().uuid().nullable(), code: z.string().nullable() });
export type CommissionCreationPayload = z.infer<typeof creationPayloadSchema>;
export type PreparedCommissionRequest = z.infer<typeof preparedRequestSchema>;
export interface CommissionCreationResult { status: 'COMPLETED' | 'ALREADY_EXISTS' | 'FAILED'; id: string | null; code: string | null; }

/** Save ALL selected positive intents atomically, before executing the first kind. */
export async function prepareCommissionCreations(organizationId: string, inputs: CommissionCreationPayload[]): Promise<PreparedCommissionRequest[]> {
  z.string().uuid().parse(organizationId);
  const intents = z.array(creationPayloadSchema).min(1).max(100).parse(inputs).map(input => ({ ...input, request_id: crypto.randomUUID() }));
  const { data, error } = await supabase.rpc('prepare_commission_requests_v1', { p_organization_id: organizationId, p_intents: intents });
  if (error) throw error;
  const receipts = z.array(preparedRequestSchema).parse(data);
  if (receipts.length !== intents.length || new Set(receipts.map(r => r.request_id)).size !== receipts.length ||
      intents.some(i => !receipts.some(r => r.request_id === i.request_id && r.contract_id === i.contract_id && r.kind === i.kind))) {
    throw new Error('Chưa xác nhận đầy đủ yêu cầu tạo phiếu; chưa gửi tạo phiếu chi.');
  }
  return receipts;
}

/** Explicit execute/reconcile only. No automatic retry and no reconstructed payload. */
export async function executeCommissionCreation(organizationId: string, input: PreparedCommissionRequest): Promise<CommissionCreationResult> {
  z.string().uuid().parse(organizationId); const request = preparedRequestSchema.parse(input);
  const { data, error } = await supabase.rpc('execute_commission_request_v1', {
    p_organization_id: organizationId, p_contract_id: request.contract_id, p_kind: request.kind, p_request_id: request.request_id,
  });
  if (error) throw error;
  const result = creationResultSchema.parse(data);
  if (result.status === 'FAILED') throw new Error('Máy chủ chưa tạo được phiếu. Yêu cầu đã được lưu; xem chi tiết và bấm Tạo lại khi sẵn sàng.');
  return { status: result.status, id: result.id, code: result.code };
}
