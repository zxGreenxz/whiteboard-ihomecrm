import { supabase } from "@/integrations/supabase/client";
import { getSessionUser } from "@/lib/authSession";

// --- Cache module-level cho income_expense_types (id/name/type/category) ---
//
// getItemTypeSiblingIds (useIncomeExpenses.ts) trước đây bắn 1+N query
// income_expense_types MỖI LẦN chạy, và chạy trong CẢ 3 queryFn
// (list/stats/batches) → burst request làm nghẽn pool PostgREST trên instance
// nhỏ (DB exec chỉ ~40ms nhưng xếp hàng thành 2-8s). Bảng chỉ ~120 dòng nên
// fetch 1 lần rồi tính sibling thuần JS.
//
// Dùng promise-cache thuần (không phụ thuộc React Query context) để chạy được
// cả trong prefetchPages/realtime re-prefetch; các lời gọi song song tự dedup
// vì cùng nhận 1 promise. Cache key theo user id — đổi phiên đăng nhập không
// leak dữ liệu RLS của user trước.

export type IeTypeLite = {
  id: string;
  name: string;
  type: "income" | "expense";
  category: string | null;
};

const IE_TYPES_CACHE_TTL_MS = 5 * 60_000;

let ieTypesCache: {
  at: number;
  uid: string | null;
  promise: Promise<IeTypeLite[]>;
} | null = null;

/** Gọi khi tạo/sửa/xoá loại thu chi để lần lọc kế tiếp thấy dữ liệu mới. */
export function invalidateIeTypesCache() {
  ieTypesCache = null;
}

async function fetchAllIeTypesLite(): Promise<IeTypeLite[]> {
  const { data, error } = await supabase
    .from("income_expense_types" as any)
    .select("id, name, type, category");
  if (error) throw error;
  return (data ?? []) as unknown as IeTypeLite[];
}

/** Toàn bộ loại thu chi user thấy được (RLS áp như query lẻ cũ), cache 5'. */
export async function getAllIeTypesCached(): Promise<IeTypeLite[]> {
  const user = await getSessionUser();
  const uid = user?.id ?? null;
  const now = Date.now();
  if (
    ieTypesCache &&
    ieTypesCache.uid === uid &&
    now - ieTypesCache.at < IE_TYPES_CACHE_TTL_MS
  ) {
    return ieTypesCache.promise;
  }
  const promise = fetchAllIeTypesLite().catch((err) => {
    // Lỗi mạng → bỏ cache để lần sau thử lại, không giam promise rejected.
    ieTypesCache = null;
    throw err;
  });
  ieTypesCache = { at: now, uid, promise };
  return promise;
}
