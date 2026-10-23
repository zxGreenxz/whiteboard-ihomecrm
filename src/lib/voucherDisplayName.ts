// =============================================================================
// voucherDisplayName — TÊN HIỂN THỊ của phiếu thu/chi (chủ nhắn 23/10/2026: "ghi thành hoá đơn tiền
// phòng kỳ như cách ghi bên Báo cáo LN, đừng ghi 'Thu tiền theo HĐ INV-2026-01184' khó hiểu"; "hoá
// đơn thanh lý hay bỏ cọc gì đó… ghi rõ, đừng ghi mã hoá đơn vô").
//
// CHỈ đổi chữ hiển thị — cột income_expenses.name và các hàm ghi giữ nguyên. Một chỗ duy nhất cho
// Thu chi (bảng, thẻ điện thoại), Quyết toán vận hành (màn quản trị + link chủ nhà) và Báo cáo LN.
//
//   · Phiếu gắn hoá đơn mà tên là mẫu tự sinh "Thu tiền theo HĐ <mã>" ⇒ tên hoá đơn như Báo cáo LN
//     ("TIỀN PHÒNG - 10/2026", "TIỀN PHÒNG THÁNG ĐẦU TIÊN - 10/2026", "Hóa đơn thanh lý - 05/10/2026"…),
//     chèn tên phòng ("TIỀN PHÒNG - 203 - 10/2026") ở nơi KHÔNG có cột phòng riêng.
//   · Tên hệ thống dạng "… — HĐ <mã hợp đồng>" (thanh lý, bỏ cọc, khách trả thêm…) ⇒ bỏ "— HĐ <mã>",
//     thay bằng "— phòng <phòng>" ở nơi không có cột phòng riêng.
//   · Tên khác (người dùng tự gõ) GIỮ NGUYÊN. Chưa tải xong hoá đơn ⇒ tạm hiện tên gốc.
// =============================================================================

import { invoiceTitleFromParts, type InvoiceTitleParts } from '@/lib/invoiceUtils';

/** Mẫu tên do RPC thu tiền hoá đơn tự sinh: 'Thu tiền theo HĐ ' || invoice_number (không thêm gì sau). */
const AUTO_INVOICE_NAME = /^Thu tiền theo HĐ(?:\s+\S+)?\s*$/;
/** Đuôi tên phiếu do hàm thanh lý / bỏ cọc tự sinh: ' — HĐ ' || contract_number (gạch dài, cuối tên). */
const CONTRACT_CODE_SUFFIX = /\s+—\s+HĐ\s+\S+\s*$/;

/** Tên phiếu là mẫu tự sinh của thu tiền hoá đơn (chỉ những phiếu này mới cần đọc hoá đơn). */
export function isAutoInvoiceVoucherName(name: string | null | undefined): boolean {
  return AUTO_INVOICE_NAME.test(name ?? '');
}

/** "203" ⇒ "phòng 203"; tên phòng đã có chữ "Phòng" thì giữ nguyên. */
const roomPhrase = (room: string) => (/^ph[oò]ng\b/i.test(room) ? room : `phòng ${room}`);

export interface VoucherDisplayInput {
  name: string | null | undefined;
  roomName?: string | null;
  /** Các phần tên hoá đơn của phiếu (null: không gắn hoá đơn / chưa tải xong / không đọc được). */
  invoice?: InvoiceTitleParts | null;
}

export function voucherDisplayName(v: VoucherDisplayInput, opts: { includeRoom: boolean }): string {
  const name = v.name ?? '';
  const room = opts.includeRoom ? (v.roomName ?? '').trim() : '';
  if (v.invoice && isAutoInvoiceVoucherName(name)) {
    return invoiceTitleFromParts(v.invoice, room || null);
  }
  if (CONTRACT_CODE_SUFFIX.test(name)) {
    const base = name.replace(CONTRACT_CODE_SUFFIX, '').trimEnd();
    if (base) return room ? `${base} — ${roomPhrase(room)}` : base;
  }
  return name;
}

/** Id hoá đơn cần đọc để dựng tên (chỉ phiếu mang tên tự sinh "Thu tiền theo HĐ …"). */
export function invoiceIdsForDisplay(
  vouchers: readonly { name: string | null | undefined; invoice_id?: string | null }[],
): string[] {
  const out = new Set<string>();
  for (const v of vouchers) if (v.invoice_id && isAutoInvoiceVoucherName(v.name)) out.add(v.invoice_id);
  return [...out];
}

// ─────────────────────────── Báo cáo LN (giữ nguyên hành vi cũ) ───────────────────────────

/** Bỏ dấu + thường hoá + đ→d (như hai trang Báo cáo LN). toLowerCase TRƯỚC khi thay đ→d (Đ hoa). */
export const normalizeVi = (s: string | null | undefined): string =>
  (s ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/đ/g, 'd')
    .trim();

/**
 * Tên dòng Báo cáo LN (desktop + điện thoại). Dời nguyên từ hai trang báo cáo về đây (23/10/2026), không
 * đổi hành vi:
 *  - dòng ghi chú thuần (phòng trống/thiếu hoá đơn) và mọi dòng CHI giữ mô tả gốc;
 *  - khoản thu thanh lý hợp đồng ⇒ "HĐ Thanh Lý Hợp Đồng" (phiếu trải nhiều HĐ, giữ nhãn gộp);
 *  - dòng gắn hoá đơn ⇒ tên hoá đơn KHÔNG kèm phòng (phòng có cột riêng);
 *  - chưa tải xong hoá đơn ⇒ nhãn rút gọn cũ "Hóa Đơn Tiền Phòng T<tháng>".
 */
export function profitReportRowDescription(
  r: { isNote: boolean; side: 'income' | 'expense'; typeName: string | null | undefined; description: string },
  ctx: { invoice?: InvoiceTitleParts | null; month: number | string },
): string {
  if (r.isNote) return r.description;
  if (r.side === 'expense') return r.description;
  if (normalizeVi(`${r.typeName ?? ''} ${r.description}`).includes('thanh ly')) return 'HĐ Thanh Lý Hợp Đồng';
  if (ctx.invoice) return invoiceTitleFromParts(ctx.invoice, null);
  if (normalizeVi(r.description).includes('thu tien theo hd tien phong')) return `Hóa Đơn Tiền Phòng T${ctx.month}`;
  return r.description;
}
