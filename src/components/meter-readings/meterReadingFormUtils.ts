/**
 * Pure utility functions extracted from MeterReadingForm.tsx for testability.
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
  meter_type_value: string;
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

/** Type for filter state */
export interface LoadFilters {
  buildingId: string;
  roomId: string;
  month: string;
}

/**
 * Map an RPC response meter to a reading form entry.
 * FIX: Uses meter.meter_id (not meter.id) from RPC response.
 *
 * Requirements: 2.1
 */
export function mapMeterToReading(meter: UnrecordedMeter): ReadingFormEntry {
  return {
    meter_id: meter.meter_id, // FIXED: was meter.id
    current_reading: 0,
    notes: '',
    meter_image_url: '',
  };
}

/**
 * Get previous reading value for a meter from the unrecorded meters list.
 * FIX: Finds by meter_id (not id), returns last_reading (not latest_reading/initial_reading).
 *
 * Requirements: 2.2, 2.4
 */
export function getPreviousReadingFromList(meterId: string, metersList: UnrecordedMeter[]): number {
  const meter = metersList.find((m) => m.meter_id === meterId); // FIXED: was m.id
  if (!meter) return 0;
  return meter.last_reading ?? 0; // FIXED: was meter.latest_reading ?? meter.initial_reading ?? 0
}

/**
 * Get display name for a meter from the unrecorded meters list.
 * FIX: Finds by meter_id (not id), returns meter_name/meter_code (not name/code).
 *
 * Requirements: 2.2, 2.3
 */
export function getMeterNameFromList(meterId: string, metersList: UnrecordedMeter[]): string {
  const meter = metersList.find((m) => m.meter_id === meterId); // FIXED: was m.id
  return meter?.meter_name || meter?.meter_code || ''; // FIXED: was meter?.name || meter?.code
}

/**
 * Check if minimum conditions are met to load meters.
 * FIX: Only requires buildingId + month. Room is optional.
 *
 * Requirements: 2.5
 */
export function isLoadEnabled(filters: LoadFilters): boolean {
  return !!filters.buildingId && !!filters.month; // FIXED: removed !!filters.roomId
}
