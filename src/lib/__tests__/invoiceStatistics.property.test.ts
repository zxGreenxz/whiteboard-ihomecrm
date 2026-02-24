import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import type { InvoiceStatus } from '@/types/invoice';

/**
 * Feature: invoice-reimplementation
 * Property 21: Thống kê hoá đơn chính xác
 *
 * Với bất kỳ tập hoá đơn, `get_invoice_statistics` phải trả về:
 * - total_paid = SUM(paid_amount) của tất cả hoá đơn trong tập
 * - total_remaining = SUM(remaining_amount) của tất cả hoá đơn trong tập
 * - total_count = số lượng hoá đơn trong tập
 *
 * **Validates: Requirements 10.1**
 */

// --- Types ---

const ALL_STATUSES: InvoiceStatus[] = ['DRAFT', 'APPROVED', 'PAID', 'PARTIAL_PAID', 'OVERDUE', 'CANCELLED'];

interface InvoiceForStats {
  id: string;
  building_id: string;
  room_id: string | null;
  status: InvoiceStatus;
  paid_amount: number;
  total_amount: number;
  remaining_amount: number;
  issue_date: string;
  deleted_at: string | null;
}

interface StatisticsFilters {
  building_id?: string;
  room_id?: string;
  status?: InvoiceStatus;
  start_date?: string;
  end_date?: string;
}

interface StatisticsResult {
  total_paid: number;
  total_remaining: number;
  total_count: number;
}

// --- Model function (pure logic mirroring the RPC) ---

function getInvoiceStatistics(invoices: InvoiceForStats[], filters: StatisticsFilters): StatisticsResult {
  let filtered = invoices.filter(inv => inv.deleted_at === null);

  if (filters.building_id) {
    filtered = filtered.filter(inv => inv.building_id === filters.building_id);
  }
  if (filters.room_id) {
    filtered = filtered.filter(inv => inv.room_id === filters.room_id);
  }
  if (filters.status) {
    filtered = filtered.filter(inv => inv.status === filters.status);
  }
  if (filters.start_date) {
    filtered = filtered.filter(inv => inv.issue_date >= filters.start_date!);
  }
  if (filters.end_date) {
    filtered = filtered.filter(inv => inv.issue_date <= filters.end_date!);
  }

  return {
    total_paid: filtered.reduce((sum, inv) => sum + inv.paid_amount, 0),
    total_remaining: filtered.reduce((sum, inv) => sum + inv.remaining_amount, 0),
    total_count: filtered.length,
  };
}

// --- Generators ---

const statusArb = fc.constantFrom<InvoiceStatus>(...ALL_STATUSES);

const buildingIdArb = fc.constantFrom('bld-1', 'bld-2', 'bld-3');
const roomIdArb = fc.constantFrom('room-1', 'room-2', 'room-3');

const dateArb = fc.integer({ min: 1, max: 28 }).chain(day =>
  fc.integer({ min: 1, max: 12 }).chain(month =>
    fc.integer({ min: 2024, max: 2025 }).map(year =>
      `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`,
    ),
  ),
);

const moneyArb = fc.double({ min: 0, max: 10_000_000, noNaN: true, noDefaultInfinity: true });

const invoiceForStatsArb: fc.Arbitrary<InvoiceForStats> = fc.record({
  id: fc.uuid(),
  building_id: buildingIdArb,
  room_id: fc.oneof(roomIdArb, fc.constant(null as string | null)),
  status: statusArb,
  total_amount: moneyArb,
  paid_amount: moneyArb,
  issue_date: dateArb,
  deleted_at: fc.oneof(
    { weight: 5, arbitrary: fc.constant(null as string | null) },
    { weight: 1, arbitrary: dateArb },
  ),
}).map(inv => ({
  ...inv,
  remaining_amount: Math.max(0, inv.total_amount - inv.paid_amount),
}));

const invoicesArb = fc.array(invoiceForStatsArb, { minLength: 0, maxLength: 30 });

// --- Tests ---

describe('Feature: invoice-reimplementation, Property 21: Thống kê hoá đơn chính xác', () => {
  it('total_paid equals SUM(paid_amount) for all matching invoices', () => {
    fc.assert(
      fc.property(invoicesArb, (invoices) => {
        const result = getInvoiceStatistics(invoices, {});
        const nonDeleted = invoices.filter(inv => inv.deleted_at === null);
        const expectedPaid = nonDeleted.reduce((sum, inv) => sum + inv.paid_amount, 0);

        expect(result.total_paid).toBe(expectedPaid);
      }),
      { numRuns: 100 },
    );
  });

  it('total_remaining equals SUM(remaining_amount) for all matching invoices', () => {
    fc.assert(
      fc.property(invoicesArb, (invoices) => {
        const result = getInvoiceStatistics(invoices, {});
        const nonDeleted = invoices.filter(inv => inv.deleted_at === null);
        const expectedRemaining = nonDeleted.reduce((sum, inv) => sum + inv.remaining_amount, 0);

        expect(result.total_remaining).toBe(expectedRemaining);
      }),
      { numRuns: 100 },
    );
  });

  it('total_count equals number of matching invoices', () => {
    fc.assert(
      fc.property(invoicesArb, (invoices) => {
        const result = getInvoiceStatistics(invoices, {});
        const nonDeleted = invoices.filter(inv => inv.deleted_at === null);

        expect(result.total_count).toBe(nonDeleted.length);
      }),
      { numRuns: 100 },
    );
  });

  it('filters correctly narrow the result set', () => {
    fc.assert(
      fc.property(
        invoicesArb,
        buildingIdArb,
        roomIdArb,
        statusArb,
        dateArb,
        dateArb,
        (invoices, buildingId, roomId, status, dateA, dateB) => {
          const startDate = dateA < dateB ? dateA : dateB;
          const endDate = dateA < dateB ? dateB : dateA;

          const filters: StatisticsFilters = {
            building_id: buildingId,
            room_id: roomId,
            status,
            start_date: startDate,
            end_date: endDate,
          };

          const result = getInvoiceStatistics(invoices, filters);

          // Manually compute expected
          const expected = invoices
            .filter(inv => inv.deleted_at === null)
            .filter(inv => inv.building_id === buildingId)
            .filter(inv => inv.room_id === roomId)
            .filter(inv => inv.status === status)
            .filter(inv => inv.issue_date >= startDate && inv.issue_date <= endDate);

          expect(result.total_count).toBe(expected.length);
          expect(result.total_paid).toBe(expected.reduce((s, inv) => s + inv.paid_amount, 0));
          expect(result.total_remaining).toBe(expected.reduce((s, inv) => s + inv.remaining_amount, 0));
        },
      ),
      { numRuns: 100 },
    );
  });

  it('soft-deleted invoices are excluded from statistics', () => {
    fc.assert(
      fc.property(invoicesArb, (invoices) => {
        // Force all invoices to be soft-deleted
        const allDeleted = invoices.map(inv => ({
          ...inv,
          deleted_at: '2025-01-01',
        }));

        const result = getInvoiceStatistics(allDeleted, {});

        expect(result.total_paid).toBe(0);
        expect(result.total_remaining).toBe(0);
        expect(result.total_count).toBe(0);
      }),
      { numRuns: 100 },
    );
  });
});
