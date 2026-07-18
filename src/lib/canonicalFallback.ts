// Shared helper cho cutover từng domain: gọi canonical writer trước, fallback
// legacy CHỈ khi tín hiệu hợp lệ (writer chưa deploy / rollout OFF / coexistence-
// denied). Mẫu rút từ paymentRecordRpc.ts, dùng chung cho cashbook/meter/… .
export interface RpcErrorLike {
  code?: string | null;
  message?: string | null;
}

/**
 * true nếu lỗi canonical là tín hiệu fallback-hợp-lệ sang legacy:
 *  - PGRST202: writer chưa deploy (schema cache không có).
 *  - 55000 + "chưa bật": rollout OFF/không canary cho org này.
 *  - 42501: coexistence — legacy vẫn là authority cho tới khi drain (T7).
 * KHÔNG fallback với 23505 (conflict), 22xxx (input), hay 55000-khác — throw thẳng.
 */
export function isCanonicalFallbackSignal(error: RpcErrorLike | null | undefined): boolean {
  if (!error) return false;
  if (error.code === "PGRST202") return true;
  if (error.code === "55000" && (error.message ?? "").includes("chưa bật")) return true;
  if (error.code === "42501") return true;
  return false;
}
