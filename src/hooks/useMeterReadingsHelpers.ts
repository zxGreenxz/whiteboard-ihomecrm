/**
 * Pure helper functions for meter readings business logic.
 * Extracted for testability without Supabase/browser dependencies.
 *
 * Requirements: 1.3, 1.6, 1.7, 4.2, 4.4, 5.1, 5.2, 5.3, 5.5, 6.2, 6.3, 7.1, 7.2, 8.4, 9.1, 9.2
 */

import { excelImportRowSchema } from '../lib/meterReadingValidation';
import type { ExcelImportRow } from '../lib/meterReadingValidation';

// ============================================================
// Types
// ============================================================

export type MeterType = 'ELECTRICITY' | 'WATER' | 'GAS';

export interface MeterWithDeletedAt {
  deleted_at: string | null;
  [key: string]: unknown;
}

export interface MeterWithRoom {
  building_id: string;
  meter_type: MeterType;
  deleted_at: string | null;
  [key: string]: unknown;
}

export interface MeterFilterParams {
  building_id?: string | null;
  meter_type?: MeterType | null;
}

export interface ReadingHistoryEntry {
  current_reading: number;
  reading_date: string;
}

export interface ReadingWithStatus {
  status: 'UNAPPROVED' | 'APPROVED';
  approved_by: string | null;
  approved_at: string | null;
  [key: string]: unknown;
}

export interface MeterReadingFilterable {
  building_id: string;
  room_id: string;
  meter_type: string;
  settlement_month: string;
  status: 'UNAPPROVED' | 'APPROVED';
}

export interface MeterReadingFilterParams {
  building_id?: string | null;
  room_id?: string | null;
  meter_type?: MeterType | null;
  month?: string | null;
  status?: 'UNAPPROVED' | 'APPROVED' | null;
}

export interface MeterReadingForStats {
  status: 'UNAPPROVED' | 'APPROVED';
  meter_type: MeterType;
  consumption: number;
}

export interface MeterReadingStats {
  total_readings: number;
  approved_count: number;
  unapproved_count: number;
  electricity_consumption: number;
  water_consumption: number;
  gas_consumption: number;
}

export interface MeterReadingForInvoice {
  id: string;
  status: 'UNAPPROVED' | 'APPROVED';
  room_id: string;
  settlement_month: string;
  [key: string]: unknown;
}

export interface PaginationResult<T> {
  data: T[];
  totalCount: number;
}

export interface BulkDeleteResult<T> {
  remaining: T[];
  deleted: T[];
}

// Keep backward-compatible alias
export type ComputedStats = MeterReadingStats;

// ============================================================
// Meter update types (used by useMeters property tests)
// ============================================================

export interface MeterBase {
  id: string;
  code: string;
  building_id: string;
  room_id: string | null;
  meter_type: string;
  name: string | null;
  initial_reading: number;
  installation_date: string | null;
  location_note: string | null;
  manufacturer: string | null;
  model: string | null;
  serial_number: string | null;
  notes: string | null;
  updated_at: string;
}

export type MeterUpdates = Partial<
  Pick<
    MeterBase,
    | 'code'
    | 'building_id'
    | 'room_id'
    | 'meter_type'
    | 'initial_reading'
    | 'installation_date'
    | 'location_note'
    | 'manufacturer'
    | 'model'
    | 'serial_number'
    | 'notes'
  >
>;

// Import row validation types
export interface ImportRowError {
  rowIndex: number;
  message: string;
}

export interface ValidateImportRowsResult {
  validRows: ExcelImportRow[];
  errors: ImportRowError[];
}

// ============================================================
// Meter type label mapping
// ============================================================

const METER_TYPE_LABELS: Record<string, string> = {
  ELECTRICITY: 'Điện',
  WATER: 'Nước',
  GAS: 'Gas',
};

// ============================================================
// Functions
// ============================================================

/**
 * Generate meter name from room name and meter type.
 * E.g. generateMeterName("Phòng 201", "ELECTRICITY") → "Phòng 201 - Điện"
 * Requirement: 1.3, 8.4
 */
export function generateMeterName(roomName: string, meterType: string): string {
  const typeLabel = METER_TYPE_LABELS[meterType] ?? meterType;
  return `${roomName} - ${typeLabel}`;
}

/**
 * Filter meters to only include active (non-soft-deleted) ones.
 * Requirement: 1.6, 1.7
 */
export function filterActiveMeters<T extends MeterWithDeletedAt>(meters: T[]): T[] {
  return meters.filter((m) => m.deleted_at === null);
}

/**
 * Filter meters by building_id and meter_type.
 * Only non-null filter values are applied. Also excludes soft-deleted meters.
 * Requirement: 1.7
 */
export function filterMeters<T extends MeterWithRoom>(
  meters: T[],
  filters: MeterFilterParams,
): T[] {
  return meters.filter((m) => {
    if (m.deleted_at !== null) return false;
    if (filters.building_id != null && m.building_id !== filters.building_id) return false;
    if (filters.meter_type != null && m.meter_type !== filters.meter_type) return false;
    return true;
  });
}

/**
 * Get previous reading from history entries.
 * Returns current_reading of the first entry (most recent, assuming desc sort)
 * or initialReading if no entries exist.
 * Requirement: 8.2
 */
export function getPreviousReading(
  initialReading: number,
  existingReadings: ReadingHistoryEntry[],
): number {
  if (existingReadings.length === 0) {
    return initialReading;
  }
  return existingReadings[0].current_reading;
}

/**
 * Apply approval to a reading: set status to APPROVED with approver info.
 * Requirement: 4.2
 */
export function applyApproval<T extends ReadingWithStatus>(
  _reading: T,
  approverId: string,
  approvedAt: string,
): { status: 'APPROVED'; approved_by: string; approved_at: string } {
  return {
    status: 'APPROVED',
    approved_by: approverId,
    approved_at: approvedAt,
  };
}

/**
 * Remove approval from a reading: set status to UNAPPROVED, clear approver info.
 * Requirement: 4.4
 */
export function applyUnapproval<T extends ReadingWithStatus>(
  _reading: T,
): { status: 'UNAPPROVED'; approved_by: null; approved_at: null } {
  return {
    status: 'UNAPPROVED',
    approved_by: null,
    approved_at: null,
  };
}

/**
 * Check if a reading can be edited (only UNAPPROVED).
 * Requirement: 5.1, 5.2
 */
export function canEditReading(status: 'UNAPPROVED' | 'APPROVED'): boolean {
  return status === 'UNAPPROVED';
}

/**
 * Check if a reading can be deleted (only UNAPPROVED).
 * Requirement: 5.3
 */
export function canDeleteReading(status: 'UNAPPROVED' | 'APPROVED'): boolean {
  return status === 'UNAPPROVED';
}

/**
 * Bulk delete only UNAPPROVED readings from a list.
 * Returns remaining and deleted arrays. APPROVED readings are never deleted.
 * Requirement: 5.5
 */
export function bulkDeleteUnapprovedOnly<
  T extends { id: string; status: 'UNAPPROVED' | 'APPROVED' },
>(
  readings: T[],
  idsToDelete: string[],
): BulkDeleteResult<T> {
  const idsSet = new Set(idsToDelete);
  const deleted: T[] = [];
  const remaining: T[] = [];

  for (const reading of readings) {
    if (idsSet.has(reading.id) && reading.status === 'UNAPPROVED') {
      deleted.push(reading);
    } else {
      remaining.push(reading);
    }
  }

  return { remaining, deleted };
}

/**
 * Apply filters to meter readings list.
 * Only non-null/non-undefined filter values are applied.
 * Requirement: 6.2
 */
export function applyMeterReadingFilters<T extends MeterReadingFilterable>(
  readings: T[],
  filters: MeterReadingFilterParams,
): T[] {
  return readings.filter((r) => {
    if (filters.building_id && r.building_id !== filters.building_id) return false;
    if (filters.room_id && r.room_id !== filters.room_id) return false;
    if (filters.meter_type && r.meter_type !== filters.meter_type) return false;
    if (filters.month && r.settlement_month !== filters.month) return false;
    if (filters.status && r.status !== filters.status) return false;
    return true;
  });
}

/**
 * Paginate a list of items.
 * Returns the correct slice for the given page and totalCount.
 * Requirement: 6.3
 */
export function paginateList<T>(
  items: T[],
  page: number,
  pageSize: number,
): PaginationResult<T> {
  const totalCount = items.length;
  const start = (page - 1) * pageSize;
  const data = items.slice(start, start + pageSize);
  return { data, totalCount };
}

/**
 * Compute statistics from a list of meter readings.
 * Requirement: 7.1, 7.2
 */
export function computeStats(readings: MeterReadingForStats[]): MeterReadingStats {
  let approved_count = 0;
  let unapproved_count = 0;
  let electricity_consumption = 0;
  let water_consumption = 0;
  let gas_consumption = 0;

  for (const r of readings) {
    if (r.status === 'APPROVED') {
      approved_count++;
    } else {
      unapproved_count++;
    }
    if (r.meter_type === 'ELECTRICITY') {
      electricity_consumption += r.consumption;
    }
    if (r.meter_type === 'WATER') {
      water_consumption += r.consumption;
    }
    if (r.meter_type === 'GAS') {
      gas_consumption += r.consumption;
    }
  }

  return {
    total_readings: approved_count + unapproved_count,
    approved_count,
    unapproved_count,
    electricity_consumption,
    water_consumption,
    gas_consumption,
  };
}

/**
 * Get approved readings for invoice: filter by APPROVED status, roomId, and month.
 * Requirement: 9.1
 */
export function getApprovedReadingsForInvoice<T extends MeterReadingForInvoice>(
  readings: T[],
  roomId: string,
  month: string,
): T[] {
  return readings.filter(
    (r) =>
      r.status === 'APPROVED' &&
      r.room_id === roomId &&
      r.settlement_month === month,
  );
}

/**
 * Calculate invoice amount: consumption × unitPrice.
 * Requirement: 9.2
 */
export function calculateInvoiceAmount(
  consumption: number,
  unitPrice: number,
): number {
  return consumption * unitPrice;
}

/**
 * Create insert payload for a new meter reading.
 * Always sets status to UNAPPROVED.
 */
export function createMeterReadingPayload(input: {
  userId: string;
  meterId: string;
  readingDate: string;
  currentReading: number;
  notes?: string;
  meterImageUrl?: string;
}): {
  user_id: string;
  meter_id: string;
  reading_date: string;
  current_reading: number;
  notes: string | null;
  meter_image_url: string | null;
  status: 'UNAPPROVED';
} {
  return {
    user_id: input.userId,
    meter_id: input.meterId,
    reading_date: input.readingDate,
    current_reading: input.currentReading,
    notes: input.notes ?? null,
    meter_image_url: input.meterImageUrl ?? null,
    status: 'UNAPPROVED',
  };
}

/**
 * Apply partial updates to a meter and bump updated_at.
 * Only defined (non-undefined) update values are applied.
 */
export function applyMeterUpdate(
  meter: MeterBase,
  updates: MeterUpdates,
  newUpdatedAt: string,
): MeterBase {
  const definedUpdates: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(updates)) {
    if (value !== undefined) {
      definedUpdates[key] = value;
    }
  }
  return {
    ...meter,
    ...definedUpdates,
    updated_at: newUpdatedAt,
  } as MeterBase;
}

/**
 * Generate a reading code in format CSS{YYMM}{5-digit-sequence}.
 */
export function generateReadingCode(yearMonth: string, sequence: number): string {
  const [yyyy, mm] = yearMonth.split('-');
  const yy = yyyy.slice(2);
  const seq = String(sequence).padStart(5, '0');
  return `CSS${yy}${mm}${seq}`;
}

/**
 * Validate that a reading code matches the expected format: CSS + 4 digits (YYMM) + 5 digits (sequence).
 */
export function isValidReadingCode(code: string): boolean {
  return /^CSS\d{9}$/.test(code);
}

/**
 * Validate an array of raw import rows using excelImportRowSchema.
 * Invariant: validRows.length + errors.length === input.length
 */
export function validateImportRows(rows: unknown[]): ValidateImportRowsResult {
  const validRows: ExcelImportRow[] = [];
  const errors: ImportRowError[] = [];

  for (let i = 0; i < rows.length; i++) {
    const result = excelImportRowSchema.safeParse(rows[i]);
    if (result.success) {
      validRows.push(result.data);
    } else {
      const message = result.error.issues.map((issue) => issue.message).join('; ');
      errors.push({ rowIndex: i, message });
    }
  }

  return { validRows, errors };
}
