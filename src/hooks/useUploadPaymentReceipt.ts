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
import { getSessionUser } from "@/lib/authSession";
import { useToast } from '@/hooks/use-toast';

interface UploadPaymentReceiptData {
  payment_id: string;
  file: File;
}

const uploadToStorage = async (file: File): Promise<string> => {
  const user = await getSessionUser();
  if (!user) throw new Error('Not authenticated');

  const ext = (file.name.split('.').pop() || 'png').toLowerCase();
  const fileName = `${user.id}/${Date.now()}_receipt.${ext}`;

  const { error } = await supabase.storage
    .from('payment-receipts')
    .upload(fileName, file, { cacheControl: '3600', upsert: false });

  if (error) {
    // Fallback bucket nếu payment-receipts không tồn tại / không có quyền.
    const fallbackPath = `receipts/${fileName}`;
    const { error: fbErr } = await supabase.storage
      .from('documents')
      .upload(fallbackPath, file, { cacheControl: '3600', upsert: false });
    if (fbErr) throw fbErr;
    const { data: urlData } = supabase.storage
      .from('documents')
      .getPublicUrl(fallbackPath);
    return urlData.publicUrl;
  }

  const { data: urlData } = supabase.storage
    .from('payment-receipts')
    .getPublicUrl(fileName);
  return urlData.publicUrl;
};

export const useUploadPaymentReceipt = () => {
  const queryClient = useQueryClient();
  const { toast } = useToast();

  return useMutation({
    mutationFn: async ({ payment_id, file }: UploadPaymentReceiptData) => {
      if (!file.type.startsWith('image/')) {
        throw new Error('Vui lòng chọn file ảnh (jpg, png, gif…)');
      }
      if (file.size > 5 * 1024 * 1024) {
        throw new Error('Kích thước file không được vượt quá 5MB');
      }

      const url = await uploadToStorage(file);

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
