// =============================================
// useDeletePayment
// Xóa 1 phiếu thanh toán (payments row) cùng với phiếu Thu/Chi
// liên kết (income_expenses) và credit excess_amounts (nếu có).
//
// Quy trình:
//   1. Soft-delete income_expenses voucher có payment_id = payment_id
//      (deleted_at = NOW())
//   2. Hard-delete excess_amounts có source_payment_id = payment_id
//      (credit "Nợ kỳ sau" sẽ huỷ theo)
//   3. Hard-delete payments row → trigger DB
//      recompute_invoice_after_payment_change tự cập nhật
//      invoices.paid_amount / status / paid_date.
// =============================================

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useToast } from '@/hooks/use-toast';

interface DeletePaymentInput {
  payment_id: string;
}

export const useDeletePayment = () => {
  const queryClient = useQueryClient();
  const { toast } = useToast();

  return useMutation({
    mutationFn: async ({ payment_id }: DeletePaymentInput) => {
      // 1. Soft-delete voucher Thu/Chi liên kết (nếu có).
      //    Trigger trg_ie_handover_guard chặn nếu phiếu đang nằm trong
      //    phiên bàn giao tiền mặt chưa hủy ([HANDOVER_LOCKED]).
      const { error: vErr } = await (supabase as any)
        .from('income_expenses')
        .update({ deleted_at: new Date().toISOString() })
        .eq('payment_id', payment_id)
        .is('deleted_at', null);
      if (vErr) {
        if (String(vErr.message ?? '').includes('[HANDOVER_LOCKED]')) {
          throw new Error(
            'Phiếu thu này đang nằm trong phiên bàn giao tiền mặt. Hãy hủy phiên bàn giao (cần cả 2 bên xác nhận) trước khi hoàn tác.',
          );
        }
        throw vErr;
      }

      // 2. Hard-delete excess_amounts (credit "Nợ kỳ sau") nếu có.
      const { error: eaErr } = await (supabase as any)
        .from('excess_amounts')
        .delete()
        .eq('source_payment_id', payment_id);
      if (eaErr) throw eaErr;

      // 3. Hard-delete payment row → trigger recompute invoice.
      const { error: pErr, count } = await (supabase as any)
        .from('payments')
        .delete({ count: 'exact' })
        .eq('id', payment_id);
      if (pErr) throw pErr;
      if (count === 0) {
        throw new Error('Bạn không có quyền xoá phiếu thu này.');
      }

      return { payment_id };
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['invoice-payments-summary'] });
      queryClient.invalidateQueries({ queryKey: ['invoices'] });
      queryClient.invalidateQueries({ queryKey: ['invoice'] });
      queryClient.invalidateQueries({ queryKey: ['payments'] });
      queryClient.invalidateQueries({ queryKey: ['invoice-statistics'] });
      queryClient.invalidateQueries({ queryKey: ['income-expenses'] });
      queryClient.invalidateQueries({ queryKey: ['accounts-with-balance'] });
      queryClient.invalidateQueries({ queryKey: ['excess-amount'] });

      toast({
        title: 'Đã xoá phiếu thanh toán',
        description: 'Phiếu Thu liên kết đã được xoá khỏi sổ Thu/Chi.',
      });
    },
    onError: (error: Error) => {
      toast({
        variant: 'destructive',
        title: 'Không thể xoá phiếu thanh toán',
        description: error.message,
      });
    },
  });
};
