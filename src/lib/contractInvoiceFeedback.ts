import type { FirstInvoiceItem } from './firstInvoiceBuilder';

/** Mirrors only the per-row checks the contract writer exposes and the UI can identify. */
export function validateFirstInvoiceRows(
  items: readonly FirstInvoiceItem[],
  billing: { start_date: string | null; end_date: string | null },
): Record<string, string> {
  const errors: Record<string, string> = {};
  for (const item of items) {
    const key = `invoice_items.${item.id}`;
    if (!Number.isFinite(item.unit_price) || item.unit_price < 0) {
      errors[`${key}.unit_price`] = 'Đơn giá phải là số không âm hợp lệ.';
    }
    if (!Number.isFinite(item.quantity) || item.quantity <= 0) {
      errors[`${key}.quantity`] = 'Số lượng phải lớn hơn 0.';
    }
    const from = item.from_date || null;
    const to = item.to_date || null;
    if (!!from !== !!to) {
      errors[`${key}.period`] = 'Kỳ của dòng hóa đơn cần đủ ngày bắt đầu và kết thúc. Sửa kỳ tính tiền đầu phía trên.';
    } else if (from && to && from > to) {
      errors[`${key}.period`] = 'Ngày bắt đầu của dòng hóa đơn phải trước hoặc bằng ngày kết thúc. Sửa kỳ tính tiền đầu phía trên.';
    } else if (item.accounting_class === 'REVENUE' && billing.start_date && billing.end_date &&
      ((from ?? billing.start_date) < billing.start_date || (to ?? billing.end_date) > billing.end_date)) {
      errors[`${key}.period`] = 'Kỳ của dòng hóa đơn phải nằm trong kỳ tính tiền đầu. Sửa kỳ tính tiền đầu phía trên.';
    }
    if (item.accounting_class === 'DEPOSIT' && item.type !== 'OTHER') {
      errors[`${key}.period`] = 'Dòng cọc trong hóa đơn đầu không hợp lệ.';
    }
  }
  return errors;
}
