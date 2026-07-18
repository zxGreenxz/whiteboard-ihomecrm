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

/**
 * CREATE income-expense canonical → legacy: như base, CỘNG 0A000 —
 * create_income_expense_v1 từ chối lớp phiếu không hỗ trợ (cọc/hoa hồng/thưởng)
 * bằng 0A000; các lớp đó có writer chuyên biệt riêng, legacy là đường đúng.
 */
export function isIeCreateFallbackSignal(error: RpcErrorLike | null | undefined): boolean {
  if (!error) return false;
  if (isCanonicalFallbackSignal(error)) return true;
  if (error.code === "0A000") return true;
  return false;
}

/**
 * LIFECYCLE income-expense (approve/cancel/verify _v1) → legacy: writer nhận
 * MỌI grant nhưng chỉ xử lý row canonical; row legacy trả 55000 kèm marker
 * 'chưa thuộc luồng canonical'. KHÁC base: 42501 ở đây là TỪ CHỐI QUYỀN THẬT
 * (writer không bị gate bởi grant/flag) — fallback 42501 sẽ làm lỗi quyền
 * hiện ra thành lỗi freeze khó hiểu, nên KHÔNG fallback.
 */
export function isIeLifecycleFallbackSignal(error: RpcErrorLike | null | undefined): boolean {
  if (!error) return false;
  if (error.code === "PGRST202") return true;
  if (error.code === "55000" && (error.message ?? "").includes("chưa thuộc luồng canonical")) {
    return true;
  }
  return false;
}
