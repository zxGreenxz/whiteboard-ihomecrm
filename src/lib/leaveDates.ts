// Ngày nghỉ phép — khoảng ngày của một đơn, nhãn hiển thị, gom các ngày chờ duyệt thành đơn.
// Khớp luật máy chủ request_paid_leave_range / approve_leave_batch (migration 20261119020927): Chủ nhật không tính,
// ngày lễ của công ty cũng không (máy chủ đọc vn_workdays; màn hình đọc cùng RPC để xem trước — leaveWorkDays ở đây chỉ
// bỏ Chủ nhật), một đơn tối đa 31 ngày lịch. Ngày là chuỗi ISO "YYYY-MM-DD" theo lịch Việt Nam; tính bằng UTC để không
// lệch múi giờ.
import { z } from "zod";

export const MAX_LEAVE_RANGE_DAYS = 31;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 86_400_000;
/** Chặn vòng lặp khi người dùng gõ năm rất xa: quá mức này coi như không có ngày nào để liệt kê. */
const MAX_SCAN_DAYS = 400;

function toUtc(iso: string): number {
  const [y, m, d] = iso.split("-").map(Number);
  return Date.UTC(y ?? 0, (m ?? 1) - 1, d ?? 1);
}

/** Số ngày lịch từ `from` đến `to`, tính cả hai đầu; `to` trước `from` ⇒ 0. */
export function calendarDaysBetween(from: string, to: string): number {
  if (!ISO_DATE.test(from) || !ISO_DATE.test(to)) return 0;
  return Math.max(0, Math.round((toUtc(to) - toUtc(from)) / DAY_MS) + 1);
}

/** Ngày làm việc (bỏ Chủ nhật) từ `from` đến `to`, tăng dần. Sai dạng, `to` trước `from` hoặc khoảng quá dài ⇒ []. */
export function leaveWorkDays(from: string, to: string): string[] {
  const span = calendarDaysBetween(from, to);
  if (span === 0 || span > MAX_SCAN_DAYS) return [];
  const out: string[] = [];
  for (let i = 0, t = toUtc(from); i < span; i++, t += DAY_MS) {
    const day = new Date(t);
    if (day.getUTCDay() !== 0) out.push(day.toISOString().slice(0, 10));
  }
  return out;
}

/**
 * Các tháng ("YYYY-MM-01") mà khoảng [from, to] chạm tới — để đọc lịch ngày làm (vn_workdays) của đúng các tháng đó.
 * Khoảng sai hoặc dài quá một đơn ⇒ [] (không đọc lịch cho khoảng không gửi được).
 */
export function leaveMonths(from: string, to: string): string[] {
  const span = calendarDaysBetween(from, to);
  if (span === 0 || span > MAX_LEAVE_RANGE_DAYS) return [];
  const months = new Set<string>();
  for (let i = 0, t = toUtc(from); i < span; i++, t += DAY_MS) months.add(`${new Date(t).toISOString().slice(0, 7)}-01`);
  return [...months];
}

const dm = (iso: string) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}`;
const dmy = (iso: string) => `${dm(iso)}/${iso.slice(0, 4)}`;

/** Khoảng ngày để ghép vào câu: "20/11/2026" · "20/11 → 23/11" (liền nhau, chỉ cách Chủ nhật) · "20/11, 24/11". */
export function leaveDateSpan(dates: readonly string[]): string {
  const sorted = [...new Set(dates)].sort();
  const first = sorted[0];
  const last = sorted[sorted.length - 1];
  if (first === undefined || last === undefined) return "";
  if (sorted.length === 1) return dmy(first);
  if (leaveWorkDays(first, last).length === sorted.length) return `${dm(first)} → ${dm(last)}`;
  return sorted.map(dm).join(", ");
}

/** Nhãn một đơn: "ngày 20/11/2026" · "3 ngày: 20/11 → 23/11". */
export function leaveDaysLabel(dates: readonly string[]): string {
  const count = new Set(dates).size;
  return count === 1 ? `ngày ${leaveDateSpan(dates)}` : `${count} ngày: ${leaveDateSpan(dates)}`;
}

export interface PendingLeaveDay {
  user_id: string;
  work_date: string;
  reason: string | null;
  requested_at: string | null;
  staff_name: string;
  /** Mã đơn nhiều ngày (evidence.batch); null với đơn một ngày gửi theo đường cũ. */
  batch: string | null;
}

export interface PendingLeaveGroup {
  key: string;
  user_id: string;
  staff_name: string;
  dates: string[];
  reason: string | null;
  requested_at: string | null;
}

/**
 * Gom các ngày chờ duyệt cùng một đơn (cùng người + cùng mã đơn). Ngày không có mã đơn (đơn một ngày) là một nhóm riêng.
 * Ngày của đơn đã được duyệt lẻ một phần ở Bảng lương thì nhóm chỉ còn các ngày đang chờ. Sắp theo ngày đầu rồi tên.
 */
export function groupPendingLeaves(rows: readonly PendingLeaveDay[]): PendingLeaveGroup[] {
  const groups = new Map<string, PendingLeaveGroup>();
  for (const row of rows) {
    const key = row.batch ? `${row.user_id}|${row.batch}` : `${row.user_id}|${row.work_date}`;
    const group = groups.get(key);
    if (group) {
      if (!group.dates.includes(row.work_date)) group.dates.push(row.work_date);
    } else {
      groups.set(key, { key, user_id: row.user_id, staff_name: row.staff_name, dates: [row.work_date], reason: row.reason, requested_at: row.requested_at });
    }
  }
  return [...groups.values()]
    .map((group) => ({ ...group, dates: [...group.dates].sort() }))
    .sort((a, b) => (a.dates[0] ?? "").localeCompare(b.dates[0] ?? "") || a.staff_name.localeCompare(b.staff_name, "vi"));
}

/** Biểu mẫu xin nghỉ: `to` rỗng = nghỉ một ngày `from`. `today` là ngày hôm nay theo máy chủ (get_my_day_summary). */
export function leaveRequestSchema(today: string) {
  return z.object({
    from: z.string().regex(ISO_DATE, "Chọn ngày bắt đầu nghỉ."),
    to: z.string(),
    reason: z.string().max(500, "Lý do tối đa 500 ký tự."),
  }).superRefine((value, ctx) => {
    if (!ISO_DATE.test(value.from)) return;
    if (value.from < today) ctx.addIssue({ code: "custom", path: ["from"], message: "Chọn hôm nay hoặc ngày sau đó." });
    const to = value.to || value.from;
    if (!ISO_DATE.test(to)) {
      ctx.addIssue({ code: "custom", path: ["to"], message: "Ngày kết thúc chưa hợp lệ." });
    } else if (to < value.from) {
      ctx.addIssue({ code: "custom", path: ["to"], message: "Ngày kết thúc phải bằng hoặc sau ngày bắt đầu." });
    } else if (calendarDaysBetween(value.from, to) > MAX_LEAVE_RANGE_DAYS) {
      ctx.addIssue({ code: "custom", path: ["to"], message: `Mỗi đơn tối đa ${MAX_LEAVE_RANGE_DAYS} ngày — chia thành nhiều đơn.` });
    } else if (leaveWorkDays(value.from, to).length === 0) {
      ctx.addIssue({ code: "custom", path: ["to"], message: "Chủ nhật đã là ngày nghỉ — không cần xin phép." });
    }
  });
}
export type LeaveRequestValues = z.infer<ReturnType<typeof leaveRequestSchema>>;
