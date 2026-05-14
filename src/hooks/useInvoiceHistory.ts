import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';

export type AuditEntity = 'invoice' | 'item' | 'payment';
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

export const useInvoiceHistory = (invoiceId: string | null, enabled = true) => {
  return useQuery({
    queryKey: ['invoice-history', invoiceId],
    enabled: enabled && !!invoiceId,
    queryFn: async (): Promise<InvoiceAuditEntry[]> => {
      const { data, error } = await (supabase as any)
        .from('invoice_audit_log')
        .select('*')
        .eq('invoice_id', invoiceId)
        .order('created_at', { ascending: false });
      if (error) throw error;
      return (data || []) as InvoiceAuditEntry[];
    },
  });
};
