import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
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
        return [];
      }

      return data || [];
    },
  });
};

export const useCreateJobType = () => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (jobType: any) => {
      const {
        data: { user },
      } = await supabase.auth.getUser();

      if (!user) throw new Error("User not authenticated");

      const { data, error } = await supabase
        .from("job_types")
        .insert({ ...jobType, user_id: user.id })
        .select()
        .single();

      if (error) {
        toast.error("Không thể tạo loại công việc");
        throw error;
      }

      return data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["job_types"] });
      toast.success("Dữ liệu đã được TẠO thành công");
    },
    onError: (error) => {
      console.error("Error creating job type:", error);
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
        toast.error("Không thể cập nhật loại công việc");
        throw error;
      }

      return data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["job_types"] });
      toast.success("Dữ liệu đã được CẬP NHẬT thành công");
    },
    onError: (error) => {
      console.error("Error updating job type:", error);
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
        toast.error("Không thể xóa loại công việc");
        throw error;
      }

      return data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["job_types"] });
      toast.success("Dữ liệu đã được XOÁ thành công");
    },
    onError: (error) => {
      console.error("Error deleting job type:", error);
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
        return [];
      }

      return data || [];
    },
  });
};
