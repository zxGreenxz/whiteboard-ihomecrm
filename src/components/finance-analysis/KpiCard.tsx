import type { LucideIcon } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { DeltaBadge } from "./DeltaBadge";

export type KpiAccent = "emerald" | "red" | "blue" | "amber" | "violet" | "slate";

// Tailwind không thấy class động → map tĩnh.
const ACCENT: Record<KpiAccent, { border: string; iconBg: string; iconText: string }> = {
  emerald: { border: "border-l-emerald-500", iconBg: "bg-emerald-100", iconText: "text-emerald-600" },
  red: { border: "border-l-red-500", iconBg: "bg-red-100", iconText: "text-red-600" },
  blue: { border: "border-l-blue-500", iconBg: "bg-blue-100", iconText: "text-blue-600" },
  amber: { border: "border-l-amber-500", iconBg: "bg-amber-100", iconText: "text-amber-600" },
  violet: { border: "border-l-violet-500", iconBg: "bg-violet-100", iconText: "text-violet-600" },
  slate: { border: "border-l-slate-500", iconBg: "bg-slate-100", iconText: "text-slate-600" },
};

interface DeltaSpec {
  current: number;
  previous: number | null | undefined;
  invert?: boolean;
}

interface KpiCardProps {
  label: string;
  /** Giá trị đã format sẵn (formatCurrency / "93,5%" / "12 phòng"). */
  value: string;
  icon: LucideIcon;
  accent: KpiAccent;
  /** So tháng trước. */
  mom?: DeltaSpec;
  /** Cùng kỳ năm trước. */
  yoy?: DeltaSpec;
  /** Dòng phụ (vd "8/120 phòng trống"). */
  sub?: string;
  loading?: boolean;
}

export function KpiCard({ label, value, icon: Icon, accent, mom, yoy, sub, loading }: KpiCardProps) {
  const a = ACCENT[accent];
  return (
    <Card className={cn("border-l-4 hover:shadow-md transition-shadow", a.border)}>
      <CardContent className="p-4">
        <div className="flex items-center gap-3">
          <div className={cn("h-11 w-11 shrink-0 rounded-full flex items-center justify-center", a.iconBg)}>
            <Icon className={cn("h-5 w-5", a.iconText)} />
          </div>
          <div className="min-w-0 flex-1">
            {loading ? (
              <Skeleton className="h-7 w-28" />
            ) : (
              <div className="text-xl font-bold truncate" title={value}>
                {value}
              </div>
            )}
            <div className="text-sm text-muted-foreground truncate">{label}</div>
          </div>
        </div>
        {sub && !loading && (
          <div className="mt-2 text-xs text-muted-foreground truncate" title={sub}>
            {sub}
          </div>
        )}
        {(mom || yoy) && !loading && (
          <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1">
            {mom && (
              <span className="flex items-center gap-1">
                <DeltaBadge current={mom.current} previous={mom.previous} invert={mom.invert} />
                <span className="text-xs text-muted-foreground">tháng trước</span>
              </span>
            )}
            {yoy && (
              <span className="flex items-center gap-1">
                <DeltaBadge current={yoy.current} previous={yoy.previous} invert={yoy.invert} />
                <span className="text-xs text-muted-foreground">cùng kỳ</span>
              </span>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
