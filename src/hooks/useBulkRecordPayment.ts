// =============================================
// Bulk Record Payment Hook
// Loop qua nhiều hoá đơn, mỗi hoá đơn có thể có 3 sub-payment (TM/TK/TT).
//
// TIỀN THỐI: KHẤU TRỪ VÀO LINE TM (giống RecordPaymentDialog single):
//   - payments.amount của line TM = amount_tm - change_amount (net thực thu)
//   - income_expenses INCOME của line TM: gắn metadata change_amount +
//     change_account_id + notes "Thu X – Thối Y"
//   - KHÔNG tạo phiếu chi EXPENSE 'Tiền thối' lẻ → sổ "X Thối" giữ tồn quỹ 0,
//     đóng vai trò "ví audit" thuần qua change_account_id metadata.
//
// LƯU Ý: KHÔNG dùng RPC record_invoice_payment vì RPC đó check
// `WHERE user_id = p_user_id` (chỉ owner gọi được) — staff được RLS
// allow write nhưng RPC vẫn từ chối. Thay vào đó insert trực tiếp vào
// payments + income_expenses, dựa vào trigger DB recompute_invoice_for_id
// (migration 20260510000010) tự cập nhật paid_amount/status invoice.
//
// `user_id` của payment + voucher = owner của invoice (không phải staff)
// để RLS staff_can('invoices', ...) match đúng.
//
// KHÔNG invalidate per-iteration (chỉ 1 lần ở onSettled).
// =============================================

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useToast } from '@/hooks/use-toast';

export interface BulkPaymentItem {
  invoice_id: string;
  invoice_number?: string;
  room_name?: string;
  amount_tm: number;
  amount_tk: number;
  amount_tt: number;
  change_amount: number;
  account_id: string;
  change_account_id: string | null;
  receipt_image_url?: string | null;
  notes?: string;
}

export interface BulkPaymentParams {
  payment_date: string;
  items: BulkPaymentItem[];
}

export interface BulkPaymentFailure {
  invoice_id: string;
  invoice_number?: string;
  room_name?: string;
  message: string;
}

export interface BulkPaymentResult {
  ok: string[]; // invoice_ids
  failures: BulkPaymentFailure[];
}

export const useBulkRecordPayment = () => {
  const queryClient = useQueryClient();
  const { toast } = useToast();

  return useMutation({
    mutationFn: async (params: BulkPaymentParams): Promise<BulkPaymentResult> => {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) throw new Error('Not authenticated');

      // ── Cache income/expense types 1 lần cho cả batch ──
      const { data: incTypes, error: incTypesErr } = await (supabase
        .from('income_expense_types' as any)
        .select('id, is_default, type, name') as any)
        .eq('type', 'income')
        .limit(50);
      if (incTypesErr) throw incTypesErr;
      const types = (incTypes ?? []) as Array<{ id: string; is_default?: boolean }>;
      const incomeTypeId = types.find((t) => t.is_default)?.id || types[0]?.id;
      if (!incomeTypeId) {
        throw new Error(
          'Chưa có loại thu nào trong "Loại thu/chi". Vào Cài đặt → Loại thu/chi để tạo trước.',
        );
      }

      const meta = (user.user_metadata ?? {}) as Record<string, any>;
      const creatorName: string =
        meta.full_name || meta.name || user.email || 'Người dùng';

      const ok: string[] = [];
      const failures: BulkPaymentFailure[] = [];

      for (const item of params.items) {
        try {
          // ── Re-read invoice để có remaining mới nhất + metadata ──
          const { data: inv, error: invErr } = await (supabase
            .from('invoices')
            .select(
              'id, user_id, invoice_number, building_id, room_id, bed_id, contract_id, billing_month, total_amount, paid_amount, remaining_amount',
            )
            .eq('id', item.invoice_id)
            .single() as any);
          if (invErr || !inv) {
            throw new Error(invErr?.message || 'Không đọc được hoá đơn');
          }
          const remaining =
            Number(
              (inv as any).remaining_amount ??
                (inv as any).total_amount - (inv as any).paid_amount,
            ) || 0;
          if (remaining <= 0) {
            failures.push({
              invoice_id: item.invoice_id,
              invoice_number: item.invoice_number,
              room_name: item.room_name,
              message: 'Đã được thanh toán bởi người khác',
            });
            continue;
          }

          const subLines = [
            { method: 'TM', amount: item.amount_tm },
            { method: 'TK', amount: item.amount_tk },
            { method: 'TT', amount: item.amount_tt },
          ].filter((s) => s.amount > 0);

          if (subLines.length === 0 && item.change_amount === 0) {
            failures.push({
              invoice_id: item.invoice_id,
              invoice_number: item.invoice_number,
              room_name: item.room_name,
              message: 'Số tiền thanh toán bằng 0',
            });
            continue;
          }

          // Tiền thối khấu trừ vào line TM cuối cùng (giống single dialog).
          const change = item.change_amount || 0;
          let tmDeductIdx = -1;
          if (change > 0) {
            for (let i = subLines.length - 1; i >= 0; i--) {
              if (subLines[i].method === 'TM') {
                tmDeductIdx = i;
                break;
              }
            }
            if (tmDeductIdx === -1) {
              throw new Error('Tiền thối chỉ áp dụng cho TM, nhưng không có dòng TM');
            }
            if (subLines[tmDeductIdx].amount < change) {
              throw new Error('Tiền thối lớn hơn số tiền TM');
            }
            if (!item.change_account_id) {
              throw new Error('Thiếu sổ quỹ tiền thối');
            }
          }

          // ── Mỗi sub-line: INSERT payment + voucher INCOME (bypass RPC) ──
          // user_id = owner của invoice (RLS staff_can dùng owner làm scope)
          const ownerId = (inv as any).user_id as string;
          for (let i = 0; i < subLines.length; i++) {
            const line = subLines[i];
            const isFirst = i === 0;
            const isDeductLine = i === tmDeductIdx;
            const deducted = isDeductLine ? change : 0;
            const effectiveAmount = line.amount - deducted;
            if (effectiveAmount <= 0) {
              // Line bị khấu trừ hết → không tạo phiếu.
              continue;
            }

            const grossPaid = effectiveAmount + deducted;
            const refundNote = deducted > 0
              ? `Thu ${grossPaid.toLocaleString('vi-VN')} – Thối ${deducted.toLocaleString('vi-VN')}`
              : null;
            const composedNotes =
              [item.notes?.trim() || null, refundNote].filter(Boolean).join(' — ') || null;

            const { data: paymentRow, error: payErr } = await supabase
              .from('payments' as any)
              .insert({
                user_id: ownerId,
                invoice_id: item.invoice_id,
                amount: effectiveAmount,
                payment_method: line.method,
                payment_date: params.payment_date,
                notes: item.notes ?? null,
                receipt_image_url:
                  isFirst ? (item.receipt_image_url ?? null) : null,
              } as any)
              .select('id')
              .single();
            if (payErr) throw payErr;
            const newPaymentId = (paymentRow as any)?.id ?? null;

            const { data: voucher, error: vErr } = await supabase
              .from('income_expenses' as any)
              .insert({
                user_id: ownerId,
                type: 'INCOME',
                name: `Thu tiền theo hóa đơn ${(inv as any).invoice_number || ''} - ${(inv as any).billing_month || ''}`,
                building_id: (inv as any).building_id,
                room_id: (inv as any).room_id,
                bed_id: (inv as any).bed_id,
                contract_id: (inv as any).contract_id,
                account_id: item.account_id,
                invoice_id: (inv as any).id,
                payment_id: newPaymentId,
                voucher_date: params.payment_date,
                payer_name: item.notes ?? null,
                notes: composedNotes,
                attachments:
                  isFirst && item.receipt_image_url
                    ? [item.receipt_image_url]
                    : [],
                approval_status: 'APPROVED',
                creator_name: creatorName,
                change_amount: deducted,
                change_account_id: isDeductLine ? (item.change_account_id ?? null) : null,
              } as any)
              .select()
              .single();
            if (vErr) throw vErr;

            const { error: itemErr } = await supabase
              .from('income_expense_items' as any)
              .insert({
                income_expense_id: (voucher as any).id,
                income_expense_type_id: incomeTypeId,
                description: `Thanh toán hoá đơn ${(inv as any).invoice_number || ''}`,
                quantity: 1,
                unit_price: effectiveAmount,
                start_date: params.payment_date,
                end_date: params.payment_date,
              });
            if (itemErr) throw itemErr;
          }

          ok.push(item.invoice_id);
        } catch (e: any) {
          failures.push({
            invoice_id: item.invoice_id,
            invoice_number: item.invoice_number,
            room_name: item.room_name,
            message: e?.message || 'Lỗi không xác định',
          });
        }
      }

      return { ok, failures };
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ['invoices'] });
      queryClient.invalidateQueries({ queryKey: ['invoice'] });
      queryClient.invalidateQueries({ queryKey: ['payments'] });
      queryClient.invalidateQueries({ queryKey: ['invoice-statistics'] });
      queryClient.invalidateQueries({ queryKey: ['excess-amount'] });
      queryClient.invalidateQueries({ queryKey: ['income-expenses'] });
      queryClient.invalidateQueries({ queryKey: ['accounts-with-balance'] });
    },
    onSuccess: (result) => {
      const okCount = result.ok.length;
      const failCount = result.failures.length;
      if (failCount === 0) {
        toast({
          title: 'Hoàn tất ghi nhận thanh toán',
          description: `Thành công ${okCount} hoá đơn`,
        });
      } else if (okCount === 0) {
        toast({
          variant: 'destructive',
          title: 'Không ghi nhận được thanh toán',
          description: `Lỗi ${failCount} hoá đơn`,
        });
      } else {
        toast({
          title: 'Hoàn tất ghi nhận thanh toán',
          description: `Thành công ${okCount} — Lỗi ${failCount}`,
        });
      }
    },
    onError: (error: Error) => {
      toast({
        variant: 'destructive',
        title: 'Có lỗi xảy ra',
        description: error.message,
      });
    },
  });
};
