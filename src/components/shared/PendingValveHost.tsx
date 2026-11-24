import { useEffect, useState, type ComponentType } from "react";
import { onPendingValveSignal } from "@/lib/pendingValveSignal";

/**
 * Chỗ gắn hộp cảnh báo «chờ đối chiếu» ở gốc ứng dụng. Hộp chỉ được nạp khi có lần ghi bị chặn, để gói tải
 * đầu không phải mang bộ hộp thoại mà đa số phiên làm việc không dùng tới.
 *
 * Nạp hụt (đang mất mạng) thì bỏ qua và thử lại ở lời báo kế tiếp: người dùng vẫn thấy câu báo ở màn đang
 * làm, và một lần nạp hỏng không được làm sập cây giao diện.
 */
export function PendingValveHost() {
  const [Dialog, setDialog] = useState<ComponentType | null>(null);
  useEffect(() => onPendingValveSignal(() => {
    import("./PendingValveDialog").then((module) => setDialog(() => module.PendingValveDialog), () => {});
  }), []);
  return Dialog ? <Dialog /> : null;
}
