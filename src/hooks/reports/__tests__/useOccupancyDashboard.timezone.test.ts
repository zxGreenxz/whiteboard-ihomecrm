import { expect, it, vi } from "vitest";
import { useOccupancyTrend12m, type OccupancyTrendPoint } from "../useOccupancyDashboard";

const rpc = vi.hoisted(() => vi.fn());
vi.mock("@tanstack/react-query", () => ({ useQuery: (options: unknown) => options }));
vi.mock("@/integrations/supabase/client", () => ({ supabase: { rpc } }));

it("keeps the calendar month from each occupancy row when aggregating across buildings", async () => {
  const BUILDING_A = "11111111-1111-4111-8111-111111111111";
  const BUILDING_B = "22222222-2222-4222-8222-222222222222";
  rpc.mockResolvedValue({
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
        occupied_rooms: 0,
        total_rooms: 0,
      },
    ],
    error: null,
  });

  const trend = useOccupancyTrend12m(
    [BUILDING_A, BUILDING_B],
  ) as unknown as { queryFn: () => Promise<OccupancyTrendPoint[]> };

  await expect(trend.queryFn()).resolves.toEqual([
    { month: "2/2026", occupied: 3, total: 6, rate: 50 },
    { month: "3/2026", occupied: 0, total: 0, rate: 0 },
  ]);
});
