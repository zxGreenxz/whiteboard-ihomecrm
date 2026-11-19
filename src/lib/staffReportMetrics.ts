// Chỉ số của báo cáo đánh giá theo kỳ. Đặt các con số cạnh nhau để chủ tự đánh giá:
// không có điểm tổng, không quy ra tiền.
import type { StaffReportMember } from "@/lib/staffDay";

export interface MetricDef {
  key: string;
  label: string;
  sub: string;
  value: (member: StaffReportMember) => string;
  /** null = không có dữ liệu để so. */
  score: (member: StaffReportMember) => number | null;
  lowerIsBetter?: boolean;
  neutral?: boolean;
}

export type BarTone = "good" | "warn" | "bad" | "neutral";
export interface MetricBar { pct: number; tone: BarTone }

export function gpsRate(member: StaffReportMember): number | null {
  const { gps_ok: ok, gps_stationary: still, gps_missing: missing } = member.metrics;
  const total = ok + still + missing;
  return total > 0 ? (ok + still) / total : null;
}

const percent = (ratio: number | null): string => (ratio == null ? "—" : `${Math.round(ratio * 100)}%`);
const ratioOf = (a: number, b: number): number | null => (b > 0 ? a / b : null);

export const METRICS: readonly MetricDef[] = [
  {
    key: "days", label: "Ngày công / ngày chuẩn", sub: "tick theo máy chủ",
    value: (m) => `${m.metrics.ticked_days}/${m.metrics.n_chuan}`,
    score: (m) => ratioOf(m.metrics.ticked_days, m.metrics.n_chuan),
  },
  {
    key: "streak", label: "Chuỗi tốt nhất", sub: "ngày liên tục · chỉ kỳ tháng",
    value: (m) => m.metrics.best_streak == null ? "—" : String(m.metrics.best_streak),
    score: (m) => m.metrics.best_streak,
  },
  {
    key: "breaks", label: "Đứt chuỗi không phép", sub: "số lần · chỉ kỳ tháng",
    value: (m) => m.metrics.breaks_no_leave == null ? "—" : String(m.metrics.breaks_no_leave),
    score: (m) => m.metrics.breaks_no_leave, lowerIsBetter: true,
  },
  {
    key: "leave", label: "Phép đã dùng", sub: "ngày trung tính",
    value: (m) => String(m.metrics.leave_days), score: (m) => m.metrics.leave_days, neutral: true,
  },
  {
    key: "full", label: "FULL đạt · có mặt · hết giờ", sub: "phiên kiểm tra nhà",
    value: (m) => `${m.metrics.full_passed} · ${m.metrics.full_presence} · ${m.metrics.full_expired}`,
    score: (m) => m.metrics.full_passed,
  },
  {
    key: "dwell", label: "Thời gian ở toà TB", sub: "phiên FULL đạt",
    value: (m) => m.metrics.avg_dwell_seconds == null ? "—" : `${Math.round(m.metrics.avg_dwell_seconds / 60)} phút`,
    score: (m) => m.metrics.avg_dwell_seconds, neutral: true,
  },
  {
    key: "photos", label: "Ảnh ngoài vùng / thiếu GPS", sub: "càng ít càng tốt",
    value: (m) => String(m.metrics.photos_out_of_range + m.metrics.photos_gps_denied),
    score: (m) => m.metrics.photos_out_of_range + m.metrics.photos_gps_denied, lowerIsBetter: true,
  },
  {
    key: "overdue", label: "Toà quá hạn ghé", sub: "số toà · số lần",
    value: (m) => `${m.overdue.buildings} · ${m.overdue.times}`,
    score: (m) => m.overdue.times, lowerIsBetter: true,
  },
  {
    key: "jobs", label: "Việc đúng hạn / tổng", sub: "công việc được giao",
    value: (m) => `${m.metrics.jobs_on_time}/${m.metrics.jobs_total}`,
    score: (m) => ratioOf(m.metrics.jobs_on_time, m.metrics.jobs_total),
  },
  {
    key: "payments", label: "Lượt thu tiền", sub: "phiếu thu trong kỳ",
    value: (m) => m.metrics.payments_gps_ok > 0
      ? `${m.metrics.payments_total} · ${m.metrics.payments_gps_ok} GPS khớp`
      : String(m.metrics.payments_total),
    score: (m) => m.metrics.payments_total, neutral: true,
  },
  {
    key: "gps", label: "Điểm danh tự động", sub: "% mốc có dấu GPS",
    value: (m) => m.metrics.gps_mock > 0 ? `${percent(gpsRate(m))} · ${m.metrics.gps_mock} nghi giả` : percent(gpsRate(m)),
    score: gpsRate,
  },
  {
    key: "flagged", label: "Nghi án", sub: "ngày công bị máy đánh dấu",
    value: (m) => String(m.metrics.flagged), score: (m) => m.metrics.flagged, lowerIsBetter: true,
  },
];

/** Độ dài và màu thanh so sánh, tính tương đối giữa những người đang so. */
export function metricBars(def: MetricDef, members: readonly StaffReportMember[]): MetricBar[] {
  const scores = members.map((member) => def.score(member));
  const known = scores.filter((score): score is number => score != null);
  if (known.length === 0) return scores.map(() => ({ pct: 0, tone: "neutral" }));

  if (def.lowerIsBetter) {
    const worst = Math.max(...known);
    const best = Math.min(...known);
    return scores.map((score) => {
      if (score == null) return { pct: 0, tone: "neutral" };
      const pct = worst === 0 ? 100 : Math.round(((worst - score) / worst) * 80 + 20);
      const tone: BarTone = score === best ? "good" : score <= best + Math.max(1, best * 0.5) ? "warn" : "bad";
      return { pct, tone };
    });
  }

  const max = Math.max(...known);
  return scores.map((score) => {
    if (score == null) return { pct: 0, tone: "neutral" };
    const pct = max > 0 ? Math.round((score / max) * 100) : 0;
    if (def.neutral) return { pct, tone: "neutral" };
    return { pct, tone: pct >= 90 ? "good" : pct >= 60 ? "warn" : "bad" };
  });
}

export interface PeriodTotals {
  attendance: number | null;
  overdueBuildings: number;
  overdueTimes: number;
  jobsLate: number;
  gps: number | null;
}

export function periodTotals(members: readonly StaffReportMember[]): PeriodTotals {
  const sum = (pick: (m: StaffReportMember) => number) => members.reduce((total, member) => total + pick(member), 0);
  const gpsGot = sum((m) => m.metrics.gps_ok + m.metrics.gps_stationary);
  const gpsAll = gpsGot + sum((m) => m.metrics.gps_missing);
  return {
    attendance: ratioOf(sum((m) => m.metrics.ticked_days), sum((m) => m.metrics.n_chuan)),
    overdueBuildings: sum((m) => m.overdue.buildings),
    overdueTimes: sum((m) => m.overdue.times),
    jobsLate: sum((m) => m.metrics.jobs_total - m.metrics.jobs_on_time),
    gps: ratioOf(gpsGot, gpsAll),
  };
}

export function reportSheetRows(members: readonly StaffReportMember[]): string[][] {
  return [
    ["Chỉ số", "Ghi chú", ...members.map((member) => member.user.name)],
    ...METRICS.map((def) => [def.label, def.sub, ...members.map((member) => def.value(member))]),
    ["Xếp loại của chủ", "A/B/C", ...members.map((member) => member.review?.rating ?? "")],
    ["Nhận xét của chủ", "", ...members.map((member) => member.review?.note ?? "")],
  ];
}
