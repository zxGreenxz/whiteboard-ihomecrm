// Câu 25 (chủ chốt 21/10/2026): người lập không có quyền duyệt KHÔNG tự duyệt phiếu chi từ
// ngưỡng tự duyệt trở lên. Luật nằm ở máy chủ — app_private.ie_self_approve_over_threshold_
// blocked_v1, mọi writer duyệt tự chặn (42501 + HINT ie_self_approve_over_threshold). Web chỉ
// HỎI cổng public.ie_self_approve_gate_v1 để khoá nút Duyệt và giải thích trước khi bấm; không
// tự so ngưỡng/quyền ở trình duyệt (luật 17/10: công thức tiền + quyền đặt trong database).
import { useQuery } from '@tanstack/react-query';
import { z } from 'zod';

import { supabase } from '@/integrations/supabase/client';
import { formatVND } from '@/lib/utils';

const gateSchema = z.object({
  voucherId: z.string(),
  selfApproveBlocked: z.boolean(),
  reason: z.string().nullable(),
  threshold: z.number().nullable(),
});

export type SelfApproveGate = z.infer<typeof gateSchema>;

/** Đọc cổng cho đúng một phiếu; câu trả lời phải nói về đúng phiếu đã hỏi. */
export async function readSelfApproveGate(voucherId: string): Promise<SelfApproveGate> {
  const { data, error } = await supabase.rpc('ie_self_approve_gate_v1', { p_voucher_id: voucherId });
  if (error) throw error;
  const gate = gateSchema.parse(data);
  if (gate.voucherId !== voucherId) {
    throw new TypeError('Chưa xác nhận được quyền duyệt của đúng phiếu đang xem.');
  }
  return gate;
}

/** Câu giải thích cạnh nút Duyệt bị khoá; ngưỡng lấy từ máy chủ, chỉ định dạng ở đây. */
export function selfApproveBlockedMessage(threshold: number | null): string {
  const muc = threshold === null ? 'từ ngưỡng tự duyệt' : `từ ${formatVND(threshold)}`;
  return `Phiếu chi ${muc} trở lên cần người có quyền duyệt thu chi duyệt. Bạn là người lập phiếu nên không tự duyệt được.`;
}

export interface SelfApproveGateState {
  /** true khi máy chủ xác nhận người đang xem là người lập không được tự duyệt phiếu này. */
  blocked: boolean;
  message: string | null;
}

/**
 * Hỏi cổng khi phiếu đang chờ duyệt và nút Duyệt sắp hiện. Đang tải hoặc đọc lỗi ⇒ KHÔNG khoá
 * nút: writer duyệt vẫn tự chặn và web báo đúng lý do (friendlyError nhận HINT). `silent`: cổng
 * chỉ để giải thích sớm, lỗi đọc báo nhật ký chứ không bật thông báo cho người dùng. Không đặt
 * staleTime: mỗi lần mở lại hỏi lại (phiếu vừa sửa số tiền / quyền vừa đổi thì câu trả lời đổi).
 */
export function useSelfApproveGate(voucherId: string | null | undefined, enabled: boolean): SelfApproveGateState {
  const query = useQuery({
    queryKey: ['ie-self-approve-gate', voucherId],
    enabled: enabled && !!voucherId,
    queryFn: () => readSelfApproveGate(voucherId as string),
    meta: { silent: true },
  });
  const gate = enabled ? query.data : undefined;
  if (!gate?.selfApproveBlocked) return { blocked: false, message: null };
  return { blocked: true, message: selfApproveBlockedMessage(gate.threshold) };
}
