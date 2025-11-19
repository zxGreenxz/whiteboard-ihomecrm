import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import type { Database } from "@/integrations/supabase/types";
import { toast } from "sonner";

type Tenant = Database["public"]["Tables"]["tenants"]["Row"];
type TenantInsert = Database["public"]["Tables"]["tenants"]["Insert"];
type TenantUpdate = Database["public"]["Tables"]["tenants"]["Update"];

// Fetch all tenants
export const useTenants = () => {
  return useQuery({
    queryKey: ["tenants"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("tenants")
        .select("*")
        .is("deleted_at", null)
        .order("created_at", { ascending: false });

      if (error) {
        toast.error("Không thể tải danh sách khách thuê");
        throw error;
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
        toast.error("Không thể tải thông tin khách thuê");
        throw error;
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
      const {
        data: { user },
      } = await supabase.auth.getUser();

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
          toast.error("Không thể tạo khách thuê");
        }
        throw error;
      }

      return data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["tenants"] });
      toast.success("Tạo khách thuê thành công");
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
          toast.error("Không thể cập nhật khách thuê");
        }
        throw error;
      }

      return data;
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["tenants"] });
      queryClient.invalidateQueries({ queryKey: ["tenants", data.id] });
      toast.success("Cập nhật khách thuê thành công");
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
      // TODO: Check if tenant has active contracts
      // Soft delete
      const { data, error } = await supabase
        .from("tenants")
        .update({ deleted_at: new Date().toISOString() })
        .eq("id", id)
        .select()
        .single();

      if (error) {
        toast.error("Không thể xóa khách thuê");
        throw error;
      }

      return data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["tenants"] });
      toast.success("Xóa khách thuê thành công");
    },
    onError: (error) => {
      console.error("Error deleting tenant:", error);
    },
  });
};
