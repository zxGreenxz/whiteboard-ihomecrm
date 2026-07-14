/**
 * Nhãn "lý do trống phòng" cho cột Khoản thu (trang Phân bổ lợi nhuận).
 *
 * Một phòng trống trong tháng vì khách rời đi qua 1 trong các sự kiện:
 *  - Bỏ cọc (contract_terminations.termination_type = 'FORFEIT')
 *  - Thanh lý HĐ (các termination_type còn lại: move-out/normal/early/breach)
 *  - Chuyển phòng (contract_transfers ROOM_CHANGE — phòng cũ được rời)
 *  - Sang nhượng (contract_transfers TENANT_CHANGE / BOTH_CHANGE)
 *  - Hết hạn HĐ (HĐ đã EXPIRED, không có termination/transfer)
 * Không suy được nguồn → "Trống phòng".
 */

/** termination_type → nhãn; loại không liệt kê → "Thanh lý HĐ". */
export const TERMINATION_LABEL: Record<string, string> = {
  FORFEIT: "Bỏ cọc",
};

/** transfer_type (phía phòng bị rời) → nhãn. */
export const TRANSFER_LABEL: Record<string, string> = {
  ROOM_CHANGE: "Chuyển phòng",
  TENANT_CHANGE: "Sang nhượng",
  BOTH_CHANGE: "Sang nhượng",
};

/** Nhãn mặc định khi không suy được nguồn trống phòng. */
export const VACANCY_FALLBACK_REASON = "Trống phòng";

export type VacancyEventKind = "termination" | "transfer" | "expired";

export interface VacancyEvent {
  /** Ngày sự kiện 'YYYY-MM-DD' (để chọn sự kiện mới nhất ≤ cuối tháng). */
  date: string | null;
  kind: VacancyEventKind;
  /** termination_type hoặc transfer_type tương ứng. */
  type?: string | null;
}

/** Tie-break khi cùng ngày: termination thắng transfer thắng expired. */
const kindPriority = (k: VacancyEventKind): number =>
  k === "termination" ? 0 : k === "transfer" ? 1 : 2;

/** Nhãn lý do cho 1 sự kiện đơn lẻ. */
export function labelForVacancyEvent(ev: VacancyEvent): string {
  if (ev.kind === "termination") {
    return TERMINATION_LABEL[ev.type ?? ""] ?? "Thanh lý HĐ";
  }
  if (ev.kind === "transfer") {
    return TRANSFER_LABEL[ev.type ?? ""] ?? "Sang nhượng";
  }
  return "Hết hạn HĐ";
}

export interface VacancyInfo {
  reason: string;
  /** Ngày khách rời phòng 'YYYY-MM-DD' — bắt đầu trống (null nếu không suy được). */
  since: string | null;
}

/**
 * Chọn sự kiện MỚI NHẤT (ngày lớn nhất; tie-break theo `kindPriority`) rồi suy
 * nhãn + ngày bắt đầu trống. Mảng rỗng → "Trống phòng"/null. Ngày dạng
 * 'YYYY-MM-DD' so sánh từ vựng = theo thời gian.
 */
export function resolveVacancyInfo(events: VacancyEvent[]): VacancyInfo {
  let best: VacancyEvent | null = null;
  for (const ev of events) {
    if (!best) {
      best = ev;
      continue;
    }
    const a = ev.date ?? "";
    const b = best.date ?? "";
    if (a > b || (a === b && kindPriority(ev.kind) < kindPriority(best.kind))) {
      best = ev;
    }
  }
  return best
    ? { reason: labelForVacancyEvent(best), since: best.date ?? null }
    : { reason: VACANCY_FALLBACK_REASON, since: null };
}

/** Như `resolveVacancyInfo` nhưng chỉ trả nhãn lý do. */
export function resolveVacancyReason(events: VacancyEvent[]): string {
  return resolveVacancyInfo(events).reason;
}

/**
 * Chuỗi ghi chú phòng trống: "Trống 12 ngày từ 02/07 — Bỏ cọc".
 * `refDate` = mốc đếm 'YYYY-MM-DD' (min(hôm nay, cuối tháng báo cáo) — tháng cũ
 * chốt theo cuối tháng, tháng hiện tại đếm tới hôm nay). Không có ngày rời →
 * giữ dạng cũ "Trống phòng — <lý do>".
 */
export function vacancyNoteText(
  reason: string | null | undefined,
  since: string | null | undefined,
  refDate: string,
): string {
  const suffix = reason && reason !== VACANCY_FALLBACK_REASON ? ` — ${reason}` : "";
  if (!since || since > refDate) return `Trống phòng${suffix}`;
  // 'YYYY-MM-DD' parse thành mốc UTC-midnight cả 2 vế → hiệu chia hết cho ngày.
  const days = Math.round((Date.parse(refDate) - Date.parse(since)) / 86_400_000);
  const [y, m, d] = since.split("-");
  const dm = refDate.slice(0, 4) === y ? `${d}/${m}` : `${d}/${m}/${y}`;
  return days > 0
    ? `Trống ${days} ngày từ ${dm}${suffix}`
    : `Trống từ ${dm}${suffix}`;
}
