import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { getSessionUser } from "@/lib/authSession";
import type { Database } from "@/integrations/supabase/types";
import { toast } from "sonner";
import type { PaginatedData } from "@/hooks/usePagination";
import { ACTIVE_CONTRACT_STATUSES } from "@/types/contract";

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
      let query = supabase
        .from("tenants")
        .select("*", { count: 'exact' })
        .is("deleted_at", null)
        .order("created_at", { ascending: false });

      if (filters?.status) {
        query = query.eq('status', filters.status as any);
      }

      // Apply pagination if provided
      if (pagination?.page && pagination?.pageSize) {
        const offset = (pagination.page - 1) * pagination.pageSize;
        query = query.range(offset, offset + pagination.pageSize - 1);
      }

      const { data, error, count } = await query;

      if (error) {
        console.error('useTenants error:', error);
        return { data: [], count: 0 };
      }

      return {
        data: data || [],
        count: count || 0
      };
    },
  });
};

// Legacy hook for backwards compatibility (returns array directly)
export const useTenantsLegacy = () => {
  return useQuery({
    queryKey: ["tenants-legacy"],
    queryFn: async (): Promise<Tenant[]> => {
      const { data, error } = await supabase
        .from("tenants")
        .select("*")
        .is("deleted_at", null)
        .order("created_at", { ascending: false });

      if (error) {
        console.error('useTenantsLegacy error:', error);
        return [];
      }

      return data || [];
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

      if (error) {
        console.error('useTenant error:', error);
        return null;
      }

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
