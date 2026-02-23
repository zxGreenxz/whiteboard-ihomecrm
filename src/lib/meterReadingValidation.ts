import { z } from 'zod';

// Schema cho form Thêm/Sửa Công tơ
export const meterFormSchema = z.object({
  building_id: z.string().min(1, 'Vui lòng chọn tòa nhà'),
  room_id: z.string().min(1, 'Vui lòng chọn phòng'),
  meter_type: z.enum(['ELECTRICITY', 'WATER', 'GAS'], {
    required_error: 'Vui lòng chọn loại công tơ',
  }),
  code: z.string().min(1, 'Vui lòng nhập mã công tơ'),
  initial_reading: z.number().min(0).optional().default(0),
  installation_date: z.string().optional(),
  location_note: z.string().optional(),
  manufacturer: z.string().optional(),
  model: z.string().optional(),
  serial_number: z.string().optional(),
  notes: z.string().optional(),
});

export type MeterFormValues = z.infer<typeof meterFormSchema>;

// Schema cho form Ghi chỉ số
export const meterReadingFormSchema = z.object({
  building_id: z.string().min(1, 'Vui lòng chọn tòa nhà'),
  room_id: z.string().min(1, 'Vui lòng chọn phòng'),
  meter_type: z.enum(['ELECTRICITY', 'WATER', 'GAS']).nullable(),
  settlement_month: z.string().regex(/^\d{4}-\d{2}$/, 'Định dạng: YYYY-MM'),
  reading_date: z.string().min(1, 'Vui lòng chọn ngày chốt'),
  readings: z.array(z.object({
    meter_id: z.string(),
    current_reading: z.number().min(0, 'Chỉ số phải >= 0'),
    notes: z.string().optional(),
    meter_image_url: z.string().optional(),
  })).min(1, 'Vui lòng nhập ít nhất 1 chỉ số'),
});

export type MeterReadingFormValues = z.infer<typeof meterReadingFormSchema>;

// Validation: chỉ số mới >= chỉ số đầu
export const validateReadingValue = (
  currentReading: number,
  previousReading: number
): string | null => {
  if (currentReading < previousReading) {
    return 'Chỉ số mới phải lớn hơn hoặc bằng chỉ số đầu';
  }
  return null;
};

// Schema cho dòng import Excel
export const excelImportRowSchema = z.object({
  meter_code: z.string().min(1, 'Mã công tơ không được trống'),
  reading_date: z.string().min(1, 'Ngày chốt không được trống'),
  current_reading: z.number().min(0, 'Chỉ số phải >= 0'),
  notes: z.string().optional(),
});

export type ExcelImportRow = z.infer<typeof excelImportRowSchema>;

// Tính số tiêu thụ = chỉ số mới - chỉ số đầu
export const calculateConsumption = (currentReading: number, previousReading: number): number => {
  return currentReading - previousReading;
};
