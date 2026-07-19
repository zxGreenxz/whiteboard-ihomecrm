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
import {
  recordInvoicePaymentWithFallback,
  type PaymentMethod,
} from '@/lib/paymentRecordRpc';

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
  /** Idempotency key (chống payment đôi khi retry sau timeout). Nếu không truyền,
   *  hook tự sinh crypto.randomUUID() mỗi lần submit. */
  idempotency_key?: string;
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

      // ─────────────────────────────────────────────────────
      // CHUẨN BỊ phiếu thu mirror — TÍNH TOÁN + PRE-CHECK TRƯỚC KHI GỌI RPC.
      // Mọi thao tác đọc/kiểm tra có thể THROW (thiếu loại thu, tách cọc…) phải
      // nằm TRƯỚC RPC: nếu để SAU thì payment đã ghi mà mutation vẫn throw →
      // user bấm lại = payment ĐÔI. (Phiếu thu vẫn insert SAU RPC vì cần payment_id.)
      // ─────────────────────────────────────────────────────
      const willMirror = !!inv && !!data.account_id && data.amount > 0;

      // Lấy loại thu: doanh thu (KHÔNG cọc) + cọc (is_deposit). Tách rõ để hạng
      // mục doanh thu KHÔNG bao giờ dính is_deposit (DB hiện có 0 is_default →
      // lọc is_deposit=false tường minh + sắp xếp ổn định + THROW nếu thiếu).
      const { data: incTypes, error: incTypesErr } = await supabase
        .from('income_expense_types' as any)
        .select('id, is_default, type, name, is_deposit')
        .eq('type', 'income')
        .limit(100) as any;
      if (incTypesErr) throw incTypesErr;
      const allInc = (incTypes ?? []) as Array<{
        id: string; is_default?: boolean; name?: string; is_deposit?: boolean;
      }>;
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

      const change = data.change_amount ?? 0;
      const credit = data.credit_amount ?? 0;
      const rounding = data.rounding_amount ?? 0;

      // Phần cọc gộp trong HĐ: item OTHER đúng nhãn "Tiền cọc" (chuỗi cố định
      // firstInvoiceBuilder phát ra) + nguồn nợ cũ type 'deposit'. So khớp CHÍNH
      // XÁC 'tiền cọc' để KHÔNG bắt nhầm khoản thật ("Cọc xe máy"/"Cọc thẻ").
      const invItems = ((inv as any)?.invoice_items ?? []) as Array<{ type?: string; description?: string; amount?: number }>;
      const itemDeposit = invItems
        .filter(
          (it) =>
            it.type === 'OTHER' &&
            typeof it.description === 'string' &&
            it.description.trim().toLowerCase() === 'tiền cọc',
        )
        .reduce((s, it) => s + (Number(it.amount) || 0), 0);
      const pdSources = Array.isArray((inv as any)?.previous_debt_sources) ? (inv as any).previous_debt_sources : [];
      const pdDeposit = (pdSources as any[])
        .filter((s) => s?.type === 'deposit')
        .reduce((s, x) => s + (Number(x.amount) || 0), 0);
      const depositInInvoice = itemDeposit + pdDeposit;

      // Chỉ tách cọc khi HĐ thực sự gộp cọc + có contract. KHÔNG chặn khi
      // rounding > 0: tiền làm tròn thiếu chỉ là chênh nhỏ; nếu bỏ tách khi có
      // rounding → toàn bộ cọc lọt vào doanh thu KQKD (bug). Vẫn bỏ qua khi
      // credit > 0 (thu dư giữ credit — phần dư không thuộc cọc).
      const canSplit = depositInInvoice > 0 && !!(inv as any)?.contract_id && credit === 0;

      // Cọc ĐÃ ghi cho HĐ này bằng phiếu thu is_deposit trước đó (kể cả HĐ từng
      // thu theo quy ước CŨ cọc-trước): phải trừ khỏi "doanh thu đã phủ" để KHÔNG
      // ghi cọc ĐÔI. Chỉ query khi HĐ gộp cọc.
      let depositRecordedBefore = 0;
      if (willMirror && canSplit) {
        const { data: prevVouchers } = await supabase
          .from('income_expenses' as any)
          .select('id')
          .eq('invoice_id', (inv as any).id)
          .is('deleted_at', null) as any;
        const ieIds = ((prevVouchers ?? []) as Array<{ id: string }>).map((v) => v.id);
        const depTypeIds = depositTypes.map((t) => t.id);
        if (ieIds.length > 0 && depTypeIds.length > 0) {
          const { data: depItems } = await supabase
            .from('income_expense_items' as any)
            .select('unit_price, quantity, income_expense_type_id')
            .in('income_expense_id', ieIds)
            .in('income_expense_type_id', depTypeIds) as any;
          depositRecordedBefore = ((depItems ?? []) as Array<{ unit_price?: number; quantity?: number }>)
            .reduce((s, it) => s + (Number(it.unit_price) || 0) * (Number(it.quantity) || 1), 0);
        }
      }

      // PHÒNG-TRƯỚC, CỌC-SAU. collectibleTotal = total_amount (ĐÃ gồm nợ cũ —
      // KHÔNG cộng previous_debt lần nữa, kẻo thổi phồng phần doanh thu → ghi
      // thiếu cọc). depositRecordedBefore trừ phần cọc đã ghi (chống ghi đôi).
      const collectibleTotal = Number((inv as any)?.total_amount) || 0;
      const { depositPortion, revenuePortion } = canSplit
        ? allocateDepositPortion({
            paymentAmount: data.amount,
            depositInInvoice,
            paidBefore,
            collectibleTotal,
            depositRecordedBefore,
          })
        : { depositPortion: 0, revenuePortion: data.amount };

      // Pre-check loại thu TRƯỚC RPC (thiếu loại → báo user tạo, CHƯA ghi tiền).
      if (willMirror) {
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
      }

      // ─────────────────────────────────────────────────────
      // ATOMIC (Sprint 5b): payment + invoice + phiếu thu + items trong 1 RPC
      // (record_invoice_payment_v3) + idempotency_key. Trước đây payment (RPC) và
      // phiếu thu (insert FE) tách transaction ⇒ RPC ok + mirror lỗi + retry =
      // payment ĐÔI. Giờ all-or-nothing; retry cùng key trả kết quả cũ.
      // Split revenue/deposit vẫn tính ở FE (logic đã kiểm), truyền qua payload.
      // ─────────────────────────────────────────────────────
      const idempotencyKey = data.idempotency_key ?? crypto.randomUUID();

      let voucherPayload: Record<string, unknown> | null = null;
      let itemsPayload: Array<Record<string, unknown>> | null = null;

      if (willMirror) {
        const meta = (user.user_metadata ?? {}) as Record<string, any>;
        const creatorName: string =
          meta.full_name || meta.name || user.email || 'Người dùng';

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

        const shortTitle = getInvoiceShortTitle(inv as any);

        voucherPayload = {
          name: revenuePortion > 0 ? `Thu tiền theo HĐ ${shortTitle}` : `Thu cọc theo HĐ ${shortTitle}`,
          room_id: inv.room_id ?? null,
          payer_name: data.notes ?? null,
          notes: composedNotes,
          attachments: data.receipt_image_url ? [data.receipt_image_url] : [],
          creator_name: creatorName,
          business_result_accounting: null, // null ⇒ kqkd tự tính (trigger DB)
          change_amount: change,
          change_account_id: data.change_account_id ?? null,
          rounding_amount: rounding,
          rounding_account_id: rounding > 0 ? (data.rounding_account_id ?? null) : null,
        };
        itemsPayload = [
          ...(revenuePortion > 0
            ? [{ income_expense_type_id: incomeTypeId!, description: `Thanh toán HĐ ${shortTitle}`, quantity: 1, unit_price: revenuePortion, start_date: data.payment_date, end_date: data.payment_date }]
            : []),
          ...(depositPortion > 0
            ? [{ income_expense_type_id: depositTypeId!, description: `Tiền cọc theo HĐ ${shortTitle}`, quantity: 1, unit_price: depositPortion, start_date: data.payment_date, end_date: data.payment_date }]
            : []),
        ];
      }

      // W1 payment cutover: v4 canonical trước, server quyết route theo org —
      // v4 chưa deploy/flag OFF/coexistence-denied thì adapter tự chạy v3.
      const { result, route, legacyReason } = await recordInvoicePaymentWithFallback(
        (fn, args) => (supabase.rpc as any)(fn, args),
        {
          invoice_id: data.invoice_id,
          amount: data.amount,
          payment_method: data.payment_method as PaymentMethod,
          payment_date: data.payment_date,
          account_id: data.account_id ?? null,
          notes: data.notes ?? null,
          receipt_image_url: data.receipt_image_url ?? null,
          voucher: voucherPayload,
          items: itemsPayload,
        },
        idempotencyKey,
      );
      if (route === 'LEGACY' && legacyReason === 'v4-denied') {
        console.info('[payment-w1] v4 denied → v3 coexistence', data.invoice_id);
      }

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
          // t5_24: hoàn trả khách thuộc nhóm "hoàn" BẮT BUỘC DUYỆT (phương án
          // org) → sinh ở NHÁP; recompute chỉ tính refund khi phiếu APPROVED.
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
