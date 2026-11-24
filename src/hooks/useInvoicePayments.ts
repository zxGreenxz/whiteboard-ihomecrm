import {useRef} from 'react';
import {useOrganization} from '@/contexts/OrganizationContext';
import {persistentFinancialWorkflow} from '@/lib/persistentFinancialWorkflow';
import {FinancialAlreadyRecordedError,FinancialWorkflowError,workflowErrorMessage} from '@/lib/financialWorkflow';
import {runDurableCollection,reconcilePendingCollection,PriorCollectionSettledError} from '@/lib/pendingCollection';
import {lookupPendingCollection,collectionScopeForInvoice} from '@/lib/collectionRecovery';
import { readCreatedVoucherReceipt } from '@/lib/createdVoucherReceipt';
import { createdVoucherFeedback } from '@/lib/voucherFeedback';
import { invoiceFailureMessage } from '@/lib/invoiceFeedback';
import { collectionFailureMessage, collectionSuccessMessage, confirmedCollection } from '@/lib/collectionFeedback';
// =============================================
// Invoice Payments Hooks
// =============================================

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { getSessionUser } from '@/lib/authSession';
import { rpcNullable } from '@/lib/rpcNullable';
import { useToast } from '@/hooks/use-toast';
import {
  planInvoiceCollection,
  recordInvoiceCollectionV5,
  type InvoiceCollectionPlanningInput,
  type RecordInvoiceCollectionInput,
} from '@/lib/paymentRecordRpc';

export type RecordPaymentRPCData = InvoiceCollectionPlanningInput & {
  idempotency_key?: string;
};

export const useRecordPaymentRPC = () => {
  const queryClient = useQueryClient();
  const { toast } = useToast();

  return useMutation({
    mutationFn: async (data: RecordPaymentRPCData) => {
      const user = await getSessionUser();
      if (!user) throw new Error('Not authenticated');

      const prior=await reconcilePendingCollection(user.id,data.invoice_id,lookupPendingCollection);
      if(prior)return prior;
      const collectionInput: RecordInvoiceCollectionInput = {
        invoice_id: data.invoice_id,
        collection_date: data.collection_date,
        tenders: data.tenders,
        overpay_action: data.overpay_action,
        allow_rounding: data.allow_rounding,
        actual_change_amount: data.actual_change_amount,
        notes: data.notes ?? null,
        receipt_image_url: data.receipt_image_url ?? null,
        expected_paid_amount: data.expected_paid_amount,
      };
      planInvoiceCollection(data);
      const idempotencyKey = data.idempotency_key ?? `collect-${crypto.randomUUID()}`;

      const scope=await collectionScopeForInvoice(user.id,data.invoice_id);
      // `key` là khoá thật sự được gửi: còn dấu của lần thu trước thì đó là khoá CŨ của dấu (máy chủ chống trùng
      // theo khoá), không phải `idempotencyKey` của lượt này.
      const result = await runDurableCollection(scope,idempotencyKey,async key=>confirmedCollection(await recordInvoiceCollectionV5(
        // `p_notes`/`p_receipt_image_url` KHÔNG có DEFAULT (DDL migration
        // 20260802230000) nên bộ sinh khai `string` bắt buộc, trong khi thân hàm
        // xử lý NULL tường minh (`NULLIF(btrim(p_notes), '')`). Đúng khoảng trống
        // mà `rpcNullable` đặt tên — payload gửi đi không đổi một byte.
        (fn, args) => supabase.rpc(fn, {
          ...args,
          p_notes: rpcNullable(args.p_notes),
          p_receipt_image_url: rpcNullable(args.p_receipt_image_url),
        }),
        collectionInput,
        key,
      )),lookupPendingCollection);
      return confirmedCollection(result);
    },
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: ['invoices'] });
      queryClient.invalidateQueries({ queryKey: ['invoice-rounding-report'] });
      queryClient.invalidateQueries({ queryKey: ['invoice'] });
      // Thẻ Thanh toán & phiếu thu ở chi tiết hoá đơn đọc phiếu qua key này —
      // không làm mới thì lần thu vừa ghi hiện "Chưa nối phiếu thu" suốt staleTime.
      queryClient.invalidateQueries({ queryKey: ['invoice-vouchers'] });
      queryClient.invalidateQueries({ queryKey: ['payments'] });
      queryClient.invalidateQueries({ queryKey: ['invoice-statistics'] });
      queryClient.invalidateQueries({ queryKey: ['excess-amount'] });
      queryClient.invalidateQueries({ queryKey: ['income-expenses'] });
      queryClient.invalidateQueries({ queryKey: ['accounts-with-balance'] });
      queryClient.invalidateQueries({ queryKey: ['first-invoice-details'] });
      queryClient.invalidateQueries({ queryKey: ['invoice-payments-summary'] });
      queryClient.invalidateQueries({ queryKey: ['contract-deposit-vouchers'] });
      queryClient.invalidateQueries({ queryKey: ['invoice-collectors'] });
      queryClient.invalidateQueries({ queryKey: ['handover-vouchers'] });

      toast({
        title: 'Đã ghi nhận thu tiền',
        description: collectionSuccessMessage(result),
      });
    },
    onError: (error: Error) => {
      // Đối chiếu kết luận lần thu trước đã ghi (còn hiệu lực hoặc đã hoàn tác): hoá đơn trên màn đang cũ.
      if (error instanceof PriorCollectionSettledError) {
        for (const queryKey of [['invoices'], ['invoice'], ['payments'], ['invoice-payments-summary'], ['invoice-vouchers']]) queryClient.invalidateQueries({ queryKey });
      }
      toast({
        variant: 'destructive',
        title: error instanceof PriorCollectionSettledError ? 'Lần thu trước đã được ghi' : 'Có lỗi xảy ra khi ghi nhận thanh toán',
        description: collectionFailureMessage(error),
      });
    },
  });
};

// =============================================
// useRecordRefundRPC - For settlement invoices with NEGATIVE total
// (i.e. landlord owes tenant). Stage-7 drain: MỘT call server RPC
// create_invoice_refund_obligation_v2 tạo atomic phiếu chi hoàn trả
// PENDING ('Chờ duyệt') + reservation gắn hoá đơn — không còn raw insert
// income_expenses/_items từ client.
// =============================================

export interface RecordRefundRPCData {
  invoice_id: string;
  amount: number;
  payment_date: string;
  account_id: string;
  notes?: string;
}

export const useRecordRefundRPC = () => {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const {selectedOrganizationId}=useOrganization();
  const workflow=useRef(persistentFinancialWorkflow('invoice-refund'));

  return useMutation({
    mutationFn: async (data: RecordRefundRPCData) => {
      if(!Number.isFinite(data.amount)||data.amount<=0)throw new Error('Nhập số tiền hoàn trả hợp lệ lớn hơn 0.');
      const id=await workflow.current.run(data.invoice_id,'lập phiếu hoàn trả',async progress=>{
      const user = await getSessionUser();
      if (!user) throw new Error('Not authenticated');

      if (data.amount <= 0) throw new Error('Số tiền hoàn trả phải > 0');

      const { data: result, error } = await supabase.rpc(
        'create_invoice_refund_obligation_v2',
        {
          p_invoice_id: data.invoice_id,
          p_amount: data.amount,
          p_reason: data.notes ?? undefined,
          p_idempotency_key: progress.requestKey,
        },
      );
      // `reserve_invoice_refund_obligation_v2` tra khoá TRƯỚC khi khoá hoá đơn: gửi lại lúc lệnh cũ còn chạy trên máy
      // chủ thì lệnh sau vấp ràng buộc duy nhất của khoá (23505) và lùi. Đó không phải lời từ chối của lệnh cũ:
      // giữ dấu cùng mã để lần sau gửi lại nhận kết quả cũ, không gỡ dấu rồi lập lại bằng mã mới.
      if (error?.code === '23505') throw new FinancialWorkflowError('Yêu cầu lập phiếu hoàn trả trước có thể vẫn đang được máy chủ xử lý. Thử lại sau ít phút; hệ thống sẽ gửi lại đúng yêu cầu cũ, không lập phiếu thứ hai.','unknown',[],error);
      if (error) throw error;

      const voucherId=(result as {refundVoucherId?:string;voucher_id?:string}|null)?.refundVoucherId ?? (result as {voucher_id?:string}|null)?.voucher_id;
      if(typeof voucherId!=='string'||!voucherId)throw new TypeError('Chưa xác nhận được mã phiếu hoàn trả.');
      // Máy chủ trả lại phiếu của lần gửi trước (cùng mã) mà không so số tiền: lượt này không lập gì, số tiền vừa
      // nhập có thể khác. Báo đã lập kèm mã phiếu thay vì báo thành công cho số mới.
      if((result as {replayed?:unknown}|null)?.replayed===true)throw new FinancialAlreadyRecordedError(`Phiếu hoàn trả đã được lập ở lần gửi trước (mã ${voucherId}). Không lập thêm; mở phiếu để kiểm tra số tiền trước khi lập tiếp.`,[voucherId]);
      progress.completed.push({id:voucherId,label:`Đã lập phiếu hoàn trả: ${voucherId}`});
      return voucherId;
      },
      // Gửi lại cùng mã, nhưng CHỈ khi lần gửi trước chắc chắn đã kết thúc (quá 2 phút): `reserve_invoice_refund_obligation_v2`
      // (đọc thân hàm production 24/11/2026) tra khoá TRƯỚC khi khoá hoá đơn, nên lệnh gửi lại lúc lệnh cũ còn chạy có thể
      // vấp trần số được hoàn (55000) thay vì nhận lại phiếu cũ. Sau 2 phút phép tra khoá luôn thấy phiếu cũ nếu đã lập.
      async()=>({outcome:'not-written'}),
      selectedOrganizationId??undefined);
      // Đọc trạng thái duyệt SAU khi đã gỡ dấu: phiếu đã lập, phép đọc hỏng chỉ làm câu báo thành "cần kiểm tra".
      return readCreatedVoucherReceipt({voucher_id:id});
    },
    onSuccess: (receipt) => {
      queryClient.invalidateQueries({ queryKey: ['invoices'] });
      queryClient.invalidateQueries({ queryKey: ['invoice'] });
      queryClient.invalidateQueries({ queryKey: ['invoice-vouchers'] });
      queryClient.invalidateQueries({ queryKey: ['payments'] });
      queryClient.invalidateQueries({ queryKey: ['invoice-statistics'] });
      queryClient.invalidateQueries({ queryKey: ['income-expenses'] });
      queryClient.invalidateQueries({ queryKey: ['accounts-with-balance'] });
      queryClient.invalidateQueries({ queryKey: ['first-invoice-details'] });
      queryClient.invalidateQueries({ queryKey: ['invoice-payments-summary'] });

      const feedback=createdVoucherFeedback(receipt);
      toast({title:feedback.kind==='warning'?'Đã lập phiếu hoàn trả; cần kiểm tra trạng thái':'Đã lập phiếu hoàn trả',description:feedback.message});
    },
    onError: (error: Error) => {
      const already = error instanceof FinancialAlreadyRecordedError;
      if (already) for (const queryKey of [['invoices'], ['invoice'], ['invoice-vouchers'], ['income-expenses'], ['invoice-payments-summary']]) queryClient.invalidateQueries({ queryKey });
      toast({
        variant: 'destructive',
        title: already ? 'Phiếu hoàn trả đã được lập trước đó' : 'Có lỗi khi ghi nhận hoàn trả',
        description: error instanceof FinancialWorkflowError ? workflowErrorMessage(error,"lập phiếu hoàn trả") : invoiceFailureMessage(error, "lập phiếu hoàn trả"),
      });
    },
  });
};
