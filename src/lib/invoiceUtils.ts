// =============================================
// Invoice Utility Functions
// Pure utility functions for invoice calculations, status checks, and formatting.
// =============================================

import type { InvoiceStatus, InvoiceTotals } from '@/types/invoice';

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
 * Calculate all invoice totals from line items, discount, tax, and prepaid.
 *
 * - subtotal = Σ(unit_price × quantity × coefficient)
 * - tax_amount = subtotal × taxPercent / 100
 * - total_amount = subtotal - discount + tax_amount
 * - remaining = total_amount - prepaid
 */
export function calculateInvoiceTotals(
  items: TotalsItem[],
  discount: number,
  taxPercent: number,
  prepaid: number,
): InvoiceTotals {
  const subtotal = items.reduce(
    (sum, item) => sum + item.unit_price * item.quantity * item.coefficient,
    0,
  );

  const tax_amount = subtotal * taxPercent / 100;
  const total_amount = subtotal - discount + tax_amount;
  const remaining = total_amount - prepaid;

  return {
    subtotal,
    discount_amount: discount,
    tax_percent: taxPercent,
    tax_amount,
    total_amount,
    prepaid_amount: prepaid,
    remaining,
  };
}

// =============================================
// Status Permission Checks
// =============================================

/** Only DRAFT invoices can be edited. */
export function canEditInvoice(status: InvoiceStatus): boolean {
  return status === 'DRAFT';
}

/** Only DRAFT invoices can be deleted. */
export function canDeleteInvoice(status: InvoiceStatus): boolean {
  return status === 'DRAFT';
}

/** Only DRAFT invoices can be approved. */
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
