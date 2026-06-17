import { Building2, Layers } from "lucide-react";
import { format } from "date-fns";
import type { IncomeExpenseBatchSummary } from "@/hooks/useIncomeExpenses";

interface Props {
  batches: IncomeExpenseBatchSummary[];
  isLoading: boolean;
  onView: (batchId: string) => void;
  totalCount: number;
  onLoadMore: () => void;
}

const compact = (n: number) => {
  const a = Math.abs(n);
  if (a >= 1e9) return (n / 1e9).toFixed(1).replace(/\.0$/, "") + "tỷ";
  if (a >= 1e6) return (n / 1e6).toFixed(1).replace(/\.0$/, "") + "tr";
  if (a >= 1e3) return (n / 1e3).toFixed(0) + "k";
  return n.toLocaleString("vi-VN");
};

const fmtDate = (s: string | null) => {
  if (!s) return "—";
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return "—";
  return format(d, "dd/MM/yyyy");
};

/**
 * Phiếu tổng (batch) — danh sách thẻ warm-neutral cho mobile. Mỗi thẻ = 1 đợt:
 * mã phiếu đầu + "+N", trạng thái, tổng tiền, tên đợt, ngày/sổ quỹ/người, các toà
 * + số phiếu. Chạm thẻ → chi tiết đợt (IncomeExpenseBatchDetailMobile).
 */
export function IncomeExpenseBatchListMobile({
  batches,
  isLoading,
  onView,
  totalCount,
  onLoadMore,
}: Props) {
  if (isLoading) {
    return (
      <div className="stub">
        <p>Đang tải phiếu tổng…</p>
      </div>
    );
  }
  if (batches.length === 0) {
    return (
      <div className="stub" style={{ padding: "48px 24px" }}>
        <p style={{ fontWeight: 700, color: "var(--ink-2)" }}>
          Chưa có phiếu tổng nào
        </p>
        <p style={{ marginTop: 4 }}>
          Tạo "Phiếu tổng" để gom nhiều phiếu lẻ trong một đợt thanh toán.
        </p>
      </div>
    );
  }

  return (
    <div className="rowlist">
      {batches.map((b) => {
        const inc = b.type === "INCOME";
        const accent = inc ? "#10b981" : "#ef4444";
        const firstCode = b.vouchers[0]?.code ?? "—";
        const extra = b.voucher_count - 1;
        return (
          <div
            className="bvch"
            key={b.id}
            onClick={() => onView(b.id)}
            style={{ borderLeftColor: accent, opacity: b.all_cancelled ? 0.6 : 1 }}
          >
            <div className="bvch-l1">
              <span
                className="lrow-code"
                style={b.all_cancelled ? { textDecoration: "line-through" } : undefined}
              >
                {firstCode}
              </span>
              {extra > 0 && <span className="bvch-plus">+{extra}</span>}
              {b.all_cancelled ? (
                <span
                  className="vch-tag"
                  style={{ color: "#b91c1c", background: "#fee2e2" }}
                >
                  Đã huỷ
                </span>
              ) : (
                <span
                  className="vch-tag"
                  style={{ color: "#047857", background: "#d1fae5" }}
                >
                  Đã ghi nhận
                </span>
              )}
              <span className="vch-amt" style={{ color: accent, marginLeft: "auto" }}>
                {inc ? "+" : "−"}
                {compact(b.total_amount)}
              </span>
            </div>
            <div className="bvch-name">{b.name}</div>
            <div className="bvch-meta">
              {fmtDate(b.voucher_date)}
              {b.account_name ? ` · ${b.account_name}` : ""}
              {b.payer_name ? ` · ${b.payer_name}` : ""}
            </div>
            <div className="bvch-foot">
              {b.building_names.length > 0 ? (
                <>
                  <span className="bvch-bld">
                    <Building2 size={12} />
                    {b.building_names.slice(0, 2).join(", ")}
                  </span>
                  {b.building_names.length > 2 && (
                    <span className="bvch-bld">+{b.building_names.length - 2} toà</span>
                  )}
                </>
              ) : null}
              <span className="bvch-cnt">
                <Layers size={11} style={{ verticalAlign: "-1px", marginRight: 3 }} />
                {b.voucher_count} phiếu
              </span>
            </div>
          </div>
        );
      })}
      {totalCount > batches.length && (
        <button className="loadmore" onClick={onLoadMore}>
          Xem thêm ({totalCount - batches.length})
        </button>
      )}
    </div>
  );
}

export default IncomeExpenseBatchListMobile;
