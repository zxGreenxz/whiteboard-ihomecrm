function feedbackRecordName(value:unknown,fallback?:string):string {
 const row=value&&typeof value==='object'?value as {name?:unknown;id?:unknown}:null;
 return typeof row?.name==='string'&&row.name.trim()?row.name: fallback?.trim()||(typeof row?.id==='string'?row.id:'bản ghi');
}
import {useOrganization} from '@/contexts/OrganizationContext';
import {withOrg} from '@/lib/orgPayload';
import { persistentFinancialWorkflow } from '@/lib/persistentFinancialWorkflow';
import { FinancialWorkflowError } from '@/lib/financialWorkflow';
import { confirmedRecordId, recordWriteMessage } from '@/lib/recordWriteOutcome';
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { getSessionUser } from "@/lib/authSession";
import { invalidateIeTypesCache } from "@/lib/ieTypesCache";
import { toast } from "sonner";
import { friendlyError } from "@/lib/friendlyError";

// --- Types ---

export interface IncomeExpenseType {
  id: string;
  user_id: string;
  name: string;
  type: "income" | "expense";
  category: string | null;
  description: string | null;
  is_default: boolean;
  // Cờ "đây có phải loại Tiền cọc" — bật → ảnh hưởng contracts.deposit_paid
  // và stats "Cọc đã thu". Set DB-side, FE chỉ đọc.
  is_deposit: boolean;
  // Cờ "hạng mục hạn chế": bật → chỉ người có quyền income_expenses.restricted_*
  // mới thấy hạng mục (picker) và các phiếu thuộc hạng mục này (bảng + tổng).
  // RLS enforce; FE thêm lọc picker theo restricted_create.
  is_restricted: boolean;
  // Cờ "hạng mục đặc biệt": bật → cho phép ẩn các dòng thuộc hạng mục này khỏi
  // danh sách báo cáo Phân bổ lợi nhuận (tuỳ chọn FE, KHÔNG đụng RLS/số tổng).
  hide_in_report: boolean;
  // NULL trên dữ liệu cũ chưa backfill; row mới do trigger trg_autofill_org gắn.
  organization_id: string | null;
  created_at: string;
  updated_at: string;
}

/**
 * Lọc hạng mục về đúng tổ chức của user TRƯỚC khi dedup theo tên.
 *
 * Án lệ 07/08/2026: RLS select trên income_expense_types chỉ check capability
 * toàn cục (can_access_org_entity không so organization_id) nên client thấy
 * hạng mục của MỌI org. Hai org seed cùng lúc đều có "Vệ Sinh Phòng"
 * (created_at giống hệt) → dedup bốc ngẫu nhiên id của org khác →
 * create_income_expense_v1 từ chối 42501 "Loại hạng mục 1 không thuộc tổ
 * chức hoặc sai chiều thu/chi", lỗi chập chờn theo thứ tự DB trả về.
 *
 * myOrgIds rỗng (rpc my_org_ids lỗi/chưa có) → không lọc để khỏi trắng
 * dropdown; dedup ưu tiên ownership vẫn chạy như cũ.
 */
export function selectIeTypeRowsForOrgs(
  rows: IncomeExpenseType[],
  currentUserId: string | null,
  myOrgIds: string[],
): IncomeExpenseType[] {
  const scoped = myOrgIds.length
    ? rows.filter(
        (r) => r.organization_id == null || myOrgIds.includes(r.organization_id),
      )
    : rows;

  const ownershipRank = (r: IncomeExpenseType) =>
    currentUserId && r.user_id === currentUserId ? 0 : 1;
  const sorted = [...scoped].sort((a, b) => {
    const diff = ownershipRank(a) - ownershipRank(b);
    if (diff !== 0) return diff;
    return (a.created_at ?? "").localeCompare(b.created_at ?? "");
  });

  const seen = new Map<string, IncomeExpenseType>();
  for (const row of sorted) {
    const key = `${row.type}::${row.name.trim().toLowerCase()}`;
    if (!seen.has(key)) seen.set(key, row);
  }

  return Array.from(seen.values()).sort((a, b) =>
    a.name.localeCompare(b.name, "vi", { sensitivity: "base" })
  );
}

// my_org_ids() là SECURITY DEFINER đã grant authenticated (xem useMyOrgIds ở
// useNotificationSettings.ts).
//
// Lỗi thì THROW, không trả []. Trước đây trả [] để "khỏi trắng dropdown", nhưng
// [] ở đây nghĩa là "không biết org nào" và selectIeTypeRowsForOrgs bỏ lọc —
// tức một lỗi RPC nhất thời mở đúng cánh cửa mà án lệ 07/08/2026 đóng lại: hạng
// mục của org khác lọt vào picker rồi create_income_expense_v1 từ chối 42501.
// Fail-closed: thà màn hình báo lỗi còn hơn đưa lựa chọn của công ty khác.
async function fetchMyOrgIds(): Promise<string[]> {
  const { data, error } = await supabase.rpc("my_org_ids");
  if (error) {
    console.error("useIncomeExpenseTypes my_org_ids error:", error);
    throw error;
  }
  if (!Array.isArray(data)) throw new Error('Chưa xác nhận được tổ chức của bạn. Tải lại hạng mục thu chi trước khi chọn.');
  return (data as string[]).filter(Boolean);
}

// --- Query Hooks ---

// Loại thu chi gần như không đổi trong phiên → staleTime dài để các component
// remount (form/dialog/filter) không refetch lại, đỡ request trên instance nhỏ.
const IE_TYPES_STALE_TIME = 5 * 60_000;

export const useIncomeExpenseTypes = (
  filterType?: "income" | "expense",
  options?: { enabled?: boolean }
) => {
  return useQuery({
    enabled: options?.enabled ?? true,
    staleTime: IE_TYPES_STALE_TIME,
    queryKey: ["income-expense-types", filterType],
    queryFn: async (): Promise<IncomeExpenseType[]> => {
      // DB canonical theo (organization, type, normalized name). Giữ dedup
      // client-side trong giai đoạn rollout để phiên đang mở trước migration
      // không nháy dòng trùng; đây không còn là nguồn bảo đảm tính duy nhất.
      const [user, myOrgIds] = await Promise.all([
        getSessionUser(),
        fetchMyOrgIds(),
      ]);
      const currentUserId = user?.id ?? null;

      let query = supabase
        .from("income_expense_types" as any)
        .select("*")
        .order("name", { ascending: true });

      if (filterType) {
        query = query.eq("type", filterType);
      }

      const { data, error } = await query;

      if (error) {
        console.error("useIncomeExpenseTypes error:", error);
        throw error;
      }

      if (!Array.isArray(data)) throw new Error('Chưa xác nhận được danh sách loại thu chi. Tải lại trước khi chọn.');
      const rows = data as unknown as IncomeExpenseType[];
      return selectIeTypeRowsForOrgs(rows, currentUserId, myOrgIds);
    },
  });
};

/**
 * Distinct, non-null categories cho user hiện tại (lọc theo type nếu truyền).
 * Dùng cho combobox gom nhóm trong form Thêm/Sửa loại thu chi.
 */
export const useIncomeExpenseTypeCategories = (
  filterType?: "income" | "expense"
) => {
  return useQuery({
    staleTime: IE_TYPES_STALE_TIME,
    queryKey: ["income-expense-type-categories", filterType],
    queryFn: async (): Promise<string[]> => {
      // Categories cũng dùng chung — không filter theo user_id (xem hook
      // useIncomeExpenseTypes phía trên), nhưng phải lọc org vì RLS đang cho
      // thấy cross-org (cùng án lệ 07/08/2026 ở selectIeTypeRowsForOrgs).
      const myOrgIds = await fetchMyOrgIds();
      let query = supabase
        .from("income_expense_types" as any)
        .select("category, organization_id")
        .not("category", "is", null);

      if (filterType) {
        query = query.eq("type", filterType);
      }

      const { data, error } = await query;
      if (error) {
        console.error("useIncomeExpenseTypeCategories error:", error);
        throw error;
      }

      if (!Array.isArray(data)) throw new Error('Chưa xác nhận được nhóm loại thu chi. Tải lại trước khi chọn.');
      const set = new Set<string>();
      for (const row of data as unknown as Array<{
        category: string | null;
        organization_id: string | null;
      }>) {
        if (
          myOrgIds.length &&
          row.organization_id != null &&
          !myOrgIds.includes(row.organization_id)
        ) {
          continue;
        }
        const c = (row.category ?? "").trim();
        if (c) set.add(c);
      }
      return Array.from(set).sort((a, b) =>
        a.localeCompare(b, "vi", { sensitivity: "base" })
      );
    },
  });
};

/**
 * Các hạng mục được đánh dấu "đặc biệt" (hide_in_report=true). DB canonical bảo
 * đảm một ID cho mỗi tên trong tổ chức; báo cáo vẫn khớp thêm theo tên để tương
 * thích cache/phiên cũ trong giai đoạn rollout.
 */
export const useHiddenInReportTypes = () => {
  return useQuery({
    staleTime: IE_TYPES_STALE_TIME,
    queryKey: ["ie-types-hidden-in-report"],
    queryFn: async (): Promise<{ id: string; name: string }[]> => {
      const { data, error } = await supabase
        .from("income_expense_types" as any)
        .select("id, name")
        .eq("hide_in_report", true);
      if (error) {
        console.error("useHiddenInReportTypes error:", error);
        throw error;
      }
      if (!Array.isArray(data)) throw new Error('Chưa xác nhận được loại thu chi trong báo cáo. Tải lại trước khi xem.');
      return (data as any[]).map((r) => ({ id: r.id, name: r.name ?? "" }));
    },
  });
};

// --- Mutation Hooks ---

export const useCreateIncomeExpenseType = () => {
  const queryClient = useQueryClient();
  const {selectedOrganizationId}=useOrganization();

  return useMutation({
    mutationFn: async (input: {
      name: string;
      type: "income" | "expense";
      category?: string | null;
      description?: string | null;
      is_default?: boolean;
      is_restricted?: boolean;
      hide_in_report?: boolean;
    }) => {
      const user = await getSessionUser();

      if (!user) throw new Error("User not authenticated");

      // Trigger strict yêu cầu tổ chức được chọn trong payload; không suy từ toà.
      return persistentFinancialWorkflow('income-expense-type-create').run('create', 'tạo loại thu chi', async () => {
      const { data, error } = await supabase
        .from("income_expense_types" as any)
        .insert(withOrg({
          user_id: user.id,
          name: input.name,
          type: input.type,
          category: input.category ?? null,
          description: input.description ?? null,
          is_default: input.is_default ?? false,
          is_restricted: input.is_restricted ?? false,
          hide_in_report: input.hide_in_report ?? false,
        },selectedOrganizationId))
        .select()
        .single();

      if (error) throw error;
      const created = data as unknown as { id?: string; name?: string } | null;
      if (!created?.id || created.name !== input.name) {
        throw new FinancialWorkflowError('Chưa xác nhận được loại thu chi vừa tạo. Giữ bản nháp và đối chiếu danh sách trước khi tạo tiếp.', 'unknown', created?.id ? [{id:created.id,label:'Loại thu chi cần đối chiếu'}] : []);
      }
      return data;
      },undefined,selectedOrganizationId);
    },
    onSuccess: (data) => {
      invalidateIeTypesCache();
      queryClient.invalidateQueries({ queryKey: ["income-expense-types"] });
      queryClient.invalidateQueries({
        queryKey: ["income-expense-type-categories"],
      });
      toast.success(`Đã tạo loại thu chi ${feedbackRecordName(data)}`);
    },
    onError: (error) => {
      invalidateIeTypesCache();
      queryClient.invalidateQueries({queryKey:['income-expense-types']});
      queryClient.invalidateQueries({queryKey:['income-expense-type-categories']});
      if (error instanceof FinancialWorkflowError) { toast.error('Chưa tạo được loại thu chi', {description:recordWriteMessage(error, 'tạo loại thu chi')}); return; }
      const feedback = friendlyError(error, "Chưa tạo được loại thu chi", { operation: "tạo loại thu chi" });
      toast.error(feedback.title, { description: feedback.description });
      console.error("Error creating income expense type:", error);
    },
  });
};

export const useUpdateIncomeExpenseType = () => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({
      id,
      updates,
    }: {
      id: string;
      updates: {
        name?: string;
        type?: "income" | "expense";
        category?: string | null;
        description?: string | null;
        is_default?: boolean;
        is_restricted?: boolean;
        hide_in_report?: boolean;
      };
    }) => {
      return persistentFinancialWorkflow('income-expense-type-update').run(id, 'cập nhật loại thu chi', async () => {
      const { data, error } = await supabase
        .from("income_expense_types" as any)
        .update(updates)
        .eq("id", id)
        .select()
        .single();

      if (error) throw error;
      confirmedRecordId(data, 'cập nhật loại thu chi', id);
      return data;
      });
    },
    onSuccess: (data) => {
      invalidateIeTypesCache();
      queryClient.invalidateQueries({ queryKey: ["income-expense-types"] });
      queryClient.invalidateQueries({
        queryKey: ["income-expense-type-categories"],
      });
      toast.success(`Đã cập nhật loại thu chi ${feedbackRecordName(data)}`);
    },
    onError: (error) => {
      invalidateIeTypesCache();
      queryClient.invalidateQueries({queryKey:['income-expense-types']});
      queryClient.invalidateQueries({queryKey:['income-expense-type-categories']});
      if (error instanceof FinancialWorkflowError) { toast.error('Chưa cập nhật được loại thu chi', {description:recordWriteMessage(error, 'cập nhật loại thu chi')}); return; }
      const feedback = friendlyError(error, "Chưa cập nhật được loại thu chi", { operation: "cập nhật loại thu chi" });
      toast.error(feedback.title, { description: feedback.description });
      console.error("Error updating income expense type:", error);
    },
  });
};

export const useDeleteIncomeExpenseType = () => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (id: string) => {
      // Check if type is being used by income_expense_items
      const { data: usageCheck, error: usageError } = await supabase
        .from("income_expense_items" as any)
        .select("id")
        .eq("income_expense_type_id", id)
        .limit(1);

      if (usageError) {
        console.error("Error checking type usage:", usageError);
        throw usageError;
      }

      if (!Array.isArray(usageCheck)) throw new Error('Chưa kiểm tra được phiếu đang dùng loại thu chi. Tải lại trước khi xóa.');
      if (usageCheck.length > 0) {
        throw new Error(
          "Không thể xoá loại thu chi đang được sử dụng bởi phiếu thu/chi"
        );
      }

      return persistentFinancialWorkflow('income-expense-type-delete').run(id, 'xoá loại thu chi', async () => {
      const { data, error } = await supabase
        .from("income_expense_types" as any)
        .delete()
        .eq("id", id)
        .select('id,name')
        .single();

      if (error) {
        throw error;
      }
      confirmedRecordId(data, 'xoá loại thu chi', id);
      return data;
      });
    },
    onSuccess: (data) => {
      invalidateIeTypesCache();
      queryClient.invalidateQueries({ queryKey: ["income-expense-types"] });
      queryClient.invalidateQueries({
        queryKey: ["income-expense-type-categories"],
      });
      toast.success(`Đã xóa loại thu chi ${feedbackRecordName(data)}`);
    },
    onError: (error) => {
      invalidateIeTypesCache();
      queryClient.invalidateQueries({queryKey:['income-expense-types']});
      queryClient.invalidateQueries({queryKey:['income-expense-type-categories']});
      if (error instanceof FinancialWorkflowError) { toast.error('Chưa xóa được loại thu chi', {description:recordWriteMessage(error, 'xóa loại thu chi')}); return; }
      const feedback = friendlyError(error, "Chưa xóa được loại thu chi", { operation: "xóa loại thu chi", rules: [{ message: "Không thể xoá loại thu chi đang được sử dụng bởi phiếu thu/chi", description: "Loại thu chi đang được dùng trong phiếu thu/chi. Kiểm tra phiếu liên quan trước khi xóa." }] });
      toast.error(feedback.title, { description: feedback.description });
      console.error("Error deleting income expense type:", error);
    },
  });
};
