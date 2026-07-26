import { describe, expect, it } from "vitest";

import * as buildingModule from "../BuildingPerformanceTab";
import * as overviewModule from "../BusinessOverviewTab";

type DeltaHelper = (current: number | null, base: number | null) => number | null;

describe("finance performance absolute deltas", () => {
  it("keeps the overview absolute delta when the comparison base is zero", () => {
    const helper = (
      overviewModule as unknown as {
        calculateComparisonAbsoluteDelta?: DeltaHelper;
      }
    ).calculateComparisonAbsoluteDelta;

    expect(typeof helper).toBe("function");
    expect(helper?.(125, 0)).toBe(125);
  });

  it("keeps the building net absolute delta when the comparison base is zero", () => {
    const helper = (
      buildingModule as unknown as {
        calculateNetAbsoluteDelta?: DeltaHelper;
      }
    ).calculateNetAbsoluteDelta;

    expect(typeof helper).toBe("function");
    expect(helper?.(-80, 0)).toBe(-80);
  });
});
