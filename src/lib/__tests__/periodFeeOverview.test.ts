import { describe, expect, it } from "vitest";
import { calculatePeriodFeeOverview } from "../periodFeeOverview";

describe("PeriodFeePanel/PeriodFeeSheet overview characterization", () => {
  it("pins dueSum, draftCount and paidSum for the shared current fixture", () => {
    const categories = [
      { key: "dien_nuoc", family: "EN", serverKey: "dien" },
      { key: "internet", family: "GRID", serverKey: "internet" },
      { key: "hoa_hong", family: "COMMISSION", serverKey: "hoa_hong" },
      { key: "bao_tri", family: "MAINTENANCE_BATCH", serverKey: "bao_tri" },
      { key: "coc", family: "DEPOSIT_LEDGER", serverKey: "coc" },
    ];
    const statuses = new Map([
      ["b1:dien", { paidAmount: 100_000, draftAmount: 0, expectedAmount: 100_000, notApplicable: false }],
      ["b1:nuoc", { paidAmount: 0, draftAmount: 0, expectedAmount: 80_000, notApplicable: false }],
      ["b1:internet", { paidAmount: 0, draftAmount: 120_000, expectedAmount: 110_000, notApplicable: false }],
    ]);
    const overview = calculatePeriodFeeOverview({
      categories,
      excludedFamilies: new Set(["DEPOSIT_LEDGER"]),
      buildingIds: ["b1"],
      buildingName: () => "Toà A",
      activeBuildingIds: () => ["b1"],
      statusOf: (buildingId, serverKey) => statuses.get(`${buildingId}:${serverKey}`),
      commissions: [
        { status: "paid", expectedAmount: 500_000, voucherAmount: 550_000, buildingName: "Toà A" },
        { status: "draft", expectedAmount: 400_000, voucherAmount: 420_000, buildingName: "Toà A" },
        { status: "unpaid", expectedAmount: 300_000, voucherAmount: null, buildingName: "Toà A" },
      ],
      maintenance: [
        { pending: false, amount: 200_000 },
        { pending: true, amount: 250_000 },
      ],
    });

    expect(overview).toMatchObject({ dueSum: 1_170_000, draftCount: 3, paidSum: 850_000 });
    expect(overview.rows.map((row) => row.category.key)).not.toContain("coc");
  });
});
