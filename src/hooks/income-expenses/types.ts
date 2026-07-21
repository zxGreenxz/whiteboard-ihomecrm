import type {
  IncomeExpenseFormValues,
  ExcelImportRow,
} from "@/lib/incomeExpenseValidation";
import { AMOUNT_SEARCH_TOLERANCE } from "@/lib/roomCodeSearch";

// Re-export để giữ tương thích cho các nơi import từ hook này.
export { AMOUNT_SEARCH_TOLERANCE };

// --- Types ---

export interface IncomeExpenseFilters {
  building_id?: string | null;
  /** Lọc nhiều toà (BuildingMultiSelect). undefined/[] = tất cả. */
  building_ids?: string[] | null;
  room_id?: string | null;
  /** Lọc nhiều phòng cùng tên (gộp mọi toà). Ưu tiên hơn room_id. */
  room_ids?: string[] | null;
  account_id?: string | null;
  cash_book_id?: string | null;
  type?: "INCOME" | "EXPENSE" | null;
  start_date?: string | null;
  end_date?: string | null;
  // "ALL_ACTIVE" = Đã ghi nhận + Nháp (loại trừ Đã huỷ) — đây là mặc định.
  approval_status?: "UNAPPROVED" | "APPROVED" | "CANCELLED" | "ALL_ACTIVE" | null;
  // Lọc theo hạng mục (income_expense_type) trong items của phiếu.
  // income_type_id: chỉ áp dụng cho phiếu thu, expense_type_id: cho phiếu chi.
  // Nếu cả 2 cùng có → union (phiếu thu khớp HOẶC phiếu chi khớp).
  income_type_id?: string | null;
  expense_type_id?: string | null;
  // Lọc theo NHÓM (Loại) của hạng mục = income_expense_types.category. Lấy phiếu
  // có ÍT NHẤT 1 item thuộc hạng mục nằm trong nhóm này. Nếu đi kèm
  // income_type_id/expense_type_id thì GIAO (phiếu vừa khớp hạng mục vừa thuộc nhóm).
  type_category?: string | null;
  // Lọc theo người tạo phiếu = user_id của profile (owner hoặc staff).
  creator_id?: string | null;
  // Lọc theo số tiền (đồng) — match phiếu có total_amount trong [target-5000, target+5000].
  // Dùng khi user gõ số vào ô tìm kiếm.
  amount_target?: number | null;
  // Lọc theo trạng thái "đã kiểm tra": null = tất cả, "VERIFIED" = đã check,
  // "UNVERIFIED" = chưa check.
  verified_status?: "VERIFIED" | "UNVERIFIED" | null;
  // Chỉ lấy phiếu có PHẦN hạch toán KQKD (kqkd_amount > 0, item-level — phiếu
  // trộn thu HĐ gộp cọc vẫn vào với phần doanh thu). Dùng cho báo cáo Lợi nhuận
  // để loại "tiền cọc" (và khoản override không-KQKD). Mặc định null/false =
  // lấy hết (trang Thu chi giữ nguyên là sổ dòng tiền).
  business_result_only?: boolean | null;
  // Lọc theo KỲ ÁP DỤNG (theo tháng) của items: lấy phiếu có ÍT NHẤT 1 item mà
  // kỳ [start_date, end_date] giao với khoảng [period_start_month, period_end_month].
  // Định dạng 'YYYY-MM'. Chỉ xét item CÓ kỳ (bỏ qua item null-period).
  period_start_month?: string | null;
  period_end_month?: string | null;
  // B4 (04/07 — thống nhất tài chính): LỚP phiếu cho trang Thu chi.
  //  CASH    = tiền thật đã vào sổ (APPROVED, sổ thực, không phải nguồn nội bộ)
  //  INTERNAL= bút toán nội bộ (nguồn termination.*/backfill/adjustment hoặc sổ ảo)
  //  PENDING = chờ xử lý (Nháp hoặc CHƯA CHỌN SỔ, chưa huỷ)
  // undefined/null = không lọc lớp (các trang khác giữ nguyên hành vi cũ).
  layer?: 'CASH' | 'INTERNAL' | 'PENDING' | null;
  // Lọc theo NHÓM NGUỒN sinh phiếu (voucherSources.ts); 'Nhập tay' = source NULL.
  source_group?: string | null;
}

// Bộ lọc rỗng mặc định của trang Thu chi (desktop + mobile + prefetch dùng
// chung — lệch shape là lệch query key, prefetch thành vô dụng).
export const EMPTY_INCOME_EXPENSE_FILTERS: IncomeExpenseFilters = {
  // Lọc nhiều toà (BuildingMultiSelect) — [] = tất cả toà.
  building_ids: [],
  room_id: null,
  room_ids: null,
  account_id: null,
  cash_book_id: null,
  type: null,
  start_date: null,
  end_date: null,
  approval_status: "ALL_ACTIVE",
  income_type_id: null,
  expense_type_id: null,
  type_category: null,
  creator_id: null,
  amount_target: null,
  verified_status: null,
  period_start_month: null,
  period_end_month: null,
  // Mặc định TIỀN THẬT — user mới & nút Reset đều về lớp này.
  layer: "CASH",
  source_group: null,
};

export interface IncomeExpenseItem {
  id: string;
  income_expense_id: string;
  income_expense_type_id: string;
  type_name: string;
  // Nhóm hạng mục (income_expense_types.category) — dùng để sắp xếp ưu tiên
  // khoản chi trong báo cáo Phân bổ lợi nhuận. Có thể null.
  category: string | null;
  // Hạng mục CỌC (income_expense_types.is_deposit) — báo cáo KQKD loại dòng này.
  is_deposit: boolean;
  description: string | null;
  quantity: number;
  unit_price: number;
  amount: number;
  start_date: string | null;
  end_date: string | null;
}


export interface IncomeExpenseWithRelations {
  id: string;
  user_id: string;
  code: string;
  type: "INCOME" | "EXPENSE";
  name: string;
  building_id: string;
  building_name: string;
  room_id: string | null;
  room_name: string | null;  tenant_id: string | null;
  tenant_name: string | null;
  voucher_date: string;
  total_amount: number;
  approval_status: "UNAPPROVED" | "APPROVED" | "CANCELLED";
  approved_by: string | null;
  approved_at: string | null;
  notes: string | null;
  payer_name: string | null;
  account_id: string | null;
  account_name: string | null;
  // B4: sổ ảo? (embed accounts.is_virtual) + nguồn sinh phiếu (system_source).
  account_is_virtual: boolean | null;
  system_source: string | null;
  shareholder_id: string | null;
  contract_id: string | null;
  // Hoá đơn liên quan — phiếu thu sinh từ thanh toán hoá đơn (deep-link 2 chiều).
  invoice_id: string | null;
  attachments: string[];
  // NULL = tự động (suy theo hạng mục cọc); TRUE/FALSE = override tay.
  business_result_accounting: boolean | null;
  // Cờ hiệu lực do DB tính: có tính vào báo cáo Lợi nhuận hay không.
  counts_in_business_result: boolean;
  // Phần tiền tính vào KQKD (DB maintain, item-level): override TRUE=total,
  // FALSE=0, NULL=total − Σ item cọc. Phiếu TRỘN (thu HĐ gộp cọc) có
  // 0 < kqkd_amount < total_amount.
  kqkd_amount: number;
  receive_bank_name: string | null;
  receive_bank_account: string | null;
  creator_name: string | null;
  repeat_cycle: 'NONE' | 'WEEK' | 'MONTH' | 'QUARTER' | 'YEAR' | null;
  repeat_infinity: boolean;
  repeat_count: number;
  repeat_remaining: number;
  repeat_next_date: string | null;
  repeat_parent_id: string | null;
  verified_at: string | null;
  verified_by: string | null;
  verified_by_name: string | null;
  verified_note: string | null;
  items: IncomeExpenseItem[];
  created_at: string;
  updated_at: string;
}

// --- Mutation Input Types ---

export interface CreateIncomeExpenseInput extends IncomeExpenseFormValues {}

export interface UpdateIncomeExpenseInput {
  id: string;
  data: IncomeExpenseFormValues;
}

export interface ImportIncomeExpenseRow extends ExcelImportRow {
  building_id: string;
  income_expense_type_id: string;
}

// Tạo phiếu CHI chia lợi nhuận cổ đông:
// - EXPENSE trên sổ quỹ thu nguồn, gắn shareholder_id
// - business_result_accounting=false (không tính KQKD — là chia lãi, không phải chi phí)
// - tòa = tòa ảo "Chung" (không thuộc tòa thật)
// - 1 item type "Chia lợi nhuận cổ đông" → trigger set total_amount = amount
export interface CreateProfitDistributionInput {
  shareholder_id: string;
  shareholder_name?: string;
  amount: number;
  account_id: string;
  voucher_date: string;
  note?: string | null;
}

// Tạo phiếu CHI trả LƯƠNG ĐIỀU HÀNH (giống chia lợi nhuận cổ đông):
// - EXPENSE trên sổ quỹ nguồn, gắn profit_manager_id
// - business_result_accounting=false (lương đã trừ ở tầng phân bổ → không trừ kép KQKD)
// - tòa = tòa ảo "Chung"; 1 item type "Lương điều hành" → trigger set total_amount
export interface CreateManagerSalaryPayoutInput {
  manager_id: string;
  manager_name?: string;
  amount: number;
  account_id: string;
  voucher_date: string;
  note?: string | null;
}

// Sửa nhanh phiếu thu/chi: chỉ 3 field "non-financial" (sổ quỹ, đính kèm,
// ghi chú). Dùng cho người tạo phiếu để fix lẹ mà không cần super admin
// và không phải mở full form (nguy hiểm vì có thể đổi total_amount/items).
// Backend RPC tự kiểm tra quyền (creator hoặc super admin).
export interface QuickUpdateIncomeExpenseInput {
  id: string;
  account_id: string | null;
  attachments: string[];
  notes: string | null;
}

// Một dòng nhật ký thao tác trên phiếu thu/chi.
export interface IncomeExpenseAuditLog {
  id: string;
  action: string; // 'CANCELLED' | 'RESTORED'
  actor_id: string | null;
  actor_name: string | null;
  old_status: string | null;
  new_status: string | null;
  note: string | null;
  created_at: string;
}

// =============================================
// PHIẾU THU/CHI TỔNG (BATCH)
// =============================================

export interface IncomeExpenseBatchSummary {
  id: string;
  user_id: string;
  name: string;
  type: "INCOME" | "EXPENSE";
  payer_name: string | null;
  attachments: string[];
  notes: string | null;
  created_at: string;
  // Aggregated từ phiếu con (đều giống nhau giữa các phiếu trong batch):
  voucher_date: string | null;
  account_id: string | null;
  account_name: string | null;
  business_result_accounting: boolean | null;
  creator_name: string | null;
  // Tổng hợp:
  vouchers: IncomeExpenseWithRelations[];
  voucher_count: number;
  total_amount: number;
  building_names: string[];
  has_approved: boolean;
  all_cancelled: boolean;
}
