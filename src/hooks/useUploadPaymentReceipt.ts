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

      const url = await uploadReceiptToStorage(file);

      // 1. Cập nhật payments.receipt_image_url (ảnh hiển thị trên popup).
      const { data: updated, error: updPErr } = await (supabase as any)
        .from('payments')
        .update({ receipt_image_url: url })
        .eq('id', payment_id)
        .select('id')
        .single();
      if (updPErr) throw updPErr;
      if (!updated) throw new Error('Bạn không có quyền cập nhật phiếu thu này.');

      // 2. Append vào income_expenses.attachments của voucher liên kết.
      const { data: voucher, error: vErr } = await (supabase as any)
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
          const { error: updVErr } = await (supabase as any)
            .from('income_expenses')
            .update({ attachments: next })
            .eq('id', voucher.id);
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
