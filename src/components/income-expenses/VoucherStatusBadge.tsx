import { Badge } from "@/components/ui/badge";
import {
  getVoucherDisplayState,
  type VoucherDisplayInput,
  type VoucherTone,
} from "@/lib/financeV2VoucherState";

/**
 * B4 (thống nhất tài chính 04/07): badge trạng thái phiếu DÙNG CHUNG desktop + mobile.
 *
 * Finance V2 (route-aware, plan §12.1/§9.6): khi org đã CANONICAL read-semantics, caller
 * truyền `v2` (4 trục approval/review/posting/execution + type) — badge render nhãn
 * composite từ getVoucherDisplayState (Chờ duyệt / Đã Duyệt - Chưa Chi / Đã Chi /
 * Đã hoàn tác / Cần bổ sung / Đang tranh chấp…), TIỀN THẬT chỉ khi POSTED.
 *
 * Khi chưa CANONICAL (route LEGACY/SHADOW — mặc định hôm nay) giữ nguyên nhãn legacy:
 *   UNAPPROVED  → "Chờ duyệt"    (việc còn phải làm)
 *   APPROVED    → "Đã vào sổ"    (legacy: duyệt = đã tính vào tồn quỹ)
 *   + verified  → "Đã đối chiếu" (đã kiểm — thay thế badge Đã vào sổ)
 *   CANCELLED   → "Đã huỷ"
 */
const TONE_CLASSES: Record<VoucherTone, string> = {
  pending: "bg-amber-100 text-amber-800 hover:bg-amber-100",
  changes: "bg-orange-100 text-orange-800 hover:bg-orange-100",
  disputed: "bg-rose-100 text-rose-700 hover:bg-rose-100",
  approved: "bg-sky-100 text-sky-700 hover:bg-sky-100",
  posted: "bg-blue-100 text-blue-700 hover:bg-blue-100",
  reversed: "bg-violet-100 text-violet-700 hover:bg-violet-100",
  cancelled: "bg-red-100 text-red-700 hover:bg-red-100",
};

export function VoucherStatusBadge({
  status,
  verifiedAt,
  v2,
}: {
  status: "UNAPPROVED" | "APPROVED" | "CANCELLED" | string;
  verifiedAt?: string | null;
  /**
   * Composite V2 input — CHỈ truyền khi route read-semantics của org là CANONICAL
   * (qua useFinanceV2Routes/isCanonicalRead). Không truyền = nhãn legacy như cũ.
   */
  v2?: Omit<VoucherDisplayInput, "approval_status"> | null;
}) {
  if (v2) {
    const s = getVoucherDisplayState({
      approval_status: status as VoucherDisplayInput["approval_status"],
      ...v2,
    });
    return (
      <Badge variant="secondary" className={TONE_CLASSES[s.tone]}>
        {s.label}
      </Badge>
    );
  }
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
