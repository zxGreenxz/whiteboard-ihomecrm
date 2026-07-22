// =============================================
// Invoice Payments Hooks
// =============================================

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { getSessionUser } from '@/lib/authSession';
import { useToast } from '@/hooks/use-toast';
import { getInvoiceShortTitle } from '@/lib/invoiceUtils';
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

      // TẠM KHÓA: giữ tiền thừa làm credit khách hàng chưa đối soát kế toán xong.
      // Fail-closed cho tới khi flag customer.credit.apply.v1 thành CANONICAL — bỏ guard này khi đó.
      if (data.overpay_action === 'CREDIT') {
        throw new Error('Tính năng giữ tiền thừa làm credit khách hàng đang tạm khóa để đối soát kế toán.');
      }

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
// (i.e. landlord owes tenant). Creates an EXPENSE voucher (Phiếu chi)
// linked to the invoice; recompute_invoice_for_id picks it up via the
// `[Hoàn trả thanh lý]` marker in notes and flips the invoice to PAID.
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

      const { data: inv, error: invErr } = await supabase
        .from('invoices')
        .select('id, invoice_number, building_id, room_id, contract_id, billing_month, total_amount, paid_amount, notes, invoice_items(type), building:buildings!invoices_building_id_fkey(id, name), room:rooms!invoices_room_id_fkey(id, name)')
        .eq('id', data.invoice_id)
        .single() as any;
      if (invErr || !inv) throw invErr ?? new Error('Không tìm thấy hoá đơn');

      const { data: existingType } = await supabase
        .from('income_expense_types' as any)
        .select('id')
        .eq('type', 'expense')
        .eq('name', 'Hoàn trả thanh lý')
        .limit(1)
        .maybeSingle() as any;

      let typeId: string | undefined = existingType?.id;
      if (!typeId) {
        const { data: created, error: cErr } = await supabase
          .from('income_expense_types' as any)
          .insert({
            user_id: user.id,
            type: 'expense',
            name: 'Hoàn trả thanh lý',
            description: 'Tự tạo khi ghi nhận hoàn trả hoá đơn thanh lý',
          })
          .select('id')
          .single() as any;
        if (cErr) throw cErr;
        typeId = created.id;
      }

      const meta = (user.user_metadata ?? {}) as Record<string, any>;
      const creatorName: string =
        meta.full_name || meta.name || user.email || 'Người dùng';

      const voucherNotes =
        '[Hoàn trả thanh lý] HĐ ' + getInvoiceShortTitle(inv as any) +
        (data.notes ? '\n' + data.notes : '');

      const { data: voucher, error: vErr } = await supabase
        .from('income_expenses' as any)
        .insert({
          user_id: user.id,
          type: 'EXPENSE',
          name: `Hoàn trả khách thanh lý — HĐ ${getInvoiceShortTitle(inv as any)}`,
          building_id: inv.building_id,
          room_id: inv.room_id,
          contract_id: inv.contract_id,
          account_id: data.account_id,
          invoice_id: inv.id,
          voucher_date: data.payment_date,
          total_amount: data.amount,
          attachments: [],
          approval_status: 'UNAPPROVED',
          creator_name: creatorName,
          notes: voucherNotes,
        } as any)
        .select()
        .single();
      if (vErr) throw vErr;

      const { error: itemErr } = await supabase
        .from('income_expense_items' as any)
        .insert({
          income_expense_id: (voucher as any).id,
          income_expense_type_id: typeId,
          description: `Hoàn trả khách — HĐ ${getInvoiceShortTitle(inv as any)}`,
          quantity: 1,
          unit_price: data.amount,
          start_date: data.payment_date,
          end_date: data.payment_date,
        });
      if (itemErr) throw itemErr;

      return { voucher_id: (voucher as any).id };
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
          'Phiếu chi hoàn trả đang ở trạng thái Nháp trong Thu chi — cần duyệt trước khi tính vào sổ.',
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
