// Tín hiệu «có lần ghi vừa bị chặn bởi dấu chờ đối chiếu», tách riêng để gói tải đầu chỉ mang vài dòng này.
// Hộp cảnh báo (`PendingValveDialog`) kéo theo cả bộ hộp thoại; nó chỉ được nạp khi tín hiệu này bật lần đầu,
// thay vì nằm sẵn trong gói entry mà phần lớn phiên làm việc không bao giờ cần. Gói entry đang sát ngưỡng
// của cửa bundle (đo 24/11/2026: còn khoảng 1,4 kB), nên tệp này và `PendingValveHost` cố ý viết ngắn.
let handler: (() => void) | null = null;
let missed = false;

/** Van gọi mỗi lần có lời báo mới. Chưa ai nghe (gốc ứng dụng chưa dựng xong) thì nhớ lại để báo sau. */
export function raisePendingValveSignal(): void {
  if (handler) handler();
  else missed = true;
}
/** Gốc ứng dụng đăng ký MỘT người nghe; trả hàm huỷ. */
export function onPendingValveSignal(next: () => void): () => void {
  handler = next;
  if (missed) { missed = false; next(); }
  return () => { if (handler === next) handler = null; };
}
