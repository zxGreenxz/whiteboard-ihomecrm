import { Badge } from "@/components/ui/badge";
import { formatCurrency } from "@/lib/utils";
import type { ReservationSettlement } from "@/lib/reservationSettlementRpc";

export function ReservationSettlementStatus({ settlement }: { settlement: ReservationSettlement }) {
  const label = settlement.refundAmount === 0
    ? "Đã bỏ cọc"
    : settlement.retainedAmount === 0
      ? settlement.refundState === "PAID" ? "Đã hoàn cọc" : "Chờ hoàn cọc"
      : "Đã bỏ cọc một phần";
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Badge variant="secondary">{label}</Badge>
      {settlement.refundAmount > 0 && (
        <span className={settlement.refundState === "PENDING" ? "text-amber-700" : "text-emerald-700"}>
          {settlement.refundState === "PENDING" ? "Chờ hoàn" : "Đã hoàn"} {formatCurrency(settlement.refundAmount)}
        </span>
      )}
    </div>
  );
}
