// =============================================
// Customer Module Types
// Standalone types for the reimplemented customer module
// Matches database schema: supabase/migrations/20250701000001_customer_vehicle_reimplementation.sql
// =============================================

// =============================================
// Enums
// =============================================

export type CustomerType = 'INDIVIDUAL' | 'ORGANIZATION';
/** Khớp enum `id_type` trong DB — xem `Database['public']['Enums']['id_type']`. */
export type IdType = 'CCCD' | 'CMND' | 'PASSPORT' | 'OTHER';
/**
 * BẪY TÊN: đây là enum `customer_status_v2` của DB (cột `status_v2`), KHÔNG
 * phải cột `status`. Bảng `customers` mang cả hai cột với hai enum khác nhau.
 */
export type CustomerStatus = 'RENTING' | 'MOVED_OUT' | 'WALK_IN';
/** Enum `customer_status` của DB — cột `status` (cũ, vẫn còn và vẫn được ghi). */
export type CustomerStatusV1 = 'PROSPECT' | 'ACTIVE' | 'INACTIVE' | 'BLACKLIST';
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
  /**
   * Liên hệ khẩn cấp — CÓ trong database (bảng `customers`), thiếu ở kiểu viết tay
   * này cho tới 11/08/2026.
   *
   * Hệ quả đã đo: CustomerDetailPage đọc ba trường này để hiển thị mục "Liên hệ
   * khẩn cấp", nhưng TypeScript báo lỗi và ts-baseline đã nuốt cả 5 lỗi thành nợ
   * đã biết. Dữ liệu vẫn về từ server (select không liệt kê cột nên lấy tất), nên
   * màn hình VẪN hiện đúng — chỉ là không ai kiểm được kiểu của nó nữa.
   */
  emergency_contact_name: string | null;
  emergency_contact_phone: string | null;
  emergency_contact_relationship: string | null;
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

/**
 * Form data shape for react-hook-form (create/edit customer).
 *
 * VÌ SAO MỌI TRƯỜNG TUỲ CHỌN ĐỀU NHẬN `| null` (11/08/2026)
 *   Bảng `customers` trả `null` cho mọi cột nullable, và `CreateCustomerDialog`
 *   đổ THẲNG bản ghi DB vào `reset()`. Khai `?: string` nghĩa là
 *   `string | undefined` — mô tả SAI thứ thật sự chạy qua kiểu này. Đo được:
 *   29 lỗi `Type 'string | null' is not assignable to type 'string | undefined'`
 *   ở đúng một lời gọi `reset()`, và cùng mẫu đó chiếm 176/360 lỗi của cả app
 *   khi bật `strictNullChecks`.
 *
 *   Cách chữa KHÔNG phải rắc `?? undefined` ở 29 chỗ gọi: đó là bẻ dữ liệu cho
 *   vừa một cái kiểu sai. react-hook-form nhận `null` bình thường (ô nhập vốn
 *   đã dùng `field.value ?? ''`), nên `| null` mới là mô tả đúng.
 */
export interface CustomerFormData {
  customer_type: CustomerType;
  full_name: string;
  phone: string;
  email?: string | null;
  date_of_birth?: string | null;
  gender?: string | null;
  // Cột `customers.id_type` CÓ THẬT trong DB (enum), chỉ thiếu ở kiểu viết tay
  // này — nên `CreateCustomerDialog` gửi nó xuống mà TypeScript kêu. Cùng vết
  // với `emergency_contact_*` đã vá trước đó: kiểu tay tụt lại sau schema.
  id_type?: IdType | null;
  id_number?: string | null;
  id_issue_date?: string | null;
  id_issue_place?: string | null;
  // Bốn trường dưới đây CÓ THẬT trong bảng `customers` và `CreateCustomerDialog`
  // vẫn gửi chúng xuống — chỉ kiểu viết tay này là thiếu. Đã có ở interface
  // `Customer` phía trên từ lô trước, nhưng lô đó bỏ sót `CustomerFormData`,
  // mà chính kiểu này mới là thứ đường ghi đi qua.
  emergency_contact_name?: string | null;
  emergency_contact_phone?: string | null;
  emergency_contact_relationship?: string | null;
  status?: CustomerStatusV1 | null;
  is_foreign: boolean;
  province?: string | null;
  district?: string | null;
  ward?: string | null;
  detailed_address?: string | null;
  current_residence?: string | null;
  permanent_address?: string | null;
  bank_account_number?: string | null;
  bank_name?: string | null;
  occupation?: string | null;
  workplace?: string | null;
  contact_person?: string | null;
  contact_person_phone?: string | null;
  advisor?: string | null;
  advisor_phone?: string | null;
  fingerprint_code?: string | null;
  customer_group?: string | null;
  notes?: string | null;
  avatar_url?: string | null;
  id_images?: Record<string, string> | null;
  // Organization
  company_name?: string | null;
  representative?: string | null;
  business_registration_url?: string | null;
  headquarters_address?: string | null;
  // Inline vehicles
  vehicles?: InlineVehicle[] | null;
}

export interface InlineVehicle {
  /** Có id = xe đã tồn tại (chế độ sửa); không id = dòng mới thêm. */
  id?: string;
  vehicle_type: string;
  vehicle_name: string;
  color?: string;
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
