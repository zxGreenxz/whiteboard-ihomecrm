import type { DoorKeyLink, DoorKeysResult, DoorTenancy, DoorUnlockType } from "./dto";
import { indexLinks, isLinkableMethod, keyOf } from "./records";

/**
 * Màn Đối chiếu (chủ chốt 21/10 điểm 3–4): số vân tay/thẻ/mật khẩu TRÊN MÁY ↔ liên kết trong CRM.
 *
 * - Mỗi số trên máy là một dòng (của người dùng trên máy hoặc "chưa gán người"), ghép liên kết
 *   theo (loại, số).
 * - Liên kết mà số không còn trên máy ⇒ dòng "Không còn trên máy" (gợi ý Bỏ gắn). Nếu máy trả
 *   danh sách CHƯA ĐỦ (`partial`) thì không kết luận được điều đó — dòng vẫn hiện nhưng đánh dấu.
 * - "Cần xoá" = liên kết khách ĐÃ TRẢ PHÒNG mà số vẫn còn trên máy. CRM không tự xoá.
 */

export type ReconcileState = DoorTenancy | "UNLINKED";

export interface ReconcileRow {
  key: string;
  unlockType: DoorUnlockType;
  sn: number;
  /** Tên của số trên máy (vd "Ngón trỏ"), nếu máy có. */
  keyName: string | null;
  /** Tên người dùng trên máy sở hữu số này. */
  deviceUserName: string | null;
  /** Người dùng trên máy — cần để xoá (`delete_key`). Số chưa gán người ⇒ null. */
  tuyaUserId: string | null;
  onDevice: boolean;
  link: DoorKeyLink | null;
  state: ReconcileState;
  needsDelete: boolean;
  goneFromDevice: boolean;
}

export interface ReconcileResult {
  rows: ReconcileRow[];
  needsDelete: ReconcileRow[];
  gone: ReconcileRow[];
  unlinked: number;
  /** Máy trả danh sách chưa đủ ⇒ "không còn trên máy" chưa chắc đúng. */
  partial: boolean;
}

const TYPE_ORDER: Record<DoorUnlockType, number> = { fingerprint: 0, card: 1, password: 2 };

function rowFor(
  unlockType: DoorUnlockType,
  sn: number,
  fields: { keyName: string | null; deviceUserName: string | null; tuyaUserId: string | null; onDevice: boolean },
  link: DoorKeyLink | null,
): ReconcileRow {
  const state: ReconcileState = link ? link.tenancy : "UNLINKED";
  return {
    key: keyOf(unlockType, sn),
    unlockType,
    sn,
    ...fields,
    link,
    state,
    needsDelete: fields.onDevice && state === "MOVED_OUT",
    goneFromDevice: !fields.onDevice && link !== null,
  };
}

const validSn = (sn: number | null): sn is number => sn !== null && Number.isInteger(sn) && sn >= 0;

export function reconcileKeys(keys: DoorKeysResult, links: readonly DoorKeyLink[]): ReconcileResult {
  const linkIndex = indexLinks(links);
  const rows = new Map<string, ReconcileRow>();

  for (const user of keys.users) {
    for (const method of user.methods) {
      if (!isLinkableMethod(method.method) || !validSn(method.sn)) continue;
      const key = keyOf(method.method, method.sn);
      if (rows.has(key)) continue;
      rows.set(
        key,
        rowFor(
          method.method,
          method.sn,
          { keyName: method.name, deviceUserName: user.name, tuyaUserId: user.userId, onDevice: true },
          linkIndex.get(key) ?? null,
        ),
      );
    }
  }
  for (const item of keys.unassigned) {
    if (!isLinkableMethod(item.method) || !validSn(item.sn)) continue;
    const key = keyOf(item.method, item.sn);
    if (rows.has(key)) continue;
    rows.set(
      key,
      rowFor(item.method, item.sn, { keyName: null, deviceUserName: null, tuyaUserId: null, onDevice: true }, linkIndex.get(key) ?? null),
    );
  }
  for (const link of links) {
    const key = keyOf(link.unlock_type, link.unlock_sn);
    if (rows.has(key)) continue;
    rows.set(
      key,
      rowFor(
        link.unlock_type,
        link.unlock_sn,
        { keyName: null, deviceUserName: link.device_user_name, tuyaUserId: link.tuya_user_id, onDevice: false },
        link,
      ),
    );
  }

  const sorted = [...rows.values()].sort(
    (a, b) => TYPE_ORDER[a.unlockType] - TYPE_ORDER[b.unlockType] || a.sn - b.sn,
  );
  return {
    rows: sorted,
    needsDelete: sorted.filter((row) => row.needsDelete),
    gone: sorted.filter((row) => row.goneFromDevice),
    unlinked: sorted.filter((row) => row.onDevice && row.link === null).length,
    partial: keys.partial,
  };
}
