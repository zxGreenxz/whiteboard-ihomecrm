/**
 * Pure helper functions for meter readings business logic.
 * Extracted for testability without Supabase/browser dependencies.
 */

import { excelImportRowSchema } from '../lib/meterReadingValidation';
import type { ExcelImportRow } from '../lib/meterReadingValidation';

// --- Pure helper: create insert payload for a new meter reading ---

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
  status: "UNAPPROVED";
} {
  return {
    user_id: input.userId,
    meter_id: input.meterId,
    reading_date: input.readingDate,
    current_reading: input.currentReading,
    notes: input.notes ?? null,
    meter_image_url: input.meterImageUrl ?? null,
    status: "UNAPPROVED",
  };
}

// --- Pure helpers: permission checks based on approval status ---

export function canEditReading(status: "UNAPPROVED" | "APPROVED"): boolean {
  return status === "UNAPPROVED";
}

export function canDeleteReading(status: "UNAPPROVED" | "APPROVED"): boolean {
  return status === "UNAPPROVED";
}

// --- Pure helpers: approval state transitions ---

export function applyApproval(
  _reading: {
    status: "UNAPPROVED" | "APPROVED";
    approved_by: string | null;
    approved_at: string | null;
  },
  approverId: string,
  approvedAt: string
): {
  status: "APPROVED";
  approved_by: string;
  approved_at: string;
} {
  return {
    status: "APPROVED",
    approved_by: approverId,
    approved_at: approvedAt,
  };
}

export function applyUnapproval(
  _reading: {
    status: "UNAPPROVED" | "APPROVED";
    approved_by: string | null;
    approved_at: string | null;
  }
): {
  status: "UNAPPROVED";
  approved_by: null;
  approved_at: null;
} {
  return {
    status: "UNAPPROVED",
    approved_by: null,
    approved_at: null,
  };
}

// --- Pure helper: bulk delete filter (only deletes UNAPPROVED readings) ---

export function bulkDeleteUnapprovedOnly<
  T extends { id: string; status: "UNAPPROVED" | "APPROVED" }
>(
  readings: T[],
  idsToDelete: string[]
): { remaining: T[]; deleted: T[] } {
  const idsSet = new Set(idsToDelete);
  const deleted: T[] = [];
  const remaining: T[] = [];

  for (const reading of readings) {
    if (idsSet.has(reading.id) && reading.status === "UNAPPROVED") {
      deleted.push(reading);
    } else {
      remaining.push(reading);
    }
  }

  return { remaining, deleted };
}

// --- Meter type label mapping ---

const METER_TYPE_LABELS: Record<string, string> = {
  ELECTRICITY: 'Điện',
  WATER: 'Nước',
  GAS: 'Gas',
};

/**
 * Pure function: generate meter name from room name and meter type.
 * E.g. generateMeterName("Phòng 201", "ELECTRICITY") → "Phòng 201 - Điện"
 */
export function generateMeterName(roomName: string, meterType: string): string {
  const typeLabel = METER_TYPE_LABELS[meterType] ?? meterType;
  return `${roomName} - ${typeLabel}`;
}

// --- Pure helper: apply updates to a meter (round-trip test) ---

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

/**
 * Pure function: apply partial updates to a meter and bump updated_at.
 * Returns a new meter object with the updates applied.
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

// --- Pure helper: apply filters to readings (for testability without Supabase) ---

export interface MeterReadingFilterable {
  building_id: string;
  room_id: string;
  meter_type: string;
  settlement_month: string;
  status: 'UNAPPROVED' | 'APPROVED';
}

export interface MeterReadingFilterParams {
  building_id?: string;
  room_id?: string;
  meter_type?: string;
  month?: string;
  status?: 'UNAPPROVED' | 'APPROVED';
}

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

// --- Pure helper: paginate a list ---

export function paginateList<T>(
  items: T[],
  page: number,
  pageSize: number,
): { data: T[]; totalCount: number } {
  const totalCount = items.length;
  const start = (page - 1) * pageSize;
  const data = items.slice(start, start + pageSize);
  return { data, totalCount };
}

// --- Pure helper: compute stats from a list of meter readings ---

export interface MeterReadingForStats {
  status: 'UNAPPROVED' | 'APPROVED';
  consumption: number;
  meter_type: string;
}

export interface ComputedStats {
  total_readings: number;
  approved_count: number;
  unapproved_count: number;
  electricity_consumption: number;
  water_consumption: number;
}

/**
 * Pure function: compute statistics from a list of meter readings.
 * - total_readings = approved_count + unapproved_count
 * - electricity_consumption = sum of consumption where meter_type === 'ELECTRICITY'
 * - water_consumption = sum of consumption where meter_type === 'WATER'
 */
export function computeStats(readings: MeterReadingForStats[]): ComputedStats {
  let approved_count = 0;
  let unapproved_count = 0;
  let electricity_consumption = 0;
  let water_consumption = 0;

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
  }

  return {
    total_readings: approved_count + unapproved_count,
    approved_count,
    unapproved_count,
    electricity_consumption,
    water_consumption,
  };
}


// --- Pure helper: get previous reading for a meter ---

export interface ReadingHistoryEntry {
  reading_date: string;
  current_reading: number;
}

/**
 * Pure function: determine the previous_reading for a new meter reading.
 * - If there are existing readings (sorted by reading_date desc), returns the
 *   current_reading of the most recent one.
 * - If no readings exist, returns the meter's initial_reading.
 */
export function getPreviousReading(
  initialReading: number,
  existingReadings: ReadingHistoryEntry[],
): number {
  if (existingReadings.length === 0) {
    return initialReading;
  }
  // Assume sorted desc by reading_date; first element is the most recent
  return existingReadings[0].current_reading;
}


// --- Pure helper: generate and validate reading codes ---

/**
 * Pure function: generate a reading code in format CSS{YYMM}{5-digit-sequence}.
 * @param yearMonth - format "YYYY-MM" (e.g. "2025-07")
 * @param sequence - positive integer (1-99999), padded to 5 digits
 * @returns reading code string, e.g. "CSS250700001"
 */
export function generateReadingCode(yearMonth: string, sequence: number): string {
  const [yyyy, mm] = yearMonth.split('-');
  const yy = yyyy.slice(2); // last 2 digits of year
  const seq = String(sequence).padStart(5, '0');
  return `CSS${yy}${mm}${seq}`;
}

/**
 * Pure function: validate that a reading code matches the expected format.
 * Format: CSS + 4 digits (YYMM) + 5 digits (sequence) = ^CSS\d{9}$
 */
export function isValidReadingCode(code: string): boolean {
  return /^CSS\d{9}$/.test(code);
}

// --- Pure helper: validate import rows ---

export interface ImportRowError {
  rowIndex: number;
  message: string;
}

export interface ValidateImportRowsResult {
  validRows: ExcelImportRow[];
  errors: ImportRowError[];
}

/**
 * Pure function: validate an array of raw import rows using excelImportRowSchema.
 * Returns valid rows and errors with row indices and messages.
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

// --- Pure helpers for invoice integration (Task 9.2) ---

/**
 * Interface for meter readings used in invoice integration.
 * Matches the shape of MeterReadingDetailed but only requires the fields
 * needed for filtering and display.
 */
export interface MeterReadingForInvoice {
  id: string;
  status: 'UNAPPROVED' | 'APPROVED';
  room_id: string;
  settlement_month: string;
  meter_type: string;
  consumption: number;
  current_reading: number;
  previous_reading: number;
  meter_name?: string;
  meter_code?: string;
  reading_code?: string;
}

/**
 * Pure function: filter meter readings to only APPROVED ones matching a specific
 * room and settlement month. Used when selecting readings for an invoice line item.
 *
 * @param readings - all available meter readings
 * @param roomId - the room to filter by
 * @param month - the settlement month to filter by (YYYY-MM)
 * @returns only APPROVED readings matching the room and month
 */
export function getApprovedReadingsForInvoice(
  readings: MeterReadingForInvoice[],
  roomId: string,
  month: string,
): MeterReadingForInvoice[] {
  return readings.filter(
    (r) =>
      r.status === 'APPROVED' &&
      r.room_id === roomId &&
      r.settlement_month === month,
  );
}

/**
 * Pure function: calculate invoice amount from consumption and unit price.
 * Returns consumption × unitPrice.
 *
 * @param consumption - the meter consumption (current_reading - previous_reading)
 * @param unitPrice - the unit price of the service
 * @returns the calculated amount
 */
export function calculateInvoiceAmount(
  consumption: number,
  unitPrice: number,
): number {
  return consumption * unitPrice;
}
