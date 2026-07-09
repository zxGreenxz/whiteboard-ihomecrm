// =============================================
// Invoice Utility Functions
// Pure utility functions for invoice calculations, status checks, and formatting.
// =============================================

import type { InvoiceStatus, InvoiceTotals, InvoiceWithRelations } from '@/types/invoice';

// =============================================
// Types
// =============================================

/** Minimal item shape needed for totals calculation */
export interface TotalsItem {
  unit_price: number;
  quantity: number;
  coefficient: number;
}

// =============================================
// Invoice Number Generation
// =============================================

/**
 * Generate an invoice number using the user's settings (prefix, format, reset period).
 * Falls back to a timestamp-based number if settings are unavailable.
 */
export async function generateInvoiceNumber(userId: string): Promise<string> {
  const { supabase } = await import('@/integrations/supabase/client');

  const { data: settings } = await supabase
    .from('settings')
    .select('value')
    .eq('user_id', userId)
    .eq('key', 'invoice_config')
    .maybeSingle();

  const config = settings?.value as Record<string, unknown> | undefined;
  const prefix = (config?.invoice_number_prefix as string) || 'INV';
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const ts = Date.now().toString().slice(-6);

  return `${prefix}-${year}${month}-${ts}`;
}

// =============================================
// Invoice Totals Calculation
// =============================================

/**
 * Calculate all invoice totals from line items, discount, and prepaid.
 *
 * - subtotal = Σ(unit_price × quantity × coefficient)
 * - total_amount = subtotal - discount
 * - remaining = total_amount - prepaid
 */
export function calculateInvoiceTotals(
  items: TotalsItem[],
  discount: number,
  prepaid: number,
): InvoiceTotals {
  const subtotal = items.reduce(
    (sum, item) => sum + item.unit_price * item.quantity * item.coefficient,
    0,
  );

  const total_amount = subtotal - discount;
  const remaining = total_amount - prepaid;

  return {
    subtotal,
    discount_amount: discount,
    total_amount,
    prepaid_amount: prepaid,
    remaining,
  };
}

/**
 * Làm tròn TỔNG TIỀN hoá đơn theo phần lẻ (3 chữ số cuối):
 * - phần lẻ < 900đ  → làm tròn XUỐNG bội số 1000 gần nhất (bỏ phần lẻ)
 * - phần lẻ >= 900đ → làm tròn LÊN bội số 1000 gần nhất
 *
 * VD: 1.299.500 → 1.299.000 ; 1.299.900 → 1.300.000 ; 2.450.000 → 2.450.000
 * Chỉ áp dụng cho tổng dương; số 0/âm/không hợp lệ giữ nguyên.
 */
export function roundInvoiceTotal(total: number): number {
  if (!Number.isFinite(total) || total <= 0) return total;
  const remainder = total % 1000;
  if (remainder === 0) return total;
  return remainder >= 900
    ? Math.ceil(total / 1000) * 1000
    : Math.floor(total / 1000) * 1000;
}

// =============================================
// Status Permission Checks
// =============================================

/** Shape needed for edit/delete permission checks. */
type InvoiceLike = {
  status: InvoiceStatus;
  paid_amount?: number | null;
  deleted_at?: string | null;
};

/**
 * Edit allowed for DRAFT and APPROVED invoices that have no payments yet.
 * Once any amount is recorded (PARTIAL_PAID/PAID) or the invoice is CANCELLED,
 * edits are blocked to protect financial data.
 */
export function canEditInvoice(invoice: InvoiceLike): boolean {
  if (invoice.status !== 'DRAFT' && invoice.status !== 'APPROVED') return false;
  return (invoice.paid_amount ?? 0) === 0;
}

/**
 * Quy tắc xoá:
 * - User thường: giống canEdit (DRAFT/APPROVED chưa thu tiền).
 * - Super admin (opts.isSuper): xoá được HĐ ở MỌI trạng thái trừ CANCELLED
 *   và HĐ đã bị soft-delete trước đó. Backend RPC sẽ hard-delete payments
 *   liên quan rồi chuyển status sang CANCELLED.
 */
export function canDeleteInvoice(
  invoice: InvoiceLike,
  opts?: { isSuper?: boolean },
): boolean {
  if (opts?.isSuper) {
    return invoice.status !== 'CANCELLED' && invoice.deleted_at == null;
  }
  return canEditInvoice(invoice);
}

/**
 * Kept for legacy callers (tests, hooks). Auto-approve on create means there
 * are no DRAFT invoices in the normal flow, so this returns false in practice.
 */
export function canApproveInvoice(status: InvoiceStatus): boolean {
  return status === 'DRAFT';
}

// =============================================
// Status Display
// =============================================

/** Return a color string for the given invoice status. */
export function getStatusColor(status: InvoiceStatus): string {
  const colors: Record<InvoiceStatus, string> = {
    DRAFT: 'gray',
    APPROVED: 'blue',
    PARTIAL_PAID: 'yellow',
    PAID: 'green',
    OVERDUE: 'red',
    CANCELLED: 'black',
  };
  return colors[status] ?? 'gray';
}

// =============================================
// Overdue Check
// =============================================

/**
 * An invoice is overdue when the current date is past the due date
 * AND the status is not PAID or CANCELLED.
 */
export function isOverdue(dueDate: string, status: InvoiceStatus): boolean {
  if (status === 'PAID' || status === 'CANCELLED') {
    return false;
  }
  const now = new Date();
  // Zero out time for a date-only comparison
  now.setHours(0, 0, 0, 0);
  const due = new Date(dueDate);
  due.setHours(0, 0, 0, 0);
  return now > due;
}

// =============================================
// Invoice Display Title
// =============================================

/**
 * HĐ THÁNG ĐẦU của hợp đồng (tự sinh khi ký HĐ) — nhận diện theo:
 *  • notes tự động chứa "… tháng đầu" (mẫu cũ) / "… đầu tiên" (useContracts từ
 *    2026-07-02), HOẶC
 *  • kỳ tiền phòng (item RENT có from_date sớm nhất) bắt đầu ĐÚNG
 *    contracts.start_billing_date.
 * Dùng CHUNG cho tên hoá đơn (getInvoiceTitle) + useFirstInvoiceDetails (màu
 * nền đỏ/xanh bên BC Lợi Nhuận) — sửa quy tắc thì chỉ sửa 1 nơi kẻo lệch nhau.
 */
export function isFirstMonthInvoice(invoice: {
  notes?: string | null;
  invoice_items?: Array<{ type?: string | null; from_date?: string | null }> | null;
  contract?: { start_billing_date?: string | null } | null;
}): boolean {
  const notes = invoice.notes ?? '';
  if (/th[aá]ng[\s_]?đầu|đầu\s*tiên/i.test(notes)) return true;
  const startBilling = invoice.contract?.start_billing_date ?? null;
  if (!startBilling) return false;
  const rent = (invoice.invoice_items ?? [])
    .filter((it) => it.type === 'RENT' && it.from_date)
    .sort((a, b) => String(a.from_date).localeCompare(String(b.from_date)))[0];
  return (
    !!rent && String(rent.from_date).slice(0, 10) === String(startBilling).slice(0, 10)
  );
}

/**
 * Build invoice display title from items + notes.
 *
 * Mọi loại HĐ đều chèn `<phòng>/<toà>` nếu có để khỏi cần dòng phụ bên dưới:
 * - Notes có "thanh lý" → "Hóa đơn thanh lý - <phòng>/<toà> - MM/YYYY"
 * - HĐ tháng đầu (ký HĐ) → "TIỀN PHÒNG THÁNG ĐẦU TIÊN - <phòng>/<toà> - MM/YYYY"
 * - RENT + SERVICE → "TIỀN PHÒNG - <phòng>/<toà> - MM/YYYY"
 * - Chỉ RENT → "Hóa đơn tiền nhà - <phòng>/<toà> - MM/YYYY"
 * - Chỉ SERVICE/PENALTY → "Hóa đơn dịch vụ - <phòng>/<toà> - MM/YYYY"
 * - Còn lại → "Hóa đơn - <phòng>/<toà> - MM/YYYY"
 */
export function getInvoiceTitle(invoice: InvoiceWithRelations): string {
  const month = invoice.billing_month ?? '';
  const monthDisplay = (() => {
    if (!month) return '';
    // billing_month dạng "2026-05" → "05/2026"
    const m = /^(\d{4})-(\d{2})$/.exec(month);
    return m ? `${m[2]}/${m[1]}` : month;
  })();

  const loc = [invoice.room?.name, invoice.building?.name]
    .filter(Boolean)
    .join('/');
  const monthPart = monthDisplay || month;
  const suffix = [loc, monthPart].filter(Boolean).join(' - ');

  const notes = invoice.notes ?? '';
  // Nguồn sự thật là invoices.kind (từ 20260709100000); regex notes giữ làm
  // fallback cho payload chưa select cột kind. Hoá đơn THÁNG không còn bị RPC
  // thanh lý append ghi chú nên regex không thể nhuộm nhầm hoá đơn thường.
  const isLiquidation =
    (invoice as { kind?: string }).kind === 'SETTLEMENT' || /thanh\s*lý/i.test(notes);
  if (isLiquidation) {
    // B6 (audit 03/07): billing_month của hoá đơn thanh lý chỉ là "slot" kỹ thuật
    // (né UNIQUE contract+kỳ nên có thể rơi vào tháng tương lai 08/09...) → hiển
    // thị NGÀY LẬP thật thay vì kỳ, và tách nhãn "thu thêm" khỏi hoá đơn bù cọc.
    const isExtra = /thu\s*thêm/i.test(notes);
    const issueDisplay = (() => {
      const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(invoice.issue_date ?? '');
      return m ? `${m[3]}/${m[2]}/${m[1]}` : monthDisplay;
    })();
    const liqSuffix = [loc, issueDisplay].filter(Boolean).join(' - ');
    const label = isExtra ? 'Hóa đơn thu thêm (thanh lý)' : 'Hóa đơn thanh lý';
    return liqSuffix ? `${label} - ${liqSuffix}` : label;
  }

  const hasRent = invoice.invoice_items?.some((i) => i.type === 'RENT');
  const hasService = invoice.invoice_items?.some(
    (i) => i.type === 'SERVICE' || i.type === 'PENALTY',
  );

  if (hasRent && isFirstMonthInvoice(invoice)) {
    return suffix
      ? `TIỀN PHÒNG THÁNG ĐẦU TIÊN - ${suffix}`
      : 'TIỀN PHÒNG THÁNG ĐẦU TIÊN';
  }
  if (hasRent && hasService) {
    return suffix ? `TIỀN PHÒNG - ${suffix}` : 'TIỀN PHÒNG';
  }
  if (hasRent) return suffix ? `Hóa đơn tiền nhà - ${suffix}` : 'Hóa đơn tiền nhà';
  if (hasService) return suffix ? `Hóa đơn dịch vụ - ${suffix}` : 'Hóa đơn dịch vụ';
  return suffix ? `Hóa đơn - ${suffix}` : 'Hóa đơn';
}

/**
 * Phiên bản viết tắt của tên hoá đơn: "Hóa đơn" → "HĐ".
 * Dùng cho field `name` của income_expenses (phiếu thu/chi từ hoá đơn) để
 * khớp với cột "Hoá đơn" bên trang Hoá đơn nhưng ngắn gọn hơn.
 */
export function getInvoiceShortTitle(invoice: InvoiceWithRelations): string {
  return getInvoiceTitle(invoice).replace(/Hóa đơn/gi, 'HĐ');
}
