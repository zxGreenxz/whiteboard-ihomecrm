// =============================================
// useQuickCollect — thu tiền MẶT nhanh cho 1 hoá đơn
//
// Bọc useBulkRecordPayment (gọi với đúng 1 item) để KHÔNG phát minh lại
// mutation thanh toán: insert payments(TM) + income_expenses, trigger DB
// recompute_invoice_for_id tự cập nhật paid_amount/remaining/status.
//
// Sổ quỹ nhận (account_id) resolve theo logic của RecordPaymentDialog:
//   sổ "...Thu" của user đang đăng nhập → sổ "Chung" → sổ trùng tên toà.
// Sổ "Làm tròn tiền thiếu" dùng khi residual sau thu < 10K (mark PAID).
// =============================================

import { useMemo } from 'react';
import { useAccounts } from '@/hooks/useAccounts';
import { useAuth } from '@/hooks/useAuth';
import {
  useBulkRecordPayment,
  type BulkPaymentItem,
} from '@/hooks/useBulkRecordPayment';
import { remainingOf, todayISO } from '@/lib/collect';
import type { InvoiceWithRelations } from '@/types/invoice';

const ROUNDING_THRESHOLD = 10_000;

export interface QuickCollectArgs {
  invoice: InvoiceWithRelations;
  /** Số tiền mặt thu (sẽ cap ≤ remaining). */
  amount: number;
  notes?: string;
}

export const useQuickCollect = () => {
  const { data: accounts = [] } = useAccounts();
  const { data: currentUser } = useAuth();
  const bulkMutation = useBulkRecordPayment();

  // Sổ quỹ TM: sổ "...Thu" của user → "Chung" → (resolve theo tên toà lúc thu).
  const myCashAccountId = useMemo(() => {
    if (!currentUser?.id || !accounts.length) return '';
    return (
      (accounts as any[]).find(
        (a) =>
          a.user_id === currentUser.id &&
          typeof a.name === 'string' &&
          a.name.trim().endsWith('Thu'),
      )?.id ?? ''
    );
  }, [currentUser, accounts]);

  const chungAccountId = useMemo(() => {
    if (!accounts.length) return '';
    return (
      (accounts as any[]).find(
        (a) => typeof a.name === 'string' && a.name.trim().toLowerCase() === 'chung',
      )?.id ?? ''
    );
  }, [accounts]);

  const roundingAccountId = useMemo(() => {
    if (!accounts.length) return '';
    return (
      (accounts as any[]).find(
        (a) => typeof a.name === 'string' && a.name.trim() === 'Làm tròn tiền thiếu',
      )?.id ?? ''
    );
  }, [accounts]);

  /** Sổ quỹ nhận tiền mặt cho 1 HĐ (fallback cuối: sổ trùng tên toà). */
  const cashAccountIdFor = (invoice: InvoiceWithRelations): string => {
    if (myCashAccountId) return myCashAccountId;
    if (chungAccountId) return chungAccountId;
    const buildingName = invoice.building?.name?.trim();
    if (buildingName) {
      return (
        (accounts as any[]).find((a) => a.name?.trim() === buildingName)?.id ?? ''
      );
    }
    return '';
  };

  /**
   * Thu tiền mặt. Trả về kết quả của bulk hook ({ ok, failures }).
   * Throw nếu không resolve được sổ quỹ TM (chặn insert account_id rỗng).
   */
  const collect = async ({ invoice, amount, notes }: QuickCollectArgs) => {
    const remaining = remainingOf(invoice);
    const amountTM = Math.max(0, Math.min(amount, remaining));
    if (amountTM <= 0) {
      throw new Error('Số tiền thu phải > 0');
    }

    const accountId = cashAccountIdFor(invoice);
    if (!accountId) {
      throw new Error(
        'Chưa xác định được sổ quỹ Thu (TM). Kiểm tra Cài đặt → Sổ quỹ (sổ "…Thu" của bạn hoặc "Chung").',
      );
    }

    // Làm tròn tự động: residual sau thu > 0 và < 10K → đính rounding metadata
    // lên voucher; trigger DB tự mark invoice PAID.
    const residualAfter = remaining - amountTM;
    const willRound = residualAfter > 0 && residualAfter < ROUNDING_THRESHOLD;

    const item: BulkPaymentItem = {
      invoice_id: invoice.id,
      invoice_number: invoice.invoice_number ?? undefined,
      room_name: invoice.room?.name ?? undefined,
      amount_tm: amountTM,
      amount_tk: 0,
      amount_tt: 0,
      change_amount: 0,
      account_id: accountId,
      change_account_id: null,
      notes: notes?.trim() || undefined,
      rounding_amount: willRound ? residualAfter : 0,
      rounding_account_id: willRound && roundingAccountId ? roundingAccountId : null,
    };

    return bulkMutation.mutateAsync({ payment_date: todayISO(), items: [item] });
  };

  return {
    collect,
    isCollecting: bulkMutation.isPending,
    /** UI có thể cảnh báo khi thiếu sổ quỹ TM (chưa map được toà/user). */
    hasCashAccount: !!(myCashAccountId || chungAccountId || accounts.length),
  };
};
