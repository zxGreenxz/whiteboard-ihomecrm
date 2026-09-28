import { z } from 'zod';
import { classifyDbError } from '@/lib/contracts/errors';
import type { DbErrorLike } from '@/lib/contracts/errors';

export function isCivilDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

const civilDate = z.string().refine(isCivilDate, 'Vui lòng nhập ngày hợp lệ');
export const moveOutNoticeFormSchema = z.object({
  expected_move_out_date: civilDate,
  reason: z.string().trim().max(2000, 'Lý do tối đa 2.000 ký tự'),
});
export type MoveOutNoticeFormData = z.infer<typeof moveOutNoticeFormSchema>;

const snapshotSchema = z.object({
  contract_id: z.string().min(1),
  organization_id: z.string().min(1),
  expected_move_out_date: civilDate.nullable(),
  updated_at: z.string().datetime({ offset: true }),
  today: civilDate,
  status: z.string().min(1),
});
export type MoveOutNoticeSnapshot = z.infer<typeof snapshotSchema>;

export const parseMoveOutNoticeSnapshot = (value: unknown): MoveOutNoticeSnapshot => snapshotSchema.parse(value);

export type MoveOutNoticeState = 'none' | 'upcoming' | 'due' | 'overdue';
export function getMoveOutNoticeState(date: string | null, today: string): MoveOutNoticeState {
  if (!date) return 'none';
  civilDate.parse(date);
  civilDate.parse(today);
  return date < today ? 'overdue' : date === today ? 'due' : 'upcoming';
}

export interface MoveOutNoticeInput {
  organizationId: string;
  contractId: string;
  expectedUpdatedAt: string;
  expectedMoveOutDate: string | null;
  reason?: string;
}

export function buildMoveOutNoticeArgs(input: MoveOutNoticeInput) {
  const reason = input.reason?.trim() || null;
  if (!input.organizationId || !input.contractId || !input.expectedUpdatedAt) {
    throw new Error('Thiếu tổ chức hoặc phiên bản hợp đồng. Vui lòng tải lại.');
  }
  if (input.expectedMoveOutDate !== null) civilDate.parse(input.expectedMoveOutDate);
  if (input.expectedMoveOutDate === null && !reason) throw new Error('Vui lòng nhập lý do hủy báo trả phòng');
  if (reason && reason.length > 2000) throw new Error('Lý do tối đa 2.000 ký tự');
  return {
    p_organization_id: input.organizationId,
    p_contract_id: input.contractId,
    p_expected_updated_at: input.expectedUpdatedAt,
    p_expected_move_out_date: input.expectedMoveOutDate,
    p_reason: reason,
  };
}

export type MoveOutNoticeRpcArgs = ReturnType<typeof buildMoveOutNoticeArgs>;
export type MoveOutNoticeRpcInvoker = (
  name: 'set_contract_move_out_notice_v1', args: MoveOutNoticeRpcArgs,
) => PromiseLike<{ data: unknown; error: DbErrorLike | null }>;

export async function invokeMoveOutNotice(rpc: MoveOutNoticeRpcInvoker, args: MoveOutNoticeRpcArgs) {
  const result = await rpc('set_contract_move_out_notice_v1', args);
  if (result.error) throw result.error;
  const snapshot = parseMoveOutNoticeSnapshot(result.data);
  if (snapshot.contract_id !== args.p_contract_id || snapshot.organization_id !== args.p_organization_id ||
      snapshot.expected_move_out_date !== args.p_expected_move_out_date) {
    throw new Error('Kết quả báo trả phòng không khớp yêu cầu');
  }
  return snapshot;
}

export function moveOutNoticeErrorMessage(error: unknown): string {
  switch (classifyDbError(error)) {
    case 'permission': return 'Bạn không có quyền báo trả phòng cho hợp đồng này hoặc phiên đăng nhập đã hết hạn.';
    case 'conflict': return 'Hợp đồng đã thay đổi. Vui lòng tải lại trước khi sửa báo trả phòng.';
    case 'validation': return 'Ngày hoặc lý do báo trả phòng không hợp lệ. Vui lòng kiểm tra lại.';
    case 'concurrency': return 'Hợp đồng đang được cập nhật. Vui lòng thử lại sau.';
    case 'not_found': return 'Không tìm thấy hợp đồng đang ở. Vui lòng tải lại.';
    default: return 'Chưa lưu được báo trả phòng. Vui lòng thử lại hoặc liên hệ hỗ trợ.';
  }
}
