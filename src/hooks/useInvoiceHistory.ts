import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';

export type AuditEntity = 'invoice' | 'item' | 'payment' | 'receipt' | 'excess';
export type AuditAction = 'INSERT' | 'UPDATE' | 'DELETE';

export interface InvoiceAuditEntry {
  id: string;
  invoice_id: string;
  entity: AuditEntity;
  entity_id: string;
  action: AuditAction;
  actor_id: string | null;
  actor_name: string | null;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  changed_fields: string[] | null;
  created_at: string;
}

// PostgREST mặc định cắt ở 1000 dòng — limit tường minh để biết chắc giới hạn,
// lấy MỚI NHẤT trước (HĐ sửa nhiều lần vẫn thấy các thao tác gần đây).
const HISTORY_LIMIT = 1000;

export const useInvoiceHistory = (invoiceId: string | null, enabled = true) => {
  return useQuery({
    queryKey: ['invoice-history', invoiceId],
    enabled: enabled && !!invoiceId,
    queryFn: async (): Promise<InvoiceAuditEntry[]> => {
      const { data, error } = await supabase
        .from('invoice_audit_log')
        .select('*')
        .eq('invoice_id', invoiceId!)
        .order('created_at', { ascending: false })
        .order('id', { ascending: false })
        .limit(HISTORY_LIMIT);
      if (error) throw error;
      return (data || []) as unknown as InvoiceAuditEntry[];
    },
  });
};
