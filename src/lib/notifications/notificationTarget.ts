// =============================================================
// Đích bấm + nhãn họ của MỘT dòng thông báo — dùng chung cho chuông, trang
// /notifications desktop và mobile. (21/10/2026, plan realtime + thông báo, C10.)
//
// MỌI đích đều đi qua resolveNotificationUrl (allow-list + kiểm quyền module).
// Trước đây nhánh dự phòng invoice_id/contract_id gọi navigate() thẳng: người không
// có quyền hoá đơn bấm nhắc hoá đơn thì bị RequirePermission đá về "/" — trông như
// nút hỏng — thay vì được hạ về /my-day như mọi đích khác (NOTIF-SERVER-4).
// =============================================================

import { resolveNotificationUrl } from "@/lib/notificationRoutes";
import type { PermsLike } from "@/lib/permissionPages";

export interface ThongBaoCoDich {
  type: string;
  invoice_id?: string | null;
  contract_id?: string | null;
  metadata?: Record<string, unknown> | null;
}

/** Đường dẫn suy từ khoá ngoại cho dòng CŨ không có metadata.url. */
export function duongDanDuPhong(n: ThongBaoCoDich): string | null {
  if (n.invoice_id) return `/invoices/${n.invoice_id}`;
  if (n.contract_id) return `/contracts/${n.contract_id}`;
  // 52 dòng SALARY_BONUS cũ không có metadata.url.
  if (n.type === "SALARY_BONUS") return "/finance/salary";
  return null;
}

/**
 * Đích điều hướng khi bấm: metadata.url TRƯỚC (nơi phát sự kiện mới biết đích đúng:
 * danh sách đã lọc, phiếu cụ thể, tab bàn giao…), rồi mới tới đường suy từ id.
 * null ⇒ không điều hướng.
 */
export function dichThongBao(n: ThongBaoCoDich, perms: PermsLike): string | null {
  return resolveNotificationUrl(n.metadata?.url, perms) ?? resolveNotificationUrl(duongDanDuPhong(n), perms);
}

/**
 * Nhãn họ cho dòng do server sinh (metadata.event). Nhắc hoá đơn/HĐ/cọc chuyển
 * lên server (gói B5) giữ `type` enum cũ nhưng mang họ mới; LIFECYCLE có `type`
 * ACTION_REQUIRED nên nhãn theo loại ("Chờ tôi xử lý") không nói được đó là gì.
 * null ⇒ dùng nhãn theo `type` như cũ.
 */
export function nhanHoThongBao(n: ThongBaoCoDich): string | null {
  const event = n.metadata?.event;
  switch (event) {
    case "BILLING":
      return n.type === "OVERDUE_INVOICE" ? "Hoá đơn quá hạn" : "Hoá đơn sắp đến hạn";
    case "CONTRACT_EXPIRY":
      return "HĐ sắp hết hạn";
    case "DEPOSIT":
      return "Thiếu cọc";
    case "LIFECYCLE":
      return "Theo dõi trả phòng";
    default:
      return null;
  }
}
