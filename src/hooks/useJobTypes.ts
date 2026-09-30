import {readJobTypes,readDepartments} from '@/lib/accountJobReadModels';
import { requireAccountWriteReceipt } from "@/lib/accountSettingsWriteReceipt";
import { notifyActionError } from '@/lib/actionFeedback';
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { getSessionUser } from "@/lib/authSession";
import { toast } from "sonner";

export const useJobTypes = () => {
  return useQuery({
    queryKey: ["job_types"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("job_types")
        .select(`*, job_groups(id, name), departments:departments!job_types_default_department_id_fkey(id, name)`)
        .order("created_at", { ascending: false });

      if (error) {
        console.error("useJobTypes error:", error);
        throw error;
      }

      return readJobTypes(data);
    },
  });
};

export const useCreateJobType = () => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (jobType: any) => {
      const user = await getSessionUser();

      if (!user) throw new Error("User not authenticated");

      const { data, error } = await supabase
        .from("job_types")
        .insert({ ...jobType, user_id: user.id })
        .select()
        .single();

      if (error) {
        throw error;
      }

      return requireAccountWriteReceipt(data, { ...jobType, user_id: user.id });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["job_types"] });
      toast.success("Đã tạo loại công việc.");
    },
    onError: (error) => {
      notifyActionError(error, "Chưa xác nhận được kết quả thao tác loại công việc");
    },
  });
};

export const useUpdateJobType = () => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ id, updates }: { id: string; updates: any }) => {
      const { data, error } = await supabase
        .from("job_types")
        .update(updates)
        .eq("id", id)
        .select()
        .single();

      if (error) {
        throw error;
      }

      return requireAccountWriteReceipt(data, { ...updates, id });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["job_types"] });
      toast.success("Đã cập nhật loại công việc.");
    },
    onError: (error) => {
      notifyActionError(error, "Chưa xác nhận được kết quả thao tác loại công việc");
    },
  });
};

export const useDeleteJobType = () => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (id: string) => {
      const { data, error } = await supabase
        .from("job_types")
        .delete()
        .eq("id", id)
        .select()
        .single();

      if (error) {
        throw error;
      }

      return requireAccountWriteReceipt(data, { id });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["job_types"] });
      toast.success("Đã xóa loại công việc.");
    },
    onError: (error) => {
      notifyActionError(error, "Chưa xác nhận được kết quả thao tác loại công việc");
    },
  });
};

export const useDepartments = () => {
  return useQuery({
    queryKey: ["departments"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("departments")
        .select("id, name, code")
        .eq("is_active", true)
        .order("name");

      if (error) {
        console.error("useDepartments error:", error);
        throw error;
      }

      return readDepartments(data);
    },
  });
};
