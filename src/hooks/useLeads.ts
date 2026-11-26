import {FinancialAlreadyRecordedError,FinancialWorkflowError} from '@/lib/financialWorkflow';
import {confirmedRecordId,recordWriteMessage,repeatableWrite,settleZeroRowDelete} from '@/lib/recordWriteOutcome';
// Nạp động: hai module của đợt 4 chỉ cần lúc tạo, nạp tĩnh từ nhiều trang làm Vite tách thành chunk dùng chung và
// thêm tên chunk vào danh sách phụ thuộc của chunk entry (cửa bundle-inventory).
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

/**
 * Dấu khoá chung của bản trước đợt 4 (`useCreateLead`/`create`): đọc một lần, tra khách hẹn người này tạo quanh giờ
 * kẹt (chưa xoá), gỡ dấu. Khách hẹn đang tạo giống một khách hẹn như thế (cùng SĐT; không có SĐT thì cùng tên) thì báo
 * «có thể đã tạo» kèm mã.
 */
async function checkLegacyLeadPending(matchKeys: readonly string[]): Promise<void> {
  const {legacyWindow,settleLegacyPending}=await import('@/lib/legacyPendingExit');
  const {personMatchKeys}=await import('@/lib/clientRecordCreate');
  const settled = await settleLegacyPending({ namespace: 'useCreateLead', businessKey: 'create' }, async (pending, context) => {
    const { from, to } = legacyWindow(pending);
    const { data, error } = await supabase.from('leads').select('id, customer_name, phone, created_at')
      .eq('user_id', context.userId).eq('organization_id', context.organizationId).is('deleted_at', null)
      .gte('created_at', from).lte('created_at', to).order('created_at', { ascending: false }).limit(50);
    if (error || !Array.isArray(data)) throw error ?? new Error('Chưa đọc được khách hẹn quanh giờ kẹt.');
    return data as { id: string; customer_name: string | null; phone: string | null }[];
  });
  const match = settled?.verdict.find(candidate => personMatchKeys({ name: candidate.customer_name, phone: candidate.phone }).some(key => matchKeys.includes(key)));
  if (match) throw new FinancialAlreadyRecordedError(`Có thể khách hẹn ${match.customer_name || ''} đã được tạo ở lần gửi trước bị kẹt (mã ${match.id}). Mở danh sách khách hẹn để kiểm tra; bấm tạo lại nếu vẫn muốn tạo thêm.`.replace(/\s+/g, ' '), [match.id]);
}

// Create lead
export const useCreateLead = () => {
  const queryClient = useQueryClient();
  const { selectedOrganizationId } = useOrganization();

  return useMutation({
    // Không còn khoá chung (đợt 4): mã khách hẹn do trình duyệt sinh, gửi lại cùng mã cho cùng khách hẹn; khoá chính
    // của `leads` chặn bản ghi thứ hai. Một lần kẹt chỉ liên quan đúng khách hẹn đó.
    mutationFn: async (data: LeadInsert): Promise<Lead & { replayed?: boolean }> => {
      const user = await getSessionUser();
      if (!user) throw new Error('Not authenticated');
      const payload = withOrg({ ...data, user_id: user.id } as Record<string, unknown>, selectedOrganizationId);
      delete payload.id;
      const person = { name: data.customer_name, phone: data.phone };
      const {createWithClientMemory,personMatchKeys}=await import('@/lib/clientRecordCreate');
      await checkLegacyLeadPending(personMatchKeys(person));
      const { row, replayed } = await createWithClientMemory<Lead>({
        table: 'leads', userId: user.id, organizationId: payload.organization_id, payload, person,
        personOf: row => ({ name: row.customer_name, phone: row.phone }),
        operation: 'tạo khách hẹn', describe: row => `Khách hẹn ${String(row.customer_name ?? '')}`.trim(),
      });
      return replayed ? { ...row, replayed } : row;
    },
    onSuccess: (lead) => {
      queryClient.invalidateQueries({ queryKey: ["leads"] });
      toast.success(lead.replayed
        ? `Khách hẹn ${lead.customer_name || ''} đã có trên máy chủ (lần gửi trước hoặc lần gửi mất phản hồi đã tạo); không tạo thêm.`.replace(/\s+/g, ' ')
        : `Đã tạo khách hẹn ${lead.customer_name || ''}`.trim());
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
    // Đợt 8 (luật 5): đặt giá trị theo mã, chạy lại cho cùng kết quả: không giữ dấu «chờ đối chiếu»; kết quả chưa rõ báo
    // rõ và cho lưu lại. Khớp 0 dòng (RLS, khách hẹn đã mất) là PGRST116: từ chối rõ.
    mutationFn: async ({ id, ...data }: LeadUpdate & { id: string }) => {
      const lead = await repeatableWrite('cập nhật khách hẹn', async () => {
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
      try { const { forgetLegacyPending } = await import('@/lib/legacyPendingExit'); await forgetLegacyPending({ namespace: 'useUpdateLead', businessKey: id }); }
      catch { /* Dấu bản trước không còn chặn gì; gỡ hỏng thì lần ghi sau gỡ lại. */ }
      return lead;
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
    // Đợt 8 (luật 5): xoá mềm theo mã lặp lại được, không giữ dấu. Chỉ xoá khách hẹn còn sống: lần bấm lại sau một lần
    // mất phản hồi khớp 0 dòng (không đổi giờ xoá), đọc lại thấy đã xoá ⇒ thành công «đã xoá trước đó»; còn nguyên ⇒
    // máy chủ không cho xoá (RLS) ⇒ báo không có quyền.
    mutationFn: async (id: string): Promise<{ id: string; alreadyDeleted?: boolean }> => {
      const result = await repeatableWrite('xoá khách hẹn', async () => {
        const { data, error } = await supabase
          .from("leads")
          .update({ deleted_at: new Date().toISOString() })
          .eq("id", id).is('deleted_at', null).select('id');

        if (error) throw error;
        if (Array.isArray(data) && data.length === 0) {
          await settleZeroRowDelete('xoá khách hẹn', () => supabase.from('leads').select('id, deleted_at').eq('id', id).maybeSingle());
          return { id, alreadyDeleted: true };
        }
        confirmedRecordId(Array.isArray(data) && data.length === 1 ? data[0] : null,'xoá khách hẹn',id);
        return { id };
      });
      try { const { forgetLegacyPending } = await import('@/lib/legacyPendingExit'); await forgetLegacyPending({ namespace: 'useDeleteLead', businessKey: id }); }
      catch { /* Dấu bản trước không còn chặn gì; gỡ hỏng thì lần xoá sau gỡ lại. */ }
      return result;
    },
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: ["leads"] });
      toast.success(result.alreadyDeleted ? 'Khách hẹn đã được xoá trước đó.' : 'Đã xóa khách hẹn');
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
