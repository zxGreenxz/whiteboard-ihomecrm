import { requireReadRows, requireReadRow, profitPersonRow, salaryRuleRow } from "@/lib/accountProfitReadModels";
import { useRef } from "react";
import { FinancialAlreadyRecordedError, FinancialWorkflowError, RepeatableWriteUnknownError, workflowErrorMessage } from "@/lib/financialWorkflow";
import { requireProfitRows } from "@/lib/profitConfigurationReceipt";
import { requireAccountWriteReceipt } from "@/lib/accountSettingsWriteReceipt";
import { validateProfitPerson, validateSalaryRules } from "@/lib/profitFeedback";
import { notifyActionError } from "@/lib/actionFeedback";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { getSessionUser } from "@/lib/authSession";
import { toast } from "sonner";
import { useOrganization } from "@/contexts/OrganizationContext";
import { withOrg, withOrgAll } from "@/lib/orgPayload";
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

// Quản lý ĐÃ XOÁ còn số (rà 21/10, F21): từ Đợt 2 Tổng quan đọc thẳng sổ lương điều hành (E10 giữ
// người đã xoá còn số dư / phiếu chờ duyệt, kèm tên) — không còn đọc riêng tên người đã nghỉ ở đây.

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

/** Nhãn bước «đã lưu hồ sơ quản lý» trong lỗi của lượt lưu: hộp lưu đọc mã hồ sơ vừa tạo từ bước này để lần bấm sau SỬA hồ sơ đó. */
export const PROFIT_MANAGER_SAVED_STEP = 'Đã lưu hồ sơ quản lý';

/**
 * Lượt lưu hỏng SAU khi hồ sơ quản lý đã ghi: giữ mã hồ sơ trong lỗi và nói đúng phần còn dở. Chưa rõ kết quả thì vẫn là
 * lỗi lặp lại được (không khoá); bị từ chối rõ thì nêu đã xoá quy tắc cũ hay chưa, để người dùng lưu lại.
 */
function managerSaveFailure(error: unknown, operation: string, managerId: string | undefined, rulesCleared: boolean): unknown {
  if (!managerId || error instanceof FinancialAlreadyRecordedError) return error;
  const saved = { id: managerId, label: PROFIT_MANAGER_SAVED_STEP };
  if (error instanceof RepeatableWriteUnknownError) return new RepeatableWriteUnknownError(operation, error.cause, [saved]);
  const done = rulesCleared ? `Đã lưu hồ sơ quản lý (mã ${managerId}) và xoá quy tắc lương cũ nhưng chưa ghi lại đủ quy tắc mới` : `Đã lưu hồ sơ quản lý (mã ${managerId}) nhưng chưa lưu xong quy tắc lương`;
  return new FinancialWorkflowError(`${done}: ${workflowErrorMessage(error, 'lưu quy tắc lương điều hành')} Bấm Lưu lại để ghi lại đúng bộ quy tắc này: hồ sơ sửa theo mã, quy tắc xoá rồi tạo lại cả bộ nên không nhân đôi.`, 'failure', [saved], error);
}

// Lưu 1 quản lý + toàn bộ quy tắc lương của họ. Quy tắc KHÔNG bị tham chiếu bởi
// snapshot (profit_manager_allocations gắn manager_id, không gắn rule id) → an toàn
// xoá-tạo lại toàn bộ quy tắc mỗi lần lưu (khỏi diff).
//
// Đợt 8 (sát tiền: quy tắc lương điều hành trừ vào lợi nhuận trước khi chia). SỬA (cách A): đặt hồ sơ theo mã, rồi xoá
// MỌI quy tắc của quản lý và tạo lại cả bộ, nên chạy lại cho đúng bộ quy tắc, kể cả khi lượt trước dở ở bất kỳ bước nào
// (quy tắc dở của lượt trước bị xoá cùng). THÊM (cách D): production có chỉ mục duy nhất `profit_managers(auth_user_id)`
// (toàn cục, đo 26/11/2026): tra hồ sơ của tài khoản trước khi chèn; đã có ⇒ báo mã, không tạo quản lý thứ hai. Không giữ
// dấu «chờ đối chiếu»; chưa rõ thì báo và cho lưu lại. Chưa nguyên tử (nhiều lệnh, không có duy nhất theo quy tắc): hai lượt
// cùng hồ sơ chạy song song có thể nhân đôi quy tắc ⇒ chặn bấm đúp trong bộ nhớ; hàm máy chủ nguyên tử thuộc đợt 10.
export const useSaveManagerWithSalaries = () => {
  const qc = useQueryClient();
  const { selectedOrganizationId } = useOrganization();
  const running = useRef(new Set<string>());
  return useMutation({
    meta: { handlesFeedback: true },
    mutationFn: async (input: {
      id?: string;
      values: ProfitManagerFormValues;
      rules: SalaryRuleInput[];
    }) => {
      const operation = 'lưu quản lý và lương điều hành';
      if (Object.keys({...validateProfitPerson(input.values.name, input.values.auth_user_id ?? ''), ...validateSalaryRules(input.rules)}).length) throw new FinancialWorkflowError('Kiểm tra tài khoản, tên và từng quy tắc lương trước khi lưu', 'failure', []);
      // Cùng khoá với dấu bản trước (`profit-manager-save`, công ty đang chọn).
      const key = input.id ?? `new:${input.values.auth_user_id ?? ''}`;
      if (running.current.has(key)) throw new FinancialWorkflowError(`Yêu cầu ${operation} đang được xử lý. Chờ kết quả trước khi lưu tiếp.`, 'failure', []);
      running.current.add(key);
      // Mã hồ sơ đã xác nhận ghi ở lượt này, và lượt này đã xoá quy tắc cũ chưa: để lỗi nói đúng phần còn dở.
      let managerId: string | undefined;
      let rulesCleared = false;
      try {
        const user = await getSessionUser();
        if (!user) throw { code: 'PGRST301', message: 'Not authenticated' };
        const uid = user.id;
        const { repeatableWrite, settleZeroRowDelete } = await import('@/lib/recordWriteOutcome');
        const result = await repeatableWrite(operation, async () => {
          // 1) Sửa hoặc thêm hồ sơ quản lý
          // Công ty của hồ sơ quản lý vừa ghi/sửa — quy tắc lương và liên kết nhà dùng đúng công ty này.
          let managerOrg: string | null | undefined;
          if (input.id) {
            const patch: any = {
              name: input.values.name,
              note: input.values.note ?? null,
              is_active: input.values.is_active ?? true,
            };
            if (input.values.auth_user_id !== undefined) patch["auth_user_id"] = input.values.auth_user_id;
            const { data, error } = await supabase
              .from("profit_managers" as any)
              .update(patch)
              .eq("id", input.id)
              .select('*');
            if (error) throw error;
            // Khớp 0 dòng (RLS, hồ sơ đã mất): chưa ghi gì, không đụng quy tắc lương.
            if (Array.isArray(data) && data.length === 0) throw new FinancialWorkflowError('Chưa lưu hồ sơ quản lý điều hành: không tìm thấy hồ sơ này, hoặc tài khoản không có quyền sửa. Tải lại danh sách quản lý rồi thử lại.', 'failure', []);
            requireProfitRows(data, [{ ...patch, id: input.id }]);
            managerOrg = (data as unknown as Array<{ organization_id?: string | null }> | null)?.[0]?.organization_id;
            managerId = input.id;
          } else {
            const account = input.values.auth_user_id ?? null;
            const { data: existing, error: lookupError } = await supabase
              .from("profit_managers")
              .select("id")
              .eq("auth_user_id", account ?? '')
              .is("deleted_at", null)
              .maybeSingle();
            if (lookupError) throw lookupError;
            if (existing !== null) {
              const existingId: unknown = existing?.id;
              if (typeof existingId !== 'string' || !existingId) throw new TypeError('Unconfirmed manager lookup');
              throw new FinancialAlreadyRecordedError(`Tài khoản này đã có hồ sơ quản lý điều hành (mã ${existingId}), có thể từ lần lưu trước. Đóng hộp này và mở hồ sơ đó để sửa quy tắc lương; không tạo thêm quản lý.`, [existingId]);
            }
            const { data, error } = await supabase
              .from("profit_managers")
              .insert(withOrg({
                user_id: uid,
                name: input.values.name,
                note: input.values.note ?? null,
                is_active: input.values.is_active ?? true,
                auth_user_id: account,
              }, selectedOrganizationId))
              .select("id, organization_id")
              .single();
            if (error) {
              throw error;
            }
            managerId = requireAccountWriteReceipt(data, {}).id as string;
            managerOrg = (data as { organization_id?: string | null } | null)?.organization_id;
          }
          if (!managerId) throw new TypeError("Unconfirmed manager result");
          const savedManagerId = managerId;

          // 2) Xoá toàn bộ quy tắc cũ (cascade buildings) rồi tạo lại.
          const { data: oldRules, error: oldError } = await supabase.from('profit_manager_salaries' as any).select('id').eq('manager_id', savedManagerId);
          if (oldError) throw oldError;
          const expectedOldRules = requireProfitRows(oldRules).map(row => row.id as string);
          const { data: deletedRules, error: delErr } = await supabase
            .from('profit_manager_salaries' as any)
            .delete()
            .eq('manager_id', savedManagerId)
            .select('id');
          if (delErr) throw delErr;
          const deletedIds = requireProfitRows(deletedRules).map(row => row.id as string);
          if (deletedIds.length) rulesCleared = true;
          // Xoá thiếu dòng đã đọc: dòng đó đã bị xoá ở nơi khác (đúng đích) hoặc RLS không cho xoá (từ chối rõ, không chèn tiếp).
          const missing = expectedOldRules.filter(id => !deletedIds.includes(id));
          if (missing.length) await settleZeroRowDelete('xoá quy tắc lương cũ', () => supabase.from('profit_manager_salaries').select('id').in('id', missing));

          // 3) Tạo quy tắc mới + tập nhà từng quy tắc.
          for (const rule of input.rules) {
            const buildings = (rule.building_ids || []).filter(Boolean);
            if (buildings.length === 0) throw new Error("Quy tắc chưa chọn nhà");
            const { data: ruleRow, error: rErr } = await supabase
              .from("profit_manager_salaries" as any)
              .insert(withOrg({
                user_id: uid,
                manager_id: savedManagerId,
                label: rule.label?.trim() || null,
                form: rule.form,
                basis: rule.basis,
                amount: rule.form === "FIXED" ? Math.max(0, rule.amount || 0) : 0,
                percent: rule.form === "PERCENT" ? Math.max(0, Math.min(100, rule.percent || 0)) : 0,
                is_active: true,
              }, managerOrg))
              .select("id")
              .single();
            if (rErr) throw rErr;
            const salaryId = (ruleRow as any)?.id;
            if (typeof salaryId !== 'string' || !salaryId) throw new TypeError('Unconfirmed salary rule result');
            const links = buildings.map((building_id) => ({ user_id: uid, salary_id: salaryId, building_id }));
            const { data: savedLinks, error: bErr } = await supabase
              .from('profit_manager_salary_buildings' as any)
              .insert(withOrgAll(links, managerOrg))
              .select('id, user_id, salary_id, building_id');
            if (bErr) throw bErr;
            requireProfitRows(savedLinks, links);
          }
          return {managerId: savedManagerId};
        });
        try { const { forgetLegacyPending } = await import('@/lib/legacyPendingExit'); await forgetLegacyPending({ namespace: 'profit-manager-save', businessKey: key }); }
        catch { /* Dấu bản trước không còn chặn gì; gỡ hỏng thì lần lưu sau gỡ lại. */ }
        return result;
      } catch (error) {
        // Lần tạo trước đã ghi (tra theo tài khoản thấy hồ sơ): báo mã và gỡ dấu bản trước, không tạo lần mới (luật 4).
        if (error instanceof FinancialAlreadyRecordedError) {
          try { const { forgetLegacyPending } = await import('@/lib/legacyPendingExit'); await forgetLegacyPending({ namespace: 'profit-manager-save', businessKey: key }); }
          catch { /* Gỡ hỏng thì lần lưu sau gỡ lại. */ }
          qc.invalidateQueries({ queryKey: ["profit-managers"] });
        }
        throw managerSaveFailure(error, operation, managerId, rulesCleared);
      } finally {
        running.current.delete(key);
      }
    },
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
