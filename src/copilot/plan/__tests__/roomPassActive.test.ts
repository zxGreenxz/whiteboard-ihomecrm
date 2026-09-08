import { expect, it } from "vitest";
import { ACTION_CATALOG, khoaRolloutHanhDong } from "../actionCatalog";

it("offers explicit boolean publication consent for an existing listing", () => {
  const entry = ACTION_CATALOG["room_pass.set_active"];
  expect(entry).toBeDefined();
  expect(entry.risk).toBe("L3");
  expect(entry.consentRequired).toBe("click");
  expect(entry.permission).toEqual({
    module: "sale_phong",
    action: "manage_pass_listings",
  });
  expect(khoaRolloutHanhDong("room_pass.set_active")).toBe(
    "action:room_pass.set_active",
  );
  const input = {
    listing_id: "dddd3000-0000-4000-8000-000000000001",
    active: false,
  };
  expect(entry.inputSchema.safeParse(input).success).toBe(true);
  for (const active of [undefined, null, "false", 0]) {
    expect(entry.inputSchema.safeParse({ ...input, active }).success).toBe(
      false,
    );
  }
  expect(
    entry.inputSchema.safeParse({ ...input, listing_id: "bad" }).success,
  ).toBe(false);
});
