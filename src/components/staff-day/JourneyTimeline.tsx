import { cn } from "@/lib/utils";
import { StaffThumb } from "@/components/staff-day/StaffThumb";
import type { TimelineRow } from "@/lib/staffDay";

const DOT: Record<TimelineRow["tone"], string> = {
  inspect: "border-emerald-600 bg-emerald-600",
  open: "border-emerald-600 bg-white",
  job: "border-violet-600 bg-violet-600",
  payment: "border-orange-500 bg-orange-500",
  gps: "border-slate-400 bg-slate-400",
  warn: "border-orange-600 bg-orange-600",
};

export function JourneyTimeline({ rows }: { rows: readonly TimelineRow[] }) {
  if (rows.length === 0) {
    return <p className="py-3 text-sm text-muted-foreground">Chưa có dấu chân nào trong ngày này.</p>;
  }
  return (
    <ol className="list-none">
      {rows.map((row) => {
        const photos = row.photos ?? [];
        const shown = photos.slice(0, 3);
        const more = photos.length - shown.length;
        return (
          <li key={row.key} className="flex items-stretch gap-2.5">
            <div className={cn("w-[42px] shrink-0 pt-2.5 font-mono text-xs font-semibold", row.tone === "warn" && "text-orange-700")}>{row.time}</div>
            <div className="flex w-[18px] shrink-0 flex-col items-center" aria-hidden="true">
              <span className="h-2.5 w-0.5 bg-slate-200" />
              <span className={cn("h-3 w-3 shrink-0 rounded-full border-2", DOT[row.tone])} />
              <span className="w-0.5 flex-1 bg-slate-200" />
            </div>
            <div className="min-w-0 flex-1 pb-3 pt-1.5">
              <div className={cn("text-[13px]", row.strong ? "font-bold" : "font-medium", row.tone === "warn" && "text-orange-700")}>{row.title}</div>
              {row.sub ? <div className="text-xs text-muted-foreground">{row.sub}</div> : null}
              {row.badge ? (
                <span className={cn(
                  "mt-1 inline-flex rounded-full px-2 py-0.5 text-[11px] font-semibold",
                  row.badge.tone === "success" ? "bg-emerald-50 text-emerald-800" : "bg-orange-50 text-orange-700",
                )}>{row.badge.text}</span>
              ) : null}
              {photos.length > 0 ? (
                <div className="mt-1.5 flex gap-1">
                  {shown.map((photo) => (
                    <StaffThumb
                      key={photo.path}
                      path={photo.path}
                      label={photo.label ?? photo.slot}
                      outOfRange={photo.geofence_status === "out_of_range"}
                      className="h-[50px]"
                    />
                  ))}
                  {more > 0 ? (
                    <div className="flex h-[50px] min-w-0 flex-1 items-center justify-center rounded-lg border border-dashed border-slate-300 bg-slate-100 text-[11px] font-semibold text-muted-foreground">+{more}</div>
                  ) : null}
                </div>
              ) : null}
            </div>
          </li>
        );
      })}
    </ol>
  );
}
