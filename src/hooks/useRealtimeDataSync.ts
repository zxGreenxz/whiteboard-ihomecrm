// =============================================================
// useRealtimeDataSync — hub realtime TRUNG TÂM cho dữ liệu nghiệp vụ.
//
// Mount 1 lần ở App (component <RealtimeDataSync/>). Lắng nghe
// postgres_changes trên các bảng nghiệp vụ (đã ADD vào publication
// supabase_realtime — migration 20260704120000) và khi có thay đổi:
//   1. Invalidate các query key liên quan → trang đang mở refetch tại chỗ
//      (giữ data cũ trên màn trong lúc fetch, không nháy "Đang tải").
//   2. Re-prefetch trang đầu của domain đó (prefetchDomain) → cache prefetch
//      từ màn chính LUÔN ẤM, quay lại trang vẫn hiện ngay dữ liệu mới.
//
// Debounce 800ms/bảng theo đúng bài học Zalo 26/06 (useZaloRealtime): thao
// tác bulk (sinh hoá đơn hàng loạt, import thu chi…) bắn 1 event/dòng — gộp
// cơn bão đó về 1 lần invalidate, tuyệt đối không refetch theo từng event.
//
// RLS vẫn kiểm soát: mỗi client chỉ nhận event của dòng nó SELECT được
// (payload bị bỏ qua — chỉ dùng làm tín hiệu). Sự kiện DELETE chỉ mang PK;
// các bảng này xoá mềm (deleted_at → UPDATE) nên không thành vấn đề.
// =============================================================

import { useEffect } from "react";
import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
// Import ĐỘNG prefetchPages (kéo theo hooks của 4 trang) — file này mount từ
// App (entry chunk), import tĩnh sẽ phồng bundle đầu vô ích.
import type { PrefetchDomain } from "@/lib/prefetchPages";

interface SyncEntry {
  table: string;
  /** Prefix query key sẽ invalidate khi bảng đổi. */
  keys: readonly (readonly unknown[])[];
  /** Domain prefetch cần hâm lại (nếu là trang được prefetch từ màn chính). */
  domain?: PrefetchDomain;
}

// dashboard-summary đi kèm invoices/income_expenses/contracts để KPI màn
// chính cũng nhảy số theo (RPC có staleTime 5ph — realtime rút ngắn độ trễ).
const SYNC_TABLES: SyncEntry[] = [
  {
    table: "invoices",
    keys: [["invoices"], ["invoice-statistics"], ["dashboard-summary"]],
    domain: "invoices",
  },
  {
    table: "income_expenses",
    keys: [
      ["income-expenses"],
      ["deposit-dashboard"],
      ["reservation-deposits"],
      ["dashboard-summary"],
    ],
    domain: "income-expenses",
  },
  {
    // Prefix ["contracts"] phủ luôn "paged"/"stats"/"dashboard-counts".
    table: "contracts",
    keys: [["contracts"], ["dashboard-summary"]],
    domain: "contracts",
  },
  { table: "jobs", keys: [["jobs"]], domain: "jobs" },
  { table: "customers", keys: [["customers"], ["customer-stats"]] },
];

const DEBOUNCE_MS = 800;

function flushEntry(qc: QueryClient, entry: SyncEntry) {
  for (const key of entry.keys) {
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
    let channel = supabase.channel(`crm-data-sync-${userId}`);
    for (const entry of SYNC_TABLES) {
      channel = channel.on(
        "postgres_changes",
        { event: "*", schema: "public", table: entry.table },
        () => {
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
      supabase.removeChannel(channel);
    };
  }, [userId, qc]);
}

/** Component tiện mount trong App — hook cần nằm dưới QueryClientProvider. */
export function RealtimeDataSync() {
  useRealtimeDataSync();
  return null;
}
