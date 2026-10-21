// =============================================================
// Tin nhắn service worker → app và tham số mở app từ push — PHÉP ĐỌC THUẦN.
// (21/10/2026, plan realtime + thông báo, mục C3/C4.)
//
// Hợp đồng phía phát nằm ở đầu public/sw.js. Dữ liệu đến từ payload push (do
// server ghi) và từ URL (ai cũng gõ được), nên KHÔNG tin hình dạng: id phải là
// uuid, url chỉ được là chuỗi — việc kiểm duyệt đích điều hướng vẫn thuộc về
// resolveNotificationUrl (có kiểm quyền), không phải ở đây.
// =============================================================

import { chuanHoaIdThongBao, laUuid } from "@/lib/notifications/notificationIds";

export type SwMessage =
  | { type: "push-received" }
  | { type: "notification-click"; url: string | null; notificationIds: string[]; organizationId: string | null }
  | { type: "push-subscription-changed" };

const laObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Đọc `event.data` của message từ service worker; tin lạ ⇒ null (bỏ qua). */
export function docTinServiceWorker(data: unknown): SwMessage | null {
  if (!laObject(data)) return null;
  switch (data.type) {
    case "push-received":
      return { type: "push-received" };
    case "push-subscription-changed":
      return { type: "push-subscription-changed" };
    case "notification-click":
      return {
        type: "notification-click",
        url: typeof data.url === "string" ? data.url : null,
        notificationIds: chuanHoaIdThongBao(Array.isArray(data.notificationIds) ? data.notificationIds : []),
        organizationId: laUuid(data.organizationId) ? data.organizationId.toLowerCase() : null,
      };
    default:
      return null;
  }
}

/** Tham số service worker gắn khi phải mở tab mới (không có tab nào đang mở). */
export const THAM_SO_ID_THONG_BAO = "notif";
export const THAM_SO_CONG_TY = "org";

export interface ThamSoMoApp {
  notificationIds: string[];
  organizationId: string | null;
  /** Query còn lại sau khi gỡ hai tham số trên (có `?` nếu không rỗng). */
  conLai: string;
}

/** Đọc `?notif=<id,id>&org=<id>` lúc mở app; không có tham số nào ⇒ null. */
export function docThamSoMoApp(search: string): ThamSoMoApp | null {
  const params = new URLSearchParams(search);
  if (!params.has(THAM_SO_ID_THONG_BAO) && !params.has(THAM_SO_CONG_TY)) return null;
  const ids = (params.get(THAM_SO_ID_THONG_BAO) ?? "").split(",").map((s) => s.trim());
  const org = params.get(THAM_SO_CONG_TY);
  params.delete(THAM_SO_ID_THONG_BAO);
  params.delete(THAM_SO_CONG_TY);
  const rest = params.toString();
  return {
    notificationIds: chuanHoaIdThongBao(ids),
    organizationId: laUuid(org) ? org.toLowerCase() : null,
    conLai: rest ? `?${rest}` : "",
  };
}
