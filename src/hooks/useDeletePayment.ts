// =============================================
// useDeletePayment
// "Delete" is always a compensating reversal. V5 payments reverse their
// entire collection; only a payment without collection_id uses the v3 adapter.
// No permission/frozen/rollout error falls back to destructive deletion.
// =============================================

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useToast } from '@/hooks/use-toast';
import { todayISO } from '@/lib/collect';
import { reverseInvoicePaymentBySource } from '@/lib/paymentRecordRpc';

interface DeletePaymentInput {
  payment_id?: string | null;
  collection_id?: string | null;
}

type DeletePaymentResult = {
  payment_id: string | null;
  collection_id: string | null;
  mode: 'COLLECTION_REVERSED' | 'LEGACY_PAYMENT_REVERSED';
};

export const useDeletePayment = () => {
  const queryClient = useQueryClient();
  const { toast } = useToast();

  return useMutation({
    mutationFn: async ({
      payment_id,
      collection_id,
    }: DeletePaymentInput): Promise<DeletePaymentResult> => {
      const paymentId = payment_id?.trim() || null;
      let collectionId = collection_id?.trim() || null;

      // Older callers only know payment_id. Resolve its collection once so a
      // multi-tender V5 receipt still reverses at collection scope.
      if (!collectionId) {
        if (!paymentId) {
          throw new Error('Không tìm thấy nguồn giao dịch cần hoàn tác');
        }
        const { data: payment, error: paymentError } = await (supabase as any)
          .from('payments')
          .select('id, collection_id')
          .eq('id', paymentId)
          .single();
        if (paymentError || !payment) {
          throw paymentError ?? new Error('Không tìm thấy giao dịch thu');
        }
        collectionId = (payment as { collection_id?: string | null }).collection_id ?? null;
      }

      const outcome = await reverseInvoicePaymentBySource(
        (fn, args) => (supabase.rpc as any)(fn, args),
        {
          payment_id: paymentId,
          collection_id: collectionId,
          reversal_date: todayISO(),
          reason: 'Hoàn tác thu tiền từ giao diện hóa đơn',
          idempotency_key: collectionId
            ? `revcollection-${collectionId}`
            : `revpayment-${paymentId}`,
        },
      );

      return {
        payment_id: paymentId,
        collection_id: collectionId,
        mode: outcome.source === 'COLLECTION'
          ? 'COLLECTION_REVERSED'
          : 'LEGACY_PAYMENT_REVERSED',
      };
    },
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: ['invoice-payments-summary'] });
      queryClient.invalidateQueries({ queryKey: ['invoices'] });
      queryClient.invalidateQueries({ queryKey: ['invoice'] });
      queryClient.invalidateQueries({ queryKey: ['payments'] });
      queryClient.invalidateQueries({ queryKey: ['invoice-statistics'] });
      queryClient.invalidateQueries({ queryKey: ['income-expenses'] });
      queryClient.invalidateQueries({ queryKey: ['accounts-with-balance'] });
      queryClient.invalidateQueries({ queryKey: ['excess-amount'] });
      queryClient.invalidateQueries({ queryKey: ['invoice-collectors'] });
      queryClient.invalidateQueries({ queryKey: ['handover-vouchers'] });
      queryClient.invalidateQueries({ queryKey: ['first-invoice-details'] });
      queryClient.invalidateQueries({ queryKey: ['contract-deposit-vouchers'] });

      toast({
        title: result.mode === 'COLLECTION_REVERSED'
          ? 'Đã hoàn tác lần thu tiền'
          : 'Đã hoàn tác phiếu thanh toán cũ',
        description: result.mode === 'COLLECTION_REVERSED'
          ? 'Toàn bộ các dòng TM/TK/TT trong cùng collection đã được hoàn tác bằng bút toán đối ứng.'
          : 'Payment cũ đã được hoàn tác bằng adapter v3; lịch sử gốc được giữ nguyên.',
      });
    },
    onError: (error: Error) => {
      toast({
        variant: 'destructive',
        title: 'Không thể hoàn tác phiếu thanh toán',
        description: error.message,
      });
    },
  });
};
