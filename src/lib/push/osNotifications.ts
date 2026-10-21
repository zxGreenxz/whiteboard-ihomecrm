// =============================================================
// Thông báo HỆ ĐIỀU HÀNH + số trên icon app — dọn theo trạng thái đã đọc.
// (21/10/2026, plan realtime + thông báo, mục C5.)
//
// Trước đây đọc trong app không đóng gì trên màn khoá: cùng một sự kiện đã xử lý
// trong chuông, sáng hôm sau điện thoại vẫn còn thông báo cũ. Module này đóng các
// thông báo do service worker hiện ra, theo đúng tag mà server gắn:
//   - lô 1 dòng: `crm-<notification_id>` (notify_claim_push_batch: cnt=1);
//   - lô gộp:    `crm-<user_id>`  — không ánh xạ được về từng dòng;
//   - vòng đời:  `lifecycle:<delivery_id>` — cũng không ánh xạ được.
// Hai loại sau chỉ đóng khi số chưa đọc về 0 (khi đó chắc chắn không còn gì).
// Nhắc "Việc của tôi" (`personal-task:…`) là nhắc cục bộ, KHÔNG thuộc hộp thư,
// nên không bao giờ bị đóng ở đây.
//
// Chỉ đóng được trên CHÍNH máy đang đọc: đóng hộ máy khác cần silent push, mà
// Chrome bắt userVisibleOnly. Mọi lỗi ở đây là mỹ thuật (thông báo còn sót trên
// màn khoá), không được chặn luồng đánh dấu đã đọc — nên nuốt có ghi console.
// =============================================================

/** Tag server gắn cho thông báo một dòng. */
export const tagThongBao = (notificationId: string): string => `crm-${notificationId}`;

/** Tag thuộc hộp thư CRM (mọi loại server gửi), dùng khi số chưa đọc về 0. */
export function laTagHopThu(tag: string | undefined | null): boolean {
  return typeof tag === "string" && (tag.startsWith("crm-") || tag.startsWith("lifecycle:"));
}

type DanhSachThongBao = ReadonlyArray<Pick<Notification, "tag" | "close">>;

async function thongBaoDangHien(): Promise<DanhSachThongBao> {
  if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return [];
  const reg = await navigator.serviceWorker.getRegistration();
  if (!reg || typeof reg.getNotifications !== "function") return [];
  return reg.getNotifications();
}

/** Đóng thông báo hệ điều hành của đúng các dòng vừa được đánh dấu đã đọc. */
export async function dongThongBaoDaDoc(notificationIds: readonly string[]): Promise<number> {
  if (notificationIds.length === 0) return 0;
  try {
    const tags = new Set(notificationIds.map(tagThongBao));
    let dong = 0;
    for (const n of await thongBaoDangHien()) {
      if (tags.has(n.tag)) {
        n.close();
        dong += 1;
      }
    }
    return dong;
  } catch (error) {
    console.warn("[push] chưa đóng được thông báo hệ điều hành đã đọc", error);
    return 0;
  }
}

/** Số chưa đọc về 0 ⇒ không còn thông báo hộp thư nào đáng hiện trên màn khoá. */
export async function dongMoiThongBaoHopThu(): Promise<number> {
  try {
    let dong = 0;
    for (const n of await thongBaoDangHien()) {
      if (laTagHopThu(n.tag)) {
        n.close();
        dong += 1;
      }
    }
    return dong;
  } catch (error) {
    console.warn("[push] chưa đóng được thông báo hộp thư", error);
    return 0;
  }
}

type NavigatorBadge = Navigator & {
  setAppBadge?: (contents?: number) => Promise<void>;
  clearAppBadge?: () => Promise<void>;
};

/**
 * Số trên icon PWA = số chưa đọc. Badging API chỉ có ở một số nền (PWA đã cài
 * trên Chrome/Edge desktop, iOS 16.4+) — thiếu thì lặng lẽ bỏ qua; hàm trả
 * promise và có thể reject (quyền, chưa cài) nên bắt cả hai kiểu lỗi.
 */
export function capNhatSoTrenIcon(soChuaDoc: number): void {
  if (typeof navigator === "undefined") return;
  const nav = navigator as NavigatorBadge;
  try {
    const viec = soChuaDoc > 0 ? nav.setAppBadge?.(soChuaDoc) : nav.clearAppBadge?.();
    void viec?.catch((error: unknown) => console.warn("[push] chưa cập nhật được số trên icon", error));
  } catch (error) {
    console.warn("[push] chưa cập nhật được số trên icon", error);
  }
}
