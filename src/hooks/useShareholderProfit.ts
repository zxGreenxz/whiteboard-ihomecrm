import { useMemo } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import { useBuildings } from "@/hooks/useBuildings";
import {
  computeShareholderSummary,
  type ShareholderSummaryRow,
} from "@/lib/shareholderProfit";
import {
  normalizeUnallocatedDisposition,
  type ProfitCloseAdjustmentPayload,
  type ProfitUnallocatedDisposition,
} from "@/lib/profitClose";
import { fetchAllRows } from "@/lib/supabaseFetchAll";
import { jsonArray } from "@/lib/jsonValue";

export { computeShareholderSummary };
export type { ShareholderSummaryRow };

// --- Types ---
export interface MonthlyBuildingProfit {
  building_id: string;
  building_name: string;
  total_income: number;
  total_expense: number;
  net_profit: number;
}

export interface ProfitMonthly {
  id: string;
  user_id: string;
  building_id: string;
  period_month: string; // YYYY-MM-01
  computed_profit: number;
  adjusted_profit: number;
  management_salary: number; // lương điều hành đã trừ (snapshot); distributable = adjusted - này
  shareholder_percent_total?: number;
  shareholder_allocated_amount?: number;
  unallocated_profit?: number;
  unallocated_disposition?: ProfitUnallocatedDisposition | null;
  unallocated_disposition_reason?: string | null;
  status: "DRAFT" | "LOCKED";
  note: string | null;
  locked_at: string | null;
  locked_by: string | null;
}

export interface ProfitCloseSnapshot {
  id: string;
  status: "DRAFT" | "LOCKED";
  computed_profit: number;
  adjustment_amount: number;
  adjustment_reason: string | null;
  adjusted_profit: number;
  management_salary: number;
  distributable_profit: number;
  shareholder_percent_total: number;
  shareholder_allocated_amount: number;
  unallocated_profit: number;
  unallocated_disposition: ProfitUnallocatedDisposition | null;
  unallocated_disposition_reason: string | null;
  source_hash: string | null;
  locked_at: string | null;
}

export interface ProfitClosePreviewRow {
  building_id: string;
  building_name: string;
  revenue: number;
  expense: number;
  computed_profit: number;
  adjustment_amount: number;
  management_salary: number;
  distributable_profit: number;
  shareholder_percent_total: number;
  shareholder_allocated_amount: number;
  unallocated_profit: number;
  unallocated_disposition: ProfitUnallocatedDisposition | null;
  unallocated_disposition_reason: string | null;
  source_hash: string;
  is_stale: boolean;
  stale_reason: string | null;
  delta_profit: number;
  shareholder_allocations: Array<{
    shareholder_id: string;
    shareholder_name: string;
    percent: number;
    amount: number;
  }>;
  manager_allocations: Array<{
    manager_id: string;
    manager_name: string;
    amount: number;
  }>;
  current_snapshot: ProfitCloseSnapshot | null;
}

export interface ProfitClosePreview {
  organization_id: string;
  period_month: string;
  source_hash: string;
  is_locked: boolean;
  is_stale: boolean;
  rows: ProfitClosePreviewRow[];
}

// Snapshot phần lương điều hành của 1 quản lý tại 1 nhà/tháng.
export interface ProfitManagerAllocation {
  id: string;
  user_id: string;
  profit_monthly_id: string;
  manager_id: string;
  amount: number;
  // embedded
  period_month?: string;
  building_id?: string;
}

// Phiếu chi trả lương điều hành (đã trả) gắn quản lý.
export interface ManagerSalaryPayout {
  id: string;
  manager_id: string;
  total_amount: number;
  voucher_date: string;
  name: string;
  account_id: string | null;
  building_id: string;
}

export interface ProfitAllocation {
  id: string;
  user_id: string;
  profit_monthly_id: string;
  shareholder_id: string;
  percent: number;
  amount: number;
  // embedded
  period_month?: string;
  building_id?: string;
}

export interface ShareholderDistribution {
  id: string;
  shareholder_id: string;
  total_amount: number;
  voucher_date: string;
  name: string;
  account_id: string | null;
  building_id: string;
}

// --- Queries ---

// Gom các dòng accrual (tháng × toà) của fa_monthly_pnl_accrual về 1 dòng/toà,
// BỎ toà ảo ("Chung" chứa phiếu chia LN). Tách riêng để dùng lại ở resync.
function aggregateAccrualByBuilding(rows: any[]): MonthlyBuildingProfit[] {
  const map = new Map<string, MonthlyBuildingProfit>();
  for (const r of rows || []) {
    if (r.is_virtual) continue;
    const cur =
      map.get(r.building_id) ?? {
        building_id: r.building_id,
        building_name: r.building_name,
        total_income: 0,
        total_expense: 0,
        net_profit: 0,
      };
    cur.total_income += Number(r.revenue) || 0;
    cur.total_expense += Number(r.expense) || 0;
    cur.net_profit += Number(r.net) || 0;
    map.set(r.building_id, cur);
  }
  return [...map.values()];
}

// LN theo nhà cho 1 khoảng — DỒN TÍCH (accrual), KHỚP báo cáo Phân bổ lợi nhuận.
// Trước đây dùng RPC monthly_building_profit (cash-basis theo voucher_date + chỉ
// phiếu owner) nên lệch số. Nay gọi fa_monthly_pnl_accrual: doanh thu HĐ theo
// billing_month, item có kỳ chia đều ra từng tháng, gồm cả phiếu nhân viên.
// Pad đủ MỌI toà thật (toà không phát sinh = 0đ) để giữ nguyên danh sách như cũ.
export const useMonthlyBuildingProfit = (
  start?: string,
  end?: string,
  buildingId?: string
) => {
  const { data: buildings = [] } = useBuildings(); // toà thật (đã ẩn toà ảo)
  const query = useQuery({
    queryKey: ["monthly-building-profit", start, end, buildingId ?? null],
    enabled: !!start && !!end,
    queryFn: async (): Promise<MonthlyBuildingProfit[]> => {
      const { data, error } = await supabase.rpc("fa_monthly_pnl_accrual", {
        p_start_date: start,
        p_end_date: end,
        p_building_ids: buildingId ? [buildingId] : undefined,
      });
      if (error) {
        toast.error("Không thể tính lợi nhuận theo nhà");
        throw error;
      }
      return aggregateAccrualByBuilding(data as any[]);
    },
  });

  // Ghép full toà thật: giữ thứ tự theo tên, toà chưa có số → 0/0/0.
  const data = useMemo<MonthlyBuildingProfit[]>(() => {
    if (query.isLoading) return [];
    const byId = new Map((query.data ?? []).map((r) => [r.building_id, r]));
    const list = (buildings as any[]).filter((b) => !buildingId || b.id === buildingId);
    const padded: MonthlyBuildingProfit[] = list.map(
      (b) =>
        byId.get(b.id) ?? {
          building_id: b.id,
          building_name: b.name,
          total_income: 0,
          total_expense: 0,
          net_profit: 0,
        }
    );
    // Phòng hờ: toà có số accrual nhưng không nằm trong danh sách toà (lệch RLS).
    const known = new Set(list.map((b) => b.id));
    for (const r of query.data ?? []) if (!known.has(r.building_id)) padded.push(r);
    return padded.sort((a, b) =>
      (a.building_name || "").localeCompare(b.building_name || "", "vi")
    );
  }, [query.isLoading, query.data, buildings, buildingId]);

  return { ...query, data };
};

// Tất cả phiếu chốt LN (owner thấy all; cổ đông thấy tháng có phần mình qua RLS).
export const useProfitMonthly = () => {
  return useQuery({
    queryKey: ["profit-monthly"],
    queryFn: async () => {
      const data = await fetchAllRows<any>(
        (from, to) =>
          (supabase.from("profit_monthly").select("*") as any)
            .order("period_month", { ascending: false })
            .order("id", { ascending: true })
            .range(from, to),
        { label: "profit.monthlyHistory" },
      );
      if (data === null) {
        toast.error("Không thể tải dữ liệu chốt lợi nhuận");
        throw new Error("Lỗi tải toàn bộ lịch sử chốt lợi nhuận");
      }
      return ((data || []) as any[]).map((r) => ({
        ...r,
        computed_profit: Number(r.computed_profit) || 0,
        adjusted_profit: Number(r.adjusted_profit) || 0,
        management_salary: Number(r.management_salary) || 0,
        shareholder_percent_total: money(r.shareholder_percent_total),
        shareholder_allocated_amount: money(r.shareholder_allocated_amount),
        unallocated_profit: money(r.unallocated_profit),
        unallocated_disposition: normalizeUnallocatedDisposition(
          r.unallocated_disposition,
        ),
        unallocated_disposition_reason:
          r.unallocated_disposition_reason ?? null,
      })) as ProfitMonthly[];
    },
  });
};

// Tất cả phân bổ (kèm period_month + building_id từ profit_monthly).
export const useProfitAllocations = () => {
  return useQuery({
    queryKey: ["profit-allocations"],
    queryFn: async () => {
      const data = await fetchAllRows<any>(
        (from, to) =>
          (supabase
            .from("profit_allocations")
            .select("*, pm:profit_monthly_id(period_month, building_id, status)") as any)
            .order("id", { ascending: true })
            .range(from, to),
        { label: "profit.shareholderAllocations" },
      );
      if (data === null) {
        toast.error("Không thể tải phân bổ lợi nhuận");
        throw new Error("Lỗi tải toàn bộ phân bổ lợi nhuận");
      }
      return ((data || []) as any[]).map((r) => ({
        id: r.id,
        user_id: r.user_id,
        profit_monthly_id: r.profit_monthly_id,
        shareholder_id: r.shareholder_id,
        percent: Number(r.percent) || 0,
        amount: Number(r.amount) || 0,
        period_month: r.pm?.period_month,
        building_id: r.pm?.building_id,
      })) as ProfitAllocation[];
    },
  });
};

// Các phiếu chi chia LN (đã ứng) gắn cổ đông.
export const useShareholderDistributions = () => {
  return useQuery({
    queryKey: ["shareholder-distributions"],
    queryFn: async () => {
      const data = await fetchAllRows<any>(
        (from, to) =>
          (supabase
            .from("income_expenses")
            .select("id, shareholder_id, total_amount, voucher_date, name, account_id, building_id") as any)
            .eq("type", "EXPENSE")
            .eq("approval_status", "APPROVED")
            .not("shareholder_id", "is", null)
            .is("deleted_at", null)
            .order("voucher_date", { ascending: false })
            .order("id", { ascending: true })
            .range(from, to),
        { label: "profit.shareholderDistributions" },
      );
      if (data === null) {
        toast.error("Không thể tải lịch sử chia lợi nhuận");
        throw new Error("Lỗi tải toàn bộ lịch sử chia lợi nhuận");
      }
      return ((data || []) as any[]).map((r) => ({
        id: r.id,
        shareholder_id: r.shareholder_id,
        total_amount: Number(r.total_amount) || 0,
        voucher_date: r.voucher_date,
        name: r.name,
        account_id: r.account_id,
        building_id: r.building_id,
      })) as ShareholderDistribution[];
    },
  });
};

// Snapshot lương điều hành (kèm period_month + building_id từ profit_monthly).
export const useProfitManagerAllocations = () => {
  return useQuery({
    queryKey: ["profit-manager-allocations"],
    queryFn: async () => {
      const data = await fetchAllRows<any>(
        (from, to) =>
          (supabase
            .from("profit_manager_allocations")
            .select("*, pm:profit_monthly_id(period_month, building_id, status)") as any)
            .order("id", { ascending: true })
            .range(from, to),
        { label: "profit.managerAllocations" },
      );
      if (data === null) {
        toast.error("Không thể tải phân bổ lương điều hành");
        throw new Error("Lỗi tải toàn bộ phân bổ lương điều hành");
      }
      return ((data || []) as any[]).map((r) => ({
        id: r.id,
        user_id: r.user_id,
        profit_monthly_id: r.profit_monthly_id,
        manager_id: r.manager_id,
        amount: Number(r.amount) || 0,
        period_month: r.pm?.period_month,
        building_id: r.pm?.building_id,
      })) as ProfitManagerAllocation[];
    },
  });
};

// Các phiếu chi trả lương điều hành (đã trả) gắn quản lý.
export const useManagerSalaryPayouts = () => {
  return useQuery({
    queryKey: ["manager-salary-payouts"],
    queryFn: async () => {
      const data = await fetchAllRows<any>(
        (from, to) =>
          (supabase
            .from("income_expenses")
            .select("id, profit_manager_id, total_amount, voucher_date, name, account_id, building_id") as any)
            .eq("type", "EXPENSE")
            .eq("approval_status", "APPROVED")
            .not("profit_manager_id", "is", null)
            .is("deleted_at", null)
            .order("voucher_date", { ascending: false })
            .order("id", { ascending: true })
            .range(from, to),
        { label: "profit.managerSalaryPayouts" },
      );
      if (data === null) {
        toast.error("Không thể tải lịch sử trả lương điều hành");
        throw new Error("Lỗi tải toàn bộ lịch sử trả lương điều hành");
      }
      return ((data || []) as any[]).map((r) => ({
        id: r.id,
        manager_id: r.profit_manager_id,
        total_amount: Number(r.total_amount) || 0,
        voucher_date: r.voucher_date,
        name: r.name,
        account_id: r.account_id,
        building_id: r.building_id,
      })) as ManagerSalaryPayout[];
    },
  });
};

// --- Canonical V2 close workflow. All calculations and writes stay server-side. ---

export const PROFIT_CLOSE_RPC = {
  scopes: "profit_close_scopes_v2",
  state: "profit_close_state_v2",
  preview: "profit_close_preview_v2",
  close: "profit_close_v2",
  reclose: "profit_reclose_v2",
  reset: "profit_reset_checked_v2",
} as const;

export interface ProfitCloseOrganizationScope {
  organization_id: string;
  organization_name: string;
  organization_slug: string;
  can_lock: boolean;
  can_unlock: boolean;
}

export interface ProfitCloseStateRow {
  id: string;
  building_id: string;
  building_name: string;
  is_virtual: boolean;
  building_deleted: boolean;
  status: "DRAFT" | "LOCKED";
  computed_profit: number;
  adjusted_profit: number;
  adjustment_amount: number;
  adjustment_reason: string | null;
  management_salary: number;
  distributable_profit: number;
  shareholder_percent_total: number;
  shareholder_allocated_amount: number;
  unallocated_profit: number;
  unallocated_disposition: ProfitUnallocatedDisposition | null;
  unallocated_disposition_reason: string | null;
  source_revenue: number;
  source_expense: number;
  source_hash: string;
  is_stale: boolean;
  stale_reason: string | null;
  revision_number: number;
  locked_at: string | null;
}

export interface ProfitCloseState {
  organization_id: string;
  period_month: string;
  can_lock: boolean;
  can_unlock: boolean;
  state_hash: string;
  snapshot_ids: string[];
  snapshot_count: number;
  locked_count: number;
  draft_count: number;
  real_building_count: number;
  active_real_snapshot_count: number;
  has_out_of_scope_snapshots: boolean;
  rows: ProfitCloseStateRow[];
}

function money(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

export const useProfitCloseOrganizations = () => {
  return useQuery({
    queryKey: ["profit-close-scopes"],
    queryFn: async (): Promise<ProfitCloseOrganizationScope[]> => {
      const { data, error } = await supabase.rpc(PROFIT_CLOSE_RPC.scopes);
      if (error) throw error;
      const rows = jsonArray(data, "organizations");
      return rows.map((row: any) => ({
        organization_id: String(row.organization_id),
        organization_name: String(row.organization_name ?? ""),
        organization_slug: String(row.organization_slug ?? ""),
        can_lock: Boolean(row.can_lock),
        can_unlock: Boolean(row.can_unlock),
      }));
    },
    staleTime: 5 * 60 * 1000,
  });
};

function normalizeProfitCloseState(value: any): ProfitCloseState {
  const root = value && typeof value === "object" ? value : {};
  const rows = Array.isArray(root.rows) ? root.rows : [];
  return {
    organization_id: String(root.organization_id ?? ""),
    period_month: String(root.period_month ?? ""),
    can_lock: Boolean(root.can_lock),
    can_unlock: Boolean(root.can_unlock),
    state_hash: String(root.state_hash ?? ""),
    snapshot_ids: Array.isArray(root.snapshot_ids)
      ? root.snapshot_ids.map((id: unknown) => String(id)).sort()
      : [],
    snapshot_count: money(root.snapshot_count),
    locked_count: money(root.locked_count),
    draft_count: money(root.draft_count),
    real_building_count: money(root.real_building_count),
    active_real_snapshot_count: money(root.active_real_snapshot_count),
    has_out_of_scope_snapshots: Boolean(root.has_out_of_scope_snapshots),
    rows: rows.map((row: any) => ({
      id: String(row.id),
      building_id: String(row.building_id),
      building_name: String(row.building_name ?? ""),
      is_virtual: Boolean(row.is_virtual),
      building_deleted: Boolean(row.building_deleted),
      status: row.status === "LOCKED" ? "LOCKED" : "DRAFT",
      computed_profit: money(row.computed_profit),
      adjusted_profit: money(row.adjusted_profit),
      adjustment_amount: money(row.adjustment_amount),
      adjustment_reason: row.adjustment_reason ?? null,
      management_salary: money(row.management_salary),
      distributable_profit: money(row.distributable_profit),
      shareholder_percent_total: money(row.shareholder_percent_total),
      shareholder_allocated_amount: money(row.shareholder_allocated_amount),
      unallocated_profit: money(row.unallocated_profit),
      unallocated_disposition: normalizeUnallocatedDisposition(
        row.unallocated_disposition,
      ),
      unallocated_disposition_reason:
        row.unallocated_disposition_reason ?? null,
      source_revenue: money(row.source_revenue),
      source_expense: money(row.source_expense),
      source_hash: String(row.source_hash ?? ""),
      is_stale: Boolean(row.is_stale),
      stale_reason: row.stale_reason ?? null,
      revision_number: money(row.revision_number),
      locked_at: row.locked_at ?? null,
    })),
  };
}

export const useProfitCloseState = (
  organizationId?: string,
  periodMonth?: string,
) => {
  return useQuery({
    queryKey: ["profit-close-state", organizationId, periodMonth],
    enabled: !!organizationId && !!periodMonth,
    queryFn: async (): Promise<ProfitCloseState> => {
      const { data, error } = await supabase.rpc(PROFIT_CLOSE_RPC.state, {
        p_organization_id: organizationId,
        p_period_month: periodMonth,
      });
      if (error) throw error;
      return normalizeProfitCloseState(data);
    },
  });
};

function normalizeSnapshot(value: any): ProfitCloseSnapshot | null {
  if (!value) return null;
  const computed = money(value.computed_profit);
  const adjustment = money(value.adjustment_amount);
  const adjusted = money(value.adjusted_profit ?? computed + adjustment);
  const salary = money(value.management_salary);
  return {
    id: String(value.id ?? ""),
    status: value.status === "LOCKED" ? "LOCKED" : "DRAFT",
    computed_profit: computed,
    adjustment_amount: adjustment,
    adjustment_reason: value.adjustment_reason ?? null,
    adjusted_profit: adjusted,
    management_salary: salary,
    distributable_profit: money(value.distributable_profit ?? adjusted - salary),
    shareholder_percent_total: money(value.shareholder_percent_total),
    shareholder_allocated_amount: money(value.shareholder_allocated_amount),
    unallocated_profit: money(value.unallocated_profit),
    unallocated_disposition: normalizeUnallocatedDisposition(
      value.unallocated_disposition,
    ),
    unallocated_disposition_reason:
      value.unallocated_disposition_reason ?? null,
    source_hash: value.source_hash ?? null,
    locked_at: value.locked_at ?? null,
  };
}

function normalizeProfitClosePreview(
  value: any,
  fallbackOrganizationId: string,
  fallbackPeriod: string,
): ProfitClosePreview {
  const root = value && typeof value === "object" ? value : {};
  const rows = Array.isArray(root.buildings)
    ? root.buildings
    : Array.isArray(root.rows)
      ? root.rows
      : Array.isArray(value)
        ? value
        : [];
  const rootSourceHash = String(root.source_hash ?? "");
  const normalizedRows = rows.map((row: any): ProfitClosePreviewRow => {
    const snapshot = normalizeSnapshot(row.current_snapshot ?? row.snapshot);
    if (snapshot && row.current_status) {
      snapshot.status = row.current_status === "LOCKED" ? "LOCKED" : "DRAFT";
    }
    const computed = money(row.computed_profit ?? row.net_profit);
    const adjustment = money(row.adjustment_amount);
    const salary = money(row.management_salary);
    const distributable = money(
      row.distributable_profit ?? computed + adjustment - salary,
    );
    const rowSourceHash = String(
      row.building_source_hash ?? row.source_hash ?? rootSourceHash,
    );
    const explicitStale =
      typeof row.current_is_stale === "boolean"
        ? row.current_is_stale
        : typeof row.is_stale === "boolean"
          ? row.is_stale
          : null;
    const stale = Boolean(
      snapshot &&
        (explicitStale ??
          (snapshot.source_hash && rowSourceHash
            ? snapshot.source_hash !== rowSourceHash
            : false)),
    );
    const shareholderAllocations = Array.isArray(row.shareholder_allocations)
      ? row.shareholder_allocations.map((allocation: any) => ({
          shareholder_id: String(allocation.shareholder_id),
          shareholder_name: String(allocation.shareholder_name ?? ""),
          percent: money(allocation.percent),
          amount: money(allocation.amount),
        }))
      : [];
    const shareholderPercentTotal = money(
      row.shareholder_percent_total ??
        shareholderAllocations.reduce(
          (sum: number, allocation: { percent: number }) => sum + allocation.percent,
          0,
        ),
    );
    const shareholderAllocatedAmount = money(
      row.shareholder_allocated_amount ??
        shareholderAllocations.reduce(
          (sum: number, allocation: { amount: number }) => sum + allocation.amount,
          0,
        ),
    );
    const unallocatedProfit = money(
      row.unallocated_profit ?? distributable - shareholderAllocatedAmount,
    );
    return {
      building_id: String(row.building_id),
      building_name: String(row.building_name ?? ""),
      revenue: money(row.source_revenue ?? row.revenue ?? row.total_income),
      expense: money(row.source_expense ?? row.expense ?? row.total_expense),
      computed_profit: computed,
      adjustment_amount: adjustment,
      management_salary: salary,
      distributable_profit: distributable,
      shareholder_percent_total: shareholderPercentTotal,
      shareholder_allocated_amount: shareholderAllocatedAmount,
      unallocated_profit: unallocatedProfit,
      unallocated_disposition: normalizeUnallocatedDisposition(
        row.unallocated_disposition ?? snapshot?.unallocated_disposition,
      ),
      unallocated_disposition_reason:
        row.unallocated_disposition_reason ??
        snapshot?.unallocated_disposition_reason ??
        null,
      source_hash: rowSourceHash,
      is_stale: stale,
      stale_reason: row.current_stale_reason ?? row.stale_reason ?? null,
      delta_profit: money(row.delta_profit ?? (snapshot ? computed - snapshot.computed_profit : 0)),
      shareholder_allocations: shareholderAllocations,
      manager_allocations: Array.isArray(row.manager_allocations)
        ? row.manager_allocations.map((allocation: any) => ({
            manager_id: String(allocation.manager_id),
            manager_name: String(allocation.manager_name ?? ""),
            amount: money(allocation.amount),
          }))
        : [],
      current_snapshot: snapshot,
    };
  });

  return {
    organization_id: String(root.organization_id ?? fallbackOrganizationId),
    period_month: String(root.period_month ?? fallbackPeriod),
    source_hash: rootSourceHash,
    is_locked: Boolean(
      root.is_locked ?? normalizedRows.some((row) => row.current_snapshot?.status === "LOCKED"),
    ),
    is_stale: Boolean(root.is_stale ?? normalizedRows.some((row) => row.is_stale)),
    rows: normalizedRows,
  };
}

export const useProfitClosePreview = (
  organizationId?: string,
  periodMonth?: string,
  adjustments: ProfitCloseAdjustmentPayload[] = [],
  buildingIds: string[] | null = null,
  enabled = true,
) => {
  const previewAdjustments = adjustments;
  const query = useQuery({
    queryKey: [
      "profit-close-preview",
      organizationId,
      periodMonth,
      buildingIds,
      previewAdjustments,
    ],
    enabled:
      enabled &&
      !!organizationId &&
      !!periodMonth &&
      (buildingIds === null || buildingIds.length > 0),
    queryFn: async (): Promise<ProfitClosePreview> => {
      const { data, error } = await supabase.rpc(PROFIT_CLOSE_RPC.preview, {
        p_organization_id: organizationId,
        p_period_month: periodMonth,
        p_building_ids: buildingIds,
        p_adjustments: previewAdjustments,
      });
      if (error) throw error;
      return normalizeProfitClosePreview(data, organizationId, periodMonth!);
    },
  });

  return {
    ...query,
    organizationId,
  };
};

export interface CloseProfitPeriodInput {
  organizationId: string;
  periodMonth: string;
  buildingIds: string[];
  adjustments: ProfitCloseAdjustmentPayload[];
  expectedSourceHash: string;
  reason: string;
  reclose: boolean;
}

function invalidateProfitCloseQueries(qc: ReturnType<typeof useQueryClient>) {
  qc.invalidateQueries({ queryKey: ["profit-close-preview"] });
  qc.invalidateQueries({ queryKey: ["profit-close-state"] });
  qc.invalidateQueries({ queryKey: ["monthly-building-profit"] });
  qc.invalidateQueries({ queryKey: ["profit-monthly"] });
  qc.invalidateQueries({ queryKey: ["profit-allocations"] });
  qc.invalidateQueries({ queryKey: ["profit-manager-allocations"] });
}

export const useCloseProfitPeriod = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: CloseProfitPeriodInput) => {
      if (!input.organizationId) throw new Error("Không xác định được tổ chức");
      if (!input.expectedSourceHash) throw new Error("Thiếu mã nguồn dữ liệu để chốt");
      if (input.buildingIds.length === 0) throw new Error("Không có nhà để chốt");
      const rpcName = input.reclose ? PROFIT_CLOSE_RPC.reclose : PROFIT_CLOSE_RPC.close;
      const submittedReason = input.reason.trim();
      if (
        input.reclose &&
        (submittedReason.length < 8 || submittedReason.length > 1000)
      ) {
        throw new Error("Lý do chốt lại phải có 8–1000 ký tự");
      }
      const reason = submittedReason || `Chốt lợi nhuận lần đầu ${input.periodMonth}`;
      for (const adjustment of input.adjustments) {
        const disposition = normalizeUnallocatedDisposition(
          adjustment.unallocated_disposition,
        );
        if (
          adjustment.unallocated_disposition != null &&
          !disposition
        ) {
          throw new Error("Cách xử lý phần chưa phân bổ không hợp lệ");
        }
        if (disposition) {
          const dispositionReason =
            adjustment.unallocated_disposition_reason?.trim() ?? "";
          if (dispositionReason.length < 8 || dispositionReason.length > 500) {
            throw new Error(
              "Lý do xử lý phần chưa phân bổ phải có 8–500 ký tự",
            );
          }
        }
      }
      const { data, error } = await supabase.rpc(rpcName, {
        p_organization_id: input.organizationId,
        p_period_month: input.periodMonth,
        p_building_ids: input.buildingIds,
        p_adjustments: input.adjustments,
        p_reason: reason,
        p_idempotency_key: `profit-${input.reclose ? "reclose" : "close"}-${crypto.randomUUID()}`,
        p_expected_source_hash: input.expectedSourceHash,
      });
      if (error) throw error;
      return data;
    },
    onSuccess: (_data, input) => {
      invalidateProfitCloseQueries(qc);
      toast.success(input.reclose ? "Đã chốt lại lợi nhuận tháng" : "Đã chốt lợi nhuận tháng");
    },
    onError: (error: any) => {
      toast.error(error?.message || "Không thể chốt lợi nhuận");
    },
  });
};

export interface ResetProfitPeriodInput {
  organizationId: string;
  periodMonth: string;
  expectedStateHash: string;
  expectedSnapshotIds: string[];
  reason: string;
}

export interface UnlockProfitMonthInput {
  periodMonth: string;
  buildingIds: string[];
}

/**
 * MỞ KHOÁ tháng đã chốt lợi nhuận — nhẹ hơn "Đặt lại tháng".
 *
 * Khác nhau ở chỗ nào:
 *   - Đặt lại tháng (profit_reset_checked_v2): XOÁ hẳn snapshot. Đòi lý do
 *     8–1000 ký tự + CAS state_hash + danh sách snapshot_ids.
 *   - Mở khoá (unlock_profit_month_v1): GIỮ dòng `profit_monthly` nhưng lật về
 *     DRAFT để sửa/ghi phiếu của tháng đó, rồi chốt lại.
 *
 * ⚠ ĐÍNH CHÍNH (31/07/2026): chỗ này từng ghi "snapshot giữ nguyên" — SAI. Đối
 * chiếu thân hàm ĐANG CHẠY trên prod, `unlock_profit_month_v1` làm:
 *     delete from public.profit_allocations         where profit_monthly_id = any(...);
 *     delete from public.profit_manager_allocations where profit_monthly_id = any(...);
 *     update public.profit_monthly set status='DRAFT', management_salary=0,
 *            locked_at=null, locked_by=null …
 * Tức là PHẦN ĐÃ CHIA BỊ XOÁ. Tài liệu người dùng nói đúng điều này, chỉ có
 * comment + tooltip FE nói sai. `profit_unlock_v2` cũng xoá y như vậy — khác ở
 * chỗ nó đòi reason + idempotency_key + CAS hash và ghi `profit_close_runs`.
 *
 * NỢ: FE đang gọi đường v1 KHÔNG audit (không reason, không idempotency, không
 * CAS, không ghi profit_close_runs). Chuyển sang `profit_unlock_v2` cần thêm
 * dialog nhập lý do — việc riêng, chưa làm.
 *
 * RPC đã tồn tại từ trước và tự gác bằng quyền `shareholder_profit.unlock`
 * (thực tế chỉ chủ tổ chức mỗi org có), nhưng tới 30/07/2026 mới được GRANT cho
 * `authenticated` — trước đó có cơ chế khoá mà không có cơ chế mở.
 */
export const useUnlockProfitMonth = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: UnlockProfitMonthInput) => {
      if (input.buildingIds.length === 0) throw new Error("Không có toà nào đang khoá để mở");
      const { data, error } = await supabase.rpc("unlock_profit_month_v1", {
        p_period_month: input.periodMonth,
        p_building_ids: input.buildingIds,
      });
      if (error) throw error;
      return data as number;
    },
    onSuccess: (count) => {
      invalidateProfitCloseQueries(qc);
      qc.invalidateQueries({ queryKey: ["income-expenses"] });
      toast.success(
        `Đã mở khoá ${count ?? 0} toà — sửa/ghi phiếu của tháng này được. Phần đã phân bổ cho cổ đông đã bị xoá, PHẢI chốt lại sau khi sửa xong.`,
      );
    },
    onError: (error: any) => {
      toast.error(error?.message || "Không thể mở khoá tháng");
    },
  });
};

export const useResetProfitPeriod = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: ResetProfitPeriodInput) => {
      if (!input.organizationId) throw new Error("Không xác định được tổ chức");
      if (!input.expectedStateHash) throw new Error("Thiếu mã trạng thái snapshot để đặt lại");
      if (input.expectedSnapshotIds.length === 0) throw new Error("Không có snapshot để đặt lại");
      if (input.reason.trim().length < 8 || input.reason.trim().length > 1000) {
        throw new Error("Lý do đặt lại phải có 8–1000 ký tự");
      }
      const { data, error } = await supabase.rpc(PROFIT_CLOSE_RPC.reset, {
        p_organization_id: input.organizationId,
        p_period_month: input.periodMonth,
        p_reason: input.reason.trim(),
        p_idempotency_key: `profit-reset-${crypto.randomUUID()}`,
        p_expected_state_hash: input.expectedStateHash,
        p_expected_snapshot_ids: [...input.expectedSnapshotIds].sort(),
      });
      if (error) throw error;
      return data;
    },
    onSuccess: () => {
      invalidateProfitCloseQueries(qc);
      toast.success("Đã đặt lại trạng thái chốt lợi nhuận");
    },
    onError: (error: any) => {
      toast.error(error?.message || "Không thể đặt lại tháng");
    },
  });
};
