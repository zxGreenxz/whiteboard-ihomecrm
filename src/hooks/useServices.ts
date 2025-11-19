import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import type { Database } from "@/integrations/supabase/types";
import { toast } from "sonner";

type Service = Database["public"]["Tables"]["services"]["Row"];
type ServiceInsert = Database["public"]["Tables"]["services"]["Insert"];
type ServiceUpdate = Database["public"]["Tables"]["services"]["Update"];

// Fetch all services
export const useServices = () => {
  return useQuery({
    queryKey: ["services"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("services")
        .select("*")
        .is("deleted_at", null)
        .order("type", { ascending: true })
        .order("name", { ascending: true });

      if (error) {
        toast.error("Không thể tải danh sách dịch vụ");
        throw error;
      }

      return data || [];
    },
  });
};

// Fetch single service by ID
export const useService = (id: string) => {
  return useQuery({
    queryKey: ["services", id],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("services")
        .select("*")
        .eq("id", id)
        .is("deleted_at", null)
        .single();

      if (error) {
        toast.error("Không thể tải thông tin dịch vụ");
        throw error;
      }

      return data;
    },
    enabled: !!id,
  });
};

// Create new service
export const useCreateService = () => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (service: Omit<ServiceInsert, "user_id">) => {
      const {
        data: { user },
      } = await supabase.auth.getUser();

      if (!user) {
        throw new Error("User not authenticated");
      }

      const { data, error } = await supabase
        .from("services")
        .insert({
          ...service,
          user_id: user.id,
        })
        .select()
        .single();

      if (error) {
        if (error.code === "23505") {
          toast.error("Mã dịch vụ đã tồn tại");
        } else {
          toast.error("Không thể tạo dịch vụ");
        }
        throw error;
      }

      return data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["services"] });
      toast.success("Tạo dịch vụ thành công");
    },
    onError: (error) => {
      console.error("Error creating service:", error);
    },
  });
};

// Update existing service
export const useUpdateService = () => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({
      id,
      updates,
    }: {
      id: string;
      updates: ServiceUpdate;
    }) => {
      const { data, error } = await supabase
        .from("services")
        .update(updates)
        .eq("id", id)
        .select()
        .single();

      if (error) {
        if (error.code === "23505") {
          toast.error("Mã dịch vụ đã tồn tại");
        } else {
          toast.error("Không thể cập nhật dịch vụ");
        }
        throw error;
      }

      return data;
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["services"] });
      queryClient.invalidateQueries({ queryKey: ["services", data.id] });
      toast.success("Cập nhật dịch vụ thành công");
    },
    onError: (error) => {
      console.error("Error updating service:", error);
    },
  });
};

// Soft delete service
export const useDeleteService = () => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (id: string) => {
      // TODO: Check if service is used in any active contracts
      // For now, just soft delete
      const { data, error } = await supabase
        .from("services")
        .update({ deleted_at: new Date().toISOString() })
        .eq("id", id)
        .select()
        .single();

      if (error) {
        toast.error("Không thể xóa dịch vụ");
        throw error;
      }

      return data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["services"] });
      toast.success("Xóa dịch vụ thành công");
    },
    onError: (error) => {
      console.error("Error deleting service:", error);
    },
  });
};
