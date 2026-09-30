import {useRef} from 'react';
import {useOrganization} from '@/contexts/OrganizationContext';
import {persistentFinancialWorkflow} from '@/lib/persistentFinancialWorkflow';
import {FinancialWorkflowError,workflowErrorMessage} from '@/lib/financialWorkflow';
import {runDurableCollection,reconcilePendingCollection} from '@/lib/pendingCollection';
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
      const result = await runDurableCollection(scope,idempotencyKey,async()=>confirmedCollection(await recordInvoiceCollectionV5(
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
        idempotencyKey,
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
      toast({
        variant: 'destructive',
        title: 'Có lỗi xảy ra khi ghi nhận thanh toán',
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
      return workflow.current.run(data.invoice_id,'lập phiếu hoàn trả',async progress=>{
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
      if (error) throw error;

      const id=(result as {refundVoucherId?:string;voucher_id?:string}|null)?.refundVoucherId ?? (result as {voucher_id?:string}|null)?.voucher_id;
      if(typeof id!=='string'||!id)throw new TypeError('Chưa xác nhận được mã phiếu hoàn trả.');
      progress.completed.push({id,label:`Đã lập phiếu hoàn trả: ${id}`});
      progress.stage='kiểm tra trạng thái phiếu hoàn trả';
      const receipt=await readCreatedVoucherReceipt({voucher_id:id});
      if(createdVoucherFeedback(receipt).kind==='warning')throw new TypeError('Chưa đọc được trạng thái duyệt và thu/chi của phiếu hoàn trả.');
      return receipt;
      },undefined,selectedOrganizationId??undefined);
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
      toast({
        variant: 'destructive',
        title: 'Có lỗi khi ghi nhận hoàn trả',
        description: error instanceof FinancialWorkflowError ? workflowErrorMessage(error,"lập phiếu hoàn trả") : invoiceFailureMessage(error, "lập phiếu hoàn trả"),
      });
    },
  });
};
