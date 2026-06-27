import { useMemo } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { getSessionUser } from "@/lib/authSession";
import { toast } from "sonner";
import { useBuildings } from "@/hooks/useBuildings";
import { monthDateRange } from "@/components/shareholders/shareholderUtils";
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
      const { data, error } = await (supabase.rpc as any)("fa_monthly_pnl_accrual", {
        p_start_date: start,
        p_end_date: end,
        p_building_ids: buildingId ? [buildingId] : null,
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

// Ghi-khoá 1 tháng: upsert profit_monthly (LOCKED) + snapshot lại profit_allocations
// theo tỷ lệ building_shareholders. Tách riêng để cả chốt thủ công lẫn resync dùng chung.
async function writeLockedMonth(
  uid: string,
  period_month: string,
  rows: LockProfitInput["rows"]
): Promise<{ locked: number; allocations: number }> {
  if (rows.length === 0) return { locked: 0, allocations: 0 };
  const nowIso = new Date().toISOString();

  // 1) Upsert profit_monthly (LOCKED) cho từng nhà
  const pmPayload = rows.map((r) => ({
    user_id: uid,
    building_id: r.building_id,
    period_month,
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

  // 2) Lấy tỷ lệ cổ đông của các nhà này — CHỈ cổ đông còn hiệu lực.
  // building_shareholders KHÔNG bị xoá khi cổ đông soft-delete → phải lọc theo
  // shareholders.deleted_at, nếu không sẽ tạo phân bổ "ma" cho cổ đông đã xoá
  // (vd "Green") làm tổng được chia phồng so với danh sách cổ đông hiển thị.
  const { data: shares, error: shErr } = await (supabase
    .from("building_shareholders" as any)
    .select("building_id, shareholder_id, percent") as any)
    .in("building_id", buildingIds);
  if (shErr) throw shErr;
  const { data: activeSh, error: aShErr } = await (supabase
    .from("shareholders" as any)
    .select("id") as any)
    .is("deleted_at", null);
  if (aShErr) throw aShErr;
  const activeShIds = new Set(((activeSh || []) as any[]).map((s) => s.id));

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
    if (!activeShIds.has(s.shareholder_id)) continue; // bỏ cổ đông đã xoá
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
}

export const useLockProfitMonth = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: LockProfitInput) => {
      const uid = (await getSessionUser())?.id;
      if (!uid) throw new Error("User not authenticated");
      if (input.rows.length === 0) throw new Error("Không có dữ liệu để chốt");
      return writeLockedMonth(uid, input.period_month, input.rows);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["profit-monthly"] });
      qc.invalidateQueries({ queryKey: ["profit-allocations"] });
      toast.success("Đã chốt lợi nhuận tháng");
    },
  });
};

// Chốt LẠI mọi tháng đang LOCKED theo số accrual mới (đồng bộ với Phân bổ lợi nhuận).
// Chỉ cập nhật đúng các toà đã chốt của từng tháng; GIỮ "LN sau điều chỉnh" nếu
// trước đó user đã sửa tay (adjusted_profit ≠ computed_profit), còn lại lấy số mới.
export const useResyncLockedMonths = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      const uid = (await getSessionUser())?.id;
      if (!uid) throw new Error("User not authenticated");

      const { data: lockedRows, error } = await (supabase
        .from("profit_monthly" as any)
        .select("building_id, period_month, computed_profit, adjusted_profit") as any)
        .eq("status", "LOCKED");
      if (error) throw error;

      const locked = (lockedRows || []) as any[];
      if (locked.length === 0) return { months: 0, buildings: 0 };

      // Gom các dòng đã chốt theo tháng.
      const byMonth = new Map<string, any[]>();
      for (const r of locked) {
        const arr = byMonth.get(r.period_month) ?? [];
        arr.push(r);
        byMonth.set(r.period_month, arr);
      }

      let months = 0;
      let buildings = 0;
      for (const [period, lrows] of byMonth) {
        const { start, end } = monthDateRange(period);
        const { data: acc, error: accErr } = await (supabase.rpc as any)(
          "fa_monthly_pnl_accrual",
          { p_start_date: start, p_end_date: end, p_building_ids: null }
        );
        if (accErr) throw accErr;

        const accNet = new Map<string, number>();
        for (const a of aggregateAccrualByBuilding(acc as any[])) {
          accNet.set(a.building_id, a.net_profit);
        }

        const rows = lrows.map((lr) => {
          const newComputed = accNet.get(lr.building_id) ?? 0;
          const hadManualEdit =
            Number(lr.adjusted_profit) !== Number(lr.computed_profit);
          return {
            building_id: lr.building_id,
            computed_profit: newComputed,
            adjusted_profit: hadManualEdit ? Number(lr.adjusted_profit) : newComputed,
          };
        });

        await writeLockedMonth(uid, period, rows);
        months += 1;
        buildings += rows.length;
      }
      return { months, buildings };
    },
    onSuccess: (res) => {
      qc.invalidateQueries({ queryKey: ["monthly-building-profit"] });
      qc.invalidateQueries({ queryKey: ["profit-monthly"] });
      qc.invalidateQueries({ queryKey: ["profit-allocations"] });
      if (res.months === 0) {
        toast.info("Không có tháng đã chốt để cập nhật");
      } else {
        toast.success(`Đã chốt lại ${res.months} tháng theo số mới`);
      }
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
