import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  QueryObserver,
  type QueryClient as QueryClientType,
} from "@tanstack/react-query";

type RealtimeHandler = () => void;

const harness = vi.hoisted(() => {
  const handlers = new Map<string, RealtimeHandler>();
  const channel = {
    on: vi.fn(),
    subscribe: vi.fn(),
  };
  return {
    handlers,
    channel,
    cleanup: undefined as void | (() => void),
    queryClient: undefined as unknown as QueryClientType,
    invalidateQueries: vi.fn(),
    removeChannel: vi.fn(),
    channelFactory: vi.fn(() => channel),
    useEffect: vi.fn(),
  };
});

vi.mock("react", () => ({
  useEffect: harness.useEffect,
}));

vi.mock("@tanstack/react-query", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tanstack/react-query")>();
  return {
    ...actual,
    useQueryClient: () => ({ invalidateQueries: harness.invalidateQueries }),
  };
});

vi.mock("@/hooks/useAuth", () => ({
  useAuth: () => ({ data: { id: "user-a" } }),
}));

vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    channel: harness.channelFactory,
    removeChannel: harness.removeChannel,
  },
}));

import { useRealtimeDataSync } from "@/hooks/useRealtimeDataSync";
import { QueryClient } from "@tanstack/react-query";

const NEW_REPORT_ROOTS = new Set([
  "business-performance",
  "occupancy-dashboard",
]);

const businessPerformanceKeys = {
  organizations: ["business-performance", "user-a", "organizations"],
  pnlAccrual: [
    "business-performance",
    "user-a",
    "pnl",
    "org-a",
    "ACCRUAL",
    "2026-01-01",
    "2026-12-31",
    ["building-a"],
  ],
  pnlVoucherDate: [
    "business-performance",
    "user-a",
    "pnl",
    "org-a",
    "VOUCHER_DATE",
    "2026-01-01",
    "2026-12-31",
    ["building-a"],
  ],
  snapshot: [
    "business-performance",
    "user-a",
    "snapshot",
    "org-a",
    ["building-a"],
  ],
  occupancySnapshot: [
    "business-performance",
    "user-a",
    "occupancy-snapshot",
    "org-a",
    "2026-07-26",
    ["building-a"],
  ],
  upcomingVacancy: [
    "business-performance",
    "user-a",
    "upcoming-vacancy",
    "org-a",
    "2026-07-26",
    90,
    ["building-a"],
  ],
  occupancyTrend12m: [
    "business-performance",
    "user-a",
    "occupancy-trend-12m",
    "org-a",
    "2025-08-01",
    "2026-07-01",
    ["building-a"],
  ],
} as const;

type BusinessPerformanceQueryName = keyof typeof businessPerformanceKeys;

const expectedBusinessPerformanceInvalidations = {
  invoices: ["pnlAccrual", "snapshot"],
  income_expenses: ["pnlAccrual", "pnlVoucherDate"],
  contracts: [
    "snapshot",
    "occupancySnapshot",
    "upcomingVacancy",
    "occupancyTrend12m",
  ],
  rooms: [
    "snapshot",
    "occupancySnapshot",
    "upcomingVacancy",
    "occupancyTrend12m",
  ],
  buildings: [
    "organizations",
    "pnlAccrual",
    "pnlVoucherDate",
    "snapshot",
    "occupancySnapshot",
    "upcomingVacancy",
    "occupancyTrend12m",
  ],
  jobs: [],
  customers: [],
} as const satisfies Record<string, readonly BusinessPerformanceQueryName[]>;

function invalidatedReportRoots() {
  return harness.invalidateQueries.mock.calls
    .map(([filters]) => filters.queryKey as unknown[])
    .filter((queryKey) => NEW_REPORT_ROOTS.has(String(queryKey[0])));
}

function invalidatedRoots() {
  return harness.invalidateQueries.mock.calls.map(([filters]) =>
    String((filters.queryKey as unknown[])[0]),
  );
}

function seedBusinessPerformanceQueries() {
  for (const queryKey of Object.values(businessPerformanceKeys)) {
    harness.queryClient.setQueryData(queryKey, []);
  }
}

function invalidatedBusinessPerformanceQueries(): BusinessPerformanceQueryName[] {
  return (
    Object.entries(businessPerformanceKeys) as Array<
      [BusinessPerformanceQueryName, readonly unknown[]]
    >
  )
    .filter(([, queryKey]) =>
      Boolean(harness.queryClient.getQueryState(queryKey)?.isInvalidated),
    )
    .map(([name]) => name);
}

function getRealtimeHandler(table: string) {
  const handler = harness.handlers.get(table);
  expect(handler, `Missing realtime handler for ${table}`).toBeTypeOf(
    "function",
  );
  return handler as RealtimeHandler;
}

function triggerTable(table: string) {
  getRealtimeHandler(table)();
  vi.advanceTimersByTime(800);
}

describe("useRealtimeDataSync report invalidation", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal("document", { visibilityState: "hidden" });
    harness.handlers.clear();
    harness.queryClient = new QueryClient();
    harness.invalidateQueries.mockReset();
    harness.invalidateQueries.mockImplementation((filters) =>
      harness.queryClient.invalidateQueries(filters),
    );
    harness.removeChannel.mockReset();
    harness.channelFactory.mockClear();
    harness.channel.on.mockReset();
    harness.channel.subscribe.mockReset();
    harness.channel.on.mockImplementation(
      (
        _event: string,
        filter: { table: string },
        handler: RealtimeHandler,
      ) => {
        harness.handlers.set(filter.table, handler);
        return harness.channel;
      },
    );
    harness.useEffect.mockReset();
    harness.useEffect.mockImplementation((effect: () => void | (() => void)) => {
      harness.cleanup = effect();
    });
    harness.cleanup = undefined;
  });

  afterEach(() => {
    if (typeof harness.cleanup === "function") {
      harness.cleanup();
    }
    harness.queryClient.clear();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it.each([
    ["invoices", [["business-performance"]]],
    ["income_expenses", [["business-performance"]]],
    ["contracts", [["business-performance"], ["occupancy-dashboard"]]],
    ["rooms", [["business-performance"]]],
    ["buildings", [["business-performance"]]],
    ["jobs", []],
    ["customers", []],
  ])("invalidates exact report roots for %s", (table, expectedRoots) => {
    useRealtimeDataSync();

    expect(harness.handlers.has(table)).toBe(true);
    harness.handlers.get(table)?.();
    vi.advanceTimersByTime(800);

    expect(invalidatedReportRoots()).toEqual(expectedRoots);
  });

  it("registers every realtime table exactly once per mount", () => {
    useRealtimeDataSync();

    const registeredTables = harness.channel.on.mock.calls.map(
      ([, filter]) => (filter as { table: string }).table,
    );
    expect(registeredTables).toEqual([
      "invoices",
      "income_expenses",
      "contracts",
      "rooms",
      "buildings",
      "jobs",
      "customers",
      // Rủi ro #5 của plan thu chi: bốn bảng TIỀN trước đây thiếu hẳn. Phiếu
      // giờ sửa/huỷ/chốt được (Đợt 4/5/6) nên không đồng bộ là hai người đối
      // chiếu quỹ đọc ra hai số.
      "payments",
      "income_expense_items",
      "accounts",
      "cash_handovers",
    ]);
    expect(new Set(registeredTables).size).toBe(registeredTables.length);
  });

  it.each(Object.entries(expectedBusinessPerformanceInvalidations))(
    "invalidates the exact Business Performance subtype matrix for %s",
    (table, expectedQueries) => {
      seedBusinessPerformanceQueries();

      useRealtimeDataSync();
      triggerTable(table);

      expect(invalidatedBusinessPerformanceQueries()).toEqual(expectedQueries);
    },
  );

  it("refetches only active queries targeted by an invoice change", async () => {
    const fetchers = {} as Record<
      BusinessPerformanceQueryName,
      ReturnType<typeof vi.fn>
    >;
    const unsubscribers: Array<() => void> = [];

    seedBusinessPerformanceQueries();
    for (const [name, queryKey] of Object.entries(businessPerformanceKeys) as Array<
      [BusinessPerformanceQueryName, readonly unknown[]]
    >) {
      const queryFn = vi.fn(async () => `fresh-${name}`);
      fetchers[name] = queryFn;
      const observer = new QueryObserver(harness.queryClient, {
        queryKey,
        queryFn,
        staleTime: Infinity,
      });
      unsubscribers.push(observer.subscribe(() => {}));
    }

    try {
      useRealtimeDataSync();
      triggerTable("invoices");

      await vi.waitFor(() => {
        expect(fetchers.pnlAccrual).toHaveBeenCalledTimes(1);
        expect(fetchers.snapshot).toHaveBeenCalledTimes(1);
      });
      for (const [name, queryFn] of Object.entries(fetchers) as Array<
        [BusinessPerformanceQueryName, ReturnType<typeof vi.fn>]
      >) {
        const expectedCalls = ["pnlAccrual", "snapshot"].includes(name)
          ? 1
          : 0;
        expect(queryFn, name).toHaveBeenCalledTimes(expectedCalls);
      }
    } finally {
      unsubscribers.forEach((unsubscribe) => unsubscribe());
    }
  });

  it("coalesces invoice and income changes into one Business Performance refresh", async () => {
    const fetchers = {} as Record<
      BusinessPerformanceQueryName,
      ReturnType<typeof vi.fn>
    >;
    const unsubscribers: Array<() => void> = [];

    seedBusinessPerformanceQueries();
    for (const [name, queryKey] of Object.entries(businessPerformanceKeys) as Array<
      [BusinessPerformanceQueryName, readonly unknown[]]
    >) {
      const queryFn = vi.fn(async () => `fresh-${name}`);
      fetchers[name] = queryFn;
      const observer = new QueryObserver(harness.queryClient, {
        queryKey,
        queryFn,
        staleTime: Infinity,
      });
      unsubscribers.push(observer.subscribe(() => {}));
    }

    try {
      useRealtimeDataSync();
      getRealtimeHandler("invoices")();
      getRealtimeHandler("income_expenses")();
      vi.advanceTimersByTime(800);

      await vi.waitFor(() => {
        expect(fetchers.pnlAccrual).toHaveBeenCalledTimes(1);
        expect(fetchers.pnlVoucherDate).toHaveBeenCalledTimes(1);
        expect(fetchers.snapshot).toHaveBeenCalledTimes(1);
      });
      expect(invalidatedReportRoots()).toEqual([["business-performance"]]);
      for (const [name, queryFn] of Object.entries(fetchers) as Array<
        [BusinessPerformanceQueryName, ReturnType<typeof vi.fn>]
      >) {
        const expectedCalls = [
          "pnlAccrual",
          "pnlVoucherDate",
          "snapshot",
        ].includes(name)
          ? 1
          : 0;
        expect(queryFn, name).toHaveBeenCalledTimes(expectedCalls);
      }
    } finally {
      unsubscribers.forEach((unsubscribe) => unsubscribe());
    }
  });

  it("coalesces contract and room changes without duplicate occupancy refreshes", async () => {
    const fetchers = {} as Record<
      BusinessPerformanceQueryName,
      ReturnType<typeof vi.fn>
    >;
    const unsubscribers: Array<() => void> = [];

    seedBusinessPerformanceQueries();
    for (const [name, queryKey] of Object.entries(businessPerformanceKeys) as Array<
      [BusinessPerformanceQueryName, readonly unknown[]]
    >) {
      const queryFn = vi.fn(async () => `fresh-${name}`);
      fetchers[name] = queryFn;
      const observer = new QueryObserver(harness.queryClient, {
        queryKey,
        queryFn,
        staleTime: Infinity,
      });
      unsubscribers.push(observer.subscribe(() => {}));
    }

    try {
      useRealtimeDataSync();
      getRealtimeHandler("contracts")();
      getRealtimeHandler("rooms")();
      vi.advanceTimersByTime(800);

      await vi.waitFor(() => {
        expect(fetchers.snapshot).toHaveBeenCalledTimes(1);
        expect(fetchers.occupancySnapshot).toHaveBeenCalledTimes(1);
        expect(fetchers.upcomingVacancy).toHaveBeenCalledTimes(1);
        expect(fetchers.occupancyTrend12m).toHaveBeenCalledTimes(1);
      });
      expect(invalidatedReportRoots()).toEqual([
        ["occupancy-dashboard"],
        ["business-performance"],
      ]);
      for (const [name, queryFn] of Object.entries(fetchers) as Array<
        [BusinessPerformanceQueryName, ReturnType<typeof vi.fn>]
      >) {
        const expectedCalls = [
          "snapshot",
          "occupancySnapshot",
          "upcomingVacancy",
          "occupancyTrend12m",
        ].includes(name)
          ? 1
          : 0;
        expect(queryFn, name).toHaveBeenCalledTimes(expectedCalls);
      }
    } finally {
      unsubscribers.forEach((unsubscribe) => unsubscribe());
    }
  });

  it("keeps table invalidations independent and cancels a pending shared BP flush", () => {
    useRealtimeDataSync();
    getRealtimeHandler("contracts")();
    vi.advanceTimersByTime(400);
    getRealtimeHandler("rooms")();
    vi.advanceTimersByTime(400);

    expect(invalidatedRoots()).toEqual([
      "contracts",
      "contracts-legacy",
      "deposit-dashboard",
      "unpaid-invoices",
      "dashboard-alerts",
      "recent-activities",
      "dashboard-summary",
      "occupancy-dashboard",
    ]);

    const cleanup = harness.cleanup;
    expect(cleanup).toBeTypeOf("function");
    if (typeof cleanup !== "function") throw new Error("Missing cleanup");
    cleanup();
    harness.cleanup = undefined;
    vi.advanceTimersByTime(800);

    expect(invalidatedRoots()).not.toContain("business-performance");
    expect(harness.invalidateQueries).toHaveBeenCalledTimes(8);
    expect(harness.removeChannel).toHaveBeenCalledTimes(1);
  });

  it("debounces a same-table burst into one invalidation", () => {
    useRealtimeDataSync();
    const handler = getRealtimeHandler("rooms");

    handler();
    vi.advanceTimersByTime(400);
    handler();
    vi.advanceTimersByTime(799);
    expect(harness.invalidateQueries).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(harness.invalidateQueries).toHaveBeenCalledTimes(1);
    expect(invalidatedRoots()).toEqual(["business-performance"]);
  });

  it("cancels pending invalidation during cleanup", () => {
    useRealtimeDataSync();
    getRealtimeHandler("rooms")();

    const cleanup = harness.cleanup;
    expect(cleanup).toBeTypeOf("function");
    if (typeof cleanup !== "function") throw new Error("Missing cleanup");
    cleanup();
    harness.cleanup = undefined;
    vi.advanceTimersByTime(800);

    expect(harness.invalidateQueries).not.toHaveBeenCalled();
    expect(harness.removeChannel).toHaveBeenCalledTimes(1);
  });

  it.each(["rooms", "buildings"])(
    "invalidates only the Business Performance root for %s",
    (table) => {
      useRealtimeDataSync();
      triggerTable(table);

      expect(invalidatedRoots()).toEqual(["business-performance"]);
    },
  );
});
