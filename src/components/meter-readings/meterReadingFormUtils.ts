/**
 * Pure utility functions for MeterReadingForm.
 * These functions handle mapping between RPC response schema and form data.
 *
 * RPC `get_meters_without_readings` returns:
 * - meter_id (UUID), meter_code (TEXT), meter_name (TEXT), room_name (TEXT)
 * - meter_type_value (enum), last_reading (DECIMAL), last_reading_date (DATE)
 */

/** Type for RPC response from get_meters_without_readings */
export interface UnrecordedMeter {
  meter_id: string;
  meter_code: string;
  meter_name: string;
  room_name: string;
  meter_type_value: 'ELECTRICITY' | 'WATER' | 'GAS';
  last_reading: number;
  last_reading_date: string | null;
}

/** Type for a single reading entry in the form */
export interface ReadingFormEntry {
  meter_id: string;
  current_reading: number;
  notes: string;
  meter_image_url: string;
}

/** Type for filter state used by isLoadEnabled */
export interface LoadEnabledFilters {
  buildingId: string;
  month: string;
}

/** Input for creating a meter reading payload */
export interface CreateMeterReadingPayloadInput {
  user_id: string;
  meter_id: string;
  reading_date: string;
  current_reading: number;
  notes?: string;
  meter_image_url?: string;
}

/** Payload sent to Supabase for creating a meter reading */
export interface CreateMeterReadingPayload {
  user_id: string;
  meter_id: string;
  reading_date: string;
  current_reading: number;
  notes: string | null;
  meter_image_url: string | null;
  status: 'APPROVED';
  approved_by: string;
  approved_at: string;
}

/**
 * Map an RPC response meter to a reading form entry.
 *
 * Requirements: 2.8
 */
export function mapMeterToReading(meter: UnrecordedMeter): ReadingFormEntry {
  return {
    meter_id: meter.meter_id,
    current_reading: 0,
    notes: '',
    meter_image_url: '',
  };
}

/**
 * Get previous reading value for a meter from the unrecorded meters list.
 * Returns last_reading of the matching meter, or 0 if not found.
 *
 * Requirements: 2.3
 */
export function getPreviousReadingFromList(meterId: string, metersList: UnrecordedMeter[]): number {
  const meter = metersList.find((m) => m.meter_id === meterId);
  if (!meter) return 0;
  return meter.last_reading ?? 0;
}

/**
 * Get display name for a meter from the unrecorded meters list.
 * Returns meter_name if non-empty, otherwise meter_code, or '' if not found.
 *
 * Requirements: 2.3
 */
export function getMeterNameFromList(meterId: string, metersList: UnrecordedMeter[]): string {
  const meter = metersList.find((m) => m.meter_id === meterId);
  return meter?.meter_name || meter?.meter_code || '';
}

/**
 * Check if minimum conditions are met to load meters.
 * Returns true when both buildingId and month are non-empty.
 *
 * Requirements: 2.2
 */
export function isLoadEnabled(filters: LoadEnabledFilters): boolean {
  return !!filters.buildingId && !!filters.month;
}

/**
 * Create a meter reading payload that is auto-approved.
 * Converts optional notes/meter_image_url to null when not provided.
 *
 * Requirements: 2.4
 */
export function createMeterReadingPayload(input: CreateMeterReadingPayloadInput): CreateMeterReadingPayload {
  return {
    user_id: input.user_id,
    meter_id: input.meter_id,
    reading_date: input.reading_date,
    current_reading: input.current_reading,
    notes: input.notes || null,
    meter_image_url: input.meter_image_url || null,
    status: 'APPROVED',
    approved_by: input.user_id,
    approved_at: new Date().toISOString(),
  };
}
