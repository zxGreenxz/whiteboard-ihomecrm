// =============================================
// Contract Module Types
// =============================================

// Enums
export type ContractStatus = 'DRAFT' | 'ACTIVE' | 'EXTENDED' | 'TRANSFERRED' | 'TERMINATED' | 'EXPIRED';
export type PaymentCycle = 'MONTHLY' | 'QUARTERLY' | 'SEMI_ANNUAL' | 'ANNUAL';
export type ContractStatFilter = 'ALL' | 'EXPIRING' | 'EXPIRED' | 'TERMINATED';

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
  bed_id: string | null;
  tenant_id: string;
  contract_number: string | null;
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
      area_id: string | null;
    } | null;
  } | null;
  bed?: {
    id: string;
    name: string;
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
  customer?: {
    id: string;
    full_name: string;
    phone: string;
    id_number: string | null;
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
  area_id?: string;
  building_id?: string;
  room_id?: string;
  bed_id?: string;
  rental_type?: string;  // building type
  month?: string;        // 'YYYY-MM'
}

// Form data
export interface ContractFormData {
  room_id: string;
  bed_id?: string | null;
  signed_date: string;
  start_date: string;
  end_date: string;
  rent_price: number;
  total_deposit: number;
  deposit_paid?: number;
  payment_cycle: PaymentCycle;
  start_billing_date?: string;
  contract_template_id?: string | null;
  invoice_template_id?: string | null;
  notes?: string;
  discount_months?: number;
  discount_amount_per_month?: number;
  customers: { customer_id: string; is_representative: boolean }[];
  services: { service_id: string; unit_price: number; initial_reading?: number }[];
}

// Helper: compute display status
export function getContractDisplayStatus(contract: Contract): ContractDisplayStatus {
  if (contract.status === 'TERMINATED') return 'TERMINATED';
  if (contract.status === 'TRANSFERRED') return 'TRANSFERRED';
  if (contract.status === 'DRAFT') return 'DRAFT';
  if (contract.expected_move_out_date) return 'MOVING_OUT';

  const now = new Date();
  const endDate = new Date(contract.end_date);
  const daysUntilEnd = Math.ceil((endDate.getTime() - now.getTime()) / (1000 * 60 * 60 * 24));

  if (daysUntilEnd < 0) return 'EXPIRED';
  if (daysUntilEnd <= 30) return 'EXPIRING';
  return 'ACTIVE';
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

// Payment cycle labels
export const PAYMENT_CYCLE_LABELS: Record<PaymentCycle, string> = {
  MONTHLY: '1 tháng',
  QUARTERLY: '3 tháng',
  SEMI_ANNUAL: '6 tháng',
  ANNUAL: '12 tháng',
};