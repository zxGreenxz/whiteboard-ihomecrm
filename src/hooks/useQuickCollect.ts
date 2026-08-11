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
import { captureGpsAndRecord } from '@/lib/v5PaymentGps';
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
  /**
   * Sổ quỹ người thu chọn tay cho từng phương thức (ô "Sổ quỹ" cạnh TK trong
   * form thu). Thắng sổ mặc định của toà; server vẫn kiểm quyền trên sổ này.
   */
  accountOverrides?: Partial<Record<CollectMethod, string>>;
}

export const useQuickCollect = (opts?: { enabled?: boolean }) => {
  const { data: accounts = [] } = useAccounts(opts);
  const { data: currentUser } = useAuth();
  const bulkMutation = useBulkRecordPayment();

  const realAccounts = useMemo(
    () => accounts.filter((account) => account.is_virtual === false),
    [accounts],
  );
  const virtualAccounts = useMemo(
    () => accounts.filter((account) => account.is_virtual === true),
    [accounts],
  );

  /** Sổ quỹ nhận cho 1 HĐ theo phương thức — '' nếu chưa cấu hình (UI disable chip). */
  const accountIdFor = (invoice: InvoiceWithRelations, method: CollectMethod): string => {
    // Chỉ chào sổ thật thuộc ĐÚNG org của hoá đơn (server vẫn validate).
    const invoiceRealAccounts = realAccounts.filter(
      (account) =>
        !invoice.organization_id || account.organization_id === invoice.organization_id,
    );
    const building = invoice.building
      ? {
          ...invoice.building,
          default_account_id_tt: invoiceRealAccounts.some(
            (account) => account.id === invoice.building?.default_account_id_tt,
          )
            ? invoice.building.default_account_id_tt
            : null,
          default_account_id_tk: invoiceRealAccounts.some(
            (account) => account.id === invoice.building?.default_account_id_tk,
          )
            ? invoice.building.default_account_id_tk
            : null,
        }
      : null;
    return resolveAccountIdForMethod(
      method,
      invoiceRealAccounts,
      currentUser?.id,
      building,
    );
  };

  /** Sổ thật chọn được cho 1 HĐ (ô "Sổ quỹ" cạnh phương thức trong form thu). */
  const accountOptionsFor = (invoice: InvoiceWithRelations) =>
    realAccounts.filter(
      (account) =>
        !invoice.organization_id || account.organization_id === invoice.organization_id,
    );

  /** Sổ ảo (thối / làm tròn) thuộc ĐÚNG org của hoá đơn. */
  const virtualAccountsFor = (invoice: InvoiceWithRelations) =>
    virtualAccounts.filter(
      (account) =>
        !invoice.organization_id || account.organization_id === invoice.organization_id,
    );

  /** Sổ "…Thối" của user (Hiển→Hiển Thối, Hiệp→Hiệp Thối, khác→sổ "…Thối" đầu). */
  const changeAccountId = (invoice: InvoiceWithRelations): string =>
    findOwnChangeAccount(virtualAccountsFor(invoice), currentUser?.id)?.id ?? '';

  /** Sổ ảo "Làm tròn tiền thiếu" thuộc org của hoá đơn — '' nếu chưa cấu hình. */
  const roundingAccountIdFor = (invoice: InvoiceWithRelations): string =>
    virtualAccountsFor(invoice).find(
      (account) => account.name.trim() === 'Làm tròn tiền thiếu',
    )?.id ?? '';

  const collect = async ({
    invoice,
    lines,
    amount,
    method = 'TM',
    keepAsCredit,
    notes,
    receiptImageUrl,
    paymentDate,
    accountOverrides,
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
    // `planned.ok === false` chứ không phải `!planned.ok`: repo bật
    // strictNullChecks:false, và ở chế độ đó tsc KHÔNG phân nhánh được union
    // theo truthiness của discriminant boolean — `planned.error` sẽ báo TS2339.
    // So sánh tường minh với `false` thì narrowing chạy đúng.
    if (planned.ok === false) throw new Error(planned.error);
    const { amountTm, amountTk, amountTt, change, keepAsCredit: credit, rounding } = planned.plan;

    // Sổ quỹ riêng từng phương thức có tiền.
    const accountsMap: Partial<Record<CollectMethod, string>> = {};
    for (const [m, amt] of [
      ['TM', amountTm],
      ['TK', amountTk],
      ['TT', amountTt],
    ] as [CollectMethod, number][]) {
      if (amt > 0) {
        const picked = accountOverrides?.[m]?.trim();
        // Chỉ nhận sổ người thu chọn nếu nó là sổ thật thuộc đúng org của HĐ.
        const acc =
          picked && accountOptionsFor(invoice).some((account) => account.id === picked)
            ? picked
            : accountIdFor(invoice, m);
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
      chgAccId = changeAccountId(invoice);
      if (!chgAccId) {
        throw new Error(
          'Chưa có sổ "…Thối" để ghi nhận tiền thối. Vào Cài đặt → Sổ quỹ tạo sổ tên kết thúc "Thối", hoặc tích "Nợ khách".',
        );
      }
    }
    const invoiceRoundingAccountId = roundingAccountIdFor(invoice);
    if (rounding > 0 && !invoiceRoundingAccountId) {
      throw new Error(
        'Chưa có sổ ảo "Làm tròn tiền thiếu". Vào Cài đặt → Sổ quỹ để tạo/cấu hình trước khi làm tròn.',
      );
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
      rounding_account_id:
        rounding > 0 && invoiceRoundingAccountId ? invoiceRoundingAccountId : null,
    };

    const res = await bulkMutation.mutateAsync({
      payment_date: paymentDate || todayISO(),
      items: [item],
    });
    // v5 (A1#3): GPS NỀN IM LẶNG sau khi phiếu lưu OK — không bao giờ chặn luồng thu.
    // Server tự quyết: tick / thông báo treo "check nhà sau thu tiền" / piggyback.
    if (res.voucherIds?.length) void captureGpsAndRecord(res.voucherIds);
    return res;
  };

  return {
    collect,
    accountIdFor,
    accountOptionsFor,
    /** Tên sổ thối của user cho 1 HĐ (org-scoped, hiển thị trong form); '' nếu chưa có. */
    changeAccountNameFor: (invoice: InvoiceWithRelations): string =>
      findOwnChangeAccount(virtualAccountsFor(invoice), currentUser?.id)?.name ?? '',
    isCollecting: bulkMutation.isPending,
    hasCashAccount:
      !!resolveTmAccountId(realAccounts, currentUser?.id) || realAccounts.length > 0,
  };
};
