import type { DoorActionLog, DoorKeyLink, DoorRecord, DoorUnlockType } from "./dto";

/**
 * Lịch sử ra vào ↔ liên kết số trên máy (docs/he-thong/26 §Người dùng thấy gì: "người (tên khách
 * nếu số đã gắn, không thì tên trên máy)").
 */

export function keyOf(type: DoorUnlockType, sn: number): string {
  return `${type}:${sn}`;
}

/** Liên kết MỞ theo (loại, số). RPC chỉ trả liên kết đang mở; một số chỉ có một liên kết mở. */
export function indexLinks(links: readonly DoorKeyLink[]): Map<string, DoorKeyLink> {
  const index = new Map<string, DoorKeyLink>();
  for (const link of links) index.set(keyOf(link.unlock_type, link.unlock_sn), link);
  return index;
}

const LINKABLE: ReadonlySet<string> = new Set<DoorUnlockType>(["fingerprint", "card", "password"]);

export function isLinkableMethod(method: string): method is DoorUnlockType {
  return LINKABLE.has(method);
}

/** Tên hiển thị của một liên kết: khách (kèm phòng) hoặc nhãn. */
export function linkDisplayName(link: Pick<DoorKeyLink, "customer_name" | "label">): string {
  return link.customer_name ?? link.label ?? "Đã gắn";
}

export interface RecordPerson {
  /** Chữ chính ở cột Người. */
  name: string;
  /** Phòng (nếu có) — dòng phụ. */
  detail: string | null;
  /** temp = mật khẩu tạm tạo từ CRM (tên lấy từ nhật ký TEMP_PASSWORD_CREATE). */
  source: "link" | "temp" | "device" | "none";
  link: DoorKeyLink | null;
}

/**
 * Id mật khẩu tạm (Tuya, dạng chuỗi như DTO nhật ký) ⇒ tên đặt lúc tạo từ CRM. Không có nhật ký ⇒ không có tên
 * (mật khẩu tạo ngoài CRM, hoặc nhật ký chưa tải được).
 */
export function indexTempPasswordNames(
  logs: ReadonlyArray<Pick<DoorActionLog, "action" | "status" | "tuya_password_id" | "detail">>,
): Map<string, string> {
  const names = new Map<string, string>();
  for (const log of logs) {
    if (log.action !== "TEMP_PASSWORD_CREATE" || log.status !== "OK" || log.tuya_password_id === null) continue;
    const name = log.detail?.name;
    if (typeof name === "string" && name.trim() !== "") names.set(log.tuya_password_id, name.trim());
  }
  return names;
}

export function recordPerson(
  record: DoorRecord,
  links: ReadonlyMap<string, DoorKeyLink>,
  tempNames: ReadonlyMap<string, string> = new Map(),
): RecordPerson {
  if (isLinkableMethod(record.method) && typeof record.slot === "number" && Number.isInteger(record.slot)) {
    const link = links.get(keyOf(record.method, record.slot)) ?? null;
    if (link) return { name: linkDisplayName(link), detail: link.room_name, source: "link", link };
  }
  // Mật khẩu tạm: slot = id mật khẩu (Tuya). Tạo từ CRM thì có tên; không thì không có gì để "gắn".
  if (record.method === "temporary" && record.slot !== null) {
    const name = tempNames.get(String(record.slot));
    if (name) return { name, detail: null, source: "temp", link: null };
  }
  const deviceName = record.userName ?? record.unlockName;
  if (deviceName) return { name: deviceName, detail: null, source: "device", link: null };
  // "Chưa gắn" chỉ có nghĩa với số vân tay/thẻ/mật khẩu (gắn được với khách ở tab Đối chiếu).
  if (isLinkableMethod(record.method)) return { name: "Chưa gắn", detail: null, source: "none", link: null };
  return { name: "—", detail: null, source: "none", link: null };
}

/** Gộp các trang (Xem thêm) và bỏ bản ghi trùng id giữa hai trang. */
export function mergeRecordPages(pages: ReadonlyArray<{ records?: readonly DoorRecord[] }>): DoorRecord[] {
  const seen = new Set<string>();
  const out: DoorRecord[] = [];
  for (const page of pages) {
    for (const record of page.records ?? []) {
      if (seen.has(record.id)) continue;
      seen.add(record.id);
      out.push(record);
    }
  }
  return out;
}
