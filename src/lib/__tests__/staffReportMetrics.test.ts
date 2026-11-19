import { describe, expect, it } from "vitest";
import type { StaffMetrics, StaffReportMember } from "@/lib/staffDay";
import { METRICS, gpsRate, metricBars, periodTotals, reportSheetRows, type MetricDef } from "@/lib/staffReportMetrics";

const base: StaffMetrics = {
  ticked_days: 20, n_chuan: 25, best_streak: 10, breaks_no_leave: 0, leave_days: 1, full_passed: 10, full_presence: 0,
  full_expired: 0, avg_dwell_seconds: 900, photos_total: 50, photos_out_of_range: 0, photos_gps_denied: 0,
  jobs_total: 10, jobs_on_time: 9, payments_total: 30, payments_gps_ok: 0,
  gps_ok: 0, gps_stationary: 0, gps_missing: 0, gps_paused: 0, gps_mock: 0, flagged: 0,
};
const member = (name: string, metrics: Partial<StaffMetrics> = {}, overdue = { buildings: 0, times: 0 }): StaffReportMember => ({
  user: { id: name, name },
  metrics: { ...base, ...metrics },
  overdue: { ...overdue, items: [] },
  days: [],
  review: null,
});
const def = (key: string): MetricDef => {
  const found = METRICS.find((m) => m.key === key);
  if (!found) throw new Error(key);
  return found;
};

describe("chỉ số báo cáo", () => {
  it("có đủ 12 chỉ số, không chỉ số nào quy ra tiền", () => {
    expect(METRICS).toHaveLength(12);
    expect(METRICS.map((m) => m.label).join(" ")).not.toMatch(/đồng|lương|thưởng/i);
  });

  it("chỉ số càng ít càng tốt: người ít nhất là tốt nhất", () => {
    const bars = metricBars(def("overdue"), [member("A", {}, { buildings: 1, times: 2 }), member("B", {}, { buildings: 4, times: 9 })]);
    expect(bars[0]?.tone).toBe("good");
    expect(bars[1]?.tone).toBe("bad");
    expect(bars[0]!.pct).toBeGreaterThan(bars[1]!.pct);
  });

  it("chỉ số càng nhiều càng tốt so tương đối với người cao nhất", () => {
    const bars = metricBars(def("full"), [member("A", { full_passed: 20 }), member("B", { full_passed: 10 })]);
    expect(bars.map((b) => b.pct)).toEqual([100, 50]);
    expect(bars[1]?.tone).toBe("bad");
  });

  it("chỉ số trung tính không tô đỏ ai", () => {
    const bars = metricBars(def("leave"), [member("A", { leave_days: 0 }), member("B", { leave_days: 5 })]);
    expect(bars.every((b) => b.tone === "neutral")).toBe(true);
  });

  it("không có dữ liệu thì không vẽ thanh, không coi là 0", () => {
    const m = member("A", { best_streak: null });
    expect(def("streak").value(m)).toBe("—");
    expect(metricBars(def("streak"), [m])[0]).toEqual({ pct: 0, tone: "neutral" });
    expect(def("gps").value(m)).toBe("—");
    expect(gpsRate(m)).toBeNull();
  });

  it("thu tiền chỉ nêu GPS khi phiếu thật sự có GPS", () => {
    expect(def("payments").value(member("A"))).toBe("30");
    expect(def("payments").value(member("A", { payments_gps_ok: 5 }))).toBe("30 · 5 GPS khớp");
  });

  it("tỉ lệ điểm danh tính cả mốc đứng yên, bỏ qua mốc đã tắt", () => {
    expect(gpsRate(member("A", { gps_ok: 6, gps_stationary: 2, gps_missing: 2, gps_paused: 5 }))).toBe(0.8);
    const gpsMetric = METRICS.find((metric) => metric.key === "gps");
    expect(gpsMetric?.value(member("A", { gps_ok: 8, gps_missing: 2 }))).toBe("80%");
    expect(gpsMetric?.value(member("A", { gps_ok: 8, gps_missing: 2, gps_mock: 3 }))).toBe("80% · 3 nghi giả");
  });

  it("cộng tổng kỳ", () => {
    const totals = periodTotals([
      member("A", { ticked_days: 20, n_chuan: 25, jobs_total: 10, jobs_on_time: 8 }, { buildings: 1, times: 2 }),
      member("B", { ticked_days: 25, n_chuan: 25, jobs_total: 4, jobs_on_time: 4 }, { buildings: 2, times: 3 }),
    ]);
    expect(totals).toMatchObject({ attendance: 0.9, overdueBuildings: 3, overdueTimes: 5, jobsLate: 2, gps: null });
  });

  it("bảng Excel có đủ cột người và nhận xét", () => {
    const m = { ...member("QUẢN LÝ A"), review: { rating: "A" as const, note: "Tốt", updated_at: "2026-11-01T00:00:00Z" } };
    const rows = reportSheetRows([m]);
    expect(rows[0]).toEqual(["Chỉ số", "Ghi chú", "QUẢN LÝ A"]);
    expect(rows.at(-2)).toEqual(["Xếp loại của chủ", "A/B/C", "A"]);
    expect(rows.at(-1)).toEqual(["Nhận xét của chủ", "", "Tốt"]);
  });
});
