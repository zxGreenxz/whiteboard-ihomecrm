/**
 * Customer Excel Import/Export Helpers
 * Matches exact column structure from the "DANH SÁCH CƯ DÂN" template
 * Uses XLSX (SheetJS) for Excel operations
 */

import * as XLSX from 'xlsx';
import { supabase } from '@/integrations/supabase/client';
import type { Customer, CustomerFilters } from '@/types/customer';

// =============================================
// Types
// =============================================

export interface CustomerImportRow {
  full_name: string;
  phone: string;
  email?: string;
  date_of_birth?: string;
  gender?: string;
  id_number?: string;
  id_issue_date?: string;
  id_issue_place?: string;
  permanent_address?: string;
  nationality?: string;
  passport_number?: string;
  occupation?: string;
  contact_person?: string;
  contact_person_phone?: string;
  // Raw image URLs from column L (newline-separated)
  id_image_urls?: string[];
  // Location info (for reference only, not directly inserted)
  room_name?: string;
  bed_name?: string;
  building_name?: string;
  // Internal warning (not blocking)
  _phone_warning?: string;
}

export interface CustomerImportResult {
  validRows: CustomerImportRow[];
  errors: { row: number; message: string }[];
  warnings: { row: number; message: string }[];
}

// =============================================
// Export column headers — matches the template exactly
// =============================================

const EXPORT_COLS = [
  { header: 'STT',                          key: 'stt',                   wch: 6  },
  { header: 'Mã KH',                        key: 'ma_kh',                 wch: 12 },
  { header: 'Họ tên',                       key: 'ho_ten',                wch: 25 },
  { header: 'SĐT',                          key: 'sdt',                   wch: 14 },
  { header: 'Email',                        key: 'email',                 wch: 25 },
  { header: 'Ngày sinh',                    key: 'ngay_sinh',             wch: 14 },
  { header: 'Giới tính',                    key: 'gioi_tinh',             wch: 10 },
  { header: 'CMND/CCCD',                    key: 'cmnd_cccd',             wch: 16 },
  { header: 'Nghề cụ',                      key: 'nghe_cu',               wch: 18 },
  { header: 'Ngày cấp',                     key: 'ngay_cap',              wch: 14 },
  { header: 'Nơi cấp',                      key: 'noi_cap',               wch: 20 },
  { header: 'Địa chỉ',                      key: 'dia_chi',               wch: 35 },
  { header: 'Ảnh CMND/CCCD',               key: 'anh_cmnd',              wch: 40 },
  { header: 'Quốc tịch',                    key: 'quoc_tich',             wch: 12 },
  { header: 'Số hộ chiếu',                  key: 'so_ho_chieu',           wch: 16 },
  { header: 'Căn hộ',                       key: 'can_ho',                wch: 14 },
  { header: 'Phòng',                        key: 'phong',                 wch: 12 },
  { header: 'Giường',                       key: 'giuong',                wch: 10 },
  { header: 'Số mạng kết nối TikTok/App',  key: 'so_mang',               wch: 22 },
  { header: 'Họ tên người liên hệ',         key: 'ho_ten_lien_he',        wch: 22 },
  { header: 'SĐT người liên hệ',            key: 'sdt_lien_he',           wch: 16 },
] as const;

// =============================================
// Import column headers — same as export (without STT, Mã KH, Ảnh CMND/CCCD)
// =============================================

const IMPORT_HEADERS = [
  'Họ tên',
  'SĐT',
  'Email',
  'Ngày sinh',
  'Giới tính',
  'CMND/CCCD',
  'Nghề cụ',
  'Ngày cấp',
  'Nơi cấp',
  'Địa chỉ',
  'Ảnh CMND/CCCD',
  'Quốc tịch',
  'Số hộ chiếu',
  'Căn hộ',
  'Phòng',
  'Giường',
  'Số mạng kết nối TikTok/App',
  'Họ tên người liên hệ',
  'SĐT người liên hệ',
] as const;

/** Map import header → CustomerImportRow field */
const IMPORT_HEADER_MAP: Record<string, keyof CustomerImportRow> = {
  'Họ tên':                         'full_name',
  'SĐT':                            'phone',
  'Email':                          'email',
  'Ngày sinh':                      'date_of_birth',
  'Giới tính':                      'gender',
  'CMND/CCCD':                      'id_number',
  'Nghề cụ':                        'occupation',
  'Ngày cấp':                       'id_issue_date',
  'Nơi cấp':                        'id_issue_place',
  'Địa chỉ':                        'permanent_address',
  'Quốc tịch':                      'nationality',
  'Số hộ chiếu':                    'passport_number',
  'Căn hộ':                         'building_name',
  'Phòng':                          'room_name',
  'Giường':                         'bed_name',
  'Họ tên người liên hệ':           'contact_person',
  'SĐT người liên hệ':              'contact_person_phone',
};

// =============================================
// Helpers
// =============================================

function formatGender(gender: string | null | undefined): string {
  if (!gender) return '';
  switch (gender.toUpperCase()) {
    case 'MALE':   return 'Nam';
    case 'FEMALE': return 'Nữ';
    case 'OTHER':  return 'Khác';
    default:       return gender;
  }
}

function parseGender(raw: string): string | undefined {
  if (!raw) return undefined;
  const v = raw.trim().toLowerCase();
  if (v === 'nam' || v === 'male')   return 'MALE';
  if (v === 'nữ' || v === 'nu' || v === 'female') return 'FEMALE';
  if (v === 'khác' || v === 'khac' || v === 'other') return 'OTHER';
  return raw.trim() || undefined;
}

// =============================================
// Export — "DANH SÁCH CƯ DÂN" format
// =============================================

export interface CustomerWithLocation extends Customer {
  building_name?: string;
  room_name?: string;
  bed_name?: string;
}

export function exportCustomers(
  customers: CustomerWithLocation[],
  _filters?: CustomerFilters
): void {
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet([]);

  // Row 1: Title
  XLSX.utils.sheet_add_aoa(ws, [['DANH SÁCH CƯ DÂN']], { origin: 'A1' });
  // Row 2: Subtitle
  XLSX.utils.sheet_add_aoa(ws, [['Resident - Phần mềm quản lý Căn hộ & Cư dân | Website: https://resident.vn | Hotline & Zalo: 0869.987.255']], { origin: 'A2' });
  // Row 3: blank
  XLSX.utils.sheet_add_aoa(ws, [['']], { origin: 'A3' });

  // Row 4: column headers
  const headers = EXPORT_COLS.map(c => c.header);
  XLSX.utils.sheet_add_aoa(ws, [headers], { origin: 'A4' });

  // Rows 5+: data
  customers.forEach((c, i) => {
    const row = [
      i + 1,
      c.id.slice(0, 8).toUpperCase(),
      c.full_name,
      c.phone,
      c.email ?? '',
      c.date_of_birth ?? '',
      formatGender(c.gender),
      c.id_number ?? '',
      c.occupation ?? '',
      c.id_issue_date ?? '',
      c.id_issue_place ?? '',
      c.permanent_address ?? c.detailed_address ?? '',
      // Ảnh CMND/CCCD: join all image URLs with newline
      Object.values(c.id_images ?? {}).filter(Boolean).join('\n'),
      c.is_foreign ? 'Nước ngoài' : 'Việt Nam',
      '', // Số hộ chiếu — not in current schema
      c.building_name ?? '',
      c.room_name ?? '',
      c.bed_name ?? '',
      '', // Số mạng kết nối TikTok/App
      c.contact_person ?? '',
      c.contact_person_phone ?? '',
    ];
    XLSX.utils.sheet_add_aoa(ws, [row], { origin: `A${i + 5}` });
  });

  // Merge title across all columns
  const totalCols = EXPORT_COLS.length;
  ws['!merges'] = [
    { s: { r: 0, c: 0 }, e: { r: 0, c: totalCols - 1 } }, // Title
    { s: { r: 1, c: 0 }, e: { r: 1, c: totalCols - 1 } }, // Subtitle
  ];

  // Column widths
  ws['!cols'] = EXPORT_COLS.map(c => ({ wch: c.wch }));

  XLSX.utils.book_append_sheet(wb, ws, 'Danh sách cư dân');
  XLSX.writeFile(wb, 'danh-sach-cu-dan.xlsx');
}

// =============================================
// Template download
// =============================================

export function downloadCustomerImportTemplate(): void {
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet([]);

  // Row 1: Title
  XLSX.utils.sheet_add_aoa(ws, [['DANH SÁCH CƯ DÂN']], { origin: 'A1' });
  // Row 2: Subtitle
  XLSX.utils.sheet_add_aoa(ws, [['Resident - Phần mềm quản lý Căn hộ & Cư dân | Website: https://resident.vn | Hotline & Zalo: 0869.987.255']], { origin: 'A2' });
  // Row 3: blank
  XLSX.utils.sheet_add_aoa(ws, [['']], { origin: 'A3' });

  // Row 4: headers
  XLSX.utils.sheet_add_aoa(ws, [IMPORT_HEADERS as unknown as string[]], { origin: 'A4' });

  // Row 5: example
  const example = [
    'Nguyễn Văn A',   // Họ tên
    '0901234567',      // SĐT
    'example@email.com', // Email
    '15/01/1990',      // Ngày sinh
    'Nam',             // Giới tính
    '012345678901',    // CMND/CCCD
    'Kỹ sư',           // Nghề cụ
    '28/01/2023',      // Ngày cấp
    'Hà Nội',          // Nơi cấp
    '123 Đường ABC, Quận 1, TP.HCM', // Địa chỉ
    '',                // Ảnh CMND/CCCD (để trống hoặc dán link)
    'Việt Nam',        // Quốc tịch
    '',                // Số hộ chiếu
    'Tòa A',           // Căn hộ
    '101',             // Phòng
    'G1',              // Giường
    '',                // Số mạng kết nối TikTok/App
    'Nguyễn Thị B',   // Họ tên người liên hệ
    '0987654321',      // SĐT người liên hệ
  ];
  XLSX.utils.sheet_add_aoa(ws, [example], { origin: 'A5' });

  const totalCols = IMPORT_HEADERS.length;
  ws['!merges'] = [
    { s: { r: 0, c: 0 }, e: { r: 0, c: totalCols - 1 } },
    { s: { r: 1, c: 0 }, e: { r: 1, c: totalCols - 1 } },
  ];

  ws['!cols'] = [
    { wch: 25 }, // Họ tên
    { wch: 14 }, // SĐT
    { wch: 25 }, // Email
    { wch: 14 }, // Ngày sinh
    { wch: 10 }, // Giới tính
    { wch: 16 }, // CMND/CCCD
    { wch: 18 }, // Nghề cụ
    { wch: 14 }, // Ngày cấp
    { wch: 20 }, // Nơi cấp
    { wch: 35 }, // Địa chỉ
    { wch: 40 }, // Ảnh CMND/CCCD
    { wch: 12 }, // Quốc tịch
    { wch: 16 }, // Số hộ chiếu
    { wch: 14 }, // Căn hộ
    { wch: 12 }, // Phòng
    { wch: 10 }, // Giường
    { wch: 22 }, // Số mạng kết nối TikTok/App
    { wch: 22 }, // Họ tên người liên hệ
    { wch: 16 }, // SĐT người liên hệ
  ];

  XLSX.utils.book_append_sheet(wb, ws, 'Mẫu nhập cư dân');
  XLSX.writeFile(wb, 'mau-nhap-cu-dan.xlsx');
}

// =============================================
// Import / Parse
// =============================================

const PHONE_REGEX = /^[0-9]{10,11}$/;

/**
 * Parse Excel file exported from Resident or filled from the template.
 * Supports both:
 *   - Template format: header at row 4 (rows 1-3 are title/subtitle/blank)
 *   - Simple format: header at row 1
 */
export async function parseCustomerExcel(file: File): Promise<CustomerImportResult> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();

    reader.onload = (e) => {
      try {
        const data = new Uint8Array(e.target?.result as ArrayBuffer);
        const workbook = XLSX.read(data, { type: 'array' });

        const sheetName = workbook.SheetNames[0];
        const ws = workbook.Sheets[sheetName];

        // Detect header row: check if A1 contains "DANH SÁCH" (title row)
        const a1 = ws['A1']?.v?.toString() ?? '';
        const headerRowIndex = a1.toUpperCase().includes('DANH SÁCH') ? 3 : 0; // 0-indexed

        // Read all rows as array of arrays
        const aoa: unknown[][] = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' }) as unknown[][];

        if (aoa.length <= headerRowIndex) {
          return resolve({ validRows: [], errors: [], warnings: [] });
        }

        // Extract header row
        const headerRow = (aoa[headerRowIndex] as string[]).map(h => String(h ?? '').trim());

        // Data rows start after header
        const dataRows = aoa.slice(headerRowIndex + 1);

        const validRows: CustomerImportRow[] = [];
        const errors: { row: number; message: string }[] = [];
        const warnings: { row: number; message: string }[] = [];

        dataRows.forEach((rawRow, index) => {
          const excelRowNum = headerRowIndex + index + 2; // 1-indexed for user display

          // Skip completely empty rows
          const rowArr = rawRow as unknown[];
          if (rowArr.every(cell => cell === '' || cell === null || cell === undefined)) return;

          // Map header → value
          const mapped: Record<string, string> = {};
          headerRow.forEach((h, colIdx) => {
            const val = rowArr[colIdx];
            if (val !== undefined && val !== null && val !== '') {
              mapped[h] = String(val).trim();
            }
          });

          // Build CustomerImportRow
          const row: Partial<CustomerImportRow> = {};
          for (const [header, field] of Object.entries(IMPORT_HEADER_MAP)) {
            if (mapped[header]) {
              (row as Record<string, string>)[field] = mapped[header];
            }
          }

          // Also handle "Họ tên người liên hệ" separately (same key as contact_person)
          if (mapped['Họ tên người liên hệ']) {
            row.contact_person = mapped['Họ tên người liên hệ'];
          }

          // Parse "Ảnh CMND/CCCD" column — may contain multiple URLs separated by newlines
          const rawImages = mapped['Ảnh CMND/CCCD'] ?? '';
          if (rawImages) {
            const urls = rawImages
              .split(/[\n\r]+/)
              .map(u => u.trim())
              .filter(u => u.startsWith('http'));
            if (urls.length > 0) row.id_image_urls = urls;
          }

          const rowErrors: string[] = [];

          // Validate full_name (required)
          if (!row.full_name?.trim()) {
            rowErrors.push('Họ tên không được để trống');
          }

          // Validate phone (required, warn if not 10-11 digits but still allow)
          const phone = row.phone?.replace(/\s/g, '') ?? '';
          if (!phone) {
            rowErrors.push('SĐT không được để trống');
          } else {
            row.phone = phone;
            // Warn but don't block if format is unusual
            if (!PHONE_REGEX.test(phone)) {
              row._phone_warning = `SĐT "${phone}" không đúng định dạng 10-11 chữ số`;
            }
          }

          if (rowErrors.length > 0) {
            errors.push({ row: excelRowNum, message: rowErrors.join('; ') });
          } else {
            // Normalize gender
            if (row.gender) row.gender = parseGender(row.gender);

            // Collect phone warning if any
            if (row._phone_warning) {
              warnings.push({ row: excelRowNum, message: row._phone_warning });
            }

            validRows.push({
              full_name:            row.full_name!.trim(),
              phone:                row.phone!,
              email:                row.email?.trim() || undefined,
              date_of_birth:        row.date_of_birth?.trim() || undefined,
              gender:               row.gender || undefined,
              id_number:            row.id_number?.trim() || undefined,
              id_issue_date:        row.id_issue_date?.trim() || undefined,
              id_issue_place:       row.id_issue_place?.trim() || undefined,
              permanent_address:    row.permanent_address?.trim() || undefined,
              nationality:          row.nationality?.trim() || undefined,
              passport_number:      row.passport_number?.trim() || undefined,
              occupation:           row.occupation?.trim() || undefined,
              contact_person:       row.contact_person?.trim() || undefined,
              contact_person_phone: row.contact_person_phone?.trim() || undefined,
              id_image_urls:        row.id_image_urls,
              building_name:        row.building_name?.trim() || undefined,
              room_name:            row.room_name?.trim() || undefined,
              bed_name:             row.bed_name?.trim() || undefined,
            });
          }
        });

        resolve({ validRows, errors, warnings });
      } catch {
        reject(new Error('Không thể đọc file Excel. Vui lòng kiểm tra định dạng file.'));
      }
    };

    reader.onerror = () => reject(new Error('Lỗi khi đọc file'));
    reader.readAsArrayBuffer(file);
  });
}

// =============================================
// ID Image Download & Upload
// =============================================

/**
 * Download an image from an external URL via a CORS proxy approach:
 * fetch the URL, get a Blob, then upload to Supabase Storage.
 *
 * Returns the public URL of the uploaded file, or null on failure.
 */
async function downloadAndUploadImage(
  externalUrl: string,
  storagePath: string
): Promise<string | null> {
  try {
    // Fetch the image (works if the source server allows CORS, e.g. s3.resident.vn)
    const response = await fetch(externalUrl, { mode: 'cors' });
    if (!response.ok) return null;

    const blob = await response.blob();
    const ext = externalUrl.split('.').pop()?.split('?')[0] ?? 'jpg';
    const contentType = blob.type || `image/${ext}`;

    const { error } = await supabase.storage
      .from('customer-images')
      .upload(storagePath, blob, { contentType, upsert: true });

    if (error) {
      console.warn('Upload failed:', storagePath, error.message);
      return null;
    }

    const { data } = supabase.storage
      .from('customer-images')
      .getPublicUrl(storagePath);

    return data.publicUrl ?? null;
  } catch (err) {
    console.warn('downloadAndUploadImage error:', externalUrl, err);
    return null;
  }
}

/**
 * Download ID card images from external URLs (column L) and upload to Supabase Storage.
 *
 * Maps:
 *   urls[0] → id_images.front
 *   urls[1] → id_images.back
 *   urls[2+] → id_images.extra_N
 *
 * Returns the id_images object to be saved on the customer record.
 * Falls back to storing the original URL if download fails (so data is not lost).
 */
export async function uploadIdImagesFromUrls(
  customerId: string,
  urls: string[]
): Promise<Record<string, string>> {
  const keys = ['front', 'back', 'extra_1', 'extra_2', 'extra_3'];
  const result: Record<string, string> = {};

  await Promise.all(
    urls.map(async (url, idx) => {
      const key = keys[idx] ?? `extra_${idx}`;
      const ext = url.split('.').pop()?.split('?')[0] ?? 'jpg';
      const storagePath = `id-cards/${customerId}/${key}.${ext}`;

      const uploadedUrl = await downloadAndUploadImage(url, storagePath);
      // Use uploaded URL if successful, otherwise keep original URL as fallback
      result[key] = uploadedUrl ?? url;
    })
  );

  return result;
}
