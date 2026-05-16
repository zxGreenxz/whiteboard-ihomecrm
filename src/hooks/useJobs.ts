import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import { TaskFilters } from "@/types/jobs";

export const useJobs = (filters?: TaskFilters) => {
  return useQuery({
    queryKey: ["jobs", filters],
    queryFn: async () => {
      let query = supabase
        .from("jobs")
        .select(`
          *,
          buildings(id, name),
          rooms(id, name),
          beds(id, name),
          job_types(id, name),
          profiles!jobs_assignee_id_fkey(id, full_name)
        `)
        .order("created_at", { ascending: false });

      if (filters?.building_id) {
        query = query.eq("building_id", filters.building_id);
      }
      if (filters?.room_id) {
        query = query.eq("room_id", filters.room_id);
      }
      if (filters?.job_type_id) {
        query = query.eq("job_type_id", filters.job_type_id);
      }
      if (filters?.priority) {
        query = query.eq("priority", filters.priority);
      }
      if (filters?.assignee_id) {
        query = query.eq("assignee_id", filters.assignee_id);
      }
      if (filters?.status) {
        query = query.eq("status", filters.status);
      }
      if (filters?.start_date) {
        query = query.gte("created_at", filters.start_date);
      }
      if (filters?.end_date) {
        query = query.lte("created_at", filters.end_date);
      }

      const { data, error } = await query;

      if (error) {
        console.error("useJobs error:", error);
        return [];
      }

      return data || [];
    },
  });
};

export const useCreateJob = () => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (job: any) => {
      const {
        data: { user },
      } = await supabase.auth.getUser();

      if (!user) throw new Error("User not authenticated");

      const { data, error } = await supabase
        .from("jobs")
        .insert({ ...job, user_id: user.id })
        .select()
        .single();

      if (error) {
        toast.error("Không thể tạo công việc");
        throw error;
      }

      return data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["jobs"] });
      toast.success("Dữ liệu đã được TẠO thành công");
    },
    onError: (error) => {
      console.error("Error creating job:", error);
    },
  });
};

export const useUpdateJobStatus = () => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({
      id,
      status,
      extraData,
    }: {
      id: string;
      status: string;
      extraData?: Record<string, any>;
    }) => {
      const { data, error } = await supabase
        .from("jobs")
        .update({ status, ...extraData })
        .eq("id", id)
        .select()
        .single();

      if (error) {
        toast.error("Không thể cập nhật trạng thái");
        throw error;
      }

      return data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["jobs"] });
      toast.success("Trạng thái đã được cập nhật thành công");
    },
    onError: (error) => {
      console.error("Error updating job status:", error);
    },
  });
};

export const useUpdateJob = () => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ id, patch }: { id: string; patch: Record<string, any> }) => {
      const { data, error } = await supabase
        .from("jobs")
        .update(patch)
        .eq("id", id)
        .select()
        .single();

      if (error) {
        toast.error("Không thể cập nhật công việc");
        throw error;
      }

      return data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["jobs"] });
      toast.success("Dữ liệu đã được CẬP NHẬT thành công");
    },
    onError: (error) => {
      console.error("Error updating job:", error);
    },
  });
};

export const useCompleteJob = () => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (input: {
      id: string;
      completion_time: string;
      completion_attachments: string[] | null;
    }) => {
      const { data, error } = await supabase
        .from("jobs")
        .update({
          status: "COMPLETED",
          completion_time: input.completion_time,
          attachments: input.completion_attachments,
        })
        .eq("id", input.id)
        .select()
        .single();

      if (error) {
        toast.error("Không thể hoàn thành công việc");
        throw error;
      }

      return data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["jobs"] });
      toast.success("Công việc đã hoàn thành");
    },
    onError: (error) => {
      console.error("Error completing job:", error);
    },
  });
};

export const useDeleteJob = () => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (id: string) => {
      const { data, error } = await supabase
        .from("jobs")
        .delete()
        .eq("id", id)
        .select()
        .single();

      if (error) {
        toast.error("Không thể xoá công việc");
        throw error;
      }

      return data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["jobs"] });
      toast.success("Dữ liệu đã được XOÁ thành công");
    },
    onError: (error) => {
      console.error("Error deleting job:", error);
    },
  });
};

export const useProfiles = () => {
  return useQuery({
    queryKey: ["profiles"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("profiles")
        .select("id, full_name")
        .order("full_name");

      if (error) {
        console.error("useProfiles error:", error);
        return [];
      }

      return data || [];
    },
  });
};
