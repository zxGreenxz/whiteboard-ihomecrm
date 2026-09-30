import {persistentFinancialWorkflow} from '@/lib/persistentFinancialWorkflow';
import {FinancialWorkflowError} from '@/lib/financialWorkflow';
import {confirmedRecordId,recordWriteMessage} from '@/lib/recordWriteOutcome';
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { getSessionUser } from "@/lib/authSession";
import { fetchAllRows } from "@/lib/supabaseFetchAll";
import type { Database } from "@/integrations/supabase/types";
import { toast } from "sonner";
import { useOrganization } from "@/contexts/OrganizationContext";
import { withOrg } from "@/lib/orgPayload";
import { friendlyError } from '@/lib/friendlyError';

type Lead = Database["public"]["Tables"]["leads"]["Row"];
type LeadInsert = Database["public"]["Tables"]["leads"]["Insert"];
type LeadUpdate = Database["public"]["Tables"]["leads"]["Update"];

export interface LeadWithRelations extends Lead {
  building?: {
    id: string;
    name: string;
  };
  room?: {
    id: string;
    name: string;
    code: string | null;
    building?: {
      id: string;
      name: string;
    };
  };
}

// Fetch all leads
export const useLeads = (filters?: {
  status?: string;
  source?: string;
}) => {
  return useQuery({
    queryKey: ["leads", filters],
    queryFn: async (): Promise<LeadWithRelations[]> => {
      const user = await getSessionUser();
      if (!user) throw new Error('Not authenticated');

      // PHÂN TRANG: kanban khách hẹn đọc toàn bộ bảng (bộ lọc status/source là
      // tuỳ chọn). Quá 1000 khách hẹn thì cột kanban thiếu thẻ mà không báo gì.
      // `created_at` không duy nhất → tiebreaker `id`.
      const rows = await fetchAllRows<LeadWithRelations>((from, to) => {
        let query = supabase
          .from("leads")
          .select(`
            *,
            building:buildings!leads_building_id_fkey (
              id, name
            ),
            room:rooms!leads_room_id_fkey (
              id, name, code,
              building:buildings!rooms_building_id_fkey (
                id, name
              )
            )
          `)
          .order("created_at", { ascending: false })
          .order("id", { ascending: false });

        if (filters?.status) {
          query = query.eq("status", filters.status as any);
        }
        if (filters?.source) {
          query = query.eq("source", filters.source as any);
        }

        return query.range(from, to);
      }, { label: "leads" });

      if (rows === null) {
        toast.error("Không thể tải danh sách khách hẹn");
        throw new Error("Không tải được danh sách khách hẹn. Hãy thử lại.");
      }

      return rows;
    },
  });
};

// Fetch single lead by ID
export const useLead = (id: string) => {
  return useQuery({
    queryKey: ["leads", id],
    queryFn: async (): Promise<LeadWithRelations> => {
      const user = await getSessionUser();
      if (!user) throw new Error('Not authenticated');

      const { data, error } = await supabase
        .from("leads")
        .select(`
          *,
          building:buildings!leads_building_id_fkey (
            id, name
          ),
          room:rooms!leads_room_id_fkey (
            id, name, code,
            building:buildings!rooms_building_id_fkey (
              id, name
            )
          )
        `)
        .eq("id", id)
        .single();

      if (error) {
        toast.error("Không thể tải thông tin khách hẹn");
        throw error;
      }

      if(!data || data.id!==id) throw new Error('Chưa xác nhận được thông tin khách hẹn. Tải lại trước khi chỉnh sửa.');
      return data as LeadWithRelations;
    },
    enabled: !!id,
  });
};

// Create lead
export const useCreateLead = () => {
  const queryClient = useQueryClient();
  const { selectedOrganizationId } = useOrganization();

  return useMutation({
    mutationFn: async (data: LeadInsert) => {
      const user = await getSessionUser();
      if (!user) throw new Error('Not authenticated');

      return persistentFinancialWorkflow('useCreateLead').run('create', 'tạo khách hẹn', async () => {
      const { data: lead, error } = await supabase
        .from("leads")
        .insert(withOrg({
          ...data,
          user_id: user.id,
        }, selectedOrganizationId))
        .select()
        .single();

      if (error) throw error;
      confirmedRecordId(lead,'tạo khách hẹn');
      return lead;
      }, undefined, selectedOrganizationId);
    },
    onSuccess: (lead) => {
      queryClient.invalidateQueries({ queryKey: ["leads"] });
      toast.success(`Đã tạo khách hẹn ${lead.customer_name || ''}`.trim());
    },
    onError: (error: Error) => {
      queryClient.invalidateQueries({queryKey:['leads']});
      if(error instanceof FinancialWorkflowError) {toast.error('Chưa tạo khách hẹn',{description:recordWriteMessage(error,'tạo khách hẹn')});return;}
      const feedback = friendlyError(error, 'Không thể tạo khách hẹn', { operation: 'tạo khách hẹn' });
      toast.error(feedback.title, { description: feedback.description });
    },
  });
};

// Update lead
export const useUpdateLead = () => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ id, ...data }: LeadUpdate & { id: string }) => {
      return persistentFinancialWorkflow('useUpdateLead').run(id, 'cập nhật khách hẹn', async () => {
      const { data: lead, error } = await supabase
        .from("leads")
        .update(data)
        .eq("id", id)
        .select()
        .single();

      if (error) throw error;
      confirmedRecordId(lead,'cập nhật khách hẹn',id);
      return lead;
      });
    },
    onSuccess: (lead) => {
      queryClient.invalidateQueries({ queryKey: ["leads"] });
      toast.success(`Đã cập nhật khách hẹn ${lead.customer_name || ''}`.trim());
    },
    onError: (error: Error) => {
      queryClient.invalidateQueries({queryKey:['leads']});
      if(error instanceof FinancialWorkflowError) {toast.error('Chưa cập nhật khách hẹn',{description:recordWriteMessage(error,'cập nhật khách hẹn')});return;}
      const feedback = friendlyError(error, 'Không thể cập nhật khách hẹn', { operation: 'cập nhật khách hẹn' });
      toast.error(feedback.title, { description: feedback.description });
    },
  });
};

// Delete lead (soft delete)
export const useDeleteLead = () => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (id: string) => {
      return persistentFinancialWorkflow('useDeleteLead').run(id, 'xoá khách hẹn', async () => {
      const { data: lead, error } = await supabase
        .from("leads")
        .update({ deleted_at: new Date().toISOString() })
        .eq("id", id).select('id').single();

      if (error) throw error;
      confirmedRecordId(lead,'xoá khách hẹn',id);
      return lead;
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["leads"] });
      toast.success('Đã xóa khách hẹn');
    },
    onError: (error: Error) => {
      queryClient.invalidateQueries({queryKey:['leads']});
      if(error instanceof FinancialWorkflowError) {toast.error('Chưa xoá khách hẹn',{description:recordWriteMessage(error,'xoá khách hẹn')});return;}
      const feedback = friendlyError(error, 'Không thể xóa khách hẹn', { operation: 'xóa khách hẹn' });
      toast.error(feedback.title, { description: feedback.description });
    },
  });
};

// Convert lead to deposit
export const useConvertLeadToDeposit = (options: { silent?: boolean } = {}) => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (leadId: string) => {
      // Get lead data
      const { data: lead, error: leadError } = await supabase
        .from("leads")
        .select("*")
        .eq("id", leadId)
        .single();

      if (leadError) throw leadError;

      if(!lead || lead.id!==leadId) throw new FinancialWorkflowError('Chưa xác nhận được khách hẹn cần chuyển. Tải lại thông tin trước khi tiếp tục.','failure',[]);
      if(lead.status==='CONVERTED') return {lead};
      // Mark lead as converted
      const { data: converted, error: updateError } = await supabase
        .from("leads")
        .update({ status: "CONVERTED" as any })
        .eq("id", leadId).select().single();

      if (updateError) throw updateError;

      confirmedRecordId(converted,'chuyển khách hẹn',leadId);
      if(converted.status!=='CONVERTED') throw new FinancialWorkflowError('Chưa xác nhận trạng thái khách hẹn đã chuyển. Tải lại và đối chiếu trước khi thao tác tiếp.','unknown',[{id:leadId,label:'Khách hẹn cần đối chiếu'}]);
      return {lead:converted};
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["leads"] });
      if (!options.silent) toast.success("Chuyển đổi sang đặt cọc thành công");
    },
    onError: (error: Error) => {
      if (!options.silent) {
        queryClient.invalidateQueries({queryKey:['leads']});
        toast.error('Chưa chuyển được khách hẹn',{description:recordWriteMessage(error,'chuyển khách hẹn thành đặt cọc')});
      }
    },
  });
};
