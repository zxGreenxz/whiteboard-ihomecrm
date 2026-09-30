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

export class UploadTimeoutError extends Error {
  /** Hạn đã chờ (ms) — để câu báo nói đúng số giây (tệp lớn được chờ lâu hơn 20 giây). */
  readonly ms?: number;
  constructor(ms?: number) {
    super("Tải file quá lâu — mạng đang chậm hoặc chập chờn. Kiểm tra mạng rồi thử lại.");
    this.name = "UploadTimeoutError";
    this.ms = ms;
  }
}
