// =============================================================
// catchUp — bắt kịp sau một khoảng có thể đã lỡ event realtime.
// (21/10/2026, plan realtime + thông báo, mục A2 / RT-HUB-1, RT-DB-3.)
//
// postgres_changes KHÔNG phát lại event đã lỡ: slot là tạm thời, server chỉ
// đẩy thay đổi xảy ra lúc kênh đang join. Nên sau khi kênh hub nối lại (hoặc
// tab hiện lại sau ≥60 s, hoặc trình duyệt báo online — xem subscribeResilient)
// cách duy nhất để màn khỏi giữ số cũ là coi mọi query hub phủ là đã cũ.
//
// MỘT lượt invalidateQueries theo gốc key, refetchType 'active':
//   - query đang hiện trên màn refetch ngay (một lần, không theo từng bảng);
//   - query nền chỉ bị đánh dấu cũ và tải lại lúc được mở — không bắn hàng
//     loạt request vào cache nền.
//
// Tập gốc = hợp phần tử đầu của mọi key trong SYNC_ENTRIES (descriptor đã nối
// sẵn nhóm quyết toán/facts ở hooks/realtime/index.ts) + nhóm báo cáo. Khai
// thêm bảng/key vào descriptor là tự vào tập này — không có danh sách thứ hai
// để quên sửa.
// =============================================================

import type { QueryClient } from "@tanstack/react-query";
import { SYNC_ENTRIES } from "@/hooks/realtime";

/** Gốc key bắt buộc có kể cả khi descriptor đổi cách nối (RT-HUB-1 REC_FIX). */
const GOC_LUON_CO = [
  "business-performance",
  "contract-settlement",
  "termination-refund-facts",
  "commission-voucher-facts",
] as const;

export const GOC_BAT_KIP: ReadonlySet<string> = new Set([
  ...SYNC_ENTRIES.flatMap((entry) => entry.keys.map((key) => String(key[0]))),
  ...GOC_LUON_CO,
]);

/** Làm tươi mọi query hub phủ. Không ném: lỗi refetch từng query tự hiện ở màn của nó. */
export function catchUp(qc: QueryClient): void {
  void Promise.resolve(
    qc.invalidateQueries({
      refetchType: "active",
      predicate: (query) => GOC_BAT_KIP.has(String(query.queryKey[0])),
    }),
  ).catch(() => { /* lỗi refetch nằm ở state từng query (throwOnError mặc định false); bắt kịp không có kênh báo lỗi riêng */ });
}
