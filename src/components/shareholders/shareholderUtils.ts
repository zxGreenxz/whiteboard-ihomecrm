import { format, parse } from "date-fns";

// period_month luôn là chuỗi YYYY-MM-01.
export function periodOf(year: number, month1to12: number): string {
  return `${year}-${String(month1to12).padStart(2, "0")}-01`;
}

export function periodToLabel(period: string): string {
  const d = parse(period, "yyyy-MM-dd", new Date());
  return format(d, "MM/yyyy");
}

export function monthsOfYear(year: number): string[] {
  return Array.from({ length: 12 }, (_, i) => periodOf(year, i + 1));
}

export function monthDateRange(period: string): { start: string; end: string } {
  const d = parse(period, "yyyy-MM-dd", new Date());
  const start = format(new Date(d.getFullYear(), d.getMonth(), 1), "yyyy-MM-dd");
  const end = format(new Date(d.getFullYear(), d.getMonth() + 1, 0), "yyyy-MM-dd");
  return { start, end };
}

export function yearDateRange(year: number): { start: string; end: string } {
  return { start: `${year}-01-01`, end: `${year}-12-31` };
}

export function currentYear(): number {
  return new Date().getFullYear();
}

export function currentPeriod(): string {
  const d = new Date();
  return periodOf(d.getFullYear(), d.getMonth() + 1);
}

// Palette ổn định cho biểu đồ theo nhà/cổ đông.
export const CHART_COLORS = [
  "#3b82f6", "#10b981", "#f59e0b", "#ef4444", "#8b5cf6",
  "#06b6d4", "#ec4899", "#84cc16", "#f97316", "#6366f1",
  "#14b8a6", "#a855f7", "#eab308", "#22c55e", "#0ea5e9",
];

export function colorAt(i: number): string {
  return CHART_COLORS[i % CHART_COLORS.length];
}
