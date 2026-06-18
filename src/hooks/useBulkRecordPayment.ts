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
import { getSessionUser } from "@/lib/authSession";
import { useToast } from '@/hooks/use-toast';
import { getInvoiceShortTitle } from '@/lib/invoiceUtils';
import { planConflictsWithRemaining } from '@/lib/collectPlan';

export interface BulkPaymentItem {
  invoice_id: string;
  invoice_number?: string;
  room_name?: string;
  amount_tm: number;
  amount_tk: number;
  amount_tt: number;
  change_amount: number;
  account_id: string;
  /** Sổ quỹ RIÊNG cho từng phương thức (thu tách TM/TK/TT vào đúng sổ).
   *  Thiếu key nào → dùng account_id chung (giữ tương thích caller cũ). */
  accounts?: Partial<Record<'TM' | 'TK' | 'TT', string>>;
  change_account_id: string | null;
  /** Nếu true: change_amount được giữ làm credit cho contract (excess_amounts),
   *  KHÔNG khấu trừ vào TM, KHÔNG tạo phiếu chi thối. */
  keep_as_credit?: boolean;
  receipt_image_url?: string | null;
  notes?: string;
  /** Số tiền làm tròn (residual < 10K) — audit metadata gắn lên voucher
   *  INCOME của line cuối, KHÔNG trừ số dư. Trigger DB tự mark PAID. */
  rounding_amount?: number;
  /** Sổ quỹ "Làm tròn tiền thiếu". Bắt buộc nếu rounding_amount > 0. */
  rounding_account_id?: string | null;
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
      const user = await getSessionUser();
      if (!user) throw new Error('Not authenticated');

      // ── Cache income/expense types 1 lần cho cả batch ──
      const { data: incTypes, error: incTypesErr } = await (supabase
        .from('income_expense_types' as any)
        .select('id, is_default, type, name, is_deposit') as any)
        .eq('type', 'income')
        .limit(100);
      if (incTypesErr) throw incTypesErr;
      const allInc = (incTypes ?? []) as Array<{
        id: string; is_default?: boolean; name?: string; is_deposit?: boolean;
      }>;
      // Loại thu DOANH THU phải KHÔNG phải cọc — tránh chọn nhầm "Tiền Cọc" làm
      // loại mặc định (DB hiện có 0 is_default) → doanh thu bị loại khỏi KQKD.
      const revenueTypes = allInc.filter((t) => !t.is_deposit);
      const normT = (s?: string) => (s ?? '').trim().toLowerCase();
      const incomeTypeId =
        revenueTypes.find((t) => t.is_default)?.id ||
        revenueTypes.find((t) => normT(t.name) === 'thu tiền hoá đơn' || normT(t.name) === 'thu tiền hóa đơn')?.id ||
        [...revenueTypes].sort((a, b) => (a.name ?? '').localeCompare(b.name ?? ''))[0]?.id;
      if (!incomeTypeId) {
        throw new Error(
          'Chưa có loại thu (không phải cọc) trong "Loại thu/chi". Vào Cài đặt → Loại thu/chi để tạo trước.',
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
              'id, user_id, invoice_number, building_id, room_id, contract_id, billing_month, total_amount, paid_amount, remaining_amount, notes, previous_debt_sources, invoice_items(type, description, amount), building:buildings!invoices_building_id_fkey(id, name), room:rooms!invoices_room_id_fkey(id, name)',
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

          // HĐ CŨ gộp cọc (item OTHER "Tiền cọc" hoặc previous_debt_sources type
          // 'deposit') → KHÔNG thu hàng loạt (đường này không tách cọc theo từng
          // sub-line). Báo thu qua màn hình hoá đơn (RecordPaymentDialog tự tách
          // cọc thành phiếu is_deposit). Tránh cọc lọt vào KQKD.
          const invItems2 = ((inv as any).invoice_items ?? []) as Array<{ type?: string; description?: string; amount?: number }>;
          const itemDeposit = invItems2
            .filter((it) => it.type === 'OTHER' && typeof it.description === 'string' && it.description.trim().toLowerCase() === 'tiền cọc')
            .reduce((s, it) => s + (Number(it.amount) || 0), 0);
          const pdSrc = Array.isArray((inv as any).previous_debt_sources) ? (inv as any).previous_debt_sources : [];
          const pdDeposit = (pdSrc as any[])
            .filter((s) => s?.type === 'deposit')
            .reduce((s, x) => s + (Number(x.amount) || 0), 0);
          if (itemDeposit + pdDeposit > 0) {
            failures.push({
              invoice_id: item.invoice_id,
              invoice_number: item.invoice_number,
              room_name: item.room_name,
              message: 'Hoá đơn có gộp tiền cọc — vui lòng thu qua màn hình hoá đơn để tách cọc đúng (không thu hàng loạt).',
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
          // Nếu keep_as_credit: KHÔNG khấu trừ — tiền thối được giữ thành credit
          // và sẽ INSERT excess_amounts row sau loop.
          const change = item.change_amount || 0;
          const keepAsCredit = !!item.keep_as_credit && change > 0;

          // ── Chốt lại theo remaining VỪA ĐỌC (chống race thu song song) ──
          // Plan (change/credit/rounding) được tính phía client theo remaining
          // có thể đã cũ. Nếu giữa lúc đó người khác vừa thu, ghi mù theo plan
          // cũ sẽ làm paid_amount vượt total (overpay phantom) hoặc lệch credit.
          // Đối chiếu với `remaining` fresh: phần dồn vào hoá đơn không được
          // vượt remaining; với nợ khách, phần giữ phải đúng bằng phần dư thực.
          const totalGross =
            (item.amount_tm || 0) + (item.amount_tk || 0) + (item.amount_tt || 0);
          if (planConflictsWithRemaining(totalGross, change, keepAsCredit, remaining)) {
            failures.push({
              invoice_id: item.invoice_id,
              invoice_number: item.invoice_number,
              room_name: item.room_name,
              message:
                'Số dư hoá đơn đã thay đổi (người khác vừa thu) — vui lòng mở lại và thu theo số mới.',
            });
            continue;
          }

          let tmDeductIdx = -1;
          if (change > 0 && !keepAsCredit) {
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
          // Tìm line TM cuối để gắn payment_id reference vào excess_amounts (nếu credit)
          let tmLastIdx = -1;
          for (let i = subLines.length - 1; i >= 0; i--) {
            if (subLines[i].method === 'TM') {
              tmLastIdx = i;
              break;
            }
          }
          let creditSourcePaymentId: string | null = null;

          // Rounding: metadata làm tròn dán lên voucher line CUỐI.
          const rounding = item.rounding_amount ?? 0;
          const roundingAccountId = item.rounding_account_id ?? null;
          const lastSubLineIdx = subLines.length - 1;

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
            const isCreditLine = keepAsCredit && i === tmLastIdx;
            const isRoundingLine = rounding > 0 && i === lastSubLineIdx;
            const refundNote = deducted > 0
              ? `Thu ${grossPaid.toLocaleString('vi-VN')} – Thối ${deducted.toLocaleString('vi-VN')}`
              : isCreditLine
                ? `Thu ${effectiveAmount.toLocaleString('vi-VN')} – Nợ khách ${change.toLocaleString('vi-VN')} (trừ kỳ sau)`
                : isRoundingLine
                  ? `Thu ${effectiveAmount.toLocaleString('vi-VN')} – Làm tròn thiếu ${rounding.toLocaleString('vi-VN')}`
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
            if (isCreditLine) creditSourcePaymentId = newPaymentId;

            const { data: voucher, error: vErr } = await supabase
              .from('income_expenses' as any)
              .insert({
                user_id: ownerId,
                type: 'INCOME',
                name: `Thu tiền theo HĐ ${getInvoiceShortTitle(inv as any)}`,
                building_id: (inv as any).building_id,
                room_id: (inv as any).room_id,
                contract_id: (inv as any).contract_id,
                account_id:
                  item.accounts?.[line.method as 'TM' | 'TK' | 'TT'] ?? item.account_id,
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
                rounding_amount: isRoundingLine ? rounding : 0,
                rounding_account_id: isRoundingLine ? roundingAccountId : null,
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
                unit_price: effectiveAmount,
                start_date: params.payment_date,
                end_date: params.payment_date,
              });
            if (itemErr) throw itemErr;
          }

          // Khi keep_as_credit: INSERT excess_amounts row cho contract
          if (keepAsCredit && (inv as any).contract_id) {
            const { error: creditErr } = await supabase
              .from('excess_amounts' as any)
              .insert({
                user_id: ownerId,
                contract_id: (inv as any).contract_id,
                amount: change,
                description: `Tiền nợ khách giữ lại từ HĐ ${(inv as any).invoice_number || ''}`.trim(),
                source_invoice_id: (inv as any).id,
                source_payment_id: creditSourcePaymentId,
              } as any);
            if (creditErr) throw creditErr;
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
      queryClient.invalidateQueries({ queryKey: ['excess-amount'] });
      queryClient.invalidateQueries({ queryKey: ['invoice-collectors'] });
      queryClient.invalidateQueries({ queryKey: ['handover-vouchers'] });
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
