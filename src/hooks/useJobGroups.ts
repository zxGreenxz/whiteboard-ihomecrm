import {readJobGroups} from '@/lib/accountJobReadModels';
import { requireAccountWriteReceipt } from "@/lib/accountSettingsWriteReceipt";
import { notifyActionError } from '@/lib/actionFeedback';
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { getSessionUser } from "@/lib/authSession";
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
        throw error;
      }

      return readJobGroups(data);
    },
  });
};

export const useCreateJobGroup = () => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (name: string) => {
      const user = await getSessionUser();

      if (!user) throw new Error("User not authenticated");

      const { data, error } = await supabase
        .from("job_groups")
        .insert({ name, user_id: user.id })
        .select()
        .single();

      if (error) {
        throw error;
      }

      return requireAccountWriteReceipt(data, { name, user_id: user.id });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["job_groups"] });
      toast.success("Nhóm công việc đã được tạo");
    },
    onError: (error) => {
      notifyActionError(error, "Chưa xác nhận được kết quả thao tác nhóm công việc");
    },
  });
};
