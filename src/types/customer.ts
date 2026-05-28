// =============================================
// Customer Module Types
// Standalone types for the reimplemented customer module
// Matches database schema: supabase/migrations/20250701000001_customer_vehicle_reimplementation.sql
// =============================================

// =============================================
// Enums
// =============================================

export type CustomerType = 'INDIVIDUAL' | 'ORGANIZATION';
export type CustomerStatus = 'RENTING' | 'MOVED_OUT' | 'WALK_IN';
export type StatFilterType = 'ALL' | 'INDIVIDUAL' | 'ORGANIZATION' | 'FOREIGN';

// =============================================
// Core Entity
// =============================================

/** Matches `customers` table */
export interface Customer {
  id: string;
  user_id: string;
  customer_type: CustomerType;
  full_name: string;
  phone: string;
  email: string | null;
  date_of_birth: string | null;
  gender: string | null;
  id_number: string | null;
  id_issue_date: string | null;
  id_issue_place: string | null;
  province: string | null;
  district: string | null;
  ward: string | null;
  detailed_address: string | null;
  current_residence: string | null;
  permanent_address: string | null;
  bank_account_number: string | null;
  bank_name: string | null;
  occupation: string | null;
  workplace: string | null;
  contact_person: string | null;
  contact_person_phone: string | null;
  advisor: string | null;
  advisor_phone: string | null;
  fingerprint_code: string | null;
  customer_group: string | null;
  is_foreign: boolean;
  status_v2: CustomerStatus;
  notes: string | null;
  avatar_url: string | null;
  id_images: Record<string, string> | null; // { front, back, passport }
  // Organization fields
  company_name: string | null;
  tax_code: string | null;
  representative: string | null;
  business_registration_url: string | null;
  headquarters_address: string | null;
  // Timestamps
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

// =============================================
// Filters & Stats
// =============================================

/** Filter parameters for querying customers */
export interface CustomerFilters {
  status?: CustomerStatus;
  statFilter?: StatFilterType;
  area_id?: string;
  building_id?: string;
  room_id?: string;
  search?: string;
}

/** Computed stats for customer summary cards */
export interface CustomerStats {
  total: number;
  individual: number;
  organization: number;
  foreign: number;
}

// =============================================
// Form Data
// =============================================

/** Form data shape for react-hook-form (create/edit customer) */
export interface CustomerFormData {
  customer_type: CustomerType;
  full_name: string;
  phone: string;
  email?: string;
  date_of_birth?: string;
  gender?: string;
  id_number?: string;
  id_issue_date?: string;
  id_issue_place?: string;
  is_foreign: boolean;
  province?: string;
  district?: string;
  ward?: string;
  detailed_address?: string;
  current_residence?: string;
  permanent_address?: string;
  bank_account_number?: string;
  bank_name?: string;
  occupation?: string;
  workplace?: string;
  contact_person?: string;
  contact_person_phone?: string;
  advisor?: string;
  advisor_phone?: string;
  fingerprint_code?: string;
  customer_group?: string;
  notes?: string;
  avatar_url?: string;
  id_images?: Record<string, string>;
  // Organization
  company_name?: string;
  tax_code?: string;
  representative?: string;
  business_registration_url?: string;
  headquarters_address?: string;
  // Inline vehicles
  vehicles?: InlineVehicle[];
}

export interface InlineVehicle {
  vehicle_type: string;
  vehicle_name: string;
  license_plate: string;
}

// =============================================
// CT01 Declaration
// =============================================

/** Matches `ct01_declarations` table */
export interface CT01Declaration {
  id: string;
  user_id: string;
  customer_id: string;
  registration_authority: string;
  full_name: string;
  date_of_birth: string;
  gender: string;
  id_number: string;
  phone: string | null;
  email: string | null;
  permanent_address: string | null;
  temporary_address: string | null;
  current_address: string | null;
  occupation_workplace: string | null;
  household_head_name: string | null;
  household_head_relationship: string | null;
  household_head_id_number: string | null;
  request_content: string | null;
  family_members: CT01FamilyMember[];
  created_at: string;
  updated_at: string;
}

export interface CT01FamilyMember {
  full_name: string;
  date_of_birth: string;
  gender: string;
  id_number: string;
  occupation_workplace: string;
  relationship_to_declarant: string;
  relationship_to_household_head: string;
}

/** Form data shape for CT01 form */
export interface CT01FormData {
  registration_authority: string;
  full_name: string;
  date_of_birth: string;
  gender: string;
  id_number: string;
  phone?: string;
  email?: string;
  permanent_address?: string;
  temporary_address?: string;
  current_address?: string;
  occupation_workplace?: string;
  household_head_name?: string;
  household_head_relationship?: string;
  household_head_id_number?: string;
  request_content?: string;
  family_members: CT01FamilyMember[];
}
