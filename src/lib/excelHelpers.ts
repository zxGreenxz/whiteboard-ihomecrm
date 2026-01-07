/**
 * Excel Import/Export Helpers
 * Uses XLSX library for Excel file operations
 */

import * as XLSX from 'xlsx';

// =============================================
// EXPORT FUNCTIONS
// =============================================

export interface ExportColumn<T> {
  header: string;
  key: keyof T | ((item: T) => any);
  width?: number;
}

/**
 * Export data to Excel file
 */
export function exportToExcel<T>(
  data: T[],
  columns: ExportColumn<T>[],
  filename: string,
  sheetName: string = 'Sheet1'
): void {
  // Transform data to worksheet format
  const worksheetData = data.map(item => {
    const row: Record<string, any> = {};
    columns.forEach(col => {
      const value = typeof col.key === 'function'
        ? col.key(item)
        : item[col.key as keyof T];
      row[col.header] = value;
    });
    return row;
  });

  // Create worksheet
  const worksheet = XLSX.utils.json_to_sheet(worksheetData);

  // Set column widths
  const columnWidths = columns.map(col => ({
    wch: col.width || Math.max(col.header.length, 15)
  }));
  worksheet['!cols'] = columnWidths;

  // Create workbook
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, worksheet, sheetName);

  // Download file
  XLSX.writeFile(workbook, `${filename}.xlsx`);
}

/**
 * Export Buildings to Excel
 */
export function exportBuildings(buildings: Array<{
  id: string;
  code: string | null;
  name: string;
  type: string;
  province: string;
  district: string;
  ward: string;
  street_address: string | null;
  total_floors: number | null;
  total_rooms: number | null;
  status: string;
  created_at: string;
}>): void {
  const columns: ExportColumn<typeof buildings[0]>[] = [
    { header: 'Mã tòa nhà', key: 'code', width: 15 },
    { header: 'Tên tòa nhà', key: 'name', width: 25 },
    { header: 'Loại', key: item => item.type === 'APARTMENT' ? 'Chung cư' : item.type === 'DORMITORY' ? 'KTX' : item.type === 'HOUSE' ? 'Nhà trọ' : item.type, width: 15 },
    { header: 'Tỉnh/TP', key: 'province', width: 20 },
    { header: 'Quận/Huyện', key: 'district', width: 20 },
    { header: 'Phường/Xã', key: 'ward', width: 20 },
    { header: 'Địa chỉ', key: 'street_address', width: 30 },
    { header: 'Số tầng', key: 'total_floors', width: 10 },
    { header: 'Số phòng', key: 'total_rooms', width: 10 },
    { header: 'Trạng thái', key: item => item.status === 'ACTIVE' ? 'Hoạt động' : 'Không hoạt động', width: 15 },
  ];

  exportToExcel(buildings, columns, 'danh-sach-toa-nha', 'Tòa nhà');
}

/**
 * Export Rooms to Excel
 */
export function exportRooms(rooms: Array<{
  id: string;
  code: string | null;
  name: string;
  floor: number | null;
  area: number | null;
  rent_price: number;
  deposit_amount: number;
  max_occupants: number | null;
  status: string;
  building?: { name: string };
}>): void {
  const columns: ExportColumn<typeof rooms[0]>[] = [
    { header: 'Tòa nhà', key: item => item.building?.name || '', width: 25 },
    { header: 'Mã phòng', key: 'code', width: 15 },
    { header: 'Tên phòng', key: 'name', width: 20 },
    { header: 'Tầng', key: 'floor', width: 10 },
    { header: 'Diện tích (m²)', key: 'area', width: 15 },
    { header: 'Giá thuê', key: item => item.rent_price.toLocaleString('vi-VN'), width: 15 },
    { header: 'Tiền cọc', key: item => item.deposit_amount.toLocaleString('vi-VN'), width: 15 },
    { header: 'Số người tối đa', key: 'max_occupants', width: 15 },
    { header: 'Trạng thái', key: item => {
      const statusMap: Record<string, string> = {
        AVAILABLE: 'Còn trống',
        OCCUPIED: 'Đã cho thuê',
        RESERVED: 'Đã đặt',
        MAINTENANCE: 'Đang sửa chữa',
      };
      return statusMap[item.status] || item.status;
    }, width: 15 },
  ];

  exportToExcel(rooms, columns, 'danh-sach-phong', 'Phòng');
}

/**
 * Export Tenants to Excel
 */
export function exportTenants(tenants: Array<{
  id: string;
  full_name: string;
  phone: string;
  email: string | null;
  id_number: string | null;
  date_of_birth: string | null;
  gender: string | null;
  permanent_address: string | null;
  created_at: string;
}>): void {
  const columns: ExportColumn<typeof tenants[0]>[] = [
    { header: 'Họ tên', key: 'full_name', width: 25 },
    { header: 'Số điện thoại', key: 'phone', width: 15 },
    { header: 'Email', key: 'email', width: 25 },
    { header: 'CCCD/CMND', key: 'id_number', width: 15 },
    { header: 'Ngày sinh', key: item => item.date_of_birth ? new Date(item.date_of_birth).toLocaleDateString('vi-VN') : '', width: 15 },
    { header: 'Giới tính', key: item => item.gender === 'MALE' ? 'Nam' : item.gender === 'FEMALE' ? 'Nữ' : '', width: 10 },
    { header: 'Địa chỉ thường trú', key: 'permanent_address', width: 40 },
  ];

  exportToExcel(tenants, columns, 'danh-sach-khach-thue', 'Khách thuê');
}

/**
 * Export Contracts to Excel
 */
export function exportContracts(contracts: Array<{
  id: string;
  contract_number: string | null;
  start_date: string;
  end_date: string;
  rent_price: number;
  total_deposit: number;
  status: string;
  tenant?: { full_name: string; phone: string };
  room?: { name: string; building?: { name: string } };
}>): void {
  const columns: ExportColumn<typeof contracts[0]>[] = [
    { header: 'Mã hợp đồng', key: 'contract_number', width: 20 },
    { header: 'Khách thuê', key: item => item.tenant?.full_name || '', width: 25 },
    { header: 'SĐT', key: item => item.tenant?.phone || '', width: 15 },
    { header: 'Tòa nhà', key: item => item.room?.building?.name || '', width: 20 },
    { header: 'Phòng', key: item => item.room?.name || '', width: 15 },
    { header: 'Ngày bắt đầu', key: item => new Date(item.start_date).toLocaleDateString('vi-VN'), width: 15 },
    { header: 'Ngày kết thúc', key: item => new Date(item.end_date).toLocaleDateString('vi-VN'), width: 15 },
    { header: 'Giá thuê', key: item => item.rent_price.toLocaleString('vi-VN'), width: 15 },
    { header: 'Tiền cọc', key: item => item.total_deposit.toLocaleString('vi-VN'), width: 15 },
    { header: 'Trạng thái', key: item => {
      const statusMap: Record<string, string> = {
        DRAFT: 'Nháp',
        ACTIVE: 'Đang hoạt động',
        EXTENDED: 'Đã gia hạn',
        TRANSFERRED: 'Đã chuyển nhượng',
        TERMINATED: 'Đã thanh lý',
        EXPIRED: 'Hết hạn',
      };
      return statusMap[item.status] || item.status;
    }, width: 15 },
  ];

  exportToExcel(contracts, columns, 'danh-sach-hop-dong', 'Hợp đồng');
}

/**
 * Export Invoices to Excel
 */
export function exportInvoices(invoices: Array<{
  id: string;
  invoice_number: string;
  billing_period_from: string;
  billing_period_to: string;
  subtotal: number;
  total_amount: number;
  paid_amount: number;
  status: string;
  due_date: string;
  room?: { name: string };
  tenant?: { full_name: string };
}>): void {
  const columns: ExportColumn<typeof invoices[0]>[] = [
    { header: 'Số hóa đơn', key: 'invoice_number', width: 20 },
    { header: 'Khách thuê', key: item => item.tenant?.full_name || '', width: 25 },
    { header: 'Phòng', key: item => item.room?.name || '', width: 15 },
    { header: 'Kỳ từ', key: item => new Date(item.billing_period_from).toLocaleDateString('vi-VN'), width: 15 },
    { header: 'Kỳ đến', key: item => new Date(item.billing_period_to).toLocaleDateString('vi-VN'), width: 15 },
    { header: 'Tiền dịch vụ', key: item => item.subtotal.toLocaleString('vi-VN'), width: 15 },
    { header: 'Tổng tiền', key: item => item.total_amount.toLocaleString('vi-VN'), width: 15 },
    { header: 'Đã thanh toán', key: item => item.paid_amount.toLocaleString('vi-VN'), width: 15 },
    { header: 'Còn lại', key: item => (item.total_amount - item.paid_amount).toLocaleString('vi-VN'), width: 15 },
    { header: 'Hạn thanh toán', key: item => new Date(item.due_date).toLocaleDateString('vi-VN'), width: 15 },
    { header: 'Trạng thái', key: item => {
      const statusMap: Record<string, string> = {
        DRAFT: 'Nháp',
        APPROVED: 'Đã duyệt',
        SENT: 'Đã gửi',
        PAID: 'Đã thanh toán',
        PARTIAL_PAID: 'Thanh toán một phần',
        OVERDUE: 'Quá hạn',
      };
      return statusMap[item.status] || item.status;
    }, width: 18 },
  ];

  exportToExcel(invoices, columns, 'danh-sach-hoa-don', 'Hóa đơn');
}

// =============================================
// IMPORT FUNCTIONS
// =============================================

export interface ImportResult<T> {
  success: T[];
  errors: Array<{ row: number; message: string }>;
}

/**
 * Parse Excel file to JSON
 */
export async function parseExcelFile<T>(
  file: File,
  headerMapping: Record<string, keyof T>
): Promise<T[]> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();

    reader.onload = (e) => {
      try {
        const data = new Uint8Array(e.target?.result as ArrayBuffer);
        const workbook = XLSX.read(data, { type: 'array' });

        // Get first sheet
        const sheetName = workbook.SheetNames[0];
        const worksheet = workbook.Sheets[sheetName];

        // Convert to JSON
        const jsonData = XLSX.utils.sheet_to_json<Record<string, any>>(worksheet);

        // Map headers
        const mappedData = jsonData.map(row => {
          const mappedRow: Partial<T> = {};
          Object.entries(headerMapping).forEach(([excelHeader, fieldKey]) => {
            if (row[excelHeader] !== undefined) {
              (mappedRow as any)[fieldKey] = row[excelHeader];
            }
          });
          return mappedRow as T;
        });

        resolve(mappedData);
      } catch (error) {
        reject(new Error('Không thể đọc file Excel. Vui lòng kiểm tra định dạng file.'));
      }
    };

    reader.onerror = () => {
      reject(new Error('Lỗi khi đọc file'));
    };

    reader.readAsArrayBuffer(file);
  });
}

/**
 * Import Buildings from Excel
 */
export async function importBuildings(
  file: File
): Promise<ImportResult<{
  name: string;
  code?: string;
  type: string;
  province: string;
  district: string;
  ward: string;
  street_address?: string;
  total_floors?: number;
  total_rooms?: number;
}>> {
  const headerMapping = {
    'Mã tòa nhà': 'code',
    'Tên tòa nhà': 'name',
    'Loại': 'type',
    'Tỉnh/TP': 'province',
    'Quận/Huyện': 'district',
    'Phường/Xã': 'ward',
    'Địa chỉ': 'street_address',
    'Số tầng': 'total_floors',
    'Số phòng': 'total_rooms',
  } as const;

  const data = await parseExcelFile(file, headerMapping as any);

  const success: any[] = [];
  const errors: Array<{ row: number; message: string }> = [];

  data.forEach((item, index) => {
    const row = index + 2; // Excel rows start at 1, plus header row

    // Validate required fields
    if (!item.name) {
      errors.push({ row, message: 'Thiếu tên tòa nhà' });
      return;
    }
    if (!item.province) {
      errors.push({ row, message: 'Thiếu tỉnh/thành phố' });
      return;
    }
    if (!item.district) {
      errors.push({ row, message: 'Thiếu quận/huyện' });
      return;
    }
    if (!item.ward) {
      errors.push({ row, message: 'Thiếu phường/xã' });
      return;
    }

    // Map type
    const typeMap: Record<string, string> = {
      'Chung cư': 'APARTMENT',
      'KTX': 'DORMITORY',
      'Nhà trọ': 'HOUSE',
      'Khác': 'OTHER',
    };

    success.push({
      ...item,
      type: typeMap[item.type as string] || 'HOUSE',
    });
  });

  return { success, errors };
}

/**
 * Import Rooms from Excel
 */
export async function importRooms(
  file: File
): Promise<ImportResult<{
  name: string;
  code?: string;
  building_name: string; // Will need to be resolved to building_id
  floor?: number;
  area?: number;
  rent_price: number;
  deposit_amount: number;
  max_occupants?: number;
}>> {
  const headerMapping = {
    'Tòa nhà': 'building_name',
    'Mã phòng': 'code',
    'Tên phòng': 'name',
    'Tầng': 'floor',
    'Diện tích (m²)': 'area',
    'Giá thuê': 'rent_price',
    'Tiền cọc': 'deposit_amount',
    'Số người tối đa': 'max_occupants',
  } as const;

  const data = await parseExcelFile(file, headerMapping as any);

  const success: any[] = [];
  const errors: Array<{ row: number; message: string }> = [];

  data.forEach((item, index) => {
    const row = index + 2;

    // Validate required fields
    if (!item.name) {
      errors.push({ row, message: 'Thiếu tên phòng' });
      return;
    }
    if (!item.building_name) {
      errors.push({ row, message: 'Thiếu tên tòa nhà' });
      return;
    }
    if (!item.rent_price || isNaN(Number(item.rent_price))) {
      errors.push({ row, message: 'Giá thuê không hợp lệ' });
      return;
    }
    if (!item.deposit_amount || isNaN(Number(item.deposit_amount))) {
      errors.push({ row, message: 'Tiền cọc không hợp lệ' });
      return;
    }

    // Parse currency strings (remove dots and convert to number)
    const parseAmount = (value: string | number): number => {
      if (typeof value === 'number') return value;
      return Number(value.replace(/\./g, '').replace(/,/g, ''));
    };

    success.push({
      ...item,
      rent_price: parseAmount(item.rent_price as any),
      deposit_amount: parseAmount(item.deposit_amount as any),
      floor: item.floor ? Number(item.floor) : undefined,
      area: item.area ? Number(item.area) : undefined,
      max_occupants: item.max_occupants ? Number(item.max_occupants) : undefined,
    });
  });

  return { success, errors };
}

/**
 * Generate sample Excel template for import
 */
export function downloadImportTemplate(type: 'buildings' | 'rooms' | 'tenants'): void {
  let headers: string[] = [];
  let sampleData: any[] = [];

  switch (type) {
    case 'buildings':
      headers = ['Mã tòa nhà', 'Tên tòa nhà', 'Loại', 'Tỉnh/TP', 'Quận/Huyện', 'Phường/Xã', 'Địa chỉ', 'Số tầng', 'Số phòng'];
      sampleData = [
        { 'Mã tòa nhà': 'TN001', 'Tên tòa nhà': 'Tòa nhà ABC', 'Loại': 'Nhà trọ', 'Tỉnh/TP': 'Hồ Chí Minh', 'Quận/Huyện': 'Quận 1', 'Phường/Xã': 'Phường Bến Nghé', 'Địa chỉ': '123 Nguyễn Huệ', 'Số tầng': 5, 'Số phòng': 20 },
        { 'Mã tòa nhà': 'TN002', 'Tên tòa nhà': 'Tòa nhà XYZ', 'Loại': 'Chung cư', 'Tỉnh/TP': 'Hồ Chí Minh', 'Quận/Huyện': 'Quận 7', 'Phường/Xã': 'Phường Tân Phong', 'Địa chỉ': '456 Nguyễn Thị Thập', 'Số tầng': 10, 'Số phòng': 50 },
      ];
      break;
    case 'rooms':
      headers = ['Tòa nhà', 'Mã phòng', 'Tên phòng', 'Tầng', 'Diện tích (m²)', 'Giá thuê', 'Tiền cọc', 'Số người tối đa'];
      sampleData = [
        { 'Tòa nhà': 'Tòa nhà ABC', 'Mã phòng': 'P101', 'Tên phòng': 'Phòng 101', 'Tầng': 1, 'Diện tích (m²)': 25, 'Giá thuê': 3500000, 'Tiền cọc': 3500000, 'Số người tối đa': 2 },
        { 'Tòa nhà': 'Tòa nhà ABC', 'Mã phòng': 'P102', 'Tên phòng': 'Phòng 102', 'Tầng': 1, 'Diện tích (m²)': 30, 'Giá thuê': 4000000, 'Tiền cọc': 4000000, 'Số người tối đa': 3 },
      ];
      break;
    case 'tenants':
      headers = ['Họ tên', 'Số điện thoại', 'Email', 'CCCD/CMND', 'Ngày sinh', 'Giới tính', 'Địa chỉ thường trú'];
      sampleData = [
        { 'Họ tên': 'Nguyễn Văn A', 'Số điện thoại': '0901234567', 'Email': 'nguyenvana@email.com', 'CCCD/CMND': '012345678901', 'Ngày sinh': '01/01/1990', 'Giới tính': 'Nam', 'Địa chỉ thường trú': '123 Đường ABC, Quận 1, TP.HCM' },
        { 'Họ tên': 'Trần Thị B', 'Số điện thoại': '0909876543', 'Email': 'tranthib@email.com', 'CCCD/CMND': '098765432109', 'Ngày sinh': '15/05/1995', 'Giới tính': 'Nữ', 'Địa chỉ thường trú': '456 Đường XYZ, Quận 2, TP.HCM' },
      ];
      break;
  }

  const worksheet = XLSX.utils.json_to_sheet(sampleData);
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, worksheet, 'Mẫu dữ liệu');

  XLSX.writeFile(workbook, `mau-${type}.xlsx`);
}
