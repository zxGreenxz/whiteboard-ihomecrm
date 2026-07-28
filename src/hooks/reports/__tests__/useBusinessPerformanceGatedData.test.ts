import { beforeEach, describe, expect, it, vi } from "vitest";

import { buildBusinessPerformanceFilters } from "@/lib/businessPerformance";

const mocks = vi.hoisted(() => ({
  rpc: vi.fn(),
  useQuery: vi.fn((options: unknown) => options),
  useMutation: vi.fn((options: unknown) => options),
  invalidateQueries: vi.fn(),
}));

vi.mock("@tanstack/react-query", () => ({
  useQuery: mocks.useQuery,
  useMutation: mocks.useMutation,
  useQueryClient: () => ({ invalidateQueries: mocks.invalidateQueries }),
}));

vi.mock("@/integrations/supabase/client", () => ({
  supabase: { rpc: mocks.rpc },
}));

vi.mock("@/hooks/useAuth", () => ({
  useAuth: () => ({ data: { id: "user-a" } }),
}));

import {
  useBusinessPerformanceBreakEven,
  useBusinessPerformanceCashReceived,
  useBusinessPerformanceCategoryBreakdown,
  useBusinessPerformanceInventoryHistory,
  useBusinessPerformanceInvoiceCohort,
  useBusinessPerformanceReportingRoles,
  useSetBusinessPerformanceReportingRole,
} from "../useBusinessPerformance";

const ORGANIZATION_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const BUILDING_ID = "11111111-1111-4111-8111-111111111111";
const TYPE_ID = "22222222-2222-4222-8222-222222222222";
const USER_ID = "33333333-3333-4333-8333-333333333333";
const filters = buildBusinessPerformanceFilters(
  "2026-07",
  [BUILDING_ID],
  "ACCRUAL",
  ORGANIZATION_ID,
);

type QueryOptions<T> = {
  enabled: boolean;
  queryKey: readonly unknown[];
  queryFn: () => Promise<T>;
};

type MutationOptions<TInput, TOutput> = {
  mutationFn: (input: TInput) => Promise<TOutput>;
  onSuccess?: () => Promise<void> | void;
};

beforeEach(() => {
  mocks.rpc.mockReset();
  mocks.useQuery.mockClear();
  mocks.useMutation.mockClear();
  mocks.invalidateQueries.mockReset();
});

describe("business-performance gated-data hooks", () => {
  it("loads effective reporting roles with a typed read-only/manage contract", async () => {
    mocks.rpc.mockResolvedValue({
      data: [
        {
          income_expense_type_id: TYPE_ID,
          type_name: "Tiền nhà",
          side: "EXPENSE",
          category: "Chi phí cố định",
          finance_reporting_role: "LANDLORD_RENT_FIXED",
          effective_from: "2026-01-01",
          effective_to: null,
          confirmed_at: "2026-01-01T00:00:00.000Z",
          confirmed_by: USER_ID,
          suggested_role: "LANDLORD_RENT_FIXED",
          can_manage: true,
        },
      ],
      error: null,
    });
    const query = useBusinessPerformanceReportingRoles(
      filters,
    ) as unknown as QueryOptions<Array<{ can_manage: boolean }>>;

    expect(query.enabled).toBe(true);
    expect(await query.queryFn()).toEqual([
      expect.objectContaining({
        income_expense_type_id: TYPE_ID,
        finance_reporting_role: "LANDLORD_RENT_FIXED",
        can_manage: true,
      }),
    ]);
    expect(mocks.rpc).toHaveBeenCalledWith(
      "business_performance_reporting_roles_v1",
      {
        p_organization_id: ORGANIZATION_ID,
        p_month: "2026-07-01",
        p_building_ids: [BUILDING_ID],
      },
    );
  });

  it("preserves missing historical snapshots as null metrics", async () => {
    mocks.rpc.mockResolvedValue({
      data: [
        {
          snapshot_month: "2026-06-01",
          building_id: BUILDING_ID,
          building_name: "Tòa A",
          snapshot_status: "MISSING",
          snapshot_missing: true,
          availability_reason: "NO_SNAPSHOT",
          total: null,
          occupied: null,
          reserved: null,
          maintenance: null,
          unavailable: null,
          available: null,
          occupancy_pct: null,
          committed_pct: null,
          listed_rent_opportunity: null,
          capacity_current: null,
          capacity_blocked: null,
          capacity_theory: null,
          invalid_rent_room_count: null,
          as_of_date: null,
          as_of_timestamp: null,
          captured_at: null,
          is_late: null,
          capture_version: null,
        },
      ],
      error: null,
    });
    const query = useBusinessPerformanceInventoryHistory(
      filters,
      "2026-06-01",
      "2026-06-01",
    ) as unknown as QueryOptions<Array<{ total: number | null }>>;

    const rows = await query.queryFn();
    expect(rows[0].total).toBeNull();
    expect(mocks.rpc).toHaveBeenCalledWith(
      "business_performance_inventory_history_v1",
      expect.objectContaining({
        p_start_month: "2026-06-01",
        p_end_month: "2026-06-01",
        p_organization_id: ORGANIZATION_ID,
        p_building_ids: [BUILDING_ID],
      }),
    );
  });

  it("parses break-even numeric strings without inventing unavailable values", async () => {
    mocks.rpc.mockResolvedValue({
      data: [
        {
          building_id: BUILDING_ID,
          building_name: "Tòa A",
          analysis_window: "SELECTED_MONTH",
          window_start: "2026-07-01",
          window_end: "2026-07-01",
          source_month_count: 1,
          valid_month_count: 0,
          revenue: "10000000",
          expense: "8000000",
          net: "2000000",
          gap_to_zero: "-2000000",
          r_room: "10000000",
          r_other: "0",
          r_pass: "0",
          f_landlord: "0",
          f_other: "0",
          v_room: "0",
          v_other: "0",
          e_pass: "0",
          mapping_coverage_pct: "75",
          unmapped_amount: "2000000",
          outside_model_amount: "0",
          missing_landlord_months: ["2026-07-01"],
          cmr_core: null,
          cmr_room: null,
          r_core_be: null,
          r_total_be: null,
          r_room_be: null,
          break_even_revenue_available: false,
          break_even_revenue_reason: "UNMAPPED_AMOUNT",
          room_break_even_revenue_available: false,
          room_break_even_revenue_reason: "UNMAPPED_AMOUNT",
          capacity_current: "30000000",
          capacity_blocked: "0",
          capacity_theory: "30000000",
          invalid_rent_room_count: 0,
          break_even_occupancy_current: null,
          break_even_occupancy_theory: null,
          room_revenue_utilization_pct: "33.33",
          break_even_occupancy_available: false,
          break_even_occupancy_reason: "ROOM_BREAK_EVEN_UNAVAILABLE",
          capacity_source: "LIVE",
          capacity_as_of: "2026-07-28T00:00:00.000Z",
          generated_at: "2026-07-28T00:00:00.000Z",
        },
      ],
      error: null,
    });
    const query = useBusinessPerformanceBreakEven(
      filters,
    ) as unknown as QueryOptions<Array<{ revenue: number; r_core_be: number | null }>>;

    const rows = await query.queryFn();
    expect(rows[0]).toMatchObject({ revenue: 10_000_000, r_core_be: null });
  });

  it("keeps incomplete invoice cohort amounts unavailable while cash remains factual", async () => {
    mocks.rpc
      .mockResolvedValueOnce({
        data: [
          {
            building_id: BUILDING_ID,
            building_name: "Tòa A",
            cohort_month: "2026-07-01",
            cohort_available: false,
            billed_current_charge: null,
            collected_current_charge: null,
            remaining_current_charge: null,
            collection_rate_pct: null,
            invoice_count: 2,
            allocation_unknown_count: 1,
            allocation_unknown_amount: "3000000",
            component_anomaly_count: 0,
            carried_invoice_debt: "1000000",
            carried_deposit_debt: "0",
            current_deposit: "500000",
            draft_pending_count: 1,
            draft_pending_amount: "2000000",
            settlement_count: 0,
            settlement_amount: "0",
            generated_at: "2026-07-28T00:00:00.000Z",
          },
        ],
        error: null,
      })
      .mockResolvedValueOnce({
        data: [
          {
            building_id: BUILDING_ID,
            building_name: "Tòa A",
            cash_month: "2026-07-01",
            cash_received: "4500000",
            payment_event_count: 2,
            first_payment_date: "2026-07-02",
            last_payment_date: "2026-07-20",
            generated_at: "2026-07-28T00:00:00.000Z",
          },
        ],
        error: null,
      });

    const cohort = useBusinessPerformanceInvoiceCohort(
      filters,
    ) as unknown as QueryOptions<Array<{ billed_current_charge: number | null }>>;
    const cash = useBusinessPerformanceCashReceived(
      filters,
    ) as unknown as QueryOptions<Array<{ cash_received: number }>>;

    expect((await cohort.queryFn())[0].billed_current_charge).toBeNull();
    expect((await cash.queryFn())[0].cash_received).toBe(4_500_000);
  });

  it("loads category breakdown for the selected basis and period", async () => {
    mocks.rpc.mockResolvedValue({
      data: [
        {
          month: "2026-07-01",
          side: "INCOME",
          type_id: TYPE_ID,
          type_name: "Tiền phòng",
          category: "Doanh thu",
          total_amount: "12000000",
          voucher_count: 3,
        },
      ],
      error: null,
    });
    const query = useBusinessPerformanceCategoryBreakdown(
      filters,
    ) as unknown as QueryOptions<Array<{ total_amount: number }>>;

    expect((await query.queryFn())[0].total_amount).toBe(12_000_000);
    expect(mocks.rpc).toHaveBeenCalledWith(
      "business_performance_category_breakdown_v1",
      {
        p_organization_id: ORGANIZATION_ID,
        p_basis: "ACCRUAL",
        p_start_date: "2026-07-01",
        p_end_date: "2026-07-31",
        p_building_ids: [BUILDING_ID],
      },
    );
  });

  it("updates a confirmed role and invalidates all report data for the organization", async () => {
    mocks.rpc.mockResolvedValue({
      data: [
        {
          assignment_id: "44444444-4444-4444-8444-444444444444",
          finance_reporting_role: "LANDLORD_RENT_FIXED",
          effective_from: "2026-07-01",
          effective_to: null,
          confirmed_at: "2026-07-28T00:00:00.000Z",
          confirmed_by: USER_ID,
        },
      ],
      error: null,
    });
    const mutation = useSetBusinessPerformanceReportingRole(
      filters,
    ) as unknown as MutationOptions<
      { incomeExpenseTypeId: string; role: string; effectiveFrom: string },
      unknown
    >;

    await mutation.mutationFn({
      incomeExpenseTypeId: TYPE_ID,
      role: "LANDLORD_RENT_FIXED",
      effectiveFrom: "2026-07-01",
    });
    await mutation.onSuccess?.();

    expect(mocks.rpc).toHaveBeenCalledWith(
      "business_performance_set_reporting_role_v1",
      {
        p_organization_id: ORGANIZATION_ID,
        p_income_expense_type_id: TYPE_ID,
        p_finance_reporting_role: "LANDLORD_RENT_FIXED",
        p_effective_from: "2026-07-01",
      },
    );
    expect(mocks.invalidateQueries).toHaveBeenCalledWith({
      queryKey: ["business-performance", "user-a"],
    });
  });

  it("rejects an out-of-scope building row instead of rendering it", async () => {
    mocks.rpc.mockResolvedValue({
      data: [
        {
          building_id: "99999999-9999-4999-8999-999999999999",
          building_name: "Cross tenant",
          cash_month: "2026-07-01",
          cash_received: 1,
          payment_event_count: 1,
          first_payment_date: "2026-07-01",
          last_payment_date: "2026-07-01",
          generated_at: "2026-07-28T00:00:00.000Z",
        },
      ],
      error: null,
    });
    const query = useBusinessPerformanceCashReceived(
      filters,
    ) as unknown as QueryOptions<unknown[]>;

    await expect(query.queryFn()).rejects.toMatchObject({ field: "building_id" });
  });
});
