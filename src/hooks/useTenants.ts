import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { getSessionUser } from "@/lib/authSession";
import { fetchAllRows } from "@/lib/supabaseFetchAll";
import type { Database } from "@/integrations/supabase/types";
import { toast } from "sonner";
import type { PaginatedData } from "@/hooks/usePagination";
import { ACTIVE_CONTRACT_STATUSES } from "@/types/contract";
import { nullIfNotFound } from "@/hooks/readErrors";

type Tenant = Database["public"]["Tables"]["tenants"]["Row"];
type TenantInsert = Database["public"]["Tables"]["tenants"]["Insert"];
type TenantUpdate = Database["public"]["Tables"]["tenants"]["Update"];

export interface TenantFilters {
  status?: string;
  search?: string;
}

export interface TenantPaginationParams {
  page?: number;
  pageSize?: number;
}

// Fetch all tenants (with optional pagination)
export const useTenants = (
  filters?: TenantFilters,
  pagination?: TenantPaginationParams
) => {
  return useQuery({
    queryKey: ["tenants", filters, pagination],
    queryFn: async (): Promise<PaginatedData<Tenant>> => {
      // `created_at` không duy nhất → tiebreaker `id`, bắt buộc cho cả hai nhánh:
      // phân trang theo trang (trang 2 không được lặp dòng của trang 1) lẫn
      // fetch-all (ranh giới trang không sót/trùng).
      //
      // `count: 'exact'` CHỈ xin ở nhánh phân trang. Xin nó ở mọi trang của
      // nhánh fetch-all nghĩa là chạy lại một COUNT(*) trên toàn bộ tập lọc cho
      // từng trang — phần đắt nhất của câu lệnh, lặp lại mà không dùng đến.
      const buildQuery = (from: number, to: number, kemCount: boolean) => {
        let query = supabase
          .from("tenants")
          .select("*", kemCount ? { count: 'exact' } : undefined)
          .is("deleted_at", null)
          .order("created_at", { ascending: false })
          .order("id", { ascending: false });

        if (filters?.status) {
          query = query.eq('status', filters.status as any);
        }

        return query.range(from, to);
      };

      // Caller có phân trang → giữ nguyên một request đúng cửa sổ + count exact.
      if (pagination?.page && pagination?.pageSize) {
        const offset = (pagination.page - 1) * pagination.pageSize;
        const { data, error, count } = await buildQuery(offset, offset + pagination.pageSize - 1, true);

        if (error) {
          console.error('useTenants error:', error);
          return { data: [], count: 0 };
        }

        return { data: data || [], count: count || 0 };
      }

      // Không phân trang → lấy ĐỦ. Trước đây request trần bị PostgREST cắt ở
      // 1000 khách mà `count` vẫn trả tổng thật, nên giao diện hiện "1.2xx khách"
      // bên trên một danh sách chỉ có 1000 dòng — lệch mà không có lỗi nào.
      const rows = await fetchAllRows<Tenant>((from, to) => buildQuery(from, to, false), { label: "tenants" });

      if (rows === null) {
        // fetchAllRows tra null = loi query (da console.error). Nem de vao isError;
        // tra { data: [], count: 0 } = "khong co khach nao" (Contract 14, plan C).
        throw new Error('useTenants: khong tai duoc du lieu');
      }

      return { data: rows, count: rows.length };
    },
  });
};

// Legacy hook for backwards compatibility (returns array directly)
// options.enabled: dialog mounted-sẵn (CreateDepositDialog) gate fetch khi đóng.
export const useTenantsLegacy = (options?: { enabled?: boolean }) => {
  return useQuery({
    enabled: options?.enabled ?? true,
    queryKey: ["tenants-legacy"],
    queryFn: async (): Promise<Tenant[]> => {
      const rows = await fetchAllRows<Tenant>((from, to) =>
        supabase
          .from("tenants")
          .select("*")
          .is("deleted_at", null)
          .order("created_at", { ascending: false })
          .order("id", { ascending: false })
          .range(from, to),
        { label: "tenants-legacy" },
      );

      if (rows === null) {
        // fetchAllRows tra null = loi query (da console.error). Nem de vao isError,
        // khong bien loi thanh danh sach rong (Contract 14, plan C).
        throw new Error('useTenantsLegacy: khong tai duoc du lieu');
      }

      return rows;
    },
  });
};

// Fetch single tenant by ID
export const useTenant = (id: string) => {
  return useQuery({
    queryKey: ["tenants", id],
    queryFn: async () => {
      const { data, error} = await supabase
        .from("tenants")
        .select("*")
        .eq("id", id)
        .is("deleted_at", null)
        .single();

      if (error) return nullIfNotFound(error, "useTenant");

      return data;
    },
    enabled: !!id,
  });
};

// Create new tenant
export const useCreateTenant = () => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (tenant: Omit<TenantInsert, "user_id">) => {
      const user = await getSessionUser();

      if (!user) {
        throw new Error("User not authenticated");
      }

      const { data, error } = await supabase
        .from("tenants")
        .insert({
          ...tenant,
          user_id: user.id,
        })
        .select()
        .single();

      if (error) {
        if (error.code === "23505") {
          toast.error("Số điện thoại hoặc CCCD đã tồn tại");
        } else {
          toast.error("Không thể tạo khách hàng");
        }
        throw error;
      }

      return data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["tenants"] });
      toast.success("Dữ liệu đã được TẠO thành công");
    },
    onError: (error) => {
      console.error("Error creating tenant:", error);
    },
  });
};

// Update existing tenant
export const useUpdateTenant = () => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({
      id,
      updates,
    }: {
      id: string;
      updates: TenantUpdate;
    }) => {
      const { data, error } = await supabase
        .from("tenants")
        .update(updates)
        .eq("id", id)
        .select()
        .single();

      if (error) {
        if (error.code === "23505") {
          toast.error("Số điện thoại hoặc CCCD đã tồn tại");
        } else {
          toast.error("Không thể cập nhật khách hàng");
        }
        throw error;
      }

      return data;
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["tenants"] });
      queryClient.invalidateQueries({ queryKey: ["tenants", data.id] });
      toast.success("Dữ liệu đã được CẬP NHẬT thành công");
    },
    onError: (error) => {
      console.error("Error updating tenant:", error);
    },
  });
};

// Soft delete tenant
export const useDeleteTenant = () => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (id: string) => {
      // Chặn xoá khách đang có hợp đồng hiệu lực (đường legacy contracts.tenant_id;
      // HĐ mới đi contract_customers → xem useDeleteCustomer).
      const { data: activeContracts, error: checkError } = await supabase
        .from("contracts")
        .select("id")
        .eq("tenant_id", id)
        .in("status", ACTIVE_CONTRACT_STATUSES)
        .is("deleted_at", null)
        .limit(1);
      if (checkError) {
        toast.error("Không kiểm tra được hợp đồng của khách hàng");
        throw checkError;
      }
      if (activeContracts && activeContracts.length > 0) {
        toast.error("Không thể xóa khách hàng đang có hợp đồng hiệu lực");
        throw new Error("Tenant has active contracts");
      }

      // Soft delete
      const { error } = await supabase
        .from("tenants")
        .update({ deleted_at: new Date().toISOString() })
        .eq("id", id);

      if (error) {
        toast.error("Không thể xóa khách hàng");
        throw error;
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["tenants"] });
      toast.success("Dữ liệu đã được XÓA thành công");
    },
    onError: (error) => {
      console.error("Error deleting tenant:", error);
    },
  });
};
