export type PeriodFeeOverviewStatus = {
  paidAmount: number;
  draftAmount: number;
  expectedAmount: number | null;
  notApplicable?: boolean;
};

export type PeriodFeeOverviewCommission = {
  status: string;
  expectedAmount: number;
  voucherAmount: number | null;
  buildingName: string;
};

export type PeriodFeeOverviewMaintenance = { pending: boolean; amount: number };

type OverviewCategory = { key: string; family: string; serverKey: string };

export type PeriodFeeOverviewRow<TCategory extends OverviewCategory> = {
  category: TCategory;
  total: number;
  paidN: number;
  dueN: number;
  draftN: number;
  dueList: string[];
  dueSum: number;
  paidSum: number;
  pct: number;
  allPaid: boolean;
  empty: boolean;
};

export function calculatePeriodFeeOverview<TCategory extends OverviewCategory>(input: {
  categories: readonly TCategory[];
  excludedFamilies: ReadonlySet<string>;
  buildingIds: readonly string[];
  buildingName: (buildingId: string) => string;
  activeBuildingIds: (category: TCategory) => readonly string[];
  statusOf: (buildingId: string, serverKey: string) => PeriodFeeOverviewStatus | undefined;
  commissions: readonly PeriodFeeOverviewCommission[];
  maintenance: readonly PeriodFeeOverviewMaintenance[];
}) {
  let dueCount = 0;
  let slots = 0;
  let dueSum = 0;
  let paidSum = 0;
  let paidCount = 0;
  let draftCount = 0;
  const dueBuildings = new Set<string>();

  const rows = input.categories.filter((category) => !input.excludedFamilies.has(category.family)).map((category) => {
    let total = 0;
    let paidN = 0;
    let rowDueSum = 0;
    let rowPaidSum = 0;
    let rowDraftN = 0;
    const dueList: string[] = [];
    const addDueBuilding = (buildingId: string, name = input.buildingName(buildingId)) => {
      if (!dueList.includes(name)) dueList.push(name);
      dueBuildings.add(buildingId);
    };

    if (category.family === "EN") {
      for (const buildingId of input.buildingIds) {
        for (const serverKey of ["dien", "nuoc"] as const) {
          const status = input.statusOf(buildingId, serverKey);
          if (status?.notApplicable) continue;
          total += 1;
          if (status && status.paidAmount > 0) {
            paidN += 1;
            rowPaidSum += status.paidAmount;
          } else {
            rowDueSum += status?.expectedAmount ?? 0;
            addDueBuilding(buildingId);
          }
        }
      }
    } else if (category.family === "GRID") {
      for (const buildingId of input.activeBuildingIds(category)) {
        const status = input.statusOf(buildingId, category.serverKey);
        total += 1;
        if (status && status.paidAmount > 0) {
          paidN += 1;
          rowPaidSum += status.paidAmount;
        } else {
          if (status && status.draftAmount > 0) {
            rowDraftN += 1;
            rowDueSum += status.draftAmount;
          } else rowDueSum += status?.expectedAmount ?? 0;
          addDueBuilding(buildingId);
        }
      }
    } else if (category.family === "COMMISSION") {
      for (const commission of input.commissions) {
        total += 1;
        if (commission.status === "paid") {
          paidN += 1;
          rowPaidSum += commission.voucherAmount ?? commission.expectedAmount;
        } else {
          if (commission.status === "draft") rowDraftN += 1;
          rowDueSum += commission.status === "draft" ? (commission.voucherAmount ?? commission.expectedAmount) : commission.expectedAmount;
          if (!dueList.includes(commission.buildingName)) dueList.push(commission.buildingName);
        }
      }
    } else if (category.family === "MAINTENANCE_BATCH") {
      total = input.maintenance.length;
      paidN = input.maintenance.filter((line) => !line.pending).length;
      for (const line of input.maintenance) {
        if (line.pending) {
          rowDraftN += 1;
          rowDueSum += line.amount;
        } else rowPaidSum += line.amount;
      }
    }

    const dueN = total - paidN;
    dueCount += dueN;
    slots += total;
    dueSum += rowDueSum;
    paidSum += rowPaidSum;
    paidCount += paidN;
    draftCount += rowDraftN;
    return {
      category, total, paidN, dueN, draftN: rowDraftN, dueList, dueSum: rowDueSum, paidSum: rowPaidSum,
      pct: total ? Math.round((paidN / total) * 100) : 100,
      allPaid: dueN === 0 && total > 0,
      empty: total === 0,
    };
  });

  return { rows, dueCount, slots, dueSum, paidSum, paidCount, draftCount, dueBldCount: dueBuildings.size };
}
