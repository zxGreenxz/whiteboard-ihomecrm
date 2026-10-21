// Câu 25 (chủ chốt 21/10/2026): người lập không có quyền duyệt KHÔNG tự duyệt phiếu chi từ
// ngưỡng tự duyệt trở lên. Luật nằm ở máy chủ — app_private.ie_self_approve_over_threshold_
// blocked_v1, mọi writer duyệt tự chặn (42501 + HINT ie_self_approve_over_threshold). Web chỉ
// HỎI cổng public.ie_self_approve_gate_v1 ở hộp "Xác nhận duyệt phiếu" — một chỗ cho mọi nơi
// bấm Duyệt (dòng danh sách, hộp chi tiết, hộp đợt; máy tính và điện thoại) — để khoá nút, giải
// thích, và hỏi lại NGAY TRƯỚC khi lưu đổi sổ quỹ/ảnh hay duyệt. Không tự so ngưỡng/quyền ở trình
// duyệt (luật 17/10: công thức tiền + quyền đặt trong database).
import { useQuery, type QueryClient } from '@tanstack/react-query';
import { z } from 'zod';

import { supabase } from '@/integrations/supabase/client';
import { formatVND } from '@/lib/utils';

type LoiRpc = { code?: string; message: string; details?: string | null; hint?: string | null };

/**
 * Ranh giới kiểu TẠM cho RPC chưa có trong `types.ts` sinh tự động — migration
 * 20261021231237_chan_tu_duyet_phieu_chi_vuot_nguong_v1 chưa lên production nên generator chưa
 * thấy hàm. Cùng khuôn `goiRpcQuyetToan` (useLandlordSettlement) / `goiRpcCopilot`: ép
 * `supabase.rpc` chứ không ép `supabase`, tên RPC vẫn viết thẳng tại nơi gọi.
 * Khi migration đã áp production và `npm run gen:types` chạy lại: đổi chỗ gọi về lời gọi
 * `supabase.rpc` có kiểu với tên ie_self_approve_gate_v1 viết thẳng, XOÁ hàm bọc này và chạy
 * `node scripts/check-raw-rpc-callers.mjs --write` (thêm lời gọi literal đó vào baseline).
 */
const goiRpcCongTuDuyet = (
  tenHam: 'ie_self_approve_gate_v1',
  args: { p_voucher_id: string },
): PromiseLike<{ data: unknown; error: LoiRpc | null }> =>
  (supabase.rpc as unknown as (
    name: string,
    params: Record<string, unknown>,
  ) => PromiseLike<{ data: unknown; error: LoiRpc | null }>)(tenHam, args);

const gateSchema = z.object({
  voucherId: z.string(),
  selfApproveBlocked: z.boolean(),
  reason: z.string().nullable(),
  threshold: z.number().nullable(),
});

export type SelfApproveGate = z.infer<typeof gateSchema>;

export const selfApproveGateKey = (voucherId: string | null | undefined) =>
  ['ie-self-approve-gate', voucherId] as const;

/** Đọc cổng cho đúng một phiếu; câu trả lời phải nói về đúng phiếu đã hỏi. */
export async function readSelfApproveGate(voucherId: string): Promise<SelfApproveGate> {
  const { data, error } = await goiRpcCongTuDuyet('ie_self_approve_gate_v1', { p_voucher_id: voucherId });
  if (error) throw error;
  const gate = gateSchema.parse(data);
  if (gate.voucherId !== voucherId) {
    throw new TypeError('Chưa xác nhận được quyền duyệt của đúng phiếu đang xem.');
  }
  return gate;
}

/** Câu giải thích khi nút duyệt bị khoá; ngưỡng lấy từ máy chủ, chỉ định dạng ở đây. */
export function selfApproveBlockedMessage(threshold: number | null): string {
  const muc = threshold === null ? 'từ ngưỡng tự duyệt' : `từ ${formatVND(threshold)}`;
  return `Phiếu chi ${muc} trở lên cần người có quyền duyệt thu chi duyệt. Bạn là người lập phiếu nên không tự duyệt được.`;
}

export interface SelfApproveGateState {
  /** true khi máy chủ xác nhận người đang xem là người lập không được tự duyệt phiếu này. */
  blocked: boolean;
  message: string | null;
}

const KHONG_CHAN: SelfApproveGateState = Object.freeze({ blocked: false, message: null });

const tuCong = (gate: SelfApproveGate): SelfApproveGateState =>
  gate.selfApproveBlocked ? { blocked: true, message: selfApproveBlockedMessage(gate.threshold) } : KHONG_CHAN;

/** Máy chủ chưa có hàm cổng (migration chưa áp): bản web mới vẫn chạy như cũ, writer tự chặn. */
const congChuaCo = (error: unknown) => {
  const code = String((error as { code?: unknown } | null)?.code ?? '');
  return code === 'PGRST202' || code === '42883';
};

/**
 * Hiển thị trong hộp xác nhận: đang tải hoặc đọc lỗi ⇒ KHÔNG khoá (bước kiểm ngay trước khi lưu
 * mới là chốt). `silent`: lỗi đọc báo nhật ký chứ không bật thông báo cho người dùng.
 */
export function useSelfApproveGate(voucherId: string | null | undefined, enabled: boolean): SelfApproveGateState {
  const query = useQuery({
    queryKey: selfApproveGateKey(voucherId),
    enabled: enabled && !!voucherId,
    queryFn: () => readSelfApproveGate(voucherId as string),
    meta: { silent: true },
  });
  const gate = enabled ? query.data : undefined;
  return gate ? tuCong(gate) : KHONG_CHAN;
}

/**
 * `ok: false` ⇒ KHÔNG lưu gì. `reason`:
 *   `blocked`    — máy chủ chặn; câu giải thích đã vào cache cổng nên hộp xác nhận tự hiện ghi chú;
 *   `unverified` — chưa đọc được cổng; người gọi phải tự hiện `message`.
 * (Không dùng union phân biệt theo `ok`: trang Thu chi chưa bật strictNullChecks nên không thu hẹp được.)
 */
export interface SelfApproveCheck {
  ok: boolean;
  reason: 'blocked' | 'unverified' | null;
  message: string | null;
}

const DUOC_DUYET: SelfApproveCheck = Object.freeze({ ok: true, reason: null, message: null });

export const SELF_APPROVE_CHECK_FAILED =
  'Chưa kiểm được quyền tự duyệt của phiếu này nên chưa lưu thay đổi nào. Bấm duyệt lại sau giây lát.';

/**
 * Hỏi lại máy chủ NGAY TRƯỚC khi lưu đổi sổ quỹ/ảnh hay gọi writer duyệt (không dùng bản đã
 * nhớ). `ok: false` ⇒ người gọi KHÔNG được lưu gì, chỉ hiện `message`:
 *   - bị chặn ⇒ câu giải thích câu 25;
 *   - đọc cổng lỗi ⇒ chưa biết thì chưa lưu, người dùng bấm lại.
 * Hàm cổng chưa có trên máy chủ (migration chưa áp) ⇒ `ok: true`: writer vẫn tự chặn.
 */
export async function checkSelfApproveBeforeApprove(
  queryClient: QueryClient,
  voucherId: string,
): Promise<SelfApproveCheck> {
  try {
    const gate = await queryClient.fetchQuery({
      queryKey: selfApproveGateKey(voucherId),
      queryFn: () => readSelfApproveGate(voucherId),
      staleTime: 0,
      retry: false,
    });
    const state = tuCong(gate);
    return state.blocked ? { ok: false, reason: 'blocked', message: state.message } : DUOC_DUYET;
  } catch (error) {
    if (congChuaCo(error)) return DUOC_DUYET;
    return { ok: false, reason: 'unverified', message: SELF_APPROVE_CHECK_FAILED };
  }
}
