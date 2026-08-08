import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { getSessionUser } from "@/lib/authSession";
import { invalidateIeTypesCache } from "@/lib/ieTypesCache";
import { incomeExpenseTypeErrorMessage } from "@/lib/incomeExpenseTypeErrors";
import { toast } from "sonner";

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
// useNotificationSettings.ts). Lỗi → [] và selectIeTypeRowsForOrgs bỏ lọc.
async function fetchMyOrgIds(): Promise<string[]> {
  const { data, error } = await supabase.rpc("my_org_ids");
  if (error) {
    console.error("useIncomeExpenseTypes my_org_ids error:", error);
    return [];
  }
  return Array.isArray(data) ? (data as string[]).filter(Boolean) : [];
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
        return [];
      }

      const rows = (data ?? []) as unknown as IncomeExpenseType[];
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
        return [];
      }

      const set = new Set<string>();
      for (const row of (data ?? []) as unknown as Array<{
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
        return [];
      }
      return ((data ?? []) as any[]).map((r) => ({ id: r.id, name: r.name ?? "" }));
    },
  });
};

// --- Mutation Hooks ---

export const useCreateIncomeExpenseType = () => {
  const queryClient = useQueryClient();

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

      // organization_id do DB tự gắn (trigger trg_autofill_org trên
      // income_expense_types, thêm 27/07/2026). ĐỪNG đoán org ở client: màn
      // Thu/Chi cho chọn mọi toà khi có income_expenses.all_buildings nên client
      // không đọc được buildings.organization_id qua RLS. Trước khi có trigger,
      // hạng mục tạo ở đây sinh ra với organization_id = NULL → create_income_
      // expense_v1 từ chối 42501 → phiếu rơi sang compat và kẹt "Chờ duyệt".
      const { data, error } = await supabase
        .from("income_expense_types" as any)
        .insert({
          user_id: user.id,
          name: input.name,
          type: input.type,
          category: input.category ?? null,
          description: input.description ?? null,
          is_default: input.is_default ?? false,
          is_restricted: input.is_restricted ?? false,
          hide_in_report: input.hide_in_report ?? false,
        })
        .select()
        .single();

      if (error) {
        toast.error(
          incomeExpenseTypeErrorMessage(error, "Không thể tạo loại thu chi"),
        );
        throw error;
      }

      return data;
    },
    onSuccess: () => {
      invalidateIeTypesCache();
      queryClient.invalidateQueries({ queryKey: ["income-expense-types"] });
      queryClient.invalidateQueries({
        queryKey: ["income-expense-type-categories"],
      });
      toast.success("Loại thu chi đã được TẠO thành công");
    },
    onError: (error) => {
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
      const { data, error } = await supabase
        .from("income_expense_types" as any)
        .update(updates)
        .eq("id", id)
        .select()
        .single();

      if (error) {
        toast.error(
          incomeExpenseTypeErrorMessage(error, "Không thể cập nhật loại thu chi"),
        );
        throw error;
      }

      return data;
    },
    onSuccess: () => {
      invalidateIeTypesCache();
      queryClient.invalidateQueries({ queryKey: ["income-expense-types"] });
      queryClient.invalidateQueries({
        queryKey: ["income-expense-type-categories"],
      });
      toast.success("Loại thu chi đã được CẬP NHẬT thành công");
    },
    onError: (error) => {
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

      if (usageCheck && usageCheck.length > 0) {
        toast.error(
          "Không thể xoá loại thu chi đang được sử dụng bởi phiếu thu/chi"
        );
        throw new Error(
          "Không thể xoá loại thu chi đang được sử dụng bởi phiếu thu/chi"
        );
      }

      const { error } = await supabase
        .from("income_expense_types" as any)
        .delete()
        .eq("id", id);

      if (error) {
        toast.error(error.message || "Không thể xoá loại thu chi");
        throw error;
      }
    },
    onSuccess: () => {
      invalidateIeTypesCache();
      queryClient.invalidateQueries({ queryKey: ["income-expense-types"] });
      queryClient.invalidateQueries({
        queryKey: ["income-expense-type-categories"],
      });
      toast.success("Loại thu chi đã được XOÁ thành công");
    },
    onError: (error) => {
      console.error("Error deleting income expense type:", error);
    },
  });
};
