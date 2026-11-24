import {useRef} from 'react';
import {persistentFinancialWorkflow} from '@/lib/persistentFinancialWorkflow';
import {FinancialAlreadyRecordedError,FinancialWorkflowError,workflowErrorMessage} from '@/lib/financialWorkflow';
// =============================================
// useUploadPaymentReceipt
// Upload ảnh chứng từ cho 1 phiếu thu đã tồn tại:
//   1. Upload file lên Storage (payment-receipts → fallback documents)
//   2. UPDATE payments.receipt_image_url (đặt làm ảnh hiển thị trên popup)
//   3. Append URL vào income_expenses.attachments của phiếu Thu/Chi liên kết
//      (qua payment_id) để chứng từ xuất hiện cả ở Thu chi.
//
// Đối chiếu sau rớt mạng (đợt 2, 24/11/2026) theo cách C — đọc trạng thái: ô ảnh của
// phiếu thanh toán chỉ được bổ sung khi còn trống (PaymentsSummaryDialog), nên ô đã có
// ảnh nghĩa là lần gửi trước đã gắn xong bước 2. Phép đọc phiếu thanh toán nằm NGOÀI
// vùng giữ dấu: đọc hỏng thì chưa có gì được ghi.
// =============================================

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useToast } from '@/hooks/use-toast';
import { uploadReceiptToStorage, validateReceiptFile } from '@/lib/receiptUpload';

interface UploadPaymentReceiptData {
  payment_id: string;
  file: File;
}

/** Phiếu thu chi liên quan không nhận nối ảnh: đang chờ duyệt (0A000) hoặc đã huỷ (55000). */
export type ReceiptVoucherBlock = 'PENDING' | 'CANCELLED';
export interface UploadPaymentReceiptResult {
  url: string;
  voucher_id: string | null;
  voucherUpdated: boolean;
  voucherBlocked: ReceiptVoucherBlock | null;
}

// Tên thao tác được lưu vào dấu chờ đối chiếu và nhật ký tự gỡ: không nhúng tên tệp.
const OPERATION = 'thêm ảnh chứng từ vào phiếu thu';
const VOUCHER_BLOCK_TEXT: Record<ReceiptVoucherBlock, string> = {
  PENDING: 'Phiếu thu chi liên quan đang chờ duyệt nên chưa bổ sung ảnh vào đó; người duyệt sửa phiếu để thêm ảnh.',
  CANCELLED: 'Phiếu thu chi liên quan đã huỷ nên không bổ sung ảnh vào đó.',
};
const voucherBlockOf = (error: unknown): ReceiptVoucherBlock | null => {
  const code = error && typeof error === 'object' ? String((error as { code?: unknown }).code ?? '') : '';
  return code === '0A000' ? 'PENDING' : code === '55000' ? 'CANCELLED' : null;
};

export const useUploadPaymentReceipt = () => {
  // Một guard cho cả vòng đời hook: khoá "đang xử lý" trong bộ nhớ phải sống qua các lần render.
  const workflow=useRef(persistentFinancialWorkflow("payment-receipt-upload",{scope:"actor"}));
  const queryClient = useQueryClient();
  const { toast } = useToast();

  return useMutation({
    mutationFn: async ({ payment_id, file }: UploadPaymentReceiptData): Promise<UploadPaymentReceiptResult> => {
      const invalid = validateReceiptFile(file);
      if (invalid) throw new FinancialWorkflowError(invalid,"failure",[]);

      const { data: payment, error: paymentError } = await supabase
        .from('payments')
        .select('id, collection_id, receipt_image_url')
        .eq('id', payment_id)
        .single();
      if (paymentError || !payment || payment.id!==payment_id) {
        throw paymentError ?? new FinancialWorkflowError('Chưa đọc được đúng phiếu thanh toán. Tải lại phiếu trước khi bổ sung ảnh.', 'failure', []);
      }
      if (payment.collection_id) {
        throw new FinancialWorkflowError('Lần thu này không hỗ trợ bổ sung ảnh sau khi đã ghi nhận. Mở phiếu thu để kiểm tra chứng từ.','failure',[]);
      }

      return workflow.current.run(payment_id,OPERATION,async progress=>{
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
      let voucherBlocked: ReceiptVoucherBlock | null = null;
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
          // Phiếu đang chờ duyệt hoặc đã huỷ: máy chủ từ chối TRƯỚC khi sửa. Ảnh đã nằm trên phiếu thanh toán;
          // đây là kết luận rõ, báo riêng và không giữ dấu chờ đối chiếu.
          voucherBlocked = voucherBlockOf(updVErr);
          if (updVErr && !voucherBlocked) throw updVErr;
          if (!voucherBlocked) {
            const {data:receipt,error:receiptError}=await supabase.from('income_expenses').select('id,attachments').eq('id',voucher.id).single();
            if(receiptError || receipt?.id!==voucher.id || !Array.isArray(receipt.attachments) || !receipt.attachments.includes(url))throw new TypeError('Ảnh đã gắn vào phiếu thu nhưng chưa xác nhận được phiếu thu chi liên quan.');
            progress.completed.push({id:voucher.id,label:`Đã bổ sung ảnh vào phiếu thu chi ${voucher.id}`});
            voucherUpdated = true;
          }
        }
      }

      return { url, voucher_id: voucher?.id ?? null, voucherUpdated, voucherBlocked };
      },
      // Cách C: phiếu thanh toán (đọc ngay trước lượt này) đã có ảnh ⇒ lần gửi trước đã gắn xong ảnh; báo người dùng
      // kiểm tra rồi tự quyết có thay ảnh không. Chưa có ảnh ⇒ lần trước chưa gắn; lõi chỉ cho làm lại khi lần đó
      // chắc chắn đã kết thúc (quá 2 phút), trước đó báo chờ.
      async()=>payment.receipt_image_url
        ? {outcome:'already-written',message:'Ảnh chứng từ đã được gắn vào phiếu thanh toán ở lần gửi trước. Mở phiếu thu chi liên quan để kiểm tra ảnh đã có ở đó chưa.',recordIds:[payment_id]}
        : {outcome:'not-written'});
    },
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: ['invoice-payments-summary'] });
      queryClient.invalidateQueries({ queryKey: ['payments'] });
      queryClient.invalidateQueries({ queryKey: ['income-expenses'] });
      toast(result.voucherBlocked
        ? { title: 'Đã thêm ảnh vào phiếu thanh toán', description: VOUCHER_BLOCK_TEXT[result.voucherBlocked] }
        : { title: 'Đã thêm ảnh chứng từ' });
    },
    onError: (error:unknown,variables:UploadPaymentReceiptData) => {
      if(error instanceof FinancialAlreadyRecordedError || (error instanceof FinancialWorkflowError && error.completed.length))for(const key of ['invoice-payments-summary','payments','income-expenses'])queryClient.invalidateQueries({queryKey:[key]});
      toast({
        variant: 'destructive',
        title: `Chưa hoàn tất thêm ảnh ${variables.file.name}`,
        description: workflowErrorMessage(error,'thêm ảnh chứng từ'),
      });
    },
  });
};
