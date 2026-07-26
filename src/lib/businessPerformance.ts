export type BusinessPerformanceBasis = "ACCRUAL" | "VOUCHER_DATE";

export type BusinessPerformanceTabId =
  | "business-overview"
  | "building-performance"
  | "occupancy-vacancy"
  | "collections-debt"
  | "revenue-cost-structure"
  | "trends-comparison"
  | "data-definitions";

export interface BusinessPerformanceFilters {
  month: string;
  periodStart: string;
  periodEnd: string;
  prevMonth: string;
  yoyMonth: string;
  t13Start: string;
  t13End: string;
  months12: string[];
  buildingIds: string[];
  basis: BusinessPerformanceBasis;
  organizationId: string;
}

export interface BusinessPerformancePnlRow {
  month: string;
  building_id: string;
  building_name: string;
  is_virtual: boolean;
  revenue: number;
  expense: number;
  net: number;
}

export interface BusinessPerformanceSnapshotRow {
  building_id: string;
  building_name: string;
  total_rooms: number;
  rooms_available: number;
  rooms_occupied: number;
  rooms_reserved: number;
  rooms_maintenance: number;
  rooms_unavailable: number;
  vacancy_loss_month: number;
  active_contracts: number;
  avg_rent: number;
  deposit_held: number;
  receivable_total: number;
  aging_not_due: number;
  aging_1_30: number;
  aging_31_60: number;
  aging_61_90: number;
  aging_over_90: number;
}

export interface BusinessPerformanceSnapshotAggregate {
  total_rooms: number;
  rooms_available: number;
  rooms_occupied: number;
  rooms_reserved: number;
  rooms_maintenance: number;
  rooms_unavailable: number;
  vacancy_loss_month: number;
  active_contracts: number;
  avg_rent: number | null;
  deposit_held: number;
  receivable_total: number;
  aging_not_due: number;
  aging_1_30: number;
  aging_31_60: number;
  aging_61_90: number;
  aging_over_90: number;
  occupancy_pct: number | null;
}

export interface BusinessPerformanceAuthorizedBuilding {
  id: string;
  name: string;
  restricted_allowed: boolean;
  analysis_provenance: Record<string, unknown>;
}

export interface BusinessPerformanceOrganization {
  id: string;
  name: string;
  authorized_buildings: BusinessPerformanceAuthorizedBuilding[];
  authorized_physical_building_count: number;
  authorization_version: number;
}

export interface BusinessPerformanceMonthAggregate {
  month: string;
  revenue: number;
  expense: number;
  net: number;
  marginPct: number | null;
  expenseRatioPct: number | null;
}

export interface BusinessPerformanceMetricComparison {
  current: number | null;
  previous: number | null;
  yearAgo: number | null;
  momPct: number | null;
  yoyPct: number | null;
}

export interface BusinessPerformanceComparison {
  current: BusinessPerformanceMonthAggregate | null;
  previous: BusinessPerformanceMonthAggregate | null;
  yearAgo: BusinessPerformanceMonthAggregate | null;
  revenue: BusinessPerformanceMetricComparison;
  expense: BusinessPerformanceMetricComparison;
  net: BusinessPerformanceMetricComparison;
}

export class BusinessPerformanceDataError extends Error {
  readonly field: string;

  constructor(field: string, message: string) {
    super(message);
    this.name = "BusinessPerformanceDataError";
    this.field = field;
  }
}

export const BUSINESS_PERFORMANCE_TABS: ReadonlyArray<{
  id: BusinessPerformanceTabId;
  label: string;
}> = [
  { id: "business-overview", label: "Tổng quan kinh doanh" },
  { id: "building-performance", label: "Hiệu quả tòa nhà" },
  { id: "occupancy-vacancy", label: "Lấp đầy & Phòng trống" },
  { id: "collections-debt", label: "Thu tiền & Công nợ" },
  { id: "revenue-cost-structure", label: "Cơ cấu Thu & Chi" },
  { id: "trends-comparison", label: "Xu hướng & So sánh" },
  { id: "data-definitions", label: "Dữ liệu & Định nghĩa" },
];

export const RESTRICTED_FINANCE_TAB_IDS: readonly BusinessPerformanceTabId[] = [
  "business-overview",
  "building-performance",
  "collections-debt",
  "revenue-cost-structure",
  "trends-comparison",
];

const RESTRICTED_FINANCE_TABS = new Set(RESTRICTED_FINANCE_TAB_IDS);

export function allowedBusinessPerformanceTabs(
  canViewRestrictedFinance: boolean,
): typeof BUSINESS_PERFORMANCE_TABS {
  return canViewRestrictedFinance
    ? BUSINESS_PERFORMANCE_TABS
    : BUSINESS_PERFORMANCE_TABS.filter((tab) => !RESTRICTED_FINANCE_TABS.has(tab.id));
}

const BUSINESS_PERFORMANCE_TAB_IDS = new Set(
  BUSINESS_PERFORMANCE_TABS.map((tab) => tab.id),
);

const CANONICAL_MONTH_PATTERN = /^(\d{4})-(0[1-9]|1[0-2])$/;
const CANONICAL_DATE_PATTERN = /^(\d{4})-(0[1-9]|1[0-2])-(\d{2})$/;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))].sort((a, b) =>
    a.localeCompare(b),
  );
}

function parseCanonicalMonth(month: string): { year: number; monthIndex: number } {
  const match = CANONICAL_MONTH_PATTERN.exec(month);
  if (!match) {
    throw new BusinessPerformanceDataError(
      "month",
      `Expected canonical month YYYY-MM, received ${JSON.stringify(month)}`,
    );
  }
  return { year: Number(match[1]), monthIndex: Number(match[2]) - 1 };
}

function shiftMonth(month: string, offset: number): string {
  const { year, monthIndex } = parseCanonicalMonth(month);
  const absoluteMonth = year * 12 + monthIndex + offset;
  const shiftedYear = Math.floor(absoluteMonth / 12);
  const shiftedMonth = ((absoluteMonth % 12) + 12) % 12;
  return `${shiftedYear}-${String(shiftedMonth + 1).padStart(2, "0")}`;
}

function monthEnd(month: string): string {
  const { year, monthIndex } = parseCanonicalMonth(month);
  const day = new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate();
  return `${month}-${String(day).padStart(2, "0")}`;
}

export function parseBusinessPerformanceBasis(value: unknown): BusinessPerformanceBasis {
  if (value !== "ACCRUAL" && value !== "VOUCHER_DATE") {
    throw new BusinessPerformanceDataError(
      "basis",
      "Expected ACCRUAL or VOUCHER_DATE for basis",
    );
  }
  return value;
}

export function parseBusinessPerformanceUuid(value: unknown, field: string): string {
  const normalized = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (!UUID_PATTERN.test(normalized)) {
    throw new BusinessPerformanceDataError(field, `Expected a UUID for ${field}`);
  }
  return normalized;
}

export function parseBusinessPerformanceIsoDate(value: unknown, field: string): string {
  const match = typeof value === "string" ? CANONICAL_DATE_PATTERN.exec(value) : null;
  if (!match) {
    throw new BusinessPerformanceDataError(
      field,
      `Expected a canonical ISO date YYYY-MM-DD for ${field}`,
    );
  }

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (day < 1 || day > daysInMonth[month - 1]) {
    throw new BusinessPerformanceDataError(field, `Expected a valid calendar date for ${field}`);
  }
  return match[0];
}

export function normalizeBusinessPerformancePnlMonth(value: unknown): string {
  if (typeof value === "string" && CANONICAL_MONTH_PATTERN.test(value)) {
    return `${value}-01`;
  }
  const date = parseBusinessPerformanceIsoDate(value, "month");
  return `${date.slice(0, 7)}-01`;
}

function monthOf(value: string): string {
  const month = value.slice(0, 7);
  parseCanonicalMonth(month);
  return month;
}

function ratioPercent(numerator: number, denominator: number): number | null {
  return denominator === 0 ? null : (numerator / denominator) * 100;
}

function changePercent(current: number | null, baseline: number | null): number | null {
  if (current == null || baseline == null || baseline === 0) return null;
  return ((current - baseline) / Math.abs(baseline)) * 100;
}

export function resolveBusinessPerformanceTab(
  value: string | null | undefined,
  canViewRestrictedFinance: boolean,
): BusinessPerformanceTabId {
  const fallback = canViewRestrictedFinance ? "business-overview" : "occupancy-vacancy";
  if (!value || !BUSINESS_PERFORMANCE_TAB_IDS.has(value as BusinessPerformanceTabId)) {
    return fallback;
  }
  const requested = value as BusinessPerformanceTabId;
  return canViewRestrictedFinance || !RESTRICTED_FINANCE_TABS.has(requested)
    ? requested
    : fallback;
}

function normalizeBuildingId(value: string): string {
  return value.trim().toLowerCase();
}

export function resolveAuthorizedBuildingIds(
  organization: BusinessPerformanceOrganization | null | undefined,
  selectedBuildingIds: readonly string[] | null | undefined,
): string[] {
  if (!organization) return [];

  const rosterIds = new Set(
    organization.authorized_buildings.map((building) => building.id),
  );
  if (!selectedBuildingIds || selectedBuildingIds.length === 0) {
    return sortedUnique([...rosterIds]);
  }

  return sortedUnique(
    selectedBuildingIds
      .map(normalizeBuildingId)
      .filter((buildingId) => rosterIds.has(buildingId)),
  );
}

export function canViewRestrictedBusinessPerformance(
  organization: BusinessPerformanceOrganization | null | undefined,
  selectedBuildingIds: readonly string[] | null | undefined,
): boolean {
  if (!organization) return false;

  const rosterById = new Map(
    organization.authorized_buildings.map((building) => [building.id, building]),
  );
  if (selectedBuildingIds && selectedBuildingIds.length > 0) {
    const hasUnknownBuilding = selectedBuildingIds.some((buildingId) => {
      const normalizedId = normalizeBuildingId(buildingId);
      return !normalizedId || !rosterById.has(normalizedId);
    });
    if (hasUnknownBuilding) return false;
  }

  const resolvedIds = resolveAuthorizedBuildingIds(
    organization,
    selectedBuildingIds,
  );
  return (
    resolvedIds.length > 0 &&
    resolvedIds.every(
      (buildingId) => rosterById.get(buildingId)?.restricted_allowed === true,
    )
  );
}

export function parseFiniteNumber(value: unknown, field: string): number {
  const parsed =
    typeof value === "number"
      ? value
      : typeof value === "string" && value.trim().length > 0
        ? Number(value)
        : Number.NaN;

  if (!Number.isFinite(parsed)) {
    throw new BusinessPerformanceDataError(
      field,
      `Expected a finite number for ${field}`,
    );
  }
  return parsed;
}

export function buildBusinessPerformanceFilters(
  month: string,
  buildingIds: readonly string[],
  basis: BusinessPerformanceBasis,
  organizationId: string,
): BusinessPerformanceFilters {
  parseCanonicalMonth(month);
  const normalizedOrganizationId = organizationId.trim();
  if (!normalizedOrganizationId) {
    throw new BusinessPerformanceDataError(
      "organizationId",
      "Expected an explicit organization ID",
    );
  }
  const normalizedBasis = parseBusinessPerformanceBasis(basis);

  const prevMonth = shiftMonth(month, -1);
  const yoyMonth = shiftMonth(month, -12);
  return {
    month,
    periodStart: `${month}-01`,
    periodEnd: monthEnd(month),
    prevMonth,
    yoyMonth,
    t13Start: `${yoyMonth}-01`,
    t13End: monthEnd(month),
    months12: Array.from({ length: 12 }, (_, index) => shiftMonth(month, index - 11)),
    buildingIds: sortedUnique(buildingIds),
    basis: normalizedBasis,
    organizationId: normalizedOrganizationId,
  };
}

export function aggregatePnlByMonth(
  rows: readonly BusinessPerformancePnlRow[],
  requestedMonths: readonly string[] = [],
): Map<string, BusinessPerformanceMonthAggregate> {
  const totals = new Map<
    string,
    Pick<BusinessPerformanceMonthAggregate, "month" | "revenue" | "expense" | "net">
  >();

  requestedMonths.forEach((month) => {
    parseCanonicalMonth(month);
    totals.set(month, { month, revenue: 0, expense: 0, net: 0 });
  });

  rows.forEach((row, index) => {
    const month = monthOf(row.month);
    const current = totals.get(month) ?? { month, revenue: 0, expense: 0, net: 0 };
    current.revenue += parseFiniteNumber(row.revenue, `pnl[${index}].revenue`);
    current.expense += parseFiniteNumber(row.expense, `pnl[${index}].expense`);
    current.net += parseFiniteNumber(row.net, `pnl[${index}].net`);
    totals.set(month, current);
  });

  return new Map(
    [...totals.entries()].map(([month, total]) => [
      month,
      {
        ...total,
        marginPct: ratioPercent(total.net, total.revenue),
        expenseRatioPct: ratioPercent(total.expense, total.revenue),
      },
    ]),
  );
}

export function buildPnlComparisons(
  rows: readonly BusinessPerformancePnlRow[],
  filters: BusinessPerformanceFilters,
): BusinessPerformanceComparison {
  const byMonth = aggregatePnlByMonth(rows, [
    filters.month,
    filters.prevMonth,
    filters.yoyMonth,
  ]);
  const current = byMonth.get(filters.month) ?? null;
  const previous = byMonth.get(filters.prevMonth) ?? null;
  const yearAgo = byMonth.get(filters.yoyMonth) ?? null;

  const metric = (
    key: "revenue" | "expense" | "net",
  ): BusinessPerformanceMetricComparison => {
    const currentValue = current?.[key] ?? null;
    const previousValue = previous?.[key] ?? null;
    const yearAgoValue = yearAgo?.[key] ?? null;
    return {
      current: currentValue,
      previous: previousValue,
      yearAgo: yearAgoValue,
      momPct: changePercent(currentValue, previousValue),
      yoyPct: changePercent(currentValue, yearAgoValue),
    };
  };

  return {
    current,
    previous,
    yearAgo,
    revenue: metric("revenue"),
    expense: metric("expense"),
    net: metric("net"),
  };
}

export function aggregateSnapshot(
  rows: readonly BusinessPerformanceSnapshotRow[],
): BusinessPerformanceSnapshotAggregate | null {
  if (rows.length === 0) return null;

  const total: Omit<BusinessPerformanceSnapshotAggregate, "avg_rent" | "occupancy_pct"> = {
    total_rooms: 0,
    rooms_available: 0,
    rooms_occupied: 0,
    rooms_reserved: 0,
    rooms_maintenance: 0,
    rooms_unavailable: 0,
    vacancy_loss_month: 0,
    active_contracts: 0,
    deposit_held: 0,
    receivable_total: 0,
    aging_not_due: 0,
    aging_1_30: 0,
    aging_31_60: 0,
    aging_61_90: 0,
    aging_over_90: 0,
  };
  let weightedRent = 0;

  rows.forEach((row, index) => {
    const activeContracts = parseFiniteNumber(
      row.active_contracts,
      `snapshot[${index}].active_contracts`,
    );
    total.total_rooms += parseFiniteNumber(row.total_rooms, `snapshot[${index}].total_rooms`);
    total.rooms_available += parseFiniteNumber(
      row.rooms_available,
      `snapshot[${index}].rooms_available`,
    );
    total.rooms_occupied += parseFiniteNumber(
      row.rooms_occupied,
      `snapshot[${index}].rooms_occupied`,
    );
    total.rooms_reserved += parseFiniteNumber(
      row.rooms_reserved,
      `snapshot[${index}].rooms_reserved`,
    );
    total.rooms_maintenance += parseFiniteNumber(
      row.rooms_maintenance,
      `snapshot[${index}].rooms_maintenance`,
    );
    total.rooms_unavailable += parseFiniteNumber(
      row.rooms_unavailable,
      `snapshot[${index}].rooms_unavailable`,
    );
    total.vacancy_loss_month += parseFiniteNumber(
      row.vacancy_loss_month,
      `snapshot[${index}].vacancy_loss_month`,
    );
    total.active_contracts += activeContracts;
    weightedRent +=
      parseFiniteNumber(row.avg_rent, `snapshot[${index}].avg_rent`) * activeContracts;
    total.deposit_held += parseFiniteNumber(
      row.deposit_held,
      `snapshot[${index}].deposit_held`,
    );
    total.receivable_total += parseFiniteNumber(
      row.receivable_total,
      `snapshot[${index}].receivable_total`,
    );
    total.aging_not_due += parseFiniteNumber(
      row.aging_not_due,
      `snapshot[${index}].aging_not_due`,
    );
    total.aging_1_30 += parseFiniteNumber(row.aging_1_30, `snapshot[${index}].aging_1_30`);
    total.aging_31_60 += parseFiniteNumber(
      row.aging_31_60,
      `snapshot[${index}].aging_31_60`,
    );
    total.aging_61_90 += parseFiniteNumber(
      row.aging_61_90,
      `snapshot[${index}].aging_61_90`,
    );
    total.aging_over_90 += parseFiniteNumber(
      row.aging_over_90,
      `snapshot[${index}].aging_over_90`,
    );
  });

  return {
    ...total,
    avg_rent: total.active_contracts > 0 ? weightedRent / total.active_contracts : null,
    occupancy_pct:
      total.total_rooms > 0 ? (total.rooms_occupied / total.total_rooms) * 100 : null,
  };
}

export const aggregateBusinessPerformancePnl = aggregatePnlByMonth;
export const buildBusinessPerformanceComparison = buildPnlComparisons;
