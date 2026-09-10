import { beforeEach, describe, expect, it, vi } from "vitest";
import { hydrateReservationCreators } from "./reservationCreators";
const query = vi.hoisted(() => vi.fn());
vi.mock("@/integrations/supabase/client", () => ({ supabase: { from: () => ({ select: () => ({ in: query }) }) } }));
beforeEach(() => query.mockReset().mockResolvedValue({ data: [{ id: "actor", full_name: "Người xử lý" }], error: null }));
describe("settlement creator hydration", () => {
  it("uses the actual payment actor, deduplicates the batch and preserves source/known names", async () => {
    const rows = await hydrateReservationCreators([
      { user_id: "source", creator_name: "Người thu cọc", system_source: null },
      { user_id: "actor", creator_name: null, system_source: "reservation.refund" },
      { user_id: "actor", creator_name: "", system_source: "reservation.forfeit_revenue" },
      { user_id: "actor", creator_name: "Tên lúc xử lý", system_source: "reservation.forfeit_offset" },
    ]);
    expect(query).toHaveBeenCalledTimes(1);
    expect(query).toHaveBeenCalledWith("id", ["actor"]);
    expect(rows.map((r) => r.creator_name)).toEqual(["Người thu cọc", "Người xử lý", "Người xử lý", "Tên lúc xử lý"]);
  });
  it("skips extra queries for ordinary vouchers", async () => {
    await hydrateReservationCreators([{ user_id: "source", creator_name: null }]);
    expect(query).not.toHaveBeenCalled();
  });
});
