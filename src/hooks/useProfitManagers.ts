import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { getSessionUser } from "@/lib/authSession";
import { toast } from "sonner";
import type { SalaryForm, SalaryBasis } from "@/lib/managementSalary";

// --- Types ---
export interface ProfitManager {
  id: string;
  user_id: string;
  auth_user_id: string | null;
  name: string;
  note: string | null;
  is_active: boolean;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

export interface ManagerSalaryRule {
  id: string;
  manager_id: string;
  label: string | null;
  form: SalaryForm;
  basis: SalaryBasis;
  amount: number;
  percent: number;
  is_active: boolean;
  building_ids: string[];
}

export interface ProfitManagerFormValues {
  name: string;
  note?: string | null;
  is_active?: boolean;
  auth_user_id?: string | null;
}

// 1 quy tắc khi lưu form (chưa có id khi tạo mới).
export interface SalaryRuleInput {
  label?: string | null;
  form: SalaryForm;
  basis: SalaryBasis;
  amount: number;
  percent: number;
  building_ids: string[];
}

// --- Queries ---

// Danh sách quản lý điều hành (owner/admin thấy tất cả; quản lý chỉ thấy mình qua RLS).
export const useProfitManagers = () => {
  return useQuery({
    queryKey: ["profit-managers"],
    queryFn: async () => {
      const { data, error } = await (supabase
        .from("profit_managers" as any)
        .select("*") as any)
        .is("deleted_at", null)
        .order("name", { ascending: true });
      if (error) {
        toast.error("Không thể tải danh sách quản lý điều hành");
        throw error;
      }
      return (data || []) as ProfitManager[];
    },
  });
};

// Quản lý điều hành tương ứng tài khoản đang đăng nhập (null nếu không phải).
export const useMyProfitManager = () => {
  return useQuery({
    queryKey: ["my-profit-manager"],
    staleTime: 5 * 60 * 1000,
    queryFn: async () => {
      const user = await getSessionUser();
      if (!user) return null;
      const { data, error } = await (supabase
        .from("profit_managers" as any)
        .select("*") as any)
        .eq("auth_user_id", user.id)
        .is("deleted_at", null)
        .maybeSingle();
      if (error) return null;
      return (data as ProfitManager) ?? null;
    },
  });
};

// Tất cả quy tắc lương (kèm building_ids) — cho cấu hình + xem trước/chốt.
export const useManagerSalaries = () => {
  return useQuery({
    queryKey: ["manager-salaries"],
    queryFn: async () => {
      const { data, error } = await (supabase
        .from("profit_manager_salaries" as any)
        .select("*, profit_manager_salary_buildings(building_id)") as any);
      if (error) {
        toast.error("Không thể tải quy tắc lương điều hành");
        throw error;
      }
      return ((data || []) as any[]).map((r) => ({
        id: r.id,
        manager_id: r.manager_id,
        label: r.label ?? null,
        form: r.form,
        basis: r.basis,
        amount: Number(r.amount) || 0,
        percent: Number(r.percent) || 0,
        is_active: r.is_active ?? true,
        building_ids: ((r.profit_manager_salary_buildings || []) as any[]).map((b) => b.building_id),
      })) as ManagerSalaryRule[];
    },
  });
};

// --- Mutations ---

// Lưu 1 quản lý + toàn bộ quy tắc lương của họ. Quy tắc KHÔNG bị tham chiếu bởi
// snapshot (profit_manager_allocations gắn manager_id, không gắn rule id) → an toàn
// xoá-tạo lại toàn bộ quy tắc mỗi lần lưu (khỏi diff).
export const useSaveManagerWithSalaries = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: {
      id?: string;
      values: ProfitManagerFormValues;
      rules: SalaryRuleInput[];
    }) => {
      const user = await getSessionUser();
      if (!user) throw new Error("User not authenticated");
      const uid = user.id;

      // 1) Upsert quản lý
      let managerId = input.id;
      if (input.id) {
        const patch: any = {
          name: input.values.name,
          note: input.values.note ?? null,
          is_active: input.values.is_active ?? true,
        };
        if (input.values.auth_user_id !== undefined) patch.auth_user_id = input.values.auth_user_id;
        const { data, error } = await supabase
          .from("profit_managers" as any)
          .update(patch)
          .eq("id", input.id)
          .select("id");
        if (error) {
          toast.error(error.message || "Không thể cập nhật quản lý");
          throw error;
        }
        if (!data || data.length === 0) throw new Error("Không có quyền sửa quản lý này");
      } else {
        const { data, error } = await supabase
          .from("profit_managers" as any)
          .insert({
            user_id: uid,
            name: input.values.name,
            note: input.values.note ?? null,
            is_active: input.values.is_active ?? true,
            auth_user_id: input.values.auth_user_id ?? null,
          })
          .select("id")
          .single();
        if (error) {
          toast.error(error.message || "Không thể tạo quản lý");
          throw error;
        }
        managerId = (data as any).id;
      }
      if (!managerId) throw new Error("Thiếu manager id");

      // 2) Xoá toàn bộ quy tắc cũ (cascade buildings) rồi tạo lại.
      const { error: delErr } = await (supabase
        .from("profit_manager_salaries" as any)
        .delete() as any)
        .eq("manager_id", managerId);
      if (delErr) throw delErr;

      // 3) Tạo quy tắc mới + tập nhà từng quy tắc.
      for (const rule of input.rules) {
        const buildings = (rule.building_ids || []).filter(Boolean);
        if (buildings.length === 0) continue; // bỏ quy tắc rỗng
        const { data: ruleRow, error: rErr } = await supabase
          .from("profit_manager_salaries" as any)
          .insert({
            user_id: uid,
            manager_id: managerId,
            label: rule.label?.trim() || null,
            form: rule.form,
            basis: rule.basis,
            amount: rule.form === "FIXED" ? Math.max(0, rule.amount || 0) : 0,
            percent: rule.form === "PERCENT" ? Math.max(0, Math.min(100, rule.percent || 0)) : 0,
            is_active: true,
          })
          .select("id")
          .single();
        if (rErr) throw rErr;
        const salaryId = (ruleRow as any).id;
        const { error: bErr } = await supabase
          .from("profit_manager_salary_buildings" as any)
          .insert(
            buildings.map((building_id) => ({ user_id: uid, salary_id: salaryId, building_id }))
          );
        if (bErr) throw bErr;
      }
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["profit-managers"] });
      qc.invalidateQueries({ queryKey: ["manager-salaries"] });
      toast.success("Đã lưu quản lý & lương điều hành");
    },
  });
};

export const useDeleteProfitManager = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const { data, error } = await supabase
        .from("profit_managers" as any)
        .update({ deleted_at: new Date().toISOString() })
        .eq("id", id)
        .select("id");
      if (error) {
        toast.error(error.message || "Không thể xoá quản lý");
        throw error;
      }
      if (!data || data.length === 0) throw new Error("Không có quyền xoá quản lý này");
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["profit-managers"] });
      toast.success("Đã xoá quản lý");
    },
  });
};
