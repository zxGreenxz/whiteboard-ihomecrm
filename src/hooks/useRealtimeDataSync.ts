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

const DEBOUNCE_MS = 800;

// TRẦN CHỜ — thứ mà debounce 800ms ở trên KHÔNG có, và thiếu nó thì lời hứa
// "gộp cơn bão về 1 lần invalidate" ở đầu file chỉ đúng SAU KHI bão tan.
//
// DEBOUNCE_MS là trailing-edge thuần: mỗi event clearTimeout rồi đặt lại. Một
// đợt bulk bắn event dày hơn 1 lần/800ms (sinh hoá đơn hàng loạt, import thu
// chi — đúng những việc mà chú thích đầu file lấy làm ví dụ) đẩy lùi flush VÔ
// HẠN. Trong suốt đợt đó giao diện đứng số mà không có tín hiệu nào: không lỗi,
// không cảnh báo, người dùng chỉ thấy màn hình không đổi.
//
// MAX_WAIT_MS là mốc muộn nhất tính từ event ĐẦU TIÊN của cụm. Chọn 3×: đủ xa
// để vẫn gộp được một cụm bình thường (một thao tác người dùng hiếm khi kéo quá
// 2,4 giây), đủ gần để một đợt bulk vẫn nhả tin về màn hình vài lần thay vì im
// bặt tới lúc xong.
const MAX_WAIT_MS = DEBOUNCE_MS * 3;

/**
 * Thời gian còn được phép chờ: bình thường là trọn DEBOUNCE_MS, nhưng không bao
 * giờ vượt quá mốc trần tính từ event đầu cụm. Trả về 0 khi đã quá hạn — timer
 * 0ms vẫn chạy bất đồng bộ nên thứ tự vẫn đúng.
 */
function delayConTrongTran(mocDauCum: number, bayGio: number): number {
  return Math.max(0, Math.min(DEBOUNCE_MS, mocDauCum + MAX_WAIT_MS - bayGio));
}

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

function flushEntry(qc: QueryClient, entry: SyncEntry) {
  for (const key of entry.keys) {
    if (key[0] === "business-performance") continue;
    qc.invalidateQueries({ queryKey: key as unknown[] });
  }
  // Hâm lại cache prefetch — chỉ khi tab đang mở (nền thì thôi, mở lại
  // tab sẽ theo staleTime tự lo).
  if (entry.domain && document.visibilityState === "visible") {
    const domain = entry.domain;
    import("@/lib/prefetchPages")
      .then((m) => m.prefetchDomain(qc, domain))
      .catch(() => {});
  }
}

// Guard chống mở 2 channel trùng (StrictMode double-mount / lỡ mount 2 nơi).
let hubActive = false;

export function useRealtimeDataSync() {
  const qc = useQueryClient();
  const { data: user } = useAuth();
  const userId = user?.id ?? null;

  useEffect(() => {
    if (!userId || hubActive) return;
    hubActive = true;

    // Kèm mốc event ĐẦU của cụm để áp MAX_WAIT_MS. Giữ chung một Map thay vì
    // hai: một thứ phải dọn ở cleanup thay vì hai thứ phải nhớ.
    const timers = new Map<
      string,
      { timer: ReturnType<typeof setTimeout>; mocDauCum: number }
    >();
    const pendingBusinessPerformanceTables = new Set<SyncTable>();
    let businessPerformanceTimer: ReturnType<typeof setTimeout> | undefined;
    let businessPerformanceMocDauCum = 0;
    let channel = supabase.channel(`crm-data-sync-${userId}`);
    for (const entry of SYNC_TABLES) {
      channel = channel.on(
        "postgres_changes",
        { event: "*", schema: "public", table: entry.table },
        () => {
          const bayGio = Date.now();

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

          const hasTableScopedWork =
            entry.domain ||
            entry.keys.some((key) => key[0] !== "business-performance");
          if (!hasTableScopedWork) return;

          const prev = timers.get(entry.table);
          if (prev) clearTimeout(prev.timer);
          const mocDauCum = prev ? prev.mocDauCum : bayGio;
          timers.set(entry.table, {
            mocDauCum,
            timer: setTimeout(() => {
              timers.delete(entry.table);
              flushEntry(qc, entry);
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
      hubActive = false;
      timers.forEach((t) => clearTimeout(t.timer));
      if (businessPerformanceTimer) clearTimeout(businessPerformanceTimer);
      pendingBusinessPerformanceTables.clear();
      supabase.removeChannel(channel);
    };
  }, [userId, qc]);
}

/** Component tiện mount trong App — hook cần nằm dưới QueryClientProvider. */
export function RealtimeDataSync(): null {
  useRealtimeDataSync();
  return null;
}
