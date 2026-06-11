import { cn } from "@/lib/utils";
import { deltaPct } from "./utils";

interface DeltaBadgeProps {
  current: number;
  previous: number | null | undefined;
  /** true cho chi phí/công nợ: TĂNG = xấu (đỏ), GIẢM = tốt (xanh). */
  invert?: boolean;
  className?: string;
}

/**
 * Badge ▲/▼ x,x% so kỳ trước. Mũi tên theo DẤU thay đổi; màu theo
 * tốt/xấu (invert đảo ánh xạ màu). prev null/0 → "—".
 */
export function DeltaBadge({ current, previous, invert = false, className }: DeltaBadgeProps) {
  const pct = deltaPct(current, previous);
  if (pct == null) {
    return <span className={cn("text-xs text-muted-foreground", className)}>—</span>;
  }
  const up = pct >= 0;
  const good = invert ? !up : up;
  const arrow = up ? "▲" : "▼";
  const label = `${arrow} ${Math.abs(pct).toLocaleString("vi-VN", {
    maximumFractionDigits: 1,
    minimumFractionDigits: 1,
  })}%`;
  return (
    <span
      className={cn(
        "inline-flex items-center rounded px-1.5 py-0.5 text-xs font-medium tabular-nums",
        good ? "bg-emerald-50 text-emerald-600" : "bg-red-50 text-red-600",
        className,
      )}
    >
      {label}
    </span>
  );
}
