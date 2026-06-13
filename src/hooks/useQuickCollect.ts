// =============================================
// useQuickCollect — thu tiền nhanh cho 1 hoá đơn (TM/TK/TT, tách nhiều dòng)
//
// Bọc useBulkRecordPayment (đúng 1 item) để KHÔNG phát minh lại mutation
// thanh toán: insert payments + income_expenses, trigger DB
// recompute_invoice_for_id tự cập nhật paid_amount/remaining/status.
//
// 2 đường gọi:
//  - 1-chạm (Thu đủ / keypad): collect({invoice, amount, method?}) — cap ≤ remaining.
//  - Form nhiều dòng: collect({invoice, lines, keepAsCredit, ...}) — cho thu dư
//    qua TM → tiền thối (sổ "…Thối") hoặc nợ khách (excess_amounts, cần HĐ).
//
// Tính tiền (thuần) ở planCollect; sổ quỹ resolve theo phương thức
// (lib/cashAccount) — mỗi phương thức vào ĐÚNG sổ qua item.accounts.
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
import { findOwnChangeAccount } from '@/lib/changeAccounts';
import { planCollect, type CollectPlanLine } from '@/lib/collectPlan';
import { remainingOf, todayISO } from '@/lib/collect';
import type { InvoiceWithRelations } from '@/types/invoice';

export interface QuickCollectArgs {
  invoice: InvoiceWithRelations;
  /** Đường nhiều dòng (form). Cung cấp cái này HOẶC amount (1-chạm). */
  lines?: CollectPlanLine[];
  /** Đường 1-chạm: số tiền (cap ≤ remaining). */
  amount?: number;
  /** Phương thức cho đường 1-chạm (mặc định TM). */
  method?: CollectMethod;
  /** Giữ phần dư thành "nợ khách" (excess_amounts) thay vì thối lại. */
  keepAsCredit?: boolean;
  notes?: string;
  /** Ảnh chứng từ đã upload (public URL). */
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

  /** Sổ "…Thối" của user (Hiển→Hiển Thối, Hiệp→Hiệp Thối, khác→sổ "…Thối" đầu). */
  const changeAccountId = (): string =>
    findOwnChangeAccount(accounts as any[], currentUser?.id)?.id ?? '';

  const collect = async ({
    invoice,
    lines,
    amount,
    method = 'TM',
    keepAsCredit,
    notes,
    receiptImageUrl,
    paymentDate,
  }: QuickCollectArgs) => {
    const remaining = remainingOf(invoice);
    const isMulti = !!(lines && lines.length);
    const rawLines: CollectPlanLine[] = isMulti
      ? lines!
      : [{ method, amount: amount ?? 0 }];

    const planned = planCollect({
      lines: rawLines,
      remaining,
      keepAsCredit,
      hasContract: !!invoice.contract_id,
      cap: !isMulti,
    });
    if (!planned.ok) throw new Error(planned.error);
    const { amountTm, amountTk, amountTt, change, keepAsCredit: credit, rounding } = planned.plan;

    // Sổ quỹ riêng từng phương thức có tiền.
    const accountsMap: Partial<Record<CollectMethod, string>> = {};
    for (const [m, amt] of [
      ['TM', amountTm],
      ['TK', amountTk],
      ['TT', amountTt],
    ] as [CollectMethod, number][]) {
      if (amt > 0) {
        const acc = accountIdFor(invoice, m);
        if (!acc) {
          throw new Error(
            m === 'TM'
              ? 'Chưa xác định được sổ quỹ Thu (TM). Kiểm tra Cài đặt → Sổ quỹ (sổ "…Thu" của bạn hoặc "Chung").'
              : `Tòa "${invoice.building?.name ?? ''}" chưa cấu hình sổ quỹ ${m}. Vào Cài đặt → Tòa nhà để chọn sổ mặc định ${m}.`,
          );
        }
        accountsMap[m] = acc;
      }
    }
    const primaryAccount = accountsMap.TM || accountsMap.TK || accountsMap.TT || '';

    // Sổ thối (chỉ khi trả thối, không khi nợ khách).
    let chgAccId: string | null = null;
    if (change > 0 && !credit) {
      chgAccId = changeAccountId();
      if (!chgAccId) {
        throw new Error(
          'Chưa có sổ "…Thối" để ghi nhận tiền thối. Vào Cài đặt → Sổ quỹ tạo sổ tên kết thúc "Thối", hoặc tích "Nợ khách".',
        );
      }
    }

    const item: BulkPaymentItem = {
      invoice_id: invoice.id,
      invoice_number: invoice.invoice_number ?? undefined,
      room_name: invoice.room?.name ?? undefined,
      amount_tm: amountTm,
      amount_tk: amountTk,
      amount_tt: amountTt,
      change_amount: change,
      keep_as_credit: credit,
      account_id: primaryAccount,
      accounts: accountsMap,
      change_account_id: chgAccId,
      receipt_image_url: receiptImageUrl ?? null,
      notes: notes?.trim() || undefined,
      rounding_amount: rounding,
      rounding_account_id: rounding > 0 && roundingAccountId ? roundingAccountId : null,
    };

    return bulkMutation.mutateAsync({
      payment_date: paymentDate || todayISO(),
      items: [item],
    });
  };

  return {
    collect,
    accountIdFor,
    /** Tên sổ thối của user (hiển thị trong form); '' nếu chưa có. */
    changeAccountName: findOwnChangeAccount(accounts as any[], currentUser?.id)?.name ?? '',
    isCollecting: bulkMutation.isPending,
    hasCashAccount:
      !!resolveTmAccountId(accounts as any[], currentUser?.id) || accounts.length > 0,
  };
};
