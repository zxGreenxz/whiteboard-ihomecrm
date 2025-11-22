import * as XLSX from 'xlsx';
import { EXCEL_COLUMN_MAP } from './contractExcelTemplate';
import { format, parse } from 'date-fns';

export interface ParsedContractRow {
  // Contract basic info
  building: string;
  room: string;
  bed?: string;
  rent_price: number;
  deposit: number;
  signed_date: string;
  start_date: string;
  billing_start_date: string;
  end_date: string;
  payment_cycle: string;
  notes?: string;

  // Tenant info
  tenant_name: string;
  tenant_phone: string;

  // Services
  services: Array<{
    name: string;
    use: boolean;
    has_meter?: boolean;
    initial_reading?: number;
    quantity?: number;
    unit_price: number;
    billing_date: string;
  }>;

  // Row number for error reporting
  rowIndex: number;
}

export interface ParseResult {
  success: boolean;
  data: ParsedContractRow[];
  errors: Array<{
    row: number;
    column?: string;
    message: string;
  }>;
}

/**
 * Parse date from Excel format (dd-mm-yyyy or Excel serial date)
 */
const parseExcelDate = (value: any): string | null => {
  if (!value) return null;

  // If it's already a Date object
  if (value instanceof Date) {
    return format(value, 'yyyy-MM-dd');
  }

  // If it's an Excel serial number (days since 1900-01-01)
  if (typeof value === 'number') {
    const date = XLSX.SSF.parse_date_code(value);
    return format(new Date(date.y, date.m - 1, date.d), 'yyyy-MM-dd');
  }

  // If it's a string in dd-mm-yyyy format
  if (typeof value === 'string') {
    // Try dd-mm-yyyy format
    const parts = value.split('-');
    if (parts.length === 3) {
      const [day, month, year] = parts;
      const date = new Date(parseInt(year), parseInt(month) - 1, parseInt(day));
      if (!isNaN(date.getTime())) {
        return format(date, 'yyyy-MM-dd');
      }
    }

    // Try parsing other formats
    try {
      const parsedDate = parse(value, 'dd/MM/yyyy', new Date());
      if (!isNaN(parsedDate.getTime())) {
        return format(parsedDate, 'yyyy-MM-dd');
      }
    } catch (e) {
      // ignore
    }
  }

  return null;
};

/**
 * Parse payment cycle to enum value
 */
const parsePaymentCycle = (value: any): string => {
  if (!value) return 'MONTHLY';

  const str = String(value).toLowerCase().trim();

  if (str.includes('tháng') || str === 'monthly' || str === '1') {
    return 'MONTHLY';
  }
  if (str.includes('quý') || str === 'quarterly' || str === '3') {
    return 'QUARTERLY';
  }
  if (str.includes('6') || str === 'semi_annual' || str === 'semi-annual') {
    return 'SEMI_ANNUAL';
  }
  if (str.includes('năm') || str === 'annual' || str === '12') {
    return 'ANNUAL';
  }

  return 'MONTHLY';
};

/**
 * Parse number value (handles formatted numbers like "4,400,000")
 */
const parseNumber = (value: any): number | null => {
  if (value === null || value === undefined || value === '') return null;

  if (typeof value === 'number') return value;

  // Remove commas and parse
  if (typeof value === 'string') {
    const cleaned = value.replace(/,/g, '').trim();
    const num = parseFloat(cleaned);
    return isNaN(num) ? null : num;
  }

  return null;
};

/**
 * Parse boolean value (1, 0, "có", "không", true, false)
 */
const parseBoolean = (value: any): boolean => {
  if (value === null || value === undefined || value === '') return false;

  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value === 1;

  if (typeof value === 'string') {
    const str = value.toLowerCase().trim();
    return str === '1' || str === 'có' || str === 'true' || str === 'yes';
  }

  return false;
};

/**
 * Parse Excel file and extract contract data
 */
export const parseContractExcel = (file: File): Promise<ParseResult> => {
  return new Promise((resolve) => {
    const reader = new FileReader();

    reader.onload = (e) => {
      try {
        const data = e.target?.result;
        const workbook = XLSX.read(data, { type: 'binary' });

        // Get first sheet
        const sheetName = workbook.SheetNames[0];
        const worksheet = workbook.Sheets[sheetName];

        // Convert to array of arrays
        const rows: any[][] = XLSX.utils.sheet_to_json(worksheet, { header: 1 });

        const parsedData: ParsedContractRow[] = [];
        const errors: ParseResult['errors'] = [];

        // Start from row 3 (index 2) - skip header and instructions
        for (let i = 2; i < rows.length; i++) {
          const row = rows[i];
          const rowNum = i + 1; // Excel row number (1-indexed)

          // Skip empty rows
          if (!row || row.length === 0 || !row[EXCEL_COLUMN_MAP.BUILDING]) {
            continue;
          }

          try {
            // Parse basic contract info
            const building = String(row[EXCEL_COLUMN_MAP.BUILDING] || '').trim();
            const room = String(row[EXCEL_COLUMN_MAP.ROOM] || '').trim();
            const bed = String(row[EXCEL_COLUMN_MAP.BED] || '').trim();

            // Validate required fields
            if (!building) {
              errors.push({ row: rowNum, column: 'A', message: 'Căn hộ không được để trống' });
              continue;
            }
            if (!room) {
              errors.push({ row: rowNum, column: 'B', message: 'Phòng không được để trống' });
              continue;
            }

            const rent_price = parseNumber(row[EXCEL_COLUMN_MAP.RENT_PRICE]);
            const deposit = parseNumber(row[EXCEL_COLUMN_MAP.DEPOSIT]);

            if (rent_price === null || rent_price < 0) {
              errors.push({ row: rowNum, column: 'D', message: 'Giá thuê không hợp lệ' });
              continue;
            }
            if (deposit === null || deposit < 0) {
              errors.push({ row: rowNum, column: 'E', message: 'Tiền cọc không hợp lệ' });
              continue;
            }

            // Parse dates
            const signed_date = parseExcelDate(row[EXCEL_COLUMN_MAP.SIGNED_DATE]);
            const start_date = parseExcelDate(row[EXCEL_COLUMN_MAP.START_DATE]);
            const billing_start_date = parseExcelDate(row[EXCEL_COLUMN_MAP.BILLING_START_2]) || start_date;
            const end_date = parseExcelDate(row[EXCEL_COLUMN_MAP.END_DATE]);

            if (!signed_date) {
              errors.push({ row: rowNum, column: 'F', message: 'Ngày ký không hợp lệ' });
              continue;
            }
            if (!start_date) {
              errors.push({ row: rowNum, column: 'I', message: 'Ngày bắt đầu không hợp lệ' });
              continue;
            }
            if (!end_date) {
              errors.push({ row: rowNum, column: 'J', message: 'Hạn hợp đồng không hợp lệ' });
              continue;
            }

            // Parse tenant info
            const tenant_name = String(row[EXCEL_COLUMN_MAP.TENANT_NAME] || '').trim();
            const tenant_phone = String(row[EXCEL_COLUMN_MAP.TENANT_PHONE] || '').trim();

            if (!tenant_name) {
              errors.push({ row: rowNum, column: 'M', message: 'Họ tên khách không được để trống' });
              continue;
            }
            if (!tenant_phone) {
              errors.push({ row: rowNum, column: 'N', message: 'SDT khách không được để trống' });
              continue;
            }

            const payment_cycle = parsePaymentCycle(row[EXCEL_COLUMN_MAP.PAYMENT_CYCLE]);
            const notes = String(row[EXCEL_COLUMN_MAP.NOTES] || '').trim();

            // Parse services
            const services: ParsedContractRow['services'] = [];

            // Water
            if (parseBoolean(row[EXCEL_COLUMN_MAP.WATER_USE])) {
              const quantity = parseNumber(row[EXCEL_COLUMN_MAP.WATER_QUANTITY]) || 1;
              const unit_price = parseNumber(row[EXCEL_COLUMN_MAP.WATER_PRICE]) || 0;
              const billing_date = parseExcelDate(row[EXCEL_COLUMN_MAP.WATER_BILLING_DATE]) || billing_start_date || start_date;

              services.push({
                name: 'Nước',
                use: true,
                has_meter: false,
                quantity,
                unit_price,
                billing_date: billing_date!,
              });
            }

            // Electricity
            if (parseBoolean(row[EXCEL_COLUMN_MAP.ELECTRIC_USE])) {
              const has_meter = parseBoolean(row[EXCEL_COLUMN_MAP.ELECTRIC_METER]);
              const initial_reading = parseNumber(row[EXCEL_COLUMN_MAP.ELECTRIC_INITIAL]) || 0;
              const unit_price = parseNumber(row[EXCEL_COLUMN_MAP.ELECTRIC_PRICE]) || 0;
              const billing_date = parseExcelDate(row[EXCEL_COLUMN_MAP.ELECTRIC_BILLING_DATE]) || billing_start_date || start_date;

              services.push({
                name: 'Điện',
                use: true,
                has_meter,
                initial_reading: has_meter ? initial_reading : undefined,
                quantity: has_meter ? undefined : 1,
                unit_price,
                billing_date: billing_date!,
              });
            }

            // Cleaning fee
            if (parseBoolean(row[EXCEL_COLUMN_MAP.CLEANING_USE])) {
              const quantity = parseNumber(row[EXCEL_COLUMN_MAP.CLEANING_QUANTITY]) || 1;
              const unit_price = parseNumber(row[EXCEL_COLUMN_MAP.CLEANING_PRICE]) || 0;
              const billing_date = parseExcelDate(row[EXCEL_COLUMN_MAP.CLEANING_BILLING_DATE]) || billing_start_date || start_date;

              services.push({
                name: 'Phí vệ sinh',
                use: true,
                has_meter: false,
                quantity,
                unit_price,
                billing_date: billing_date!,
              });
            }

            // Damage fee
            if (parseBoolean(row[EXCEL_COLUMN_MAP.DAMAGE_USE])) {
              const quantity = parseNumber(row[EXCEL_COLUMN_MAP.DAMAGE_QUANTITY]) || 1;
              const unit_price = parseNumber(row[EXCEL_COLUMN_MAP.DAMAGE_PRICE]) || 0;
              const billing_date = parseExcelDate(row[EXCEL_COLUMN_MAP.DAMAGE_BILLING_DATE]) || billing_start_date || start_date;

              services.push({
                name: 'Phí Hư Hỏng',
                use: true,
                has_meter: false,
                quantity,
                unit_price,
                billing_date: billing_date!,
              });
            }

            parsedData.push({
              building,
              room,
              bed: bed || undefined,
              rent_price,
              deposit,
              signed_date,
              start_date,
              billing_start_date: billing_start_date!,
              end_date,
              payment_cycle,
              notes: notes || undefined,
              tenant_name,
              tenant_phone,
              services,
              rowIndex: rowNum,
            });
          } catch (error) {
            errors.push({
              row: rowNum,
              message: `Lỗi parse dữ liệu: ${error instanceof Error ? error.message : 'Unknown error'}`,
            });
          }
        }

        resolve({
          success: errors.length === 0,
          data: parsedData,
          errors,
        });
      } catch (error) {
        resolve({
          success: false,
          data: [],
          errors: [{
            row: 0,
            message: `Lỗi đọc file Excel: ${error instanceof Error ? error.message : 'Unknown error'}`,
          }],
        });
      }
    };

    reader.onerror = () => {
      resolve({
        success: false,
        data: [],
        errors: [{ row: 0, message: 'Không thể đọc file' }],
      });
    };

    reader.readAsBinaryString(file);
  });
};
