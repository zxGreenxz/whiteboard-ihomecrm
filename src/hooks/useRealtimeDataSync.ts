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

    const timers = new Map<string, ReturnType<typeof setTimeout>>();
    const pendingBusinessPerformanceTables = new Set<SyncTable>();
    let businessPerformanceTimer: ReturnType<typeof setTimeout> | undefined;
    let channel = supabase.channel(`crm-data-sync-${userId}`);
    for (const entry of SYNC_TABLES) {
      channel = channel.on(
        "postgres_changes",
        { event: "*", schema: "public", table: entry.table },
        () => {
          if (getBusinessPerformanceRules(entry.table)) {
            pendingBusinessPerformanceTables.add(entry.table);
            if (businessPerformanceTimer) {
              clearTimeout(businessPerformanceTimer);
            }
            businessPerformanceTimer = setTimeout(() => {
              businessPerformanceTimer = undefined;
              const pendingTables = new Set(pendingBusinessPerformanceTables);
              pendingBusinessPerformanceTables.clear();
              flushBusinessPerformance(qc, pendingTables);
            }, DEBOUNCE_MS);
          }

          const hasTableScopedWork =
            entry.domain ||
            entry.keys.some((key) => key[0] !== "business-performance");
          if (!hasTableScopedWork) return;

          const prev = timers.get(entry.table);
          if (prev) clearTimeout(prev);
          timers.set(
            entry.table,
            setTimeout(() => {
              timers.delete(entry.table);
              flushEntry(qc, entry);
            }, DEBOUNCE_MS),
          );
        },
      );
    }
    channel.subscribe();

    return () => {
      hubActive = false;
      timers.forEach((t) => clearTimeout(t));
      if (businessPerformanceTimer) clearTimeout(businessPerformanceTimer);
      pendingBusinessPerformanceTables.clear();
      supabase.removeChannel(channel);
    };
  }, [userId, qc]);
}

/** Component tiện mount trong App — hook cần nằm dưới QueryClientProvider. */
export function RealtimeDataSync() {
  useRealtimeDataSync();
  return null;
}
