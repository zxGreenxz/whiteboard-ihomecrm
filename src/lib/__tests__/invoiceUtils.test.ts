import { describe, it, expect } from 'vitest';
import {
  calculateInvoiceTotals,
  canEditInvoice,
  canDeleteInvoice,
  canApproveInvoice,
  getStatusColor,
  isOverdue,
  type TotalsItem,
} from '../invoiceUtils';
import type { InvoiceStatus } from '@/types/invoice';

// =============================================
// calculateInvoiceTotals
// =============================================

describe('calculateInvoiceTotals', () => {
  it('calculates correctly for a single item', () => {
    const items: TotalsItem[] = [{ unit_price: 1000, quantity: 2, coefficient: 1.5 }];
    const result = calculateInvoiceTotals(items, 0, 0);
    expect(result.subtotal).toBe(3000);
    expect(result.total_amount).toBe(3000);
    expect(result.remaining).toBe(3000);
  });

  it('calculates correctly for multiple items', () => {
    const items: TotalsItem[] = [
      { unit_price: 500, quantity: 3, coefficient: 1 },
      { unit_price: 200, quantity: 5, coefficient: 2 },
    ];
    // subtotal = 1500 + 2000 = 3500
    const result = calculateInvoiceTotals(items, 0, 0);
    expect(result.subtotal).toBe(3500);
    expect(result.total_amount).toBe(3500);
  });

  it('applies discount correctly', () => {
    const items: TotalsItem[] = [{ unit_price: 1000, quantity: 1, coefficient: 1 }];
    const result = calculateInvoiceTotals(items, 200, 0);
    expect(result.total_amount).toBe(800);
    expect(result.discount_amount).toBe(200);
  });

  it('applies prepaid correctly', () => {
    const items: TotalsItem[] = [{ unit_price: 1000, quantity: 1, coefficient: 1 }];
    const result = calculateInvoiceTotals(items, 0, 300);
    expect(result.remaining).toBe(700);
    expect(result.prepaid_amount).toBe(300);
  });

  it('handles empty items array', () => {
    const result = calculateInvoiceTotals([], 0, 0);
    expect(result.subtotal).toBe(0);
    expect(result.total_amount).toBe(0);
    expect(result.remaining).toBe(0);
  });

  it('combines discount and prepaid', () => {
    const items: TotalsItem[] = [{ unit_price: 10000, quantity: 1, coefficient: 1 }];
    // subtotal = 10000, discount = 1000
    // total = 10000 - 1000 = 9000, remaining = 9000 - 2000 = 7000
    const result = calculateInvoiceTotals(items, 1000, 2000);
    expect(result.subtotal).toBe(10000);
    expect(result.total_amount).toBe(9000);
    expect(result.remaining).toBe(7000);
  });
});

// =============================================
// canEditInvoice / canDeleteInvoice / canApproveInvoice
// =============================================

describe('status permission checks', () => {
  const allStatuses: InvoiceStatus[] = [
    'DRAFT', 'APPROVED', 'PAID', 'PARTIAL_PAID', 'OVERDUE', 'CANCELLED',
  ];

  it('canEditInvoice returns true for DRAFT/APPROVED with paid_amount=0', () => {
    for (const s of allStatuses) {
      const allowed = (s === 'DRAFT' || s === 'APPROVED');
      expect(canEditInvoice({ status: s, paid_amount: 0 })).toBe(allowed);
    }
  });

  it('canEditInvoice returns false once any payment is recorded', () => {
    expect(canEditInvoice({ status: 'APPROVED', paid_amount: 1 })).toBe(false);
    expect(canEditInvoice({ status: 'DRAFT', paid_amount: 1 })).toBe(false);
  });

  it('canDeleteInvoice mirrors canEditInvoice', () => {
    for (const s of allStatuses) {
      const allowed = (s === 'DRAFT' || s === 'APPROVED');
      expect(canDeleteInvoice({ status: s, paid_amount: 0 })).toBe(allowed);
    }
    expect(canDeleteInvoice({ status: 'APPROVED', paid_amount: 100 })).toBe(false);
  });

  it('canApproveInvoice still returns true only for DRAFT (legacy)', () => {
    for (const s of allStatuses) {
      expect(canApproveInvoice(s)).toBe(s === 'DRAFT');
    }
  });
});

// =============================================
// getStatusColor
// =============================================

describe('getStatusColor', () => {
  it('returns correct colors for all statuses', () => {
    expect(getStatusColor('DRAFT')).toBe('gray');
    expect(getStatusColor('APPROVED')).toBe('blue');
    expect(getStatusColor('PARTIAL_PAID')).toBe('yellow');
    expect(getStatusColor('PAID')).toBe('green');
    expect(getStatusColor('OVERDUE')).toBe('red');
    expect(getStatusColor('CANCELLED')).toBe('black');
  });
});

// =============================================
// isOverdue
// =============================================

describe('isOverdue', () => {
  it('returns true when past due date and status is DRAFT', () => {
    const pastDate = '2020-01-01';
    expect(isOverdue(pastDate, 'DRAFT')).toBe(true);
  });

  it('returns true when past due date and status is APPROVED', () => {
    expect(isOverdue('2020-01-01', 'APPROVED')).toBe(true);
  });

  it('returns true when past due date and status is PARTIAL_PAID', () => {
    expect(isOverdue('2020-01-01', 'PARTIAL_PAID')).toBe(true);
  });

  it('returns false when status is PAID regardless of date', () => {
    expect(isOverdue('2020-01-01', 'PAID')).toBe(false);
  });

  it('returns false when status is CANCELLED regardless of date', () => {
    expect(isOverdue('2020-01-01', 'CANCELLED')).toBe(false);
  });

  it('returns false when due date is in the future', () => {
    const futureDate = '2099-12-31';
    expect(isOverdue(futureDate, 'DRAFT')).toBe(false);
  });
});
