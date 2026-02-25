/**
 * Customer Excel Import/Export Helpers
 * Uses XLSX (SheetJS) library for Excel file operations
 * Requirements: 7.1, 7.2, 7.3, 7.4, 7.5, 7.6
 */

import * as XLSX from 'xlsx';
import type { Customer, CustomerFilters } from '@/types/customer';

// =============================================
// Types
// =============================================

export interface CustomerImportRow {
  full_name: string;
  customer_type: string;
  phone: string;
  email?: string;
  id_number?: string;
  date_of_birth?: string;
  gender?: string;
  permanent_address?: string;
}

export interface CustomerImportResult {
  validRows: CustomerImportRow[];
  errors: { row: number; message: string }[];
}

// =============================================
// Column definitions
// =============================================

/** Export column headers (Vietnamese) */
const EXPORT_HEADERS = [
  'Mã KH',
  'Họ tên',
  'Loại KH',
  'SĐT',
  'Email',
  'CMND/CCCD',
  'Ngày sinh',
  'Giới tính',
  'Địa chỉ',
  'Trạng thái',
] as const;

/** Import template column headers (required marked with *) */
const IMPORT_HEADERS = [
  'Họ tên (*)',
  'Loại KH (*) [Cá nhân/Tổ chức]',
  'SĐT (*)',
  'Email',
  'CMND/CCCD',
  'Ngày sinh (YYYY-MM-DD)',
  'Giới tính [Nam/Nữ/Khác]',
  'Địa chỉ thường trú',
] as const;

/** Mapping from import header → CustomerImportRow field */
const IMPORT_HEADER_MAP: Record<string, keyof CustomerImportRow> = {
  'Họ tên (*)': 'full_name',
  'Loại KH (*) [Cá nhân/Tổ chức]': 'customer_type',
  'SĐT (*)': 'phone',
  'Email': 'email',
  'CMND/CCCD': 'id_number',
  'Ngày sinh (YYYY-MM-DD)': 'date_of_birth',
  'Giới tính [Nam/Nữ/Khác]': 'gender',
  'Địa chỉ thường trú': 'permanent_address',
};

// =============================================
// Helpers
// =============================================

function formatCustomerType(type: string): string {
  return type === 'INDIVIDUAL' ? 'Cá nhân' : type === 'ORGANIZATION' ? 'Tổ chức' : type;
}

function formatStatus(status: string): string {
  switch (status) {
    case 'RENTING': return 'Đang thuê';
    case 'MOVED_OUT': return 'Đã chuyển đi';
    case 'WALK_IN': return 'Khách vãng lai';
    default: return status;
  }
}

function formatGender(gender: string | null): string {
  if (!gender) return '';
  switch (gender) {
    case 'MALE': return 'Nam';
    case 'FEMALE': return 'Nữ';
    case 'OTHER': return 'Khác';
    default: return gender;
  }
}

// =============================================
// Export
// =============================================

/**
 * Export customers to Excel file based on current filters.
 * Requirement 7.1
 */
export function exportCustomers(customers: Customer[], filters?: CustomerFilters): void {
  const rows = customers.map(c => ({
    'Mã KH': c.id.slice(0, 8).toUpperCase(),
    'Họ tên': c.full_name,
    'Loại KH': formatCustomerType(c.customer_type),
    'SĐT': c.phone,
    'Email': c.email ?? '',
    'CMND/CCCD': c.id_number ?? '',
    'Ngày sinh': c.date_of_birth ?? '',
    'Giới tính': formatGender(c.gender),
    'Địa chỉ': c.permanent_address ?? c.detailed_address ?? '',
    'Trạng thái': formatStatus(c.status_v2),
  }));

  const worksheet = XLSX.utils.json_to_sheet(rows, { header: EXPORT_HEADERS as unknown as string[] });

  // Set column widths
  worksheet['!cols'] = [
    { wch: 12 }, // Mã KH
    { wch: 25 }, // Họ tên
    { wch: 12 }, // Loại KH
    { wch: 14 }, // SĐT
    { wch: 25 }, // Email
    { wch: 16 }, // CMND/CCCD
    { wch: 14 }, // Ngày sinh
    { wch: 10 }, // Giới tính
    { wch: 35 }, // Địa chỉ
    { wch: 14 }, // Trạng thái
  ];

  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, worksheet, 'Khách hàng');

  // Build filename with filter context
  const statusLabel = filters?.status ? `-${formatStatus(filters.status).replace(/\s/g, '_')}` : '';
  XLSX.writeFile(workbook, `danh-sach-khach-hang${statusLabel}.xlsx`);
}

// =============================================
// Template download
// =============================================

/**
 * Download blank import template with required columns marked (*).
 * Requirement 7.3
 */
export function downloadCustomerImportTemplate(): void {
  // Header row
  const headerRow: Record<string, string> = {};
  IMPORT_HEADERS.forEach(h => { headerRow[h] = ''; });

  // Example row to guide users
  const exampleRow: Record<string, string> = {
    'Họ tên (*)': 'Nguyễn Văn A',
    'Loại KH (*) [Cá nhân/Tổ chức]': 'Cá nhân',
    'SĐT (*)': '0901234567',
    'Email': 'example@email.com',
    'CMND/CCCD': '012345678901',
    'Ngày sinh (YYYY-MM-DD)': '1990-01-15',
    'Giới tính [Nam/Nữ/Khác]': 'Nam',
    'Địa chỉ thường trú': '123 Đường ABC, Quận 1, TP.HCM',
  };

  const worksheet = XLSX.utils.json_to_sheet([exampleRow], {
    header: IMPORT_HEADERS as unknown as string[],
  });

  // Set column widths
  worksheet['!cols'] = [
    { wch: 20 }, // Họ tên (*)
    { wch: 28 }, // Loại KH (*)
    { wch: 14 }, // SĐT (*)
    { wch: 25 }, // Email
    { wch: 16 }, // CMND/CCCD
    { wch: 22 }, // Ngày sinh
    { wch: 22 }, // Giới tính
    { wch: 35 }, // Địa chỉ thường trú
  ];

  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, worksheet, 'Mẫu nhập khách hàng');

  XLSX.writeFile(workbook, 'mau-nhap-khach-hang.xlsx');
}

// =============================================
// Import / Parse
// =============================================

const PHONE_REGEX = /^[0-9]{10,11}$/;
const VALID_CUSTOMER_TYPES = ['Cá nhân', 'Tổ chức'];

/**
 * Read and validate an Excel file for customer import.
 * Returns valid rows and per-row errors.
 * Requirements 7.4, 7.6
 */
export async function parseCustomerExcel(file: File): Promise<CustomerImportResult> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();

    reader.onload = (e) => {
      try {
        const data = new Uint8Array(e.target?.result as ArrayBuffer);
        const workbook = XLSX.read(data, { type: 'array' });

        const sheetName = workbook.SheetNames[0];
        const worksheet = workbook.Sheets[sheetName];

        // Parse rows as raw objects (header row = keys)
        const rawRows = XLSX.utils.sheet_to_json<Record<string, unknown>>(worksheet, {
          defval: '',
        });

        const validRows: CustomerImportRow[] = [];
        const errors: { row: number; message: string }[] = [];

        rawRows.forEach((rawRow, index) => {
          // Excel row number (1-indexed, +1 for header row)
          const rowNumber = index + 2;

          // Map headers → fields
          const mapped: Partial<CustomerImportRow> = {};
          for (const [header, field] of Object.entries(IMPORT_HEADER_MAP)) {
            const value = rawRow[header];
            if (value !== undefined && value !== '') {
              (mapped as Record<string, unknown>)[field] = String(value).trim();
            }
          }

          // Collect per-row validation errors
          const rowErrors: string[] = [];

          // Validate full_name (required)
          if (!mapped.full_name || mapped.full_name.trim() === '') {
            rowErrors.push('Họ tên không được để trống');
          }

          // Validate phone (required, 10-11 digits)
          if (!mapped.phone || mapped.phone.trim() === '') {
            rowErrors.push('Số điện thoại không được để trống');
          } else if (!PHONE_REGEX.test(mapped.phone.trim())) {
            rowErrors.push('Số điện thoại phải có 10-11 chữ số');
          }

          // Validate customer_type (required, must be 'Cá nhân' or 'Tổ chức')
          if (!mapped.customer_type || mapped.customer_type.trim() === '') {
            rowErrors.push('Loại KH không được để trống');
          } else if (!VALID_CUSTOMER_TYPES.includes(mapped.customer_type.trim())) {
            rowErrors.push(`Loại KH phải là "Cá nhân" hoặc "Tổ chức"`);
          }

          if (rowErrors.length > 0) {
            errors.push({
              row: rowNumber,
              message: rowErrors.join('; '),
            });
          } else {
            validRows.push({
              full_name: mapped.full_name!.trim(),
              customer_type: mapped.customer_type!.trim(),
              phone: mapped.phone!.trim(),
              email: mapped.email?.trim() || undefined,
              id_number: mapped.id_number?.trim() || undefined,
              date_of_birth: mapped.date_of_birth?.trim() || undefined,
              gender: mapped.gender?.trim() || undefined,
              permanent_address: mapped.permanent_address?.trim() || undefined,
            });
          }
        });

        resolve({ validRows, errors });
      } catch {
        reject(new Error('Không thể đọc file Excel. Vui lòng kiểm tra định dạng file.'));
      }
    };

    reader.onerror = () => {
      reject(new Error('Lỗi khi đọc file'));
    };

    reader.readAsArrayBuffer(file);
  });
}
