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
import { allocateDepositPortion } from '@/lib/invoiceHelpers';

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

      // Fetch invoice TRƯỚC khi gọi RPC để có paid_amount chính xác (RPC sẽ
      // cộng payment vào paid_amount). Cần previous_debt_sources +
      // invoice_items(description, amount) để phát hiện cọc gộp trong HĐ cũ.
      const { data: inv } = await supabase
        .from('invoices')
        .select(
          'id, invoice_number, building_id, room_id, contract_id, billing_month, tenant_id:contract_id, notes, paid_amount, total_amount, previous_debt, previous_debt_sources, invoice_items(type, description, amount), building:buildings!invoices_building_id_fkey(id, name), room:rooms!invoices_room_id_fkey(id, name)'
        )
        .eq('id', data.invoice_id)
        .single() as any;
      const paidBefore = Number(inv?.paid_amount) || 0;

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
      // (inv đã fetch ở trên — trước RPC — để có paid_amount.)
      // Lấy loại thu: doanh thu (KHÔNG cọc) + cọc (is_deposit). Tách rõ để hạng
      // mục doanh thu KHÔNG bao giờ dính is_deposit (DB hiện có 0 is_default →
      // phải lọc is_deposit=false tường minh + sắp xếp ổn định + THROW nếu thiếu).
      const { data: incTypes, error: incTypesErr } = await supabase
        .from('income_expense_types' as any)
        .select('id, is_default, type, name, is_deposit')
        .eq('type', 'income')
        .limit(100) as any;
      if (incTypesErr) throw incTypesErr;
      const allInc = (incTypes ?? []) as Array<{
        id: string; is_default?: boolean; name?: string; is_deposit?: boolean;
      }>;
      // Ưu tiên: is_default → hạng mục quy ước "Thu tiền hoá đơn" → đầu danh
      // sách (sort theo tên cho ổn định). DB hiện KHÔNG có is_default income type.
      const revenueTypes = allInc.filter((t) => !t.is_deposit);
      const norm = (s?: string) => (s ?? '').trim().toLowerCase();
      const incomeTypeId =
        revenueTypes.find((t) => t.is_default)?.id ||
        revenueTypes.find((t) => norm(t.name) === 'thu tiền hoá đơn' || norm(t.name) === 'thu tiền hóa đơn')?.id ||
        [...revenueTypes].sort((a, b) => (a.name ?? '').localeCompare(b.name ?? ''))[0]?.id;
      const depositTypes = allInc.filter((t) => t.is_deposit);
      const depositTypeId =
        depositTypes.find((t) => (t.name ?? '').trim().toLowerCase() === 'tiền cọc')?.id ||
        depositTypes[0]?.id;

      if (inv && data.account_id && data.amount > 0) {
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

        // Phần cọc gộp trong HĐ cũ: item OTHER đúng nhãn "Tiền cọc" (chuỗi cố
        // định firstInvoiceBuilder cũ phát ra) + nguồn nợ cũ type 'deposit'.
        // Dùng so khớp CHÍNH XÁC 'tiền cọc' để KHÔNG bắt nhầm khoản thật như
        // "Cọc xe máy"/"Cọc thẻ". (Khớp đúng 2 đường gộp cọc cũ; HĐ mới = 0.)
        const invItems = (inv.invoice_items ?? []) as Array<{ type?: string; description?: string; amount?: number }>;
        const itemDeposit = invItems
          .filter(
            (it) =>
              it.type === 'OTHER' &&
              typeof it.description === 'string' &&
              it.description.trim().toLowerCase() === 'tiền cọc',
          )
          .reduce((s, it) => s + (Number(it.amount) || 0), 0);
        const pdSources = Array.isArray(inv.previous_debt_sources) ? inv.previous_debt_sources : [];
        const pdDeposit = (pdSources as any[])
          .filter((s) => s?.type === 'deposit')
          .reduce((s, x) => s + (Number(x.amount) || 0), 0);
        const depositInInvoice = itemDeposit + pdDeposit;

        // Chỉ phân bổ phần cọc khi HĐ thực sự gộp cọc + có contract. Bỏ qua khi
        // có rounding/credit (paid_amount không cộng đúng data.amount → lệch).
        const canSplit = depositInInvoice > 0 && !!inv.contract_id && rounding === 0 && credit === 0;
        // PHÒNG-TRƯỚC, CỌC-SAU (hàm thuần allocateDepositPortion + property
        // test): tiền thu phủ phần phòng/DV còn thiếu trước, dư mới vào cọc.
        const collectibleTotal =
          (Number(inv.total_amount) || 0) + (Number(inv.previous_debt) || 0);
        const { depositPortion, revenuePortion } = canSplit
          ? allocateDepositPortion({
              paymentAmount: data.amount,
              depositInInvoice,
              paidBefore,
              collectibleTotal,
            })
          : { depositPortion: 0, revenuePortion: data.amount };

        const shortTitle = getInvoiceShortTitle(inv as any);

        // Idempotency: nếu đã có phiếu thu gắn payment_id này (retry) → bỏ qua.
        let alreadyMirrored = false;
        if (newPaymentId) {
          const { data: existingV } = await supabase
            .from('income_expenses' as any)
            .select('id')
            .eq('payment_id', newPaymentId)
            .limit(1) as any;
          alreadyMirrored = !!(existingV && existingV.length > 0);
        }

        if (!alreadyMirrored) {
          // Pre-check loại thu TRƯỚC khi tạo phiếu (thiếu loại thì báo user tạo).
          if (depositPortion > 0 && !depositTypeId) {
            throw new Error(
              'Hoá đơn có phần cọc nhưng chưa có loại thu cọc (is_deposit). Vào Cài đặt → Loại thu/chi tạo loại "Tiền cọc".',
            );
          }
          if (revenuePortion > 0 && !incomeTypeId) {
            throw new Error(
              'Chưa có loại thu (không phải cọc) trong "Loại thu/chi". Vào Cài đặt → Loại thu/chi để tạo trước.',
            );
          }

          // 1 lần thu = ĐÚNG 1 phiếu thu (chứng từ khớp giao dịch thực — KHÔNG
          // tách phiếu). Phần cọc là HẠNG MỤC is_deposit trên CÙNG phiếu; báo
          // cáo KQKD tự loại phần cọc qua cột kqkd_amount (item-level, trigger
          // DB — migration 20260702120000_kqkd_item_level).
          const { data: voucher, error: vErr } = await supabase
            .from('income_expenses' as any)
            .insert({
              user_id: user.id,
              type: 'INCOME',
              name: revenuePortion > 0
                ? `Thu tiền theo HĐ ${shortTitle}`
                : `Thu cọc theo HĐ ${shortTitle}`,
              building_id: inv.building_id,
              room_id: inv.room_id,
              contract_id: inv.contract_id,
              account_id: data.account_id,
              invoice_id: inv.id,
              payment_id: newPaymentId,
              voucher_date: data.payment_date,
              payer_name: data.notes ?? null,
              notes: composedNotes,
              attachments: data.receipt_image_url ? [data.receipt_image_url] : [],
              approval_status: 'APPROVED',
              creator_name: creatorName,
              // null = tự động: kqkd_amount = total − Σ item cọc (trigger DB).
              business_result_accounting: null,
              change_amount: change,
              change_account_id: data.change_account_id ?? null,
              rounding_amount: rounding,
              rounding_account_id: rounding > 0 ? (data.rounding_account_id ?? null) : null,
            } as any)
            .select()
            .single();
          if (vErr) throw vErr;

          const items = [
            ...(revenuePortion > 0
              ? [{
                  income_expense_id: (voucher as any).id,
                  income_expense_type_id: incomeTypeId!,
                  description: `Thanh toán HĐ ${shortTitle}`,
                  quantity: 1,
                  unit_price: revenuePortion,
                  start_date: data.payment_date,
                  end_date: data.payment_date,
                }]
              : []),
            ...(depositPortion > 0
              ? [{
                  income_expense_id: (voucher as any).id,
                  income_expense_type_id: depositTypeId!,
                  description: `Tiền cọc theo HĐ ${shortTitle}`,
                  quantity: 1,
                  unit_price: depositPortion,
                  start_date: data.payment_date,
                  end_date: data.payment_date,
                }]
              : []),
          ];
          if (items.length > 0) {
            const { error: itemErr } = await supabase
              .from('income_expense_items' as any)
              .insert(items);
            if (itemErr) throw itemErr;
          }
        }
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
      // Box "Hoá đơn tháng đầu" + popup Các lần thanh toán + cọc ngoài HĐ —
      // không invalidate là hiển thị số CŨ (stale) ngay sau khi thu.
      queryClient.invalidateQueries({ queryKey: ['first-invoice-details'] });
      queryClient.invalidateQueries({ queryKey: ['invoice-payments-summary'] });
      queryClient.invalidateQueries({ queryKey: ['contract-deposit-vouchers'] });

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
          room_id: inv.room_id,
          contract_id: inv.contract_id,
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
      queryClient.invalidateQueries({ queryKey: ['first-invoice-details'] });
      queryClient.invalidateQueries({ queryKey: ['invoice-payments-summary'] });

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
