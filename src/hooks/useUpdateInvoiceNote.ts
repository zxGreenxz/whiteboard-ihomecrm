// =============================================
// useUpdateInvoiceNote — ghi ghi-chú vào invoices.notes
//
// Dùng cho Drawer Thu tiền khi phòng CHƯA thu (note đứng-một-mình, không có
// phiếu thu để gắn vào). RLS cho staff sửa HĐ trong phạm vi phụ trách.
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
        .update({ notes: notes.trim() || null } as any)
        .eq('id', invoice_id)
        .select('id');
      if (error) throw error;
      if (!data || data.length === 0) {
        throw new Error('Bạn không có quyền ghi chú hoá đơn này.');
      }
      return { invoice_id };
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['invoices'] });
      queryClient.invalidateQueries({ queryKey: ['invoice'] });
    },
  });
};
