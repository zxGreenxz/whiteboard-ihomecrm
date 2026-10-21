import type { DoorKeyLink, DoorRecord, DoorUnlockType } from "./dto";

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
  source: "link" | "device" | "none";
  link: DoorKeyLink | null;
}

export function recordPerson(record: DoorRecord, links: ReadonlyMap<string, DoorKeyLink>): RecordPerson {
  if (isLinkableMethod(record.method) && typeof record.slot === "number" && Number.isInteger(record.slot)) {
    const link = links.get(keyOf(record.method, record.slot)) ?? null;
    if (link) return { name: linkDisplayName(link), detail: link.room_name, source: "link", link };
  }
  const deviceName = record.userName ?? record.unlockName;
  if (deviceName) return { name: deviceName, detail: null, source: "device", link: null };
  if (record.kind === "alarm" || record.kind === "doorbell") return { name: "—", detail: null, source: "none", link: null };
  return { name: "Chưa gắn", detail: null, source: "none", link: null };
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
