// =============================================
// Invoice Module Types
// Standalone types for the reimplemented invoice module
// Matches database schema: supabase/migrations/20250601000001_invoice_reimplementation.sql
// =============================================

// =============================================
// Enums
// =============================================

export type InvoiceStatus =
  | 'DRAFT'
  | 'APPROVED'
  | 'PAID'
  | 'PARTIAL_PAID'
  | 'OVERDUE'
  | 'CANCELLED';

export type InvoiceItemType =
  | 'RENT'
  | 'SERVICE'
  | 'PENALTY'
  | 'DISCOUNT'
  | 'OTHER';

export type PaymentMethod = 'TM' | 'TK' | 'TT';

// =============================================
// Core Entities (matching database tables)
// =============================================

/**
 * Một nguồn nợ cũ được cộng vào previous_debt của HĐ mới.
 * - type='invoice': remaining của HĐ cũ. Trigger DB sẽ tự mark HĐ đó PAID khi HĐ mới được thanh toán đủ.
 * - type='deposit': cọc còn thiếu trong hợp đồng. Trigger DB sẽ cộng amount vào contracts.deposit_paid.
 */
export interface PreviousDebtSource {
  type: 'invoice' | 'deposit';
  /** Có với type='invoice' — id của HĐ cũ. */
  id?: string;
  /** Có với type='deposit' — id của hợp đồng. */
  contract_id?: string;
  amount: number;
  /** Label hiển thị trong tooltip / print, vd "HĐ #INV-2026-04-001 (04/2026)" / "Cọc còn thiếu". */
  label: string;
}

/** Matches `invoices` table */
export interface Invoice {
  id: string;
  user_id: string;
  contract_id: string;
  building_id: string;
  room_id: string;
  invoice_number: string | null;
  billing_month: string; // YYYY-MM
  issue_date: string; // DATE
  due_date: string; // DATE
  paid_date: string | null; // DATE
  status: InvoiceStatus;
  subtotal: number;
  discount_amount: number;
  tax_percent: number;
  tax_amount: number;
  total_amount: number;
  prepaid_amount: number;
  paid_amount: number;
  remaining_amount: number; // GENERATED: total_amount - paid_amount
  previous_debt: number;
  previous_debt_sources: PreviousDebtSource[];
  notes: string | null;
  discount_notes: string | null;
  electricity_prev_overridden: boolean;
  template_id: string | null;
  approved_at: string | null; // TIMESTAMPTZ
  approved_by: string | null;
  creator_name: string | null;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

/** Matches `invoice_items` table */
export interface InvoiceItem {
  id: string;
  invoice_id: string;
  service_id: string | null;
  type: InvoiceItemType;
  description: string;
  unit_price: number;
  quantity: number;
  coefficient: number; // default 1
  amount: number; // = unit_price * quantity * coefficient
  previous_reading: number | null;
  current_reading: number | null;
  from_date: string | null; // DATE
  to_date: string | null; // DATE
  sort_order: number;
  created_at: string;
}

/** Matches `payments` table */
export interface Payment {
  id: string;
  user_id: string;
  invoice_id: string;
  receipt_number: string | null;
  amount: number;
  payment_method: PaymentMethod;
  payment_date: string; // DATE
  notes: string | null;
  receipt_image_url: string | null;
  created_at: string;
  updated_at: string;
}

/** Matches `excess_amounts` table */
export interface ExcessAmount {
  id: string;
  user_id: string;
  contract_id: string;
  amount: number; // positive = credit added, negative = credit used
  description: string | null;
  source_invoice_id: string | null;
  source_payment_id: string | null;
  created_at: string;
}

// =============================================
// Derived / Utility Types
// =============================================

/** Filter parameters for querying invoices */
export interface InvoiceFilters {
  area_id?: string;
  building_id?: string;
  room_id?: string;
  /** Lọc nhiều phòng cùng tên (gộp mọi toà). Ưu tiên hơn room_id. */
  room_ids?: string[];
  contract_id?: string;
  status?: InvoiceStatus;
  /** UI filter trạng thái thanh toán:
   *  - 'paid'    → status = PAID (đã thanh toán đủ, đã làm tròn cũng tính)
   *  - 'partial' → status = PARTIAL_PAID (đã thu 1 phần, còn thiếu ≥ 10K)
   *  - 'unpaid'  → chưa thu đồng nào (status NOT IN PAID/PARTIAL_PAID). */
  payment_status?: 'paid' | 'unpaid' | 'partial';
  /** UI filter vòng đời HĐ:
   *  - 'active' (mặc định) → loại CANCELLED → các HĐ đang hoạt động.
   *  - 'cancelled' → chỉ HĐ đã huỷ.
   *  - 'all' → không lọc theo CANCELLED. */
  view_status?: 'active' | 'cancelled' | 'all';
  billing_month?: string; // YYYY-MM
  date_range?: {
    start: string; // DATE
    end: string; // DATE
  };
  search?: string;
}

/** Computed totals for invoice summary section */
export interface InvoiceTotals {
  subtotal: number;
  discount_amount: number;
  tax_percent: number;
  tax_amount: number;
  total_amount: number;
  prepaid_amount: number;
  remaining: number;
}

/** Form data shape for react-hook-form (create/edit invoice) */
export interface InvoiceFormData {
  building_id: string;
  room_id: string;
  contract_id: string;
  billing_month: string; // YYYY-MM
  issue_date: string; // DATE
  due_date: string; // DATE
  template_id?: string | null;
  notes?: string | null;
  discount_amount: number;
  /** Ghi chú gắn ô Giảm trừ — auto fill "Nợ X Tiền Thối" khi áp credit. */
  discount_notes?: string | null;
  /** Số tiền credit (excess_amounts) đã áp vào discount_amount → sau khi tạo
   *  HĐ sẽ INSERT excess_amounts row âm để tiêu credit. */
  applied_credit?: number;
  /** Cờ chỉ số điện đầu (CHỈ SỐ ĐẦU) bị NV sửa tay khi tạo HĐ. */
  electricity_prev_overridden?: boolean;
  tax_percent: number;
  prepaid_amount: number;
  previous_debt: number;
  /** Breakdown của previous_debt — hiển thị tooltip + cascade khi HĐ này PAID. */
  previous_debt_sources?: PreviousDebtSource[];
  items: InvoiceFormItem[];
}

/** Single item within the invoice form */
export interface InvoiceFormItem {
  service_id?: string | null;
  type: InvoiceItemType;
  description: string;
  unit_price: number;
  quantity: number;
  coefficient: number;
  previous_reading?: number | null;
  current_reading?: number | null;
  from_date?: string | null;
  to_date?: string | null;
  sort_order: number;
}

/** Invoice with joined relations for detail/list views */
export interface InvoiceWithRelations extends Invoice {
  contract?: {
    id: string;
    contract_number: string | null;
    status?: string;
    public_code?: string;
    contract_customers?: Array<{
      id: string;
      is_representative: boolean;
      customer: {
        id: string;
        full_name: string;
        phone: string | null;
      } | null;
    }>;
  };
  building?: {
    id: string;
    name: string;
    default_account_id_tt?: string | null;
    default_account_id_tk?: string | null;
  };
  room?: {
    id: string;
    name: string;
  };
  bed?: {
    id: string;
    name: string;
  } | null;
  tenant?: {
    id: string;
    full_name: string;
    phone: string | null;
  };
  invoice_items?: InvoiceItem[];
  payments?: Payment[];
}
