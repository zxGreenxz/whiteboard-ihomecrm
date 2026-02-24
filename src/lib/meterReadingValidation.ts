import { z } from 'zod';

// ============================================================
// Zod Schemas
// ============================================================

/** Schema cho form Thêm/Sửa Công tơ */
export const meterFormSchema = z.object({
  building_id: z.string().min(1, 'Vui lòng chọn tòa nhà'),
  room_id: z.string().min(1, 'Vui lòng chọn phòng'),
  meter_type: z.enum(['ELECTRICITY', 'WATER', 'GAS']),
  code: z.string().min(1, 'Vui lòng nhập mã công tơ'),
  initial_reading: z.number().min(0).optional().default(0),
  installation_date: z.string().optional(),
  location_note: z.string().optional(),
});

export type MeterFormValues = z.infer<typeof meterFormSchema>;

/** Schema cho form Ghi chỉ số */
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

/** Schema cho dòng import Excel */
export const excelImportRowSchema = z.object({
  meter_code: z.string().min(1, 'Mã công tơ không được trống'),
  reading_date: z.string().min(1, 'Ngày chốt không được trống'),
  current_reading: z.number().min(0, 'Chỉ số phải >= 0'),
  notes: z.string().optional(),
});

export type ExcelImportRow = z.infer<typeof excelImportRowSchema>;

// ============================================================
// Validation Functions
// ============================================================

/**
 * Validate chỉ số mới >= chỉ số đầu.
 * Trả về chuỗi lỗi nếu currentReading < previousReading, null nếu hợp lệ.
 */
export const validateReadingValue = (
  currentReading: number,
  previousReading: number,
): string | null => {
  if (currentReading < previousReading) {
    return 'Chỉ số mới phải lớn hơn hoặc bằng chỉ số đầu';
  }
  return null;
};

/**
 * Tính số tiêu thụ = chỉ số mới - chỉ số đầu.
 */
export const calculateConsumption = (
  currentReading: number,
  previousReading: number,
): number => {
  return currentReading - previousReading;
};

// ============================================================
// Reading Code Generation & Validation
// ============================================================

/**
 * Sinh mã chỉ số theo format CSS{YY}{MM}{5-digit-seq}.
 * @param yearMonth - Chuỗi "YYYY-MM" (VD: "2025-07")
 * @param sequence  - Số thứ tự (1-99999)
 * @returns Mã chỉ số (VD: "CSS250700001")
 */
export const generateReadingCode = (
  yearMonth: string,
  sequence: number,
): string => {
  const [year, month] = yearMonth.split('-');
  const yy = year.slice(-2);
  const mm = month;
  const seq = String(sequence).padStart(5, '0');
  return `CSS${yy}${mm}${seq}`;
};

/**
 * Kiểm tra mã chỉ số có đúng format CSS{YYMM}{5-digit-seq} hay không.
 * Pattern: "CSS" + 4 chữ số (YYMM) + 5 chữ số (sequence)
 */
export const isValidReadingCode = (code: string): boolean => {
  return /^CSS\d{4}\d{5}$/.test(code);
};

// ============================================================
// Import Row Validation
// ============================================================

interface ImportValidationResult {
  validRows: ExcelImportRow[];
  errors: Array<{ rowIndex: number; message: string }>;
}

/**
 * Validate mảng dòng import Excel.
 * Partition invariant: validRows.length + errors.length === rows.length
 */
export const validateImportRows = (rows: unknown[]): ImportValidationResult => {
  const validRows: ExcelImportRow[] = [];
  const errors: Array<{ rowIndex: number; message: string }> = [];

  rows.forEach((row, index) => {
    const result = excelImportRowSchema.safeParse(row);
    if (result.success) {
      validRows.push(result.data);
    } else {
      const message = result.error.issues.map((i) => i.message).join('; ');
      errors.push({ rowIndex: index, message });
    }
  });

  return { validRows, errors };
};
