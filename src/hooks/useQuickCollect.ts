// =============================================
// useQuickCollect — thu tiền nhanh cho 1 hoá đơn (TM/TK/TT)
//
// Bọc useBulkRecordPayment (gọi với đúng 1 item) để KHÔNG phát minh lại
// mutation thanh toán: insert payments + income_expenses, trigger DB
// recompute_invoice_for_id tự cập nhật paid_amount/remaining/status.
//
// Sổ quỹ nhận resolve theo PHƯƠNG THỨC (lib/cashAccount):
//   TM → sổ "…Thu" của user (ưu tiên is_default) → "Chung" → tên toà
//   TK → buildings.default_account_id_tk → sổ trùng tên toà
//   TT → buildings.default_account_id_tt → sổ trùng tên toà
// Sổ "Làm tròn tiền thiếu" dùng khi residual sau thu < 10K (mark PAID).
// =============================================

import { useMemo } from 'react';
import { useAccounts } from '@/hooks/useAccounts';
import { useAuth } from '@/hooks/useAuth';
import {
  useBulkRecordPayment,
  type BulkPaymentItem,
} from '@/hooks/useBulkRecordPayment';
import {
  resolveAccountIdForMethod,
  resolveTmAccountId,
  type CollectMethod,
} from '@/lib/cashAccount';
import { remainingOf, todayISO } from '@/lib/collect';
import type { InvoiceWithRelations } from '@/types/invoice';

const ROUNDING_THRESHOLD = 10_000;

export interface QuickCollectArgs {
  invoice: InvoiceWithRelations;
  /** Số tiền thu (sẽ cap ≤ remaining). */
  amount: number;
  notes?: string;
  /** Phương thức thanh toán — mặc định tiền mặt. */
  method?: CollectMethod;
  /** Ảnh chứng từ đã upload (public URL) — vào payments.receipt_image_url + attachments. */
  receiptImageUrl?: string | null;
  /** Ngày thanh toán (DATE) — mặc định hôm nay. */
  paymentDate?: string;
}

export const useQuickCollect = () => {
  const { data: accounts = [] } = useAccounts();
  const { data: currentUser } = useAuth();
  const bulkMutation = useBulkRecordPayment();

  const roundingAccountId = useMemo(() => {
    if (!accounts.length) return '';
    return (
      (accounts as any[]).find(
        (a) => typeof a.name === 'string' && a.name.trim() === 'Làm tròn tiền thiếu',
      )?.id ?? ''
    );
  }, [accounts]);

  /** Sổ quỹ nhận cho 1 HĐ theo phương thức — '' nếu chưa cấu hình (UI disable chip). */
  const accountIdFor = (invoice: InvoiceWithRelations, method: CollectMethod): string =>
    resolveAccountIdForMethod(method, accounts as any[], currentUser?.id, invoice.building);

  /**
   * Thu tiền. Trả về kết quả của bulk hook ({ ok, failures }).
   * Throw nếu không resolve được sổ quỹ cho phương thức (chặn insert account_id rỗng).
   */
  const collect = async ({
    invoice,
    amount,
    notes,
    method = 'TM',
    receiptImageUrl,
    paymentDate,
  }: QuickCollectArgs) => {
    const remaining = remainingOf(invoice);
    const paid = Math.max(0, Math.min(amount, remaining));
    if (paid <= 0) {
      throw new Error('Số tiền thu phải > 0');
    }

    const accountId = accountIdFor(invoice, method);
    if (!accountId) {
      throw new Error(
        method === 'TM'
          ? 'Chưa xác định được sổ quỹ Thu (TM). Kiểm tra Cài đặt → Sổ quỹ (sổ "…Thu" của bạn hoặc "Chung").'
          : `Tòa "${invoice.building?.name ?? ''}" chưa cấu hình sổ quỹ ${method}. Vào Cài đặt → Tòa nhà để chọn sổ mặc định ${method}.`,
      );
    }

    // Làm tròn tự động: residual sau thu > 0 và < 10K → đính rounding metadata
    // lên voucher; trigger DB tự mark invoice PAID. Áp dụng cho mọi phương thức.
    const residualAfter = remaining - paid;
    const willRound = residualAfter > 0 && residualAfter < ROUNDING_THRESHOLD;

    const item: BulkPaymentItem = {
      invoice_id: invoice.id,
      invoice_number: invoice.invoice_number ?? undefined,
      room_name: invoice.room?.name ?? undefined,
      amount_tm: method === 'TM' ? paid : 0,
      amount_tk: method === 'TK' ? paid : 0,
      amount_tt: method === 'TT' ? paid : 0,
      change_amount: 0,
      account_id: accountId,
      change_account_id: null,
      receipt_image_url: receiptImageUrl ?? null,
      notes: notes?.trim() || undefined,
      rounding_amount: willRound ? residualAfter : 0,
      rounding_account_id: willRound && roundingAccountId ? roundingAccountId : null,
    };

    return bulkMutation.mutateAsync({
      payment_date: paymentDate || todayISO(),
      items: [item],
    });
  };

  return {
    collect,
    accountIdFor,
    isCollecting: bulkMutation.isPending,
    /** UI có thể cảnh báo khi thiếu sổ quỹ TM (chưa map được toà/user). */
    hasCashAccount:
      !!resolveTmAccountId(accounts as any[], currentUser?.id) || accounts.length > 0,
  };
};
