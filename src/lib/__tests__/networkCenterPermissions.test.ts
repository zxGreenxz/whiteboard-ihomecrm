import { describe, expect, it } from "vitest";

import {
  ALL_PAGES,
  featureValue,
  setPageViewOnly,
} from "@/lib/permissionPages";
import {
  ACTION_LABELS,
  MODULE_BY_KEY,
  actionsForModule,
  applyGlobalPreset,
  buildEmptyPermissions,
} from "@/lib/permissions";

describe("network center permissions", () => {
  it("registers exactly view and execute", () => {
    expect(MODULE_BY_KEY.network_center?.label).toBe("Trung tâm mạng");
    expect(actionsForModule("network_center")).toEqual(["view", "execute"]);
    expect(ACTION_LABELS.execute).toBe("Thực thi");
  });

  it("publishes the view and elevated execute features without fallback", () => {
    const page = ALL_PAGES.find((candidate) => candidate.key === "network_center");

    expect(page?.route).toBe("/network-center");
    expect(page?.features).toEqual([
      expect.objectContaining({
        module: "network_center",
        action: "view",
        tier: "view",
      }),
      expect.objectContaining({
        module: "network_center",
        action: "execute",
        tier: "elevated",
      }),
    ]);
    expect(page?.features.every((feature) => !("fallback" in feature))).toBe(true);
  });

  it("keeps execute out of view-only and manage presets", () => {
    const page = ALL_PAGES.find((candidate) => candidate.key === "network_center")!;
    const viewOnly = setPageViewOnly(buildEmptyPermissions(), page);
    const manage = applyGlobalPreset(buildEmptyPermissions(), "manage");

    expect(featureValue(viewOnly, page.features[0])).toBe(true);
    expect(featureValue(viewOnly, page.features[1])).toBe(false);
    expect(manage.network_center?.view).toBe(true);
    expect(manage.network_center?.execute).toBe(false);
  });
});
