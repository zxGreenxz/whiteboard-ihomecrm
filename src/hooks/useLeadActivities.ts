import {persistentFinancialWorkflow} from '@/lib/persistentFinancialWorkflow';
import {FinancialWorkflowError} from '@/lib/financialWorkflow';
import {confirmedRecordId,recordWriteMessage} from '@/lib/recordWriteOutcome';
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { getSessionUser } from "@/lib/authSession";
import { toast } from "sonner";
import type { LeadActivityType } from "@/lib/leadHelpers";
import { friendlyError } from '@/lib/friendlyError';

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

/**
 * Bốn trường văn bản nhận cả `null` vì bảng `lead_activities` khai chúng
 * `?: string | null` (xem `Database['public']['Tables']['lead_activities']['Insert']`),
 * và `LeadActivityTimeline` đổ thẳng giá trị từ bản ghi xuống đây.
 *
 * Khai `?: string` là mô tả hẹp hơn thứ thật sự chạy qua kiểu này. Cách chữa
 * KHÔNG phải rắc `|| undefined` ở chỗ gọi — đó là bẻ dữ liệu cho vừa một cái
 * kiểu sai, và nó nhân bản theo số chỗ gọi.
 */
export interface CreateLeadActivityData {
  lead_id: string;
  activity_type: LeadActivityType;
  description?: string | null;
  old_value?: Record<string, any>;
  new_value?: Record<string, any>;
  scheduled_at?: string | null;
  completed_at?: string | null;
  notes?: string | null;
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
      if(!Array.isArray(data) || data.some(row=>!row.id || typeof row.created_at!=='string' || !Number.isFinite(Date.parse(row.created_at)))) throw new Error('Chưa xác nhận đủ lịch sử hoạt động khách hẹn. Tải lại trước khi xem.');
      return data as LeadActivity[];
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

      return persistentFinancialWorkflow('lead-activity-create',{scope:'actor'}).run(data.lead_id,'thêm hoạt động khách hẹn',async()=>{
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
      confirmedRecordId(activity,'thêm hoạt động khách hẹn');
      return activity;
      });
    },
    onSuccess: (_activity, variables) => {
      queryClient.invalidateQueries({ queryKey: ["lead-activities", variables.lead_id] });
      toast.success('Đã thêm hoạt động khách hẹn');
    },
    onError: (error: Error) => {
      if(error instanceof FinancialWorkflowError){toast.error('Chưa thêm được hoạt động',{description:recordWriteMessage(error,'thêm hoạt động khách hẹn')});return;}
      const feedback = friendlyError(error, 'Không thể thêm hoạt động', { operation: 'thêm hoạt động khách hẹn' });
      toast.error(feedback.title, { description: feedback.description });
    },
  });
};

// Delete lead activity
export const useDeleteLeadActivity = () => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ activityId, leadId }: { activityId: string; leadId: string }) => {
      return persistentFinancialWorkflow('lead-activity-delete',{scope:'actor'}).run(activityId,'xoá hoạt động khách hẹn',async()=>{
      const { data, error } = await supabase
        .from("lead_activities")
        .delete()
        .eq("id", activityId).eq('lead_id',leadId).select('id').single();

      if (error) throw error;
      confirmedRecordId(data,'xoá hoạt động khách hẹn',activityId);
      return { leadId };
      });
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["lead-activities", data.leadId] });
      toast.success('Đã xóa hoạt động khách hẹn');
    },
    onError: (error: Error) => {
      if(error instanceof FinancialWorkflowError){toast.error('Chưa xoá được hoạt động',{description:recordWriteMessage(error,'xoá hoạt động khách hẹn')});return;}
      const feedback = friendlyError(error, 'Không thể xóa hoạt động', { operation: 'xóa hoạt động khách hẹn' });
      toast.error(feedback.title, { description: feedback.description });
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
