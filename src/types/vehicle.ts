// =============================================
// Vehicle Module Types
// Standalone types for the reimplemented vehicle module
// Matches database schema: supabase/migrations/20250701000001_customer_vehicle_reimplementation.sql
// =============================================

// =============================================
// Enums
// =============================================

export type VehicleType = 'MOTORBIKE' | 'CAR' | 'BICYCLE' | 'ELECTRIC_BIKE' | 'OTHER';

// =============================================
// Core Entity
// =============================================

/** Matches `vehicles` table */
export interface Vehicle {
  id: string;
  user_id: string;
  customer_id: string | null;
  tenant_id: string | null; // legacy, kept for backward compat
  vehicle_type: VehicleType;
  vehicle_name: string | null;
  license_plate: string | null;
  color: string | null;
  owner_name: string | null;
  ticket_number: string | null;
  building_id: string | null;
  room_id: string | null;
  image_url: string | null;
  parking_fee: number | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

/** Vehicle with joined relations for detail/list views */
export interface VehicleWithRelations extends Vehicle {
  customer?: {
    id: string;
    full_name: string;
    phone: string | null;
  } | null;
  building?: {
    id: string;
    name: string;
  } | null;
  room?: {
    id: string;
    name: string;
  } | null;
}

// =============================================
// Filters
// =============================================

/** Filter parameters for querying vehicles */
export interface VehicleFilters {
  search?: string;
  vehicle_type?: VehicleType;
  building_id?: string;
  room_id?: string;
  customer_id?: string;
  contract_id?: string;
  vehicle_name?: string;
  color?: string;
}

// =============================================
// Form Data
// =============================================

/** Form data shape for react-hook-form (create/edit vehicle) */
export interface VehicleFormData {
  vehicle_type: VehicleType;
  vehicle_name: string;
  color: string;
  license_plate: string;
  owner_name: string;
  ticket_number?: string;
  building_id?: string;
  room_id?: string;
  customer_id?: string;
  image_url?: string;
}

// =============================================
// Excel Import
// =============================================

/** Row shape when importing vehicles from Excel */
export interface VehicleImportRow {
  vehicle_type: string;
  vehicle_name: string;
  color: string;
  license_plate: string;
  owner_name: string;
  ticket_number?: string;
  building_name?: string;
  room_name?: string;
  customer_name?: string;
}
