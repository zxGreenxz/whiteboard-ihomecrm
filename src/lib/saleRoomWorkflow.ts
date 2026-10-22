import { z } from 'zod';
import type { Json } from '@/integrations/supabase/types';
import {
  buildSaleRoomPatchArgs, SaleRoomOperationError, saleRoomWriteError, saleRoomOperationErrorMessage,
  saleRoomPatchSchema, type SaleRoomPatchReceipt, type PatchSaleRoomInput,
} from '@/lib/saleRoomOperations';
import { saleRoomPolicyInputSchema, saleRoomPolicySchema, type SaleRoomPolicyInput } from '@/lib/saleRoomPolicyTypes';

const uuid = z.string().uuid();
const revision = z.string().regex(/^[a-f0-9]{32}$/);
const roomRequest = z.object({ roomId: uuid, expectedRevision: revision, requestId: uuid });
export const saveSalePolicyInputSchema = roomRequest.extend({ policy: saleRoomPolicyInputSchema }).strict();
export interface SaveSalePolicyInput { roomId: string; expectedRevision: string; requestId: string; policy: SaleRoomPolicyInput }
export const cancelSalePolicyInputSchema = z.object({
  roomId: uuid, policyId: uuid, expectedVersion: z.number().int().positive(), requestId: uuid,
  reason: z.string().trim().min(1).max(500),
}).strict();
export interface CancelSalePolicyInput { roomId: string; policyId: string; expectedVersion: number; requestId: string; reason: string }
export const salePolicyReceiptSchema = z.object({
  request_id: uuid, room_id: uuid, building_id: uuid, revision, policy: saleRoomPolicySchema,
});
export type SalePolicyReceipt = z.infer<typeof salePolicyReceiptSchema>;
export type SalePolicyRpcInvoker = (name: 'save_room_sale_policy_v1' | 'cancel_room_sale_policy_v1', args: Record<string, Json>) =>
  PromiseLike<{ data: unknown; error: { code?: string; message?: string } | null }>;

export async function saveSaleRoomPolicy(rpc: SalePolicyRpcInvoker, organizationId: string, input: SaveSalePolicyInput): Promise<SalePolicyReceipt> {
  const parsed = saveSalePolicyInputSchema.safeParse(input);
  if (!parsed.success || !uuid.safeParse(organizationId).success) throw new SaleRoomOperationError('Kiểm tra tên, nội dung và thời hạn chính sách.', 'rejected', '22023');
  const args = { p_organization_id: organizationId, p_room_id: input.roomId,
    p_expected_revision: input.expectedRevision, p_request_id: input.requestId, p_policy: parsed.data.policy };
  try {
    const result = await rpc('save_room_sale_policy_v1', args);
    if (result.error) throw result.error;
    const receipt = salePolicyReceiptSchema.safeParse(result.data);
    if (!receipt.success || receipt.data.room_id !== input.roomId || receipt.data.request_id !== input.requestId
      || receipt.data.policy.title !== parsed.data.policy.title || receipt.data.policy.content !== parsed.data.policy.content
      || Date.parse(receipt.data.policy.starts_at) !== Date.parse(input.policy.starts_at)
      || Date.parse(receipt.data.policy.ends_at) !== Date.parse(input.policy.ends_at)
      || receipt.data.policy.status === 'CANCELLED') {
      throw new SaleRoomOperationError('Phản hồi chưa xác nhận đúng chính sách. Đối chiếu lại yêu cầu cũ.', 'unknown');
    }
    return receipt.data;
  } catch (error) { throw saleRoomWriteError(error); }
}

export async function cancelSaleRoomPolicy(rpc: SalePolicyRpcInvoker, organizationId: string, input: CancelSalePolicyInput): Promise<SalePolicyReceipt> {
  const parsed = cancelSalePolicyInputSchema.safeParse(input);
  if (!parsed.success || !uuid.safeParse(organizationId).success) throw new SaleRoomOperationError('Nhập lý do ngừng chính sách.', 'rejected', '22023');
  try {
    const result = await rpc('cancel_room_sale_policy_v1', {
      p_organization_id: organizationId, p_policy_id: input.policyId, p_expected_version: input.expectedVersion,
      p_request_id: input.requestId, p_reason: parsed.data.reason,
    });
    if (result.error) throw result.error;
    const receipt = salePolicyReceiptSchema.safeParse(result.data);
    if (!receipt.success || receipt.data.room_id !== input.roomId || receipt.data.request_id !== input.requestId
      || receipt.data.policy.id !== input.policyId || receipt.data.policy.status !== 'CANCELLED'
      || receipt.data.policy.version !== input.expectedVersion + 1) {
      throw new SaleRoomOperationError('Chưa xác nhận được việc ngừng đúng chính sách. Đối chiếu yêu cầu cũ.', 'unknown');
    }
    return receipt.data;
  } catch (error) { throw saleRoomWriteError(error); }
}

export const saleBatchCommandSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('patch'), label: z.string(), input: roomRequest.extend({ patch: saleRoomPatchSchema }).strict() }).strict(),
  z.object({ kind: z.literal('policy'), label: z.string(), input: saveSalePolicyInputSchema }).strict(),
  z.object({ kind: z.literal('cancel'), label: z.string(), input: cancelSalePolicyInputSchema }).strict(),
]);
export type SaleBatchCommand =
  | { kind: 'patch'; label: string; input: PatchSaleRoomInput }
  | { kind: 'policy'; label: string; input: SaveSalePolicyInput }
  | { kind: 'cancel'; label: string; input: CancelSalePolicyInput };
export const saleBatchResultSchema = z.object({
  requestId: uuid, roomId: uuid,
  status: z.enum(['queued', 'saving', 'applied', 'conflict', 'rejected', 'unknown']),
  message: z.string(),
});
export type SaleBatchResult = z.infer<typeof saleBatchResultSchema>;
export const saleBatchDraftSchema = z.object({
  commands: z.array(saleBatchCommandSchema).min(1).max(50),
  results: z.array(saleBatchResultSchema),
}).strict();
export interface SaleBatchDraft { commands: SaleBatchCommand[]; results: SaleBatchResult[] }
type ExecuteSaleCommand = (command: SaleBatchCommand) => Promise<SaleRoomPatchReceipt | SalePolicyReceipt>;

export function validateSaleBatch(organizationId: string, draft: SaleBatchDraft): SaleBatchDraft {
  uuid.parse(organizationId);
  // The parent application still disables strictNullChecks, which makes Zod's
  // inferred object keys optional. Runtime validation above this boundary is exact.
  const parsed = saleBatchDraftSchema.parse(draft) as SaleBatchDraft;
  const rooms = new Set<string>(); const requests = new Set<string>();
  for (const command of parsed.commands) {
    if (rooms.has(command.input.roomId) || requests.has(command.input.requestId)) throw new Error('Danh sách có phòng hoặc mã yêu cầu bị trùng.');
    rooms.add(command.input.roomId); requests.add(command.input.requestId);
    if (command.kind === 'patch') buildSaleRoomPatchArgs(organizationId, command.input);
  }
  const resultIds = new Set<string>();
  for (const result of parsed.results) {
    const target = parsed.commands.find(command => command.input.requestId === result.requestId);
    if (!target || target.input.roomId !== result.roomId || resultIds.has(result.requestId)) throw new Error('Kết quả không thuộc đúng lô cập nhật.');
    resultIds.add(result.requestId);
  }
  return parsed;
}

/** One transaction per room. Unknown outcomes stop dispatch; retries reuse the exact durable request. */
export async function runSaleRoomBatch(
  organizationId: string, draft: SaleBatchDraft, execute: ExecuteSaleCommand,
  persist: (next: SaleBatchDraft) => void, isCurrent: () => boolean = () => true,
): Promise<SaleBatchDraft> {
  let current = validateSaleBatch(organizationId, draft);
  const record = (command: SaleBatchCommand, status: SaleBatchResult['status'], message: string) => {
    const next = { commands: current.commands, results: [
      ...current.results.filter(result => result.requestId !== command.input.requestId),
      { requestId: command.input.requestId, roomId: command.input.roomId, status, message },
    ] };
    // Persist before changing UI or making a request. Storage failure must prevent dispatch.
    persist(next); current = next;
  };
  for (const command of current.commands) {
    if (!isCurrent()) break;
    const previous = current.results.find(result => result.requestId === command.input.requestId);
    if (previous && ['applied', 'rejected', 'conflict'].includes(previous.status)) continue;
    record(command, 'saving', 'Đang lưu; cần đối chiếu nếu mất kết nối.');
    let failed = false; let failure: unknown;
    try { await execute(command); } catch (error) { failed = true; failure = error; }
    if (failed) {
      const error = saleRoomWriteError(failure);
      // A denied/conflicting replay cannot disprove an earlier lost commit.
      const outcome = previous && ['saving', 'unknown'].includes(previous.status) ? 'unknown' : error.outcome;
      record(command, outcome, outcome === 'unknown' && error.outcome !== 'unknown'
        ? 'Chưa đối chiếu được lần lưu trước. Giữ nguyên yêu cầu và kiểm tra lại quyền hoặc kết nối.' : saleRoomOperationErrorMessage(error));
      if (outcome === 'unknown') break;
    } else record(command, 'applied', command.kind === 'cancel' ? 'Đã ngừng chính sách.' : 'Đã lưu.');
  }
  return current;
}
