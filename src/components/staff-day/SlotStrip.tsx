import { cn } from "@/lib/utils";
import { slotStrip, type GpsDay, type StripCell } from "@/lib/staffDay";

const STATE_LABEL: Record<StripCell["state"], string> = {
  ok: "có dấu GPS",
  ok_stationary: "có dấu, máy đứng yên",
  missing: "mất tín hiệu",
  paused: "đã tắt",
  pending: "chờ máy gửi",
  future: "chưa tới",
  off: "ngoài khung giờ",
};

const DOT_CLASS: Record<StripCell["state"], string> = {
  ok: "border-emerald-600 bg-emerald-600",
  ok_stationary: "border-emerald-500 bg-emerald-300",
  missing: "border-orange-600 bg-orange-600",
  paused: "border-slate-500 bg-slate-400",
  pending: "border-primary bg-white",
  future: "border-slate-300 bg-white",
  off: "rounded-sm border-slate-300 bg-slate-300",
};

const MOCK_CLASS = "border-red-600 bg-red-200";
/** Nhiều ô hơn mức này thì chấm 12 px chồng lên nhau ở khổ 390 px. */
const DENSE_FROM = 24;

function cellLabel(cell: StripCell): string {
  return `${cell.label} ${STATE_LABEL[cell.state]}${cell.mock ? ", nghi vị trí giả" : ""}`;
}

/** Dải mốc điểm danh của một ngày. Ô xám vuông là ngoài khung giờ: lúc đó tính theo việc/check nhà. */
export function SlotStrip({ gps }: { gps: Pick<GpsDay, "windows" | "interval_min" | "slots"> }) {
  const cells = slotStrip(gps);
  if (cells.length === 0) return null;
  const dense = cells.length > DENSE_FROM;
  return (
    <div className={cn("flex items-end justify-between", dense ? "gap-px" : "gap-0.5")} role="img" aria-label={`Các mốc điểm danh: ${cells.map(cellLabel).join(", ")}`}>
      {cells.map((cell) => (
        <div key={cell.at} className="flex min-w-0 flex-1 flex-col items-center gap-1">
          <span title={cellLabel(cell)} className={cn("aspect-square w-full rounded-full", dense ? "max-w-1.5 border" : "max-w-3 border-2", cell.mock ? MOCK_CLASS : DOT_CLASS[cell.state])} />
          <span className="h-3 whitespace-nowrap text-[9px] leading-3 text-muted-foreground">{cell.hourLabel}</span>
        </div>
      ))}
    </div>
  );
}

const LEGEND: { cls: string; text: string }[] = [
  { cls: "border-emerald-600 bg-emerald-600", text: "Có dấu GPS" },
  { cls: "border-orange-600 bg-orange-600", text: "Mất tín hiệu" },
  { cls: "border-slate-300 bg-white", text: "Chưa tới" },
  { cls: "rounded-sm border-slate-300 bg-slate-300", text: "Ngoài khung giờ — theo việc / check nhà" },
];

export function SlotLegend({ showMock = false }: { showMock?: boolean }) {
  const items = showMock ? [...LEGEND, { cls: MOCK_CLASS, text: "Nghi vị trí giả" }] : LEGEND;
  return (
    <div className="flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-slate-700">
      {items.map((item) => (
        <span key={item.text} className="flex items-center gap-1.5">
          <span aria-hidden="true" className={cn("h-2.5 w-2.5 rounded-full border-2", item.cls)} />
          {item.text}
        </span>
      ))}
    </div>
  );
}
