import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseMutationResult,
  type UseQueryResult,
} from "@tanstack/react-query";

import { useAuth } from "@/hooks/useAuth";
import { supabase } from "@/integrations/supabase/client";
import {
  BusinessPerformanceDataError,
  parseBusinessPerformanceBasis,
  parseBusinessPerformanceIsoDate,
  parseBusinessPerformanceUuid,
  parseFiniteNumber,
  type BusinessPerformanceFilters,
} from "@/lib/businessPerformance";

const QUERY_ROOT = "business-performance";
const HISTORICAL_STALE_TIME = 5 * 60 * 1000;
const LIVE_STALE_TIME = 60 * 1000;

export type FinanceReportingRole =
  | "ROOM_RENT_REVENUE"
  | "OTHER_OPERATING_REVENUE"
  | "PASS_THROUGH_REVENUE"
  | "LANDLORD_RENT_FIXED"
  | "OTHER_FIXED_COST"
  | "ROOM_VARIABLE_COST"
  | "OTHER_VARIABLE_COST"
  | "PASS_THROUGH_EXPENSE"
  | "OUTSIDE_BREAK_EVEN_MODEL";

export interface BusinessPerformanceReportingRoleRow {
  income_expense_type_id: string;
  type_name: string;
  side: "INCOME" | "EXPENSE";
  category: string | null;
  finance_reporting_role: FinanceReportingRole | null;
  effective_from: string | null;
  effective_to: string | null;
  confirmed_at: string | null;
  confirmed_by: string | null;
  suggested_role: FinanceReportingRole | null;
  can_manage: boolean;
}

export interface BusinessPerformanceInventoryHistoryRow {
  snapshot_month: string;
  building_id: string;
  building_name: string;
  snapshot_status: "MISSING" | "PROVISIONAL" | "FINALIZED" | "MISSED";
  snapshot_missing: boolean;
  availability_reason: string | null;
  total: number | null;
  occupied: number | null;
  reserved: number | null;
  maintenance: number | null;
  unavailable: number | null;
  available: number | null;
  occupancy_pct: number | null;
  committed_pct: number | null;
  listed_rent_opportunity: number | null;
  capacity_current: number | null;
  capacity_blocked: number | null;
  capacity_theory: number | null;
  invalid_rent_room_count: number | null;
  as_of_date: string | null;
  as_of_timestamp: string | null;
  captured_at: string | null;
  is_late: boolean | null;
  capture_version: number | null;
}

export interface BusinessPerformanceBreakEvenRow {
  building_id: string;
  building_name: string;
  analysis_window: "SELECTED_MONTH" | "THREE_MONTH_AVERAGE";
  window_start: string;
  window_end: string;
  source_month_count: number;
  valid_month_count: number;
  revenue: number;
  expense: number;
  net: number;
  gap_to_zero: number;
  r_room: number;
  r_other: number;
  r_pass: number;
  f_landlord: number;
  f_other: number;
  v_room: number;
  v_other: number;
  e_pass: number;
  mapping_coverage_pct: number | null;
  unmapped_amount: number;
  outside_model_amount: number;
  missing_landlord_months: string[];
  cmr_core: number | null;
  cmr_room: number | null;
  r_core_be: number | null;
  r_total_be: number | null;
  r_room_be: number | null;
  break_even_revenue_available: boolean;
  break_even_revenue_reason: string | null;
  room_break_even_revenue_available: boolean;
  room_break_even_revenue_reason: string | null;
  capacity_current: number | null;
  capacity_blocked: number | null;
  capacity_theory: number | null;
  invalid_rent_room_count: number | null;
  break_even_occupancy_current: number | null;
  break_even_occupancy_theory: number | null;
  room_revenue_utilization_pct: number | null;
  break_even_occupancy_available: boolean;
  break_even_occupancy_reason: string | null;
  capacity_source: "LIVE" | "FINALIZED_SNAPSHOT" | "UNAVAILABLE";
  capacity_as_of: string | null;
  generated_at: string;
}

export interface BusinessPerformanceInvoiceCohortRow {
  building_id: string;
  building_name: string;
  cohort_month: string;
  cohort_available: boolean;
  billed_current_charge: number | null;
  collected_current_charge: number | null;
  remaining_current_charge: number | null;
  collection_rate_pct: number | null;
  invoice_count: number;
  allocation_unknown_count: number;
  allocation_unknown_amount: number;
  component_anomaly_count: number;
  carried_invoice_debt: number;
  carried_deposit_debt: number;
  current_deposit: number;
  draft_pending_count: number;
  draft_pending_amount: number;
  settlement_count: number;
  settlement_amount: number;
  generated_at: string;
}

export interface BusinessPerformanceCashReceivedRow {
  building_id: string;
  building_name: string;
  cash_month: string;
  cash_received: number;
  payment_event_count: number;
  first_payment_date: string | null;
  last_payment_date: string | null;
  generated_at: string;
}

export interface BusinessPerformanceCategoryBreakdownRow {
  month: string;
  side: "INCOME" | "EXPENSE";
  type_id: string | null;
  type_name: string | null;
  category: string | null;
  total_amount: number;
  voucher_count: number;
}

export interface SetBusinessPerformanceReportingRoleInput {
  incomeExpenseTypeId: string;
  role: FinanceReportingRole | string;
  effectiveFrom: string;
}

export interface SetBusinessPerformanceReportingRoleResult {
  assignment_id: string;
  finance_reporting_role: FinanceReportingRole;
  effective_from: string;
  effective_to: string | null;
  confirmed_at: string;
  confirmed_by: string;
}

function record(value: unknown, field: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new BusinessPerformanceDataError(field, `Expected an object for ${field}`);
  }
  return value as Record<string, unknown>;
}

function rows(value: unknown, field: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new BusinessPerformanceDataError(field, `Expected an array for ${field}`);
  }
  return value;
}

function string(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new BusinessPerformanceDataError(field, `Expected text for ${field}`);
  }
  return value.trim();
}

function nullableString(value: unknown, field: string): string | null {
  return value === null ? null : string(value, field);
}

function bool(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") {
    throw new BusinessPerformanceDataError(field, `Expected a boolean for ${field}`);
  }
  return value;
}

function nullableBool(value: unknown, field: string): boolean | null {
  return value === null ? null : bool(value, field);
}

function integer(value: unknown, field: string): number {
  const parsed = parseFiniteNumber(value, field);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new BusinessPerformanceDataError(field, `Expected a non-negative integer for ${field}`);
  }
  return parsed;
}

function nullableInteger(value: unknown, field: string): number | null {
  return value === null ? null : integer(value, field);
}

function number(value: unknown, field: string): number {
  return parseFiniteNumber(value, field);
}

function nonNegativeNumber(value: unknown, field: string): number {
  const parsed = number(value, field);
  if (parsed < 0) {
    throw new BusinessPerformanceDataError(field, `Expected a non-negative number for ${field}`);
  }
  return parsed;
}

function nullableNumber(value: unknown, field: string): number | null {
  return value === null ? null : number(value, field);
}

function date(value: unknown, field: string): string {
  return parseBusinessPerformanceIsoDate(value, field);
}

function nullableDate(value: unknown, field: string): string | null {
  return value === null ? null : date(value, field);
}

function timestamp(value: unknown, field: string): string {
  const parsed = string(value, field);
  if (!Number.isFinite(Date.parse(parsed))) {
    throw new BusinessPerformanceDataError(field, `Expected an ISO timestamp for ${field}`);
  }
  return parsed;
}

function nullableTimestamp(value: unknown, field: string): string | null {
  return value === null ? null : timestamp(value, field);
}

function enumValue<T extends string>(
  value: unknown,
  field: string,
  allowed: readonly T[],
): T {
  const parsed = string(value, field) as T;
  if (!allowed.includes(parsed)) {
    throw new BusinessPerformanceDataError(field, `Unexpected value for ${field}`);
  }
  return parsed;
}

const REPORTING_ROLES: readonly FinanceReportingRole[] = [
  "ROOM_RENT_REVENUE",
  "OTHER_OPERATING_REVENUE",
  "PASS_THROUGH_REVENUE",
  "LANDLORD_RENT_FIXED",
  "OTHER_FIXED_COST",
  "ROOM_VARIABLE_COST",
  "OTHER_VARIABLE_COST",
  "PASS_THROUGH_EXPENSE",
  "OUTSIDE_BREAK_EVEN_MODEL",
];

function nullableRole(value: unknown, field: string): FinanceReportingRole | null {
  return value === null ? null : enumValue(value, field, REPORTING_ROLES);
}

function normalizedScope(filters: BusinessPerformanceFilters) {
  const organizationId = parseBusinessPerformanceUuid(
    filters.organizationId,
    "organizationId",
  );
  const buildingIds = [...new Set(filters.buildingIds)]
    .map((id) => parseBusinessPerformanceUuid(id, "buildingIds"))
    .sort((left, right) => left.localeCompare(right));
  if (buildingIds.length === 0) {
    throw new BusinessPerformanceDataError("buildingIds", "Expected explicit building scope");
  }
  return { organizationId, buildingIds, buildingSet: new Set(buildingIds) };
}

function assertBuilding(buildingId: string, buildingSet: ReadonlySet<string>) {
  if (!buildingSet.has(buildingId)) {
    throw new BusinessPerformanceDataError(
      "building_id",
      "Business-performance RPC returned a building outside the requested scope",
    );
  }
  return buildingId;
}

function parseReportingRoleRow(value: unknown): BusinessPerformanceReportingRoleRow {
  const row = record(value, "reporting_role");
  return {
    income_expense_type_id: parseBusinessPerformanceUuid(
      row.income_expense_type_id,
      "income_expense_type_id",
    ),
    type_name: string(row.type_name, "type_name"),
    side: enumValue(row.side, "side", ["INCOME", "EXPENSE"] as const),
    category: nullableString(row.category, "category"),
    finance_reporting_role: nullableRole(
      row.finance_reporting_role,
      "finance_reporting_role",
    ),
    effective_from: nullableDate(row.effective_from, "effective_from"),
    effective_to: nullableDate(row.effective_to, "effective_to"),
    confirmed_at: nullableTimestamp(row.confirmed_at, "confirmed_at"),
    confirmed_by:
      row.confirmed_by === null
        ? null
        : parseBusinessPerformanceUuid(row.confirmed_by, "confirmed_by"),
    suggested_role: nullableRole(row.suggested_role, "suggested_role"),
    can_manage: bool(row.can_manage, "can_manage"),
  };
}

function parseInventoryRow(
  value: unknown,
  buildingSet: ReadonlySet<string>,
): BusinessPerformanceInventoryHistoryRow {
  const row = record(value, "inventory_history");
  const snapshotMissing = bool(row.snapshot_missing, "snapshot_missing");
  const parsed: BusinessPerformanceInventoryHistoryRow = {
    snapshot_month: date(row.snapshot_month, "snapshot_month"),
    building_id: assertBuilding(
      parseBusinessPerformanceUuid(row.building_id, "building_id"),
      buildingSet,
    ),
    building_name: string(row.building_name, "building_name"),
    snapshot_status: enumValue(row.snapshot_status, "snapshot_status", [
      "MISSING",
      "PROVISIONAL",
      "FINALIZED",
      "MISSED",
    ] as const),
    snapshot_missing: snapshotMissing,
    availability_reason: nullableString(row.availability_reason, "availability_reason"),
    total: nullableInteger(row.total, "total"),
    occupied: nullableInteger(row.occupied, "occupied"),
    reserved: nullableInteger(row.reserved, "reserved"),
    maintenance: nullableInteger(row.maintenance, "maintenance"),
    unavailable: nullableInteger(row.unavailable, "unavailable"),
    available: nullableInteger(row.available, "available"),
    occupancy_pct: nullableNumber(row.occupancy_pct, "occupancy_pct"),
    committed_pct: nullableNumber(row.committed_pct, "committed_pct"),
    listed_rent_opportunity: nullableNumber(
      row.listed_rent_opportunity,
      "listed_rent_opportunity",
    ),
    capacity_current: nullableNumber(row.capacity_current, "capacity_current"),
    capacity_blocked: nullableNumber(row.capacity_blocked, "capacity_blocked"),
    capacity_theory: nullableNumber(row.capacity_theory, "capacity_theory"),
    invalid_rent_room_count: nullableInteger(
      row.invalid_rent_room_count,
      "invalid_rent_room_count",
    ),
    as_of_date: nullableDate(row.as_of_date, "as_of_date"),
    as_of_timestamp: nullableTimestamp(row.as_of_timestamp, "as_of_timestamp"),
    captured_at: nullableTimestamp(row.captured_at, "captured_at"),
    is_late: nullableBool(row.is_late, "is_late"),
    capture_version: nullableInteger(row.capture_version, "capture_version"),
  };

  const metricFields = [
    parsed.total,
    parsed.occupied,
    parsed.reserved,
    parsed.maintenance,
    parsed.unavailable,
    parsed.available,
    parsed.occupancy_pct,
    parsed.committed_pct,
    parsed.listed_rent_opportunity,
    parsed.capacity_current,
    parsed.capacity_blocked,
    parsed.capacity_theory,
    parsed.invalid_rent_room_count,
  ];
  if (snapshotMissing && metricFields.some((metric) => metric !== null)) {
    throw new BusinessPerformanceDataError(
      "snapshot_missing",
      "Missing inventory snapshots must not contain fake metrics",
    );
  }
  if (!snapshotMissing) {
    if (metricFields.some((metric) => metric === null)) {
      throw new BusinessPerformanceDataError(
        "snapshot_missing",
        "Available inventory snapshots require complete metrics",
      );
    }
    if (
      parsed.total !==
      (parsed.occupied ?? 0) +
        (parsed.reserved ?? 0) +
        (parsed.maintenance ?? 0) +
        (parsed.unavailable ?? 0) +
        (parsed.available ?? 0)
    ) {
      throw new BusinessPerformanceDataError(
        "total",
        "Inventory snapshot room groups must partition total rooms",
      );
    }
  }
  return parsed;
}

function parseBreakEvenRow(
  value: unknown,
  buildingSet: ReadonlySet<string>,
): BusinessPerformanceBreakEvenRow {
  const row = record(value, "break_even");
  const nonNegativeFields = [
    "revenue",
    "expense",
    "r_room",
    "r_other",
    "r_pass",
    "f_landlord",
    "f_other",
    "v_room",
    "v_other",
    "e_pass",
    "unmapped_amount",
    "outside_model_amount",
  ] as const;
  const parsedNonNegative = Object.fromEntries(
    nonNegativeFields.map((field) => [field, nonNegativeNumber(row[field], field)]),
  ) as Record<(typeof nonNegativeFields)[number], number>;
  if (!Array.isArray(row.missing_landlord_months)) {
    throw new BusinessPerformanceDataError(
      "missing_landlord_months",
      "Expected a month array for missing_landlord_months",
    );
  }
  return {
    building_id: assertBuilding(
      parseBusinessPerformanceUuid(row.building_id, "building_id"),
      buildingSet,
    ),
    building_name: string(row.building_name, "building_name"),
    analysis_window: enumValue(row.analysis_window, "analysis_window", [
      "SELECTED_MONTH",
      "THREE_MONTH_AVERAGE",
    ] as const),
    window_start: date(row.window_start, "window_start"),
    window_end: date(row.window_end, "window_end"),
    source_month_count: integer(row.source_month_count, "source_month_count"),
    valid_month_count: integer(row.valid_month_count, "valid_month_count"),
    ...parsedNonNegative,
    net: number(row.net, "net"),
    gap_to_zero: number(row.gap_to_zero, "gap_to_zero"),
    mapping_coverage_pct: nullableNumber(
      row.mapping_coverage_pct,
      "mapping_coverage_pct",
    ),
    missing_landlord_months: row.missing_landlord_months.map((month) =>
      date(month, "missing_landlord_months"),
    ),
    cmr_core: nullableNumber(row.cmr_core, "cmr_core"),
    cmr_room: nullableNumber(row.cmr_room, "cmr_room"),
    r_core_be: nullableNumber(row.r_core_be, "r_core_be"),
    r_total_be: nullableNumber(row.r_total_be, "r_total_be"),
    r_room_be: nullableNumber(row.r_room_be, "r_room_be"),
    break_even_revenue_available: bool(
      row.break_even_revenue_available,
      "break_even_revenue_available",
    ),
    break_even_revenue_reason: nullableString(
      row.break_even_revenue_reason,
      "break_even_revenue_reason",
    ),
    room_break_even_revenue_available: bool(
      row.room_break_even_revenue_available,
      "room_break_even_revenue_available",
    ),
    room_break_even_revenue_reason: nullableString(
      row.room_break_even_revenue_reason,
      "room_break_even_revenue_reason",
    ),
    capacity_current: nullableNumber(row.capacity_current, "capacity_current"),
    capacity_blocked: nullableNumber(row.capacity_blocked, "capacity_blocked"),
    capacity_theory: nullableNumber(row.capacity_theory, "capacity_theory"),
    invalid_rent_room_count: nullableInteger(
      row.invalid_rent_room_count,
      "invalid_rent_room_count",
    ),
    break_even_occupancy_current: nullableNumber(
      row.break_even_occupancy_current,
      "break_even_occupancy_current",
    ),
    break_even_occupancy_theory: nullableNumber(
      row.break_even_occupancy_theory,
      "break_even_occupancy_theory",
    ),
    room_revenue_utilization_pct: nullableNumber(
      row.room_revenue_utilization_pct,
      "room_revenue_utilization_pct",
    ),
    break_even_occupancy_available: bool(
      row.break_even_occupancy_available,
      "break_even_occupancy_available",
    ),
    break_even_occupancy_reason: nullableString(
      row.break_even_occupancy_reason,
      "break_even_occupancy_reason",
    ),
    capacity_source: enumValue(row.capacity_source, "capacity_source", [
      "LIVE",
      "FINALIZED_SNAPSHOT",
      "UNAVAILABLE",
    ] as const),
    capacity_as_of: nullableTimestamp(row.capacity_as_of, "capacity_as_of"),
    generated_at: timestamp(row.generated_at, "generated_at"),
  };
}

function parseCohortRow(
  value: unknown,
  buildingSet: ReadonlySet<string>,
): BusinessPerformanceInvoiceCohortRow {
  const row = record(value, "invoice_cohort");
  return {
    building_id: assertBuilding(
      parseBusinessPerformanceUuid(row.building_id, "building_id"),
      buildingSet,
    ),
    building_name: string(row.building_name, "building_name"),
    cohort_month: date(row.cohort_month, "cohort_month"),
    cohort_available: bool(row.cohort_available, "cohort_available"),
    billed_current_charge: nullableNumber(
      row.billed_current_charge,
      "billed_current_charge",
    ),
    collected_current_charge: nullableNumber(
      row.collected_current_charge,
      "collected_current_charge",
    ),
    remaining_current_charge: nullableNumber(
      row.remaining_current_charge,
      "remaining_current_charge",
    ),
    collection_rate_pct: nullableNumber(
      row.collection_rate_pct,
      "collection_rate_pct",
    ),
    invoice_count: integer(row.invoice_count, "invoice_count"),
    allocation_unknown_count: integer(
      row.allocation_unknown_count,
      "allocation_unknown_count",
    ),
    allocation_unknown_amount: nonNegativeNumber(
      row.allocation_unknown_amount,
      "allocation_unknown_amount",
    ),
    component_anomaly_count: integer(
      row.component_anomaly_count,
      "component_anomaly_count",
    ),
    carried_invoice_debt: nonNegativeNumber(
      row.carried_invoice_debt,
      "carried_invoice_debt",
    ),
    carried_deposit_debt: nonNegativeNumber(
      row.carried_deposit_debt,
      "carried_deposit_debt",
    ),
    current_deposit: nonNegativeNumber(row.current_deposit, "current_deposit"),
    draft_pending_count: integer(row.draft_pending_count, "draft_pending_count"),
    draft_pending_amount: nonNegativeNumber(
      row.draft_pending_amount,
      "draft_pending_amount",
    ),
    settlement_count: integer(row.settlement_count, "settlement_count"),
    settlement_amount: nonNegativeNumber(row.settlement_amount, "settlement_amount"),
    generated_at: timestamp(row.generated_at, "generated_at"),
  };
}

function parseCashRow(
  value: unknown,
  buildingSet: ReadonlySet<string>,
): BusinessPerformanceCashReceivedRow {
  const row = record(value, "cash_received");
  return {
    building_id: assertBuilding(
      parseBusinessPerformanceUuid(row.building_id, "building_id"),
      buildingSet,
    ),
    building_name: string(row.building_name, "building_name"),
    cash_month: date(row.cash_month, "cash_month"),
    cash_received: nonNegativeNumber(row.cash_received, "cash_received"),
    payment_event_count: integer(row.payment_event_count, "payment_event_count"),
    first_payment_date: nullableDate(row.first_payment_date, "first_payment_date"),
    last_payment_date: nullableDate(row.last_payment_date, "last_payment_date"),
    generated_at: timestamp(row.generated_at, "generated_at"),
  };
}

function parseCategoryRow(value: unknown): BusinessPerformanceCategoryBreakdownRow {
  const row = record(value, "category_breakdown");
  return {
    month: date(row.month, "month"),
    side: enumValue(row.side, "side", ["INCOME", "EXPENSE"] as const),
    type_id:
      row.type_id === null
        ? null
        : parseBusinessPerformanceUuid(row.type_id, "type_id"),
    type_name: nullableString(row.type_name, "type_name"),
    category: nullableString(row.category, "category"),
    total_amount: nonNegativeNumber(row.total_amount, "total_amount"),
    voucher_count: integer(row.voucher_count, "voucher_count"),
  };
}

function queryEnabled(
  userId: string | null,
  filters: BusinessPerformanceFilters,
  enabled: boolean,
) {
  return Boolean(userId && enabled && filters.organizationId && filters.buildingIds.length > 0);
}

export function useBusinessPerformanceReportingRoles(
  filters: BusinessPerformanceFilters,
  enabled = true,
): UseQueryResult<BusinessPerformanceReportingRoleRow[], Error> {
  const { data: user } = useAuth();
  const userId = user?.id ?? null;
  const scope = normalizedScope(filters);
  const month = date(`${filters.month}-01`, "month");
  return useQuery({
    queryKey: [QUERY_ROOT, userId, "reporting-roles", scope.organizationId, month, scope.buildingIds],
    enabled: queryEnabled(userId, filters, enabled),
    staleTime: HISTORICAL_STALE_TIME,
    queryFn: async () => {
      const { data, error } = await supabase.rpc(
        "business_performance_reporting_roles_v1",
        {
          p_organization_id: scope.organizationId,
          p_month: month,
          p_building_ids: scope.buildingIds,
        },
      );
      if (error) throw error;
      return rows(data, "reporting_roles").map(parseReportingRoleRow);
    },
  });
}

export function useBusinessPerformanceInventoryHistory(
  filters: BusinessPerformanceFilters,
  startMonth: string,
  endMonth: string,
  enabled = true,
): UseQueryResult<BusinessPerformanceInventoryHistoryRow[], Error> {
  const { data: user } = useAuth();
  const userId = user?.id ?? null;
  const scope = normalizedScope(filters);
  const start = date(startMonth, "startMonth");
  const end = date(endMonth, "endMonth");
  if (start > end) {
    throw new BusinessPerformanceDataError("endMonth", "Expected endMonth after startMonth");
  }
  return useQuery({
    queryKey: [QUERY_ROOT, userId, "inventory-history", scope.organizationId, start, end, scope.buildingIds],
    enabled: queryEnabled(userId, filters, enabled),
    staleTime: HISTORICAL_STALE_TIME,
    queryFn: async () => {
      const { data, error } = await supabase.rpc(
        "business_performance_inventory_history_v1",
        {
          p_organization_id: scope.organizationId,
          p_start_month: start,
          p_end_month: end,
          p_building_ids: scope.buildingIds,
        },
      );
      if (error) throw error;
      return rows(data, "inventory_history").map((value) =>
        parseInventoryRow(value, scope.buildingSet),
      );
    },
  });
}

export function useBusinessPerformanceBreakEven(
  filters: BusinessPerformanceFilters,
  enabled = true,
): UseQueryResult<BusinessPerformanceBreakEvenRow[], Error> {
  const { data: user } = useAuth();
  const userId = user?.id ?? null;
  const scope = normalizedScope(filters);
  const month = date(`${filters.month}-01`, "month");
  const basis = parseBusinessPerformanceBasis(filters.basis);
  return useQuery({
    queryKey: [QUERY_ROOT, userId, "break-even", scope.organizationId, basis, month, scope.buildingIds],
    enabled: queryEnabled(userId, filters, enabled),
    staleTime: LIVE_STALE_TIME,
    queryFn: async () => {
      const { data, error } = await supabase.rpc("business_performance_break_even_v1", {
        p_organization_id: scope.organizationId,
        p_basis: basis,
        p_month: month,
        p_building_ids: scope.buildingIds,
      });
      if (error) throw error;
      return rows(data, "break_even").map((value) =>
        parseBreakEvenRow(value, scope.buildingSet),
      );
    },
  });
}

export function useBusinessPerformanceInvoiceCohort(
  filters: BusinessPerformanceFilters,
  enabled = true,
): UseQueryResult<BusinessPerformanceInvoiceCohortRow[], Error> {
  const { data: user } = useAuth();
  const userId = user?.id ?? null;
  const scope = normalizedScope(filters);
  const month = date(`${filters.month}-01`, "month");
  return useQuery({
    queryKey: [QUERY_ROOT, userId, "invoice-cohort", scope.organizationId, month, scope.buildingIds],
    enabled: queryEnabled(userId, filters, enabled),
    staleTime: LIVE_STALE_TIME,
    queryFn: async () => {
      const { data, error } = await supabase.rpc(
        "business_performance_invoice_cohort_v1",
        {
          p_organization_id: scope.organizationId,
          p_cohort_month: month,
          p_building_ids: scope.buildingIds,
        },
      );
      if (error) throw error;
      return rows(data, "invoice_cohort").map((value) =>
        parseCohortRow(value, scope.buildingSet),
      );
    },
  });
}

export function useBusinessPerformanceCashReceived(
  filters: BusinessPerformanceFilters,
  enabled = true,
): UseQueryResult<BusinessPerformanceCashReceivedRow[], Error> {
  const { data: user } = useAuth();
  const userId = user?.id ?? null;
  const scope = normalizedScope(filters);
  const month = date(`${filters.month}-01`, "month");
  return useQuery({
    queryKey: [QUERY_ROOT, userId, "cash-received", scope.organizationId, month, scope.buildingIds],
    enabled: queryEnabled(userId, filters, enabled),
    staleTime: LIVE_STALE_TIME,
    queryFn: async () => {
      const { data, error } = await supabase.rpc(
        "business_performance_cash_received_v1",
        {
          p_organization_id: scope.organizationId,
          p_month: month,
          p_building_ids: scope.buildingIds,
        },
      );
      if (error) throw error;
      return rows(data, "cash_received").map((value) =>
        parseCashRow(value, scope.buildingSet),
      );
    },
  });
}

export function useBusinessPerformanceCategoryBreakdown(
  filters: BusinessPerformanceFilters,
  enabled = true,
): UseQueryResult<BusinessPerformanceCategoryBreakdownRow[], Error> {
  const { data: user } = useAuth();
  const userId = user?.id ?? null;
  const scope = normalizedScope(filters);
  const basis = parseBusinessPerformanceBasis(filters.basis);
  const startDate = date(filters.periodStart, "periodStart");
  const endDate = date(filters.periodEnd, "periodEnd");
  return useQuery({
    queryKey: [QUERY_ROOT, userId, "category-breakdown", scope.organizationId, basis, startDate, endDate, scope.buildingIds],
    enabled: queryEnabled(userId, filters, enabled),
    staleTime: HISTORICAL_STALE_TIME,
    queryFn: async () => {
      const { data, error } = await supabase.rpc(
        "business_performance_category_breakdown_v1",
        {
          p_organization_id: scope.organizationId,
          p_basis: basis,
          p_start_date: startDate,
          p_end_date: endDate,
          p_building_ids: scope.buildingIds,
        },
      );
      if (error) throw error;
      return rows(data, "category_breakdown").map(parseCategoryRow);
    },
  });
}

export function useSetBusinessPerformanceReportingRole(
  filters: BusinessPerformanceFilters,
): UseMutationResult<
  SetBusinessPerformanceReportingRoleResult,
  Error,
  SetBusinessPerformanceReportingRoleInput
> {
  const { data: user } = useAuth();
  const queryClient = useQueryClient();
  const userId = user?.id ?? null;
  const scope = normalizedScope(filters);
  return useMutation({
    mutationFn: async (input) => {
      const typeId = parseBusinessPerformanceUuid(
        input.incomeExpenseTypeId,
        "incomeExpenseTypeId",
      );
      const role = enumValue(input.role, "role", REPORTING_ROLES);
      const effectiveFrom = date(input.effectiveFrom, "effectiveFrom");
      const { data, error } = await supabase.rpc(
        "business_performance_set_reporting_role_v1",
        {
          p_organization_id: scope.organizationId,
          p_income_expense_type_id: typeId,
          p_finance_reporting_role: role,
          p_effective_from: effectiveFrom,
        },
      );
      if (error) throw error;
      const resultRows = rows(data, "set_reporting_role");
      if (resultRows.length !== 1) {
        throw new BusinessPerformanceDataError(
          "set_reporting_role",
          "Expected exactly one reporting-role assignment",
        );
      }
      const row = record(resultRows[0], "set_reporting_role");
      return {
        assignment_id: parseBusinessPerformanceUuid(row.assignment_id, "assignment_id"),
        finance_reporting_role: enumValue(
          row.finance_reporting_role,
          "finance_reporting_role",
          REPORTING_ROLES,
        ),
        effective_from: date(row.effective_from, "effective_from"),
        effective_to: nullableDate(row.effective_to, "effective_to"),
        confirmed_at: timestamp(row.confirmed_at, "confirmed_at"),
        confirmed_by: parseBusinessPerformanceUuid(row.confirmed_by, "confirmed_by"),
      };
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: [QUERY_ROOT, userId] });
    },
  });
}
