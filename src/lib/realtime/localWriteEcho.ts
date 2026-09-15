// =============================================================
// Cửa sổ "VỪA TỰ GHI" — chống việc hub realtime đánh lại mutation của CHÍNH máy
// này. (15/09/2026, plan con B của đợt rà soát toàn hệ thống.)
//
// VẤN ĐỀ ĐO ĐƯỢC
//   Mọi mutation đều tự invalidate trong onSuccess. Nhưng thay đổi đó cũng chạy
//   qua publication `supabase_realtime`, nên 0,8–2,4 giây sau (debounce của hub)
//   hub invalidate LẦN HAI toàn bộ key của bảng, rồi prefetch lại cả domain —
//   kể cả khi người dùng không đứng ở trang đó. `create_contract_v2` chạm 5 bảng
//   ⇒ ~70 lượt quét cache + 6 RPC nặng cho một thao tác đã xong từ lâu.
//
//   Đây KHÔNG phải lỗi đồng bộ: dữ liệu vẫn đúng. Nó là lượt làm lại thừa, và
//   thừa đủ để thấy bằng mắt trên máy yếu.
//
// CÁCH CHẶN — VÀ VÌ SAO NÓ KHÔNG LÀM MẤT ĐỒNG BỘ
//   Mutation gọi markLocalWrite(<các bảng nó ghi>). Event realtime tới trong
//   CUA_SO_MS sau mốc đó, cho ĐÚNG bảng đó, gần như chắc chắn là tiếng vọng của
//   chính mình ⇒ hub gộp cả entry về MỘT lượt invalidate và bỏ prefetch.
//
//   "Gộp" không có nghĩa là bỏ bớt key: bộ lọc dưới đây phủ ĐÚNG tập tiền tố của
//   entry, chỉ khác ở chỗ một lời gọi thay vì N. invalidateQueries vẫn đánh dấu
//   MỌI query khớp là hết hạn (kể cả query không active) — `refetchType: active`
//   chỉ quyết định cái nào gọi lại NGAY. Nên trang đang mở vẫn refetch, trang
//   chưa mở vẫn hết hạn và sẽ tải lại lúc quay về. Không có dữ liệu nào kẹt cũ.
//
//   Rủi ro còn lại là hẹp và đã cân: máy KHÁC sửa đúng bảng đó trong đúng 3 giây
//   ấy thì thay đổi của họ cũng được invalidate (cùng tập key), chỉ là không
//   được hâm cache prefetch. Lần thay đổi kế tiếp — hoặc lần vào trang kế tiếp —
//   lo nốt.
// =============================================================

import type { SyncTable } from "@/lib/realtime/syncTables";

/** Cửa sổ tính từ lúc mutation local báo đã ghi xong. */
export const CUA_SO_VUA_TU_GHI_MS = 3000;

const mocGhiNoiBo = new Map<SyncTable, number>();

/**
 * Đánh dấu "máy này vừa ghi các bảng sau". Gọi trong onSuccess của mutation,
 * SAU khi đã invalidate xong — hub sẽ không đánh lại lượt hai.
 *
 * Liệt kê đúng những bảng mutation thật sự ghi. Khai thừa một bảng nghĩa là tự
 * bịt tai với thay đổi của máy khác trên bảng ấy trong 3 giây.
 */
export function markLocalWrite(tables: readonly SyncTable[]): void {
  const bayGio = Date.now();
  for (const table of tables) mocGhiNoiBo.set(table, bayGio);
}

/** Event của `table` lúc `bayGio` có nằm trong cửa sổ vừa tự ghi không. */
export function laTiengVongNoiBo(table: SyncTable, bayGio: number): boolean {
  const moc = mocGhiNoiBo.get(table);
  if (moc === undefined) return false;
  return bayGio - moc >= 0 && bayGio - moc <= CUA_SO_VUA_TU_GHI_MS;
}

/** Query khớp tiền tố `tienTo` theo đúng nghĩa của React Query (so từ đầu mảng). */
function khopTienTo(
  tienTo: readonly unknown[],
  queryKey: readonly unknown[],
): boolean {
  if (tienTo.length > queryKey.length) return false;
  for (let i = 0; i < tienTo.length; i += 1) {
    if (!Object.is(tienTo[i], queryKey[i])) return false;
  }
  return true;
}

/**
 * Bộ lọc invalidateQueries gộp cả entry về MỘT lượt.
 *
 * Bỏ nhóm ["business-performance"]: hub gom nhóm đó theo luật riêng cắt ngang
 * nhiều bảng (BUSINESS_PERFORMANCE_INVALIDATION_RULES) và flush bằng đường khác
 * — kéo nó vào đây sẽ invalidate rộng hơn luật, tức đúng thứ luật đó sinh ra để
 * tránh.
 */
export function locTiengVongNoiBo(keys: readonly (readonly unknown[])[]) {
  const tienTo = keys.filter((key) => key[0] !== "business-performance");
  return {
    refetchType: "active" as const,
    predicate: (query: { queryKey: readonly unknown[] }) =>
      tienTo.some((k) => khopTienTo(k, query.queryKey)),
  };
}

/** Dọn sổ mốc — chỉ dùng trong test, vì Map này ở cấp module. */
export function __resetLocalWriteEchoForTest(): void {
  mocGhiNoiBo.clear();
}
