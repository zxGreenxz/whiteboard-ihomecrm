// Nhãn hiển thị dùng CHUNG giữa bảng và modal của khu "Hợp đồng & quyết toán".
//
// ⚠ PHẠM VI THẬT của file này: tên VƯỚNG MẮC và câu mô tả CĂN CỨ. Nhãn TRẠNG
// THÁI **không** nằm ở đây — cả bảng lẫn modal đều lấy `STATUS_STYLE` của
// `@/lib/contractSettlement`. Từng có một bảng `NHAN_TRANG_THAI` ở đây nhưng
// KHÔNG ai gọi, và nó đã trôi lệch khỏi `STATUS_STYLE` lúc nào không biết
// (noncash / cancelled / reversed mỗi bên một chữ). Giữ lại là đặt bẫy: người
// sau sửa chữ ở đây rồi tưởng màn hình đã đổi. Đã xoá 22/09/2026, cùng với
// `NHAN_VUONG_MAC.loai` (cũng không consumer nào).
//
// "Dùng chung" KHÔNG có nghĩa là một câu cho mọi chỗ. Hai NGỮ CẢNH khác nhau
// thì được có hai câu khác nhau (xem `moTaCanCuTrongModal`); thứ phải tránh là
// hai chữ khác nhau cho CÙNG MỘT trạng thái.

import type { BasisState, SettlementIssue } from '@/lib/contractSettlement';
import { CAN_CU_HOAN_TRA_KHI_MO_PHIEU } from '@/lib/contractSettlement';
import { fmtFull } from '@/lib/collect';

type Mau = 'red' | 'amber' | 'green' | 'violet' | 'grey';

export const NHAN_VUONG_MAC = {
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

/**
 * Câu căn cứ dành cho HỘP THOẠI ĐÃ MỞ. Lớp CHỮ, không đụng vào `basisOf` hay
 * `AMOUNT_MISMATCH`.
 *
 * `basisOf` trả `CAN_CU_HOAN_TRA_KHI_MO_PHIEU` cho MỌI phiếu hoàn
 * (`useContractSettlement.ts`) vì RPC quyết toán đắt, chỉ gọi khi mở phiếu. Ở
 * DANH SÁCH đó là câu đúng. Trong hộp thoại thì nó SAI: việc tra đã làm xong
 * rồi, số thật in ngay dưới ở "Bảng quyết toán · căn cứ". Đem nguyên câu hứa ấy
 * vào khối "Số trên phiếu so với căn cứ" là nói với người sắp duyệt ba triệu
 * rằng chưa ai tra căn cứ — hai TRẠNG THÁI khác nhau mà chung một câu.
 *
 * So bằng HẰNG SỐ (`===`), y hệt `SettlementVoucherDetails.tsx`: mọi lý do
 * `not-found` khác vẫn hiện nguyên văn, đổi chữ ở `basisOf` không bị nuốt.
 */
export function moTaCanCuTrongModal(b: BasisState): string {
  return b.kind === 'not-found' && b.reason === CAN_CU_HOAN_TRA_KHI_MO_PHIEU
    ? 'Xem “Bảng quyết toán · căn cứ” bên dưới'
    : moTaCanCu(b);
}
