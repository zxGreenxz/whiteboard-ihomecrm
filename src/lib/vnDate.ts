// Ngày theo GIỜ VIỆT NAM + số học ngày trên chuỗi "YYYY-MM-DD".
//
// Vì sao không dùng `todayISO()` của `collect.ts`: hàm đó đọc giờ MÁY. CI chạy
// UTC còn dữ liệu ở UTC+7, nên trong khoảng 00:00–07:00 giờ VN nó trả về NGÀY
// HÔM QUA — đủ để một phiếu đang đúng hạn bị xếp vào "quá hạn". Cùng lớp lỗi đã
// làm màn lương mặc định về kỳ trước (audit 2026-07-20), thứ sinh ra `vnYmOf`.
//
// `diffDaysISO` cố ý làm việc trên CHUỖI chứ không parse về `Date` local: hiệu
// hai mốc ngày là số học lịch, không dính múi giờ, nên nó cho cùng kết quả ở
// mọi máy — điều kiện của gate `check-timezone-stability`.

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})/;

/** Hôm nay theo giờ VN, dạng "YYYY-MM-DD". */
export function vnTodayISO(now: Date = new Date()): string {
  // en-CA cho ra đúng "YYYY-MM-DD".
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Ho_Chi_Minh",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

/** "2026-08-21" → số ngày kể từ epoch (UTC), null nếu chuỗi không hợp lệ. */
function toEpochDay(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const m = ISO_DATE.exec(iso);
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  const ms = Date.UTC(y, mo - 1, d);
  if (Number.isNaN(ms)) return null;
  // Ngày không tồn tại (31/02) bị Date.UTC cuộn sang tháng sau ⇒ từ chối.
  const back = new Date(ms);
  if (back.getUTCFullYear() !== y || back.getUTCMonth() !== mo - 1 || back.getUTCDate() !== d) {
    return null;
  }
  return Math.round(ms / 86_400_000);
}

/**
 * `a − b` theo NGÀY. `diffDaysISO("2026-08-25", "2026-08-21") === 4`.
 * Trả null nếu một trong hai mốc thiếu/không hợp lệ.
 */
export function diffDaysISO(
  a: string | null | undefined,
  b: string | null | undefined,
): number | null {
  const da = toEpochDay(a);
  const db = toEpochDay(b);
  if (da === null || db === null) return null;
  return da - db;
}

/** Cộng `days` ngày vào một mốc "YYYY-MM-DD". null nếu mốc không hợp lệ. */
export function addDaysISO(iso: string | null | undefined, days: number): string | null {
  const base = toEpochDay(iso);
  if (base === null || !Number.isFinite(days)) return null;
  const d = new Date((base + Math.trunc(days)) * 86_400_000);
  const y = d.getUTCFullYear();
  const mo = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${mo}-${dd}`;
}

/** "2026-08-21" → "21/08/2026". Chuỗi lạ trả nguyên văn. */
export function formatISODateVN(iso: string | null | undefined): string {
  if (!iso) return "—";
  const m = ISO_DATE.exec(iso);
  return m ? `${m[3]}/${m[2]}/${m[1]}` : iso;
}

/** "2026-08-21" → "21/08" (dùng cho thẻ hẹp trên mobile). */
export function formatISODayMonth(iso: string | null | undefined): string {
  if (!iso) return "—";
  const m = ISO_DATE.exec(iso);
  return m ? `${m[3]}/${m[2]}` : iso;
}
