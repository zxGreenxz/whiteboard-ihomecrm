// Thẻ nháp của trang "Báo chi nhanh" và luật kiểm hợp lệ trước khi bấm "Lưu".
//
// Một thẻ = một phiếu chi công ty (nhiều dòng theo hạng mục) HOẶC một lần ghi ví cá nhân.
// Giới hạn bám theo writer `create_income_expense_v1`: tên ≤500, mô tả dòng ≤1000, ≤200 dòng,
// ≤20 ảnh https, số tiền nguyên dương. Thông báo lỗi trả theo đường dẫn ô ("lines.0.amount")
// để thẻ tô đúng ô.

import { MAX_AMOUNT_VND } from "./amount";
import { z } from 'zod';
import type { WalletResolution } from './personalWallet';

const walletResolutionSchema = z.object({walletId:z.string().nullable(),reason:z.enum(['manual','explicit','platform','bank_transfer','cash_default','unresolved'])});

export type DraftMode = "company" | "personal";
export type TransactionType = 'INCOME' | 'EXPENSE';

export interface DraftLine {
  personalWalletResolution?: WalletResolution;
  transactionType?: TransactionType;
  personalCategoryId?: string | null;
  description: string;
  /** Số đồng, nguyên dương. */
  amount: number;
  /** Công ty: id hạng mục chi. */
  categoryId: string | null;
  /** Cá nhân: tên danh mục ví cá nhân. */
  personalCategory: string | null;
  /** Kỳ áp dụng của dòng (vd tiền điện tháng 9); null ⇒ lấy ngày phiếu. */
  periodStart: string | null;
  periodEnd: string | null;
}

export interface QuickDraft {
  personalWalletResolution?: WalletResolution;
  transactionType?: TransactionType;
  personalWalletId?: string | null;
  /** New drafts use the atomic RPC; missing on historic pending cards means manual reconciliation. */
  personalRequestKey?: string;
  personalProtocol?: 1;
  /** Id thẻ (uuid) — sinh khoá chống trùng cố định `qe-<id>`. */
  id: string;
  mode: DraftMode;
  /** Ngày chi "YYYY-MM-DD". */
  date: string;
  name: string;
  /** Người nhận / cửa hàng (payer_name của phiếu chi). */
  vendor: string | null;
  buildingId: string | null;
  roomId: string | null;
  accountId: string | null;
  /** URL https ảnh chứng từ đã tải — chỉ khoản công ty. */
  attachmentUrls: string[];
  lines: DraftLine[];
}

/** Persisted drafts may be incomplete, but field types and transaction directions must be trustworthy. */
export const quickDraftSchema=z.object({
 id:z.string().min(1),mode:z.enum(['company','personal']),date:z.string(),name:z.string(),vendor:z.string().nullable(),
 buildingId:z.string().nullable(),roomId:z.string().nullable(),accountId:z.string().nullable(),attachmentUrls:z.array(z.string()),
 transactionType:z.enum(['INCOME','EXPENSE']).optional(),personalWalletId:z.string().nullable().optional(),personalWalletResolution:walletResolutionSchema.optional(),personalRequestKey:z.string().uuid().optional(),personalProtocol:z.literal(1).optional(),
 lines:z.array(z.object({description:z.string(),amount:z.number().finite(),categoryId:z.string().nullable(),personalCategory:z.string().nullable(),periodStart:z.string().nullable(),periodEnd:z.string().nullable(),transactionType:z.enum(['INCOME','EXPENSE']).optional(),personalCategoryId:z.string().nullable().optional(),personalWalletResolution:walletResolutionSchema.optional()})).max(200),
});

export const MAX_NAME = 500;
export const MAX_DESCRIPTION = 1000;
/** Người nộp/nhận: writer dùng c_max_short_text_length = 255 (khác tên phiếu 500). */
export const MAX_PAYER_NAME = 255;
export const MAX_LINES = 200;
export const MAX_ATTACHMENTS = 20;

export type DraftValidation = { ok: true } | { ok: false; issues: Record<string, string> };

/** "YYYY-MM-DD" có thật trên lịch (từ chối 30/02). */
export function isRealDate(s: string | null | undefined): boolean {
  if (!s || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const [y, m, d] = s.split("-").map(Number);
  const t = new Date(Date.UTC(y, m - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d;
}

export function validateDraft(d: QuickDraft): DraftValidation {
  const issues: Record<string, string> = {};
  const add = (path: string, message: string) => {
    if (!(path in issues)) issues[path] = message;
  };

  // Tên và mô tả sinh tự động từ tin nhắn (có khi cả đoạn ghi âm) ⇒ không chặn độ dài ở đây;
  // `convert` cắt về giới hạn writer.
  if (!isRealDate(d.date)) add("date", "Chọn ngày chi hợp lệ.");
  if (d.lines.length === 0) add("lines", "Thêm ít nhất một khoản tiền.");
  if (d.lines.length > MAX_LINES) add("lines", `Tối đa ${MAX_LINES} dòng mỗi phiếu.`);

  d.lines.forEach((l, i) => {
    if (!Number.isSafeInteger(l.amount) || l.amount < 1 || l.amount > MAX_AMOUNT_VND) {
      add(`lines.${i}.amount`, "Số tiền phải là số đồng nguyên dương.");
    }
    if (d.mode === "company" && !l.categoryId) add(`lines.${i}.categoryId`, "Chọn hạng mục chi.");
    if (d.mode === 'personal' && !l.personalCategoryId) add(`lines.${i}.personalCategoryId`, 'Chọn danh mục thu hoặc chi.');
    if (d.mode === 'company' && (l.transactionType ?? d.transactionType ?? 'EXPENSE') !== (d.transactionType ?? 'EXPENSE')) add(`lines.${i}.transactionType`, 'Tách khoản thu và chi thành các phiếu riêng.');
    if (l.periodStart !== null || l.periodEnd !== null) {
      if (!isRealDate(l.periodStart)) add(`lines.${i}.periodStart`, "Chọn đầu kỳ hợp lệ.");
      else if (!isRealDate(l.periodEnd)) add(`lines.${i}.periodEnd`, "Chọn cuối kỳ hợp lệ.");
      else if ((l.periodStart as string) > (l.periodEnd as string)) {
        add(`lines.${i}.periodEnd`, "Đầu kỳ không được sau cuối kỳ.");
      }
    }
  });

  if (d.mode === "company") {
    if (!d.buildingId) add("buildingId", "Chọn toà nhà cho khoản chi.");
    if (!d.accountId) add("accountId", "Chọn sổ quỹ chi tiền.");
    if (d.attachmentUrls.length > MAX_ATTACHMENTS) add("attachmentUrls", `Tối đa ${MAX_ATTACHMENTS} ảnh chứng từ.`);
    d.attachmentUrls.forEach((u, i) => {
      if (!/^https:\/\//.test(u)) add(`attachmentUrls.${i}`, "Ảnh chứng từ chưa tải xong.");
    });
  } else if (d.attachmentUrls.length > 0) {
    add("attachmentUrls", "Khoản cá nhân không lưu ảnh.");
  }
  if (d.mode === 'personal' && !d.personalWalletId) add('personalWalletId', 'Chọn ví cá nhân.');

  return Object.keys(issues).length ? { ok: false, issues } : { ok: true };
}
