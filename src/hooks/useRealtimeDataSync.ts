// =============================================================
// useRealtimeDataSync — hub realtime TRUNG TÂM cho dữ liệu nghiệp vụ.
//
// Mount 1 lần ở AppProviders (component <RealtimeDataSync/>), giữ bằng
// ref-count. Lắng nghe postgres_changes trên các bảng nghiệp vụ (đã ADD vào
// publication supabase_realtime qua các migration realtime) và khi có thay đổi:
//   1. Invalidate các query key liên quan → trang đang mở refetch tại chỗ
//      (giữ data cũ trên màn trong lúc fetch, không nháy "Đang tải").
//   2. Re-prefetch trang đầu của domain đó (prefetchDomain) → cache prefetch
//      từ màn chính LUÔN ẤM, quay lại trang vẫn hiện ngay dữ liệu mới.
//
// Gom theo CỤM xuyên bảng (src/lib/realtime/hubCollector.ts): debounce 800ms,
// trần 2,4s — một giao dịch chạm nhiều bảng chỉ làm mỗi query refetch một lần.
// Bài học Zalo 26/06 vẫn giữ: thao tác bulk bắn 1 event/dòng, tuyệt đối không
// refetch theo từng event.
//
// Vòng đời kênh đi qua subscribeResilient (21/10/2026): SUBSCRIBED lại sau rớt,
// tab hiện lại sau ≥60s hay 'online' ⇒ catchUp (một lượt làm tươi query active);
// server đóng kênh (CLOSED) ⇒ dựng lại có backoff; trạng thái vào channelHealth
// để dải "Mất kết nối cập nhật tự động" ở layout đọc.
//
// Payload realtime bị bỏ qua hoàn toàn — event chỉ là tín hiệu invalidate cache.
// Không dựa vào payload hoặc việc nhận event DELETE để phân quyền; dữ liệu refetch
// vẫn đi qua query/RPC authorization hiện có. Các bảng này chủ yếu xoá mềm (UPDATE).
// =============================================================

import { useEffect } from "react";
import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import { useAuth } from "@/hooks/useAuth";
// prefetchPages (kéo theo hooks của 4 trang) được import ĐỘNG trong
// hubCollector — file này mount từ entry chunk, import tĩnh sẽ phồng bundle đầu.
// Danh sách bảng chuẩn ở src/lib/realtime/syncTables.ts (dữ liệu thuần cho gate
// check-realtime-descriptors); hub chỉ đọc descriptor đã đối chiếu với nó.
import { catchUp } from "@/lib/realtime/catchUp";
import { createHubInvalidationCollector } from "@/lib/realtime/hubCollector";
import { subscribeResilient } from "@/lib/realtime/subscribeResilient";

// Re-export để mutation chỉ cần biết MỘT cửa: hub realtime.
export { markLocalWrite } from "@/lib/realtime/localWriteEcho";

// Descriptor nay TÁCH THEO MIỀN sang src/hooks/realtime/ (P1.8 của plan). Hub chỉ
// còn ba việc: mở channel, đẩy event vào bộ gom, điều phối vòng đời. Bản đồ
// bảng → query key không còn nằm ở đây, và đó là điểm chính: người sửa màn thu
// chi không phải đọc qua phần điều phối để tìm dòng của mình.
//
// index.ts của thư mục đó KHÔNG chỉ là chỗ gom — nó đối chiếu tập descriptor với
// REALTIME_SYNC_TABLES. Tách một mảng thành nhiều file tạo ra một cách hỏng MỚI
// mà bản gộp không có (quên nối một miền vào hub), và hậu quả trùng khít với lớp
// lỗi mà cả hệ realtime này sinh ra để chống: im lặng tuyệt đối.
import { SYNC_ENTRIES as SYNC_TABLES } from "@/hooks/realtime";

// ── Singleton hub theo REF-COUNT (sửa 28/08, audit 27/08 C-INFRA-6) ─────────
//
// Bản cũ là cờ boolean `hubActive`: consumer thứ hai mount khi hub đang sống
// thì `return` sớm KHÔNG cleanup — rồi khi consumer ĐẦU unmount, cleanup của nó
// hạ cờ + removeChannel, còn consumer sống sót thì VĨNH VIỄN không subscribe.
// Hôm nay App.tsx chỉ mount một lần nên chưa nổ, nhưng đó là bất biến ngầm chờ
// một lần refactor mount-topology để vỡ. Ref-count làm hành vi đúng với MỌI số
// consumer: hub sống chừng nào còn ≥1 consumer, chết khi consumer cuối rời đi,
// và dựng lại khi user đổi.
let hubRefs = 0;
let hubUserId: string | null = null;
let hubTeardown: (() => void) | null = null;

/** Số consumer đang giữ hub — cho test bất biến ref-count. */
export function __hubRefsForTest() {
  return hubRefs;
}

export function useRealtimeDataSync() {
  const qc = useQueryClient();
  const { data: user } = useAuth();
  const userId = user?.id ?? null;

  useEffect(() => {
    if (!userId) return;
    hubRefs += 1;
    if (hubTeardown === null || hubUserId !== userId) {
      // Consumer đầu tiên, hoặc user đã đổi khi hub cũ còn sống: dọn rồi dựng.
      hubTeardown?.();
      hubUserId = userId;
      hubTeardown = dungHub(qc, userId);
    }
    return () => {
      hubRefs -= 1;
      if (hubRefs <= 0) {
        hubRefs = 0;
        hubTeardown?.();
        hubTeardown = null;
        hubUserId = null;
      }
    };
  }, [userId, qc]);
}

/** Dựng channel + bộ gom; trả về hàm dọn. Tách khỏi effect để ref-count ở
 *  trên chỉ còn đúng một việc: đếm. */
function dungHub(qc: QueryClient, userId: string): () => void {
  const collector = createHubInvalidationCollector(qc);
  // Trước 21/10 là `channel.subscribe(cb)` tự xử lý trạng thái: CHANNEL_ERROR /
  // TIMED_OUT chỉ console.warn, SUBSCRIBED lần hai bị bỏ qua (mất event trong
  // lúc rớt), CLOSED từ server làm hub chết tới F5. subscribeResilient giữ cờ
  // "ta chủ động dọn" (không cảnh báo giả lúc unmount) và lo cả ba ca đó.
  const stop = subscribeResilient({
    id: "hub",
    topic: `crm-data-sync-${userId}`,
    bind: (channel) => {
      let ch = channel;
      for (const entry of SYNC_TABLES) {
        ch = ch.on(
          "postgres_changes",
          { event: "*", schema: "public", table: entry.table },
          () => collector.enqueue(entry, Date.now()),
        );
      }
      return ch;
    },
    onResync: () => catchUp(qc),
  });

  return () => {
    collector.dispose();
    stop();
  };
}

/** Component tiện mount trong App — hook cần nằm dưới QueryClientProvider. */
export function RealtimeDataSync(): null {
  useRealtimeDataSync();
  return null;
}
