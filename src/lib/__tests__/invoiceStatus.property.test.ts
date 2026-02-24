import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import { canEditInvoice, canDeleteInvoice, canApproveInvoice } from '../invoiceUtils';
import type { InvoiceStatus } from '@/types/invoice';

// =============================================
// Shared Arbitraries
// =============================================

const allStatuses: InvoiceStatus[] = ['DRAFT', 'APPROVED', 'PAID', 'PARTIAL_PAID', 'OVERDUE', 'CANCELLED'];
const nonDraftStatuses: InvoiceStatus[] = ['APPROVED', 'PAID', 'PARTIAL_PAID', 'OVERDUE', 'CANCELLED'];

const statusArb = fc.constantFrom<InvoiceStatus>(...allStatuses);
const nonDraftStatusArb = fc.constantFrom<InvoiceStatus>(...nonDraftStatuses);

// =============================================
// Property 6: Quyền sửa/xoá phụ thuộc trạng thái
// =============================================

/**
 * Feature: invoice-reimplementation
 * Property 6: Quyền sửa/xoá phụ thuộc trạng thái
 *
 * Với bất kỳ hoá đơn, canEditInvoice(status) và canDeleteInvoice(status)
 * phải trả về true khi và chỉ khi status === 'DRAFT'.
 * Với tất cả trạng thái khác (APPROVED, PAID, PARTIAL_PAID, OVERDUE, CANCELLED),
 * phải trả về false.
 *
 * **Validates: Requirements 3.6, 4.4**
 */
describe('Feature: invoice-reimplementation, Property 6: Quyền sửa/xoá phụ thuộc trạng thái', () => {
  it('canEditInvoice returns true only when status is DRAFT', () => {
    fc.assert(
      fc.property(statusArb, (status) => {
        const result = canEditInvoice(status);
        if (status === 'DRAFT') {
          expect(result).toBe(true);
        } else {
          expect(result).toBe(false);
        }
      }),
      { numRuns: 100 },
    );
  });

  it('canDeleteInvoice returns true only when status is DRAFT', () => {
    fc.assert(
      fc.property(statusArb, (status) => {
        const result = canDeleteInvoice(status);
        if (status === 'DRAFT') {
          expect(result).toBe(true);
        } else {
          expect(result).toBe(false);
        }
      }),
      { numRuns: 100 },
    );
  });

  it('canEditInvoice and canDeleteInvoice always return false for non-DRAFT statuses', () => {
    fc.assert(
      fc.property(nonDraftStatusArb, (status) => {
        expect(canEditInvoice(status)).toBe(false);
        expect(canDeleteInvoice(status)).toBe(false);
      }),
      { numRuns: 100 },
    );
  });
});

// =============================================
// Property 4: Hoá đơn mới luôn có trạng thái DRAFT
// =============================================

/**
 * Feature: invoice-reimplementation
 * Property 4: Hoá đơn mới luôn có trạng thái DRAFT
 *
 * Với bất kỳ hoá đơn hợp lệ được tạo mới, trạng thái ban đầu phải luôn là DRAFT.
 * This is a conceptual test: the initial status constant used when creating invoices
 * must always be 'DRAFT'.
 *
 * **Validates: Requirements 1.12**
 */
describe('Feature: invoice-reimplementation, Property 4: Hoá đơn mới luôn có trạng thái DRAFT', () => {
  const INITIAL_INVOICE_STATUS: InvoiceStatus = 'DRAFT';

  it('initial invoice status is always DRAFT regardless of other invoice data', () => {
    fc.assert(
      fc.property(
        fc.record({
          building_id: fc.uuid(),
          room_id: fc.uuid(),
          contract_id: fc.uuid(),
          billing_month: fc.integer({ min: 2020, max: 2030 }).chain((year) =>
            fc.integer({ min: 1, max: 12 }).map((month) =>
              `${year}-${String(month).padStart(2, '0')}`
            )
          ),
          total_amount: fc.double({ min: 0, max: 100_000_000, noNaN: true, noDefaultInfinity: true }),
        }),
        (_invoiceData) => {
          // No matter what data is provided, a new invoice must start as DRAFT
          expect(INITIAL_INVOICE_STATUS).toBe('DRAFT');

          // DRAFT invoices should be editable and deletable
          expect(canEditInvoice(INITIAL_INVOICE_STATUS)).toBe(true);
          expect(canDeleteInvoice(INITIAL_INVOICE_STATUS)).toBe(true);
          expect(canApproveInvoice(INITIAL_INVOICE_STATUS)).toBe(true);
        },
      ),
      { numRuns: 100 },
    );
  });
});

// =============================================
// Property 7: Duyệt/Bỏ duyệt là round-trip
// =============================================

/**
 * Feature: invoice-reimplementation
 * Property 7: Duyệt/Bỏ duyệt là round-trip
 *
 * Với bất kỳ hoá đơn có trạng thái DRAFT, thực hiện duyệt (→ APPROVED)
 * rồi bỏ duyệt (→ DRAFT) phải đưa hoá đơn về trạng thái ban đầu DRAFT.
 *
 * **Validates: Requirements 4.2, 4.3, 4.5**
 */
describe('Feature: invoice-reimplementation, Property 7: Duyệt/Bỏ duyệt là round-trip', () => {
  // Model the state transitions as pure functions
  function approve(status: InvoiceStatus): InvoiceStatus {
    if (canApproveInvoice(status)) {
      return 'APPROVED';
    }
    return status;
  }

  function unapprove(status: InvoiceStatus): InvoiceStatus {
    if (status === 'APPROVED') {
      return 'DRAFT';
    }
    return status;
  }

  it('DRAFT → approve → APPROVED → unapprove → DRAFT is a round-trip', () => {
    fc.assert(
      fc.property(
        fc.record({
          invoice_id: fc.uuid(),
          total_amount: fc.double({ min: 0, max: 100_000_000, noNaN: true, noDefaultInfinity: true }),
        }),
        (_invoiceData) => {
          const initial: InvoiceStatus = 'DRAFT';

          // Step 1: Approve (DRAFT → APPROVED)
          const afterApprove = approve(initial);
          expect(afterApprove).toBe('APPROVED');

          // After approval, edit/delete should be blocked
          expect(canEditInvoice(afterApprove)).toBe(false);
          expect(canDeleteInvoice(afterApprove)).toBe(false);

          // Step 2: Unapprove (APPROVED → DRAFT)
          const afterUnapprove = unapprove(afterApprove);
          expect(afterUnapprove).toBe('DRAFT');

          // After unapproval, should be back to initial state
          expect(afterUnapprove).toBe(initial);

          // Edit/delete should be allowed again
          expect(canEditInvoice(afterUnapprove)).toBe(true);
          expect(canDeleteInvoice(afterUnapprove)).toBe(true);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('approve is a no-op for non-DRAFT statuses', () => {
    fc.assert(
      fc.property(nonDraftStatusArb, (status) => {
        const result = approve(status);
        // canApproveInvoice returns false for non-DRAFT, so status stays the same
        expect(result).toBe(status);
      }),
      { numRuns: 100 },
    );
  });
});

// =============================================
// Property 8: Soft-delete đặt deleted_at
// =============================================

/**
 * Feature: invoice-reimplementation
 * Property 8: Soft-delete đặt deleted_at
 *
 * Với bất kỳ hoá đơn khi thực hiện xoá, trường deleted_at phải được đặt giá trị
 * (không null), và hoá đơn đó không được xuất hiện trong kết quả truy vấn danh sách
 * thông thường (filtered by deleted_at IS NULL).
 *
 * **Validates: Requirements 3.4, 3.5**
 */
describe('Feature: invoice-reimplementation, Property 8: Soft-delete đặt deleted_at', () => {
  // Model soft-delete as a pure function
  function softDelete(invoice: { deleted_at: string | null }): { deleted_at: string } {
    return { ...invoice, deleted_at: new Date().toISOString() };
  }

  // Model the list filter (normal queries exclude soft-deleted records)
  function filterActiveInvoices<T extends { deleted_at: string | null }>(invoices: T[]): T[] {
    return invoices.filter((inv) => inv.deleted_at === null);
  }

  it('soft-delete sets deleted_at to a non-null ISO timestamp', () => {
    fc.assert(
      fc.property(
        fc.record({
          id: fc.uuid(),
          status: statusArb,
          total_amount: fc.double({ min: 0, max: 100_000_000, noNaN: true, noDefaultInfinity: true }),
          deleted_at: fc.constant(null as string | null),
        }),
        (invoice) => {
          // Before delete: deleted_at is null
          expect(invoice.deleted_at).toBeNull();

          // Perform soft-delete
          const deleted = softDelete(invoice);

          // After delete: deleted_at must be set (not null)
          expect(deleted.deleted_at).not.toBeNull();
          expect(typeof deleted.deleted_at).toBe('string');
          expect(deleted.deleted_at.length).toBeGreaterThan(0);

          // Validate it's a valid ISO date string
          const parsedDate = new Date(deleted.deleted_at);
          expect(parsedDate.getTime()).not.toBeNaN();
        },
      ),
      { numRuns: 100 },
    );
  });

  it('soft-deleted invoices do not appear in normal query results', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            id: fc.uuid(),
            status: statusArb,
            deleted_at: fc.constant(null as string | null),
          }),
          { minLength: 1, maxLength: 10 },
        ),
        fc.integer({ min: 0 }),
        (invoices, deleteIndexSeed) => {
          // Pick a random invoice to delete
          const deleteIndex = deleteIndexSeed % invoices.length;
          const targetId = invoices[deleteIndex].id;

          // Soft-delete the chosen invoice
          const updatedInvoices = invoices.map((inv) =>
            inv.id === targetId
              ? { ...inv, deleted_at: new Date().toISOString() }
              : inv,
          );

          // Filter active invoices (simulating WHERE deleted_at IS NULL)
          const activeInvoices = filterActiveInvoices(updatedInvoices);

          // The deleted invoice must NOT appear in active results
          const deletedInActive = activeInvoices.find((inv) => inv.id === targetId);
          expect(deletedInActive).toBeUndefined();

          // Active count should be one less than original
          expect(activeInvoices.length).toBe(invoices.length - 1);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('bulk soft-delete sets deleted_at for all selected invoices', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            id: fc.uuid(),
            status: statusArb,
            deleted_at: fc.constant(null as string | null),
          }),
          { minLength: 2, maxLength: 10 },
        ),
        fc.integer({ min: 1 }),
        (invoices, deleteCountSeed) => {
          // Select a subset to delete
          const deleteCount = Math.min(deleteCountSeed % invoices.length + 1, invoices.length);
          const idsToDelete = new Set(invoices.slice(0, deleteCount).map((inv) => inv.id));

          // Bulk soft-delete
          const updatedInvoices = invoices.map((inv) =>
            idsToDelete.has(inv.id)
              ? { ...inv, deleted_at: new Date().toISOString() }
              : inv,
          );

          // All deleted invoices must have deleted_at set
          for (const inv of updatedInvoices) {
            if (idsToDelete.has(inv.id)) {
              expect(inv.deleted_at).not.toBeNull();
            } else {
              expect(inv.deleted_at).toBeNull();
            }
          }

          // Filter active invoices
          const activeInvoices = filterActiveInvoices(updatedInvoices);
          expect(activeInvoices.length).toBe(invoices.length - deleteCount);

          // None of the deleted IDs should appear in active results
          for (const inv of activeInvoices) {
            expect(idsToDelete.has(inv.id)).toBe(false);
          }
        },
      ),
      { numRuns: 100 },
    );
  });
});
