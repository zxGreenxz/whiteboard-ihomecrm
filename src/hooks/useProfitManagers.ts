import { requireReadRows, requireReadRow, profitPersonRow, salaryRuleRow } from "@/lib/accountProfitReadModels";
import { useRef } from "react";
import { FinancialWorkflowError } from "@/lib/financialWorkflow";
import { persistentFinancialWorkflow } from "@/lib/persistentFinancialWorkflow";
import { requireProfitRows } from "@/lib/profitConfigurationReceipt";
import { requireAccountWriteReceipt } from "@/lib/accountSettingsWriteReceipt";
import { validateProfitPerson, validateSalaryRules } from "@/lib/profitFeedback";
import { notifyActionError } from "@/lib/actionFeedback";
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
    meta: { label: "dữ liệu lợi nhuận", errorDisplay: "inline" },
    queryFn: async () => {
      const { data, error } = await (supabase
        .from("profit_managers" as any)
        .select("*") as any)
        .is("deleted_at", null)
        .order("name", { ascending: true });
      if (error) {
        throw error;
      }
      return requireReadRows<ProfitManager>(data, profitPersonRow);
    },
  });
};

// Quản lý điều hành tương ứng tài khoản đang đăng nhập (null nếu không phải).
export const useMyProfitManager = () => {
  return useQuery({
    queryKey: ["my-profit-manager"],
    meta: { label: "dữ liệu lợi nhuận", errorDisplay: "inline" },
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
      // KHÔNG nuốt: null ở đây nghĩa "bạn không phải quản lý điều hành", nên một
      // lỗi RLS/mạng bị nuốt sẽ ẩn nguyên khu lương của đúng người có quyền.
      if (error) throw error;
      return data === null ? null : requireReadRow<ProfitManager>(data, profitPersonRow);
    },
  });
};

// Tất cả quy tắc lương (kèm building_ids) — cho cấu hình + xem trước/chốt.
export const useManagerSalaries = () => {
  return useQuery({
    queryKey: ["manager-salaries"],
    meta: { label: "dữ liệu lợi nhuận", errorDisplay: "inline" },
    queryFn: async () => {
      const { data, error } = await (supabase
        .from("profit_manager_salaries" as any)
        .select("*, profit_manager_salary_buildings(building_id)") as any);
      if (error) {
        throw error;
      }
      return requireReadRows<Omit<ManagerSalaryRule, "building_ids"> & {profit_manager_salary_buildings: {building_id: string}[]}>(data, salaryRuleRow).map((r) => ({
        id: r.id,
        manager_id: r.manager_id,
        label: r.label ?? null,
        form: r.form,
        basis: r.basis,
        amount: r.amount,
        percent: r.percent,
        is_active: r.is_active,
        building_ids: r.profit_manager_salary_buildings.map((b) => b.building_id),
      })) as ManagerSalaryRule[];
    },
  });
};

// --- Mutations ---

// Lưu 1 quản lý + toàn bộ quy tắc lương của họ. Quy tắc KHÔNG bị tham chiếu bởi
// snapshot (profit_manager_allocations gắn manager_id, không gắn rule id) → an toàn
// xoá-tạo lại toàn bộ quy tắc mỗi lần lưu (khỏi diff). Nhiều yêu cầu riêng biệt:
// nếu bước sau lỗi, giữ mã/bước đã xác nhận và chặn chạy lại toàn bộ.
export const useSaveManagerWithSalaries = () => {
  const qc = useQueryClient();
  const workflow = useRef(persistentFinancialWorkflow('profit-manager-save'));
  return useMutation({
    meta: { handlesFeedback: true },
    mutationFn: async (input: {
      id?: string;
      values: ProfitManagerFormValues;
      rules: SalaryRuleInput[];
    }) => workflow.current.run(input.id ?? `new:${input.values.auth_user_id ?? ''}`, 'lưu quản lý và lương điều hành', async (progress) => {
      if (Object.keys({...validateProfitPerson(input.values.name, input.values.auth_user_id ?? ''), ...validateSalaryRules(input.rules)}).length) throw new FinancialWorkflowError('Kiểm tra tài khoản, tên và từng quy tắc lương trước khi lưu', 'failure', []);
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
          .select('*');
        if (error) throw error;
        requireProfitRows(data, [{ ...patch, id: input.id }]);
      } else {
        const { data, error } = await supabase
          .from("profit_managers")
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
          throw error;
        }
        managerId = requireAccountWriteReceipt(data, {}).id as string;
      }
      if (!managerId) throw new TypeError("Unconfirmed manager result");
      progress.completed.push({id:managerId,label:'Đã lưu hồ sơ quản lý'});
      progress.stage = 'thay quy tắc lương';

      // 2) Xoá toàn bộ quy tắc cũ (cascade buildings) rồi tạo lại.
      const { data: oldRules, error: oldError } = await supabase.from('profit_manager_salaries' as any).select('id').eq('manager_id', managerId);
      if (oldError) throw oldError;
      const expectedOldRules = requireProfitRows(oldRules).map(row => ({id: row.id}));
      const { data: deletedRules, error: delErr } = await supabase
        .from('profit_manager_salaries' as any)
        .delete()
        .eq('manager_id', managerId)
        .select('id');
      if (delErr) throw delErr;
      const deletedRows = requireProfitRows(deletedRules);
      for (const row of deletedRows) progress.completed.push({id:row.id as string,label:'Đã xóa quy tắc lương cũ'});
      requireProfitRows(deletedRows, expectedOldRules);

      // 3) Tạo quy tắc mới + tập nhà từng quy tắc.
      for (const rule of input.rules) {
        const buildings = (rule.building_ids || []).filter(Boolean);
        if (buildings.length === 0) throw new Error("Quy tắc chưa chọn nhà");
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
        const salaryId = (ruleRow as any)?.id;
        if (typeof salaryId !== 'string' || !salaryId) throw new TypeError('Unconfirmed salary rule result');
        progress.completed.push({id:salaryId,label:`Đã tạo quy tắc ${rule.label?.trim() || 'lương điều hành'}`});
        progress.stage = 'gán nhà cho quy tắc lương';
        const links = buildings.map((building_id) => ({ user_id: uid, salary_id: salaryId, building_id }));
        const { data: savedLinks, error: bErr } = await supabase
          .from('profit_manager_salary_buildings' as any)
          .insert(links)
          .select('id, user_id, salary_id, building_id');
        if (bErr) throw bErr;
        const linkRows = requireProfitRows(savedLinks);
        for (const row of linkRows) progress.completed.push({id:row.id as string,label:'Đã nhận dòng liên kết nhà cần đối chiếu'});
        requireProfitRows(linkRows, links);
        progress.stage = 'tạo quy tắc lương tiếp theo';
      }
      return {managerId};
    }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["profit-managers"] });
      qc.invalidateQueries({ queryKey: ["manager-salaries"] });
      toast.success("Đã lưu hồ sơ quản lý và toàn bộ quy tắc lương điều hành.");
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
        throw error;
      }
      const rows = requireProfitRows(data);
      if (!rows.length) return false;
      requireProfitRows(rows, [{id}]);
      return true;
    },
    onError: (error) => notifyActionError(error, "Chưa xóa quản lý điều hành."),
    onSuccess: (changed) => {
      qc.invalidateQueries({ queryKey: ["profit-managers"] });
      if (changed) toast.success('Đã xoá quản lý');
      else toast.info('Không có hồ sơ quản lý nào được thay đổi.');
    },
  });
};
