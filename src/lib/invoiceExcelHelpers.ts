/**
 * Invoice Excel Import/Export Helpers
 * Handles generating invoice templates and parsing uploaded Excel files
 */

import * as XLSX from 'xlsx';

// =============================================
// Types
// =============================================

export interface ParsedInvoiceRow {
  room_name: string;
  bed_name?: string;
  services: Record<string, number>; // service_name → amount
}

export interface ValidationResult {
  valid: ParsedInvoiceRow[];
  errors: Array<{ row: number; message: string }>;
}

/** Minimal building info needed for template generation */
export interface TemplateBuildingInfo {
  id: string;
  name: string;
}

/** Minimal room info with active services for template generation */
export interface TemplateRoomInfo {
  id: string;
  name: string;
  bed_names?: string[];
  /** Service IDs currently in use by this room's active contract */
  active_service_ids?: string[];
}

/** Minimal service info for template columns */
export interface TemplateServiceInfo {
  id: string;
  name: string;
}

// =============================================
// Constants
// =============================================

const ROOM_HEADER = 'Phòng (*)';
const BED_HEADER = 'Giường';

/** Style object for yellow-highlighted cells (active services) */
const YELLOW_FILL = {
  fill: { fgColor: { rgb: 'FFFF00' } },
};

const NA_VALUE = 'N/A';

// =============================================
// Generate Invoice Template
// =============================================

/**
 * Generate an Excel template file for invoice import.
 *
 * - Columns: Phòng (*), Giường, then one column per service
 * - Pre-fills room names in the Phòng column
 * - Yellow cells for services currently in use, white N/A for unused services
 *
 * Requirements: 2.1, 2.2, 2.3
 */
export function generateInvoiceTemplate(
  building: TemplateBuildingInfo,
  rooms: TemplateRoomInfo[],
  services: TemplateServiceInfo[]
): Blob {
  // Build headers
  const headers = [ROOM_HEADER, BED_HEADER, ...services.map((s) => s.name)];

  // Build rows - one row per room (or per bed if room has beds)
  const rows: Record<string, any>[] = [];
  const cellStyles: Array<{ row: number; col: number; style: typeof YELLOW_FILL }> = [];

  let rowIndex = 0; // 0-based data row index (header is row 0 in sheet, data starts at row 1)

  for (const room of rooms) {
    const hasBeds = room.bed_names && room.bed_names.length > 0;
    const activeServiceIds = new Set(room.active_service_ids || []);

    if (hasBeds) {
      for (const bedName of room.bed_names!) {
        const row: Record<string, any> = {
          [ROOM_HEADER]: room.name,
          [BED_HEADER]: bedName,
        };

        services.forEach((service, serviceIdx) => {
          const isActive = activeServiceIds.has(service.id);
          if (isActive) {
            row[service.name] = '';
            // Mark yellow (data row rowIndex → sheet row rowIndex + 1, col offset by 2 for Phòng + Giường)
            cellStyles.push({
              row: rowIndex + 1, // +1 for header row
              col: serviceIdx + 2, // +2 for Phòng and Giường columns
              style: YELLOW_FILL,
            });
          } else {
            row[service.name] = NA_VALUE;
          }
        });

        rows.push(row);
        rowIndex++;
      }
    } else {
      const row: Record<string, any> = {
        [ROOM_HEADER]: room.name,
        [BED_HEADER]: '',
      };

      services.forEach((service, serviceIdx) => {
        const isActive = activeServiceIds.has(service.id);
        if (isActive) {
          row[service.name] = '';
          cellStyles.push({
            row: rowIndex + 1,
            col: serviceIdx + 2,
            style: YELLOW_FILL,
          });
        } else {
          row[service.name] = NA_VALUE;
        }
      });

      rows.push(row);
      rowIndex++;
    }
  }

  // Create worksheet from data
  const worksheet = XLSX.utils.json_to_sheet(rows, { header: headers });

  // Set column widths
  const colWidths = [
    { wch: 15 }, // Phòng
    { wch: 12 }, // Giường
    ...services.map((s) => ({ wch: Math.max(s.name.length + 2, 15) })),
  ];
  worksheet['!cols'] = colWidths;

  // Apply yellow cell styles
  for (const { row, col, style } of cellStyles) {
    const cellRef = XLSX.utils.encode_cell({ r: row, c: col });
    if (!worksheet[cellRef]) {
      worksheet[cellRef] = { v: '', t: 's' };
    }
    worksheet[cellRef].s = style;
  }

  // Create workbook
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, worksheet, 'Hoá đơn');

  // Write to buffer and return as Blob
  const wbout = XLSX.write(workbook, { bookType: 'xlsx', type: 'array' });
  return new Blob([wbout], {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  });
}

// =============================================
// Parse Invoice Excel
// =============================================

/**
 * Core parsing logic: converts raw Excel data (ArrayBuffer) into ParsedInvoiceRow[].
 * Extracted for testability (no browser APIs needed).
 */
export function parseInvoiceBuffer(data: ArrayBuffer): ParsedInvoiceRow[] {
  const workbook = XLSX.read(new Uint8Array(data), { type: 'array' });

  const sheetName = workbook.SheetNames[0];
  if (!sheetName) {
    throw new Error('File Excel không có sheet nào.');
  }

  const worksheet = workbook.Sheets[sheetName];
  const jsonData = XLSX.utils.sheet_to_json<Record<string, any>>(worksheet);

  return jsonData.map((row) => {
    // Extract room name - try with and without (*)
    const roomName = String(row[ROOM_HEADER] ?? row['Phòng'] ?? '').trim();

    const bedName =
      row[BED_HEADER] != null ? String(row[BED_HEADER]).trim() : undefined;

    // All other columns are service amounts
    const services: Record<string, number> = {};
    for (const [header, value] of Object.entries(row)) {
      if (header === ROOM_HEADER || header === 'Phòng' || header === BED_HEADER) {
        continue;
      }

      // Skip N/A values - these are services not in use
      const strValue = String(value).trim();
      if (strValue === NA_VALUE || strValue === '') {
        continue;
      }

      const numValue = Number(strValue);
      if (!isNaN(numValue)) {
        services[header] = numValue;
      } else {
        // Store as NaN so validation can catch it
        services[header] = NaN;
      }
    }

    return {
      room_name: roomName,
      bed_name: bedName || undefined,
      services,
    };
  });
}

/**
 * Parse an uploaded Excel file into structured rows.
 *
 * - Maps Vietnamese headers to field names
 * - Each row: room_name, bed_name?, service amounts (keyed by service name)
 *
 * Requirements: 2.4
 */
export async function parseInvoiceExcel(
  file: File,
  _buildingId: string,
  _billingMonth: string
): Promise<ParsedInvoiceRow[]> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();

    reader.onload = (e) => {
      try {
        const data = e.target?.result as ArrayBuffer;
        resolve(parseInvoiceBuffer(data));
      } catch (error) {
        reject(
          new Error('Không thể đọc file Excel. Vui lòng kiểm tra định dạng file.')
        );
      }
    };

    reader.onerror = () => {
      reject(new Error('Lỗi khi đọc file.'));
    };

    reader.readAsArrayBuffer(file);
  });
}

// =============================================
// Validate Parsed Rows
// =============================================

/**
 * Validate each parsed row:
 * - room_name is required
 * - service amounts must be valid numbers
 *
 * Returns valid rows and detailed errors for invalid rows.
 *
 * Requirements: 2.4, 2.6
 */
export function validateParsedRows(rows: ParsedInvoiceRow[]): ValidationResult {
  const valid: ParsedInvoiceRow[] = [];
  const errors: Array<{ row: number; message: string }> = [];

  rows.forEach((row, index) => {
    const rowNumber = index + 2; // +2 because row 1 is header, data starts at row 2
    const rowErrors: string[] = [];

    // room_name is required
    if (!row.room_name) {
      rowErrors.push('Thiếu tên phòng (Phòng)');
    }

    // Validate service amounts are valid numbers
    for (const [serviceName, amount] of Object.entries(row.services)) {
      if (isNaN(amount)) {
        rowErrors.push(`Giá trị '${serviceName}' không phải số hợp lệ`);
      } else if (amount < 0) {
        rowErrors.push(`Giá trị '${serviceName}' không được âm`);
      }
    }

    if (rowErrors.length > 0) {
      errors.push({
        row: rowNumber,
        message: rowErrors.join('; '),
      });
    } else {
      valid.push(row);
    }
  });

  return { valid, errors };
}
