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

/** Matches `invoices` table */
export interface Invoice {
  id: string;
  user_id: string;
  contract_id: string;
  building_id: string;
  room_id: string;
  bed_id: string | null;
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
  notes: string | null;
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
  building_id?: string;
  room_id?: string;
  bed_id?: string;
  contract_id?: string;
  status?: InvoiceStatus;
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
  bed_id?: string | null;
  contract_id: string;
  billing_month: string; // YYYY-MM
  issue_date: string; // DATE
  due_date: string; // DATE
  template_id?: string | null;
  notes?: string | null;
  discount_amount: number;
  tax_percent: number;
  prepaid_amount: number;
  previous_debt: number;
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
  };
  building?: {
    id: string;
    name: string;
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
