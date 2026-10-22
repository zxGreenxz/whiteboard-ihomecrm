import type {
  DoorAction,
  DoorActionLog,
  DoorActionStatus,
  DoorDeviceKind,
  DoorMethod,
  DoorRecord,
  DoorTenancy,
  DoorUnlockType,
  TempPasswordPurpose,
} from "./dto";

/**
 * Giờ Việt Nam cố định UTC+7 (không có giờ mùa hè) — tính bằng phép cộng thay vì Intl để kết quả
 * không phụ thuộc múi giờ của máy đang chạy (máy nhân viên, máy CI).
 */
export const VN_OFFSET_MS = 7 * 60 * 60 * 1000;
export const DAY_MS = 24 * 60 * 60 * 1000;

const pad = (n: number) => String(n).padStart(2, "0");

function vnParts(ms: number) {
  const d = new Date(ms + VN_OFFSET_MS);
  return {
    year: d.getUTCFullYear(),
    month: d.getUTCMonth() + 1,
    day: d.getUTCDate(),
    hour: d.getUTCHours(),
    minute: d.getUTCMinutes(),
  };
}

/** "21/10 14:05" */
export function formatDayTime(ms: number): string {
  const p = vnParts(ms);
  return `${pad(p.day)}/${pad(p.month)} ${pad(p.hour)}:${pad(p.minute)}`;
}

/** "14:05 21/10" — dùng cho hiệu lực mật khẩu tạm. */
export function formatTimeDay(ms: number): string {
  const p = vnParts(ms);
  return `${pad(p.hour)}:${pad(p.minute)} ${pad(p.day)}/${pad(p.month)}`;
}

/** "2026-10-21" theo giờ Việt Nam. */
export function vnDate(ms: number): string {
  const p = vnParts(ms);
  return `${p.year}-${pad(p.month)}-${pad(p.day)}`;
}

/** "2026-10-21T14:05" theo giờ Việt Nam (giá trị cho ô datetime-local). */
export function vnDateTimeLocal(ms: number): string {
  const p = vnParts(ms);
  return `${vnDate(ms)}T${pad(p.hour)}:${pad(p.minute)}`;
}

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const DATE_TIME_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/;

/** 00:00 giờ Việt Nam của ngày "YYYY-MM-DD" ⇒ ms; sai dạng ⇒ null. */
export function vnDayStartMs(date: string): number | null {
  const m = DATE_RE.exec(date);
  if (!m) return null;
  const ms = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) - VN_OFFSET_MS;
  return vnDate(ms) === date ? ms : null;
}

/** Giá trị ô datetime-local, đọc là giờ Việt Nam ⇒ ms; sai dạng ⇒ null. */
export function parseVnDateTimeLocal(value: string): number | null {
  const m = DATE_TIME_RE.exec(value);
  if (!m) return null;
  const ms =
    Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6] ?? "0")) - VN_OFFSET_MS;
  return vnDateTimeLocal(ms) === value.slice(0, 16) ? ms : null;
}

/** "2026-12-31" ⇒ "31/12/2026"; sai dạng giữ nguyên. */
export function formatDateVn(date: string): string {
  const m = DATE_RE.exec(date);
  return m ? `${m[3]}/${m[2]}/${m[1]}` : date;
}

/** 23:59:00 hôm nay (giờ Việt Nam) ⇒ giây. */
export function vnEndOfTodaySec(nowMs: number): number {
  const start = vnDayStartMs(vnDate(nowMs));
  // vnDate luôn trả ngày hợp lệ nên start không null; giữ nhánh để kiểu chặt.
  const base = start ?? nowMs;
  return Math.floor((base + DAY_MS - 60_000) / 1000);
}

// ---------------------------------------------------------------------------------------------
// Nhãn

export const DEVICE_KIND_LABEL: Record<DoorDeviceKind, string> = {
  access_control: "Máy kiểm soát ra vào",
  wifi_lock: "Khoá Wi-Fi",
};

export const UNLOCK_TYPE_LABEL: Record<DoorUnlockType, string> = {
  fingerprint: "Vân tay",
  card: "Thẻ",
  password: "Mật khẩu",
};

export function unlockTypeLabel(type: DoorUnlockType, sn: number | null): string {
  return sn === null ? UNLOCK_TYPE_LABEL[type] : `${UNLOCK_TYPE_LABEL[type]} #${sn}`;
}

const METHOD_LABEL: Record<DoorMethod, string> = {
  fingerprint: "Vân tay",
  card: "Thẻ",
  password: "Mật khẩu",
  temporary: "Mật khẩu tạm",
  dynamic: "Mật khẩu động",
  app: "App",
  remote: "Từ xa",
  face: "Khuôn mặt",
  other: "Khác",
};

const NUMBERED: ReadonlySet<DoorMethod> = new Set<DoorMethod>(["fingerprint", "card", "password"]);

/** "Vân tay #12", "Thẻ #3", "Mật khẩu tạm", "App", "Từ xa", "Chuông", "Cảnh báo". */
export function recordMethodLabel(record: Pick<DoorRecord, "kind" | "method" | "slot" | "methodCode">): string {
  if (record.kind === "doorbell") return "Chuông";
  if (record.kind === "alarm") return "Cảnh báo";
  if (NUMBERED.has(record.method) && typeof record.slot === "number" && Number.isInteger(record.slot)) {
    return `${METHOD_LABEL[record.method]} #${record.slot}`;
  }
  if (record.method === "other" && record.methodCode) return record.methodCode;
  return METHOD_LABEL[record.method];
}

export const TENANCY_LABEL: Record<DoorTenancy, string> = {
  CURRENT: "Đang thuê",
  MOVED_OUT: "Đã trả phòng",
  NO_CONTRACT: "Không có HĐ ở tòa",
  STAFF: "Nhân viên",
};

export const PURPOSE_LABEL: Record<TempPasswordPurpose, string> = {
  XEM_PHONG: "Xem phòng",
  THO: "Thợ",
  KHACH: "Khách",
  KHAC: "Khác",
};

export function purposeLabel(value: unknown): string | null {
  return typeof value === "string" && value in PURPOSE_LABEL ? PURPOSE_LABEL[value as TempPasswordPurpose] : null;
}

export const ACTION_LABEL: Record<DoorAction, string> = {
  REMOTE_UNLOCK: "Mở cửa từ xa",
  TEMP_PASSWORD_CREATE: "Tạo mật khẩu tạm",
  TEMP_PASSWORD_DELETE: "Xoá mật khẩu tạm",
  KEY_DELETE: "Xoá trên máy",
  DEVICE_SAVE: "Lưu máy",
  DEVICE_DISABLE: "Tắt máy khỏi CRM",
  KEY_LINK: "Gắn số trên máy",
  KEY_UNLINK: "Bỏ gắn",
};

const isUnlockType = (value: unknown): value is DoorUnlockType =>
  value === "fingerprint" || value === "card" || value === "password";
const finiteNumber = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) ? value : null);

/** Tóm tắt `detail` của một dòng nhật ký — đọc phòng thủ, trường lạ thì bỏ qua (không bao giờ có mật khẩu). */
export function logDetailText(log: Pick<DoorActionLog, "action" | "detail" | "tuya_password_id">): string | null {
  const detail = log.detail ?? {};
  const parts: string[] = [];
  if (log.action === "TEMP_PASSWORD_CREATE") {
    if (typeof detail.name === "string" && detail.name) parts.push(`“${detail.name}”`);
    const purpose = purposeLabel(detail.purpose);
    if (purpose) parts.push(purpose);
    const from = finiteNumber(detail.effective_sec);
    const to = finiteNumber(detail.invalid_sec);
    if (from !== null && to !== null) parts.push(`${formatTimeDay(from * 1000)} → ${formatTimeDay(to * 1000)}`);
  } else if (log.action === "TEMP_PASSWORD_DELETE") {
    const id = detail.password_id ?? log.tuya_password_id;
    if (typeof id === "string" || typeof id === "number") parts.push(`mật khẩu #${id}`);
  } else if (log.action === "KEY_DELETE" || log.action === "KEY_LINK" || log.action === "KEY_UNLINK") {
    const sn = finiteNumber(detail.unlock_sn);
    if (isUnlockType(detail.unlock_type)) parts.push(unlockTypeLabel(detail.unlock_type, sn));
    if (typeof detail.customer_name === "string" && detail.customer_name) parts.push(detail.customer_name);
    else if (typeof detail.label === "string" && detail.label) parts.push(detail.label);
  }
  return parts.length > 0 ? parts.join(" · ") : null;
}

/** PENDING quá chừng này coi như chưa rõ kết quả (hàm Edge đã dừng mà chưa chốt). */
export const PENDING_STALE_MS = 2 * 60 * 1000;

export type LogStatusTone = "ok" | "failed" | "unknown" | "pending";

export function logStatus(log: Pick<DoorActionLog, "status" | "created_at">, nowMs: number): { label: string; tone: LogStatusTone } {
  const status: DoorActionStatus = log.status;
  if (status === "OK") return { label: "Thành công", tone: "ok" };
  if (status === "FAILED") return { label: "Thất bại", tone: "failed" };
  if (status === "UNKNOWN") return { label: "Chưa rõ kết quả", tone: "unknown" };
  const created = Date.parse(log.created_at);
  if (!Number.isFinite(created) || nowMs - created > PENDING_STALE_MS) return { label: "Chưa rõ kết quả", tone: "unknown" };
  return { label: "Đang chạy", tone: "pending" };
}

/**
 * Trạng thái gửi mật khẩu tạm xuống máy (`delivery_status` của Tuya). Tài liệu Tuya không nói rõ
 * từng mã — CHƯA kiểm trên máy thật; chỉ hiện gợi ý trung tính, đổi đúng một chỗ này khi đã đo.
 */
export function deliveryHint(status: number | null): string | null {
  if (status === null) return null;
  if (status === 1) return "Đang gửi xuống máy";
  if (status === 2) return "Đã gửi xuống máy";
  return `Trạng thái gửi: ${status}`;
}
