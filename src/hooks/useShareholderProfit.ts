import {readProfitMonthly,readProfitAllocations,readManagerAllocations,readShareholderDistributions,readManagerPayouts,readAccrualByBuilding,readProfitScopes,readProfitPeers,readProfitState,readProfitPreview,profitRows,profitString} from '@/lib/profitReadModels';
import { persistentFinancialWorkflow } from '@/lib/persistentFinancialWorkflow';
import { useRef } from "react";
import { FinancialWorkflowError } from "@/lib/financialWorkflow";
import { profitActionErrorMessage, readProfitActionResult } from "@/lib/profitFeedback";
import { useMemo } from "react";
import { rpcNullable } from "@/lib/rpcNullable";
import { batBuoc } from "@/lib/queryGuard";
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
  type TotalGroupPeerMap,
  type ProfitUnallocatedDisposition,
} from "@/lib/profitClose";
import { fetchAllRows } from "@/lib/supabaseFetchAll";

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
  const buildingsQuery=useBuildings();
  const query = useQuery({
    queryKey: ["monthly-building-profit", start, end, buildingId ?? null],
    meta: { label: "dữ liệu lợi nhuận", errorDisplay: "inline" },
    enabled: !!start && !!end,
    queryFn: async (): Promise<MonthlyBuildingProfit[]> => {
      const { data, error } = await supabase.rpc("fa_monthly_pnl_accrual", {
        p_start_date: rpcNullable(start),
        p_end_date: rpcNullable(end),
        p_building_ids: buildingId ? [buildingId] : undefined,
      });
      if (error) {
        throw error;
      }
      return readAccrualByBuilding(data);
    },
  });

  const computed=useMemo(()=>{
    if(query.data===undefined||buildingsQuery.data===undefined)return {data:undefined,validationError:null};
    try{
      const buildings=profitRows(buildingsQuery.data,b=>({id:profitString(b.id),name:profitString(b.name)}));
      const byId=new Map(query.data.map(row=>[row.building_id,row]));
      const list=buildings.filter(building=>!buildingId||building.id===buildingId);
      const data:MonthlyBuildingProfit[]=list.map(building=>byId.get(building.id)??{building_id:building.id,building_name:building.name,total_income:0,total_expense:0,net_profit:0});
      const known=new Set(list.map(building=>building.id));for(const row of query.data)if(!known.has(row.building_id))data.push(row);
      return {data:data.sort((a,b)=>a.building_name.localeCompare(b.building_name,'vi')),validationError:null};
    }catch(error){return {data:undefined,validationError:error};}
  },[query.data,buildingsQuery.data,buildingId]);
  const error=computed.validationError??query.error??buildingsQuery.error;
  const isError=!!error||query.isError||buildingsQuery.isError;
  const isLoading=query.isLoading||buildingsQuery.isLoading;
  return {...query,data:computed.data,error,isError,isLoading,isSuccess:!isError&&!isLoading&&computed.data!==undefined,status:isError?'error' as const:isLoading?'pending' as const:query.status,
    refetch:()=>Promise.allSettled([query.refetch(),buildingsQuery.refetch()])};
};

// Tất cả phiếu chốt LN (owner thấy all; cổ đông thấy tháng có phần mình qua RLS).
export const useProfitMonthly = () => {
  return useQuery({
    queryKey: ["profit-monthly"],
    meta: { label: "dữ liệu lợi nhuận", errorDisplay: "inline" },
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
        throw new Error("Lỗi tải toàn bộ lịch sử chốt lợi nhuận");
      }
      return readProfitMonthly(data);
    },
  });
};

// Tất cả phân bổ (kèm period_month + building_id từ profit_monthly).
export const useProfitAllocations = () => {
  return useQuery({
    queryKey: ["profit-allocations"],
    meta: { label: "dữ liệu lợi nhuận", errorDisplay: "inline" },
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
        throw new Error("Lỗi tải toàn bộ phân bổ lợi nhuận");
      }
      return readProfitAllocations(data);
    },
  });
};

// Các phiếu chi chia LN (đã ứng) gắn cổ đông.
export const useShareholderDistributions = () => {
  return useQuery({
    queryKey: ["shareholder-distributions"],
    meta: { label: "dữ liệu lợi nhuận", errorDisplay: "inline" },
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
        throw new Error("Lỗi tải toàn bộ lịch sử chia lợi nhuận");
      }
      return readShareholderDistributions(data);
    },
  });
};

// Snapshot lương điều hành (kèm period_month + building_id từ profit_monthly).
export const useProfitManagerAllocations = () => {
  return useQuery({
    queryKey: ["profit-manager-allocations"],
    meta: { label: "dữ liệu lợi nhuận", errorDisplay: "inline" },
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
        throw new Error("Lỗi tải toàn bộ phân bổ lương điều hành");
      }
      return readManagerAllocations(data);
    },
  });
};

// Các phiếu chi trả lương điều hành (đã trả) gắn quản lý.
export const useManagerSalaryPayouts = () => {
  return useQuery({
    queryKey: ["manager-salary-payouts"],
    meta: { label: "dữ liệu lợi nhuận", errorDisplay: "inline" },
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
        throw new Error("Lỗi tải toàn bộ lịch sử trả lương điều hành");
      }
      return readManagerPayouts(data);
    },
  });
};

// --- Canonical V2 close workflow. All calculations and writes stay server-side. ---

/**
 * Tên các RPC chốt lợi nhuận V2, giữ lại để đọc thành nhóm.
 *
 * NHƯNG CHỖ GỌI PHẢI VIẾT THẲNG TÊN. Ba gate canh biên RPC
 * (`check-rpc-surface`, `check-rpc-arg-names`, `check-rpc-layer`) tìm tên bằng
 * chuỗi viết thẳng trong văn bản, nên `supabase.rpc(PROFIT_CLOSE_RPC.state, …)`
 * vô hình với cả ba — và năm RPC này là ĐƯỜNG TIỀN. Đo 12/08/2026 trước khi sửa:
 * chúng không hề có mặt trong `contracts/surfaces/rpc-surface.json`.
 *
 * `scripts/check-rpc-name-literal.mjs` canh để chuyện đó không tái diễn.
 */
export const PROFIT_CLOSE_RPC = {
  scopes: "profit_close_scopes_v2",
  state: "profit_close_state_v2",
  preview: "profit_close_preview_v2",
  close: "profit_close_v2",
  reclose: "profit_reclose_v2",
  reset: "profit_reset_checked_v2",
  unlock: "profit_unlock_v2",
  totalGroupPeers: "profit_total_group_peers_v2",
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

export const useProfitCloseOrganizations=()=>useQuery({queryKey:['profit-close-scopes'],meta:{label:'dữ liệu lợi nhuận',errorDisplay:'inline'},staleTime:5*60*1000,queryFn:async()=>{const {data,error}=await supabase.rpc('profit_close_scopes_v2');if(error)throw error;return readProfitScopes(data);}});

/**
 * Bản đồ "chốt nhà này thì phải chốt cùng nhà nào".
 *
 * Là cấu hình mức tổ chức (quy tắc lương điều hành TOTAL_GROUP), không phụ thuộc
 * tháng — nên tách khỏi preview. Cố ý KHÔNG nhét vào `profit_close_preview_v2`:
 * mọi khoá mới trong tài liệu nguồn đều đổi `building_source_hash` và làm mọi
 * snapshot đang LOCKED hoá "lệch nguồn".
 */
export const useProfitTotalGroupPeers = (organizationId?: string) => {
  return useQuery({
    queryKey: ["profit-total-group-peers", organizationId],
    meta: { label: "dữ liệu lợi nhuận", errorDisplay: "inline" },
    enabled: !!organizationId,
    staleTime: 5 * 60 * 1000,
    queryFn: async (): Promise<TotalGroupPeerMap> => {
      const { data, error } = await supabase.rpc("profit_total_group_peers_v2", {
        p_organization_id: batBuoc(organizationId, "organizationId"),
      });
      if (error) throw error;
      return readProfitPeers(data);
    },
  });
};

export const useProfitCloseState = (
  organizationId?: string,
  periodMonth?: string,
) => {
  return useQuery({
    queryKey: ["profit-close-state", organizationId, periodMonth],
    meta: { label: "dữ liệu lợi nhuận", errorDisplay: "inline" },
    enabled: !!organizationId && !!periodMonth,
    queryFn: async (): Promise<ProfitCloseState> => {
      const { data, error } = await supabase.rpc("profit_close_state_v2", {
        p_organization_id: batBuoc(organizationId, 'organizationId'),
        p_period_month: batBuoc(periodMonth, 'periodMonth'),
      });
      if (error) throw error;
      return readProfitState(data,batBuoc(organizationId,'organizationId'),batBuoc(periodMonth,'periodMonth'));
    },
  });
};

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
    meta:{label:"dữ liệu lợi nhuận",errorDisplay:"inline"},
    enabled:
      enabled &&
      !!organizationId &&
      !!periodMonth &&
      (buildingIds === null || buildingIds.length > 0),
    queryFn: async (): Promise<ProfitClosePreview> => {
      const { data, error } = await supabase.rpc("profit_close_preview_v2", {
        p_organization_id: batBuoc(organizationId, 'organizationId'),
        p_period_month: batBuoc(periodMonth, 'periodMonth'),
        p_building_ids: buildingIds ?? undefined,
        p_adjustments: previewAdjustments,
      });
      if (error) throw error;
      return readProfitPreview(
        data,
        batBuoc(organizationId, 'organizationId'),
        batBuoc(periodMonth, 'periodMonth'),
      );
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
  const workflow = useRef(persistentFinancialWorkflow('profit-close'));
  return useMutation({
    mutationFn: async (input: CloseProfitPeriodInput) => {
      if (!input.organizationId) throw new FinancialWorkflowError("Không xác định được tổ chức", 'failure', []);
      return workflow.current.run(`${input.organizationId}:${input.periodMonth}`, "chốt lợi nhuận", async () => {
      if (!input.expectedSourceHash) throw new FinancialWorkflowError("Thiếu mã nguồn dữ liệu để chốt", 'failure', []);
      if (input.buildingIds.length === 0) throw new FinancialWorkflowError("Không có nhà để chốt", 'failure', []);
      const rpcName = input.reclose ? PROFIT_CLOSE_RPC.reclose : PROFIT_CLOSE_RPC.close;
      const submittedReason = input.reason.trim();
      if (
        input.reclose &&
        (submittedReason.length < 8 || submittedReason.length > 1000)
      ) {
        throw new FinancialWorkflowError("Lý do chốt lại phải có 8–1000 ký tự", 'failure', []);
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
          throw new FinancialWorkflowError("Cách xử lý phần chưa phân bổ không hợp lệ", 'failure', []);
        }
        if (disposition) {
          const dispositionReason =
            adjustment.unallocated_disposition_reason?.trim() ?? "";
          if (dispositionReason.length < 8 || dispositionReason.length > 500) {
            throw new FinancialWorkflowError(
              "Lý do xử lý phần chưa phân bổ phải có 8–500 ký tự", 'failure', [],
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
      return readProfitActionResult(data,input.buildingIds.length);
    }, undefined, input.organizationId);
    },
    onSuccess: (result, input) => {
      invalidateProfitCloseQueries(qc);
      toast[result.idempotent_replay ? 'info' : 'success'](`${result.idempotent_replay ? 'Yêu cầu đã hoàn tất trước đó' : input.reclose ? 'Đã chốt lại' : 'Đã chốt'}: ${result.affected_buildings} nhà, tháng ${input.periodMonth.slice(5,7)}/${input.periodMonth.slice(0,4)}.`);
    },
    onError: (error) => { toast.error(profitActionErrorMessage(error,"chốt lợi nhuận")); },
  });
};

export interface ResetProfitPeriodInput {
  organizationId: string;
  periodMonth: string;
  expectedStateHash: string;
  expectedSnapshotIds: string[];
  reason: string;
  /**
   * NULL = đặt lại cả kỳ (hành vi cũ). Khác NULL = chỉ đặt lại các nhà này.
   *
   * CAS vẫn ở mức TOÀN KỲ: expectedStateHash + expectedSnapshotIds phải khớp
   * toàn bộ snapshot đang có của tháng, nên không đặt lại được trên trạng thái
   * đã cũ dù chỉ nhắm một nhà.
   */
  targetBuildingIds: string[] | null;
}

export interface UnlockProfitMonthInput {
  /** Tổ chức đang chọn trên màn Chốt lợi nhuận — máy chủ gác quyền theo tổ chức. */
  organizationId: string;
  /** Kỳ dạng 'YYYY-MM-01'. */
  periodMonth: string;
  /** Chỉ những nhà ĐANG Đã chốt — máy chủ từ chối cả lượt nếu có nhà không LOCKED. */
  buildingIds: string[];
  /** Lý do mở khoá 8–1000 ký tự (sau khi cắt khoảng trắng) — được lưu lại. */
  reason: string;
}

/** Phần cần dùng trong kết quả jsonb của `profit_unlock_v2`. */
export interface UnlockProfitMonthResult {
  run_id: string | null;
  affected_buildings: number;
  idempotent_replay: boolean;
}

/**
 * Câu tiếng Việt cho các lỗi `profit_unlock_v2` người dùng có thể gặp. Bộ hàm
 * chốt V2 báo lỗi bằng tiếng Anh; chỉ giữ nội dung nghiệp vụ đã xác minh.
 */
export function unlockProfitMonthErrorMessage(message: string | null | undefined): string {
  if(message === 'reason must contain 8..1000 characters') return 'Lý do mở khoá phải có 8–1000 ký tự';
  return profitActionErrorMessage({message},'mở khóa lợi nhuận');
}

/**
 * MỞ KHOÁ tháng đã chốt lợi nhuận — gọi `profit_unlock_v2`, BẮT BUỘC có lý do.
 *
 * Khác "Đặt lại tháng" (profit_reset_checked_v2) ở chỗ nào:
 *   - Đặt lại: XOÁ hẳn snapshot; CAS state_hash + danh sách snapshot_ids.
 *   - Mở khoá: GIỮ dòng `profit_monthly` nhưng lật về DRAFT (is_stale = true,
 *     stale_reason 'UNLOCKED: <lý do>') để sửa/lập/huỷ phiếu của tháng đó, rồi
 *     chốt lại.
 *
 * Hậu quả KHÔNG nhẹ: máy chủ XOÁ `profit_allocations` + `profit_manager_allocations`
 * của các nhà được mở và đặt `management_salary = 0` — PHẦN ĐÃ CHIA BỊ XOÁ, phải
 * chốt lại. (Comment cũ từng ghi "snapshot giữ nguyên" — sai, đã đối chiếu thân
 * hàm thật 31/07/2026.)
 *
 * Có vết: lý do + idempotency key + người mở + ảnh chụp phân bổ trước khi xoá nằm
 * trong `profit_close_runs`, mỗi nhà thêm một dòng `profit_close_revisions`. Đường
 * mở khoá v1 cũ (không lý do, không vết) đã bỏ: giao diện chuyển sang đây ngày
 * 25/09/2026; migration 20260925083655_dong_duong_cu_sua_phieu gỡ hàm cũ khỏi máy
 * chủ (áp sau khi web mới lên).
 *
 * KHÔNG gửi `p_expected_source_hash`: máy chủ so MỘT hash với `source_hash` của
 * TỪNG nhà, mà mỗi nhà một hash riêng — mở từ hai nhà trở lên là chắc chắn lệch.
 * Trạng thái đổi dưới tay thì máy chủ tự chặn: nhà nào không còn LOCKED là cả lượt
 * bị từ chối (55000).
 *
 * `p_building_ids` luôn khác NULL: NULL nghĩa là MỌI snapshot của kỳ, kể cả dòng
 * legacy trên toà ảo — phạm vi phải do người dùng tick ra.
 *
 * Quyền `shareholder_profit.unlock` (thực tế chỉ chủ công ty có). Từ 25/09/2026
 * khoá tháng là TUYỆT ĐỐI — mọi phiếu có ngày trong tháng đã chốt bị khoá với MỌI
 * người, kể cả chủ công ty và super admin — nên đây là đường duy nhất để sửa phiếu
 * của tháng đó.
 */
export const useUnlockProfitMonth = () => {
  const qc = useQueryClient();
  const workflow = useRef(persistentFinancialWorkflow('profit-unlock'));
  return useMutation({
    mutationFn: async (input: UnlockProfitMonthInput): Promise<UnlockProfitMonthResult> => {
      if (!input.organizationId) throw new FinancialWorkflowError("Không xác định được tổ chức", 'failure', []);
      return workflow.current.run(`${input.organizationId}:${input.periodMonth}`, "mở khóa lợi nhuận", async () => {
      if (!/^\d{4}-\d{2}-01$/.test(input.periodMonth)) {
        throw new FinancialWorkflowError("Kỳ mở khoá phải là ngày đầu tháng (YYYY-MM-01)", 'failure', []);
      }
      const buildingIds = [...new Set(input.buildingIds)].sort();
      if (buildingIds.length === 0) throw new FinancialWorkflowError("Không có toà nào đang khoá để mở", 'failure', []);
      const reason = input.reason.trim();
      if (reason.length < 8 || reason.length > 1000) {
        throw new FinancialWorkflowError("Lý do mở khoá phải có 8–1000 ký tự", 'failure', []);
      }
      const { data, error } = await supabase.rpc("profit_unlock_v2", {
        p_organization_id: input.organizationId,
        p_period_month: input.periodMonth,
        p_reason: reason,
        p_idempotency_key: `profit-unlock-${crypto.randomUUID()}`,
        p_building_ids: buildingIds,
      });
      if (error) throw error;
      return readProfitActionResult(data,buildingIds.length);
    }, undefined, input.organizationId);
    },
    onSuccess: (result, input) => {
      invalidateProfitCloseQueries(qc);
      qc.invalidateQueries({ queryKey: ["income-expenses"] });
      // Nút Huỷ ở màn Thu chi đọc trạng thái khoá qua hai reader này (giữ 30 giây):
      // không làm mới thì vừa mở khoá xong nút vẫn mờ vì "tháng đã chốt".
      qc.invalidateQueries({ queryKey: ["income-cancel-eligibility"] });
      qc.invalidateQueries({ queryKey: ["flex-cancel-eligibility"] });
      const thang = `${input.periodMonth.slice(5, 7)}/${input.periodMonth.slice(0, 4)}`;
      toast.success(
        `Đã mở khoá ${result.affected_buildings} toà tháng ${thang} — sửa/ghi phiếu của tháng này được, lý do đã được lưu lại. Phần đã phân bổ cho cổ đông đã bị xoá, PHẢI chốt lại sau khi sửa xong.`,
      );
    },
    onError: (error) => { toast.error(profitActionErrorMessage(error,"mở khóa lợi nhuận")); },
  });
};

export const useResetProfitPeriod = () => {
  const qc = useQueryClient();
  const workflow = useRef(persistentFinancialWorkflow('profit-reset'));
  return useMutation({
    mutationFn: async (input: ResetProfitPeriodInput) => {
      if (!input.organizationId) throw new FinancialWorkflowError("Không xác định được tổ chức", 'failure', []);
      return workflow.current.run(`${input.organizationId}:${input.periodMonth}`, "đặt lại lợi nhuận", async () => {
      if (!input.expectedStateHash) throw new FinancialWorkflowError("Thiếu mã trạng thái snapshot để đặt lại", 'failure', []);
      if (input.expectedSnapshotIds.length === 0) throw new FinancialWorkflowError("Không có snapshot để đặt lại", 'failure', []);
      if (input.reason.trim().length < 8 || input.reason.trim().length > 1000) {
        throw new FinancialWorkflowError("Lý do đặt lại phải có 8–1000 ký tự", 'failure', []);
      }
      const { data, error } = await supabase.rpc("profit_reset_checked_v2", {
        p_organization_id: input.organizationId,
        p_period_month: input.periodMonth,
        p_reason: input.reason.trim(),
        p_idempotency_key: `profit-reset-${crypto.randomUUID()}`,
        p_expected_state_hash: input.expectedStateHash,
        p_expected_snapshot_ids: [...input.expectedSnapshotIds].sort(),
        p_target_building_ids: input.targetBuildingIds
          ? [...input.targetBuildingIds].sort()
          : undefined,
      });
      if (error) throw error;
      return readProfitActionResult(data,input.targetBuildingIds?.length ?? input.expectedSnapshotIds.length);
    }, undefined, input.organizationId);
    },
    onSuccess: (result,input) => {
      invalidateProfitCloseQueries(qc);
      toast[result.idempotent_replay ? "info" : "success"](`Đã đặt lại trạng thái chốt của ${result.affected_buildings} nhà, tháng ${input.periodMonth.slice(5,7)}/${input.periodMonth.slice(0,4)}.`);
    },
    onError: (error) => { toast.error(profitActionErrorMessage(error,"đặt lại lợi nhuận")); },
  });
};
