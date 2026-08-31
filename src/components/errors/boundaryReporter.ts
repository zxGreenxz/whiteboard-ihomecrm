/**
 * Chỗ cắm để một trang tự nhận báo cáo khi ErrorBoundary bắt được render crash.
 *
 * VÌ SAO CẦN
 *   React nuốt lỗi render tại boundary — `window.onerror` KHÔNG thấy chúng ở bản
 *   production. Nghĩa là loại lỗi nặng nhất (trang trắng, người dùng thấy thẻ
 *   "Đã xảy ra lỗi") lại là loại duy nhất không có trong nhật ký. ErrorBoundary
 *   trước đây chỉ `console.error`, tức là chỉ tồn tại trên máy của khách.
 *
 * VÌ SAO LÀ MỘT Ô CẮM CHỨ KHÔNG GỌI THẲNG BỘ ĐO ĐẾM
 *   ErrorBoundary bọc toàn bộ ứng dụng, còn bộ đo đếm chỉ tồn tại trên trang
 *   công khai và cần token của link chia sẻ. Nếu boundary import thẳng tracker
 *   thì mọi màn hình CRM kéo theo mã đo đếm mà không dùng đến. Ô cắm này mặc
 *   định rỗng: không ai đăng ký thì `reportBoundaryError` là no-op.
 */
import type { ErrorInfo } from "react";

export type BoundaryReporter = (error: Error, info?: ErrorInfo) => void;

let reporter: BoundaryReporter | null = null;

/**
 * Đăng ký (hoặc gỡ, bằng `null`) hàm nhận báo cáo.
 *
 * Gỡ chỉ có tác dụng khi hàm truyền vào ĐÚNG là hàm đang đăng ký — hai trang
 * chồng nhau lúc chuyển route thì trang cũ không được phép rút thảm của trang
 * mới.
 */
export function setBoundaryReporter(fn: BoundaryReporter | null): void {
  if (fn === null) {
    reporter = null;
    return;
  }
  reporter = fn;
}

/** Gỡ đăng ký nếu `fn` đúng là hàm đang giữ chỗ. */
export function clearBoundaryReporter(fn: BoundaryReporter): void {
  if (reporter === fn) reporter = null;
}

/** Báo một lỗi render. Không bao giờ ném — bộ ghi lỗi không được hạ boundary. */
export function reportBoundaryError(error: Error, info?: ErrorInfo): void {
  const fn = reporter;
  if (!fn) return;
  try {
    fn(error, info);
  } catch {
    /* báo cáo hỏng thì bỏ qua: boundary còn phải dựng được giao diện cứu hộ */
  }
}
