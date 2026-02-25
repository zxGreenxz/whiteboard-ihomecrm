/**
 * Vehicle Excel Import/Export Helpers
 * Uses XLSX (SheetJS) library for Excel file operations
 * Requirements: 10.1, 10.2, 10.3, 10.4, 10.5
 */

import * as XLSX from 'xlsx';
import type { VehicleWithRelations, VehicleImportRow } from '@/types/vehicle';

// =============================================
// Types
// =============================================

export interface VehicleImportResult {
  validRows: VehicleImportRow[];
  errors: { row: number; message: string }[];
}

// =============================================
// Column definitions
// =============================================

/** Export column headers (Vietnamese) */
const EXPORT_HEADERS = [
  'Mã PT',
  'Loại xe',
  'Tên dòng xe',
  'Biển số',
  'Màu xe',
  'Tên chủ xe',
  'Số vé xe',
  'Khách hàng',
  'Toà nhà',
  'Phòng',
] as const;

/** Import template column headers (required marked with *) */
const IMPORT_HEADERS = [
  'Loại xe (*) [Xe máy/Ô tô/Xe đạp/Xe đạp điện]',
  'Tên dòng xe (*)',
  'Biển số (*)',
  'Màu xe (*)',
  'Tên chủ xe (*)',
] as const;

/** Mapping from import header → VehicleImportRow field */
const IMPORT_HEADER_MAP: Record<string, keyof VehicleImportRow> = {
  'Loại xe (*) [Xe máy/Ô tô/Xe đạp/Xe đạp điện]': 'vehicle_type',
  'Tên dòng xe (*)': 'vehicle_name',
  'Biển số (*)': 'license_plate',
  'Màu xe (*)': 'color',
  'Tên chủ xe (*)': 'owner_name',
};

// =============================================
// Helpers
// =============================================

const VEHICLE_TYPE_LABEL: Record<string, string> = {
  MOTORBIKE: 'Xe máy',
  CAR: 'Ô tô',
  BICYCLE: 'Xe đạp',
  ELECTRIC_BIKE: 'Xe đạp điện',
  OTHER: 'Khác',
};

const VALID_IMPORT_VEHICLE_TYPES = ['Xe máy', 'Ô tô', 'Xe đạp', 'Xe đạp điện'];

function formatVehicleType(type: string): string {
  return VEHICLE_TYPE_LABEL[type] ?? type;
}

// =============================================
// Export
// =============================================

/**
 * Export vehicles to Excel file.
 * Requirement 10.1
 */
export function exportVehicles(vehicles: VehicleWithRelations[]): void {
  const rows = vehicles.map(v => ({
    'Mã PT': v.id.slice(0, 8).toUpperCase(),
    'Loại xe': formatVehicleType(v.vehicle_type),
    'Tên dòng xe': v.vehicle_name ?? '',
    'Biển số': v.license_plate ?? '',
    'Màu xe': v.color ?? '',
    'Tên chủ xe': v.owner_name ?? '',
    'Số vé xe': v.ticket_number ?? '',
    'Khách hàng': v.customer?.full_name ?? '',
    'Toà nhà': v.building?.name ?? '',
    'Phòng': v.room?.name ?? '',
  }));

  const worksheet = XLSX.utils.json_to_sheet(rows, {
    header: EXPORT_HEADERS as unknown as string[],
  });

  worksheet['!cols'] = [
    { wch: 12 }, // Mã PT
    { wch: 14 }, // Loại xe
    { wch: 20 }, // Tên dòng xe
    { wch: 16 }, // Biển số
    { wch: 12 }, // Màu xe
    { wch: 22 }, // Tên chủ xe
    { wch: 12 }, // Số vé xe
    { wch: 25 }, // Khách hàng
    { wch: 20 }, // Toà nhà
    { wch: 14 }, // Phòng
  ];

  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, worksheet, 'Phương tiện');

  XLSX.writeFile(workbook, 'danh-sach-phuong-tien.xlsx');
}

// =============================================
// Template download
// =============================================

/**
 * Download blank import template with required columns marked (*).
 * Requirement 10.2
 */
export function downloadVehicleImportTemplate(): void {
  const exampleRow: Record<string, string> = {
    'Loại xe (*) [Xe máy/Ô tô/Xe đạp/Xe đạp điện]': 'Xe máy',
    'Tên dòng xe (*)': 'Honda Wave',
    'Biển số (*)': '51A-12345',
    'Màu xe (*)': 'Đỏ',
    'Tên chủ xe (*)': 'Nguyễn Văn A',
  };

  const worksheet = XLSX.utils.json_to_sheet([exampleRow], {
    header: IMPORT_HEADERS as unknown as string[],
  });

  worksheet['!cols'] = [
    { wch: 38 }, // Loại xe (*)
    { wch: 20 }, // Tên dòng xe (*)
    { wch: 16 }, // Biển số (*)
    { wch: 14 }, // Màu xe (*)
    { wch: 22 }, // Tên chủ xe (*)
  ];

  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, worksheet, 'Mẫu nhập phương tiện');

  XLSX.writeFile(workbook, 'mau-nhap-phuong-tien.xlsx');
}

// =============================================
// Import / Parse
// =============================================

/**
 * Read and validate an Excel file for vehicle import.
 * Returns valid rows and per-row errors.
 * Requirements 10.3, 10.4, 10.5
 */
export async function parseVehicleExcel(file: File): Promise<VehicleImportResult> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();

    reader.onload = (e) => {
      try {
        const data = new Uint8Array(e.target?.result as ArrayBuffer);
        const workbook = XLSX.read(data, { type: 'array' });

        const sheetName = workbook.SheetNames[0];
        const worksheet = workbook.Sheets[sheetName];

        const rawRows = XLSX.utils.sheet_to_json<Record<string, unknown>>(worksheet, {
          defval: '',
        });

        const validRows: VehicleImportRow[] = [];
        const errors: { row: number; message: string }[] = [];

        rawRows.forEach((rawRow, index) => {
          const rowNumber = index + 2; // 1-indexed + header row

          // Map headers → fields
          const mapped: Partial<VehicleImportRow> = {};
          for (const [header, field] of Object.entries(IMPORT_HEADER_MAP)) {
            const value = rawRow[header];
            if (value !== undefined && value !== '') {
              (mapped as Record<string, unknown>)[field] = String(value).trim();
            }
          }

          const rowErrors: string[] = [];

          // Validate vehicle_type (required, must be one of the 4 valid types)
          if (!mapped.vehicle_type || mapped.vehicle_type.trim() === '') {
            rowErrors.push('Loại xe không được để trống');
          } else if (!VALID_IMPORT_VEHICLE_TYPES.includes(mapped.vehicle_type.trim())) {
            rowErrors.push(`Loại xe phải là một trong: ${VALID_IMPORT_VEHICLE_TYPES.join(', ')}`);
          }

          // Validate vehicle_name (required)
          if (!mapped.vehicle_name || mapped.vehicle_name.trim() === '') {
            rowErrors.push('Tên dòng xe không được để trống');
          }

          // Validate license_plate (required)
          if (!mapped.license_plate || mapped.license_plate.trim() === '') {
            rowErrors.push('Biển số không được để trống');
          }

          // Validate color (required)
          if (!mapped.color || mapped.color.trim() === '') {
            rowErrors.push('Màu xe không được để trống');
          }

          // Validate owner_name (required)
          if (!mapped.owner_name || mapped.owner_name.trim() === '') {
            rowErrors.push('Tên chủ xe không được để trống');
          }

          if (rowErrors.length > 0) {
            errors.push({ row: rowNumber, message: rowErrors.join('; ') });
          } else {
            validRows.push({
              vehicle_type: mapped.vehicle_type!.trim(),
              vehicle_name: mapped.vehicle_name!.trim(),
              license_plate: mapped.license_plate!.trim(),
              color: mapped.color!.trim(),
              owner_name: mapped.owner_name!.trim(),
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
