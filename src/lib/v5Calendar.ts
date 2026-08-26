// v5Calendar — MIRROR TS của SQL public.vn_workdays / public.v5_n_chuan
// (supabase/migrations/20260703000001_v5_foundation.sql).
// Quy tắc C10 (một calendar duy nhất cho TIỀN + SLA):
//   - Ngày-làm = T2–T7 (bỏ CN) trừ ngày lễ của owner.
//   - N_chuẩn(user, tháng) = COUNT(ngày-làm) − số-ngày-phép-đã-duyệt-của-người-đó.
//   - Đơn giá ngày = budget / N_chuẩn (KHÔNG hardcode 230.769 hay 26 — N thay đổi theo tháng).
// Sửa hàm này thì PHẢI sửa SQL tương ứng và chạy scripts/v5-calendar-parity.mjs.

/** yyyy-mm-dd (giờ VN — chuỗi lịch thuần, không dính timezone) */
export type IsoDate = string;

const pad = (n: number) => String(n).padStart(2, "0");

export function toIso(year: number, month1: number, day: number): IsoDate {
  return `${year}-${pad(month1)}-${pad(day)}`;
}

export function daysInMonth(year: number, month1: number): number {
  return new Date(Date.UTC(year, month1, 0)).getUTCDate();
}

/** 0 = CN … 6 = T7 (UTC-safe, chỉ phụ thuộc lịch) */
export function dayOfWeek(iso: IsoDate): number {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

/** Danh sách ngày-làm (T2–T7, bỏ CN và ngày lễ) của tháng — mirror vn_workdays(p_month) */
export function workdaysInMonth(year: number, month1: number, holidays: IsoDate[]): IsoDate[] {
  const hol = new Set(holidays);
  const out: IsoDate[] = [];
  const n = daysInMonth(year, month1);
  for (let d = 1; d <= n; d++) {
    const iso = toIso(year, month1, d);
    if (dayOfWeek(iso) === 0) continue; // CN
    if (hol.has(iso)) continue;
    out.push(iso);
  }
  return out;
}

/** N_chuẩn — mirror v5_n_chuan(p_month, p_user): ngày phép-duyệt là TRUNG TÍNH, loại khỏi mẫu số */
export function nChuan(
  year: number,
  month1: number,
  holidays: IsoDate[],
  approvedLeaveDates: IsoDate[],
): number {
  const wd = workdaysInMonth(year, month1, holidays);
  const wdSet = new Set(wd);
  // chỉ trừ ngày phép rơi ĐÚNG vào ngày-làm của tháng (phép trùng CN/lễ không trừ đôi)
  const leaves = new Set(approvedLeaveDates.filter((d) => wdSet.has(d)));
  return wd.length - leaves.size;
}

/** Đơn giá ngày-công (chưa làm tròn — làm tròn chỉ ở bước LOCK) */
export function dayRate(budgetVnd: number, n: number): number {
  if (n <= 0) return 0;
  return budgetVnd / n;
}

/** Tiền chuyên cần tạm-tính từ số ngày đã tick (chưa làm tròn) */
export function attendPay(budgetVnd: number, n: number, tickedDays: number): number {
  const capped = Math.min(Math.max(tickedDays, 0), n);
  return dayRate(budgetVnd, n) * capped;
}

/** Làm tròn VND về đồng — dùng DUY NHẤT tại bước LOCK/hiển thị chốt */
export function roundVnd(v: number): number {
  return Math.round(v);
}

/**
 * Cắt mốc streak cho tháng ngắn (C10): mốc giữ SỐ TUYỆT ĐỐI; mốc > N_chuẩn bị cắt
 * từ trên xuống, delta của mốc bị cắt DỒN vào mốc đích — tổng luôn = budget.
 *
 * V5.1: sentinel 'n_top' = ĐỈNH ĐỘNG tại N_chuẩn (thay 'full_month' từ kỳ 09/2026).
 * Delta cắt dồn vào n_top; n_top trùng một mốc số thì MERGE thành một mốc.
 * 'full_month' giữ nguyên hành vi cũ cho kỳ legacy. Mirror của SQL
 * public_v5_effective_milestones (migration 20260826120000) — sửa một phía
 * phải sửa phía kia.
 */
export function effectiveMilestones(
  milestones: (number | "full_month" | "n_top")[],
  deltas: number[],
  n: number,
): { milestone: number | "full_month" | "n_top"; at?: number; delta: number }[] {
  const items = milestones.map((m, i) => ({ milestone: m, delta: deltas[i] ?? 0 }));
  const topDelta = items.find((it) => it.milestone === "n_top")?.delta;
  const fmDelta = items.find((it) => it.milestone === "full_month")?.delta;
  const out: { milestone: number | "full_month" | "n_top"; at?: number; delta: number }[] = items
    .filter((it) => typeof it.milestone === "number" && it.milestone <= n)
    .map((it) => ({ milestone: it.milestone, at: it.milestone as number, delta: it.delta }));
  const cutSum = items
    .filter((it) => typeof it.milestone === "number" && it.milestone > n)
    .reduce((s, it) => s + it.delta, 0);
  if (topDelta !== undefined) {
    const same = out.find((it) => it.at === n);
    if (same) same.delta += topDelta + cutSum;
    else out.push({ milestone: "n_top", at: n, delta: topDelta + cutSum });
  } else if (fmDelta !== undefined) {
    out.push({ milestone: "full_month", delta: fmDelta + cutSum });
  } else if (cutSum > 0 && out.length > 0) {
    out[out.length - 1].delta += cutSum;
  }
  return out;
}
