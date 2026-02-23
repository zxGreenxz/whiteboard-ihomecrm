/**
 * Unit tests for invoice integration helper functions.
 * Tests getApprovedReadingsForInvoice and calculateInvoiceAmount.
 *
 * Validates: Requirements 11.1, 11.2
 */
import { describe, it, expect } from 'vitest';
import {
  getApprovedReadingsForInvoice,
  calculateInvoiceAmount,
  type MeterReadingForInvoice,
} from '../useMeterReadingsHelpers';

describe('getApprovedReadingsForInvoice', () => {
  const makeReading = (
    overrides: Partial<MeterReadingForInvoice> = {},
  ): MeterReadingForInvoice => ({
    id: 'r1',
    status: 'APPROVED',
    room_id: 'room-1',
    settlement_month: '2025-07',
    meter_type: 'ELECTRICITY',
    consumption: 100,
    current_reading: 500,
    previous_reading: 400,
    ...overrides,
  });

  it('returns only APPROVED readings matching room and month', () => {
    const readings: MeterReadingForInvoice[] = [
      makeReading({ id: 'r1', status: 'APPROVED', room_id: 'room-1', settlement_month: '2025-07' }),
      makeReading({ id: 'r2', status: 'UNAPPROVED', room_id: 'room-1', settlement_month: '2025-07' }),
      makeReading({ id: 'r3', status: 'APPROVED', room_id: 'room-2', settlement_month: '2025-07' }),
      makeReading({ id: 'r4', status: 'APPROVED', room_id: 'room-1', settlement_month: '2025-06' }),
    ];

    const result = getApprovedReadingsForInvoice(readings, 'room-1', '2025-07');
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('r1');
  });

  it('returns empty array when no readings match', () => {
    const readings: MeterReadingForInvoice[] = [
      makeReading({ status: 'UNAPPROVED' }),
    ];

    const result = getApprovedReadingsForInvoice(readings, 'room-1', '2025-07');
    expect(result).toHaveLength(0);
  });

  it('returns empty array for empty input', () => {
    const result = getApprovedReadingsForInvoice([], 'room-1', '2025-07');
    expect(result).toHaveLength(0);
  });

  it('returns multiple approved readings for same room/month', () => {
    const readings: MeterReadingForInvoice[] = [
      makeReading({ id: 'r1', meter_type: 'ELECTRICITY' }),
      makeReading({ id: 'r2', meter_type: 'WATER' }),
    ];

    const result = getApprovedReadingsForInvoice(readings, 'room-1', '2025-07');
    expect(result).toHaveLength(2);
  });
});

describe('calculateInvoiceAmount', () => {
  it('returns consumption × unitPrice', () => {
    expect(calculateInvoiceAmount(100, 3500)).toBe(350000);
  });

  it('returns 0 when consumption is 0', () => {
    expect(calculateInvoiceAmount(0, 3500)).toBe(0);
  });

  it('returns 0 when unitPrice is 0', () => {
    expect(calculateInvoiceAmount(100, 0)).toBe(0);
  });

  it('handles decimal values', () => {
    expect(calculateInvoiceAmount(15.5, 25000)).toBe(387500);
  });
});
