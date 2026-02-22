import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import type { Database } from "@/integrations/supabase/types";
import { toast } from "sonner";

type ServiceQuota = Database["public"]["Tables"]["service_quotas"]["Row"];
type ServiceQuotaInsert = Database["public"]["Tables"]["service_quotas"]["Insert"];
type ServiceQuotaUpdate = Database["public"]["Tables"]["service_quotas"]["Update"];

export const useServiceQuotas = (serviceId?: string, buildingId?: string) => {
  return useQuery({
    queryKey: ["service_quotas", serviceId, buildingId],
    queryFn: async () => {
      let query = supabase
        .from("service_quotas")
        .select("*")
        .order("created_at", { ascending: false });

      if (serviceId) {
        query = query.eq("service_id", serviceId);
      }
      if (buildingId) {
        query = query.eq("building_id", buildingId);
      }

      const { data, error } = await query;

      if (error) {
        console.error("useServiceQuotas error:", error);
        return [];
      }

      return data || [];
    },
  });
};

export const useCreateServiceQuota = () => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (item: Omit<ServiceQuotaInsert, "user_id">) => {
      const {
        data: { user },
      } = await supabase.auth.getUser();

      if (!user) throw new Error("User not authenticated");

      const { data, error } = await supabase
        .from("service_quotas")
        .insert({ ...item, user_id: user.id })
        .select()
        .single();

      if (error) {
        toast.error("Không thể tạo định mức dịch vụ");
        throw error;
      }

      return data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["service_quotas"] });
      toast.success("Định mức dịch vụ đã được tạo thành công");
    },
    onError: (error) => {
      console.error("Error creating service quota:", error);
    },
  });
};

export const useUpdateServiceQuota = () => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ id, updates }: { id: string; updates: ServiceQuotaUpdate }) => {
      const { data, error } = await supabase
        .from("service_quotas")
        .update(updates)
        .eq("id", id)
        .select()
        .single();

      if (error) {
        toast.error("Không thể cập nhật định mức dịch vụ");
        throw error;
      }

      return data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["service_quotas"] });
      toast.success("Định mức dịch vụ đã được cập nhật thành công");
    },
    onError: (error) => {
      console.error("Error updating service quota:", error);
    },
  });
};

export const useDeleteServiceQuota = () => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (id: string) => {
      const { data, error } = await supabase
        .from("service_quotas")
        .delete()
        .eq("id", id)
        .select()
        .single();

      if (error) {
        toast.error("Không thể xóa định mức dịch vụ");
        throw error;
      }

      return data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["service_quotas"] });
      toast.success("Định mức dịch vụ đã được xóa thành công");
    },
    onError: (error) => {
      console.error("Error deleting service quota:", error);
    },
  });
};
