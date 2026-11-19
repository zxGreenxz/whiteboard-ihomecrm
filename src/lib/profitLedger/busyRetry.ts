// Gửi lại NGUYÊN lời gọi (cùng tham số, cùng khoá chống gửi trùng) khi máy chủ báo bận ở tầng khoá:
// 40P01 (kẹt khoá chéo — PostgREST KHÔNG tự chạy lại), 40001, 55P03. Ba mã này PostgreSQL bảo đảm
// giao dịch đã lùi trọn, và các lệnh ghi sổ tổng đều idempotent theo khoá ⇒ gửi lại an toàn.
// Mọi mã khác (kể cả 55000 = HTTP 500) KHÔNG gửi lại.

import { classifyDbError, isRetryable } from '@/lib/contracts/errors';

export interface RpcResponse {
  data: unknown;
  error: unknown;
}

/** Khoảng chờ giữa các lần gửi lại (ms). Hết lượt vẫn bận ⇒ trả lỗi cuối cho lớp gọi dịch "thử lại". */
export const BUSY_RETRY_DELAYS_MS: readonly number[] = [200, 600];

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export async function withBusyRetry(
  call: () => PromiseLike<RpcResponse>,
  delays: readonly number[] = BUSY_RETRY_DELAYS_MS,
): Promise<RpcResponse> {
  let response = await call();
  for (const delay of delays) {
    if (!response.error || !isRetryable(classifyDbError(response.error))) return response;
    await sleep(delay);
    response = await call();
  }
  return response;
}
