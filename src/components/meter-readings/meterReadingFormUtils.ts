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
 * Strip meter type prefix from a meter code.
 * "CTD-111PVC-101" -> "111PVC-101", "CTN-A-12" -> "A-12".
 * Returns the original code if it has no dash separator.
 */
export function formatSimpleMeterName(code: string | null | undefined): string {
  if (!code) return '';
  const parts = code.split('-');
  if (parts.length <= 1) return code;
  return parts.slice(1).join('-');
}

/**
 * Get display name for a meter from the unrecorded meters list.
 * Trả về tên rút gọn dạng "Tòa nhà-Phòng" (vd "111PVC-101"), bỏ prefix loại công tơ.
 *
 * Requirements: 2.3
 */
export function getMeterNameFromList(meterId: string, metersList: UnrecordedMeter[]): string {
  const meter = metersList.find((m) => m.meter_id === meterId);
  if (!meter) return '';
  return formatSimpleMeterName(meter.meter_code);
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

// ---------------------------------------------------------------------------
// Nhánh CHỈNH SỬA (isEditing && reading): lấy số/tên từ chính bản ghi đang sửa,
// không dò trong danh sách công tơ chưa ghi.
//
// Tách ra đây vì `meterReadingFormBugfix.preservation.test.ts` từng CHÉP TAY hai
// hàm này vào chính file test, và bản chép đã lệch: nó viết
// `reading.meter_name || reading.meter_code || ''` trong khi component từ lâu đã
// dùng `formatSimpleMeterName(reading.meter_code)` và bỏ hẳn `meter_name`. Test
// vì thế khẳng định một hành vi không còn tồn tại — xanh, nhưng nói về quá khứ.
// ---------------------------------------------------------------------------

/** Chỉ số cũ khi đang SỬA một bản ghi: lấy thẳng từ bản ghi đó. */
export function previousReadingWhenEditing(
  reading: { previous_reading: number | null } | null | undefined,
): number {
  return reading?.previous_reading ?? 0;
}

/** Tên công tơ khi đang SỬA: rút gọn từ mã của chính bản ghi đó. */
export function meterNameWhenEditing(
  reading: { meter_code: string | null } | null | undefined,
): string {
  return formatSimpleMeterName(reading?.meter_code);
}
