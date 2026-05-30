// =============================================
// Building Module Types
// Standalone types for the reimplemented building module
// Matches database schema: supabase/migrations/20250703000001_building_room_reimplementation.sql
// =============================================

// =============================================
// Enums
// =============================================

export type BuildingStatus = 'ACTIVE' | 'INACTIVE';

// =============================================
// Commission tiers
// =============================================

/** Một bậc hoa hồng môi giới: số tháng HĐ trong [min, max] thì tính rate% tiền phòng */
export interface CommissionTier {
  min_months: number;
  max_months: number;
  rate_percent: number;
}

export const DEFAULT_COMMISSION_TIERS: CommissionTier[] = [
  { min_months: 5, max_months: 6, rate_percent: 50 },
  { min_months: 10, max_months: 12, rate_percent: 60 },
];

// =============================================
// Core Entity
// =============================================

/** Matches `buildings` table */
export interface Building {
  id: string;
  user_id: string;
  area_id: string | null;
  name: string;
  code: string | null;
  type: string;
  status: BuildingStatus;
  province: string;
  district: string;
  ward: string;
  street_address: string | null;
  total_floors: number;
  total_rooms: number;
  description: string | null;
  images: any;
  amenities: any;
  commission_tiers: CommissionTier[];
  /** Sổ quỹ mặc định khi thanh toán hoá đơn phòng = TT (POS) cho toà này. */
  default_account_id_tt: string | null;
  /** Sổ quỹ mặc định khi thanh toán hoá đơn phòng = TK (chuyển khoản) cho toà này. */
  default_account_id_tk: string | null;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

/** Building with joined area and computed rooms count */
export interface BuildingWithRelations extends Building {
  area?: { id: string; name: string; code: string | null } | null;
  rooms_count?: number;
}

// =============================================
// Building Services (junction table)
// =============================================

/** Matches `building_services` table */
export interface BuildingService {
  id: string;
  building_id: string;
  service_id: string;
  is_active: boolean;
  unit_price_override: number | null;
  created_at: string;
  updated_at: string;
}

/** BuildingService with joined service details */
export interface BuildingServiceWithDetails extends BuildingService {
  service: {
    id: string;
    name: string;
    unit_price: number;
    unit: string | null;
    type?: string | null;
    pricing_type?: string | null;
  };
}

// =============================================
// Form Data
// =============================================

/** Form data shape for react-hook-form (create/edit building) */
export interface BuildingFormData {
  name: string;
  code?: string;
  province: string;
  district: string;
  ward: string;
  street_address: string;
  area_id?: string;
  status: BuildingStatus;
  contract_template_id?: string | null;
  invoice_template_id?: string | null;
  commission_tiers?: CommissionTier[];
  default_account_id_tt?: string | null;
  default_account_id_tk?: string | null;
}

/** Form data shape for building service rows in the services table */
export interface BuildingServiceFormData {
  service_id: string;
  service_name: string;
  is_active: boolean;
  unit_price_override: number | null;
  default_unit_price: number;
}
