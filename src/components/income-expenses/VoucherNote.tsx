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
import { formatSupplementAuthor, type IncomeExpenseSupplement } from '@/lib/incomeExpenseSupplement';

export type VoucherNoteRef = CommissionVoucherRef & TerminationVoucherRef & { supplements?: IncomeExpenseSupplement[] };

/** Phiếu có ghi chú hệ thống tính lúc xem ⇒ luôn hiện Row Ghi chú. */
export const coGhiChuHeThong = (v: VoucherNoteRef): boolean =>
  laPhieuHoaHong(v) || laPhieuTraKhachThanhLy(v) || !!v.supplements?.length;

interface Props {
  voucher: VoucherNoteRef;
  fallbackNotes?: string | null;
  enabled?: boolean;
}

export function VoucherNote({ voucher, fallbackNotes, enabled = true }: Props) {
  const original = () => {
  if (laPhieuHoaHong(voucher)) {
    return <CommissionVoucherNote voucher={voucher} fallbackNotes={fallbackNotes} enabled={enabled} />;
  }
  if (laPhieuTraKhachThanhLy(voucher)) {
    return <TerminationRefundNote voucher={voucher} fallbackNotes={fallbackNotes} enabled={enabled} />;
  }
  const notes = fallbackNotes?.trim() || null;
  return notes ? <div className="whitespace-pre-line">{notes}</div> : null;
  };
  return <div className="space-y-2">{original()}<VoucherSupplementNotes supplements={voucher.supplements ?? []} /></div>;
}

export function VoucherSupplementNotes({ supplements }: { supplements: IncomeExpenseSupplement[] }) {
  return <>{supplements.map(s => <div key={s.id} className="space-y-1 border-t pt-2" data-testid="voucher-supplement-note">
    <div className="whitespace-pre-wrap break-words text-sm">{s.note || `Bổ sung ${s.attachments.length} ảnh / chứng từ.`}</div>
    <div className="text-xs text-muted-foreground">{formatSupplementAuthor(s)}</div>
  </div>)}</>;
}

export default VoucherNote;
