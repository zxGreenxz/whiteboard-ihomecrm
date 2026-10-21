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
    prefetchDomain: vi.fn(),
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

// prefetchPages kéo theo hooks của 4 trang (supabase client, permission…) — hub
// import ĐỘNG nó, nên mock ở đây vừa giữ test nhẹ vừa cho phép ĐẾM số lần hâm
// cache. Cửa chặn route/throttle nằm ở prefetchGate, KHÔNG bị mock.
// Từ 21/10 hub gọi prefetchDomainTuHub (kiểm quyền xem domain rồi mới
// prefetchDomain) — phần kiểm quyền có test riêng ở prefetchDomainTuHub.test.ts.
vi.mock("@/lib/prefetchPages", () => ({
  prefetchDomain: harness.prefetchDomain,
  prefetchDomainTuHub: harness.prefetchDomain,
}));

import {
  useRealtimeDataSync,
  __hubRefsForTest,
  markLocalWrite,
} from "@/hooks/useRealtimeDataSync";
// Nạp sẵn module ĐÃ MOCK ở trên. Với fake timers, lần `import()` ĐẦU TIÊN cần
// một nhịp thật của event loop nên không resolve trong microtask — thiếu dòng
// này thì ca prefetch đo nhầm thành "hub không gọi" dù hub có gọi.
import "@/lib/prefetchPages";
import { __resetLocalWriteEchoForTest } from "@/lib/realtime/localWriteEcho";
import { __resetPrefetchGateForTest } from "@/lib/realtime/prefetchGate";
import { QueryClient } from "@tanstack/react-query";

/** Đẩy hết microtask đang chờ — dynamic import của hub resolve ở đây. */
async function xaMicrotask() {
  for (let i = 0; i < 50; i += 1) await Promise.resolve();
}

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

// Existing domain budgets stay scoped to those domains; settlement has its own burst test.
function originalInvalidations() {
  return harness.invalidateQueries.mock.calls.filter(([filters]) =>
    !['contract-settlement', 'termination-refund-facts', 'commission-voucher-facts'].includes(String(filters.queryKey?.[0])));
}

function invalidatedRoots() {
  return originalInvalidations().map(([filters]) =>
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
    // Hai sổ cấp MODULE: mốc "vừa tự ghi" và mốc prefetch gần nhất. Không dọn thì
    // ca sau thừa hưởng mốc của ca trước và xanh/đỏ theo thứ tự chạy.
    __resetLocalWriteEchoForTest();
    __resetPrefetchGateForTest();
    harness.prefetchDomain.mockReset();
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

  it('refreshes an active settlement query once for a burst across money tables', async () => {
    let starts = 0;
    const observer = new QueryObserver(harness.queryClient, {
      queryKey: ['contract-settlement', 'vouchers', 'org-a'],
      initialData: ['old'], staleTime: Infinity,
      queryFn: () => { starts += 1; return new Promise<string[]>(() => {}); },
    });
    const unsubscribe = observer.subscribe(() => {});
    useRealtimeDataSync();
    getRealtimeHandler('income_expenses')();
    getRealtimeHandler('income_expense_items')();
    getRealtimeHandler('accounts')();
    await vi.advanceTimersByTimeAsync(800);
    expect(starts).toBe(1);
    unsubscribe();
  });

  it.each(['termination-refund-facts', 'commission-voucher-facts'])('refreshes open modal %s once per cross-table burst', async (root) => {
    let starts = 0;
    const observer = new QueryObserver(harness.queryClient, {
      queryKey: [root, 'voucher-a'], initialData: { amount: 1 }, staleTime: Infinity,
      queryFn: () => { starts++; return new Promise<{ amount: number }>(() => {}); },
    });
    const unsubscribe = observer.subscribe(() => {});
    useRealtimeDataSync();
    getRealtimeHandler('income_expenses')();
    getRealtimeHandler('income_expense_items')();
    getRealtimeHandler('contracts')();
    await vi.advanceTimersByTimeAsync(800);
    expect(starts).toBe(1);
    unsubscribe();
  });

  it.each([
    ['income_expense_supplements', 'supplements'],
    ['invoices', 'lifecycle'],
    ['contracts', 'movements'],
    ['contract_terminations', 'lifecycle'],
    ['contract_transfers', 'lifecycle'],
    ['reservation_deposit_settlements', 'movements'],
    ['customers', 'vouchers'],
  ])('refreshes settlement %s dependency without invalidating unrelated type definitions', (table, subtype) => {
    const key = ['contract-settlement', subtype, 'org-a'];
    const typeKey = ['contract-settlement', 'types', 'org-a'];
    harness.queryClient.setQueryData(key, []);
    harness.queryClient.setQueryData(typeKey, []);
    useRealtimeDataSync();
    triggerTable(table);
    expect(harness.queryClient.getQueryState(key)?.isInvalidated).toBe(true);
    expect(harness.queryClient.getQueryState(typeKey)?.isInvalidated).toBe(false);
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

    // So theo TẬP: từ 21/10 cả cụm nhả trong một lượt (hubCollector) nên thứ tự
    // hai lời gọi báo cáo không còn phụ thuộc thứ tự đặt timer — thứ tự không
    // phải tính chất hành vi, "đúng gốc, mỗi gốc một lần" mới là.
    const sortRoots = (roots: readonly (readonly unknown[])[]) =>
      roots.map((root) => String(root[0])).sort();
    expect(sortRoots(invalidatedReportRoots())).toEqual(sortRoots(expectedRoots));
  });

  // 31/08 (audit /thanh-toan P2-01): C-INFRA-7 vá 4 khoá lưới phí nhưng bỏ quên
  // 3 sổ theo dõi (SettlementPanels) + biểu đồ Điện & Nước. Chốt cả cụm ở đây
  // để lần "vá thiếu khoá" sau không tái diễn im lặng.
  it.each(['income_expenses','income_expense_items','accounts'])('%s refreshes company wallet balances and reports',table=>{
    useRealtimeDataSync();
    harness.queryClient.setQueryData(['company-wallets','actor','organization'],{wallets:[],transactions:[]});
    triggerTable(table);
    expect(harness.queryClient.getQueryState(['company-wallets','actor','organization'])?.isInvalidated).toBe(true);
  });

  it("income_expenses invalidates 3 khoá lưới phí (C-INFRA-7) + sổ cọc tt-* + utility-chart (P2-01)", () => {
    useRealtimeDataSync();
    triggerTable("income_expenses");
    const roots = invalidatedRoots();
    for (const root of [
      "period-fee-status",
      "period-maintenance",
      "fee-accounts",
      "tt-deposit-ledger",
      "utility-chart",
    ]) {
      expect(roots, `thiếu invalidation cho ['${root}']`).toContain(root);
    }
  });

  it.each(["reservation_deposit_settlements", "income_expenses"])(
    "%s refreshes reservation balances, refund queue and source history",
    (table) => {
      const queryKeys = [
        ["reservation-deposits", "building-a"],
        ["reservation-settlements", "building-a", "PENDING"],
        ["reservation-settlement-summary", "building-a"],
        ["reservation-settlement-preview", "voucher-a"],
        ["reservation-settlement-by-voucher", "voucher-a"],
        ["reservation-refund-evidence", "settlement-a"],
        ["reservation-settlement-audit", "settlement-a"],
        ["voucher-with-batch", "voucher-a"],
        ["orphan-deposit-vouchers", "room-a"],
      ];
      for (const key of queryKeys) harness.queryClient.setQueryData(key, []);
      const unrelatedKey = ["customers", "building-a"];
      harness.queryClient.setQueryData(unrelatedKey, []);

      useRealtimeDataSync();
      triggerTable(table);

      for (const key of queryKeys) {
        expect(harness.queryClient.getQueryState(key)?.isInvalidated, key[0]).toBe(true);
      }
      expect(harness.queryClient.getQueryState(unrelatedKey)?.isInvalidated).toBe(false);
    },
  );

  it('supplements refresh visible notes/photos without invalidating money reports', () => {
    const keys = [['income-expense-supplements', 'voucher'], ['income-expenses'],
      ['voucher-with-batch', 'voucher'], ['income-expense', 'print', 'voucher'], ['reservation-refund-evidence', 'settlement']];
    for (const key of keys) harness.queryClient.setQueryData(key, []);
    harness.queryClient.setQueryData(['business-performance', 'pnl'], []);
    useRealtimeDataSync(); triggerTable('income_expense_supplements');
    for (const key of keys) expect(harness.queryClient.getQueryState(key)?.isInvalidated, key[0]).toBe(true);
    expect(harness.queryClient.getQueryState(['business-performance', 'pnl'])?.isInvalidated).toBe(false);
  });

  it("registers every realtime table exactly once per mount", () => {
    useRealtimeDataSync();

    const registeredTables = harness.channel.on.mock.calls.map(
      ([, filter]) => (filter as { table: string }).table,
    );
    // SO THEO TẬP, KHÔNG THEO THỨ TỰ.
    //
    // Bản trước so mảng theo đúng thứ tự khai. Thứ tự đăng ký handler không phải
    // tính chất hành vi — mỗi bảng một handler độc lập — nên nó chỉ tạo ra một
    // cách làm vỡ test mà không có lỗi nào: P1.8 tách descriptor theo miền
    // (finance/contracts/operations), thứ tự nối đổi, test đỏ trong khi không mất
    // một bảng nào. Hai tính chất THẬT SỰ cần chốt vẫn nguyên: đủ các bảng, và
    // mỗi bảng đúng MỘT lần (dòng expect cuối).
    expect([...registeredTables].sort()).toEqual([
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
      // Đợt 1: hai bảng VÒNG ĐỜI. Trước đó chúng không có trong publication
      // `supabase_realtime` (đo prod 30/07: publication có 21 bảng, thiếu đúng
      // hai bảng này) lẫn trong SYNC_TABLES ⇒ mọi thay đổi thanh lý / chuyển
      // phòng là im lặng hoàn toàn. Migration 20260731060000 thêm vào publication.
      "contract_terminations",
      "contract_transfers",
      // 28/08 (C-INFRA-7): hai bảng CẤU HÌNH PHÍ THEO TOÀ mà /thanh-toan đọc.
      // Publication: 20260828130000_realtime_building_fee_tables.sql.
      "building_fee_accounts",
      "building_utility_accounts",
      // Xử lý bỏ cọc phải cập nhật hàng chờ hoàn và lịch sử trên máy khác.
      "reservation_deposit_settlements",
      "income_expense_supplements",
      // 21/10/2026 (RT-HUB-6): công tơ — migration realtime_publication_toi_uu.
      "meter_readings",
      "meters",
    ].sort());
    expect(new Set(registeredTables).size).toBe(registeredTables.length);
  });

  // C-INFRA-6 (audit 27/08): bản cũ là cờ boolean — consumer thứ HAI return sớm
  // không cleanup, rồi consumer ĐẦU unmount là hạ cờ + removeChannel, để lại
  // consumer sống sót VĨNH VIỄN không subscribe. Ref-count phải chịu được hai
  // consumer: hub sống chừng nào còn ≥1, và channel chỉ bị remove khi consumer
  // CUỐI rời đi.
  it("hai consumer: hub sống tới khi consumer CUỐI unmount, không chết theo consumer đầu", () => {
    // Mock useEffect mặc định chỉ giữ MỘT cleanup (harness.cleanup) — hai
    // consumer cần giữ RIÊNG từng cleanup để unmount đúng thứ tự.
    const cleanups: Array<void | (() => void)> = [];
    harness.useEffect.mockImplementation((effect: () => void | (() => void)) => {
      cleanups.push(effect());
    });

    useRealtimeDataSync(); // consumer A
    useRealtimeDataSync(); // consumer B

    // Hai consumer nhưng chỉ MỘT channel được dựng.
    expect(harness.channelFactory).toHaveBeenCalledTimes(1);
    expect(__hubRefsForTest()).toBe(2);

    // Consumer đầu rời đi: hub PHẢI còn sống (bản cũ chết ngay tại đây —
    // cleanup của A hạ cờ + removeChannel trong khi B còn đứng nhìn).
    (cleanups[0] as () => void)();
    expect(__hubRefsForTest()).toBe(1);
    expect(harness.removeChannel).not.toHaveBeenCalled();

    // Consumer cuối rời đi: giờ mới được dọn.
    (cleanups[1] as () => void)();
    expect(__hubRefsForTest()).toBe(0);
    expect(harness.removeChannel).toHaveBeenCalledTimes(1);

    // afterEach đừng dọn đôi — cleanup đã chạy hết trong test này.
    harness.cleanup = undefined;
  });

  // Chốt chặn cho chính việc tách file ở P1.8: tách một mảng thành ba module tạo
  // ra một cách hỏng MỚI — quên nối một miền vào index — và hậu quả là im lặng
  // tuyệt đối cho đúng miền bị rơi. Ba hàm dưới đây đối chiếu tập descriptor với
  // danh sách bảng chuẩn, cùng danh sách mà gate publication đang dùng.
  it("descriptor theo miền phủ đúng danh sách bảng chuẩn, không thiếu không thừa không trùng", async () => {
    const { tablesWithoutDescriptor, descriptorsWithoutTable, duplicatedTables } =
      await import("@/hooks/realtime");
    expect(tablesWithoutDescriptor(), "bảng chuẩn mà không miền nào khai").toEqual([]);
    expect(descriptorsWithoutTable(), "descriptor trỏ bảng ngoài danh sách chuẩn").toEqual([]);
    expect(duplicatedTables(), "bảng bị hai miền cùng khai").toEqual([]);
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

  // ĐỔI CÓ CHỦ ĐÍCH 21/10/2026 (RT-HUB-7). Ca cũ "keeps table invalidations
  // independent" ghim việc contracts nhả ở 800ms trong khi rooms còn chờ — tức
  // ghim đúng hành vi gây refetch lặp: một giao dịch chạm hai bảng nhả hai lượt
  // cách nhau vài trăm ms. Nay hai bảng trong cùng cụm nhả MỘT lượt ở mốc
  // debounce của event cuối (vẫn trong trần MAX_WAIT_MS), và cleanup trước mốc
  // đó huỷ cả cụm.
  it("gom hai bảng của một cụm vào một lượt nhả; cleanup trước mốc thì không nhả gì", () => {
    useRealtimeDataSync();
    getRealtimeHandler("contracts")();
    vi.advanceTimersByTime(400);
    getRealtimeHandler("rooms")();
    vi.advanceTimersByTime(400);

    // 800ms sau event ĐẦU: cụm chưa nhả vì event rooms đặt lại debounce.
    expect(harness.invalidateQueries).not.toHaveBeenCalled();

    const cleanup = harness.cleanup;
    expect(cleanup).toBeTypeOf("function");
    if (typeof cleanup !== "function") throw new Error("Missing cleanup");
    cleanup();
    harness.cleanup = undefined;
    vi.advanceTimersByTime(2400);

    expect(harness.invalidateQueries).not.toHaveBeenCalled();
    expect(harness.removeChannel).toHaveBeenCalledTimes(1);
  });

  it("cụm contracts + rooms: mỗi gốc key bị invalidate ĐÚNG MỘT lần, kể cả gốc hai bảng cùng khai", () => {
    useRealtimeDataSync();
    getRealtimeHandler("contracts")();
    vi.advanceTimersByTime(400);
    getRealtimeHandler("rooms")();
    vi.advanceTimersByTime(800);

    const roots = invalidatedRoots();
    // ["rooms"] nằm ở CẢ entry contracts lẫn rooms — bản gom theo bảng gọi hai lần.
    expect(roots.filter((root) => root === "rooms")).toHaveLength(1);
    expect(new Set(roots).size).toBe(roots.length);
    expect(roots.filter((root) => root === "business-performance")).toHaveLength(1);
  });

  it("một query active chạm bởi hai bảng trong cụm chỉ fetch MỘT lần", async () => {
    let starts = 0;
    const observer = new QueryObserver(harness.queryClient, {
      queryKey: ["rooms", "building", "building-a"],
      initialData: [],
      staleTime: Infinity,
      queryFn: () => { starts += 1; return new Promise<never[]>(() => {}); },
    });
    const unsubscribe = observer.subscribe(() => {});
    useRealtimeDataSync();
    getRealtimeHandler("contracts")();
    getRealtimeHandler("rooms")();
    getRealtimeHandler("reservation_deposit_settlements")();
    await vi.advanceTimersByTimeAsync(800);
    expect(starts).toBe(1);
    unsubscribe();
  });

  it("debounces a same-table burst into one invalidation", () => {
    useRealtimeDataSync();
    const handler = getRealtimeHandler("buildings");

    handler();
    vi.advanceTimersByTime(400);
    handler();
    vi.advanceTimersByTime(799);
    expect(harness.invalidateQueries).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    // Entry buildings: ["buildings"], ["rooms"] + MỘT lượt gom báo cáo. Hai event
    // nhả một lần — nhiều hơn 3 lời gọi nghĩa là debounce đã không gộp.
    expect(originalInvalidations()).toHaveLength(3);
    expect(invalidatedRoots()).toEqual(["buildings", "rooms", "business-performance"]);
  });

  // ── TRẦN CHỜ (MAX_WAIT_MS) ────────────────────────────────────────────────
  // Ca ngay trên ("debounces a same-table burst") ghim vế THỨ NHẤT của debounce:
  // cụm thưa thì gộp. Hai ca dưới đây ghim vế THỨ HAI, vốn trước đây không có:
  // cụm DÀY thì vẫn phải nhả. Thiếu chúng thì xoá `delayConTrongTran` khỏi hub
  // vẫn xanh 33/33 — nghĩa là bản vá này không có gì canh.
  it("flushes at the max-wait ceiling when a burst never idles", () => {
    useRealtimeDataSync();
    const handler = getRealtimeHandler("customers");

    // Mỗi 400ms một event: khoảng cách luôn NGẮN HƠN 800ms nên trailing-edge
    // thuần sẽ đẩy lùi flush mãi mãi. 6 event = 2400ms = đúng trần.
    for (let i = 0; i < 6; i += 1) {
      handler();
      vi.advanceTimersByTime(400);
    }

    expect(harness.invalidateQueries).toHaveBeenCalled();
    expect(invalidatedRoots()).toContain("customers");
  });

  it("keeps coalescing inside the ceiling — one flush, not one per event", () => {
    useRealtimeDataSync();
    const handler = getRealtimeHandler("customers");

    // 4 event trong 1200ms (dưới trần 2400ms) rồi để yên cho debounce chốt.
    for (let i = 0; i < 4; i += 1) {
      handler();
      vi.advanceTimersByTime(400);
    }
    vi.advanceTimersByTime(800);

    // Entry customers có 2 key: customers, customer-residence.
    // Một lần flush là đúng 2 lời gọi invalidateQueries. Nhiều hơn nghĩa là đã flush
    // nhiều lần, tức trần chờ đã ăn mất tác dụng gộp.
    expect(originalInvalidations()).toHaveLength(2);
    expect(invalidatedRoots()).toEqual(["customers", "customer-residence"]);
  });

  it("starts a fresh ceiling for the next burst after a flush", () => {
    useRealtimeDataSync();
    const handler = getRealtimeHandler("customers");

    handler();
    vi.advanceTimersByTime(800);
    expect(originalInvalidations()).toHaveLength(2);
    expect(invalidatedRoots()).toEqual(["customers", "customer-residence"]);

    // Cụm thứ hai phải được hưởng trọn 800ms debounce của riêng nó. Nếu mốc
    // đầu cụm không được đặt lại, cụm này sẽ bị tính là đã quá hạn và flush
    // ngay lập tức — gộp bão hỏng từ cụm thứ hai trở đi.
    handler();
    vi.advanceTimersByTime(799);
    expect(originalInvalidations()).toHaveLength(2);
    expect(invalidatedRoots()).toEqual(["customers", "customer-residence"]);
    vi.advanceTimersByTime(1);
    expect(originalInvalidations()).toHaveLength(4);
    expect(invalidatedRoots().filter(key => key === "customer-residence")).toHaveLength(2);
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

  // ĐỔI CÓ CHỦ ĐÍCH 21/10/2026 (RT-HUB-3). Ca cũ "invalidates only the Business
  // Performance root" ghim đúng lỗ hổng: phòng/toà đổi mà Danh mục căn hộ, Sơ đồ
  // toà, chi tiết phòng không ai làm mới. Nay ghim tập key thật của các màn đó.
  it.each([
    ["rooms", ["rooms", "rooms-with-contracts", "room-detail-contracts", "room-detail-tenants",
      "room-active-contract", "business-performance"]],
    ["buildings", ["buildings", "rooms", "business-performance"]],
  ])("%s làm mới màn phòng/toà + đúng một lượt báo cáo", (table, expected) => {
    useRealtimeDataSync();
    triggerTable(table);

    expect(invalidatedRoots()).toEqual(expected);
  });

  it("hợp đồng đổi ⇒ Sơ đồ toà (rooms-with-contracts) và chi tiết khách được làm mới", () => {
    useRealtimeDataSync();
    triggerTable("contracts");
    const roots = invalidatedRoots();
    for (const root of ["rooms", "rooms-with-contracts", "room-detail-contracts",
      "building-detail-contracts", "room-active-contract", "customer-contracts", "reports"]) {
      expect(roots, `thiếu ['${root}']`).toContain(root);
    }
  });

  it.each([
    ["income_expenses", ["contract-pending-forfeit", "contract-termination-info", "invoice-vouchers",
      "cashbook-closing-blockers", "income-cancel-eligibility", "pending-approvals", "revenue-chart"]],
    ["income_expense_items", ["contract-pending-forfeit", "contract-termination-info", "invoice-vouchers",
      "cashbook-closing-blockers", "income-cancel-eligibility"]],
    ["invoices", ["room-detail-invoices", "building-detail-invoices", "room-latest-invoice",
      "ie-related-invoice", "income-cancel-eligibility", "revenue-chart", "debt-chart", "reports"]],
    ["payments", ["payments-summary"]],
    ["meter_readings", ["meter-readings", "meter-reading-stats", "unrecorded-meters",
      "meters-with-latest-reading", "contract-meter-followups"]],
    ["meters", ["meters", "meters-with-latest-reading", "unrecorded-meters"]],
  ])("%s làm mới các màn chi tiết đọc bằng key riêng (RT-HUB-5/6)", (table, expected) => {
    useRealtimeDataSync();
    triggerTable(table);
    const roots = invalidatedRoots();
    for (const root of expected) expect(roots, `${table} thiếu ['${root}']`).toContain(root);
  });

  // RT-HUB-11: bốn khối của GatedData ở /bao-cao/hieu-qua chỉ có staleTime.
  it.each([
    ["invoices", ["break-even", "invoice-cohort", "cash-received"]],
    ["income_expenses", ["break-even", "category-breakdown"]],
    ["payments", ["cash-received", "invoice-cohort"]],
  ])("%s làm mới đúng các subtype báo cáo mới", (table, expected) => {
    const all = ["break-even", "invoice-cohort", "cash-received", "category-breakdown"];
    const key = (subtype: string) => ["business-performance", "user-a", subtype, "org-a", "ACCRUAL", ["b"]];
    for (const subtype of all) harness.queryClient.setQueryData(key(subtype), []);
    useRealtimeDataSync();
    triggerTable(table);
    const invalidated = all.filter((subtype) =>
      harness.queryClient.getQueryState(key(subtype))?.isInvalidated);
    expect(invalidated.sort()).toEqual([...expected].sort());
  });

  // ── CỬA SỔ "VỪA TỰ GHI" (plan con B, mục 1) ──────────────────────────────
  //
  // Mutation local đã invalidate xong thì 0,8–2,4 giây sau chính hub invalidate
  // LẦN HAI toàn bộ key của bảng rồi prefetch lại cả domain — dù người dùng
  // không đứng ở trang đó. Với create_contract_v2 (5 bảng) là ~70 lượt quét
  // cache + 6 RPC nặng cho một thao tác đã xong từ lâu.
  //
  // Sau bản vá: event realtime đến trong ≤3 giây sau mutation của CHÍNH máy này
  // chỉ còn MỘT lượt invalidate gộp, chạm đúng query đang active.
  it("bảng vừa tự ghi: cả entry gộp về MỘT lượt invalidate, chỉ chạm query active", () => {
    useRealtimeDataSync();
    markLocalWrite(["customers"]);
    triggerTable("customers");

    // Entry customers có 3 key; cửa sổ vừa tự ghi gộp còn 1 lượt.
    expect(originalInvalidations()).toHaveLength(1);
    const [filters] = originalInvalidations()[0] as [
      {
        queryKey?: unknown;
        refetchType?: string;
        predicate: (q: { queryKey: readonly unknown[] }) => boolean;
      },
    ];
    expect(filters.queryKey).toBeUndefined();
    expect(filters.refetchType).toBe("active");
    expect(filters.predicate({ queryKey: ["customers", "building-a"] })).toBe(true);
    expect(filters.predicate({ queryKey: ["customer-residence", "summary", "org-a"] })).toBe(true);
    expect(filters.predicate({ queryKey: ["invoices"] })).toBe(false);
  });

  it("hợp đồng vừa tự ghi: 11 lượt invalidate còn 2 (entry gộp + báo cáo)", () => {
    useRealtimeDataSync();
    markLocalWrite(["contracts"]);
    triggerTable("contracts");

    // 10 key ngoài business-performance + 1 lượt gom báo cáo = 11.
    expect(originalInvalidations()).toHaveLength(2);
  });

  it("chỉ bảng ĐƯỢC đánh dấu mới vào cửa sổ — bảng khác giữ nguyên đường đầy đủ", () => {
    useRealtimeDataSync();
    markLocalWrite(["contracts"]);
    triggerTable("customers");

    expect(originalInvalidations()).toHaveLength(2);
    expect(invalidatedRoots()).toEqual(["customers", "customer-residence"]);
  });

  it("quá 3 giây thì trở lại đường đầy đủ — cửa sổ không dính vĩnh viễn", () => {
    useRealtimeDataSync();
    markLocalWrite(["customers"]);
    vi.advanceTimersByTime(3001);
    triggerTable("customers");

    expect(originalInvalidations()).toHaveLength(2);
    expect(invalidatedRoots()).toEqual(["customers", "customer-residence"]);
  });

  it("một event ngoài cửa sổ trong cùng cụm kéo cả cụm về đường đầy đủ", () => {
    useRealtimeDataSync();
    const handler = getRealtimeHandler("customers");
    markLocalWrite(["customers"]);
    vi.advanceTimersByTime(2900);
    handler(); // vẫn trong cửa sổ 3s
    vi.advanceTimersByTime(400); // < 800ms ⇒ CÙNG một cụm debounce
    handler(); // đã ngoài cửa sổ ⇒ có thể là thay đổi của MÁY KHÁC
    vi.advanceTimersByTime(800);

    expect(originalInvalidations()).toHaveLength(2);
    expect(invalidatedRoots()).toEqual(["customers", "customer-residence"]);
  });

  // ── CỬA CHẶN PREFETCH (plan con B, mục 2) ────────────────────────────────
  it("không prefetch domain khi đang đứng ở chính trang của domain đó", async () => {
    vi.stubGlobal("document", { visibilityState: "visible" });
    vi.stubGlobal("window", { location: { pathname: "/contracts" } });

    useRealtimeDataSync();
    triggerTable("contracts");
    await xaMicrotask();

    expect(harness.prefetchDomain).not.toHaveBeenCalled();
  });

  it("không prefetch domain trong cửa sổ vừa tự ghi", async () => {
    vi.stubGlobal("document", { visibilityState: "visible" });
    vi.stubGlobal("window", { location: { pathname: "/dashboard" } });

    useRealtimeDataSync();
    markLocalWrite(["contracts"]);
    triggerTable("contracts");
    await xaMicrotask();

    expect(harness.prefetchDomain).not.toHaveBeenCalled();
  });

  it("prefetch khi ở trang khác, nhưng throttle 10 giây theo domain", async () => {
    vi.stubGlobal("document", { visibilityState: "visible" });
    vi.stubGlobal("window", { location: { pathname: "/dashboard" } });

    useRealtimeDataSync();
    triggerTable("contracts");
    await xaMicrotask();
    expect(harness.prefetchDomain).toHaveBeenCalledTimes(1);
    expect(harness.prefetchDomain.mock.calls[0]?.[1]).toBe("contracts");

    vi.advanceTimersByTime(5000);
    triggerTable("contracts");
    await xaMicrotask();
    expect(harness.prefetchDomain).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(10_000);
    triggerTable("contracts");
    await xaMicrotask();
    expect(harness.prefetchDomain).toHaveBeenCalledTimes(2);
  });

  it("throttle đếm RIÊNG từng domain — hoá đơn không bị chặn vì hợp đồng", async () => {
    vi.stubGlobal("document", { visibilityState: "visible" });
    vi.stubGlobal("window", { location: { pathname: "/dashboard" } });

    useRealtimeDataSync();
    triggerTable("contracts");
    await xaMicrotask();
    triggerTable("invoices");
    await xaMicrotask();

    expect(
      harness.prefetchDomain.mock.calls.map((c) => c[1]),
    ).toEqual(["contracts", "invoices"]);
  });

  // ── BẮT KỊP SAU GIÁN ĐOẠN (21/10/2026, RT-HUB-1 / RT-DB-3) ────────────────
  // postgres_changes không phát lại event đã lỡ. Trước đây hub bỏ qua SUBSCRIBED
  // lần hai nên thay đổi trong lúc rớt mất hẳn. Nay: SUBSCRIBED sau CHANNEL_ERROR
  // ⇒ catchUp gọi invalidateQueries ĐÚNG MỘT lần, chỉ refetch query active.
  function trangThaiKenh() {
    const cb = harness.channel.subscribe.mock.calls[0]?.[0] as
      | ((status: string, err?: Error) => void)
      | undefined;
    expect(cb, "hub không đăng ký callback trạng thái kênh").toBeTypeOf("function");
    return cb!;
  }

  it("SUBSCRIBED lần đầu KHÔNG bắt kịp — dữ liệu vừa tải là mới", () => {
    useRealtimeDataSync();
    trangThaiKenh()("SUBSCRIBED");
    expect(harness.invalidateQueries).not.toHaveBeenCalled();
  });

  it("CHANNEL_ERROR → SUBSCRIBED gọi catchUp đúng MỘT lần, phủ gốc key hub + báo cáo + quyết toán", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    useRealtimeDataSync();
    const cb = trangThaiKenh();
    cb("SUBSCRIBED");
    cb("CHANNEL_ERROR", new Error("socket"));
    expect(harness.invalidateQueries).not.toHaveBeenCalled();
    cb("SUBSCRIBED");

    expect(harness.invalidateQueries).toHaveBeenCalledTimes(1);
    const [filters] = harness.invalidateQueries.mock.calls[0] as [
      { queryKey?: unknown; refetchType?: string; predicate: (q: { queryKey: readonly unknown[] }) => boolean },
    ];
    expect(filters.queryKey).toBeUndefined();
    expect(filters.refetchType).toBe("active");
    for (const root of ["income-expenses", "invoices", "contracts", "jobs", "rooms-with-contracts",
      "business-performance", "contract-settlement", "termination-refund-facts", "commission-voucher-facts"]) {
      expect(filters.predicate({ queryKey: [root, "x"] }), root).toBe(true);
    }
    // Gốc ngoài hub (chuông, quyền) không bị kéo theo.
    expect(filters.predicate({ queryKey: ["notifications", "count"] })).toBe(false);
    expect(filters.predicate({ queryKey: ["my-permissions", "org-a"] })).toBe(false);
    warn.mockRestore();
  });

  it("bắt kịp chỉ refetch query ĐANG ACTIVE; query nền chỉ bị đánh dấu cũ", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    let activeFetches = 0;
    const observer = new QueryObserver(harness.queryClient, {
      queryKey: ["income-expenses", "list"],
      initialData: [],
      staleTime: Infinity,
      queryFn: () => { activeFetches += 1; return new Promise<never[]>(() => {}); },
    });
    const unsubscribe = observer.subscribe(() => {});
    harness.queryClient.setQueryData(["invoices", "background"], []);

    useRealtimeDataSync();
    const cb = trangThaiKenh();
    cb("SUBSCRIBED");
    cb("TIMED_OUT");
    cb("SUBSCRIBED");
    await vi.advanceTimersByTimeAsync(0);

    expect(activeFetches).toBe(1);
    expect(harness.queryClient.getQueryState(["invoices", "background"])?.isInvalidated).toBe(true);
    expect(harness.queryClient.getQueryState(["invoices", "background"])?.fetchStatus).toBe("idle");
    unsubscribe();
    warn.mockRestore();
  });
});
