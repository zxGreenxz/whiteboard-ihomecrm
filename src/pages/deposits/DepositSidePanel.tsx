import { Card } from "@/components/ui/card";
import { formatCurrency } from "@/lib/utils";
import type { BuildingDepositSummary } from "@/hooks/useDepositDashboard";
import type { RefundForfeitServerSummary } from "@/hooks/useDepositDashboard";
import type { ReservationDepositRow } from "@/hooks/useDeposits";

/**
 * Cột phải của bản 2a — ba thứ trả lời câu "bức tranh chung thế nào", tách khỏi
 * hàng đợi việc để hai thứ không tranh chỗ nhau.
 */

const RESV_ROWS = [
  { key: "UNAPPROVED" as const, label: "Chờ duyệt", dot: "bg-amber-500" },
  { key: "APPROVED" as const, label: "Đang giữ chỗ", dot: "bg-emerald-500" },
  { key: "CANCELLED" as const, label: "Đã huỷ", dot: "bg-muted-foreground/50" },
];

export function ReservationBreakdownCard({
  reservations,
  onOpenHolds,
}: {
  reservations: ReservationDepositRow[];
  onOpenHolds: () => void;
}) {
  return (
    <Card className="p-5">
      <div className="text-sm font-extrabold">Phiếu giữ chỗ</div>
      <div className="mt-3 flex flex-col gap-2.5 text-[13px]">
        {RESV_ROWS.map((row) => {
          // Cộng trên `reservations` — hook đã phân trang đủ (fetchAllRows) nên
          // không dính cap-1000, và tiền/số phiếu ở đây đi từ CÙNG một nguồn
          // nên không thể lệch nhau.
          const rows = reservations.filter((r) => r.approval_status === row.key);
          const total = rows.reduce((s, r) => s + r.total_amount, 0);
          return (
            <div key={row.key} className="flex items-center gap-2">
              <span className={`h-1.5 w-1.5 rounded-full ${row.dot}`} />
              <span>{row.label}</span>
              <span className="ml-auto text-muted-foreground">{rows.length} phiếu</span>
              <strong className={row.key === "CANCELLED" ? "text-muted-foreground" : ""}>
                {formatCurrency(total)}
              </strong>
            </div>
          );
        })}
      </div>
      <div className="mt-3 border-t pt-2.5">
        <button
          type="button"
          onClick={onOpenHolds}
          className="text-[12.5px] font-bold text-primary hover:underline"
        >
          Xem tất cả phiếu →
        </button>
      </div>
    </Card>
  );
}

export function BuildingCoverageCard({ rows }: { rows: BuildingDepositSummary[] }) {
  return (
    <Card className="p-5">
      <div className="text-sm font-extrabold">Đủ / thiếu theo toà</div>
      {rows.length === 0 ? (
        <p className="mt-3 text-xs text-muted-foreground">
          Không có hợp đồng đang hiệu lực.
        </p>
      ) : (
        <div className="mt-3.5 flex flex-col gap-3.5">
          {rows.map((b) => {
            const pct =
              b.expected > 0 ? Math.min(100, (b.held / b.expected) * 100) : 100;
            return (
              <div key={b.building_id || b.building_name}>
                <div className="flex items-baseline gap-2 text-[13px]">
                  <span className="truncate font-bold" title={b.building_name}>
                    {b.building_name}
                  </span>
                  {b.shortCount > 0 && (
                    <span className="shrink-0 rounded-md bg-orange-50 px-1.5 py-px text-[11px] font-bold text-orange-600">
                      {b.shortCount} thiếu
                    </span>
                  )}
                  <span className="ml-auto shrink-0 text-xs text-muted-foreground">
                    {formatCurrency(b.held)} / {formatCurrency(b.expected)}
                  </span>
                </div>
                <div className="mt-1.5 h-1.5 rounded-full bg-orange-100">
                  <div
                    className="h-1.5 rounded-full bg-emerald-500"
                    style={{ width: `${pct}%` }}
                  />
                </div>
              </div>
            );
          })}
        </div>
      )}
    </Card>
  );
}

export function RefundReconcileCard({
  summary,
  reconciles,
}: {
  summary: RefundForfeitServerSummary | undefined;
  reconciles: boolean;
}) {
  // Không đối chiếu được thì KHÔNG vẽ thanh tỉ lệ: một thanh dựng từ hai số
  // không cộng lại thành tổng là hình ảnh nói dối, tệ hơn là không có hình.
  if (!summary || !reconciles) {
    return (
      <Card className="p-5">
        <div className="text-sm font-extrabold">Đối soát hoàn cọc</div>
        <p className="mt-2 text-xs text-muted-foreground">
          Chưa đối chiếu được (nối hồ sơ + mồ côi ≠ tổng đã ra két). Xem tab
          "Hoàn / Bỏ cọc" để rà tay.
        </p>
      </Card>
    );
  }
  const linkedPct =
    summary.refundTotal > 0 ? (summary.linkedTotal / summary.refundTotal) * 100 : 0;
  return (
    <Card className="p-5">
      <div className="text-sm font-extrabold">Đối soát hoàn cọc</div>
      <div className="mt-2.5 flex flex-col gap-2 text-[12.5px]">
        <div className="flex">
          <span className="text-muted-foreground">Tiền đã ra khỏi két</span>
          <span className="ml-auto font-bold">{formatCurrency(summary.refundTotal)}</span>
        </div>
        <div className="flex">
          <span className="text-muted-foreground">Nối được hồ sơ</span>
          <span className="ml-auto">
            {formatCurrency(summary.linkedTotal)} · {summary.linkedVoucherCount}
          </span>
        </div>
        <div className="flex text-red-600">
          <span className="font-bold">Chưa có hồ sơ</span>
          <span className="ml-auto font-bold">
            {formatCurrency(summary.orphanTotal)} · {summary.orphanCount}
          </span>
        </div>
        <div className="mt-0.5 h-2 overflow-hidden rounded-full bg-red-100">
          <div className="h-2 bg-emerald-500" style={{ width: `${linkedPct}%` }} />
        </div>
        <p className="text-[11.5px] text-muted-foreground">
          Ghi nhận để rà tay — hệ thống không tự sửa.
        </p>
      </div>
    </Card>
  );
}
