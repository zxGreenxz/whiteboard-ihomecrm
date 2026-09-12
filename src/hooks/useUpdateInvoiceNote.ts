// =============================================
// useUpdateInvoiceNote — ghi ghi-chú vào invoices.notes
//
// Chỉ dùng cho hóa đơn DRAFT chưa có phiên bản điều chỉnh. Hóa đơn đã phát
// hành dùng editor v2 với đầy đủ snapshot và lý do điều chỉnh riêng.
// =============================================

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';

interface UpdateInvoiceNoteInput {
  invoice_id: string;
  notes: string;
}

export const useUpdateInvoiceNote = () => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ invoice_id, notes }: UpdateInvoiceNoteInput) => {
      const { data, error } = await supabase
        .from('invoices')
        .update({ notes: notes.trim() || null })
        .eq('id', invoice_id)
        .eq('status', 'DRAFT')
        .eq('paid_amount', 0)
        .eq('adjustment_revision', 0)
        .is('deleted_at', null)
        .select('id');
      if (error) throw error;
      if (!data || data.length === 0) {
        throw new Error('Hóa đơn vừa thay đổi hoặc không cho phép ghi chú trực tiếp. Tải lại và dùng Điều chỉnh hóa đơn.');
      }
      return { invoice_id };
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['invoices'] });
      queryClient.invalidateQueries({ queryKey: ['invoice'] });
    },
  });
};
