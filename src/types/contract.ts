import type { SupportPlanInput } from '@/lib/rentSupport';
// =============================================
// Contract Module Types
// =============================================

// Enums
// Lưu ý: 'EXTENDED' là giá trị NGƯNG DÙNG (deprecated) — không còn gán cho HĐ nữa.
// "Đã gia hạn" giờ suy từ bảng contract_extensions (xem useRenewedContractIds), KHÔNG từ status.
// Giữ trong union để tương thích enum DB; mọi check "còn hiệu lực" chỉ xét 'ACTIVE'.
export type ContractStatus = 'DRAFT' | 'ACTIVE' | 'EXTENDED' | 'TRANSFERRED' | 'TERMINATED' | 'EXPIRED';
export type PaymentCycle = 'MONTHLY' | 'QUARTERLY' | 'SEMI_ANNUAL' | 'ANNUAL';
export type ContractStatFilter = 'ALL' | 'EXPIRING' | 'EXPIRED' | 'TERMINATED';
// Trạng thái vòng đời hợp đồng: ALL = tất cả, ACTIVE = đang ở (tất cả trừ thanh lý), TERMINATED = đã thanh lý
export type ContractLifecycleFilter = 'ALL' | 'ACTIVE' | 'TERMINATED';

// Computed display status (includes derived statuses)
export type ContractDisplayStatus =
  | 'ACTIVE'        // Còn hạn (green)
  | 'EXPIRING'      // Sắp hết hạn — within 30 days (orange)
  | 'EXPIRED'       // Quá hạn (red)
  | 'MOVING_OUT'    // Sắp chuyển đi — has expected_move_out_date (orange)
  | 'TERMINATED'    // Đã thanh lý (gray)
  | 'TRANSFERRED'   // Đã nhượng (gray)
  | 'DRAFT';        // Nháp (gray)

// Core entity
export interface Contract {
  id: string;
  user_id: string;
  room_id: string | null;
  tenant_id: string;
  contract_number: string | null;
  /** Mã ngắn ngẫu nhiên (6 ký tự) dùng cho link QR công khai: /c/<public_code>. */
  public_code: string;
  signed_date: string;
  start_date: string;
  end_date: string;
  actual_end_date: string | null;
  expected_move_out_date: string | null;
  rent_price: number;
  total_deposit: number;
  deposit_paid: number | null;
  deposit_remaining: number | null;
  payment_cycle: PaymentCycle | null;
  start_billing_date: string | null;
  end_billing_date: string | null;
  contract_template_id: string | null;
  invoice_template_id: string | null;
  contract_file_url: string | null;
  parent_contract_id: string | null;
  initial_electricity_reading: number | null;
  initial_water_reading: number | null;
  discounts: { months: number; amount_per_month: number } | null;
  notes: string | null;
  status: ContractStatus;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}


// Contract with joined relations
export interface ContractWithRelations extends Contract {
  room?: {
    id: string;
    name: string;
    building_id: string;
    building?: {
      id: string;
      name: string;
      type: string;
      street_address?: string | null;
      ward?: string | null;
      district?: string | null;
      province?: string | null;
    } | null;
  } | null;
  contract_customers?: ContractCustomer[];
  contract_services?: ContractServiceWithDetails[];
}

// Junction table: contract ↔ customer
export interface ContractCustomer {
  id: string;
  contract_id: string;
  customer_id: string;
  is_representative: boolean;
  notes: string | null;
  customer?: {
    id: string;
    full_name: string;
    phone: string;
    email: string | null;
    id_number: string | null;
    /** Ảnh giấy tờ: { front?, back?, passport? } — JSON tự do trong DB. */
    id_images?: unknown;
    // Các trường dưới đây đã nằm sẵn trong select của `useContract`; khai ra để
    // khối thông tin giấy tờ (CccdDialog) dùng được mà không phải ép kiểu.
    date_of_birth?: string | null;
    gender?: string | null;
    id_issue_date?: string | null;
    id_issue_place?: string | null;
    permanent_address?: string | null;
    detailed_address?: string | null;
    current_residence?: string | null;
  } | null;
  created_at: string;
  updated_at: string;
}

// Contract service with service details
export interface ContractServiceWithDetails {
  id: string;
  contract_id: string;
  service_id: string;
  unit_price: number;
  initial_reading: number | null;
  service?: {
    id: string;
    name: string;
    unit: string | null;
    type: string;
    pricing_type: string | null;
  } | null;
  created_at: string;
  updated_at: string;
}

// Stats
export interface ContractStats {
  total: number;
  expiring: number;
  expired: number;
  terminated: number;
}

// Filters
export interface ContractFilters {
  statFilter?: ContractStatFilter;
  search?: string;
  building_id?: string;
  room_id?: string;
  rental_type?: string;  // building type
  month?: string;        // 'YYYY-MM'
}

// Form data
export interface ContractFormData {
  rent_support?: SupportPlanInput;
  room_id: string;
  signed_date: string;
  start_date: string;
  end_date: string;
  rent_price: number;
  total_deposit: number;
  deposit_paid?: number;
  payment_cycle: PaymentCycle;
  start_billing_date?: string;
  end_billing_date?: string;
  contract_template_id?: string | null;
  invoice_template_id?: string | null;
  notes?: string;
  discount_months?: number;
  discount_amount_per_month?: number;
  customers: { customer_id: string; is_representative: boolean; notes?: string | null }[];
  services: { service_id: string; unit_price: number; initial_reading?: number }[];
}

// Trạng thái hợp đồng "đang hiệu lực" (đang ở / còn tính tiền / còn thao tác được).
// CHỈ là 'ACTIVE'. HĐ gia hạn vẫn giữ 'ACTIVE' (không chuyển EXTENDED nữa) — "đã gia
// hạn" là dấu hiệu RIÊNG suy từ contract_extensions, không liên quan tới "còn hiệu lực".
export const ACTIVE_CONTRACT_STATUSES: ContractStatus[] = ['ACTIVE'];

/** True nếu hợp đồng đang hiệu lực (chỉ 'ACTIVE'). */
export function isContractInEffect(status?: string | null): boolean {
  return status === 'ACTIVE';
}

// hermes-parity:begin contract-search — Hermes chép vùng này, xem infra/hermes-broker/web-parity.json
// Nhãn hiển thị — CÙNG công thức với public.contract_display_status_v1 (SQL) và cùng mốc ngày
// org_today_v1 (múi giờ công ty, mặc định Asia/Ho_Chi_Minh, không đổi giờ mùa hè ⇒ UTC+7 cố
// định). Danh sách/thống kê đọc nhãn do SQL tính; màn chi tiết và ghi chú phiếu tính tại chỗ
// bằng đúng hàm dưới — khoá bằng contractListV1Migration.test.ts (JS = SQL mọi giờ trong ngày).
const VN_UTC_OFFSET_MS = 7 * 3_600_000;
const DAY_MS = 86_400_000;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Hôm nay theo giờ Việt Nam, dạng YYYY-MM-DD. */
export function vnTodayISO(nowMs: number = Date.now()): string {
  return new Date(nowMs + VN_UTC_OFFSET_MS).toISOString().slice(0, 10);
}

/** Nhãn theo một ngày mốc cho trước (YYYY-MM-DD) — dùng khi "hôm nay" do server cấp. */
export function contractDisplayStatusOn(
  contract: Pick<Contract, 'status' | 'end_date' | 'expected_move_out_date'>,
  todayISO: string,
): ContractDisplayStatus {
  if (contract.status === 'TERMINATED') return 'TERMINATED';
  if (contract.status === 'TRANSFERRED') return 'TRANSFERRED';
  if (contract.status === 'DRAFT') return 'DRAFT';
  if (contract.expected_move_out_date) return 'MOVING_OUT';
  // Thiếu/hỏng ngày (end_date hoặc mốc) ⇒ 'ACTIVE', như SQL so với NULL rơi xuống ELSE.
  const end = typeof contract.end_date === 'string' ? contract.end_date.slice(0, 10) : '';
  if (!ISO_DATE.test(end) || !ISO_DATE.test(todayISO)) return 'ACTIVE';
  if (end < todayISO) return 'EXPIRED';
  const in30 = new Date(Date.parse(`${todayISO}T00:00:00Z`) + 30 * DAY_MS).toISOString().slice(0, 10);
  if (end <= in30) return 'EXPIRING';
  return 'ACTIVE';
}

// Hàng danh sách đọc từ contract_list_v1 đã mang nhãn SQL ⇒ dùng lại nguyên nhãn đó.
export function getContractDisplayStatus(contract: Contract & { display_status?: ContractDisplayStatus }): ContractDisplayStatus {
  if (contract.display_status) return contract.display_status;
  return contractDisplayStatusOn(contract, vnTodayISO());
}

// Helper: status badge config
export const CONTRACT_STATUS_CONFIG: Record<ContractDisplayStatus, { label: string; color: string }> = {
  ACTIVE: { label: 'Còn hạn', color: 'bg-green-100 text-green-800' },
  EXPIRING: { label: 'Sắp hết hạn', color: 'bg-orange-100 text-orange-800' },
  EXPIRED: { label: 'Quá hạn', color: 'bg-red-100 text-red-800' },
  MOVING_OUT: { label: 'Sắp chuyển đi', color: 'bg-orange-100 text-orange-800' },
  TERMINATED: { label: 'Đã thanh lý', color: 'bg-gray-100 text-gray-800' },
  TRANSFERRED: { label: 'Đã nhượng', color: 'bg-gray-100 text-gray-600' },
  DRAFT: { label: 'Nháp', color: 'bg-gray-100 text-gray-500' },
};
// hermes-parity:end contract-search

// Payment cycle labels
export const PAYMENT_CYCLE_LABELS: Record<PaymentCycle, string> = {
  MONTHLY: '1 tháng',
  QUARTERLY: '3 tháng',
  SEMI_ANNUAL: '6 tháng',
  ANNUAL: '12 tháng',
};