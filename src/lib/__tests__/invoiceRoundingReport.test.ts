import { describe, expect, it } from 'vitest';
import { fetchInvoiceRoundingReport, parseInvoiceRoundingReport } from '../invoiceRoundingReport';

const id = 'dddd0000-0000-4000-8000-000000000002';
const row = {
  payment_id: id, collection_id: id, invoice_id: id, invoice_number: 'HD-09',
  building_id: id, building_name: 'DEMO', room_name: '305', billing_month: '2026-09',
  collection_date: '2026-09-08', collector_id: id, collector_name: 'Người thu',
  gross_amount: 5_000_000, change_amount: 200_000, applied_amount: 4_800_000,
  rounding_amount: 5_000, reason: 'EXTRA_CHANGE',
};
const report = {
  rows: [row], total_count: 51, invoice_count: 49, total_amount: 120_000,
  by_collector: [{ collector_id: id, collector_name: 'Người thu', total_count: 51, invoice_count: 49, total_amount: 120_000 }],
};

describe('invoice rounding report boundary', () => {
  it('preserves valid two-decimal money in rows and server summaries', () => {
    const result = parseInvoiceRoundingReport({ ...report,
      rows: [{ ...row, gross_amount: 5_000_000.25, change_amount: 200_000.75,
        applied_amount: 4_799_999.50, rounding_amount: 5_000.50 }],
      total_amount: 120_000.29,
      by_collector: [{ ...report.by_collector[0], total_amount: 120_000.29 }],
    });
    expect(result.rows[0]).toMatchObject({ gross_amount: 5_000_000.25,
      change_amount: 200_000.75, applied_amount: 4_799_999.50, rounding_amount: 5_000.50 });
    expect(result.total_amount).toBe(120_000.29);
    expect(result.by_collector[0].total_amount).toBe(120_000.29);
  });

  it.each([
    { ...report, rows: [{ ...row, rounding_amount: 5_000.001 }] },
    { ...report, total_amount: 120_000.001 },
    { ...report, by_collector: [{ ...report.by_collector[0], total_amount: 120_000.001 }] },
    { ...report, invoice_count: 49.5 },
    { ...report, by_collector: [{ ...report.by_collector[0], total_count: 51.5 }] },
  ])('rejects excess monetary precision and fractional counts', (invalid) => {
    expect(() => parseInvoiceRoundingReport(invalid)).toThrow();
  });

  it('keeps server totals and distinct invoice count across a partial page', () => {
    const result = parseInvoiceRoundingReport(report);
    expect(result.rows).toHaveLength(1);
    expect(result.total_amount).toBe(120_000);
    expect(result.invoice_count).toBe(49);
    expect(result.total_count).toBe(51);
    expect(result.by_collector[0].total_amount).toBe(120_000);
  });

  it('preserves unknown legacy tender and collector instead of inventing zeros', () => {
    const result = parseInvoiceRoundingReport({ ...report, rows: [{ ...row,
      payment_id: null, collection_id: null, collector_id: null, collector_name: null,
      gross_amount: null, change_amount: null, reason: 'LEGACY',
    }] });
    expect(result.rows[0].gross_amount).toBeNull();
    expect(result.rows[0].change_amount).toBeNull();
    expect(result.rows[0].collector_id).toBeNull();
    expect(result.rows[0].reason).toBe('LEGACY');
  });

  it.each([null, {}, { ...report, total_amount: '120000' },
    { ...report, invoice_count: -1 }, { ...report, total_count: 1.5 },
    { ...report, rows: [{ ...row, rounding_amount: Infinity }] },
    { ...report, rows: [{ ...row, reason: 'UNKNOWN' }] },
    { ...report, rows: [{ ...row, rounding_amount: -1 }] },
  ])('rejects invalid report data without showing a false empty report', (invalid) => {
    expect(() => parseInvoiceRoundingReport(invalid)).toThrow();
  });

  it('passes the selected period, collector, building and second-page offset to the boundary', async () => {
    let received: unknown;
    const result = await fetchInvoiceRoundingReport({ billingMonth: '2026-09', collectorId: id, buildingId: id, offset: 50, limit: 50 }, async (args) => {
      received = args;
      return { data: report, error: null };
    });
    expect(received).toEqual({ p_billing_month: '2026-09', p_collector_id: id, p_building_id: id, p_offset: 50, p_limit: 50 });
    expect(result.total_count).toBe(51);
  });

  it.each(['2026-00', '2026-13', '', '2026-09-01'])('rejects malformed billing month %s before requesting data', async (billingMonth) => {
    let called = false;
    await expect(fetchInvoiceRoundingReport({ billingMonth }, async () => { called = true; return { data: report, error: null }; })).rejects.toMatchObject({ kind: 'validation' });
    expect(called).toBe(false);
  });

  it.each([['42501', 'permission'], ['22023', 'validation'], ['PGRST202', 'unavailable']])('distinguishes %s without leaking database details', async (code, kind) => {
    await expect(fetchInvoiceRoundingReport({ billingMonth: '2026-09' }, async () => ({ data: null, error: { code, message: 'private SQL detail' } }))).rejects.toMatchObject({ kind });
  });
});
