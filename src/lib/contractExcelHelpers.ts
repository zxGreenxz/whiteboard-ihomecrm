/**
 * Contract Excel Import/Export Helpers
 * Uses XLSX (SheetJS) library for Excel file operations
 * Requirements: 11.2, 11.3, 11.4, 11.5, 12.1, 12.2
 */

import * as XLSX from 'xlsx';
import type { ContractWithRelations, ContractFilters } from '@/types/contract';
import { getContractDisplayStatus, CONTRACT_STATUS_CONFIG, PAYMENT_CYCLE_LABELS } from '@/types/contract';
import type { PaymentCycle } from '@/types/contract';
import type { ImportResult } from '@/lib/excelHelpers';
import { parseDateToISO } from '@/lib/customerExcelHelpers';

// =============================================
// Types
// =============================================

export interface ContractImportRow {
  room_name: string;
  customer_name: string;
  customer_phone: string;
  customer_id_number?: string;
  signed_date: string;
  start_date: string;
  end_date: string;
  rent_price: number;
  payment_cycle: string;
  deposit: number;
  notes?: string;
}

// =============================================
// Column definitions
// =============================================

const EXPORT_COLS = [
  { header: 'STT',              key: 'stt',            wch: 6  },
  { header: 'Mã HĐ',           key: 'ma_hd',          wch: 14 },
  { header: 'Trạng thái',       key: 'trang_thai',     wch: 16 },
  { header: 'Vị trí',           key: 'vi_tri',         wch: 30 },
  { header: 'Khách hàng',       key: 'khach_hang',     wch: 25 },
  { header: 'SĐT',              key: 'sdt',            wch: 14 },
  { header: 'Giá thuê',         key: 'gia_thue',       wch: 16 },
  { header: 'Tiền cọc',         key: 'tien_coc',       wch: 16 },
  { header: 'Ngày BĐ',          key: 'ngay_bd',        wch: 14 },
  { header: 'Ngày KT',          key: 'ngay_kt',        wch: 14 },
  { header: 'Chu kỳ TT',        key: 'chu_ky_tt',      wch: 14 },
  { header: 'Ghi chú',          key: 'ghi_chu',        wch: 30 },
] as const;

const IMPORT_HEADERS = [
  'Phòng (*)',
  'Tên KH (*)',
  'SĐT (*)',
  'CCCD',
  'Ngày ký (*)',
  'Ngày BĐ (*)',
  'Ngày KT (*)',
  'Tiền thuê (*)',
  'Chu kỳ TT (*) [1 tháng/3 tháng/6 tháng/12 tháng]',
  'Tiền cọc (*)',
  'Ghi chú',
] as const;

const IMPORT_HEADER_MAP: Record<string, keyof ContractImportRow> = {
  'Phòng (*)':                                           'room_name',
  'Tên KH (*)':                                          'customer_name',
  'SĐT (*)':                                             'customer_phone',
  'CCCD':                                                'customer_id_number',
  'Ngày ký (*)':                                         'signed_date',
  'Ngày BĐ (*)':                                         'start_date',
  'Ngày KT (*)':                                         'end_date',
  'Tiền thuê (*)':                                       'rent_price',
  'Chu kỳ TT (*) [1 tháng/3 tháng/6 tháng/12 tháng]':  'payment_cycle',
  'Tiền cọc (*)':                                        'deposit',
  'Ghi chú':                                             'notes',
};

// =============================================
// Helpers
// =============================================

function getRepresentativeCustomer(contract: ContractWithRelations) {
  const rep = contract.contract_customers?.find(cc => cc.is_representative);
  return rep?.customer ?? contract.contract_customers?.[0]?.customer ?? null;
}

function formatLocation(contract: ContractWithRelations): string {
  const parts: string[] = [];
  if (contract.room?.building?.name) parts.push(contract.room.building.name);
  if (contract.room?.name) parts.push(contract.room.name);
  return parts.join(' - ');
}

function formatVND(amount: number | null | undefined): string {
  if (amount === null || amount === undefined) return '';
  return amount.toLocaleString('vi-VN');
}

function formatDate(dateStr: string | null | undefined): string {
  if (!dateStr) return '';
  try {
    const d = new Date(dateStr);
    const day = String(d.getDate()).padStart(2, '0');
    const month = String(d.getMonth() + 1).padStart(2, '0');
    const year = d.getFullYear();
    return `${day}/${month}/${year}`;
  } catch {
    return dateStr;
  }
}

function formatPaymentCycle(cycle: PaymentCycle | string | null | undefined): string {
  if (!cycle) return '';
  return PAYMENT_CYCLE_LABELS[cycle as PaymentCycle] ?? cycle;
}

const VALID_PAYMENT_CYCLES = ['1 tháng', '3 tháng', '6 tháng', '12 tháng'];

function parsePaymentCycle(raw: string): string | undefined {
  if (!raw) return undefined;
  const v = raw.trim().toLowerCase();
  if (v === '1 tháng' || v === '1 thang' || v === 'monthly')      return 'MONTHLY';
  if (v === '3 tháng' || v === '3 thang' || v === 'quarterly')    return 'QUARTERLY';
  if (v === '6 tháng' || v === '6 thang' || v === 'semi_annual')  return 'SEMI_ANNUAL';
  if (v === '12 tháng' || v === '12 thang' || v === 'annual')     return 'ANNUAL';
  return undefined;
}

function parseNumber(raw: unknown): number | undefined {
  if (raw === undefined || raw === null || raw === '') return undefined;
  const num = Number(raw);
  return isNaN(num) ? undefined : num;
}

/**
 * Validate a single raw import row and return either a valid ContractImportRow or error messages.
 * This is a pure function extracted from parseContractExcel for testability.
 * Requirements: 11.4, 11.5
 */
export function validateContractImportRow(
  row: Record<string, unknown>
): { valid: true; data: ContractImportRow } | { valid: false; errors: string[] } {
  const rowErrors: string[] = [];

  // Validate room_name (required)
  const roomName = row.room_name ? String(row.room_name).trim() : '';
  if (!roomName) {
    rowErrors.push('Phòng không được để trống');
  }

  // Validate customer_name (required)
  const customerName = row.customer_name ? String(row.customer_name).trim() : '';
  if (!customerName) {
    rowErrors.push('Tên KH không được để trống');
  }

  // Validate customer_phone (required)
  const customerPhone = row.customer_phone ? String(row.customer_phone).replace(/\s/g, '') : '';
  if (!customerPhone) {
    rowErrors.push('SĐT không được để trống');
  }

  // Validate signed_date (required)
  const signedDate = parseDateToISO(row.signed_date as string | number | undefined);
  if (!signedDate) {
    rowErrors.push('Ngày ký không hợp lệ hoặc để trống');
  }

  // Validate start_date (required)
  const startDate = parseDateToISO(row.start_date as string | number | undefined);
  if (!startDate) {
    rowErrors.push('Ngày BĐ không hợp lệ hoặc để trống');
  }

  // Validate end_date (required)
  const endDate = parseDateToISO(row.end_date as string | number | undefined);
  if (!endDate) {
    rowErrors.push('Ngày KT không hợp lệ hoặc để trống');
  }

  // Validate end_date > start_date
  if (startDate && endDate && new Date(endDate) <= new Date(startDate)) {
    rowErrors.push('Ngày KT phải sau Ngày BĐ');
  }

  // Validate rent_price (required, >= 0)
  const rentPrice = parseNumber(row.rent_price);
  if (rentPrice === undefined || rentPrice < 0) {
    rowErrors.push('Tiền thuê không hợp lệ');
  }

  // Validate payment_cycle (required)
  const paymentCycleRaw = row.payment_cycle ? String(row.payment_cycle).trim() : '';
  const paymentCycle = parsePaymentCycle(paymentCycleRaw);
  if (!paymentCycle) {
    rowErrors.push(`Chu kỳ TT không hợp lệ (chấp nhận: ${VALID_PAYMENT_CYCLES.join(', ')})`);
  }

  // Validate deposit (required, >= 0)
  const deposit = parseNumber(row.deposit);
  if (deposit === undefined || deposit < 0) {
    rowErrors.push('Tiền cọc không hợp lệ');
  }

  if (rowErrors.length > 0) {
    return { valid: false, errors: rowErrors };
  }

  const idNumber = row.customer_id_number ? String(row.customer_id_number).trim() : undefined;
  const notes = row.notes ? String(row.notes).trim() : undefined;

  return {
    valid: true,
    data: {
      room_name: roomName,
      customer_name: customerName,
      customer_phone: customerPhone,
      customer_id_number: idNumber || undefined,
      signed_date: signedDate!,
      start_date: startDate!,
      end_date: endDate!,
      rent_price: rentPrice!,
      payment_cycle: paymentCycle!,
      deposit: deposit!,
      notes: notes || undefined,
    },
  };
}

// =============================================
// Export
// =============================================

/**
 * Export contracts to Excel file.
 * Requirement 12.1, 12.2
 */
export function exportContracts(
  contracts: ContractWithRelations[],
  _filters?: ContractFilters
): void {
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet([]);

  // Row 1: Title
  XLSX.utils.sheet_add_aoa(ws, [['DANH SÁCH HỢP ĐỒNG THUÊ']], { origin: 'A1' });
  // Row 2: Subtitle
  XLSX.utils.sheet_add_aoa(ws, [['Resident - Phần mềm quản lý Căn hộ & Cư dân | Website: https://resident.vn | Hotline & Zalo: 0869.987.255']], { origin: 'A2' });
  // Row 3: blank
  XLSX.utils.sheet_add_aoa(ws, [['']], { origin: 'A3' });

  // Row 4: column headers
  const headers = EXPORT_COLS.map(c => c.header);
  XLSX.utils.sheet_add_aoa(ws, [headers], { origin: 'A4' });

  // Rows 5+: data
  contracts.forEach((c, i) => {
    const displayStatus = getContractDisplayStatus(c);
    const statusLabel = CONTRACT_STATUS_CONFIG[displayStatus]?.label ?? c.status;
    const customer = getRepresentativeCustomer(c);

    const row = [
      i + 1,
      c.contract_number ?? '',
      statusLabel,
      formatLocation(c),
      customer?.full_name ?? '',
      customer?.phone ?? '',
      formatVND(c.rent_price),
      formatVND(c.total_deposit),
      formatDate(c.start_date),
      formatDate(c.end_date),
      formatPaymentCycle(c.payment_cycle),
      c.notes ?? '',
    ];
    XLSX.utils.sheet_add_aoa(ws, [row], { origin: `A${i + 5}` });
  });

  // Merge title across all columns
  const totalCols = EXPORT_COLS.length;
  ws['!merges'] = [
    { s: { r: 0, c: 0 }, e: { r: 0, c: totalCols - 1 } },
    { s: { r: 1, c: 0 }, e: { r: 1, c: totalCols - 1 } },
  ];

  // Column widths
  ws['!cols'] = EXPORT_COLS.map(c => ({ wch: c.wch }));

  XLSX.utils.book_append_sheet(wb, ws, 'Danh sách hợp đồng');
  XLSX.writeFile(wb, 'danh-sach-hop-dong.xlsx');
}

// =============================================
// Template download
// =============================================

/**
 * Download blank import template with required columns marked (*).
 * Requirement 11.2
 */
export function downloadContractImportTemplate(): void {
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet([]);

  // Row 1: Title
  XLSX.utils.sheet_add_aoa(ws, [['MẪU NHẬP HỢP ĐỒNG THUÊ']], { origin: 'A1' });
  // Row 2: Subtitle
  XLSX.utils.sheet_add_aoa(ws, [['Resident - Phần mềm quản lý Căn hộ & Cư dân | Website: https://resident.vn | Hotline & Zalo: 0869.987.255']], { origin: 'A2' });
  // Row 3: blank
  XLSX.utils.sheet_add_aoa(ws, [['']], { origin: 'A3' });

  // Row 4: headers
  XLSX.utils.sheet_add_aoa(ws, [IMPORT_HEADERS as unknown as string[]], { origin: 'A4' });

  // Row 5: example
  const example = [
    '101',             // Phòng
    'Nguyễn Văn A',   // Tên KH
    '0901234567',      // SĐT
    '012345678901',    // CCCD
    '01/07/2025',      // Ngày ký
    '01/07/2025',      // Ngày BĐ
    '01/07/2026',      // Ngày KT
    3000000,           // Tiền thuê
    '1 tháng',         // Chu kỳ TT
    3000000,           // Tiền cọc
    '',                // Ghi chú
  ];
  XLSX.utils.sheet_add_aoa(ws, [example], { origin: 'A5' });

  const totalCols = IMPORT_HEADERS.length;
  ws['!merges'] = [
    { s: { r: 0, c: 0 }, e: { r: 0, c: totalCols - 1 } },
    { s: { r: 1, c: 0 }, e: { r: 1, c: totalCols - 1 } },
  ];

  ws['!cols'] = [
    { wch: 12 }, // Phòng
    { wch: 25 }, // Tên KH
    { wch: 14 }, // SĐT
    { wch: 16 }, // CCCD
    { wch: 14 }, // Ngày ký
    { wch: 14 }, // Ngày BĐ
    { wch: 14 }, // Ngày KT
    { wch: 16 }, // Tiền thuê
    { wch: 38 }, // Chu kỳ TT
    { wch: 16 }, // Tiền cọc
    { wch: 30 }, // Ghi chú
  ];

  XLSX.utils.book_append_sheet(wb, ws, 'Mẫu nhập hợp đồng');
  XLSX.writeFile(wb, 'mau-nhap-hop-dong.xlsx');
}

// =============================================
// Import / Parse
// =============================================

/**
 * Parse Excel file for contract import.
 * Supports both template format (header at row 4) and simple format (header at row 1).
 * Requirements: 11.3, 11.4, 11.5
 */
export async function parseContractExcel(
  file: File,
  _buildingId: string
): Promise<ImportResult<ContractImportRow>> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();

    reader.onload = (e) => {
      try {
        const data = new Uint8Array(e.target?.result as ArrayBuffer);
        const workbook = XLSX.read(data, { type: 'array' });

        const sheetName = workbook.SheetNames[0];
        const ws = workbook.Sheets[sheetName];

        // Detect header row: check if A1 contains title text
        const a1 = ws['A1']?.v?.toString() ?? '';
        const headerRowIndex = a1.toUpperCase().includes('MẪU') || a1.toUpperCase().includes('DANH SÁCH') || a1.toUpperCase().includes('HỢP ĐỒNG') ? 3 : 0;

        // Read all rows as array of arrays
        const aoa: unknown[][] = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' }) as unknown[][];

        if (aoa.length <= headerRowIndex) {
          return resolve({ success: [], errors: [] });
        }

        // Extract header row
        const headerRow = (aoa[headerRowIndex] as string[]).map(h => String(h ?? '').trim());

        // Data rows start after header
        const dataRows = aoa.slice(headerRowIndex + 1);

        const success: ContractImportRow[] = [];
        const errors: { row: number; message: string }[] = [];

        dataRows.forEach((rawRow, index) => {
          const excelRowNum = headerRowIndex + index + 2; // 1-indexed for user display

          // Skip completely empty rows
          const rowArr = rawRow as unknown[];
          if (rowArr.every(cell => cell === '' || cell === null || cell === undefined)) return;

          // Map header → value
          const mapped: Record<string, unknown> = {};
          headerRow.forEach((h, colIdx) => {
            const val = rowArr[colIdx];
            if (val !== undefined && val !== null && val !== '') {
              mapped[h] = val;
            }
          });

          // Build row from header mapping
          const row: Record<string, unknown> = {};
          for (const [header, field] of Object.entries(IMPORT_HEADER_MAP)) {
            if (mapped[header] !== undefined) {
              row[field] = mapped[header];
            }
          }

          const rowErrors: string[] = [];

          // Validate room_name (required)
          const roomName = row.room_name ? String(row.room_name).trim() : '';
          if (!roomName) {
            rowErrors.push('Phòng không được để trống');
          }

          // Validate customer_name (required)
          const customerName = row.customer_name ? String(row.customer_name).trim() : '';
          if (!customerName) {
            rowErrors.push('Tên KH không được để trống');
          }

          // Validate customer_phone (required)
          const customerPhone = row.customer_phone ? String(row.customer_phone).replace(/\s/g, '') : '';
          if (!customerPhone) {
            rowErrors.push('SĐT không được để trống');
          }

          // Validate signed_date (required)
          const signedDate = parseDateToISO(row.signed_date as string | number | undefined);
          if (!signedDate) {
            rowErrors.push('Ngày ký không hợp lệ hoặc để trống');
          }

          // Validate start_date (required)
          const startDate = parseDateToISO(row.start_date as string | number | undefined);
          if (!startDate) {
            rowErrors.push('Ngày BĐ không hợp lệ hoặc để trống');
          }

          // Validate end_date (required)
          const endDate = parseDateToISO(row.end_date as string | number | undefined);
          if (!endDate) {
            rowErrors.push('Ngày KT không hợp lệ hoặc để trống');
          }

          // Validate end_date > start_date
          if (startDate && endDate && new Date(endDate) <= new Date(startDate)) {
            rowErrors.push('Ngày KT phải sau Ngày BĐ');
          }

          // Validate rent_price (required, >= 0)
          const rentPrice = parseNumber(row.rent_price);
          if (rentPrice === undefined || rentPrice < 0) {
            rowErrors.push('Tiền thuê không hợp lệ');
          }

          // Validate payment_cycle (required)
          const paymentCycleRaw = row.payment_cycle ? String(row.payment_cycle).trim() : '';
          const paymentCycle = parsePaymentCycle(paymentCycleRaw);
          if (!paymentCycle) {
            rowErrors.push(`Chu kỳ TT không hợp lệ (chấp nhận: ${VALID_PAYMENT_CYCLES.join(', ')})`);
          }

          // Validate deposit (required, >= 0)
          const deposit = parseNumber(row.deposit);
          if (deposit === undefined || deposit < 0) {
            rowErrors.push('Tiền cọc không hợp lệ');
          }

          if (rowErrors.length > 0) {
            errors.push({ row: excelRowNum, message: rowErrors.join('; ') });
          } else {
            const idNumber = row.customer_id_number ? String(row.customer_id_number).trim() : undefined;
            const notes = row.notes ? String(row.notes).trim() : undefined;

            success.push({
              room_name: roomName,
              customer_name: customerName,
              customer_phone: customerPhone,
              customer_id_number: idNumber || undefined,
              signed_date: signedDate!,
              start_date: startDate!,
              end_date: endDate!,
              rent_price: rentPrice!,
              payment_cycle: paymentCycle!,
              deposit: deposit!,
              notes: notes || undefined,
            });
          }
        });

        resolve({ success, errors });
      } catch {
        reject(new Error('Không thể đọc file Excel. Vui lòng kiểm tra định dạng file.'));
      }
    };

    reader.onerror = () => reject(new Error('Lỗi khi đọc file'));
    reader.readAsArrayBuffer(file);
  });
}
