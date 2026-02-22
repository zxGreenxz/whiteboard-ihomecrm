import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import type { Database } from "@/integrations/supabase/types";
import { toast } from "sonner";

type TaskType = Database["public"]["Tables"]["task_types"]["Row"];
type TaskTypeInsert = Database["public"]["Tables"]["task_types"]["Insert"];
type TaskTypeUpdate = Database["public"]["Tables"]["task_types"]["Update"];

export const useTaskTypes = () => {
  return useQuery({
    queryKey: ["task_types"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("task_types")
        .select("*")
        .order("name", { ascending: true });

      if (error) {
        console.error("useTaskTypes error:", error);
        return [];
      }

      return data || [];
    },
  });
};

export const useCreateTaskType = () => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (taskType: Omit<TaskTypeInsert, "user_id">) => {
      const {
        data: { user },
      } = await supabase.auth.getUser();

      if (!user) throw new Error("User not authenticated");

      const { data, error } = await supabase
        .from("task_types")
        .insert({ ...taskType, user_id: user.id })
        .select()
        .single();

      if (error) {
        toast.error("Không thể tạo loại công việc");
        throw error;
      }

      return data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["task_types"] });
      toast.success("Loại công việc đã được tạo thành công");
    },
    onError: (error) => {
      console.error("Error creating task type:", error);
    },
  });
};

export const useUpdateTaskType = () => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ id, updates }: { id: string; updates: TaskTypeUpdate }) => {
      const { data, error } = await supabase
        .from("task_types")
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
      queryClient.invalidateQueries({ queryKey: ["task_types"] });
      toast.success("Loại công việc đã được cập nhật thành công");
    },
    onError: (error) => {
      console.error("Error updating task type:", error);
    },
  });
};

export const useDeleteTaskType = () => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (id: string) => {
      const { data, error } = await supabase
        .from("task_types")
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
      queryClient.invalidateQueries({ queryKey: ["task_types"] });
      toast.success("Loại công việc đã được xóa thành công");
    },
    onError: (error) => {
      console.error("Error deleting task type:", error);
    },
  });
};
