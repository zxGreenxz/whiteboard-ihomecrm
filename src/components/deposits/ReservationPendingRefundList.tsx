import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { useInfiniteReservationSettlements } from "@/hooks/useReservationSettlement";
import { useMyPermissions } from "@/hooks/useMyPermissions";
import { can } from "@/lib/permissions";
import { formatCurrency } from "@/lib/utils";
import { ReservationRefundDialog } from "./ReservationRefundDialog";

export function ReservationPendingRefundList({ buildingIds }: { buildingIds?: string[] }) {
  const query = useInfiniteReservationSettlements({ buildingIds, refundState: "PENDING" });
  const { data: perms } = useMyPermissions();
  const canPay = can(perms, "deposits", "refund") && can(perms, "income_expenses", "approve");
  const [payTarget, setPayTarget] = useState<{ id: string; amount: number } | null>(null);
  if (query.isLoading) return <Skeleton className="h-28 w-full" />;
  if (query.error) return <p className="text-sm text-destructive">Không tải được khoản chờ hoàn: {query.error.message}</p>;
  const rows = query.data?.pages.flatMap((page) => page.rows) ?? [];
  return <section className="space-y-3"><div><h2 className="font-bold">Chờ hoàn cọc</h2><p className="text-sm text-muted-foreground">Các khoản phải trả khách, không phụ thuộc ngày hẹn.</p></div>{rows.length === 0 ? <Card className="p-4 text-sm text-muted-foreground">Không có khoản nào đang chờ hoàn.</Card> : rows.map((row) => <Card key={row.id} className="flex flex-wrap items-center gap-3 p-4"><div className="min-w-0 flex-1"><b>{row.voucherCode || "Phiếu giữ chỗ"}</b><div className="text-sm text-muted-foreground">{row.payerName || "—"} · {row.buildingName}{row.roomName ? ` / ${row.roomName}` : ""}</div><div className="mt-1 font-bold text-amber-700">Còn phải hoàn {formatCurrency(row.refundRemaining)}</div></div>{canPay && <Button onClick={() => setPayTarget({ id: row.id, amount: row.refundRemaining })}>Hoàn tiền</Button>}</Card>)}{query.hasNextPage && <Button variant="outline" disabled={query.isFetchingNextPage} onClick={() => query.fetchNextPage()}>{query.isFetchingNextPage ? "Đang tải…" : "Tải thêm"}</Button>}<ReservationRefundDialog settlementId={payTarget?.id ?? null} amount={payTarget?.amount ?? 0} open={!!payTarget} onOpenChange={(next) => !next && setPayTarget(null)} /></section>;
}
