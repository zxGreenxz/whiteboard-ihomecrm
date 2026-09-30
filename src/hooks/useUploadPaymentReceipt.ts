import {persistentFinancialWorkflow} from '@/lib/persistentFinancialWorkflow';
import {FinancialWorkflowError,workflowErrorMessage} from '@/lib/financialWorkflow';
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
  const workflow=persistentFinancialWorkflow("payment-receipt-upload",{scope:"actor"});
  const queryClient = useQueryClient();
  const { toast } = useToast();

  return useMutation({
    mutationFn: async ({ payment_id, file }: UploadPaymentReceiptData) => {
      const invalid = validateReceiptFile(file);
      if (invalid) throw new FinancialWorkflowError(invalid,"failure",[]);
      return workflow.run(payment_id,`thêm ảnh ${file.name} vào phiếu thu`,async progress=>{

      const { data: payment, error: paymentError } = await supabase
        .from('payments')
        .select('id, collection_id')
        .eq('id', payment_id)
        .single();
      if (paymentError || !payment || payment.id!==payment_id) {
        throw paymentError ?? new FinancialWorkflowError('Chưa đọc được đúng phiếu thanh toán. Tải lại phiếu trước khi bổ sung ảnh.', 'failure', []);
      }
      if (payment.collection_id) {
        throw new FinancialWorkflowError('Lần thu này không hỗ trợ bổ sung ảnh sau khi đã ghi nhận. Mở phiếu thu để kiểm tra chứng từ.','failure',[]);
      }

      const url = await uploadReceiptToStorage(file);
      if(typeof url!=="string" || !url)throw new TypeError("Chưa xác nhận ảnh đã tải lên.");
      progress.completed.push({id:payment_id,label:`Đã tải ảnh ${file.name}; cần kiểm tra ảnh trên phiếu thu ${payment_id}`});
      progress.stage="gắn ảnh vào phiếu thu";

      // 1. Cập nhật payments.receipt_image_url (ảnh hiển thị trên popup).
      const { data: updated, error: updPErr } = await supabase
        .from('payments')
        .update({ receipt_image_url: url })
        .eq('id', payment_id)
        .select('id')
        .single();
      if (updPErr) throw updPErr;
      if(updated?.id!==payment_id)throw new TypeError('Chưa xác nhận ảnh đã gắn vào đúng phiếu thu.');
      progress.completed[0]!.label=`Đã gắn ảnh ${file.name} vào phiếu thu ${payment_id}`;
      progress.stage='bổ sung chứng từ vào phiếu thu chi liên quan';

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
        if(voucher.attachments!==null && (!Array.isArray(voucher.attachments)||voucher.attachments.some(item=>typeof item!=='string')))throw new TypeError('Chưa đọc đủ chứng từ của phiếu thu chi liên quan.');
        const existing: string[]=Array.isArray(voucher.attachments)?voucher.attachments.filter((item):item is string=>typeof item==='string'):[];
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
          const {data:receipt,error:receiptError}=await supabase.from('income_expenses').select('id,attachments').eq('id',voucher.id).single();
          if(receiptError || receipt?.id!==voucher.id || !Array.isArray(receipt.attachments) || !receipt.attachments.includes(url))throw new TypeError('Ảnh đã gắn vào phiếu thu nhưng chưa xác nhận được phiếu thu chi liên quan.');
          progress.completed.push({id:voucher.id,label:`Đã bổ sung ảnh vào phiếu thu chi ${voucher.id}`});
          voucherUpdated = true;
        }
      }

      return { url, voucher_id: voucher?.id ?? null, voucherUpdated };
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['invoice-payments-summary'] });
      queryClient.invalidateQueries({ queryKey: ['payments'] });
      queryClient.invalidateQueries({ queryKey: ['income-expenses'] });
      toast({ title: 'Đã thêm ảnh chứng từ' });
    },
    onError: (error:unknown,variables:UploadPaymentReceiptData) => {
      if(error instanceof FinancialWorkflowError && error.completed.length)for(const key of ['invoice-payments-summary','payments','income-expenses'])queryClient.invalidateQueries({queryKey:[key]});
      toast({
        variant: 'destructive',
        title: `Chưa hoàn tất thêm ảnh ${variables.file.name}`,
        description: workflowErrorMessage(error,'thêm ảnh chứng từ'),
      });
    },
  });
};
