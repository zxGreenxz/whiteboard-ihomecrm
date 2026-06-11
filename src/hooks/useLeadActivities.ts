import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { getSessionUser } from "@/lib/authSession";
import { toast } from "sonner";
import type { LeadActivityType } from "@/lib/leadHelpers";

export interface LeadActivity {
  id: string;
  lead_id: string;
  activity_type: LeadActivityType;
  description: string | null;
  old_value: Record<string, any> | null;
  new_value: Record<string, any> | null;
  performed_by: string | null;
  scheduled_at: string | null;
  completed_at: string | null;
  notes: string | null;
  created_at: string;
}

export interface CreateLeadActivityData {
  lead_id: string;
  activity_type: LeadActivityType;
  description?: string;
  old_value?: Record<string, any>;
  new_value?: Record<string, any>;
  scheduled_at?: string;
  completed_at?: string;
  notes?: string;
}

// Fetch activities for a lead
export const useLeadActivities = (leadId?: string) => {
  return useQuery({
    queryKey: ["lead-activities", leadId],
    queryFn: async (): Promise<LeadActivity[]> => {
      if (!leadId) return [];

      const user = await getSessionUser();
      if (!user) throw new Error('Not authenticated');

      const { data, error } = await supabase
        .from("lead_activities")
        .select("*")
        .eq("lead_id", leadId)
        .order("created_at", { ascending: false });

      if (error) throw error;
      return (data as LeadActivity[]) || [];
    },
    enabled: !!leadId,
  });
};

// Create lead activity
export const useCreateLeadActivity = () => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (data: CreateLeadActivityData) => {
      const user = await getSessionUser();
      if (!user) throw new Error('Not authenticated');

      const { data: activity, error } = await supabase
        .from("lead_activities")
        .insert({
          ...data,
          user_id: user.id,
          performed_by: user.id,
        })
        .select()
        .single();

      if (error) throw error;
      return activity;
    },
    onSuccess: (_, variables) => {
      queryClient.invalidateQueries({ queryKey: ["lead-activities", variables.lead_id] });
      toast.success("Hoạt động đã được thêm thành công");
    },
    onError: (error: Error) => {
      toast.error("Có lỗi xảy ra khi thêm hoạt động: " + error.message);
    },
  });
};

// Delete lead activity
export const useDeleteLeadActivity = () => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ activityId, leadId }: { activityId: string; leadId: string }) => {
      const { error } = await supabase
        .from("lead_activities")
        .delete()
        .eq("id", activityId);

      if (error) throw error;
      return { leadId };
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["lead-activities", data.leadId] });
      toast.success("Hoạt động đã được xóa thành công");
    },
    onError: (error: Error) => {
      toast.error("Có lỗi xảy ra khi xóa hoạt động: " + error.message);
    },
  });
};

// Log activity when lead status changes
export const logLeadStatusChange = async (
  leadId: string,
  oldStatus: string,
  newStatus: string
) => {
  const user = await getSessionUser();
  if (!user) return;

  await supabase.from("lead_activities").insert({
    lead_id: leadId,
    user_id: user.id,
    activity_type: "STATUS_CHANGE",
    description: `Chuyển trạng thái từ ${oldStatus} sang ${newStatus}`,
    old_value: { status: oldStatus },
    new_value: { status: newStatus },
    performed_by: user.id,
    completed_at: new Date().toISOString(),
  });
};
