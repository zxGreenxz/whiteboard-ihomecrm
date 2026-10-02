import { SkeletonBar, SlowNotice, useSlowFlag } from "@/components/loading/LoadingState";

/** Chiều cao cột xám — lệch nhau cho giống biểu đồ thật. */
const BAR_HEIGHTS = ["45%", "62%", "38%", "74%", "56%", "82%", "48%", "68%"];

/**
 * Khối xám hình biểu đồ (cột hoặc tròn) lúc chờ dữ liệu biểu đồ — chủ chốt 02/10/2026,
 * xem components/loading/LoadingState: không chữ "Đang tải…" trên màn hình, câu đó chỉ
 * còn cho trình đọc màn hình; khối xám hiện sau 0,3 s; quá 8 giây báo mạng chậm kèm
 * Thử lại. LoadingState chưa có hình biểu đồ nên ghép từ SkeletonBar/SlowNotice của bộ
 * dùng chung.
 */
export function ChartSkeleton({
  label,
  kind = "bars",
  height = 300,
  bars = BAR_HEIGHTS.length,
  onRetry,
}: {
  label: string;
  kind?: "bars" | "pie";
  height?: number;
  bars?: number;
  onRetry?: () => void;
}) {
  const slow = useSlowFlag(true);
  return (
    <div role="status">
      <span className="sr-only">Đang tải {label}…</span>
      {kind === "pie" ? (
        <div className="ld-appear flex items-center justify-center" style={{ height }} aria-hidden="true">
          <SkeletonBar className="aspect-square rounded-full" style={{ height: "55%" }} />
        </div>
      ) : (
        <div className="ld-appear flex items-end gap-2 px-1" style={{ height }} aria-hidden="true">
          {Array.from({ length: bars }, (_, i) => (
            <SkeletonBar
              key={i}
              className="flex-1 rounded-t-md rounded-b-none"
              style={{ height: BAR_HEIGHTS[i % BAR_HEIGHTS.length] }}
            />
          ))}
        </div>
      )}
      {slow && <SlowNotice onRetry={onRetry} />}
    </div>
  );
}
