// =============================================
// Invoice Payments Hooks
// =============================================

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { getSessionUser } from '@/lib/authSession';
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

      const collectionInput: RecordInvoiceCollectionInput = {
        invoice_id: data.invoice_id,
        collection_date: data.collection_date,
        tenders: data.tenders,
        overpay_action: data.overpay_action,
        allow_rounding: data.allow_rounding,
        notes: data.notes ?? null,
        receipt_image_url: data.receipt_image_url ?? null,
        expected_paid_amount: data.expected_paid_amount,
      };
      planInvoiceCollection(data);
      const idempotencyKey = data.idempotency_key ?? `collect-${crypto.randomUUID()}`;

      return recordInvoiceCollectionV5(
        (fn, args) => (supabase.rpc as any)(fn, args),
        collectionInput,
        idempotencyKey,
      );
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['invoices'] });
      queryClient.invalidateQueries({ queryKey: ['invoice'] });
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
        title: 'Thanh toán đã được ghi nhận thành công',
        description: 'Toàn bộ phương thức đã được ghi trong cùng một lần thu.',
      });
    },
    onError: (error: Error) => {
      toast({
        variant: 'destructive',
        title: 'Có lỗi xảy ra khi ghi nhận thanh toán',
        description: error.message,
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

  return useMutation({
    mutationFn: async (data: RecordRefundRPCData) => {
      const user = await getSessionUser();
      if (!user) throw new Error('Not authenticated');

      if (data.amount <= 0) throw new Error('Số tiền hoàn trả phải > 0');

      const { data: result, error } = await (supabase.rpc as any)(
        'create_invoice_refund_obligation_v2',
        {
          p_invoice_id: data.invoice_id,
          p_amount: data.amount,
          p_reason: data.notes ?? null,
          p_idempotency_key: `refund-${crypto.randomUUID()}`,
        },
      );
      if (error) throw error;

      return {
        voucher_id:
          (result as { voucher_id?: string } | null)?.voucher_id ?? null,
      };
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['invoices'] });
      queryClient.invalidateQueries({ queryKey: ['invoice'] });
      queryClient.invalidateQueries({ queryKey: ['payments'] });
      queryClient.invalidateQueries({ queryKey: ['invoice-statistics'] });
      queryClient.invalidateQueries({ queryKey: ['income-expenses'] });
      queryClient.invalidateQueries({ queryKey: ['accounts-with-balance'] });
      queryClient.invalidateQueries({ queryKey: ['first-invoice-details'] });
      queryClient.invalidateQueries({ queryKey: ['invoice-payments-summary'] });

      toast({
        title: 'Đã lập phiếu hoàn trả (chờ duyệt)',
        description:
          'Phiếu chi hoàn trả đang ở trạng thái Chờ duyệt trong Thu chi — cần duyệt trước khi tính vào sổ.',
      });
    },
    onError: (error: Error) => {
      toast({
        variant: 'destructive',
        title: 'Có lỗi khi ghi nhận hoàn trả',
        description: error.message,
      });
    },
  });
};
