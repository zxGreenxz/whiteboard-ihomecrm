import { Badge } from "@/components/ui/badge";

/**
 * B4 (thống nhất tài chính 04/07): badge trạng thái phiếu DÙNG CHUNG
 * desktop + mobile — trước đây mỗi nơi tự vẽ (mobile thiếu "Đã ghi nhận").
 * Nhãn theo hành động cho người vận hành:
 *   UNAPPROVED  → "Chờ duyệt"    (việc còn phải làm)
 *   APPROVED    → "Đã vào sổ"    (đã tính vào tồn quỹ)
 *   + verified  → "Đã đối chiếu" (đã kiểm — thay thế badge Đã vào sổ)
 *   CANCELLED   → "Đã huỷ"
 */
export function VoucherStatusBadge({
  status,
  verifiedAt,
}: {
  status: "UNAPPROVED" | "APPROVED" | "CANCELLED" | string;
  verifiedAt?: string | null;
}) {
  if (status === "CANCELLED") {
    return (
      <Badge variant="secondary" className="bg-red-100 text-red-700 hover:bg-red-100">
        Đã huỷ
      </Badge>
    );
  }
  if (status === "UNAPPROVED") {
    return (
      <Badge variant="secondary" className="bg-amber-100 text-amber-800 hover:bg-amber-100">
        Chờ duyệt
      </Badge>
    );
  }
  if (verifiedAt) {
    return (
      <Badge variant="secondary" className="bg-emerald-100 text-emerald-700 hover:bg-emerald-100">
        Đã đối chiếu
      </Badge>
    );
  }
  return (
    <Badge variant="secondary" className="bg-blue-100 text-blue-700 hover:bg-blue-100">
      Đã vào sổ
    </Badge>
  );
}

/** Badge "Nội bộ" cho bút toán không-tiền-thật (cấn cọc, backfill, điều chỉnh). */
export function InternalBadge() {
  return (
    <Badge
      variant="secondary"
      className="bg-slate-200 text-slate-600 hover:bg-slate-200"
      title="Bút toán nội bộ — không có tiền thật ra/vào két, không cộng vào Tổng thu/chi"
    >
      Nội bộ
    </Badge>
  );
}
