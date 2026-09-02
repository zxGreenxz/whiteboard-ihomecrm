// =============================================================================
// Ô "Ghi chú" của phiếu thu/chi — chọn cách hiển thị theo loại phiếu:
//   • hoa hồng / thưởng Sale  → CommissionVoucherNote (facts HĐ lúc xem)
//   • trả khách thanh lý       → TerminationRefundNote (dòng + khung tổng hợp)
//   • còn lại                  → ghi chú DB, đã xuống dòng
// Dùng chung cho dialog desktop, sheet mobile, trang chi tiết, trang in.
// =============================================================================

import {
  CommissionVoucherNote,
  laPhieuHoaHong,
  type CommissionVoucherRef,
} from "@/components/income-expenses/CommissionVoucherNote";
import {
  TerminationRefundNote,
  laPhieuTraKhachThanhLy,
  type TerminationVoucherRef,
} from "@/components/income-expenses/TerminationRefundNote";

export type VoucherNoteRef = CommissionVoucherRef & TerminationVoucherRef;

/** Phiếu có ghi chú hệ thống tính lúc xem ⇒ luôn hiện Row Ghi chú. */
export const coGhiChuHeThong = (v: VoucherNoteRef): boolean =>
  laPhieuHoaHong(v) || laPhieuTraKhachThanhLy(v);

interface Props {
  voucher: VoucherNoteRef;
  fallbackNotes?: string | null;
  enabled?: boolean;
}

export function VoucherNote({ voucher, fallbackNotes, enabled = true }: Props) {
  if (laPhieuHoaHong(voucher)) {
    return <CommissionVoucherNote voucher={voucher} fallbackNotes={fallbackNotes} enabled={enabled} />;
  }
  if (laPhieuTraKhachThanhLy(voucher)) {
    return <TerminationRefundNote voucher={voucher} fallbackNotes={fallbackNotes} enabled={enabled} />;
  }
  const notes = fallbackNotes?.trim() || null;
  return notes ? <div className="whitespace-pre-line">{notes}</div> : null;
}

export default VoucherNote;
