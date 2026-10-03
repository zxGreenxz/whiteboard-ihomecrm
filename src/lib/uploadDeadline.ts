/**
 * Hạn chờ một lần tải lên kho — chủ chốt 30/09/2026: CHỜ TỐI ĐA 20 GIÂY. Mọi ảnh
 * chứng từ sau khi nén đều dưới 1 MB (bill ~70 KB, ảnh camera ~340 KB, đo E2E) nên
 * đúng 20 giây. Tệp lớn thật (PDF nhiều MB, tệp gửi Zalo tới 25 MB) được thêm 20
 * giây cho mỗi MB vượt quá 1 MB, để tải chậm-mà-vẫn-chạy không bị báo lỗi oan.
 * Quá hạn nghĩa là request đã kẹt trên mạng (chủ gặp 30/09/2026: kẹt "Đang
 * tải..." tới khi tắt app), nên báo lỗi để người dùng thử lại thay vì chờ mãi.
 *
 * Tách riêng khỏi storage.ts để storage/r2Client dùng được mà không vòng import.
 */
export function uploadDeadlineMs(bytes: number): number {
  const extraMb = Math.max(0, Math.ceil(bytes / (1024 * 1024)) - 1);
  return 20_000 + extraMb * 20_000;
}

/**
 * Hạn TỔNG của đường tải chịu mạng chập chờn (`storage/resilientUpload.ts`) — chủ
 * chốt 03/10/2026: tính cả các lần tự tải lại, không quá 45 giây cho ảnh (mọi ảnh
 * chứng từ sau nén dưới 1 MB). Tệp lớn thêm 20 giây cho mỗi MB vượt 1 MB, như trên.
 */
export function resilientUploadDeadlineMs(bytes: number): number {
  const extraMb = Math.max(0, Math.ceil(bytes / (1024 * 1024)) - 1);
  return 45_000 + extraMb * 20_000;
}

export class UploadTimeoutError extends Error {
  /** Hạn đã chờ (ms) — để câu báo nói đúng số giây (tệp lớn được chờ lâu hơn 20 giây). */
  readonly ms?: number;
  constructor(ms?: number) {
    super("Tải file quá lâu — mạng đang chậm hoặc chập chờn. Kiểm tra mạng rồi thử lại.");
    this.name = "UploadTimeoutError";
    this.ms = ms;
  }
}

/** Tệp SAU khi nén vẫn vượt cỡ cho phép — từ chối trước khi gửi byte nào. */
export class UploadTooLargeError extends Error {
  readonly bytes: number;
  readonly limit: number;
  constructor(bytes: number, limit: number) {
    super(`Tệp ${Math.ceil(bytes / 1024)} KB vượt giới hạn ${Math.round(limit / (1024 * 1024))} MB`);
    this.name = "UploadTooLargeError";
    this.bytes = bytes;
    this.limit = limit;
  }
}

/**
 * Máy chủ lưu trữ trả lỗi hẳn (quyền, định dạng… hoặc 5xx sau khi đã tự tải lại).
 * `statusCode` là mã thật trong thân trả lời (Storage bọc 403/409 trong HTTP 400).
 */
export class UploadRejectedError extends Error {
  readonly statusCode: number;
  constructor(statusCode: number, message: string) {
    super(message);
    this.name = "UploadRejectedError";
    this.statusCode = statusCode;
  }
}

/** Lỗi do chính người dùng huỷ lệnh tải (gỡ ảnh, đóng hộp) — không phải lỗi để báo. */
export function uploadAbortError(): DOMException {
  return new DOMException("Đã huỷ tải tệp", "AbortError");
}

export function isAbortError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "name" in error && (error as { name: unknown }).name === "AbortError";
}
