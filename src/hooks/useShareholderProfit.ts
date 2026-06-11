import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { getSessionUser } from "@/lib/authSession";
import { toast } from "sonner";
import {
  computeShareholderSummary,
  type ShareholderSummaryRow,
} from "@/lib/shareholderProfit";

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
  status: "DRAFT" | "LOCKED";
  note: string | null;
  locked_at: string | null;
  locked_by: string | null;
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

// LN theo nhà cho 1 khoảng (RPC, chỉ khoản KQKD).
export const useMonthlyBuildingProfit = (
  start?: string,
  end?: string,
  buildingId?: string
) => {
  return useQuery({
    queryKey: ["monthly-building-profit", start, end, buildingId ?? null],
    enabled: !!start && !!end,
    queryFn: async () => {
      const { data, error } = await (supabase.rpc as any)("monthly_building_profit", {
        p_start: start,
        p_end: end,
        p_building_id: buildingId ?? null,
      });
      if (error) {
        toast.error("Không thể tính lợi nhuận theo nhà");
        throw error;
      }
      return ((data || []) as any[]).map((r) => ({
        building_id: r.building_id,
        building_name: r.building_name,
        total_income: Number(r.total_income) || 0,
        total_expense: Number(r.total_expense) || 0,
        net_profit: Number(r.net_profit) || 0,
      })) as MonthlyBuildingProfit[];
    },
  });
};

// Tất cả phiếu chốt LN (owner thấy all; cổ đông thấy tháng có phần mình qua RLS).
export const useProfitMonthly = () => {
  return useQuery({
    queryKey: ["profit-monthly"],
    queryFn: async () => {
      const { data, error } = await (supabase
        .from("profit_monthly" as any)
        .select("*") as any)
        .order("period_month", { ascending: false });
      if (error) {
        toast.error("Không thể tải dữ liệu chốt lợi nhuận");
        throw error;
      }
      return ((data || []) as any[]).map((r) => ({
        ...r,
        computed_profit: Number(r.computed_profit) || 0,
        adjusted_profit: Number(r.adjusted_profit) || 0,
      })) as ProfitMonthly[];
    },
  });
};

// Tất cả phân bổ (kèm period_month + building_id từ profit_monthly).
export const useProfitAllocations = () => {
  return useQuery({
    queryKey: ["profit-allocations"],
    queryFn: async () => {
      const { data, error } = await (supabase
        .from("profit_allocations" as any)
        .select("*, pm:profit_monthly_id(period_month, building_id, status)") as any);
      if (error) {
        toast.error("Không thể tải phân bổ lợi nhuận");
        throw error;
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
      const { data, error } = await (supabase
        .from("income_expenses" as any)
        .select("id, shareholder_id, total_amount, voucher_date, name, account_id, building_id") as any)
        .eq("type", "EXPENSE")
        .eq("approval_status", "APPROVED")
        .not("shareholder_id", "is", null)
        .is("deleted_at", null)
        .order("voucher_date", { ascending: false });
      if (error) {
        toast.error("Không thể tải lịch sử chia lợi nhuận");
        throw error;
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

// --- Lock mutation: chốt LN 1 tháng → ghi profit_monthly (LOCKED) + snapshot allocations ---
export interface LockProfitInput {
  period_month: string; // YYYY-MM-01
  rows: Array<{ building_id: string; computed_profit: number; adjusted_profit: number }>;
}

export const useLockProfitMonth = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: LockProfitInput) => {
      const auth = { user: await getSessionUser() };
      if (!auth.user) throw new Error("User not authenticated");
      const uid = auth.user.id;
      const nowIso = new Date().toISOString();

      if (input.rows.length === 0) throw new Error("Không có dữ liệu để chốt");

      // 1) Upsert profit_monthly (LOCKED) cho từng nhà
      const pmPayload = input.rows.map((r) => ({
        user_id: uid,
        building_id: r.building_id,
        period_month: input.period_month,
        computed_profit: r.computed_profit,
        adjusted_profit: r.adjusted_profit,
        status: "LOCKED",
        locked_at: nowIso,
        locked_by: uid,
      }));
      const { data: pmRows, error: pmErr } = await supabase
        .from("profit_monthly" as any)
        .upsert(pmPayload, { onConflict: "building_id,period_month" })
        .select("id, building_id, adjusted_profit");
      if (pmErr) {
        toast.error(pmErr.message || "Không thể chốt lợi nhuận");
        throw pmErr;
      }

      const pm = (pmRows || []) as any[];
      const buildingIds = pm.map((r) => r.building_id);
      const pmIds = pm.map((r) => r.id);

      // 2) Lấy tỷ lệ cổ đông của các nhà này
      const { data: shares, error: shErr } = await (supabase
        .from("building_shareholders" as any)
        .select("building_id, shareholder_id, percent") as any)
        .in("building_id", buildingIds);
      if (shErr) throw shErr;

      // 3) Xoá allocations cũ của các profit_monthly này rồi insert lại (snapshot)
      if (pmIds.length > 0) {
        const { error: delErr } = await (supabase
          .from("profit_allocations" as any)
          .delete() as any)
          .in("profit_monthly_id", pmIds);
        if (delErr) throw delErr;
      }

      const pmByBuilding = new Map<string, { id: string; adjusted: number }>();
      for (const r of pm) {
        pmByBuilding.set(r.building_id, { id: r.id, adjusted: Number(r.adjusted_profit) || 0 });
      }

      const allocPayload: any[] = [];
      for (const s of (shares || []) as any[]) {
        const target = pmByBuilding.get(s.building_id);
        if (!target) continue;
        const percent = Number(s.percent) || 0;
        const amount = Math.round((target.adjusted * percent) / 100);
        allocPayload.push({
          user_id: uid,
          profit_monthly_id: target.id,
          shareholder_id: s.shareholder_id,
          percent,
          amount,
        });
      }

      if (allocPayload.length > 0) {
        const { error: insErr } = await supabase
          .from("profit_allocations" as any)
          .insert(allocPayload);
        if (insErr) throw insErr;
      }

      return { locked: pm.length, allocations: allocPayload.length };
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["profit-monthly"] });
      qc.invalidateQueries({ queryKey: ["profit-allocations"] });
      toast.success("Đã chốt lợi nhuận tháng");
    },
  });
};

// Mở khoá 1 tháng (xoá allocations + set DRAFT) cho 1 nhà.
export const useUnlockProfitMonth = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (profitMonthlyId: string) => {
      const { error: delErr } = await (supabase
        .from("profit_allocations" as any)
        .delete() as any)
        .eq("profit_monthly_id", profitMonthlyId);
      if (delErr) throw delErr;
      const { error } = await supabase
        .from("profit_monthly" as any)
        .update({ status: "DRAFT", locked_at: null, locked_by: null })
        .eq("id", profitMonthlyId);
      if (error) throw error;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["profit-monthly"] });
      qc.invalidateQueries({ queryKey: ["profit-allocations"] });
      toast.success("Đã mở khoá tháng");
    },
  });
};
