// =============================================
// Bàn giao tiền mặt — pure helpers (không fetch, không side-effect).
// Dùng chung giữa HandoverSheet (khung mobile) và ManagePanel (desktop).
// Trạng thái phiên: PENDING → CONFIRMED | CANCELLED; yêu cầu hủy là
// overlay flag (cancel_requested_by) chứ không phải status riêng.
// =============================================

export type HandoverStatus = 'PENDING' | 'CONFIRMED' | 'CANCELLED';

export interface HandoverItemLite {
  voucher_id: string;
  amount: number;
  voucher_code?: string | null;
  voucher_date?: string | null;
  room_name?: string | null;
  building_name?: string | null;
}

export interface HandoverLite {
  id: string;
  code?: string | null;
  giver_id: string;
  receiver_id: string;
  giver_name?: string | null;
  receiver_name?: string | null;
  total_amount: number;
  voucher_count: number;
  status: HandoverStatus;
  cancel_requested_by?: string | null;
  cancel_reason?: string | null;
  created_at?: string | null;
  confirmed_at?: string | null;
  cancelled_at?: string | null;
}

/** Tổng tiền các phiếu đang được tick chọn. */
export const sumSelected = <T extends { id: string; total_amount?: number | null }>(
  vouchers: T[],
  selectedIds: ReadonlySet<string> | string[],
): number => {
  const set = selectedIds instanceof Set ? selectedIds : new Set(selectedIds);
  return vouchers.reduce(
    (s, v) => (set.has(v.id) ? s + (Number(v.total_amount) || 0) : s),
    0,
  );
};

export type HandoverRole = 'giver' | 'receiver' | 'none';

export const myRole = (h: Pick<HandoverLite, 'giver_id' | 'receiver_id'>, myId?: string | null): HandoverRole =>
  !myId ? 'none' : h.giver_id === myId ? 'giver' : h.receiver_id === myId ? 'receiver' : 'none';

/**
 * Nhãn trạng thái theo góc nhìn của `myId`:
 *  - PENDING:    "Chờ tôi nhận" (mình là receiver) / "Chờ nhận"
 *  - có yêu cầu hủy chưa chốt: "Chờ tôi xác nhận hủy" / "Đang chờ hủy"
 *  - CONFIRMED:  "Đã nhận" · CANCELLED: "Đã hủy"
 */
export const handoverStatusLabel = (h: HandoverLite, myId?: string | null): string => {
  if (h.status === 'CANCELLED') return 'Đã hủy';
  if (h.cancel_requested_by) {
    return myId && h.cancel_requested_by !== myId && myRole(h, myId) !== 'none'
      ? 'Chờ tôi xác nhận hủy'
      : 'Đang chờ hủy';
  }
  if (h.status === 'CONFIRMED') return 'Đã nhận';
  return myRole(h, myId) === 'receiver' ? 'Chờ tôi nhận' : 'Chờ nhận';
};

/** Phiên cần CHÍNH TÔI thao tác (badge): chờ tôi nhận, hoặc chờ tôi xác nhận hủy. */
export const needsMyAction = (h: HandoverLite, myId?: string | null): boolean => {
  if (!myId || h.status === 'CANCELLED' || myRole(h, myId) === 'none') return false;
  if (h.cancel_requested_by) return h.cancel_requested_by !== myId;
  return h.status === 'PENDING' && h.receiver_id === myId;
};

/** Phiên còn "sống" (hiện ở khu Phiên chờ thay vì Lịch sử). */
export const isOpenHandover = (h: HandoverLite): boolean =>
  h.status === 'PENDING' || (h.status === 'CONFIRMED' && !!h.cancel_requested_by);

/** Ngày + giờ ngắn gọn "dd/mm hh:mm" (giờ địa phương) — cho "giờ nhận bàn giao". */
export const fmtDateTime = (d?: string | null): string => {
  if (!d) return '';
  const dt = new Date(d);
  if (Number.isNaN(dt.getTime())) return '';
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(dt.getDate())}/${p(dt.getMonth() + 1)} ${p(dt.getHours())}:${p(dt.getMinutes())}`;
};
