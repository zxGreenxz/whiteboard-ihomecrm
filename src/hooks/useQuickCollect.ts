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
// Tính tiền (thuần) ở planCollect. SỔ NHẬN theo hình thức do MÁY CHỦ quyết
// (get_receiving_cashbooks_v1, đợt 1 sửa phiếu 25/09/2026): TM = sổ tiền mặt
// riêng của người thu; TK/TT = danh sách sổ của toà (mặc định đứng đầu) giao với
// sổ người thu giữ/biết. Hình thức chưa có sổ ⇒ CHẶN, không rơi về sổ khác.
// =============================================

import { useMemo } from 'react';
import { useAccounts } from '@/hooks/useAccounts';
import { useAuth } from '@/hooks/useAuth';
import {
  useBulkRecordPayment,
  type BulkPaymentItem,
} from '@/hooks/useBulkRecordPayment';
import {
  missingReceivingBookMessage,
  receivingBooksFor,
  useReceivingCashbooks,
  type ReceivingBook,
} from '@/hooks/useReceivingCashbooks';
import { useOrganization } from '@/contexts/OrganizationContext';
import { findOwnChangeAccount } from '@/lib/changeAccounts';
import { planCollect, type CollectMethod, type CollectPlanLine } from '@/lib/collectPlan';
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
  changeAmount?: number;
  /** Không bỏ qua khoản thiếu khi hoá đơn còn tiền cọc. Backend kiểm lại dữ liệu mới. */
  allowRounding?: boolean;
  notes?: string;
  /** Ảnh chứng từ đã upload (public URL). */
  receiptImageUrl?: string | null;
  /** Ngày thanh toán (DATE) — mặc định hôm nay. */
  paymentDate?: string;
  /**
   * Sổ người thu chọn cho từng hình thức (ô sổ cạnh TK/TT trong form thu). Chỉ
   * nhận khi sổ nằm trong danh sách máy chủ cho phép; TM luôn là sổ tiền mặt riêng.
   */
  accountOverrides?: Partial<Record<CollectMethod, string>>;
}

/** Một sổ được nhận (mặc định đứng đầu danh sách). */
export interface CollectBook {
  id: string;
  name: string;
  isDefault?: boolean;
}

/** Sổ được nhận theo hình thức của hoá đơn đang mở (TM = [sổ tiền mặt riêng]). */
export type ReceivingBooksByMethod = Record<CollectMethod, CollectBook[]>;

// Chép tường minh: tsconfig.app.json tắt strictNullChecks nên kiểu zod suy ra có
// mọi trường tuỳ chọn, không gán thẳng sang kiểu bắt buộc được.
const toBooks = (list: ReceivingBook[]): CollectBook[] =>
  list.map((b) => ({ id: b.id, name: b.name, isDefault: b.isDefault }));

export interface ReceivingBooksState {
  loading: boolean;
  /** Câu lỗi khi không đọc được danh sách sổ (đã bỏ tiền tố máy-đọc). */
  error: string | null;
  books: ReceivingBooksByMethod;
}

const KHONG_SO: ReceivingBooksByMethod = { TM: [], TK: [], TT: [] };

const loiDoc = (error: unknown): string => {
  const msg = (error as { message?: unknown } | null)?.message;
  return typeof msg === 'string' && msg.trim()
    ? msg.replace(/^\[[A-Z_]+\]\s*/, '')
    : 'Không tải được danh sách sổ nhận tiền.';
};

/**
 * `invoice` = hoá đơn đang mở ở ngăn thu tiền: danh sách sổ nhận đọc theo toà của
 * nó và theo NGƯỜI ĐANG ĐĂNG NHẬP (người thu). `collect` chỉ nhận đúng hoá đơn đó.
 */
export const useQuickCollect = (opts?: { invoice?: InvoiceWithRelations | null }) => {
  const invoice = opts?.invoice ?? null;
  const enabled = !!invoice;
  const { data: accounts = [] } = useAccounts({ enabled });
  const { data: currentUser } = useAuth();
  const { selectedOrganizationId } = useOrganization();
  const bulkMutation = useBulkRecordPayment();

  // Tổ chức của CHÍNH hoá đơn (máy chủ từ chối toà của tổ chức khác); chỉ rơi về
  // tổ chức đang chọn khi truy vấn hoá đơn không kèm cột này.
  const organizationId = invoice ? invoice.organization_id || selectedOrganizationId : null;
  const receivingQuery = useReceivingCashbooks(organizationId, invoice?.building_id ?? null);

  const receiving: ReceivingBooksState = useMemo(() => {
    const data = receivingQuery.data;
    return {
      loading: enabled && !data && !receivingQuery.isError,
      error: receivingQuery.isError
        ? loiDoc(receivingQuery.error)
        : enabled && !organizationId
          ? 'Chưa xác định được công ty của hoá đơn — chọn công ty rồi mở lại.'
          : null,
      books: data
        ? {
            TM: toBooks(receivingBooksFor(data, 'TM')),
            TK: toBooks(receivingBooksFor(data, 'TK')),
            TT: toBooks(receivingBooksFor(data, 'TT')),
          }
        : KHONG_SO,
    };
  }, [receivingQuery.data, receivingQuery.isError, receivingQuery.error, enabled, organizationId]);

  const virtualAccounts = useMemo(
    () => accounts.filter((account) => account.is_virtual === true),
    [accounts],
  );

  /** Sổ ảo (thối / làm tròn) thuộc ĐÚNG org của hoá đơn. */
  const virtualAccountsFor = (inv: InvoiceWithRelations) =>
    virtualAccounts.filter(
      (account) => !inv.organization_id || account.organization_id === inv.organization_id,
    );

  /** Sổ "…Thối" của user (Hiển→Hiển Thối, Hiệp→Hiệp Thối, khác→sổ "…Thối" đầu). */
  const changeAccountId = (inv: InvoiceWithRelations): string =>
    findOwnChangeAccount(virtualAccountsFor(inv), currentUser?.id)?.id ?? '';

  /** Sổ ảo "Làm tròn tiền thiếu" thuộc org của hoá đơn — '' nếu chưa cấu hình. */
  const roundingAccountIdFor = (inv: InvoiceWithRelations): string =>
    virtualAccountsFor(inv).find(
      (account) => account.name.trim() === 'Làm tròn tiền thiếu',
    )?.id ?? '';

  /** Câu chặn thu theo một hình thức (null = thu được). */
  const receivingBlockFor = (method: CollectMethod): string | null => {
    if (receiving.error) return receiving.error;
    if (receiving.loading) return 'Đang tải danh sách sổ nhận tiền — thử lại sau giây lát.';
    return receiving.books[method].length
      ? null
      : missingReceivingBookMessage(method, invoice?.building?.name);
  };

  const collect = async ({
    invoice: target,
    lines,
    amount,
    method = 'TM',
    keepAsCredit,
    changeAmount,
    allowRounding,
    notes,
    receiptImageUrl,
    paymentDate,
    accountOverrides,
  }: QuickCollectArgs) => {
    // Danh sách sổ đọc theo toà của hoá đơn đang mở; hoá đơn khác thì không dám
    // đoán sổ.
    if (!invoice || target.id !== invoice.id) {
      throw new Error('Hoá đơn vừa đổi — đóng rồi mở lại để thu.');
    }
    const remaining = remainingOf(target);
    const isMulti = !!(lines && lines.length);
    const rawLines: CollectPlanLine[] = isMulti
      ? lines!
      : [{ method, amount: amount ?? 0 }];

    const planned = planCollect({
      lines: rawLines,
      remaining,
      keepAsCredit,
      changeAmount,
      allowRounding,
      hasContract: !!target.contract_id,
      cap: !isMulti,
    });
    // `planned.ok === false` chứ không phải `!planned.ok`: repo bật
    // strictNullChecks:false, và ở chế độ đó tsc KHÔNG phân nhánh được union
    // theo truthiness của discriminant boolean — `planned.error` sẽ báo TS2339.
    // So sánh tường minh với `false` thì narrowing chạy đúng.
    if (planned.ok === false) throw new Error(planned.error);
    const { amountTm, amountTk, amountTt, change, keepAsCredit: credit, rounding } = planned.plan;

    // Sổ nhận riêng từng hình thức có tiền — chỉ trong danh sách máy chủ cho phép.
    const accountsMap: Partial<Record<CollectMethod, string>> = {};
    for (const [m, amt] of [
      ['TM', amountTm],
      ['TK', amountTk],
      ['TT', amountTt],
    ] as [CollectMethod, number][]) {
      if (amt <= 0) continue;
      const blocked = receivingBlockFor(m);
      if (blocked) throw new Error(blocked);
      const allowed = receiving.books[m];
      const picked = m === 'TM' ? undefined : accountOverrides?.[m]?.trim();
      accountsMap[m] = picked && allowed.some((b) => b.id === picked) ? picked : allowed[0].id;
    }
    const primaryAccount = accountsMap.TM || accountsMap.TK || accountsMap.TT || '';

    // Sổ thối (chỉ khi trả thối, không khi nợ khách).
    let chgAccId: string | null = null;
    if (change > 0 && !credit) {
      chgAccId = changeAccountId(target);
      if (!chgAccId) {
        throw new Error(
          'Chưa có sổ "…Thối" để ghi nhận tiền thối. Vào Cài đặt → Sổ quỹ tạo sổ tên kết thúc "Thối", hoặc tích "Nợ khách".',
        );
      }
    }
    const invoiceRoundingAccountId = roundingAccountIdFor(target);
    if (rounding > 0 && !invoiceRoundingAccountId) {
      throw new Error(
        'Chưa có sổ ảo "Làm tròn tiền thiếu". Vào Cài đặt → Sổ quỹ để tạo/cấu hình trước khi làm tròn.',
      );
    }

    const item: BulkPaymentItem = {
      invoice_id: target.id,
      invoice_number: target.invoice_number ?? undefined,
      room_name: target.room?.name ?? undefined,
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
    /** Sổ được nhận theo hình thức của hoá đơn đang mở + trạng thái nạp. */
    receiving,
    /** Câu chặn thu theo hình thức (null = thu được). */
    receivingBlockFor,
    /** Tên sổ thối của user cho 1 HĐ (org-scoped, hiển thị trong form); '' nếu chưa có. */
    changeAccountNameFor: (inv: InvoiceWithRelations): string =>
      findOwnChangeAccount(virtualAccountsFor(inv), currentUser?.id)?.name ?? '',
    isCollecting: bulkMutation.isPending,
  };
};
