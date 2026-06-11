/**
 * Công thức + helpers thuần (không side-effect) cho trang Phân tích tài chính.
 * Mọi phép chia đều guard chia-0 → trả null, UI render "—".
 */

import { formatCurrency } from "@/lib/utils";
import type { FaMonthlyPnlRow, FaTypeBreakdownRow, Insight, MonthAgg } from "./types";

// ── Công thức ────────────────────────────────────────────────────────

/** Biên lợi nhuận % = net/revenue. revenue <= 0 → null. */
export const marginPct = (net: number, revenue: number): number | null =>
  revenue > 0 ? (net / revenue) * 100 : null;

/** % thay đổi so kỳ trước. prev null/0 → null. Math.abs để base âm (lỗ) vẫn có hướng đúng. */
export const deltaPct = (cur: number, prev: number | null | undefined): number | null =>
  prev == null || prev === 0 ? null : ((cur - prev) / Math.abs(prev)) * 100;

/** Tỷ trọng % của 1 phần trong tổng. */
export const sharePct = (amount: number, total: number): number | null =>
  total > 0 ? (amount / total) * 100 : null;

/** Tỷ lệ chi phí / doanh thu %. */
export const ratioPct = (expense: number, revenue: number): number | null =>
  revenue > 0 ? (expense / revenue) * 100 : null;

/** Tỷ lệ thu hồi % = đã thu / phải thu. */
export const collectionRate = (collected: number, billed: number): number | null =>
  billed > 0 ? (collected / billed) * 100 : null;

/**
 * Lấp đầy gộp nhiều toà: TRỌNG SỐ THEO PHÒNG (Σoccupied/Σtotal),
 * KHÔNG trung bình các % từng toà.
 */
export const occupancyAgg = (
  rows: { total_rooms: number; occupied_rooms: number }[],
): number | null => {
  const total = rows.reduce((s, r) => s + r.total_rooms, 0);
  if (total <= 0) return null;
  const occupied = rows.reduce((s, r) => s + r.occupied_rooms, 0);
  return (occupied / total) * 100;
};

// ── Định dạng ────────────────────────────────────────────────────────

/** Số gọn cho trục Y ("12 Tr", "1,2 T"). Tooltip/bảng luôn dùng formatCurrency. */
export const compactVnd = (v: number): string =>
  new Intl.NumberFormat("vi-VN", { notation: "compact", maximumFractionDigits: 1 }).format(v);

/** % 1 số lẻ theo vi-VN, null → "—". */
export const fmtPct = (v: number | null | undefined): string =>
  v == null
    ? "—"
    : `${v.toLocaleString("vi-VN", { maximumFractionDigits: 1, minimumFractionDigits: 1 })}%`;

/** 'YYYY-MM' | 'YYYY-MM-DD' → 'MM/yy' (cửa sổ 12T vắt qua 2 năm nên cần năm). */
export const monthLabel = (ym: string): string => `${ym.slice(5, 7)}/${ym.slice(2, 4)}`;

/** 'YYYY-MM' → 'MM/yyyy' cho tiêu đề. */
export const monthTitle = (ym: string): string => `${ym.slice(5, 7)}/${ym.slice(0, 4)}`;

/** 'YYYY-MM-01' | 'YYYY-MM' → 'YYYY-MM'. */
export const ymOf = (d: string): string => d.slice(0, 7);

// ── Số học tháng (string, tránh lệch timezone) ───────────────────────

/** Cộng/trừ tháng trên chuỗi 'YYYY-MM'. */
export function shiftMonth(ym: string, delta: number): string {
  const [y, m] = ym.split("-").map(Number);
  const idx = y * 12 + (m - 1) + delta;
  const ny = Math.floor(idx / 12);
  const nm = (idx % 12) + 1;
  return `${ny}-${String(nm).padStart(2, "0")}`;
}

/** `count` tháng 'YYYY-MM' liên tiếp KẾT THÚC tại endYm (inclusive). */
export function monthsRange(endYm: string, count: number): string[] {
  const out: string[] = [];
  for (let i = count - 1; i >= 0; i--) out.push(shiftMonth(endYm, -i));
  return out;
}

// ── Gộp & scaffold dữ liệu ───────────────────────────────────────────

/** Cộng pnl rows (mọi toà trong scope) theo tháng → Map<'YYYY-MM', MonthAgg>. */
export function aggregatePnlByMonth(rows: FaMonthlyPnlRow[]): Map<string, MonthAgg> {
  const map = new Map<string, MonthAgg>();
  for (const r of rows) {
    const ym = ymOf(r.month);
    const cur = map.get(ym) ?? { ym, revenue: 0, expense: 0, net: 0 };
    cur.revenue += r.revenue;
    cur.expense += r.expense;
    cur.net += r.net;
    map.set(ym, cur);
  }
  return map;
}

/** Trục tháng đầy đủ: tháng thiếu dữ liệu → 0 (RPC chỉ trả tháng có phiếu). */
export function scaffoldMonths(months: string[], byMonth: Map<string, MonthAgg>): MonthAgg[] {
  return months.map((ym) => byMonth.get(ym) ?? { ym, revenue: 0, expense: 0, net: 0 });
}

// ── Màu sắc ──────────────────────────────────────────────────────────

/** Màu cố định toàn trang (đồng bộ CashFlowReport). */
export const COLOR_INCOME = "#10B981";
export const COLOR_EXPENSE = "#EF4444";
export const COLOR_NET = "#3B82F6";
export const COLOR_RATIO = "#F59E0B";
export const COLOR_MUTED = "#94A3B8";

export const CHART_PALETTE = [
  "#3B82F6", "#10B981", "#F59E0B", "#8B5CF6", "#EC4899",
  "#06B6D4", "#84CC16", "#F97316", "#64748B", "#14B8A6",
];
export const colorAt = (i: number): string => CHART_PALETTE[i % CHART_PALETTE.length];

/** Palette tab Chi phí — bắt đầu từ đỏ, tông ấm. */
export const EXPENSE_PALETTE = [
  "#EF4444", "#F97316", "#F59E0B", "#8B5CF6", "#EC4899",
  "#06B6D4", "#64748B", "#84CC16", "#14B8A6", "#3B82F6",
];
export const expenseColorAt = (i: number): string => EXPENSE_PALETTE[i % EXPENSE_PALETTE.length];

/** Class nền heat-cell cho ma trận LN: 3 bậc xanh (dương) / đỏ (âm). */
export function heatClass(v: number, maxAbs: number): string {
  if (v === 0 || maxAbs <= 0) return "";
  const ratio = Math.abs(v) / maxAbs;
  if (v > 0) {
    if (ratio > 0.66) return "bg-emerald-200/70 text-emerald-900";
    if (ratio > 0.33) return "bg-emerald-100/70 text-emerald-900";
    return "bg-emerald-50 text-emerald-800";
  }
  if (ratio > 0.66) return "bg-red-200/70 text-red-900";
  if (ratio > 0.33) return "bg-red-100/70 text-red-900";
  return "bg-red-50 text-red-800";
}

// ── Phân tích cơ cấu theo hạng mục (dùng chung tab Doanh thu & Chi phí) ──

export interface TypeMonthDatum {
  label: string;
  [typeName: string]: number | string;
}

export interface TypeTableRow {
  name: string;
  category: string | null;
  current: number;
  previous: number | null;
  share: number | null;
}

export interface TypeAnalysis {
  /** Top N hạng mục theo tổng 12 tháng (thứ tự vẽ stack). */
  topNames: string[];
  /** Có bucket "Khác" trong stacked chart không. */
  hasOther: boolean;
  /** Data stacked chart 12 tháng: {label, [tên hạng mục]: tiền}. */
  stacked: TypeMonthDatum[];
  /** Bảng tháng chọn: từng hạng mục, so tháng trước, tỷ trọng. */
  tableRows: TypeTableRow[];
  /** Donut tháng chọn (top N + Khác). */
  donut: { name: string; value: number }[];
  /** Tổng giá trị tháng chọn của side. */
  curTotal: number;
  /** % giá trị "Không có hạng mục" trong tháng chọn (chất lượng dữ liệu). */
  uncategorizedPct: number | null;
}

export const UNCATEGORIZED_NAME = "Không có hạng mục";

export function analyzeTypeBreakdown(
  rows: FaTypeBreakdownRow[],
  side: "INCOME" | "EXPENSE",
  months12: string[],
  ym: string,
  prevYm: string,
  topN = 8,
): TypeAnalysis {
  const sideRows = rows.filter((r) => r.side === side);
  const monthSet = new Set(months12);

  // Rank theo tổng 12 tháng (gộp theo TÊN hạng mục — trùng tên thì gộp).
  const totalByName = new Map<string, number>();
  for (const r of sideRows) {
    if (!monthSet.has(ymOf(r.month))) continue;
    totalByName.set(r.type_name, (totalByName.get(r.type_name) ?? 0) + r.total_amount);
  }
  const ranked = [...totalByName.entries()].sort((a, b) => b[1] - a[1]).map(([n]) => n);
  const topNames = ranked.slice(0, topN);
  const hasOther = ranked.length > topN;
  const topSet = new Set(topNames);

  const stacked: TypeMonthDatum[] = months12.map((m) => {
    const d: TypeMonthDatum = { label: monthLabel(m) };
    for (const n of topNames) d[n] = 0;
    if (hasOther) d["Khác"] = 0;
    return d;
  });
  const idxByYm = new Map(months12.map((m, i) => [m, i] as const));
  for (const r of sideRows) {
    const i = idxByYm.get(ymOf(r.month));
    if (i == null) continue;
    const key = topSet.has(r.type_name) ? r.type_name : "Khác";
    if (!(key in stacked[i])) continue;
    stacked[i][key] = (stacked[i][key] as number) + r.total_amount;
  }

  const aggMonth = (target: string) => {
    const m = new Map<string, { name: string; category: string | null; total: number }>();
    for (const r of sideRows) {
      if (ymOf(r.month) !== target) continue;
      const cur = m.get(r.type_name) ?? { name: r.type_name, category: r.category, total: 0 };
      cur.total += r.total_amount;
      if (cur.category == null && r.category != null) cur.category = r.category;
      m.set(r.type_name, cur);
    }
    return m;
  };
  const curMap = aggMonth(ym);
  const prevMap = aggMonth(prevYm);
  const curTotal = [...curMap.values()].reduce((s, r) => s + r.total, 0);

  const tableRows: TypeTableRow[] = [...curMap.values()]
    .sort((a, b) => b.total - a.total)
    .map((r) => ({
      name: r.name,
      category: r.category,
      current: r.total,
      previous: prevMap.get(r.name)?.total ?? null,
      share: sharePct(r.total, curTotal),
    }));

  const donutRanked = [...curMap.values()].sort((a, b) => b.total - a.total);
  const otherSum = donutRanked.slice(topN).reduce((s, r) => s + r.total, 0);
  const donut = [
    ...donutRanked.slice(0, topN).map((r) => ({ name: r.name, value: r.total })),
    ...(otherSum > 0 ? [{ name: "Khác", value: otherSum }] : []),
  ];

  const uncat = curMap.get(UNCATEGORIZED_NAME)?.total ?? 0;

  return {
    topNames,
    hasOther,
    stacked,
    tableRows,
    donut,
    curTotal,
    uncategorizedPct: sharePct(uncat, curTotal),
  };
}

// ── Nhận định tự động ────────────────────────────────────────────────

export interface InsightInput {
  /** Tháng phân tích 'YYYY-MM'. */
  ym: string;
  /** Tổng thu/chi/LN theo tháng (đã gộp toà). */
  byMonth: Map<string, MonthAgg>;
  /** Lấp đầy % tháng chọn (trọng số phòng), null nếu chưa có dữ liệu. */
  occupancyPct: number | null;
  vacantRooms: number;
  vacancyLoss: number;
  /** Thu hồi hoá đơn của kỳ chọn (billed=0 → bỏ qua rule). */
  collection: { billed: number; collected: number } | null;
  agingOver90: number;
  /** LN từng toà tháng chọn (để soi toà lỗ — BỎ toà ảo "Chung" vì nó luôn âm). */
  buildingNets: { name: string; net: number; isVirtual: boolean }[];
  /** % giá trị thu/chi tháng chọn chưa gắn hạng mục (null = không có dữ liệu). */
  uncategorizedIncomePct: number | null;
  uncategorizedExpensePct: number | null;
}

/** Rule-based CFO commentary — thuần hàm để unit-test. */
export function buildInsights(input: InsightInput): Insight[] {
  const out: Insight[] = [];
  const cur = input.byMonth.get(input.ym);
  const prev = input.byMonth.get(shiftMonth(input.ym, -1));

  // 1. Lỗ / biên LN thấp
  if (cur && (cur.revenue > 0 || cur.expense > 0)) {
    if (cur.net < 0) {
      out.push({
        severity: "red",
        title: `Tháng này LỖ ${formatCurrency(Math.abs(cur.net))}`,
        detail: "Chi phí vượt doanh thu — rà soát Top khoản chi lớn ở tab Chi phí.",
      });
    } else {
      const m = marginPct(cur.net, cur.revenue);
      if (m != null && m < 20) {
        out.push({
          severity: "amber",
          title: `Biên lợi nhuận thấp (${fmtPct(m)})`,
          detail: "Dưới ngưỡng 20% — xem cơ cấu chi phí và tỷ lệ CP/DT ở tab Chi phí.",
        });
      }
    }
  }

  // 2. Lấp đầy
  if (input.occupancyPct != null && input.occupancyPct < 85) {
    out.push({
      severity: input.occupancyPct < 70 ? "red" : "amber",
      title: `Tỷ lệ lấp đầy ${fmtPct(input.occupancyPct)}`,
      detail: `${input.vacantRooms} phòng trống, thiệt hại ~${formatCurrency(input.vacancyLoss)}/tháng — đẩy marketing/Sale Phòng.`,
    });
  }

  // 3. Thu hồi hoá đơn kỳ chọn
  if (input.collection && input.collection.billed > 0) {
    const rate = collectionRate(input.collection.collected, input.collection.billed);
    if (rate != null && rate < 90) {
      out.push({
        severity: rate < 70 ? "red" : "amber",
        title: `Mới thu ${fmtPct(rate)} hoá đơn kỳ ${monthTitle(input.ym)}`,
        detail: "Đôn đốc thu tiền — xem chi tiết ở tab Vận hành (Thu hồi hoá đơn & Tuổi nợ).",
      });
    }
  }

  // 4. Nợ quá hạn > 90 ngày
  if (input.agingOver90 > 0) {
    out.push({
      severity: "red",
      title: `${formatCurrency(input.agingOver90)} nợ quá hạn trên 90 ngày`,
      detail: "Nguy cơ mất thu cao — ưu tiên xử lý nhóm nợ này trước.",
    });
  }

  // 5. Tỷ lệ CP/DT tăng 3 tháng liên tiếp
  const r3 = [shiftMonth(input.ym, -2), shiftMonth(input.ym, -1), input.ym].map((ym) => {
    const m = input.byMonth.get(ym);
    return m ? ratioPct(m.expense, m.revenue) : null;
  });
  if (r3.every((r) => r != null) && r3[0]! < r3[1]! && r3[1]! < r3[2]!) {
    out.push({
      severity: "amber",
      title: "Tỷ lệ chi phí/doanh thu tăng 3 tháng liên tiếp",
      detail: `${fmtPct(r3[0])} → ${fmtPct(r3[1])} → ${fmtPct(r3[2])} — kiểm soát lại chi phí.`,
    });
  }

  // 6. Toà thật lỗ trong tháng (loại "Chung" — toà ảo gom chi phí chung, luôn âm)
  const losers = input.buildingNets.filter((b) => !b.isVirtual && b.net < 0);
  if (losers.length > 0) {
    const names = losers.slice(0, 3).map((b) => b.name).join(", ");
    out.push({
      severity: "amber",
      title: `${losers.length} toà có lợi nhuận âm tháng này`,
      detail: `${names}${losers.length > 3 ? "…" : ""} — xem ma trận LN theo toà ở tab Lợi nhuận.`,
    });
  }

  // 7. Doanh thu giảm mạnh so tháng trước
  if (cur && prev && prev.revenue > 0) {
    const d = deltaPct(cur.revenue, prev.revenue);
    if (d != null && d <= -10) {
      out.push({
        severity: "amber",
        title: `Doanh thu giảm ${fmtPct(Math.abs(d))} so với tháng trước`,
        detail: "Xem tab Doanh thu để biết hạng mục/toà nào sụt giảm.",
      });
    }
  }

  // 8. Chất lượng dữ liệu: phiếu chưa gắn hạng mục
  const uncat = Math.max(input.uncategorizedIncomePct ?? 0, input.uncategorizedExpensePct ?? 0);
  if (uncat > 10) {
    out.push({
      severity: "amber",
      title: `${fmtPct(uncat)} giá trị phiếu chưa gắn hạng mục`,
      detail: "Bổ sung hạng mục khi lập phiếu thu chi để cơ cấu doanh thu/chi phí chính xác hơn.",
    });
  }

  if (out.length === 0) {
    out.push({
      severity: "green",
      title: "Các chỉ số trong ngưỡng an toàn",
      detail: "Lợi nhuận, lấp đầy, thu hồi công nợ đều ổn định — duy trì đà hiện tại.",
    });
  }
  return out;
}
