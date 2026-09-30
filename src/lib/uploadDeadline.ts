/**
 * Hạn chờ một lần tải lên kho: 20 giây + 20 giây mỗi MB. Ảnh chứng từ đã nén
 * (~100–300 KB) có 40 giây; PDF 5 MB có 2 phút. Tải thường xong trong vài giây —
 * quá hạn nghĩa là request đã kẹt trên mạng (chủ gặp 30/09/2026: kẹt "Đang
 * tải..." tới khi tắt app), nên báo lỗi để người dùng thử lại thay vì chờ mãi.
 *
 * Tách riêng khỏi storage.ts để storage/r2Client dùng được mà không vòng import.
 */
export function uploadDeadlineMs(bytes: number): number {
  return 20_000 + Math.ceil(bytes / (1024 * 1024)) * 20_000;
}

export class UploadTimeoutError extends Error {
  constructor() {
    super("Tải file quá lâu — mạng đang chậm hoặc chập chờn. Kiểm tra mạng rồi thử lại.");
    this.name = "UploadTimeoutError";
  }
}
