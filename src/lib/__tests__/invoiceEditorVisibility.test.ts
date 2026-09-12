import { describe, expect, it } from 'vitest';
import { canOpenInvoiceEditor } from '@/lib/invoiceUtils';

describe('invoice editor visibility', () => {
  it('opens the editor for a paid invoice so it can use adjustment flow', () => {
    expect(canOpenInvoiceEditor({ status: 'PAID', paid_amount: 100 })).toBe(true);
  });

  it('opens ordinary editor for an unpaid approved invoice', () => {
    expect(canOpenInvoiceEditor({ status: 'APPROVED', paid_amount: 0 })).toBe(true);
  });

  it('never opens editor for cancelled invoices', () => {
    expect(canOpenInvoiceEditor({ status: 'CANCELLED', paid_amount: 100 })).toBe(false);
  });
});
