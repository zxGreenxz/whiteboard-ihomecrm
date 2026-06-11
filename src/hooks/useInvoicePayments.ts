// =============================================
// Invoice Payments Hooks
// TanStack Query hooks for recording payments (RPC).
// Requirements: 7.1, 7.2
// =============================================

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { getSessionUser } from "@/lib/authSession";
import { useToast } from '@/hooks/use-toast';
import { getInvoiceShortTitle } from '@/lib/invoiceUtils';

// =============================================
// Types
// =============================================

export interface RecordPaymentRPCData {
  invoice_id: string;
  amount: number;
  payment_method: string;
  payment_date: string;
  notes?: string;
  receipt_image_url?: string;
  /** Sổ quỹ tiếp nhận khoản thu — required to mirror Resident's flow
   * (mỗi payment ⇒ 1 phiếu thu trong Thu chi). */
  account_id?: string | null;
  /** Tiền thối lại cho khách (chênh khách đưa vs còn phải thu). */
  change_amount?: number;
  /** Sổ quỹ ghi tiền thối — bắt buộc nếu change_amount > 0. */
  change_account_id?: string | null;
  /** Nếu > 0: giữ chỗ tiền thối làm credit cho contract (excess_amounts row).
   *  KHÔNG khấu trừ vào amount của phiếu thu. Chỉ set trên ĐÚNG MỘT call
   *  trong loop nhiều line (line TM cuối). */
  credit_amount?: number;
  /** Làm tròn tiền thiếu (residual < 10K) — metadata audit gắn lên phiếu
   *  thu INCOME, KHÔNG ảnh hưởng số dư sổ quỹ. Trigger DB tự mark invoice
   *  PAID khi residual < 10K. */
  rounding_amount?: number;
  /** Sổ quỹ "Làm tròn tiền thiếu" — bắt buộc nếu rounding_amount > 0. */
  rounding_account_id?: string | null;
}

// =============================================
// useRecordPaymentRPC - Mutation calling RPC record_invoice_payment
// Requirements: 7.1, 7.2
// =============================================

export const useRecordPaymentRPC = () => {
  const queryClient = useQueryClient();
  const { toast } = useToast();

  return useMutation({
    mutationFn: async (data: RecordPaymentRPCData) => {
      const user = await getSessionUser();
      if (!user) throw new Error('Not authenticated');

      // RBAC v2: bỏ p_user_id; quyền xác định qua can_do_on_building.
      const { data: result, error } = await (supabase.rpc as any)(
        'record_invoice_payment_v2',
        {
          p_invoice_id: data.invoice_id,
          p_amount: data.amount,
          p_payment_method: data.payment_method,
          p_payment_date: data.payment_date,
          p_notes: data.notes ?? null,
          p_receipt_image_url: data.receipt_image_url ?? null,
        },
      );

      if (error) throw error;

      const newPaymentId = (result as any)?.payment_id ?? null;

      // ─────────────────────────────────────────────────────
      // Mirror Resident: every invoice payment ⇒ 1 phiếu thu
      // ─────────────────────────────────────────────────────
      // Fetch the invoice details we need to seed the voucher.
      const { data: inv } = await supabase
        .from('invoices')
        .select(
          'id, invoice_number, building_id, room_id, contract_id, billing_month, tenant_id:contract_id, notes, invoice_items(type), building:buildings!invoices_building_id_fkey(id, name), room:rooms!invoices_room_id_fkey(id, name)'
        )
        .eq('id', data.invoice_id)
        .single() as any;

      const { data: incTypes, error: incTypesErr } = await supabase
        .from('income_expense_types' as any)
        .select('id, is_default, type, name')
        .eq('type', 'income')
        .limit(50) as any;
      if (incTypesErr) throw incTypesErr;
      const types = (incTypes ?? []) as Array<{ id: string; is_default?: boolean }>;
      const incomeTypeId = types.find((t) => t.is_default)?.id || types[0]?.id;

      if (inv && data.account_id) {
        if (!incomeTypeId) {
          throw new Error(
            'Chưa có loại thu nào trong "Loại thu/chi". Vào Cài đặt → Loại thu/chi để tạo trước.',
          );
        }

        const meta = (user.user_metadata ?? {}) as Record<string, any>;
        const creatorName: string =
          meta.full_name || meta.name || user.email || 'Người dùng';

        const change = data.change_amount ?? 0;
        const credit = data.credit_amount ?? 0;
        const rounding = data.rounding_amount ?? 0;
        const grossPaid = data.amount + change;
        const refundNote = change > 0
          ? `Thu ${grossPaid.toLocaleString('vi-VN')} – Thối ${change.toLocaleString('vi-VN')}`
          : credit > 0
            ? `Thu ${data.amount.toLocaleString('vi-VN')} – Nợ khách ${credit.toLocaleString('vi-VN')} (trừ kỳ sau)`
            : rounding > 0
              ? `Thu ${data.amount.toLocaleString('vi-VN')} – Làm tròn thiếu ${rounding.toLocaleString('vi-VN')}`
              : null;
        const composedNotes = [data.notes?.trim() || null, refundNote]
          .filter(Boolean)
          .join(' — ') || null;

        const { data: voucher, error: vErr } = await supabase
          .from('income_expenses' as any)
          .insert({
            user_id: user.id,
            type: 'INCOME',
            name: `Thu tiền theo HĐ ${getInvoiceShortTitle(inv as any)}`,
            building_id: inv.building_id,
            room_id: inv.room_id,            contract_id: inv.contract_id,
            account_id: data.account_id,
            invoice_id: inv.id,
            payment_id: newPaymentId,
            voucher_date: data.payment_date,
            payer_name: data.notes ?? null,
            notes: composedNotes,
            attachments: data.receipt_image_url ? [data.receipt_image_url] : [],
            approval_status: 'APPROVED',
            creator_name: creatorName,
            change_amount: change,
            change_account_id: data.change_account_id ?? null,
            rounding_amount: rounding,
            rounding_account_id: rounding > 0 ? (data.rounding_account_id ?? null) : null,
          } as any)
          .select()
          .single();

        if (vErr) throw vErr;

        const { error: itemErr } = await supabase
          .from('income_expense_items' as any)
          .insert({
            income_expense_id: (voucher as any).id,
            income_expense_type_id: incomeTypeId,
            description: `Thanh toán HĐ ${getInvoiceShortTitle(inv as any)}`,
            quantity: 1,
            unit_price: data.amount,
            start_date: data.payment_date,
            end_date: data.payment_date,
          });
        if (itemErr) throw itemErr;
      }
      // ─────────────────────────────────────────────────────

      // Tiền thối không còn tạo phiếu chi riêng — chỉ là metadata
      // change_amount + change_account_id trên phiếu thu INCOME (đã ghi ở trên).
      //
      // Khi keep_as_credit: pass amount = full TM (không khấu trừ change), RPC
      // record_invoice_payment tự INSERT excess_amounts row khi paid > total.
      // Frontend không cần insert thủ công.

      return result;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['invoices'] });
      queryClient.invalidateQueries({ queryKey: ['invoice'] });
      queryClient.invalidateQueries({ queryKey: ['payments'] });
      queryClient.invalidateQueries({ queryKey: ['invoice-statistics'] });
      queryClient.invalidateQueries({ queryKey: ['excess-amount'] });
      queryClient.invalidateQueries({ queryKey: ['income-expenses'] });
      queryClient.invalidateQueries({ queryKey: ['accounts-with-balance'] });
      queryClient.invalidateQueries({ queryKey: ['excess-amount'] });

      toast({
        title: 'Thanh toán đã được ghi nhận thành công',
        description: 'Thanh toán đã được ghi nhận vào hệ thống.',
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
  amount: number;          // positive number — the refund cash out
  payment_date: string;
  account_id: string;      // sổ quỹ chi tiền ra
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

      // Pick / create an expense category for refund.
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

      // The `[Hoàn trả thanh lý]` prefix is the marker recompute_invoice_for_id
      // looks for to count this voucher against a negative-total invoice.
      // Marker [Hoàn trả thanh lý] bắt buộc giữ — recompute_invoice_for_id
      // match prefix này để cộng dồn refund vào paid_amount.
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
          room_id: inv.room_id,          contract_id: inv.contract_id,
          account_id: data.account_id,
          invoice_id: inv.id,
          voucher_date: data.payment_date,
          total_amount: data.amount,
          attachments: [],
          approval_status: 'APPROVED',
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

      toast({
        title: 'Hoàn trả đã được ghi nhận',
        description: 'Phiếu chi đã được lập trong Thu chi.',
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
