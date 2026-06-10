/**
 * Excel Import/Export Helpers
 * Uses XLSX library for Excel file operations
 */

// xlsx ~430 kB min — dynamic import để không vào bundle đầu; chỉ tải khi
// user bấm Import/Export.
type XLSXModule = typeof import('xlsx');
let xlsxPromise: Promise<XLSXModule> | null = null;
const getXLSX = (): Promise<XLSXModule> => (xlsxPromise ??= import('xlsx'));

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
export async function exportToExcel<T>(
  data: T[],
  columns: ExportColumn<T>[],
  filename: string,
  sheetName: string = 'Sheet1'
): Promise<void> {
  const XLSX = await getXLSX();

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
export async function exportBuildings(buildings: Array<{
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
}>): Promise<void> {
  const columns: ExportColumn<typeof buildings[0]>[] = [
    { header: 'Mã tòa nhà', key: 'code', width: 15 },
    { header: 'Tên tòa nhà', key: 'name', width: 25 },
    { header: 'Loại', key: item => item.type === 'APARTMENT' ? 'Chung cư' : item.type === 'DORMITORY' ? 'KTX' : item.type === 'HOUSE' ? 'Nhà trọ' : item.type, width: 15 },
    { header: 'Tỉnh/TP', key: 'province', width: 20 },
    { header: 'Quận/Huyện', key: 'district', width: 20 },
    { header: 'Phường/Xã', key: 'ward', width: 20 },
    { header: 'Địa chỉ', key: 'street_address', width: 30 },
    { header: 'Số tầng', key: 'total_floors', width: 10 },
    { header: 'Số căn hộ', key: 'total_rooms', width: 10 },
    { header: 'Trạng thái', key: item => item.status === 'ACTIVE' ? 'Hoạt động' : 'Không hoạt động', width: 15 },
  ];

  await exportToExcel(buildings, columns, 'danh-sach-toa-nha', 'Tòa nhà');
}

/**
 * Export Rooms to Excel
 */
export async function exportRooms(rooms: Array<{
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
}>): Promise<void> {
  const columns: ExportColumn<typeof rooms[0]>[] = [
    { header: 'Tòa nhà', key: item => item.building?.name || '', width: 25 },
    { header: 'Mã căn hộ', key: 'code', width: 15 },
    { header: 'Tên căn hộ', key: 'name', width: 20 },
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

  await exportToExcel(rooms, columns, 'danh-sach-can-ho', 'Căn hộ');
}

/**
 * Export Tenants to Excel
 */
export async function exportTenants(tenants: Array<{
  id: string;
  full_name: string;
  phone: string;
  email: string | null;
  id_number: string | null;
  date_of_birth: string | null;
  gender: string | null;
  permanent_address: string | null;
  created_at: string;
}>): Promise<void> {
  const columns: ExportColumn<typeof tenants[0]>[] = [
    { header: 'Họ tên', key: 'full_name', width: 25 },
    { header: 'Số điện thoại', key: 'phone', width: 15 },
    { header: 'Email', key: 'email', width: 25 },
    { header: 'CCCD/CMND', key: 'id_number', width: 15 },
    { header: 'Ngày sinh', key: item => item.date_of_birth ? new Date(item.date_of_birth).toLocaleDateString('vi-VN', { day: '2-digit', month: '2-digit', year: 'numeric' }) : '', width: 15 },
    { header: 'Giới tính', key: item => item.gender === 'MALE' ? 'Nam' : item.gender === 'FEMALE' ? 'Nữ' : '', width: 10 },
    { header: 'Địa chỉ thường trú', key: 'permanent_address', width: 40 },
  ];

  await exportToExcel(tenants, columns, 'danh-sach-khach-hang', 'Khách hàng');
}

/**
 * Export Contracts to Excel
 */
export async function exportContracts(contracts: Array<{
  id: string;
  contract_number: string | null;
  start_date: string;
  end_date: string;
  rent_price: number;
  total_deposit: number;
  status: string;
  tenant?: { full_name: string; phone: string };
  room?: { name: string; building?: { name: string } };
}>): Promise<void> {
  const columns: ExportColumn<typeof contracts[0]>[] = [
    { header: 'Mã hợp đồng', key: 'contract_number', width: 20 },
    { header: 'Khách hàng', key: item => item.tenant?.full_name || '', width: 25 },
    { header: 'SĐT', key: item => item.tenant?.phone || '', width: 15 },
    { header: 'Tòa nhà', key: item => item.room?.building?.name || '', width: 20 },
    { header: 'Căn hộ', key: item => item.room?.name || '', width: 15 },
    { header: 'Ngày bắt đầu', key: item => new Date(item.start_date).toLocaleDateString('vi-VN', { day: '2-digit', month: '2-digit', year: 'numeric' }), width: 15 },
    { header: 'Ngày kết thúc', key: item => new Date(item.end_date).toLocaleDateString('vi-VN', { day: '2-digit', month: '2-digit', year: 'numeric' }), width: 15 },
    { header: 'Giá thuê', key: item => item.rent_price.toLocaleString('vi-VN'), width: 15 },
    { header: 'Tiền cọc', key: item => item.total_deposit.toLocaleString('vi-VN'), width: 15 },
    { header: 'Trạng thái', key: item => {
      const statusMap: Record<string, string> = {
        DRAFT: 'Nháp',
        ACTIVE: 'Đang hoạt động',
        TRANSFERRED: 'Đã chuyển nhượng',
        TERMINATED: 'Đã thanh lý',
        EXPIRED: 'Hết hạn',
      };
      return statusMap[item.status] || item.status;
    }, width: 15 },
  ];

  await exportToExcel(contracts, columns, 'danh-sach-hop-dong', 'Hợp đồng');
}

/**
 * Export Invoices to Excel
 */
export async function exportInvoices(invoices: Array<{
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
}>): Promise<void> {
  const columns: ExportColumn<typeof invoices[0]>[] = [
    { header: 'Số hóa đơn', key: 'invoice_number', width: 20 },
    { header: 'Khách hàng', key: item => item.tenant?.full_name || '', width: 25 },
    { header: 'Căn hộ', key: item => item.room?.name || '', width: 15 },
    { header: 'Kỳ từ', key: item => new Date(item.billing_period_from).toLocaleDateString('vi-VN', { day: '2-digit', month: '2-digit', year: 'numeric' }), width: 15 },
    { header: 'Kỳ đến', key: item => new Date(item.billing_period_to).toLocaleDateString('vi-VN', { day: '2-digit', month: '2-digit', year: 'numeric' }), width: 15 },
    { header: 'Tiền dịch vụ', key: item => item.subtotal.toLocaleString('vi-VN'), width: 15 },
    { header: 'Tổng tiền', key: item => item.total_amount.toLocaleString('vi-VN'), width: 15 },
    { header: 'Đã thanh toán', key: item => item.paid_amount.toLocaleString('vi-VN'), width: 15 },
    { header: 'Còn lại', key: item => (item.total_amount - item.paid_amount).toLocaleString('vi-VN'), width: 15 },
    { header: 'Hạn thanh toán', key: item => new Date(item.due_date).toLocaleDateString('vi-VN', { day: '2-digit', month: '2-digit', year: 'numeric' }), width: 15 },
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

  await exportToExcel(invoices, columns, 'danh-sach-hoa-don', 'Hóa đơn');
}

/**
 * Export Leads to Excel
 */
export async function exportLeads(leads: Array<{
  id: string;
  customer_name: string;
  phone: string | null;
  email: string | null;
  source: string | null;
  status: string;
  appointment_date: string | null;
  notes: string | null;
  created_at: string;
  room?: { name: string; building?: { name: string } };
}>): Promise<void> {
  const sourceMap: Record<string, string> = {
    WEBSITE: 'Website',
    FACEBOOK: 'Facebook',
    ZALO: 'Zalo',
    REFERRAL: 'Giới thiệu',
    WALK_IN: 'Khách đến trực tiếp',
    OTHER: 'Khác',
  };

  const statusMap: Record<string, string> = {
    NEW: 'Mới',
    CONTACTED: 'Đã liên hệ',
    VIEWING_SCHEDULED: 'Đã hẹn xem',
    VIEWED: 'Đã xem căn hộ',
    DEPOSITED: 'Đã cọc',
    CONVERTED: 'Đã chuyển đổi',
    FAILED: 'Thất bại',
  };

  const columns: ExportColumn<typeof leads[0]>[] = [
    { header: 'Tên khách hàng', key: 'customer_name', width: 25 },
    { header: 'Số điện thoại', key: 'phone', width: 15 },
    { header: 'Email', key: 'email', width: 25 },
    { header: 'Nguồn', key: item => sourceMap[item.source || ''] || item.source || '', width: 15 },
    { header: 'Tòa nhà', key: item => item.room?.building?.name || '', width: 20 },
    { header: 'Căn hộ', key: item => item.room?.name || '', width: 15 },
    { header: 'Ngày hẹn', key: item => item.appointment_date ? new Date(item.appointment_date).toLocaleDateString('vi-VN', { day: '2-digit', month: '2-digit', year: 'numeric' }) : '', width: 15 },
    { header: 'Trạng thái', key: item => statusMap[item.status] || item.status, width: 15 },
    { header: 'Ghi chú', key: 'notes', width: 30 },
    { header: 'Ngày tạo', key: item => new Date(item.created_at).toLocaleDateString('vi-VN', { day: '2-digit', month: '2-digit', year: 'numeric' }), width: 15 },
  ];

  await exportToExcel(leads, columns, 'danh-sach-khach-hen', 'Khách hẹn');
}

/**
 * Export Payments to Excel
 */
export async function exportPayments(payments: Array<{
  id: string;
  amount: number;
  payment_date: string;
  payment_method: string | null;
  reference_number: string | null;
  notes: string | null;
  invoice?: {
    invoice_number: string | null;
    contract?: {
      contract_number: string | null;
      tenant?: {
        full_name: string;
        phone: string | null;
      };
    };
  };
}>): Promise<void> {
  const methodMap: Record<string, string> = {
    TM: 'TM',
    TK: 'TK',
    TT: 'TT',
  };

  const columns: ExportColumn<typeof payments[0]>[] = [
    { header: 'Số hóa đơn', key: item => item.invoice?.invoice_number || '', width: 20 },
    { header: 'Khách hàng', key: item => item.invoice?.contract?.tenant?.full_name || '', width: 25 },
    { header: 'SĐT', key: item => item.invoice?.contract?.tenant?.phone || '', width: 15 },
    { header: 'Số tiền', key: item => item.amount.toLocaleString('vi-VN'), width: 15 },
    { header: 'Ngày thanh toán', key: item => new Date(item.payment_date).toLocaleDateString('vi-VN', { day: '2-digit', month: '2-digit', year: 'numeric' }), width: 15 },
    { header: 'Phương thức', key: item => methodMap[item.payment_method || ''] || item.payment_method || '', width: 15 },
    { header: 'Mã giao dịch', key: 'reference_number', width: 20 },
    { header: 'Ghi chú', key: 'notes', width: 30 },
  ];

  await exportToExcel(payments, columns, 'danh-sach-thanh-toan', 'Thanh toán');
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
  // Load xlsx trước khi tạo FileReader — callback closure dùng biến này.
  const XLSX = await getXLSX();

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
    'Số căn hộ': 'total_rooms',
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
    'Mã căn hộ': 'code',
    'Tên căn hộ': 'name',
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
      errors.push({ row, message: 'Thiếu tên căn hộ' });
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
 * Download Contract Import Template (building-specific)
 */
export async function downloadContractImportTemplate(
  buildingName: string,
  rooms: Array<{ name: string }>
): Promise<void> {
  const XLSX = await getXLSX();

  const headers = [
    'Căn hộ (*)', 'Họ tên khách hàng (*)', 'SĐT khách hàng (*)',
    'Ngày ký (*)', 'Ngày bắt đầu (*)', 'Hạn hợp đồng (*)',
    'Tiền thuê (*)', 'Chu kỳ thanh toán', 'Ngày bắt đầu tính tiền',
    'Tiền cọc', 'Đã đặt cọc', 'Ghi chú'
  ];

  const sampleData = [
    {
      'Căn hộ (*)': rooms[0]?.name || 'Căn hộ 101',
      'Họ tên khách hàng (*)': 'Nguyễn Văn A',
      'SĐT khách hàng (*)': '0901234567',
      'Ngày ký (*)': '01/01/2025',
      'Ngày bắt đầu (*)': '01/01/2025',
      'Hạn hợp đồng (*)': '01/01/2026',
      'Tiền thuê (*)': 3500000,
      'Chu kỳ thanh toán': '1 tháng',
      'Ngày bắt đầu tính tiền': '01/01/2025',
      'Tiền cọc': 3500000,
      'Đã đặt cọc': 0,
      'Ghi chú': '',
    },
  ];

  if (rooms.length > 1) {
    sampleData.push({
      'Căn hộ (*)': rooms[1]?.name || 'Căn hộ 102',
      'Họ tên khách hàng (*)': 'Trần Thị B',
      'SĐT khách hàng (*)': '0909876543',
      'Ngày ký (*)': '15/01/2025',
      'Ngày bắt đầu (*)': '15/01/2025',
      'Hạn hợp đồng (*)': '15/01/2026',
      'Tiền thuê (*)': 4000000,
      'Chu kỳ thanh toán': '1 tháng',
      'Ngày bắt đầu tính tiền': '15/01/2025',
      'Tiền cọc': 4000000,
      'Đã đặt cọc': 4000000,
      'Ghi chú': '',
    });
  }

  const worksheet = XLSX.utils.json_to_sheet(sampleData);

  // Set column widths
  worksheet['!cols'] = [
    { wch: 15 }, { wch: 25 }, { wch: 15 },
    { wch: 15 }, { wch: 15 }, { wch: 15 },
    { wch: 15 }, { wch: 18 }, { wch: 20 },
    { wch: 15 }, { wch: 12 }, { wch: 25 },
  ];

  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, worksheet, 'Mẫu hợp đồng');

  // Add a reference sheet with room names
  const roomsRef = rooms.map(r => ({ 'Danh sách căn hộ': r.name }));
  const roomsSheet = XLSX.utils.json_to_sheet(roomsRef);
  XLSX.utils.book_append_sheet(workbook, roomsSheet, 'Danh sách căn hộ');

  XLSX.writeFile(workbook, `mau-hop-dong-${buildingName.replace(/\s+/g, '-')}.xlsx`);
}

/**
 * Import Contracts from Excel
 */
export interface ContractImportRow {
  room_name: string;
  tenant_name: string;
  tenant_phone: string;
  signed_date: string;
  start_date: string;
  end_date: string;
  rent_price: number;
  payment_cycle?: string;
  start_billing_date?: string;
  total_deposit?: number;
  deposit_paid?: number;
  notes?: string;
}

export async function importContracts(
  file: File
): Promise<ImportResult<ContractImportRow>> {
  const headerMapping = {
    'Căn hộ (*)': 'room_name',
    'Họ tên khách hàng (*)': 'tenant_name',
    'SĐT khách hàng (*)': 'tenant_phone',
    'Ngày ký (*)': 'signed_date',
    'Ngày bắt đầu (*)': 'start_date',
    'Hạn hợp đồng (*)': 'end_date',
    'Tiền thuê (*)': 'rent_price',
    'Chu kỳ thanh toán': 'payment_cycle',
    'Ngày bắt đầu tính tiền': 'start_billing_date',
    'Tiền cọc': 'total_deposit',
    'Đã đặt cọc': 'deposit_paid',
    'Ghi chú': 'notes',
  } as const;

  const data = await parseExcelFile<ContractImportRow>(file, headerMapping as any);

  const success: ContractImportRow[] = [];
  const errors: Array<{ row: number; message: string }> = [];

  // Helper to parse dd/MM/yyyy date strings to yyyy-MM-dd
  const parseDate = (value: any): string | null => {
    if (!value) return null;
    const str = String(value).trim();

    // Try dd/MM/yyyy format
    const match = str.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
    if (match) {
      const [, day, month, year] = match;
      return `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
    }

    // Try yyyy-MM-dd format (already correct)
    if (/^\d{4}-\d{2}-\d{2}$/.test(str)) return str;

    // Try Excel serial date (number)
    if (!isNaN(Number(str)) && Number(str) > 30000) {
      const date = new Date((Number(str) - 25569) * 86400 * 1000);
      return date.toISOString().split('T')[0];
    }

    return null;
  };

  const parseAmount = (value: any): number => {
    if (typeof value === 'number') return value;
    if (!value) return 0;
    return Number(String(value).replace(/\./g, '').replace(/,/g, ''));
  };

  const parseCycle = (value: any): string => {
    if (!value) return 'MONTHLY';
    const str = String(value).trim().toLowerCase();
    if (str.includes('3') || str.includes('quý')) return 'QUARTERLY';
    if (str.includes('6')) return 'SEMI_ANNUAL';
    if (str.includes('năm') || str.includes('12')) return 'ANNUAL';
    return 'MONTHLY';
  };

  data.forEach((item, index) => {
    const row = index + 2;

    // Validate required fields
    if (!item.room_name) {
      errors.push({ row, message: 'Thiếu tên căn hộ' });
      return;
    }
    if (!item.tenant_name) {
      errors.push({ row, message: 'Thiếu họ tên khách hàng' });
      return;
    }
    if (!item.tenant_phone) {
      errors.push({ row, message: 'Thiếu số điện thoại khách hàng' });
      return;
    }

    const signedDate = parseDate(item.signed_date);
    const startDate = parseDate(item.start_date);
    const endDate = parseDate(item.end_date);

    if (!signedDate) {
      errors.push({ row, message: 'Ngày ký không hợp lệ' });
      return;
    }
    if (!startDate) {
      errors.push({ row, message: 'Ngày bắt đầu không hợp lệ' });
      return;
    }
    if (!endDate) {
      errors.push({ row, message: 'Hạn hợp đồng không hợp lệ' });
      return;
    }

    const rentPrice = parseAmount(item.rent_price);
    if (!rentPrice || isNaN(rentPrice)) {
      errors.push({ row, message: 'Tiền thuê không hợp lệ' });
      return;
    }

    success.push({
      room_name: String(item.room_name).trim(),
      tenant_name: String(item.tenant_name).trim(),
      tenant_phone: String(item.tenant_phone).trim(),
      signed_date: signedDate,
      start_date: startDate,
      end_date: endDate,
      rent_price: rentPrice,
      payment_cycle: parseCycle(item.payment_cycle),
      start_billing_date: parseDate(item.start_billing_date) || startDate,
      total_deposit: parseAmount(item.total_deposit),
      deposit_paid: parseAmount(item.deposit_paid),
      notes: item.notes ? String(item.notes) : undefined,
    });
  });

  return { success, errors };
}

/**
 * Generate sample Excel template for import
 */
export async function downloadImportTemplate(type: 'buildings' | 'rooms' | 'tenants'): Promise<void> {
  const XLSX = await getXLSX();

  let headers: string[] = [];
  let sampleData: any[] = [];

  switch (type) {
    case 'buildings':
      headers = ['Mã tòa nhà', 'Tên tòa nhà', 'Loại', 'Tỉnh/TP', 'Quận/Huyện', 'Phường/Xã', 'Địa chỉ', 'Số tầng', 'Số căn hộ'];
      sampleData = [
        { 'Mã tòa nhà': 'TN001', 'Tên tòa nhà': 'Tòa nhà ABC', 'Loại': 'Nhà trọ', 'Tỉnh/TP': 'Hồ Chí Minh', 'Quận/Huyện': 'Quận 1', 'Phường/Xã': 'Phường Bến Nghé', 'Địa chỉ': '123 Nguyễn Huệ', 'Số tầng': 5, 'Số căn hộ': 20 },
        { 'Mã tòa nhà': 'TN002', 'Tên tòa nhà': 'Tòa nhà XYZ', 'Loại': 'Chung cư', 'Tỉnh/TP': 'Hồ Chí Minh', 'Quận/Huyện': 'Quận 7', 'Phường/Xã': 'Phường Tân Phong', 'Địa chỉ': '456 Nguyễn Thị Thập', 'Số tầng': 10, 'Số căn hộ': 50 },
      ];
      break;
    case 'rooms':
      headers = ['Tòa nhà', 'Mã căn hộ', 'Tên căn hộ', 'Tầng', 'Diện tích (m²)', 'Giá thuê', 'Tiền cọc', 'Số người tối đa'];
      sampleData = [
        { 'Tòa nhà': 'Tòa nhà ABC', 'Mã căn hộ': 'P101', 'Tên căn hộ': 'Căn hộ 101', 'Tầng': 1, 'Diện tích (m²)': 25, 'Giá thuê': 3500000, 'Tiền cọc': 3500000, 'Số người tối đa': 2 },
        { 'Tòa nhà': 'Tòa nhà ABC', 'Mã căn hộ': 'P102', 'Tên căn hộ': 'Căn hộ 102', 'Tầng': 1, 'Diện tích (m²)': 30, 'Giá thuê': 4000000, 'Tiền cọc': 4000000, 'Số người tối đa': 3 },
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

/**
 * Download Meter Reading Import Template
 * Columns: Mã công tơ, Ngày chốt, Chỉ số mới, Ghi chú
 */
export async function downloadMeterReadingImportTemplate(): Promise<void> {
  const XLSX = await getXLSX();

  const sampleData = [
    {
      'Mã công tơ (*)': 'CTD-201',
      'Ngày chốt (*)': '2025-01-15',
      'Chỉ số mới (*)': 1250,
      'Ghi chú': 'Ghi chú mẫu',
    },
    {
      'Mã công tơ (*)': 'CTN-201',
      'Ngày chốt (*)': '2025-01-15',
      'Chỉ số mới (*)': 85,
      'Ghi chú': '',
    },
  ];

  const worksheet = XLSX.utils.json_to_sheet(sampleData);

  worksheet['!cols'] = [
    { wch: 20 },
    { wch: 15 },
    { wch: 15 },
    { wch: 30 },
  ];

  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, worksheet, 'Mẫu chỉ số');

  XLSX.writeFile(workbook, 'mau-chi-so-cong-to.xlsx');
}

/**
 * Parse Meter Reading Excel file
 * Maps Vietnamese headers to field names expected by excelImportRowSchema
 */
export async function parseMeterReadingExcel(
  file: File
): Promise<Array<{ meter_code: string; reading_date: string; current_reading: number; notes?: string }>> {
  const headerMapping = {
    'Mã công tơ (*)': 'meter_code' as const,
    'Ngày chốt (*)': 'reading_date' as const,
    'Chỉ số mới (*)': 'current_reading' as const,
    'Ghi chú': 'notes' as const,
  };

  return parseExcelFile(file, headerMapping as any);
}
