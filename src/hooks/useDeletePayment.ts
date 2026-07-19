// =============================================
// useDeletePayment
// T5_20: mặc định đi CANONICAL reverse_invoice_payment_v3 — "xoá" = HOÀN TÁC
// (bút toán đối ứng, giữ nguyên payment + voucher gốc, paid_amount tự trừ).
// Fallback legacy (xoá thật) khi: payment cũ có phiếu cặp [THU TACH COC] hoặc
// tín hiệu fallback hợp lệ (writer chưa bật / 42501 coexistence).
//
// Đường LEGACY: xóa 1 phiếu thanh toán (payments row) cùng với phiếu Thu/Chi
// liên kết (income_expenses) và credit excess_amounts (nếu có).
//
// Quy trình:
//   1. Soft-delete income_expenses voucher có payment_id = payment_id
//      (deleted_at = NOW())
//   1b. Soft-delete phiếu CỌC cặp CŨ nhận diện qua marker
//      "[THU TACH COC <payment_id>]" (cơ chế tách phiếu đã bỏ — chỉ còn
//      dữ liệu lịch sử).
//   2. Hard-delete excess_amounts có source_payment_id = payment_id
//      (credit "Nợ kỳ sau" sẽ huỷ theo)
//   3. Hard-delete payments row → trigger DB
//      recompute_invoice_after_payment_change tự cập nhật
//      invoices.paid_amount / status / paid_date.
// =============================================

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useToast } from '@/hooks/use-toast';
import { isCanonicalFallbackSignal } from '@/lib/canonicalFallback';

interface DeletePaymentInput {
  payment_id: string;
}

type DeletePaymentResult = { payment_id: string; mode: 'REVERSED' | 'DELETED' };

export const useDeletePayment = () => {
  const queryClient = useQueryClient();
  const { toast } = useToast();

  return useMutation({
    mutationFn: async ({ payment_id }: DeletePaymentInput): Promise<DeletePaymentResult> => {
      // ===== T5_20 canonical: HOÀN TÁC thay vì xoá (giữ lịch sử tiền) =====
      // reverse_invoice_payment_v3 tạo bút toán hoàn tác (EXPENSE đối ứng) +
      // negate credit thừa; payment gốc GIỮ NGUYÊN, paid_amount tự trừ lại.
      // NGOẠI LỆ đi legacy: payment CŨ có phiếu cặp "[THU TACH COC ...]" —
      // canonical không xử lý cặp, xoá legacy mới gỡ được cả phiếu cọc kèm.
      const { data: pairRows, error: pairChkErr } = await (supabase as any)
        .from('income_expenses')
        .select('id')
        .like('notes', `%[THU TACH COC ${payment_id}]%`)
        .is('deleted_at', null)
        .limit(1);
      const hasLegacyPair = !pairChkErr && ((pairRows as unknown[])?.length ?? 0) > 0;

      if (!hasLegacyPair) {
        const { error: revErr } = await (supabase as any).rpc('reverse_invoice_payment_v3', {
          p_payment_id: payment_id,
          p_reason: 'Hoàn tác thu tiền (xoá phiếu thanh toán từ giao diện)',
          p_idempotency_key: `revpay-${payment_id}`,
        });
        if (!revErr) return { payment_id, mode: 'REVERSED' };
        if (!isCanonicalFallbackSignal(revErr)) {
          // Lỗi nghiệp vụ thật từ canonical (vd "Giao dịch đã được hoàn tác")
          // — hiển thị thẳng, KHÔNG rơi xuống xoá legacy.
          throw new Error(
            String((revErr as { message?: string })?.message ?? 'Không thể hoàn tác phiếu thu'),
          );
        }
        // Tín hiệu fallback hợp lệ (writer chưa bật / không quyền canonical)
        // → tiếp tục đường xoá legacy bên dưới.
      }
      // 1. Soft-delete voucher Thu/Chi liên kết (nếu có).
      //    Trigger trg_ie_handover_guard chặn nếu phiếu đang nằm trong
      //    phiên bàn giao tiền mặt chưa hủy ([HANDOVER_LOCKED]).
      const handleVoucherErr = (err: any) => {
        if (String(err.message ?? '').includes('[HANDOVER_LOCKED]')) {
          throw new Error(
            'Phiếu thu này đang nằm trong phiên bàn giao tiền mặt. Hãy hủy phiên bàn giao (cần cả 2 bên xác nhận) trước khi hoàn tác.',
          );
        }
        throw err;
      };
      const { error: vErr } = await (supabase as any)
        .from('income_expenses')
        .update({ deleted_at: new Date().toISOString() })
        .eq('payment_id', payment_id)
        .is('deleted_at', null);
      if (vErr) handleVoucherErr(vErr);

      // 1b. DỮ LIỆU CŨ (trước khi bỏ cơ chế tách phiếu): 1 payment từng tách
      //     thành 2 phiếu — phiếu CỌC không mang payment_id, chỉ nhận diện qua
      //     marker "[THU TACH COC <payment_id>]" trong notes. Không xoá kèm sẽ
      //     mồ côi phiếu cọc → lệch sổ + deposit_paid ảo (trigger deposit tự
      //     recompute khi soft-delete). Phiếu MỚI (1 phiếu/lần thu) không có
      //     marker nên bước này no-op.
      const { error: pairErr } = await (supabase as any)
        .from('income_expenses')
        .update({ deleted_at: new Date().toISOString() })
        .like('notes', `%[THU TACH COC ${payment_id}]%`)
        .is('deleted_at', null);
      if (pairErr) handleVoucherErr(pairErr);

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

      return { payment_id, mode: 'DELETED' };
    },
    onSuccess: (res: DeletePaymentResult) => {
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
        title:
          res.mode === 'REVERSED'
            ? 'Đã hoàn tác phiếu thanh toán'
            : 'Đã xoá phiếu thanh toán',
        description:
          res.mode === 'REVERSED'
            ? 'Đã tạo bút toán hoàn tác (giữ lịch sử); số đã thu của hoá đơn được trừ lại.'
            : 'Phiếu Thu liên kết đã được xoá khỏi sổ Thu/Chi.',
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
