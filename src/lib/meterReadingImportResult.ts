/**
 * Kết quả từng dòng của nhập chỉ số từ Excel (`useImportMeterReadings`). Đợt 11: đã xoá bộ đọc kết quả của hàm cũ
 * `bulk_create_meter_readings` (`parseMeterReadingImportResult`, `MeterReadingImportUnknownError`) vì đợt 9 chuyển nhập chỉ
 * số sang `record_meter_readings_v2` và không còn nơi gọi.
 */
export interface MeterReadingImportRowResult {
  reading_id: string | null;
  reading_code: string | null;
  success: boolean;
  error_message: string | null;
}
