import {
  afterEach,
  beforeEach,
  describe,
  expect,
  expectTypeOf,
  it,
  vi,
} from "vitest";

const mocks = vi.hoisted(() => ({
  rpc: vi.fn(),
  useAuth: vi.fn(() => ({ data: { id: "user-a" } })),
  useQuery: vi.fn((options: unknown) => options),
}));

vi.mock("@tanstack/react-query", () => ({
  useQuery: mocks.useQuery,
}));

vi.mock("@/integrations/supabase/client", () => ({
  supabase: { rpc: mocks.rpc },
}));

vi.mock("@/hooks/useAuth", () => ({
  useAuth: mocks.useAuth,
}));

import {
  type OccupancySnapshotRow,
  type OccupancyTrendPoint,
  type UpcomingVacancyRow,
  useOccupancySnapshot,
  useOccupancyTrend12m,
  useUpcomingVacancy,
} from "../useOccupancyDashboard";

type QueryOptions<T> = {
  queryKey: readonly unknown[];
  queryFn: () => Promise<T>;
  enabled?: boolean;
  staleTime?: number;
  refetchInterval?: number | false;
};

const BUILDING_A = "11111111-1111-4111-8111-111111111111";
const BUILDING_B = "22222222-2222-4222-8222-222222222222";

describe("legacy occupancy dashboard hooks", () => {
  beforeEach(() => {
    mocks.rpc.mockReset();
    mocks.useAuth.mockClear();
    mocks.useQuery.mockClear();
    vi.useRealTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("preserves the legacy public signatures and typed query data", () => {
    expect(useOccupancySnapshot).toHaveLength(2);
    expect(useUpcomingVacancy).toHaveLength(3);
    expect(useOccupancyTrend12m).toHaveLength(1);

    expectTypeOf<ReturnType<typeof useOccupancySnapshot>["data"]>()
      .toEqualTypeOf<OccupancySnapshotRow[] | undefined>();
    expectTypeOf<ReturnType<typeof useUpcomingVacancy>["data"]>()
      .toEqualTypeOf<UpcomingVacancyRow[] | undefined>();
    expectTypeOf<ReturnType<typeof useOccupancyTrend12m>["data"]>()
      .toEqualTypeOf<OccupancyTrendPoint[] | undefined>();
  });

  it("keeps legacy query keys without auth gating or polling options", () => {
    const snapshot = useOccupancySnapshot(
      "2026-07-25",
      [BUILDING_A],
    ) as unknown as QueryOptions<OccupancySnapshotRow[]>;
    const upcoming = useUpcomingVacancy(
      "2026-07-25",
      60,
      [BUILDING_A],
    ) as unknown as QueryOptions<UpcomingVacancyRow[]>;
    const trend = useOccupancyTrend12m(
      [BUILDING_A],
    ) as unknown as QueryOptions<OccupancyTrendPoint[]>;

    expect(snapshot.queryKey).toEqual([
      "occupancy-dashboard",
      "snapshot",
      "2026-07-25",
      [BUILDING_A],
    ]);
    expect(upcoming.queryKey).toEqual([
      "occupancy-dashboard",
      "upcoming-vacancy",
      "2026-07-25",
      60,
      [BUILDING_A],
    ]);
    expect(trend.queryKey).toEqual([
      "occupancy-dashboard",
      "trend-12m",
      [BUILDING_A],
    ]);

    for (const options of [snapshot, upcoming, trend]) {
      expect(options).not.toHaveProperty("enabled");
      expect(options).not.toHaveProperty("staleTime");
      expect(options).not.toHaveProperty("refetchInterval");
    }
    expect(mocks.useAuth).not.toHaveBeenCalled();
  });

  // Bản cũ của ca này khoá `p_building_ids: null`. Đổi sang `undefined` vì cả ba
  // RPC khai `p_building_ids?: string[]` (tham số có `DEFAULT NULL` trên server),
  // nên bỏ khoá đi là server tự dùng NULL — hành vi không đổi. Bản `null` chặn ba
  // file này khỏi đảo strict vì `null` không gán được vào `string[] | undefined`.
  //
  // Giới hạn của phép khẳng định dưới đây, ghi rõ để không ai đọc quá lời: `toEqual`
  // BỎ QUA khoá mang `undefined` ở cả hai vế, nên nó không phân biệt được "có khoá
  // mang undefined" với "vắng khoá". Nó VẪN bắt được `null` (null không bị bỏ qua),
  // tức nó đủ để chặn việc lỡ tay quay về bản cũ. Chỗ nó không phân biệt được thì
  // cũng không quan trọng: xem ca "gửi lên dây" ngay dưới.
  it("uses only legacy RPCs and omits an empty building filter", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 6, 25, 12));
    mocks.rpc.mockResolvedValue({ data: null, error: null });

    const snapshot = useOccupancySnapshot(
      "2026-07-25",
      [],
    ) as unknown as QueryOptions<OccupancySnapshotRow[]>;
    const upcoming = useUpcomingVacancy(
      "2026-07-25",
      30,
      [],
    ) as unknown as QueryOptions<UpcomingVacancyRow[]>;
    const trend = useOccupancyTrend12m(
      [],
    ) as unknown as QueryOptions<OccupancyTrendPoint[]>;

    await expect(snapshot.queryFn()).resolves.toEqual([]);
    await expect(upcoming.queryFn()).resolves.toEqual([]);
    await expect(trend.queryFn()).resolves.toEqual([]);

    expect(mocks.rpc).toHaveBeenCalledTimes(3);
    expect(mocks.rpc.mock.calls.map(([name]) => name)).toEqual([
      "occupancy_snapshot_v2",
      "occupancy_upcoming_vacancy_v2",
      "fa_occupancy_monthly",
    ]);
    expect(mocks.rpc).toHaveBeenNthCalledWith(1, "occupancy_snapshot_v2", {
      p_as_of_date: "2026-07-25",
      p_building_ids: undefined,
    });
    expect(mocks.rpc).toHaveBeenNthCalledWith(
      2,
      "occupancy_upcoming_vacancy_v2",
      {
        p_as_of_date: "2026-07-25",
        p_window_days: 30,
        p_building_ids: undefined,
      },
    );
    expect(mocks.rpc).toHaveBeenNthCalledWith(3, "fa_occupancy_monthly", {
      p_start_date: "2025-08-01",
      p_end_date: "2026-07-25",
      p_building_ids: undefined,
    });
  });

  it("gửi lên dây: bỏ khoá p_building_ids, KHÔNG gửi null", async () => {
    // Vì sao ca này tồn tại: đổi `toIdsParam` từ `null` sang `undefined` là đổi
    // thứ đi qua mạng, nên phải chứng minh nó KHÔNG đổi ý nghĩa. `JSON.stringify`
    // — chính là bước supabase-js dựng thân request — bỏ hẳn khoá mang `undefined`,
    // nên server thấy tham số vắng mặt và dùng `DEFAULT NULL` của chính nó. Bản cũ
    // gửi `"p_building_ids":null` tường minh; hai đằng cho cùng một kết quả.
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 6, 25, 12));
    mocks.rpc.mockResolvedValue({ data: null, error: null });

    const snapshot = useOccupancySnapshot(
      "2026-07-25",
      [],
    ) as unknown as QueryOptions<OccupancySnapshotRow[]>;
    await snapshot.queryFn();

    const [, args] = mocks.rpc.mock.calls[0] as [string, Record<string, unknown>];
    expect(args.p_building_ids).toBeUndefined();
    expect(args.p_building_ids).not.toBeNull();
    expect(JSON.parse(JSON.stringify(args))).toEqual({ p_as_of_date: "2026-07-25" });

    // Và khi CÓ lọc thì mảng phải đi nguyên vẹn — chống-xanh-rỗng cho ca trên:
    // một `toIdsParam` luôn trả `undefined` cũng làm ba khẳng định kia xanh.
    mocks.rpc.mockClear();
    const coLoc = useOccupancySnapshot(
      "2026-07-25",
      [BUILDING_A],
    ) as unknown as QueryOptions<OccupancySnapshotRow[]>;
    await coLoc.queryFn();
    const [, argsCoLoc] = mocks.rpc.mock.calls[0] as [string, Record<string, unknown>];
    expect(argsCoLoc.p_building_ids).toEqual([BUILDING_A]);
  });

  it("keeps legacy trend aggregation and returns rate zero for zero-room months", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 6, 25, 12));
    mocks.rpc.mockResolvedValue({
      data: [
        {
          month: "2026-02-01",
          building_id: BUILDING_A,
          occupied_rooms: 2,
          total_rooms: 4,
        },
        {
          month: "2026-02-01",
          building_id: BUILDING_B,
          occupied_rooms: 1,
          total_rooms: 2,
        },
        {
          month: "2026-03-01",
          building_id: BUILDING_A,
          occupied_rooms: null,
          total_rooms: null,
        },
      ],
      error: null,
    });

    const trend = useOccupancyTrend12m(
      [BUILDING_A, BUILDING_B],
    ) as unknown as QueryOptions<OccupancyTrendPoint[]>;

    await expect(trend.queryFn()).resolves.toEqual([
      { month: "2/2026", occupied: 3, total: 6, rate: 50 },
      { month: "3/2026", occupied: 0, total: 0, rate: 0 },
    ]);
  });
});
