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
// Số chưa đọc là của CÔNG TY ĐANG CHỌN (inboxScope), nên "về 0" chỉ đóng thông báo
// mang `data.organizationId` của công ty đó hoặc không mang công ty — thông báo của
// công ty khác vẫn còn việc chờ, giữ nguyên (NOTIF-CLIENT-4). send-push trải
// `data` của payload vào Notification.data (public/sw.js).
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

type DanhSachThongBao = ReadonlyArray<Pick<Notification, "tag" | "close" | "data">>;

/** Công ty của thông báo theo payload push; thiếu/méo ⇒ null (thông báo không gắn công ty). */
function congTyCua(n: Pick<Notification, "data">): string | null {
  const data: unknown = n.data;
  if (!data || typeof data !== "object") return null;
  const org = (data as { organizationId?: unknown }).organizationId;
  return typeof org === "string" && org ? org.toLowerCase() : null;
}

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

/**
 * Số chưa đọc của công ty `organizationId` về 0 ⇒ đóng thông báo hộp thư của công ty
 * đó (và thông báo không gắn công ty). `null` = chưa chốt công ty ⇒ chỉ đóng thông
 * báo không gắn công ty.
 */
export async function dongMoiThongBaoHopThu(organizationId: string | null): Promise<number> {
  const congTy = organizationId ? organizationId.toLowerCase() : null;
  try {
    let dong = 0;
    for (const n of await thongBaoDangHien()) {
      const cua = congTyCua(n);
      if (laTagHopThu(n.tag) && (cua === null || cua === congTy)) {
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
 * Số trên icon PWA = số chưa đọc CỦA CÔNG TY ĐANG CHỌN (cùng số với chuông — chọn
 * có chủ ý: đếm mọi công ty cần thêm một truy vấn đếm ngoài inboxScope mỗi lần làm
 * tươi, trong khi người thuộc nhiều công ty rất hiếm). Người nhiều công ty
 * thấy số của công ty đang xem, không phải tổng. Badging API chỉ có ở một số nền (PWA đã cài
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
