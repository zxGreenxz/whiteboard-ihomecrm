// =============================================================
// useRealtimeDataSync — hub realtime TRUNG TÂM cho dữ liệu nghiệp vụ.
//
// Mount 1 lần ở App (component <RealtimeDataSync/>). Lắng nghe
// postgres_changes trên các bảng nghiệp vụ (đã ADD vào publication
// supabase_realtime qua các migration realtime) và khi có thay đổi:
//   1. Invalidate các query key liên quan → trang đang mở refetch tại chỗ
//      (giữ data cũ trên màn trong lúc fetch, không nháy "Đang tải").
//   2. Re-prefetch trang đầu của domain đó (prefetchDomain) → cache prefetch
//      từ màn chính LUÔN ẤM, quay lại trang vẫn hiện ngay dữ liệu mới.
//
// Debounce 800ms/bảng theo đúng bài học Zalo 26/06 (useZaloRealtime): thao
// tác bulk (sinh hoá đơn hàng loạt, import thu chi…) bắn 1 event/dòng — gộp
// cơn bão đó về 1 lần invalidate, tuyệt đối không refetch theo từng event.
//
// Payload realtime bị bỏ qua hoàn toàn — event chỉ là tín hiệu invalidate cache.
// Không dựa vào payload hoặc việc nhận event DELETE để phân quyền; dữ liệu refetch
// vẫn đi qua query/RPC authorization hiện có. Các bảng này chủ yếu xoá mềm (UPDATE).
// =============================================================

import { useEffect } from "react";
import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
// Import ĐỘNG prefetchPages (kéo theo hooks của 4 trang) — file này mount từ
// App (entry chunk), import tĩnh sẽ phồng bundle đầu vô ích.

// Danh sách bảng + union kiểu nay ở src/lib/realtime/syncTables.ts — module DỮ
// LIỆU THUẦN để scripts/check-realtime-descriptors.mjs đọc được mà không phải
// nạp React. Khai ở hai nơi thì hai nơi sẽ trôi khỏi nhau.
import { type SyncTable } from "@/lib/realtime/syncTables";
import { delayConTrongTran } from "@/lib/realtime/hubDebounce";
import { laTiengVongNoiBo, locTiengVongNoiBo } from "@/lib/realtime/localWriteEcho";
import { nenPrefetchTuHub } from "@/lib/realtime/prefetchGate";

// Re-export để mutation chỉ cần biết MỘT cửa: hub realtime.
export { markLocalWrite } from "@/lib/realtime/localWriteEcho";

// Descriptor nay TÁCH THEO MIỀN sang src/hooks/realtime/ (P1.8 của plan). Hub chỉ
// còn ba việc: mở channel, gom debounce, điều phối. Bản đồ 13 bảng → query key
// không còn nằm ở đây, và đó là điểm chính: người sửa màn thu chi không phải đọc
// qua phần điều phối để tìm dòng của mình.
//
// index.ts của thư mục đó KHÔNG chỉ là chỗ gom — nó đối chiếu tập descriptor với
// REALTIME_SYNC_TABLES. Tách một mảng thành nhiều file tạo ra một cách hỏng MỚI
// mà bản gộp không có (quên nối một miền vào hub), và hậu quả trùng khít với lớp
// lỗi mà cả hệ realtime này sinh ra để chống: im lặng tuyệt đối.
import {
  BUSINESS_PERFORMANCE_INVALIDATION_RULES,
  SYNC_ENTRIES as SYNC_TABLES,
  type BusinessPerformanceInvalidationRule,
  type SyncEntry,
} from "@/hooks/realtime";
import { createSettlementInvalidationCollector, isSettlementQueryKey } from '@/hooks/realtime/settlementInvalidation';

function matchesBusinessPerformanceRule(
  queryKey: readonly unknown[],
  rules: readonly BusinessPerformanceInvalidationRule[],
): boolean {
  const subtype = queryKey[2];
  return rules.some((rule) => {
    if (rule.subtype !== subtype) return false;
    return rule.subtype !== "pnl" || !rule.basis || queryKey[4] === rule.basis;
  });
}

function getBusinessPerformanceRules(
  table: SyncTable,
): readonly BusinessPerformanceInvalidationRule[] | undefined {
  return BUSINESS_PERFORMANCE_INVALIDATION_RULES[
    table as keyof typeof BUSINESS_PERFORMANCE_INVALIDATION_RULES
  ];
}

function flushBusinessPerformance(
  qc: QueryClient,
  pendingTables: ReadonlySet<SyncTable>,
) {
  const rules = Array.from(pendingTables).flatMap(
    (table) => getBusinessPerformanceRules(table) ?? [],
  );
  if (rules.length === 0) return;

  qc.invalidateQueries({
    queryKey: ["business-performance"],
    predicate: (query) =>
      matchesBusinessPerformanceRule(query.queryKey, rules),
  });
}

function flushEntry(qc: QueryClient, entry: SyncEntry, tiengVong: boolean) {
  // `tiengVong` = tiếng vọng của mutation vừa chạy trên CHÍNH máy này (xem
  // localWriteEcho.ts): gộp cả entry về một lượt chạm query active, bỏ hâm cache.
  if (tiengVong) {
    qc.invalidateQueries(locTiengVongNoiBo(entry.keys.filter((key) => !isSettlementQueryKey(key))));
  } else {
    for (const key of entry.keys) {
      if (key[0] === "business-performance" || isSettlementQueryKey(key)) continue;
      qc.invalidateQueries({ queryKey: key as unknown[] });
    }
  }
  // Hâm lại cache prefetch — chỉ khi tab đang mở (nền thì thôi, mở lại tab sẽ
  // theo staleTime tự lo) và qua được hai cửa ở prefetchGate.ts.
  if (
    entry.domain &&
    !tiengVong &&
    document.visibilityState === "visible" &&
    nenPrefetchTuHub(entry.domain)
  ) {
    const domain = entry.domain;
    import("@/lib/prefetchPages")
      .then((m) => m.prefetchDomain(qc, domain))
      .catch(() => {});
  }
}

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

/** Dựng channel + toàn bộ debounce; trả về hàm dọn. Tách khỏi effect để
 *  ref-count ở trên chỉ còn đúng một việc: đếm. */
function dungHub(qc: QueryClient, userId: string): () => void {
  {
    // Kèm mốc event ĐẦU của cụm để áp MAX_WAIT_MS. Giữ chung một Map thay vì
    // hai: một thứ phải dọn ở cleanup thay vì hai thứ phải nhớ.
    const timers = new Map<
      string,
      {
        timer: ReturnType<typeof setTimeout>;
        mocDauCum: number;
        tiengVong: boolean;
      }
    >();
    const pendingBusinessPerformanceTables = new Set<SyncTable>();
    let businessPerformanceTimer: ReturnType<typeof setTimeout> | undefined;
    let businessPerformanceMocDauCum = 0;
    const settlement = createSettlementInvalidationCollector(qc);
    let channel = supabase.channel(`crm-data-sync-${userId}`);
    for (const entry of SYNC_TABLES) {
      channel = channel.on(
        "postgres_changes",
        { event: "*", schema: "public", table: entry.table },
        () => {
          const bayGio = Date.now();
          settlement.enqueue(entry.table, bayGio);

          if (getBusinessPerformanceRules(entry.table)) {
            pendingBusinessPerformanceTables.add(entry.table);
            if (businessPerformanceTimer) {
              clearTimeout(businessPerformanceTimer);
            } else {
              // Không có timer đang chờ ⇒ đây là event đầu của cụm mới.
              businessPerformanceMocDauCum = bayGio;
            }
            businessPerformanceTimer = setTimeout(() => {
              businessPerformanceTimer = undefined;
              const pendingTables = new Set(pendingBusinessPerformanceTables);
              pendingBusinessPerformanceTables.clear();
              flushBusinessPerformance(qc, pendingTables);
            }, delayConTrongTran(businessPerformanceMocDauCum, bayGio));
          }

          if (!entry.domain && !entry.keys.some((key) =>
            key[0] !== "business-performance" && !isSettlementQueryKey(key))) return;

          const prev = timers.get(entry.table);
          if (prev) clearTimeout(prev.timer);
          const mocDauCum = prev ? prev.mocDauCum : bayGio;
          // Chỉ VÀ mới đúng: event nằm ngoài cửa sổ có thể đến từ máy khác, nên
          // cả cụm chứa nó phải đi đường đầy đủ.
          const tiengVong =
            (prev?.tiengVong ?? true) && laTiengVongNoiBo(entry.table, bayGio);
          timers.set(entry.table, {
            mocDauCum,
            tiengVong,
            timer: setTimeout(() => {
              timers.delete(entry.table);
              flushEntry(qc, entry, tiengVong);
            }, delayConTrongTran(mocDauCum, bayGio)),
          });
        },
      );
    }
    // Cờ phân biệt "ta chủ động dọn" với "kênh chết". CLOSED bắn ở CẢ HAI
    // trường hợp, nên thiếu cờ này thì mỗi lần unmount lại sinh một dòng cảnh
    // báo giả — và một cảnh báo kêu cả lúc bình thường thì không ai đọc nữa.
    let dangTuDon = false;

    // Trước đây là `channel.subscribe()` trần: CHANNEL_ERROR / TIMED_OUT /
    // CLOSED đều trôi qua không dấu vết, nên mất đồng bộ realtime là mất IM
    // LẶNG — giao diện chỉ đơn giản ngừng tự cập nhật, không ai biết để bấm F5.
    channel.subscribe((status, err) => {
      if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") {
        console.warn(`[realtime] hub ${status}`, err?.message ?? "");
        return;
      }
      if (status === "CLOSED" && !dangTuDon) {
        console.warn("[realtime] hub CLOSED ngoài ý muốn — mất đồng bộ tại chỗ");
      }
    });

    return () => {
      dangTuDon = true;
      timers.forEach((t) => clearTimeout(t.timer));
      if (businessPerformanceTimer) clearTimeout(businessPerformanceTimer);
      settlement.dispose();
      pendingBusinessPerformanceTables.clear();
      supabase.removeChannel(channel);
    };
  }
}

/** Component tiện mount trong App — hook cần nằm dưới QueryClientProvider. */
export function RealtimeDataSync(): null {
  useRealtimeDataSync();
  return null;
}
