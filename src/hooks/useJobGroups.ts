import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";

export const useJobGroups = () => {
  return useQuery({
    queryKey: ["job_groups"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("job_groups")
        .select("*")
        .order("name");

      if (error) {
        console.error("useJobGroups error:", error);
        return [];
      }

      return data || [];
    },
  });
};

export const useCreateJobGroup = () => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (name: string) => {
      const {
        data: { user },
      } = await supabase.auth.getUser();

      if (!user) throw new Error("User not authenticated");

      const { data, error } = await supabase
        .from("job_groups")
        .insert({ name, user_id: user.id })
        .select()
        .single();

      if (error) {
        toast.error("Không thể tạo nhóm công việc");
        throw error;
      }

      return data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["job_groups"] });
      toast.success("Nhóm công việc đã được tạo");
    },
    onError: (error) => {
      console.error("Error creating job group:", error);
    },
  });
};
