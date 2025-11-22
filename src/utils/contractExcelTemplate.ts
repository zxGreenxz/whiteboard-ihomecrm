import * as XLSX from 'xlsx';

/**
 * Generate Excel template for bulk contract import
 * Format matches the provided screenshots exactly
 */
export const generateContractExcelTemplate = () => {
  // Define headers matching the screenshots
  const headers = [
    // Column A-N: Contract Info
    'Căn hộ (*)',
    'Phòng (*)',
    'Giường (*)',
    'Giá thuê (*)',
    'Tiền cọc (*)',
    'Ngày ký',
    'Ngày bắt đầu (Đại diện)',
    'Ngày khấu hao thanh toán',
    'Ngày bắt đầu',
    'Hạn hợp đồng',
    'Chu kỳ thanh toán',
    'Ghi chú',
    'Họ tên khách (Đại diện) (*)',
    'SDT khách (Đại diện) (*)',

    // Column O-X: Nước (Water)
    'Nước',
    'Sử dụng?',
    'Số lượng',
    'Hệ số',
    'Ngày tính phí',

    // Column Y-AH: Điện (Electricity)
    'Điện',
    'Sử dụng?',
    'Công tơ',
    'Chỉ số đầu',
    'Hệ số',
    'Ngày tính phí',

    // Column AI-AR: Phí vệ sinh (Cleaning fee)
    'Phí vệ sinh',
    'Sử dụng?',
    'Số lượng',
    'Hệ số',
    'Ngày tính phí',

    // Column AS-BB: Phí Hư Hỏng (Damage fee)
    'Phí Hư Hỏng',
    'Sử dụng?',
    'Số lượng',
    'Hệ số',
    'Ngày tính phí',
  ];

  // Sample data row (as shown in screenshot)
  const sampleData = [
    'LEPMC',           // Căn hộ
    '102',             // Phòng
    '',                // Giường (empty if renting room)
    '4400000',         // Giá thuê
    '4400000',         // Tiền cọc
    '22-11-2025',      // Ngày ký
    '22-11-2025',      // Ngày bắt đầu (Đại diện)
    '22-11-2025',      // Ngày khấu hao
    '22-11-2025',      // Ngày bắt đầu
    '22-11-2027',      // Hạn hợp đồng
    '1 tháng',         // Chu kỳ
    '',                // Ghi chú
    'Nguyễn Văn A',    // Họ tên
    '0912345678',      // SDT

    // Nước
    '',                // Header (merged cell in original)
    '1',               // Sử dụng
    '1',               // Số lượng
    '1',               // Hệ số
    '22-11-2025',      // Ngày tính phí

    // Điện
    '',                // Header
    '1',               // Sử dụng
    '1',               // Công tơ
    '1',               // Chỉ số đầu
    '1',               // Hệ số
    '22-11-2025',      // Ngày tính phí

    // Phí vệ sinh
    '',                // Header
    '1',               // Sử dụng
    '1',               // Số lượng
    '1',               // Hệ số
    '22-11-2025',      // Ngày tính phí

    // Phí Hư Hỏng
    '',                // Header
    '1',               // Sử dụng
    '1',               // Số lượng
    '1',               // Hệ số
    '22-11-2025',      // Ngày tính phí
  ];

  // Instructions row
  const instructions = [
    'Tòa nhà (LEPMC, etc)',
    'Tên phòng (101, 102, etc)',
    'Tên giường (để trống nếu thuê phòng)',
    'Số tiền thuê mỗi tháng',
    'Số tiền cọc',
    'Ngày ký hợp đồng (dd-mm-yyyy)',
    'Ngày khách bắt đầu ở',
    'Ngày bắt đầu tính tiền',
    'Ngày bắt đầu tính tiền',
    'Ngày hết hạn hợp đồng (dd-mm-yyyy)',
    'MONTHLY / QUARTERLY / SEMI_ANNUAL / ANNUAL',
    'Ghi chú về hợp đồng',
    'Họ tên khách hàng',
    'Số điện thoại',
    '',
    '1 = có, 0 = không',
    'Số lượng (cho dịch vụ cố định)',
    'Đơn giá',
    'Ngày bắt đầu tính phí',
    '',
    '1 = có, 0 = không',
    '1 = có công tơ, 0 = không',
    'Chỉ số điện ban đầu',
    'Đơn giá',
    'Ngày bắt đầu tính phí',
    '',
    '1 = có, 0 = không',
    'Số lượng',
    'Đơn giá',
    'Ngày bắt đầu tính phí',
    '',
    '1 = có, 0 = không',
    'Số lượng',
    'Đơn giá',
    'Ngày bắt đầu tính phí',
  ];

  // Create worksheet with headers, instructions, and sample data
  const data = [headers, instructions, sampleData];
  const ws = XLSX.utils.aoa_to_sheet(data);

  // Set column widths for better readability
  const colWidths = [
    { wch: 12 }, // Căn hộ
    { wch: 10 }, // Phòng
    { wch: 10 }, // Giường
    { wch: 12 }, // Giá thuê
    { wch: 12 }, // Tiền cọc
    { wch: 12 }, // Ngày ký
    { wch: 18 }, // Ngày bắt đầu (ĐD)
    { wch: 18 }, // Ngày khấu hao
    { wch: 12 }, // Ngày bắt đầu
    { wch: 12 }, // Hạn HĐ
    { wch: 15 }, // Chu kỳ
    { wch: 20 }, // Ghi chú
    { wch: 20 }, // Họ tên
    { wch: 12 }, // SDT
    // Services columns
    { wch: 12 }, { wch: 10 }, { wch: 10 }, { wch: 8 }, { wch: 12 },
    { wch: 12 }, { wch: 10 }, { wch: 10 }, { wch: 10 }, { wch: 8 }, { wch: 12 },
    { wch: 12 }, { wch: 10 }, { wch: 10 }, { wch: 8 }, { wch: 12 },
    { wch: 12 }, { wch: 10 }, { wch: 10 }, { wch: 8 }, { wch: 12 },
  ];
  ws['!cols'] = colWidths;

  // Create workbook
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Hợp đồng');

  // Generate Excel file and trigger download
  XLSX.writeFile(wb, 'Template_Import_Hop_Dong.xlsx');
};

/**
 * Column mapping for parsing Excel import
 */
export const EXCEL_COLUMN_MAP = {
  // Contract info (0-indexed)
  BUILDING: 0,          // A: Căn hộ
  ROOM: 1,              // B: Phòng
  BED: 2,               // C: Giường
  RENT_PRICE: 3,        // D: Giá thuê
  DEPOSIT: 4,           // E: Tiền cọc
  SIGNED_DATE: 5,       // F: Ngày ký
  TENANT_START: 6,      // G: Ngày bắt đầu (ĐD)
  BILLING_START_2: 7,   // H: Ngày khấu hao
  START_DATE: 8,        // I: Ngày bắt đầu
  END_DATE: 9,          // J: Hạn hợp đồng
  PAYMENT_CYCLE: 10,    // K: Chu kỳ
  NOTES: 11,            // L: Ghi chú
  TENANT_NAME: 12,      // M: Họ tên khách
  TENANT_PHONE: 13,     // N: SDT khách

  // Nước (Water) - starts at column O (index 14)
  WATER_HEADER: 14,
  WATER_USE: 15,
  WATER_QUANTITY: 16,
  WATER_PRICE: 17,
  WATER_BILLING_DATE: 18,

  // Điện (Electricity) - starts at column Y (index 19)
  ELECTRIC_HEADER: 19,
  ELECTRIC_USE: 20,
  ELECTRIC_METER: 21,
  ELECTRIC_INITIAL: 22,
  ELECTRIC_PRICE: 23,
  ELECTRIC_BILLING_DATE: 24,

  // Phí vệ sinh (Cleaning) - starts at column AI (index 25)
  CLEANING_HEADER: 25,
  CLEANING_USE: 26,
  CLEANING_QUANTITY: 27,
  CLEANING_PRICE: 28,
  CLEANING_BILLING_DATE: 29,

  // Phí Hư Hỏng (Damage) - starts at column AS (index 30)
  DAMAGE_HEADER: 30,
  DAMAGE_USE: 31,
  DAMAGE_QUANTITY: 32,
  DAMAGE_PRICE: 33,
  DAMAGE_BILLING_DATE: 34,
} as const;
