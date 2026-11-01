import { z } from 'zod';
import type { Json } from '@/integrations/supabase/types';
import { EXIT_KINDS } from '@/lib/contractExitCases';

// Nháp bước quyết toán của hồ sơ Chờ quyết toán (migration 20261030104546). Nháp chỉ giữ số người dùng TỰ ĐIỀN để
// mở lại form; công nợ, cọc đã thu và chỉ số đã chốt bằng ảnh luôn đọc lại lúc mở. Đổi ý nghĩa trường ⇒ tăng `schema`.
export const EXIT_SETTLEMENT_DRAFT_SCHEMA = 1;
const money = z.number().finite().nonnegative().max(1e12);
const isoDate = z.union([z.literal(''), z.string().regex(/^\d{4}-\d{2}-\d{2}$/)]);
const customRows = z.array(z.object({ name: z.string().max(200), amount: money }).strict()).max(30);
const uuid = z.string().uuid();

export const extraChargesDraftSchema = z.object({
  fromDate: isoDate, toDate: isoDate, proratedAmount: money, proratedTouched: z.boolean(), cleaningAmount: money, customRows,
  // Chỉ đồng hồ ghi tay mới có số gõ tay; startOverride vắng = dùng số đầu tự lấy, null = người dùng xoá ô.
  meter: z.object({ meterId: uuid, currentReading: z.number().finite().nullable(), startOverride: z.number().finite().nullable().optional() }).strict().nullable(),
}).strict();
export const refundItemsDraftSchema = z.object({
  fromDate: isoDate, toDate: isoDate, proratedAmount: money, proratedTouched: z.boolean(), customRows,
}).strict();
export const moveOutDraftSchema = z.object({
  depositRefund: money, excessRent: money, notes: z.string().max(8000),
  shortfallMode: z.enum(['PAID', 'DEBT']), receiptAccountId: z.union([z.literal(''), uuid]),
}).strict();
export const exitSettlementDraftPayloadSchema = z.object({
  schema: z.literal(EXIT_SETTLEMENT_DRAFT_SCHEMA), kind: z.enum(EXIT_KINDS), changeReason: z.string().max(4000),
  extra: extraChargesDraftSchema.nullable(), refund: refundItemsDraftSchema.nullable(), moveOut: moveOutDraftSchema.nullable(),
}).strict();
export type ExtraChargesDraft = z.infer<typeof extraChargesDraftSchema>;
export type RefundItemsDraft = z.infer<typeof refundItemsDraftSchema>;
export type MoveOutDraft = z.infer<typeof moveOutDraftSchema>;
export type ExitSettlementDraftPayload = z.infer<typeof exitSettlementDraftPayloadSchema>;
export type ExitSettlementDraftSections = Pick<ExitSettlementDraftPayload, 'extra' | 'refund' | 'moveOut'>;

const responseSchema = z.object({
  case_id: uuid, case_version: z.number().int().positive(), version: z.number().int().positive(), payload: z.unknown(),
  created_at: z.string(), created_by: uuid, updated_at: z.string(), updated_by: uuid, updated_by_name: z.string().nullable(),
});
const listSchema = z.array(z.object({
  case_id: uuid, version: z.number().int().positive(), updated_at: z.string(), updated_by: uuid, updated_by_name: z.string().nullable(),
}));
export interface ExitSettlementDraftMeta { caseId: string; version: number; updatedAt: string; updatedByName: string | null }
export interface ExitSettlementDraft extends ExitSettlementDraftMeta {
  /** null khi nội dung không đọc được (khuôn nháp cũ/khác) — vẫn giữ version để ghi đè hoặc bỏ. */
  payload: ExitSettlementDraftPayload | null;
}

export type ExitSettlementDraftRpcName = 'get_contract_exit_settlement_draft_v1' | 'list_contract_exit_settlement_drafts_v1'
  | 'save_contract_exit_settlement_draft_v1' | 'discard_contract_exit_settlement_draft_v1';
export interface ExitSettlementDraftRpcError { code?: string; message?: string }
export type ExitSettlementDraftRpcInvoker = (name: ExitSettlementDraftRpcName, args: Record<string, Json>) =>
  PromiseLike<{ data: unknown; error: ExitSettlementDraftRpcError | null }>;
export interface SaveExitSettlementDraftInput { caseId: string; expectedVersion: number | null; payload: ExitSettlementDraftPayload }
export interface DiscardExitSettlementDraftInput { caseId: string; expectedVersion: number }

async function call(invoke: ExitSettlementDraftRpcInvoker, name: ExitSettlementDraftRpcName, args: Record<string, Json>) {
  const result = await invoke(name, args);
  if (result.error) throw result.error;
  return result.data;
}
function parseDraft(value: unknown): ExitSettlementDraft | null {
  if (value === null) return null;
  const row = responseSchema.parse(value);
  const payload = exitSettlementDraftPayloadSchema.safeParse(row.payload);
  return { caseId: row.case_id, version: row.version, updatedAt: row.updated_at, updatedByName: row.updated_by_name,
    payload: payload.success ? payload.data : null };
}
export async function getExitSettlementDraft(invoke: ExitSettlementDraftRpcInvoker, caseId: string, organizationId: string) {
  return parseDraft(await call(invoke, 'get_contract_exit_settlement_draft_v1', { p_organization_id: uuid.parse(organizationId), p_case_id: uuid.parse(caseId) }));
}
export async function listExitSettlementDrafts(invoke: ExitSettlementDraftRpcInvoker, caseIds: string[], organizationId: string): Promise<ExitSettlementDraftMeta[]> {
  const ids = z.array(uuid).max(100).parse(caseIds);
  const rows = listSchema.parse(await call(invoke, 'list_contract_exit_settlement_drafts_v1', { p_organization_id: uuid.parse(organizationId), p_case_ids: ids }));
  return rows.map(row => ({ caseId: row.case_id, version: row.version, updatedAt: row.updated_at, updatedByName: row.updated_by_name }));
}
/** Máy chủ nhận payload ≤ 32 KB tính theo jsonb::text (thêm dấu cách sau `:` và `,`) — chừa biên. */
export const EXIT_SETTLEMENT_DRAFT_MAX_BYTES = 30_000;
export class ExitSettlementDraftTooLargeError extends Error {
  constructor(readonly bytes: number) { super('Settlement draft is too large'); }
}
export function exitSettlementDraftBytes(payload: ExitSettlementDraftPayload): number {
  return new TextEncoder().encode(JSON.stringify(payload)).length;
}
export async function saveExitSettlementDraft(invoke: ExitSettlementDraftRpcInvoker, input: SaveExitSettlementDraftInput, organizationId: string) {
  const payload = exitSettlementDraftPayloadSchema.parse(input.payload);
  const bytes = exitSettlementDraftBytes(payload);
  if (bytes > EXIT_SETTLEMENT_DRAFT_MAX_BYTES) throw new ExitSettlementDraftTooLargeError(bytes);
  const draft = parseDraft(await call(invoke, 'save_contract_exit_settlement_draft_v1', { p_organization_id: uuid.parse(organizationId),
    p_case_id: uuid.parse(input.caseId), p_expected_version: input.expectedVersion === null ? null : z.number().int().positive().parse(input.expectedVersion),
    p_payload: payload as Json }));
  if (!draft) throw new Error('Máy chủ không trả bản nháp vừa lưu');
  return draft;
}
export async function discardExitSettlementDraft(invoke: ExitSettlementDraftRpcInvoker, input: DiscardExitSettlementDraftInput, organizationId: string) {
  await call(invoke, 'discard_contract_exit_settlement_draft_v1', { p_organization_id: uuid.parse(organizationId),
    p_case_id: uuid.parse(input.caseId), p_expected_version: z.number().int().positive().parse(input.expectedVersion) });
}
export function exitSettlementDraftErrorMessage(error: unknown): string {
  if (error instanceof ExitSettlementDraftTooLargeError) return 'Nháp quá dài để lưu: rút gọn ghi chú, lý do đổi loại hoặc tên các khoản rồi lưu lại.';
  const code = (error as ExitSettlementDraftRpcError | null)?.code;
  if (code === 'PT409') return 'Bản nháp vừa được người khác lưu hoặc hồ sơ đã quyết toán. Tải lại để xem bản mới nhất.';
  if (code === '42501') return 'Bạn không có quyền quyết toán hồ sơ ở tòa nhà này.';
  if (code === '22023' || error instanceof z.ZodError) return 'Nội dung nháp không hợp lệ hoặc quá dài.';
  return (error as ExitSettlementDraftRpcError | null)?.message || 'Không lưu được bản nháp quyết toán.';
}
/** "10:45 30/10 bởi Tên" — ai lưu nháp, lúc nào. */
export function draftSavedBy(draft: Pick<ExitSettlementDraftMeta, 'updatedAt' | 'updatedByName'>): string {
  return `${formatDraftTime(draft.updatedAt)}${draft.updatedByName ? ` bởi ${draft.updatedByName}` : ''}`;
}
/** "10:45 30/10" theo giờ máy người dùng. */
export function formatDraftTime(iso: string): string {
  const date = new Date(iso);
  if (!Number.isFinite(date.getTime())) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(date.getHours())}:${pad(date.getMinutes())} ${pad(date.getDate())}/${pad(date.getMonth() + 1)}`;
}
