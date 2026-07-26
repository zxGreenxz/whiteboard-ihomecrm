import { useQuery, type UseQueryResult } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import {
  BusinessPerformanceDataError,
  normalizeBusinessPerformancePnlMonth,
  parseBusinessPerformanceBasis,
  parseBusinessPerformanceIsoDate,
  parseBusinessPerformanceUuid,
  parseFiniteNumber,
  type BusinessPerformanceAuthorizedBuilding,
  type BusinessPerformanceFilters,
  type BusinessPerformanceOrganization,
  type BusinessPerformancePnlRow,
  type BusinessPerformanceSnapshotRow,
} from "@/lib/businessPerformance";

const BUSINESS_PERFORMANCE_QUERY_KEY = "business-performance";
const HISTORICAL_STALE_TIME = 5 * 60 * 1000;
const LIVE_STALE_TIME = 60 * 1000;
const PNL_RPC_BUILDING_BATCH_SIZE = 50;
const OCCUPANCY_TREND_BUILDING_BATCH_SIZE = 50;
const PNL_NET_TOLERANCE_ULPS = 4;
const RECEIVABLE_PARTITION_TOLERANCE = 0.01;
const PERCENTAGE_ROUNDING_DECIMALS = 1;
const BUSINESS_DATE_FORMATTER = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Ho_Chi_Minh",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

export interface OccupancySnapshotRow {
  building_id: string;
  building_name: string;
  total: number;
  occupied: number;
  reserved: number;
  maintenance: number;
  unavailable: number;
  available: number;
  occupancy_pct: number;
  committed_pct: number;
  missed_revenue: number;
  generated_at: string;
}

export interface UpcomingVacancyRow {
  contract_id: string;
  contract_number: string;
  building_id: string;
  building_name: string;
  room_id: string;
  room_name: string;
  effective_end_date: string;
  days_remaining: number;
  rent_price: number;
  extension_applied: boolean;
}

export interface OccupancyTrendPoint {
  month: string;
  occupied: number;
  total: number;
  rate: number | null;
}

function sortedUniqueIds(ids: readonly string[]): string[] {
  return [...new Set(ids.map((id) => id.trim()).filter(Boolean))].sort((a, b) =>
    a.localeCompare(b),
  );
}

function chunkIds(ids: readonly string[], size: number): string[][] {
  const chunks: string[][] = [];
  for (let index = 0; index < ids.length; index += size) {
    chunks.push(ids.slice(index, index + size));
  }
  return chunks;
}

function requiredString(value: unknown, field: string): string {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!normalized) {
    throw new BusinessPerformanceDataError(
      field,
      `Expected a non-empty string for ${field}`,
    );
  }
  return normalized;
}

function requireExplicitIds(ids: readonly string[], field: string): void {
  if (ids.length === 0) {
    throw new BusinessPerformanceDataError(
      field,
      `Expected a non-empty explicit ${field} scope`,
    );
  }
}

function hasExplicitId(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function requireUuidIds(ids: readonly string[], field: string): string[] {
  requireExplicitIds(ids, field);
  return sortedUniqueIds(
    ids.map((id) => parseBusinessPerformanceUuid(id, field)),
  );
}

function requiredRows(value: unknown, field: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new BusinessPerformanceDataError(
      field,
      `Expected an array payload for ${field}`,
    );
  }
  return value;
}

function requiredRecord(
  value: unknown,
  field: string,
): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new BusinessPerformanceDataError(
      field,
      `Expected a non-null object for ${field}`,
    );
  }
  return value as Record<string, unknown>;
}

function requiredJsonObject(
  value: unknown,
  field: string,
): Record<string, unknown> {
  return requiredRecord(value, field);
}

function parseNonNegativeSafeInteger(value: unknown, field: string): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < 0
  ) {
    throw new BusinessPerformanceDataError(
      field,
      `Expected a non-negative safe integer for ${field}`,
    );
  }
  return value;
}

function parsePnlRow(value: unknown): BusinessPerformancePnlRow {
  const row = value as Record<string, unknown>;
  if (typeof row?.is_virtual !== "boolean") {
    throw new BusinessPerformanceDataError(
      "is_virtual",
      "Expected a boolean for is_virtual",
    );
  }
  if (row.is_virtual) {
    throw new BusinessPerformanceDataError(
      "is_virtual",
      "Business performance P&L accepts physical buildings only",
    );
  }
  const month = normalizeBusinessPerformancePnlMonth(row.month);
  const buildingId = parseBusinessPerformanceUuid(
    row.building_id,
    "building_id",
  );
  const buildingName = requiredString(row.building_name, "building_name");
  const revenue = parseFiniteNumber(row.revenue, "revenue");
  const expense = parseFiniteNumber(row.expense, "expense");
  const net = parseFiniteNumber(row.net, "net");
  const expectedNet = revenue - expense;
  const tolerance =
    Number.EPSILON *
    Math.max(1, Math.abs(revenue), Math.abs(expense), Math.abs(net)) *
    PNL_NET_TOLERANCE_ULPS;
  if (Math.abs(net - expectedNet) > tolerance) {
    throw new BusinessPerformanceDataError(
      "net",
      "Expected P&L net to equal revenue minus expense",
    );
  }
  return {
    month,
    building_id: buildingId,
    building_name: buildingName,
    is_virtual: row.is_virtual,
    revenue,
    expense,
    net,
  };
}

function parseSnapshotRow(value: unknown): BusinessPerformanceSnapshotRow {
  const row = value as Record<string, unknown>;
  const totalRooms = parseNonNegativeSafeInteger(
    row?.total_rooms,
    "total_rooms",
  );
  const roomsAvailable = parseNonNegativeSafeInteger(
    row?.rooms_available,
    "rooms_available",
  );
  const roomsOccupied = parseNonNegativeSafeInteger(
    row?.rooms_occupied,
    "rooms_occupied",
  );
  const roomsReserved = parseNonNegativeSafeInteger(
    row?.rooms_reserved,
    "rooms_reserved",
  );
  const roomsMaintenance = parseNonNegativeSafeInteger(
    row?.rooms_maintenance,
    "rooms_maintenance",
  );
  const roomsUnavailable = parseNonNegativeSafeInteger(
    row?.rooms_unavailable,
    "rooms_unavailable",
  );
  const partitionTotal = [
    roomsAvailable,
    roomsOccupied,
    roomsReserved,
    roomsMaintenance,
    roomsUnavailable,
  ].reduce((sum, count) => sum + BigInt(count), 0n);
  if (partitionTotal !== BigInt(totalRooms)) {
    throw new BusinessPerformanceDataError(
      "room_counts",
      "Expected snapshot room buckets to sum exactly to total_rooms",
    );
  }
  const vacancyLossMonth = parseNonNegativeNumber(
    row?.vacancy_loss_month,
    "vacancy_loss_month",
  );
  const avgRent = parseNonNegativeNumber(row?.avg_rent, "avg_rent");
  const depositHeld = parseNonNegativeNumber(
    row?.deposit_held,
    "deposit_held",
  );
  const receivableTotal = parseNonNegativeNumber(
    row?.receivable_total,
    "receivable_total",
  );
  const agingNotDue = parseNonNegativeNumber(
    row?.aging_not_due,
    "aging_not_due",
  );
  const aging1To30 = parseNonNegativeNumber(row?.aging_1_30, "aging_1_30");
  const aging31To60 = parseNonNegativeNumber(
    row?.aging_31_60,
    "aging_31_60",
  );
  const aging61To90 = parseNonNegativeNumber(
    row?.aging_61_90,
    "aging_61_90",
  );
  const agingOver90 = parseNonNegativeNumber(
    row?.aging_over_90,
    "aging_over_90",
  );
  const agingTotal =
    agingNotDue + aging1To30 + aging31To60 + aging61To90 + agingOver90;
  if (
    Math.abs(receivableTotal - agingTotal) >=
    RECEIVABLE_PARTITION_TOLERANCE
  ) {
    throw new BusinessPerformanceDataError(
      "receivable_total",
      "Expected receivable_total to equal the sum of aging buckets",
    );
  }

  return {
    building_id: parseBusinessPerformanceUuid(row?.building_id, "building_id"),
    building_name: requiredString(row?.building_name, "building_name"),
    total_rooms: totalRooms,
    rooms_available: roomsAvailable,
    rooms_occupied: roomsOccupied,
    rooms_reserved: roomsReserved,
    rooms_maintenance: roomsMaintenance,
    rooms_unavailable: roomsUnavailable,
    vacancy_loss_month: vacancyLossMonth,
    active_contracts: parseNonNegativeSafeInteger(
      row?.active_contracts,
      "active_contracts",
    ),
    avg_rent: avgRent,
    deposit_held: depositHeld,
    receivable_total: receivableTotal,
    aging_not_due: agingNotDue,
    aging_1_30: aging1To30,
    aging_31_60: aging31To60,
    aging_61_90: aging61To90,
    aging_over_90: agingOver90,
  };
}

function parseAuthorizedBuilding(
  value: unknown,
  index: number,
): BusinessPerformanceAuthorizedBuilding {
  const field = `authorized_buildings[${index}]`;
  const row = requiredRecord(value, field);
  const id = parseBusinessPerformanceUuid(row.id, `${field}.id`);
  const name = requiredString(row.name, `${field}.name`);
  if (typeof row.restricted_allowed !== "boolean") {
    throw new BusinessPerformanceDataError(
      `${field}.restricted_allowed`,
      `Expected a boolean for ${field}.restricted_allowed`,
    );
  }

  return {
    id,
    name,
    restricted_allowed: row.restricted_allowed,
    analysis_provenance: requiredJsonObject(
      row.analysis_provenance,
      `${field}.analysis_provenance`,
    ),
  };
}

function parseOrganizationRow(
  value: unknown,
  index: number,
): BusinessPerformanceOrganization {
  const row = requiredRecord(value, `organizations[${index}]`);
  const authorizedBuildings = requiredRows(
    row.authorized_buildings,
    "authorized_buildings",
  ).map(parseAuthorizedBuilding);
  if (authorizedBuildings.length === 0) {
    throw new BusinessPerformanceDataError(
      "authorized_buildings",
      "Expected at least one authorized physical building per organization",
    );
  }
  const buildingIds = new Set<string>();
  authorizedBuildings.forEach((building, buildingIndex) => {
    if (buildingIds.has(building.id)) {
      throw new BusinessPerformanceDataError(
        `authorized_buildings[${buildingIndex}].id`,
        "Business performance RPC returned a duplicate building within an organization",
      );
    }
    buildingIds.add(building.id);
  });

  const authorizedPhysicalBuildingCount = parseNonNegativeSafeInteger(
    row.authorized_physical_building_count,
    "authorized_physical_building_count",
  );
  if (authorizedPhysicalBuildingCount !== authorizedBuildings.length) {
    throw new BusinessPerformanceDataError(
      "authorized_physical_building_count",
      "Business performance RPC roster count does not match authorized buildings",
    );
  }

  return {
    id: parseBusinessPerformanceUuid(row.organization_id, "organization_id"),
    name: requiredString(row.organization_name, "organization_name"),
    authorized_buildings: authorizedBuildings,
    authorized_physical_building_count: authorizedPhysicalBuildingCount,
    authorization_version: parseNonNegativeSafeInteger(
      row.authorization_version,
      "authorization_version",
    ),
  };
}

function assertRequestedBuilding<T extends { building_id: string }>(
  row: T,
  requestedBuildingIds: ReadonlySet<string>,
): T {
  if (!requestedBuildingIds.has(row.building_id)) {
    throw new BusinessPerformanceDataError(
      "building_id",
      "Business performance RPC returned a building outside the explicit request scope",
    );
  }
  return row;
}

function assertCompleteBuildingScope<T extends { building_id: string }>(
  rows: readonly T[],
  requestedBuildingIds: readonly string[],
  field: string,
): void {
  const returnedIds = new Set(rows.map((row) => row.building_id));
  if (returnedIds.size !== rows.length) {
    throw new BusinessPerformanceDataError(
      field,
      "Business performance RPC returned duplicate rows for a requested building",
    );
  }
  for (const buildingId of requestedBuildingIds) {
    if (!returnedIds.has(buildingId)) {
      throw new BusinessPerformanceDataError(
        field,
        "Business performance RPC omitted a building from the explicit request scope",
      );
    }
  }
}

function assertUniquePnlRows(rows: readonly BusinessPerformancePnlRow[]): void {
  const seen = new Set<string>();
  for (const row of rows) {
    const key = `${row.building_id}:${row.month}`;
    if (seen.has(key)) {
      throw new BusinessPerformanceDataError(
        "pnl",
        "Business performance RPC returned duplicate building-month rows",
      );
    }
    seen.add(key);
  }
}

function assertPnlDateScope(
  row: BusinessPerformancePnlRow,
  startDate: string,
  endDate: string,
): BusinessPerformancePnlRow {
  const startMonth = `${startDate.slice(0, 7)}-01`;
  const endMonth = `${endDate.slice(0, 7)}-01`;
  if (row.month < startMonth || row.month > endMonth) {
    throw new BusinessPerformanceDataError(
      "month",
      "Business performance RPC returned a month outside the explicit request scope",
    );
  }
  return row;
}

function normalizedScopeIds(ids: readonly string[]): string[] {
  return sortedUniqueIds(ids.map((id) => id.toLowerCase()));
}

function hasValidUuid(value: string): boolean {
  try {
    parseBusinessPerformanceUuid(value, "uuid");
    return true;
  } catch {
    return false;
  }
}

function hasValidUuidScope(ids: readonly string[]): boolean {
  return ids.length > 0 && ids.every(hasValidUuid);
}

function hasValidIsoDate(value: string): boolean {
  try {
    parseBusinessPerformanceIsoDate(value, "date");
    return true;
  } catch {
    return false;
  }
}

function requireAuthenticatedUser(userId: string | null): string {
  if (!userId) {
    throw new BusinessPerformanceDataError(
      "userId",
      "Expected an authenticated Business Performance principal",
    );
  }
  return userId;
}

function parsePositiveSafeInteger(value: unknown, field: string): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value <= 0
  ) {
    throw new BusinessPerformanceDataError(
      field,
      `Expected a positive safe integer for ${field}`,
    );
  }
  return value;
}

function parseNonNegativeNumber(value: unknown, field: string): number {
  const parsed = parseFiniteNumber(value, field);
  if (parsed < 0) {
    throw new BusinessPerformanceDataError(
      field,
      `Expected a non-negative number for ${field}`,
    );
  }
  return parsed;
}

function parsePercentage(value: unknown, field: string): number {
  const parsed = parseFiniteNumber(value, field);
  if (parsed < 0 || parsed > 100) {
    throw new BusinessPerformanceDataError(
      field,
      `Expected ${field} to be between 0 and 100`,
    );
  }
  return parsed;
}

function roundedPercentage(numerator: number, denominator: number): number {
  if (denominator === 0) return 0;
  return Number(
    ((numerator / denominator) * 100).toFixed(PERCENTAGE_ROUNDING_DECIMALS),
  );
}

function assertPercentageMatches(
  actual: number,
  numerator: number,
  denominator: number,
  field: string,
): void {
  if (actual !== roundedPercentage(numerator, denominator)) {
    throw new BusinessPerformanceDataError(
      field,
      `Expected ${field} to match its room-count ratio`,
    );
  }
}

function parseBoolean(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") {
    throw new BusinessPerformanceDataError(
      field,
      `Expected a boolean for ${field}`,
    );
  }
  return value;
}

function parseIsoTimestamp(value: unknown, field: string): string {
  const timestamp = requiredString(value, field);
  if (!Number.isFinite(Date.parse(timestamp))) {
    throw new BusinessPerformanceDataError(
      field,
      `Expected a valid timestamp for ${field}`,
    );
  }
  return timestamp;
}

function businessDateParts(now: Date): {
  year: number;
  month: number;
  day: number;
} {
  const parts = BUSINESS_DATE_FORMATTER.formatToParts(now);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return {
    year: Number(values.year),
    month: Number(values.month),
    day: Number(values.day),
  };
}

function businessDate(now: Date): string {
  const { year, month, day } = businessDateParts(now);
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function monthStart(year: number, month: number): string {
  return `${year}-${String(month).padStart(2, "0")}-01`;
}

function shiftBusinessMonth(
  year: number,
  month: number,
  offset: number,
): { year: number; month: number } {
  const shifted = new Date(Date.UTC(year, month - 1 + offset, 1));
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
  };
}

function occupancyTrendRange(now: Date): {
  startDate: string;
  endDate: string;
} {
  const current = businessDateParts(now);
  const start = shiftBusinessMonth(current.year, current.month, -11);
  return {
    startDate: monthStart(start.year, start.month),
    endDate: monthStart(current.year, current.month),
  };
}

function occupancyDateFreshness(asOfDate: string): {
  staleTime: number;
  refetchInterval: number | false;
} {
  const isCurrentBusinessDate = asOfDate === businessDate(new Date());
  return {
    staleTime: isCurrentBusinessDate ? LIVE_STALE_TIME : HISTORICAL_STALE_TIME,
    refetchInterval: isCurrentBusinessDate ? LIVE_STALE_TIME : false,
  };
}

function parseOccupancySnapshotRow(
  value: unknown,
  requestedBuildingIds: ReadonlySet<string>,
): OccupancySnapshotRow {
  const row = requiredRecord(value, "occupancySnapshot");
  const total = parseNonNegativeSafeInteger(row.total, "total");
  const occupied = parseNonNegativeSafeInteger(row.occupied, "occupied");
  const reserved = parseNonNegativeSafeInteger(row.reserved, "reserved");
  const maintenance = parseNonNegativeSafeInteger(
    row.maintenance,
    "maintenance",
  );
  const unavailable = parseNonNegativeSafeInteger(
    row.unavailable,
    "unavailable",
  );
  const available = parseNonNegativeSafeInteger(row.available, "available");
  if (
    occupied + reserved + maintenance + unavailable + available !==
    total
  ) {
    throw new BusinessPerformanceDataError(
      "room_counts",
      "Expected occupancy snapshot buckets to sum exactly to total",
    );
  }
  const occupancyPct = parsePercentage(row.occupancy_pct, "occupancy_pct");
  const committedPct = parsePercentage(row.committed_pct, "committed_pct");
  assertPercentageMatches(occupancyPct, occupied, total, "occupancy_pct");
  assertPercentageMatches(
    committedPct,
    occupied + reserved,
    total,
    "committed_pct",
  );
  const parsed = {
    building_id: parseBusinessPerformanceUuid(row.building_id, "building_id"),
    building_name: requiredString(row.building_name, "building_name"),
    total,
    occupied,
    reserved,
    maintenance,
    unavailable,
    available,
    occupancy_pct: occupancyPct,
    committed_pct: committedPct,
    missed_revenue: parseNonNegativeNumber(
      row.missed_revenue,
      "missed_revenue",
    ),
    generated_at: parseIsoTimestamp(row.generated_at, "generated_at"),
  };
  return assertRequestedBuilding(parsed, requestedBuildingIds);
}

function parseUpcomingVacancyRow(
  value: unknown,
  requestedBuildingIds: ReadonlySet<string>,
  asOfDate: string,
  windowDays: number,
): UpcomingVacancyRow {
  const row = requiredRecord(value, "upcomingVacancy");
  const effectiveEndDate = parseBusinessPerformanceIsoDate(
    row.effective_end_date,
    "effective_end_date",
  );
  const daysRemaining = parseNonNegativeSafeInteger(
    row.days_remaining,
    "days_remaining",
  );
  const expectedDaysRemaining = Math.round(
    (Date.parse(`${effectiveEndDate}T00:00:00.000Z`) -
      Date.parse(`${asOfDate}T00:00:00.000Z`)) /
      86_400_000,
  );
  if (
    daysRemaining !== expectedDaysRemaining ||
    daysRemaining > windowDays
  ) {
    throw new BusinessPerformanceDataError(
      "days_remaining",
      "Expected days_remaining to match the requested vacancy window",
    );
  }
  const parsed = {
    contract_id: parseBusinessPerformanceUuid(row.contract_id, "contract_id"),
    contract_number: requiredString(row.contract_number, "contract_number"),
    building_id: parseBusinessPerformanceUuid(row.building_id, "building_id"),
    building_name: requiredString(row.building_name, "building_name"),
    room_id: parseBusinessPerformanceUuid(row.room_id, "room_id"),
    room_name: requiredString(row.room_name, "room_name"),
    effective_end_date: effectiveEndDate,
    days_remaining: daysRemaining,
    rent_price: parseNonNegativeNumber(row.rent_price, "rent_price"),
    extension_applied: parseBoolean(
      row.extension_applied,
      "extension_applied",
    ),
  };
  return assertRequestedBuilding(parsed, requestedBuildingIds);
}

function parseOccupancyMonth(value: unknown): {
  key: string;
  label: string;
} {
  const date = parseBusinessPerformanceIsoDate(value, "month");
  if (!date.endsWith("-01")) {
    throw new BusinessPerformanceDataError(
      "month",
      "Expected the first day of a canonical business month",
    );
  }
  return {
    key: date,
    label: `${Number(date.slice(5, 7))}/${date.slice(0, 4)}`,
  };
}

function parseOccupancyMonthlyRow(
  value: unknown,
  requestedBuildingIds: ReadonlySet<string>,
  startDate: string,
  endDate: string,
): {
  month: string;
  label: string;
  building_id: string;
  occupied: number;
  total: number;
} {
  const row = requiredRecord(value, "occupancyTrend");
  const month = parseOccupancyMonth(row.month);
  if (month.key < startDate || month.key > endDate) {
    throw new BusinessPerformanceDataError(
      "month",
      "Occupancy trend RPC returned a month outside the requested range",
    );
  }
  const occupied = parseNonNegativeSafeInteger(
    row.occupied_rooms,
    "occupied_rooms",
  );
  const total = parseNonNegativeSafeInteger(row.total_rooms, "total_rooms");
  if (occupied > total) {
    throw new BusinessPerformanceDataError(
      "occupied_rooms",
      "Occupancy trend occupied rooms cannot exceed total rooms",
    );
  }
  const occupancyPct = parsePercentage(row.occupancy_pct, "occupancy_pct");
  assertPercentageMatches(occupancyPct, occupied, total, "occupancy_pct");
  const building = assertRequestedBuilding(
    {
      building_id: parseBusinessPerformanceUuid(
        row.building_id,
        "building_id",
      ),
      building_name: requiredString(row.building_name, "building_name"),
    },
    requestedBuildingIds,
  );
  return {
    month: month.key,
    label: month.label,
    building_id: building.building_id,
    occupied,
    total,
  };
}

function occupancyMonthStarts(startDate: string, endDate: string): string[] {
  const current = new Date(`${startDate}T00:00:00.000Z`);
  const end = new Date(`${endDate}T00:00:00.000Z`);
  const months: string[] = [];
  while (current <= end) {
    months.push(
      `${current.getUTCFullYear()}-${String(current.getUTCMonth() + 1).padStart(2, "0")}-01`,
    );
    current.setUTCMonth(current.getUTCMonth() + 1);
  }
  return months;
}

function assertCompleteOccupancyTrendMatrix(
  rows: readonly ReturnType<typeof parseOccupancyMonthlyRow>[],
  requestedBuildingIds: readonly string[],
  expectedMonths: readonly string[],
): void {
  const expectedRowCount = requestedBuildingIds.length * expectedMonths.length;
  if (rows.length !== expectedRowCount) {
    throw new BusinessPerformanceDataError(
      "month",
      "Occupancy trend RPC omitted or added a building-month row",
    );
  }

  const returnedRows = new Set<string>();
  for (const row of rows) {
    const identity = `${row.building_id}:${row.month}`;
    if (returnedRows.has(identity)) {
      throw new BusinessPerformanceDataError(
        "month",
        "Occupancy trend RPC returned a duplicate building-month row",
      );
    }
    returnedRows.add(identity);
  }
  for (const buildingId of requestedBuildingIds) {
    for (const month of expectedMonths) {
      if (!returnedRows.has(`${buildingId}:${month}`)) {
        throw new BusinessPerformanceDataError(
          "month",
          "Occupancy trend RPC omitted a requested building-month row",
        );
      }
    }
  }
}

export function useBusinessPerformancePnl(
  filters: BusinessPerformanceFilters,
  enabled = true,
): UseQueryResult<BusinessPerformancePnlRow[], Error> {
  const { data: user } = useAuth();
  const userId = user?.id ?? null;
  const buildingIds = sortedUniqueIds(filters.buildingIds);
  const normalizedOrganizationId =
    typeof filters.organizationId === "string"
      ? filters.organizationId.trim().toLowerCase()
      : "";
  return useQuery({
    queryKey: [
      BUSINESS_PERFORMANCE_QUERY_KEY,
      userId,
      "pnl",
      normalizedOrganizationId,
      filters.basis,
      filters.t13Start,
      filters.t13End,
      buildingIds,
    ] as const,
    enabled:
      Boolean(userId) &&
      enabled &&
      buildingIds.length > 0 &&
      hasExplicitId(normalizedOrganizationId),
    staleTime: HISTORICAL_STALE_TIME,
    refetchInterval: HISTORICAL_STALE_TIME,
    queryFn: async () => {
      const requestedOrganizationId = parseBusinessPerformanceUuid(
        normalizedOrganizationId,
        "organizationId",
      );
      const requestedIds = requireUuidIds(buildingIds, "buildingIds");
      const basis = parseBusinessPerformanceBasis(filters.basis);
      const startDate = parseBusinessPerformanceIsoDate(
        filters.t13Start,
        "t13Start",
      );
      const endDate = parseBusinessPerformanceIsoDate(filters.t13End, "t13End");
      if (startDate > endDate) {
        throw new BusinessPerformanceDataError(
          "t13End",
          "Expected t13End to be on or after t13Start",
        );
      }
      const batches = chunkIds(requestedIds, PNL_RPC_BUILDING_BATCH_SIZE);
      const batchRows = await Promise.all(
        batches.map(async (batchIds) => {
          const params = {
            p_start_date: startDate,
            p_end_date: endDate,
            p_building_ids: batchIds,
          };
          const result = await supabase.rpc(
            "business_performance_pnl_v1",
            {
              ...params,
              p_organization_id: requestedOrganizationId,
              p_basis: basis,
            },
          );
          if (result.error) throw result.error;
          const batchBuildingIds = new Set(batchIds);
          const rows = requiredRows(result.data, "pnl")
            .map(parsePnlRow)
            .map((row) => assertRequestedBuilding(row, batchBuildingIds))
            .map((row) => assertPnlDateScope(row, startDate, endDate));
          assertUniquePnlRows(rows);
          return rows;
        }),
      );
      return batchRows.flat();
    },
  });
}

export function useBusinessPerformanceOrganizations(
  enabled = true,
): UseQueryResult<BusinessPerformanceOrganization[], Error> {
  const { data: user } = useAuth();
  const userId = user?.id ?? null;
  return useQuery({
    queryKey: [
      BUSINESS_PERFORMANCE_QUERY_KEY,
      userId,
      "organizations",
    ] as const,
    enabled: Boolean(userId) && enabled,
    staleTime: HISTORICAL_STALE_TIME,
    refetchInterval: HISTORICAL_STALE_TIME,
    queryFn: async () => {
      const { data, error } = await supabase.rpc(
        "business_performance_organizations_v1",
      );
      if (error) throw error;
      const rows = requiredRows(data, "organizations").map(parseOrganizationRow);
      const organizationIds = new Set<string>();
      const buildingIds = new Set<string>();
      for (const organization of rows) {
        if (organizationIds.has(organization.id)) {
          throw new BusinessPerformanceDataError(
            "organization_id",
            "Business performance RPC returned a duplicate organization",
          );
        }
        organizationIds.add(organization.id);
        for (const building of organization.authorized_buildings) {
          if (buildingIds.has(building.id)) {
            throw new BusinessPerformanceDataError(
              `authorized_buildings[${organization.authorized_buildings.indexOf(building)}].id`,
              "Business performance RPC returned a building in multiple organizations",
            );
          }
          buildingIds.add(building.id);
        }
      }
      return rows;
    },
  });
}

export function useBusinessPerformanceSnapshot(
  organizationId: string,
  buildingIds: readonly string[],
  enabled = true,
): UseQueryResult<BusinessPerformanceSnapshotRow[], Error> {
  const { data: user } = useAuth();
  const userId = user?.id ?? null;
  const sortedIds = sortedUniqueIds(buildingIds);
  const normalizedOrganizationId =
    typeof organizationId === "string"
      ? organizationId.trim().toLowerCase()
      : "";
  return useQuery({
    queryKey: [
      BUSINESS_PERFORMANCE_QUERY_KEY,
      userId,
      "snapshot",
      normalizedOrganizationId,
      sortedIds,
    ] as const,
    enabled:
      Boolean(userId) &&
      enabled &&
      sortedIds.length > 0 &&
      hasExplicitId(normalizedOrganizationId),
    staleTime: LIVE_STALE_TIME,
    refetchInterval: LIVE_STALE_TIME,
    queryFn: async () => {
      const requestedOrganizationId = parseBusinessPerformanceUuid(
        normalizedOrganizationId,
        "organizationId",
      );
      const requestedIds = requireUuidIds(sortedIds, "buildingIds");
      const requestedBuildingIds = new Set(requestedIds);
      const { data, error } = await supabase.rpc(
        "business_performance_snapshot_v1",
        {
          p_organization_id: requestedOrganizationId,
          p_building_ids: requestedIds,
        },
      );
      if (error) throw error;
      const rows = requiredRows(data, "snapshot")
        .map(parseSnapshotRow)
        .map((row) => assertRequestedBuilding(row, requestedBuildingIds));
      assertCompleteBuildingScope(rows, requestedIds, "building_id");
      return rows;
    },
  });
}

export function useBusinessPerformanceOccupancySnapshot(
  organizationId: string,
  asOfDate: string,
  buildingIds: readonly string[],
  enabled = true,
): UseQueryResult<OccupancySnapshotRow[], Error> {
  const { data: user } = useAuth();
  const userId = user?.id ?? null;
  const normalizedOrganizationId =
    typeof organizationId === "string"
      ? organizationId.trim().toLowerCase()
      : "";
  const normalizedBuildingIds = normalizedScopeIds(buildingIds);
  const validScope =
    hasValidUuid(normalizedOrganizationId) &&
    hasValidUuidScope(normalizedBuildingIds) &&
    hasValidIsoDate(asOfDate);

  return useQuery({
    queryKey: [
      BUSINESS_PERFORMANCE_QUERY_KEY,
      userId,
      "occupancy-snapshot",
      normalizedOrganizationId,
      asOfDate,
      normalizedBuildingIds,
    ] as const,
    enabled: Boolean(userId) && enabled && validScope,
    ...occupancyDateFreshness(asOfDate),
    refetchOnWindowFocus: "always",
    queryFn: async () => {
      requireAuthenticatedUser(userId);
      const requestedOrganizationId = parseBusinessPerformanceUuid(
        normalizedOrganizationId,
        "organizationId",
      );
      const requestedAsOfDate = parseBusinessPerformanceIsoDate(
        asOfDate,
        "asOfDate",
      );
      const requestedIds = requireUuidIds(
        normalizedBuildingIds,
        "buildingIds",
      );
      const requestedBuildingIds = new Set(requestedIds);
      const { data, error } = await supabase.rpc(
        "business_performance_occupancy_snapshot_v1",
        {
          p_organization_id: requestedOrganizationId,
          p_as_of_date: requestedAsOfDate,
          p_building_ids: requestedIds,
        },
      );
      if (error) throw error;
      const rows = requiredRows(data, "occupancySnapshot").map((row) =>
        parseOccupancySnapshotRow(row, requestedBuildingIds),
      );
      assertCompleteBuildingScope(rows, requestedIds, "building_id");
      return rows;
    },
  });
}

export function useBusinessPerformanceUpcomingVacancy(
  organizationId: string,
  asOfDate: string,
  windowDays: number,
  buildingIds: readonly string[],
  enabled = true,
): UseQueryResult<UpcomingVacancyRow[], Error> {
  const { data: user } = useAuth();
  const userId = user?.id ?? null;
  const normalizedOrganizationId =
    typeof organizationId === "string"
      ? organizationId.trim().toLowerCase()
      : "";
  const normalizedBuildingIds = normalizedScopeIds(buildingIds);
  const validWindow = Number.isSafeInteger(windowDays) && windowDays > 0;
  const validScope =
    hasValidUuid(normalizedOrganizationId) &&
    hasValidUuidScope(normalizedBuildingIds) &&
    hasValidIsoDate(asOfDate) &&
    validWindow;

  return useQuery({
    queryKey: [
      BUSINESS_PERFORMANCE_QUERY_KEY,
      userId,
      "upcoming-vacancy",
      normalizedOrganizationId,
      asOfDate,
      windowDays,
      normalizedBuildingIds,
    ] as const,
    enabled: Boolean(userId) && enabled && validScope,
    ...occupancyDateFreshness(asOfDate),
    refetchOnWindowFocus: "always",
    queryFn: async () => {
      requireAuthenticatedUser(userId);
      const requestedOrganizationId = parseBusinessPerformanceUuid(
        normalizedOrganizationId,
        "organizationId",
      );
      const requestedAsOfDate = parseBusinessPerformanceIsoDate(
        asOfDate,
        "asOfDate",
      );
      const requestedWindowDays = parsePositiveSafeInteger(
        windowDays,
        "windowDays",
      );
      const requestedIds = requireUuidIds(
        normalizedBuildingIds,
        "buildingIds",
      );
      const requestedBuildingIds = new Set(requestedIds);
      const { data, error } = await supabase.rpc(
        "business_performance_upcoming_vacancy_v1",
        {
          p_organization_id: requestedOrganizationId,
          p_as_of_date: requestedAsOfDate,
          p_window_days: requestedWindowDays,
          p_building_ids: requestedIds,
        },
      );
      if (error) throw error;
      const rows = requiredRows(data, "upcomingVacancy").map((row) =>
        parseUpcomingVacancyRow(
          row,
          requestedBuildingIds,
          requestedAsOfDate,
          requestedWindowDays,
        ),
      );
      const contractIds = new Set<string>();
      const roomIds = new Set<string>();
      for (const row of rows) {
        if (contractIds.has(row.contract_id)) {
          throw new BusinessPerformanceDataError(
            "contract_id",
            "Upcoming vacancy RPC returned a duplicate contract",
          );
        }
        if (roomIds.has(row.room_id)) {
          throw new BusinessPerformanceDataError(
            "room_id",
            "Upcoming vacancy RPC returned a duplicate room",
          );
        }
        contractIds.add(row.contract_id);
        roomIds.add(row.room_id);
      }
      return rows;
    },
  });
}

export function useBusinessPerformanceOccupancyTrend12m(
  organizationId: string,
  buildingIds: readonly string[],
  enabled = true,
): UseQueryResult<OccupancyTrendPoint[], Error> {
  const { data: user } = useAuth();
  const userId = user?.id ?? null;
  const normalizedOrganizationId =
    typeof organizationId === "string"
      ? organizationId.trim().toLowerCase()
      : "";
  const normalizedBuildingIds = normalizedScopeIds(buildingIds);
  const { startDate, endDate } = occupancyTrendRange(new Date());
  const validScope =
    hasValidUuid(normalizedOrganizationId) &&
    hasValidUuidScope(normalizedBuildingIds);

  return useQuery({
    queryKey: [
      BUSINESS_PERFORMANCE_QUERY_KEY,
      userId,
      "occupancy-trend-12m",
      normalizedOrganizationId,
      startDate,
      endDate,
      normalizedBuildingIds,
    ] as const,
    enabled: Boolean(userId) && enabled && validScope,
    staleTime: HISTORICAL_STALE_TIME,
    refetchInterval: HISTORICAL_STALE_TIME,
    refetchOnWindowFocus: "always",
    queryFn: async () => {
      requireAuthenticatedUser(userId);
      const requestedOrganizationId = parseBusinessPerformanceUuid(
        normalizedOrganizationId,
        "organizationId",
      );
      const requestedIds = requireUuidIds(
        normalizedBuildingIds,
        "buildingIds",
      );
      const batches = chunkIds(
        requestedIds,
        OCCUPANCY_TREND_BUILDING_BATCH_SIZE,
      );
      const expectedMonths = occupancyMonthStarts(startDate, endDate);
      const batchRows = await Promise.all(
        batches.map(async (batchIds) => {
          const { data, error } = await supabase.rpc(
            "business_performance_occupancy_monthly_v1",
            {
              p_organization_id: requestedOrganizationId,
              p_start_date: startDate,
              p_end_date: endDate,
              p_building_ids: batchIds,
            },
          );
          if (error) throw error;
          const batchBuildingIds = new Set(batchIds);
          const rows = requiredRows(data, "occupancyTrend").map((row) =>
            parseOccupancyMonthlyRow(
              row,
              batchBuildingIds,
              startDate,
              endDate,
            ),
          );
          assertCompleteOccupancyTrendMatrix(
            rows,
            batchIds,
            expectedMonths,
          );
          return rows;
        }),
      );
      const rows = batchRows.flat();
      const byMonth = new Map<
        string,
        { label: string; occupied: number; total: number }
      >();
      for (const row of rows) {
        const current = byMonth.get(row.month) ?? {
          label: row.label,
          occupied: 0,
          total: 0,
        };
        current.occupied += row.occupied;
        current.total += row.total;
        byMonth.set(row.month, current);
      }
      return [...byMonth.entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([, row]) => ({
          month: row.label,
          occupied: row.occupied,
          total: row.total,
          rate:
            row.total === 0
              ? null
              : Number(
                  ((row.occupied / row.total) * 100).toFixed(
                    PERCENTAGE_ROUNDING_DECIMALS,
                  ),
                ),
        }));
    },
  });
}
