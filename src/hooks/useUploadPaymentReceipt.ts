// =============================================
// useUploadPaymentReceipt
// Upload ảnh chứng từ cho 1 phiếu thu đã tồn tại:
//   1. Upload file lên Storage (payment-receipts → fallback documents)
//   2. UPDATE payments.receipt_image_url (đặt làm ảnh hiển thị trên popup)
//   3. Append URL vào income_expenses.attachments của phiếu Thu/Chi liên kết
//      (qua payment_id) để chứng từ xuất hiện cả ở Thu chi.
// =============================================

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useToast } from '@/hooks/use-toast';
import { uploadReceiptToStorage, validateReceiptFile } from '@/lib/receiptUpload';

interface UploadPaymentReceiptData {
  payment_id: string;
  file: File;
}

export const useUploadPaymentReceipt = () => {
  const queryClient = useQueryClient();
  const { toast } = useToast();

  return useMutation({
    mutationFn: async ({ payment_id, file }: UploadPaymentReceiptData) => {
      const invalid = validateReceiptFile(file);
      if (invalid) throw new Error(invalid);

      const { data: payment, error: paymentError } = await supabase
        .from('payments')
        .select('id, collection_id')
        .eq('id', payment_id)
        .single();
      if (paymentError || !payment) {
        throw paymentError ?? new Error('Không tìm thấy phiếu thanh toán');
      }
      if (payment.collection_id) {
        throw new Error(
          'Lần thu V5 đã khóa bất biến. Hiện chưa có RPC được ủy quyền để bổ sung ảnh; hãy đính ảnh ngay khi thu hoặc hoàn tác rồi ghi lại.',
        );
      }

      const url = await uploadReceiptToStorage(file);

      // 1. Cập nhật payments.receipt_image_url (ảnh hiển thị trên popup).
      const { data: updated, error: updPErr } = await supabase
        .from('payments')
        .update({ receipt_image_url: url })
        .eq('id', payment_id)
        .select('id')
        .single();
      if (updPErr) throw updPErr;
      if (!updated) throw new Error('Bạn không có quyền cập nhật phiếu thu này.');

      // 2. Append vào income_expenses.attachments của voucher liên kết.
      const { data: voucher, error: vErr } = await supabase
        .from('income_expenses')
        .select('id, attachments')
        .eq('payment_id', payment_id)
        .limit(1)
        .maybeSingle();
      if (vErr) throw vErr;

      let voucherUpdated = false;
      if (voucher) {
        const existing: string[] = Array.isArray(voucher.attachments)
          ? (voucher.attachments as string[])
          : [];
        if (!existing.includes(url)) {
          const next = [...existing, url];
          // Stage-7 drain: append attachments qua RPC ie_compat_update_pending_v2
          // (metadata — server cho sửa khi phiếu chưa huỷ, không đụng trục tiền).
          const { error: updVErr } = await supabase.rpc(
            'ie_compat_update_pending_v2',
            {
              p_id: voucher.id,
              p_patch: { attachments: next },
              p_items: null,
            },
          );
          if (updVErr) throw updVErr;
          voucherUpdated = true;
        }
      }

      return { url, voucher_id: voucher?.id ?? null, voucherUpdated };
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['invoice-payments-summary'] });
      queryClient.invalidateQueries({ queryKey: ['payments'] });
      queryClient.invalidateQueries({ queryKey: ['income-expenses'] });
      toast({ title: 'Đã thêm ảnh chứng từ' });
    },
    onError: (error: Error) => {
      toast({
        variant: 'destructive',
        title: 'Không thể thêm ảnh chứng từ',
        description: error.message,
      });
    },
  });
};
