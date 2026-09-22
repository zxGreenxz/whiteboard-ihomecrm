// Nhãn hiển thị của khu "Hợp đồng & quyết toán". Tách riêng để bảng và modal
// dùng CHUNG một bộ chữ — hai chỗ gọi cùng một trạng thái mà ra hai chữ khác
// nhau là lỗi người dùng nhìn thấy ngay.

import type { BasisState, SettlementIssue, SettlementStatus } from '@/lib/contractSettlement';
import { KIND_LABEL } from '@/lib/contractSettlement';
import { fmtFull } from '@/lib/collect';

type Mau = 'red' | 'amber' | 'green' | 'violet' | 'grey';

export const NHAN_TRANG_THAI: Record<SettlementStatus, { nhan: string; mau: Mau }> = {
  pending: { nhan: 'Chờ duyệt', mau: 'amber' },
  approved: { nhan: 'Đã duyệt · chờ chi', mau: 'green' },
  // ⚠ KHÔNG phải "chờ chi". Phiếu này ĐÃ ghi sổ rồi bị đảo bút toán; gọi nó là
  // chờ chi là mời người ta chi lần hai cho cùng một khoản.
  reversed: { nhan: 'Đã ghi sổ rồi hoàn tác', mau: 'violet' },
  // ⚠ KHÔNG gộp vào "Đã chi". Đo thật 21/09: 3 phiếu tổng 9.515.634đ nằm trên
  // sổ ảo "CỌC (giữ hộ khách)", không có dòng posting nào. Gọi chúng là đã chi
  // là nói dối rằng khách đã nhận tiền.
  noncash: { nhan: 'Đã duyệt · không ghi quỹ (sổ ảo)', mau: 'violet' },
  paid: { nhan: 'Đã chi', mau: 'green' },
  cancelled: { nhan: 'Đã huỷ', mau: 'grey' },
  unknown: { nhan: 'Trạng thái không xác định', mau: 'grey' },
};

export const NHAN_VUONG_MAC = {
  // Một nguồn chữ duy nhất cho tên loại — trước đây chép tay lần hai ở đây, và
  // chép tay là cách chắc chắn để bảng và modal lệch nhau khi thêm loại mới.
  loai: KIND_LABEL,

  vuong: {
    MISSING_PAYMENT_INFO: { nhan: 'Thiếu thông tin thanh toán', mau: 'red' as Mau },
    AMOUNT_MISMATCH: { nhan: 'Lệch căn cứ', mau: 'red' as Mau },
    BASIS_UNAVAILABLE: { nhan: 'Không đọc được căn cứ', mau: 'red' as Mau },
    SUPPLEMENT_PENDING: { nhan: 'Có yêu cầu bổ sung', mau: 'violet' as Mau },
    BASIS_NOT_FOUND: { nhan: 'Chưa có căn cứ', mau: 'grey' as Mau },
    BASIS_NOT_APPLICABLE: { nhan: 'Không có công thức căn cứ', mau: 'grey' as Mau },
    // Cảnh báo, KHÔNG chặn duyệt (isBlocker trả false) — xem chú thích của
    // 'CLASSIFICATION_REVIEW' trong contractSettlement.ts.
    CLASSIFICATION_REVIEW: { nhan: 'Cần đối chiếu phân loại', mau: 'amber' as Mau },
    OLD_PERIOD: { nhan: 'Tồn kỳ trước', mau: 'amber' as Mau },
  } as Record<SettlementIssue, { nhan: string; mau: Mau }>,
};

/** Câu mô tả tình trạng căn cứ — nói rõ "chưa tra" khác "tra mà hỏng". */
export function moTaCanCu(b: BasisState): string {
  switch (b.kind) {
    case 'matched': return fmtFull(b.amount);
    case 'mismatch': return fmtFull(b.amount);
    case 'unavailable': return `Không đọc được — ${b.reason}`;
    case 'not-found': return b.reason;
    case 'not-applicable': return 'Loại này không có công thức đối chiếu';
  }
}
