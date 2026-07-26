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
import type { PrefetchDomain } from "@/lib/prefetchPages";

type SyncTable =
  | "invoices"
  | "income_expenses"
  | "contracts"
  | "rooms"
  | "buildings"
  | "jobs"
  | "customers";

type BusinessPerformanceSubtype =
  | "organizations"
  | "pnl"
  | "snapshot"
  | "occupancy-snapshot"
  | "upcoming-vacancy"
  | "occupancy-trend-12m";

type BusinessPerformanceInvalidationRule =
  | {
      subtype: "pnl";
      basis?: "ACCRUAL" | "VOUCHER_DATE";
    }
  | {
      subtype: Exclude<BusinessPerformanceSubtype, "pnl">;
    };

interface SyncEntry {
  table: SyncTable;
  /** Prefix query key sẽ invalidate khi bảng đổi. */
  keys: readonly (readonly unknown[])[];
  /** Domain prefetch cần hâm lại (nếu là trang được prefetch từ màn chính). */
  domain?: PrefetchDomain;
}

const BUSINESS_PERFORMANCE_OCCUPANCY_RULES = [
  { subtype: "snapshot" },
  { subtype: "occupancy-snapshot" },
  { subtype: "upcoming-vacancy" },
  { subtype: "occupancy-trend-12m" },
] as const satisfies readonly BusinessPerformanceInvalidationRule[];

const BUSINESS_PERFORMANCE_INVALIDATION_RULES = {
  invoices: [
    { subtype: "pnl", basis: "ACCRUAL" },
    { subtype: "snapshot" },
  ],
  income_expenses: [{ subtype: "pnl" }],
  contracts: BUSINESS_PERFORMANCE_OCCUPANCY_RULES,
  rooms: BUSINESS_PERFORMANCE_OCCUPANCY_RULES,
  buildings: [
    { subtype: "organizations" },
    { subtype: "pnl" },
    ...BUSINESS_PERFORMANCE_OCCUPANCY_RULES,
  ],
} as const satisfies Partial<
  Record<SyncTable, readonly BusinessPerformanceInvalidationRule[]>
>;

// dashboard-summary đi kèm invoices/income_expenses/contracts để KPI màn
// chính cũng nhảy số theo (RPC có staleTime 5ph — realtime rút ngắn độ trễ).
//
// LƯU Ý BẢO TRÌ: invalidate khớp theo PREFIX mảng — key cùng phần tử đầu được
// phủ sẵn (vd ["income-expenses","stats",…], ["income-expenses","accrual-month",…]).
// Nhưng mọi màn đọc từ các bảng này bằng key CÓ PHẦN TỬ ĐẦU KHÁC thì PHẢI liệt kê
// tường minh ở đây, nếu không nó sẽ kẹt dữ liệu cũ khi thay đổi đến từ client
// khác. Thêm màn/hook mới đọc các bảng này ⇒ nhớ bổ sung key tương ứng.
// (Xem docs/he-thong/realtime-sync.md để biết đầy đủ bản đồ bảng → query key.)
const SYNC_TABLES: SyncEntry[] = [
  {
    table: "invoices",
    keys: [
      ["invoices"],
      ["invoice"], // chi tiết 1 hoá đơn (số ít ≠ "invoices")
      ["invoices-legacy"],
      ["invoice-statistics"],
      ["invoice-totals-by-ids"],
      ["first-invoice-details"],
      ["invoice-rent-periods"],
      ["invoice-collectors"], // quy công thu (đọc invoices + income_expenses)
      ["unpaid-invoices"],
      ["dashboard-alerts"],
      ["recent-activities"],
      ["dashboard-summary"],
      ["business-performance"],
    ],
    domain: "invoices",
  },
  {
    table: "income_expenses",
    keys: [
      ["income-expenses"],
      ["deposit-dashboard"],
      ["reservation-deposits"],
      ["dashboard-summary"],
      // --- màn nghiệp vụ đọc income_expenses bằng key riêng (Nhóm A) ---
      ["utility-payments"], // "Đóng điện nước" — trạng thái đã đóng
      ["utility-accounts"],
      ["accounts-with-balance"], // số dư sổ quỹ
      ["cash-book"],
      ["cash-book-summary"],
      ["cash-flow-by-day"],
      ["handover-vouchers"], // bàn giao tiền
      ["invoice-collectors"], // quy công thu
      ["manager-salary"], // bảng lương quản lý
      ["voucher-with-batch"], // chi tiết phiếu
      ["orphan-deposit-vouchers"],
      ["contract-deposit-vouchers"],
      ["shareholder-distributions"],
      ["manager-salary-payouts"],
      ["change-breakdown"], // sổ thối
      ["commission-prefill"],
      ["business-performance"],
    ],
    domain: "income-expenses",
  },
  {
    // Prefix ["contracts"] phủ luôn "paged"/"stats"/"dashboard-counts".
    table: "contracts",
    keys: [
      ["contracts"],
      ["contracts-legacy"],
      // deposit-dashboard đọc contracts + contract_terminations (KHÔNG phải
      // income_expenses) → phải gắn vào ĐÂY mới live theo thay đổi HĐ.
      ["deposit-dashboard"],
      ["unpaid-invoices"],
      ["dashboard-alerts"],
      ["recent-activities"],
      ["dashboard-summary"],
      ["business-performance"],
    ],
    domain: "contracts",
  },
  { table: "rooms", keys: [["business-performance"]] },
  {
    table: "buildings",
    keys: [["business-performance"]],
  },
  { table: "jobs", keys: [["jobs"]], domain: "jobs" },
  { table: "customers", keys: [["customers"], ["customer-stats"]] },
];

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
