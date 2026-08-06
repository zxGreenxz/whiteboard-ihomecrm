import type { Json } from "@/integrations/supabase/types";

/**
 * Đọc an toàn các giá trị `Json` mà RPC trả về.
 *
 * Vì sao cần: rất nhiều hàm Postgres khai `RETURNS jsonb`, nên `types.ts` sinh ra
 * kiểu trả về là `Json` — một union đệ quy gồm cả `string | number | boolean | null`.
 * Viết `data.organizations` trên đó không compile được, và cách né phổ biến nhất
 * trong repo này là ép `(supabase.rpc as any)`. Cái ép đó tắt kiểm tra cho TOÀN BỘ
 * lời gọi: sai tên hàm, sai tên tham số, sai kiểu tham số đều lọt qua.
 *
 * Ba hàm dưới đây thay thế đúng chỗ cần: chúng thu hẹp kiểu bằng kiểm tra thật ở
 * runtime, nên giữ được kiểm tra tĩnh cho phần còn lại của lời gọi RPC.
 *
 * Hành vi khớp nguyên vẹn lối viết cũ (`data?.field`, `Array.isArray(x) ? x : []`)
 * — đây là thay đổi kiểu, không phải thay đổi logic.
 */

/** `true` khi value là object JSON — tức không phải null và không phải mảng. */
export function isJsonObject(value: unknown): value is Record<string, Json> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Đọc một trường của giá trị JSON.
 *
 * Trả `undefined` khi value không phải object (kể cả khi là mảng, chuỗi, số hay
 * null) — giống hệt kết quả của `value?.key` trước đây, nhưng có kiểu.
 */
export function jsonProp(value: unknown, key: string): Json | undefined {
  return isJsonObject(value) ? value[key] : undefined;
}

/**
 * Đọc một trường và bảo đảm kết quả là mảng.
 *
 * Trả mảng rỗng khi trường không tồn tại hoặc không phải mảng, nên chỗ gọi luôn
 * `.map()` được mà không cần kiểm tra thêm.
 */
export function jsonArray(value: unknown, key: string): Json[] {
  const field = jsonProp(value, key);
  return Array.isArray(field) ? field : [];
}
