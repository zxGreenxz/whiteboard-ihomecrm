import { format } from "date-fns";
import { ArrowRight, History } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { formatVND } from "@/lib/utils";
import {
  ROOM_PRICE_SOURCE_LABELS,
  useRoomPriceHistory,
  type RoomPriceHistoryEntry,
} from "@/hooks/useRoomPriceHistory";

interface RoomPriceHistorySectionProps {
  roomId: string;
  /** Chỉ fetch khi dialog đang mở. */
  enabled?: boolean;
}

const changed = (before: number | null, after: number | null) =>
  Math.abs(Number(before ?? 0) - Number(after ?? 0)) >= 0.01;

/** Nhãn cặp số — cùng một cột nhưng ý nghĩa khác nhau theo nguồn thay đổi. */
function labels(entry: RoomPriceHistoryEntry): { rent: string; deposit: string } {
  if (entry.source === "CONTRACT_CREATE") {
    return { rent: "Giá phòng → giá ký HĐ", deposit: "Tiền thuê → cọc đã ký" };
  }
  if (entry.source === "CONTRACT_EDIT") {
    return { rent: "Giá thuê HĐ", deposit: "Tiền cọc HĐ" };
  }
  return { rent: "Giá thuê mặc định", deposit: "Tiền cọc mặc định" };
}

function PriceDelta({
  label,
  before,
  after,
}: {
  label: string;
  before: number | null;
  after: number | null;
}) {
  const isDown = Number(after ?? 0) < Number(before ?? 0);
  return (
    <div className="flex flex-wrap items-center gap-1.5 text-xs">
      <span className="text-muted-foreground">{label}:</span>
      <span className="tabular-nums text-muted-foreground line-through">
        {formatVND(before ?? 0)}
      </span>
      <ArrowRight className="h-3 w-3 text-muted-foreground" />
      <span
        className={
          isDown
            ? "font-medium tabular-nums text-amber-600 dark:text-amber-500"
            : "font-medium tabular-nums text-emerald-600 dark:text-emerald-500"
        }
      >
        {formatVND(after ?? 0)}
      </span>
    </div>
  );
}

/**
 * Lịch sử giá của phòng — ai đổi giá thuê / tiền cọc, lúc nào, từ hợp đồng nào.
 *
 * Dữ liệu do trigger DB ghi tự động (sửa phòng, ký HĐ lệch giá niêm yết, sửa
 * giá trên HĐ) nên không bao giờ thiếu dấu vết dù thao tác đi đường nào.
 */
export function RoomPriceHistorySection({
  roomId,
  enabled = true,
}: RoomPriceHistorySectionProps) {
  const { data: entries = [], isLoading } = useRoomPriceHistory(roomId, {
    enabled,
  });

  return (
    <div className="space-y-3 pt-4 border-t">
      <h3 className="flex items-center gap-2 font-semibold text-sm">
        <History className="h-4 w-4" />
        Lịch sử giá
      </h3>

      {isLoading ? (
        <p className="text-xs text-muted-foreground">Đang tải…</p>
      ) : entries.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          Chưa có thay đổi giá nào được ghi nhận cho phòng này.
        </p>
      ) : (
        <div className="space-y-2">
          {entries.map((entry) => {
            const l = labels(entry);
            return (
              <div key={entry.id} className="rounded-md border px-3 py-2 space-y-1">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge variant="secondary" className="text-[11px]">
                    {ROOM_PRICE_SOURCE_LABELS[entry.source] ?? entry.source}
                  </Badge>
                  <span className="text-xs text-muted-foreground">
                    {format(new Date(entry.changed_at), "dd/MM/yyyy HH:mm")}
                  </span>
                  {entry.contract_number && (
                    <span className="text-xs text-muted-foreground">
                      · HĐ {entry.contract_number}
                    </span>
                  )}
                  {entry.changed_by_name && (
                    <span className="text-xs text-muted-foreground">
                      · {entry.changed_by_name}
                    </span>
                  )}
                </div>

                {changed(entry.rent_price_before, entry.rent_price_after) && (
                  <PriceDelta
                    label={l.rent}
                    before={entry.rent_price_before}
                    after={entry.rent_price_after}
                  />
                )}
                {changed(entry.deposit_before, entry.deposit_after) && (
                  <PriceDelta
                    label={l.deposit}
                    before={entry.deposit_before}
                    after={entry.deposit_after}
                  />
                )}

                {entry.note && (
                  <p className="text-[11px] text-muted-foreground">{entry.note}</p>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
