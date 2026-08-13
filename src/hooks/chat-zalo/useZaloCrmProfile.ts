// Hồ sơ CRM LIVE của hội thoại (khách hàng / lead / HĐ / phòng) — thay cho
// snapshot jsonb `profile`. 1 roundtrip qua RPC zalo_get_crm_summary; gắn/tháo
// thủ công qua zalo_link_conversation / zalo_unlink_conversation (DB chặn
// gắn chéo công ty).
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { supabase } from '@/integrations/supabase/client';
import { QK } from '@/hooks/useZaloChat';

export interface ZaloCrmSummary {
  customer?: { id: string; full_name: string; phone: string; avatar_url?: string | null; customer_type?: string | null; status?: string | null };
  lead?: { id: string; customer_name?: string | null; phone: string; status?: string | null; source?: string | null; budget_min?: number | null; budget_max?: number | null; move_in_date?: string | null; next_follow_up_date?: string | null };
  contract?: { id: string; contract_number?: string | null; status?: string | null; start_date?: string | null; end_date?: string | null; rent_price?: number | null; payment_cycle?: string | null };
  room?: { id: string; code?: string | null; name?: string | null; floor?: number | null; building_name?: string | null };
}

export function useZaloCrmSummary(conversationId?: string, linked?: boolean) {
  return useQuery({
    queryKey: ['zalo', 'crm', conversationId],
    enabled: !!conversationId && !!linked,
    staleTime: 60_000,
    retry: 1,
    queryFn: async (): Promise<ZaloCrmSummary | null> => {
      const { data, error } = await supabase.rpc('zalo_get_crm_summary', {
        p_conversation_id: conversationId!,
      });
      if (error) throw error;
      return (data as unknown as ZaloCrmSummary) || null;
    },
  });
}

export function useLinkConversation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (v: { conversationId: string; customerId?: string; leadId?: string }) => {
      const { error } = await supabase.rpc('zalo_link_conversation', {
        p_conversation_id: v.conversationId,
        p_customer_id: v.customerId,
        p_lead_id: v.leadId,
      });
      if (error) throw error;
    },
    onSuccess: (_d, v) => {
      qc.invalidateQueries({ queryKey: QK.conversations });
      qc.invalidateQueries({ queryKey: ['zalo', 'crm', v.conversationId] });
      toast.success('Đã gắn hồ sơ CRM vào hội thoại');
    },
    onError: (e: Error) => { toast.error(e?.message || 'Không gắn được hồ sơ'); },
  });
}

export function useUnlinkConversation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (v: { conversationId: string }) => {
      const { error } = await supabase.rpc('zalo_unlink_conversation', {
        p_conversation_id: v.conversationId,
      });
      if (error) throw error;
    },
    onSuccess: (_d, v) => {
      qc.invalidateQueries({ queryKey: QK.conversations });
      qc.invalidateQueries({ queryKey: ['zalo', 'crm', v.conversationId] });
      toast.success('Đã tháo liên kết hồ sơ');
    },
    onError: (e: Error) => { toast.error(e?.message || 'Không tháo được liên kết'); },
  });
}

// Tìm khách hàng theo tên/SĐT trong org (cho dialog gắn hồ sơ) — select cột
// tường minh, limit chặt, chỉ chạy khi có từ khoá ≥2 ký tự.
export interface CustomerHit { id: string; full_name: string; phone: string }
export function useSearchCustomers(term: string, orgId: string | null) {
  const q = term.trim();
  return useQuery({
    queryKey: ['zalo', 'customer-search', orgId, q],
    enabled: !!orgId && q.length >= 2,
    staleTime: 30_000,
    retry: 1,
    queryFn: async (): Promise<CustomerHit[]> => {
      const { data, error } = await supabase
        .from('customers')
        .select('id, full_name, phone')
        .eq('organization_id', orgId!)
        .is('deleted_at', null)
        .or(`full_name.ilike.%${q.replace(/[%,()]/g, '')}%,phone.ilike.%${q.replace(/[%,()]/g, '')}%`)
        .order('updated_at', { ascending: false })
        .limit(20);
      if (error) throw error;
      return (data || []) as CustomerHit[];
    },
  });
}
