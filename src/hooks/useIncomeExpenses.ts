import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { getSessionUser } from "@/lib/authSession";
import { toast } from "sonner";
import { VOUCHER_SOURCES } from "@/lib/voucherSources";
import type {
  IncomeExpenseFormValues,
  ExcelImportRow,
  IncomeExpenseBatchFormValues,
} from "@/lib/incomeExpenseValidation";
import { monthToStartDate, monthToEndDate } from "@/lib/monthPeriod";
import { getAllIeTypesCached, type IeTypeLite } from "@/lib/ieTypesCache";
import { addCycle, type RepeatCycle } from "@/lib/recurring";
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

// --- Helpers ---

// Resolve filter hạng mục (income_type_id/expense_type_id) → tập type_id "sibling"
// cùng (name, type). Trả null nếu không có filter hạng mục; [] nếu có filter
// nhưng không type nào khớp (caller trả rỗng ngay).
//
// TRƯỚC ĐÂY hàm này còn join thêm income_expense_items để ra danh sách voucher_id
// rồi caller `.in("id", [...])`. Với hạng mục có hàng trăm phiếu (vd "Thu tiền
// hoá đơn") danh sách UUID làm URL GET dài chục KB → PostgREST trả 400 → list
// rỗng oan. Nay chỉ trả type_id (tập NHỎ) để caller lọc qua embedded inner-join
// `income_expense_items!inner` — xem ITEM_TYPE_INNER_JOIN / planItemFilters.
//
// LƯU Ý: income_expense_types có nhiều row trùng (name, type) do mỗi user được
// seed riêng; items của phiếu có thể trỏ tới bất kỳ id "sibling" nào cùng
// (name, type). Vì vậy phải expand selected id → tất cả id cùng (name, type),
// nếu không sẽ bỏ sót phiếu của user khác.
async function getItemTypeSiblingIds(
  filters: Pick<
    IncomeExpenseFilters,
    "income_type_id" | "expense_type_id" | "type_category"
  >
): Promise<string[] | null> {
  const selectedIds: string[] = [];
  if (filters.income_type_id) selectedIds.push(filters.income_type_id);
  if (filters.expense_type_id) selectedIds.push(filters.expense_type_id);
  const hasCategory = !!filters.type_category;
  if (selectedIds.length === 0 && !hasCategory) return null;

  // Bản cũ bắn 1+N query income_expense_types mỗi lần chạy (và chạy trong CẢ 3
  // queryFn list/stats/batches) → burst nghẽn pool. Giờ resolve thuần JS trên
  // cache 1-fetch (ieTypesCache, TTL 5', RLS áp như cũ) — giữ nguyên ngữ nghĩa
  // match exact của .eq().
  let allTypes: IeTypeLite[];
  try {
    allTypes = await getAllIeTypesCached();
  } catch (err) {
    console.error("getItemTypeSiblingIds types fetch error:", err);
    return [];
  }

  // --- Lọc theo NHÓM (Loại): mọi type_id có category khớp (mọi user, không cần
  // expand sibling vì đã match trực tiếp chuỗi category). ---
  let categoryIds: Set<string> | null = null;
  if (hasCategory) {
    categoryIds = new Set(
      allTypes
        .filter((t) => t.category === filters.type_category)
        .map((t) => t.id)
    );
    if (categoryIds.size === 0) return [];
  }

  // --- Lọc theo hạng mục cụ thể (income_type_id/expense_type_id) ---
  let siblingIds: Set<string> | null = null;
  if (selectedIds.length > 0) {
    // Bước 1: resolve selected ids → (name, type)
    const byId = new Map(allTypes.map((t) => [t.id, t]));
    const selRows = selectedIds
      .map((id) => byId.get(id))
      .filter((t): t is IeTypeLite => !!t);
    if (selRows.length === 0) return [];

    // Bước 2: expand sang tất cả type_id cùng (name, type)
    const expandedIds = new Set<string>(selectedIds);
    for (const row of selRows) {
      for (const t of allTypes) {
        if (t.type === row.type && t.name === row.name) expandedIds.add(t.id);
      }
    }
    siblingIds = expandedIds;
  }

  // --- Kết hợp: cả 2 = GIAO; chỉ 1 = tập đó; không có = null. ---
  if (siblingIds && categoryIds) {
    return Array.from(siblingIds).filter((id) => categoryIds!.has(id));
  }
  if (siblingIds) return Array.from(siblingIds);
  return Array.from(categoryIds!);
}

// Trả về danh sách voucher_id có ÍT NHẤT 1 item mà kỳ áp dụng [start_date,
// end_date] GIAO với khoảng [periodStartMonth, periodEndMonth] (theo tháng).
// Overlap: item.start_date <= cuối-tháng-periodEnd AND item.end_date >= đầu-tháng-periodStart.
// Chỉ xét item CÓ kỳ (item null-period bị loại — "lọc kỳ" ngụ ý item đã gán kỳ).
// Trả null nếu không có filter kỳ; [] nếu có filter nhưng không voucher nào match.
async function getVoucherIdsByItemPeriod(
  periodStartMonth?: string | null,
  periodEndMonth?: string | null
): Promise<string[] | null> {
  if (!periodStartMonth && !periodEndMonth) return null;
  // Nếu chỉ có 1 đầu, coi khoảng = đúng tháng đó (start=end).
  const startM = periodStartMonth || periodEndMonth!;
  const endM = periodEndMonth || periodStartMonth!;
  const rangeStart = monthToStartDate(startM); // 'YYYY-MM-01'
  const rangeEnd = monthToEndDate(endM); // ngày cuối tháng

  const { data, error } = await supabase
    .from("income_expense_items" as any)
    .select("income_expense_id")
    .not("start_date", "is", null)
    .not("end_date", "is", null)
    .lte("start_date", rangeEnd)
    .gte("end_date", rangeStart);

  if (error) {
    console.error("getVoucherIdsByItemPeriod error:", error);
    return [];
  }
  const ids = Array.from(
    new Set(((data ?? []) as any[]).map((r) => r.income_expense_id))
  );
  return ids;
}

// Fragment thêm vào select để lọc hạng mục qua embedded INNER join trên
// income_expense_items: phiếu chỉ lọt khi có ≥1 item thuộc type sibling đã chọn.
// Embed KHÔNG nhân đôi dòng cha (PostgREST trả nested) và KHÔNG nhồi UUID vào URL
// → tránh hẳn lỗi 400 "URL quá dài" của cách `.in("id", [hàng trăm id])` cũ.
const ITEM_TYPE_INNER_JOIN =
  ", _itemTypeFilter:income_expense_items!inner(income_expense_type_id)";

// Kế hoạch lọc cấp item (hạng mục + kỳ áp dụng) cho query income_expenses.
type ItemFilterPlan = {
  // true = filter cấp item chắc chắn rỗng → caller trả kết quả rỗng ngay.
  empty: boolean;
  // null = không lọc hạng mục; ngược lại tập type_id sibling (NHỎ) áp qua
  // embedded inner-join (_itemTypeFilter.income_expense_type_id).
  typeSiblingIds: string[] | null;
  // null = không lọc kỳ; ngược lại voucher_id thoả kỳ, áp .in("id", ...).
  // (Kỳ áp dụng hiếm dùng & tập thường nhỏ nên vẫn resolve ra voucher_id.)
  periodVoucherIds: string[] | null;
};

// Gộp filter cấp item. Kết hợp hạng mục (inner-join) + kỳ (.in id) trên cùng
// query = GIAO, giữ đúng ngữ nghĩa intersection của bản cũ.
async function planItemFilters(
  filters: IncomeExpenseFilters
): Promise<ItemFilterPlan> {
  const [typeSiblingIds, periodVoucherIds] = await Promise.all([
    getItemTypeSiblingIds(filters),
    getVoucherIdsByItemPeriod(filters.period_start_month, filters.period_end_month),
  ]);
  const empty =
    (typeSiblingIds !== null && typeSiblingIds.length === 0) ||
    (periodVoucherIds !== null && periodVoucherIds.length === 0);
  return { empty, typeSiblingIds, periodVoucherIds };
}

// Phần nối thêm vào chuỗi select khi có lọc hạng mục.
function itemFilterJoinSelect(plan: ItemFilterPlan): string {
  return plan.typeSiblingIds !== null ? ITEM_TYPE_INNER_JOIN : "";
}

// Áp filter cấp item lên một query income_expenses đã khởi tạo.
function applyItemFilterToQuery<T>(query: T, plan: ItemFilterPlan): T {
  let q = query as any;
  if (plan.typeSiblingIds !== null) {
    q = q.in("_itemTypeFilter.income_expense_type_id", plan.typeSiblingIds);
  }
  if (plan.periodVoucherIds !== null) {
    q = q.in("id", plan.periodVoucherIds);
  }
  return q as T;
}

// --- Query Hooks ---

// Options factory dùng chung cho hook + prefetch (src/lib/prefetchPages.ts)
// B4: nguồn BÚT TOÁN NỘI BỘ theo bản chất (không có tiền thật di chuyển).
const INTERNAL_SOURCES = Object.entries(VOUCHER_SOURCES)
  .filter(([, m]) => m.internal)
  .map(([k]) => k);

// Áp lọc LỚP phiếu + NHÓM NGUỒN vào query (dùng chung list + stats-list).
// CASH cần thêm inner-embed acc_v để lọc sổ thực — trả về select fragment.
export const layerJoinSelect = (filters: IncomeExpenseFilters): string =>
  filters.layer === 'CASH' ? ', acc_v:accounts!income_expenses_account_id_fkey!inner ( is_virtual )' : '';

const applyLayerFilters = (query: any, filters: IncomeExpenseFilters) => {
  if (filters.layer === 'CASH') {
    query = query.eq('approval_status', 'APPROVED').not('account_id', 'is', null);
    query = query.or('system_source.is.null,system_source.not.in.(' + INTERNAL_SOURCES.join(',') + ')');
    query = query.eq('acc_v.is_virtual', false);
  } else if (filters.layer === 'INTERNAL') {
    query = query.eq('approval_status', 'APPROVED').in('system_source', INTERNAL_SOURCES);
  } else if (filters.layer === 'PENDING') {
    query = query.neq('approval_status', 'CANCELLED');
    query = query.or('approval_status.eq.UNAPPROVED,account_id.is.null');
  }
  if (filters.source_group) {
    if (filters.source_group === 'Nhập tay') {
      query = query.is('system_source', null);
    } else {
      const srcs = Object.entries(VOUCHER_SOURCES)
        .filter(([, m]) => m.group === filters.source_group)
        .map(([k]) => k);
      query = srcs.length ? query.in('system_source', srcs) : query;
    }
  }
  return query;
};

// — queryKey/queryFn 1 nguồn duy nhất, prefetch lệch key là vô dụng.
export const incomeExpensesListQuery = (
  filters: IncomeExpenseFilters,
  pagination: { page: number; pageSize: number },
  searchQuery?: string
) => ({
    gcTime: 15 * 60_000, // ấm lâu cho prefetch (mặc định 5' hay bị GC trước khi bấm)
    queryKey: [
      "income-expenses",
      "list",
      filters.building_id,
      filters.building_ids,
      filters.room_id,
      filters.room_ids,
      filters.account_id,
      filters.type,
      filters.start_date,
      filters.end_date,
      filters.approval_status,
      filters.income_type_id,
      filters.expense_type_id,
      filters.type_category,
      filters.creator_id,
      filters.amount_target,
      filters.verified_status,
      filters.layer,
      filters.source_group,
      filters.business_result_only,
      filters.period_start_month,
      filters.period_end_month,
      pagination.page,
      pagination.pageSize,
      searchQuery,
    ],
    queryFn: async (): Promise<{
      data: IncomeExpenseWithRelations[];
      totalCount: number;
    }> => {
      const hasSearch = searchQuery && searchQuery.trim().length > 0;

      // Lọc theo hạng mục item + kỳ áp dụng (nếu có).
      const itemPlan = await planItemFilters(filters);
      if (itemPlan.empty) {
        return { data: [], totalCount: 0 };
      }

      // Build the main query with joins (kèm inner-join lọc hạng mục nếu có)
      let query = supabase
        .from("income_expenses" as any)
        .select(
          `
          *,
          building:buildings!income_expenses_building_id_fkey ( id, name ),
          room:rooms!income_expenses_room_id_fkey ( id, name ),          tenant:tenants!income_expenses_tenant_id_fkey ( id, full_name ),
          account:accounts!income_expenses_account_id_fkey ( id, name, is_virtual )${itemFilterJoinSelect(itemPlan)}${layerJoinSelect(filters)}
        `,
          { count: "exact" }
        )
        .is("deleted_at", null);

      query = applyItemFilterToQuery(query, itemPlan);
      query = applyLayerFilters(query, filters);

      // Apply filters
      // building_ids: mảng toà từ BuildingMultiSelect (khu vực = phím tắt chọn
      // nhóm toà ở UI, đã bung sẵn thành building_ids)
      if (filters.building_ids?.length) {
        query = query.in("building_id", filters.building_ids);
      }
      if (filters.building_id) {
        query = query.eq("building_id", filters.building_id);
      }
      if (filters.room_ids?.length) {
        query = query.in("room_id", filters.room_ids);
      } else if (filters.room_id) {
        query = query.eq("room_id", filters.room_id);
      }
      if (filters.account_id) {
        // OR: account_id (phiếu thường) HOẶC change_account_id (sổ X Thối nhận metadata thối)
        query = query.or(
          `account_id.eq.${filters.account_id},change_account_id.eq.${filters.account_id}`
        );
      }
      if (filters.type) {
        query = query.eq("type", filters.type);
      }
      if (filters.start_date) {
        query = query.gte("voucher_date", filters.start_date);
      }
      if (filters.end_date) {
        query = query.lte("voucher_date", filters.end_date);
      }
      if (filters.approval_status === "ALL_ACTIVE") {
        query = query.in("approval_status", ["APPROVED", "UNAPPROVED"]);
      } else if (filters.approval_status) {
        query = query.eq("approval_status", filters.approval_status);
      }
      if (filters.creator_id) {
        query = query.eq("user_id", filters.creator_id);
      }
      if (filters.amount_target != null) {
        query = query
          .gte("total_amount", filters.amount_target - AMOUNT_SEARCH_TOLERANCE)
          .lte("total_amount", filters.amount_target + AMOUNT_SEARCH_TOLERANCE);
      }
      if (filters.verified_status === "VERIFIED") {
        query = query.not("verified_at", "is", null);
      } else if (filters.verified_status === "UNVERIFIED") {
        query = query.is("verified_at", null);
      }
      // Báo cáo Lợi nhuận: chỉ phiếu có PHẦN hạch toán KQKD > 0 (item-level —
      // phiếu trộn thu HĐ gộp cọc vẫn hiện với phần doanh thu; phiếu thuần cọc
      // và phiếu override không-KQKD bị loại).
      if (filters.business_result_only) {
        query = query.gt("kqkd_amount", 0);
      }

      // Search SERVER-SIDE: name/code ilike trực tiếp; tenant_name nằm ở bảng
      // join nên resolve trước tenant_id khớp tên rồi OR vào. Trước đây khi
      // search là fetch TOÀN BỘ lịch sử về client (chậm dần theo tuổi dữ liệu
      // + đụng trần max-rows 1000 của PostgREST).
      if (hasSearch) {
        // Bỏ ký tự phá cú pháp or() của PostgREST (dấu phẩy / ngoặc).
        const q = searchQuery!.trim().replace(/[,()]/g, " ").replace(/\s+/g, " ").trim();
        if (q) {
          const { data: tenantRows } = await (supabase as any)
            .from("tenants")
            .select("id")
            .ilike("full_name", `%${q}%`)
            .limit(200);
          const tenantIds = (tenantRows || []).map((t: any) => t.id);
          const ors = [`name.ilike.%${q}%`, `code.ilike.%${q}%`];
          if (tenantIds.length > 0) {
            ors.push(`tenant_id.in.(${tenantIds.join(",")})`);
          }
          query = query.or(ors.join(","));
        }
      }

      // Server-side pagination LUÔN áp dụng (kể cả khi search).
      {
        const from = (pagination.page - 1) * pagination.pageSize;
        const to = from + pagination.pageSize - 1;
        query = query.range(from, to);
      }

      // Order by voucher_date desc
      query = query.order("voucher_date", { ascending: false });

      const { data: vouchers, error, count } = await query;

      if (error) {
        console.error("useIncomeExpenses error:", error);
        return { data: [], totalCount: 0 };
      }

      if (!vouchers || vouchers.length === 0) {
        return { data: [], totalCount: count || 0 };
      }

      // Fetch items for all vouchers in one query
      const voucherIds = (vouchers as any[]).map((v: any) => v.id);
      const { data: allItems, error: itemsError } = await supabase
        .from("income_expense_items" as any)
        .select(
          `
          *,
          income_expense_type:income_expense_types!income_expense_items_income_expense_type_id_fkey ( id, name, category, is_deposit )
        `
        )
        .in("income_expense_id", voucherIds);

      if (itemsError) {
        console.error("useIncomeExpenses items error:", itemsError);
      }

      // Group items by income_expense_id
      const itemsByVoucherId = new Map<string, IncomeExpenseItem[]>();
      if (allItems) {
        for (const item of allItems as any[]) {
          const vId = item.income_expense_id;
          if (!itemsByVoucherId.has(vId)) {
            itemsByVoucherId.set(vId, []);
          }
          itemsByVoucherId.get(vId)!.push({
            id: item.id,
            income_expense_id: item.income_expense_id,
            income_expense_type_id: item.income_expense_type_id,
            type_name: item.income_expense_type?.name ?? "",
            category: item.income_expense_type?.category ?? null,
            is_deposit: !!item.income_expense_type?.is_deposit,
            description: item.description,
            quantity: item.quantity,
            unit_price: Number(item.unit_price),
            amount: Number(item.amount),
            start_date: item.start_date ?? null,
            end_date: item.end_date ?? null,
          });
        }
      }

      // Map vouchers to IncomeExpenseWithRelations
      const mapped: IncomeExpenseWithRelations[] = (vouchers as any[]).map(
        (v: any) => ({
          id: v.id,
          user_id: v.user_id,
          code: v.code,
          type: v.type,
          name: v.name,
          building_id: v.building_id,
          building_name: v.building?.name ?? "",
          room_id: v.room_id,
          room_name: v.room?.name ?? null,          tenant_id: v.tenant_id,
          tenant_name: v.tenant?.full_name ?? null,
          voucher_date: v.voucher_date,
          total_amount: Number(v.total_amount),
          approval_status: v.approval_status,
          approved_by: v.approved_by,
          approved_at: v.approved_at,
          notes: v.notes,
          payer_name: v.payer_name ?? null,
          account_id: v.account_id ?? null,
          account_name: v.account?.name ?? null,
          account_is_virtual: v.account?.is_virtual ?? null,
          system_source: v.system_source ?? null,
          contract_id: v.contract_id ?? null,
          invoice_id: v.invoice_id ?? null,
          attachments: v.attachments ?? [],
          business_result_accounting: v.business_result_accounting ?? null,
          counts_in_business_result: v.counts_in_business_result ?? true,
          kqkd_amount: Number(v.kqkd_amount ?? v.total_amount) || 0,
          receive_bank_name: v.receive_bank_name ?? null,
          receive_bank_account: v.receive_bank_account ?? null,
          creator_name: v.creator_name ?? null,
          repeat_cycle: v.repeat_cycle ?? 'NONE',
          repeat_infinity: !!v.repeat_infinity,
          repeat_count: Number(v.repeat_count ?? 0),
          repeat_remaining: Number(v.repeat_remaining ?? 0),
          repeat_next_date: v.repeat_next_date ?? null,
          repeat_parent_id: v.repeat_parent_id ?? null,
          verified_at: v.verified_at ?? null,
          verified_by: v.verified_by ?? null,
          verified_by_name: v.verified_by_name ?? null,
          verified_note: v.verified_note ?? null,
          items: itemsByVoucherId.get(v.id) ?? [],
          created_at: v.created_at,
          updated_at: v.updated_at,
        })
      );

      // Search đã áp dụng server-side ở trên — count là tổng khớp thật.
      return {
        data: mapped,
        totalCount: count || 0,
      };
    },
  });

// options.enabled: trang Phân bổ LN gate list tiền-mặt khi đang ở chế độ DỒN
// TÍCH (mặc định) — list 1000 dòng + items chỉ được đọc ở nhánh !accrualMode.
export const useIncomeExpenses = (
  filters: IncomeExpenseFilters,
  pagination: { page: number; pageSize: number },
  searchQuery?: string,
  options?: { enabled?: boolean }
) => {
  return useQuery({
    ...incomeExpensesListQuery(filters, pagination, searchQuery),
    enabled: options?.enabled ?? true,
  });
};

export const incomeExpenseStatsQuery = (
  filters: IncomeExpenseFilters,
  businessResultOnly: boolean
) => ({
    gcTime: 15 * 60_000, // ấm lâu cho prefetch (mặc định 5')
    queryKey: [
      "income-expenses",
      "stats",
      filters.building_id,
      filters.building_ids,
      filters.room_id,
      filters.room_ids,
      filters.account_id,
      filters.type,
      filters.start_date,
      filters.end_date,
      filters.approval_status,
      filters.income_type_id,
      filters.expense_type_id,
      filters.type_category,
      filters.creator_id,
      filters.amount_target,
      filters.verified_status,
      filters.layer,
      filters.source_group,
      filters.period_start_month,
      filters.period_end_month,
      businessResultOnly,
    ],
    queryFn: async (): Promise<{
      totalIncome: number;
      totalExpense: number;
      difference: number;
      // B4: bút toán nội bộ & chờ xử lý tách khỏi 3 thẻ tiền thật.
      internalCount: number;
      internalIncome: number;
      internalExpense: number;
      pendingCount: number;
      pendingTotal: number;
      // Tổng MỌI khoản (cash+internal+pending) — trang Phân bổ LN chế độ
      // "gồm cả khoản ngoài KQKD" dùng; trang Thu chi bỏ qua.
      allIncome?: number;
      allExpense?: number;
    }> => {
      const EMPTY_STATS = {
        totalIncome: 0, totalExpense: 0, difference: 0,
        internalCount: 0, internalIncome: 0, internalExpense: 0,
        pendingCount: 0, pendingTotal: 0,
      };
      const itemPlan = await planItemFilters(filters);
      if (itemPlan.empty) {
        return EMPTY_STATS;
      }

      // B4: aggregate SERVER-SIDE qua RPC — bản cũ SELECT rồi cộng client-side
      // dính cap 1000 hàng của PostgREST → tenant thật (~1.356 phiếu) bị cộng
      // thiếu âm thầm. RPC SECURITY INVOKER nên RLS vẫn áp per-user như cũ.
      const groupSources =
        filters.source_group && filters.source_group !== 'Nhập tay'
          ? Object.entries(VOUCHER_SOURCES)
              .filter(([, m]) => m.group === filters.source_group)
              .map(([k]) => k)
          : null;
      const { data, error } = await (supabase.rpc as any)(
        'get_income_expense_layer_stats',
        {
          p_building_ids: filters.building_ids?.length
            ? filters.building_ids
            : filters.building_id
              ? [filters.building_id]
              : null,
          p_room_ids: filters.room_ids?.length
            ? filters.room_ids
            : filters.room_id
              ? [filters.room_id]
              : null,
          p_account_id: filters.account_id ?? null,
          p_type: filters.type ?? null,
          p_start_date: filters.start_date ?? null,
          p_end_date: filters.end_date ?? null,
          p_approval: filters.approval_status ?? 'ALL_ACTIVE',
          p_creator_id: filters.creator_id ?? null,
          p_amount: filters.amount_target ?? null,
          p_amount_tol: AMOUNT_SEARCH_TOLERANCE,
          p_verified: filters.verified_status ?? null,
          p_item_type_ids: itemPlan.typeSiblingIds,
          p_voucher_ids: itemPlan.periodVoucherIds,
          p_sources: groupSources,
          p_source_manual: filters.source_group === 'Nhập tay',
          p_internal_sources: INTERNAL_SOURCES,
          p_kqkd_only: businessResultOnly,
        }
      );

      if (error) {
        console.error('useIncomeExpenseStats error:', error);
        return EMPTY_STATS;
      }
      const s = Array.isArray(data) ? data[0] : data;
      if (!s) return EMPTY_STATS;
      const totalIncome = Number(s.cash_income) || 0;
      const totalExpense = Number(s.cash_expense) || 0;
      const allIncome = businessResultOnly
        ? totalIncome
        : totalIncome + (Number(s.internal_income) || 0) + (Number(s.pending_income) || 0);
      const allExpense = businessResultOnly
        ? totalExpense
        : totalExpense + (Number(s.internal_expense) || 0) + (Number(s.pending_expense) || 0);
      return {
        totalIncome,
        totalExpense,
        difference: totalIncome - totalExpense,
        allIncome,
        allExpense,
        internalCount: Number(s.internal_count) || 0,
        internalIncome: Number(s.internal_income) || 0,
        internalExpense: Number(s.internal_expense) || 0,
        pendingCount: Number(s.pending_count) || 0,
        pendingTotal: Number(s.pending_total) || 0,
      };
    },
  });

export const useIncomeExpenseStats = (
  filters: IncomeExpenseFilters,
  opts?: { businessResultOnly?: boolean }
) => {
  const businessResultOnly = opts?.businessResultOnly ?? false;
  return useQuery(incomeExpenseStatsQuery(filters, businessResultOnly));
};


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

// --- Mutation Hooks ---

// Tạo phiếu thu/chi mới (phiếu + items)
export const useCreateIncomeExpense = () => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (input: CreateIncomeExpenseInput) => {
      const user = await getSessionUser();

      if (!user) throw new Error("User not authenticated");

      const meta = (user.user_metadata ?? {}) as Record<string, any>;
      const creatorName: string =
        meta.full_name || meta.name || user.email || "Người dùng";

      // 1. Insert the voucher
      const { data: voucher, error: voucherError } = await supabase
        .from("income_expenses" as any)
        .insert({
          user_id: user.id,
          creator_name: creatorName,
          type: input.type,
          name: input.name,
          building_id: input.building_id,
          room_id: input.room_id ?? null,
          tenant_id: input.tenant_id ?? null,
          contract_id: input.contract_id ?? null,
          payer_name: input.payer_name ?? null,
          receive_bank_account: input.receive_bank_account || null,
          receive_bank_name: input.receive_bank_name || null,
          account_id: input.account_id ?? null,
          attachments: input.attachments ?? [],
          // null = tự động (DB suy theo hạng mục cọc); false/true = override tay.
          business_result_accounting: input.business_result_accounting ?? null,
          repeat_cycle: input.repeat_cycle ?? "NONE",
          repeat_infinity: !!input.repeat_infinity,
          repeat_count: input.repeat_count ?? 0,
          repeat_remaining: input.repeat_infinity
            ? 0
            : Number(input.repeat_count ?? 0),
          // Phiếu gốc = kỳ #1; ngày sinh tiếp theo là kỳ kế (tránh trùng kỳ đầu).
          repeat_next_date:
            input.repeat_cycle && input.repeat_cycle !== "NONE"
              ? addCycle(input.voucher_date, input.repeat_cycle as RepeatCycle, 1)
              : null,
          voucher_date: input.voucher_date,
        })
        .select()
        .single();

      if (voucherError) {
        toast.error(voucherError.message || "Không thể tạo phiếu thu/chi");
        throw voucherError;
      }

      // 2. Insert items
      const itemsToInsert = input.items.map((item) => ({
        income_expense_id: (voucher as any).id,
        income_expense_type_id: item.income_expense_type_id,
        description: item.description ?? null,
        quantity: item.quantity,
        unit_price: item.unit_price,
        start_date: item.start_date ?? null,
        end_date: item.end_date ?? null,
      }));

      const { error: itemsError } = await supabase
        .from("income_expense_items" as any)
        .insert(itemsToInsert);

      if (itemsError) {
        toast.error(itemsError.message || "Không thể tạo hạng mục");
        throw itemsError;
      }

      return voucher;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["income-expenses"] });
      toast.success("Dữ liệu đã được TẠO thành công");
    },
    onError: (error) => {
      console.error("Error creating income expense:", error);
    },
  });
};

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

export const useCreateProfitDistribution = () => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (input: CreateProfitDistributionInput) => {
      const user = await getSessionUser();
      if (!user) throw new Error("User not authenticated");

      const meta = (user.user_metadata ?? {}) as Record<string, any>;
      const creatorName: string =
        meta.full_name || meta.name || user.email || "Người dùng";

      // 1) Toà chung hệ thống (toà ảo — hiện là "Kho Văn Phòng Chung").
      //    RLS tự cắt theo tenant; chỉ còn 1 toà ảo non-deleted nên không mơ hồ.
      const { data: chung, error: bErr } = await (supabase
        .from("buildings" as any)
        .select("id") as any)
        .eq("is_virtual", true)
        .is("deleted_at", null)
        .order("created_at", { ascending: true })
        .limit(1)
        .maybeSingle();
      if (bErr) throw bErr;
      if (!chung)
        throw new Error("Chưa có toà chung để hạch toán phiếu chia lợi nhuận");

      // 2) Hạng mục "Chia lợi nhuận cổ đông" (tạo nếu thiếu)
      let typeId: string;
      const { data: t } = await (supabase
        .from("income_expense_types" as any)
        .select("id") as any)
        .eq("user_id", user.id)
        .eq("type", "expense")
        .eq("name", "Chia lợi nhuận cổ đông")
        .limit(1)
        .maybeSingle();
      if (t?.id) {
        typeId = t.id;
      } else {
        const { data: created, error: ctErr } = await supabase
          .from("income_expense_types" as any)
          .insert({
            user_id: user.id,
            name: "Chia lợi nhuận cổ đông",
            type: "expense",
            category: "Chia lợi nhuận",
            is_default: false,
            is_deposit: false,
          })
          .select("id")
          .single();
        if (ctErr) throw ctErr;
        typeId = (created as any).id;
      }

      // 3) Phiếu chi (không hạch toán KQKD)
      const name =
        input.note?.trim() ||
        `Chia lợi nhuận: ${input.shareholder_name ?? ""}`.trim() ||
        "Chia lợi nhuận cổ đông";
      const { data: voucher, error: vErr } = await supabase
        .from("income_expenses" as any)
        .insert({
          user_id: user.id,
          creator_name: creatorName,
          type: "EXPENSE",
          name,
          building_id: (chung as any).id,
          account_id: input.account_id,
          shareholder_id: input.shareholder_id,
          business_result_accounting: false,
          attachments: [],
          repeat_cycle: "NONE",
          repeat_infinity: false,
          repeat_count: 0,
          repeat_remaining: 0,
          voucher_date: input.voucher_date,
        })
        .select()
        .single();
      if (vErr) {
        toast.error(vErr.message || "Không thể tạo phiếu chia lợi nhuận");
        throw vErr;
      }

      // 4) 1 item → trigger tính total_amount = amount
      const { error: itErr } = await supabase
        .from("income_expense_items" as any)
        .insert({
          income_expense_id: (voucher as any).id,
          income_expense_type_id: typeId,
          description: input.note ?? null,
          quantity: 1,
          unit_price: input.amount,
          start_date: input.voucher_date,
          end_date: input.voucher_date,
        });
      if (itErr) {
        toast.error(itErr.message || "Không thể tạo hạng mục");
        throw itErr;
      }

      return voucher;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["income-expenses"] });
      queryClient.invalidateQueries({ queryKey: ["accounts-with-balance"] });
      queryClient.invalidateQueries({ queryKey: ["shareholder-distributions"] });
      toast.success("Đã ghi phiếu chia lợi nhuận");
    },
    onError: (error) => {
      console.error("Error creating profit distribution:", error);
    },
  });
};

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

export const useCreateManagerSalaryPayout = () => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (input: CreateManagerSalaryPayoutInput) => {
      const user = await getSessionUser();
      if (!user) throw new Error("User not authenticated");

      const meta = (user.user_metadata ?? {}) as Record<string, any>;
      const creatorName: string =
        meta.full_name || meta.name || user.email || "Người dùng";

      // 1) Toà chung hệ thống (toà ảo — hiện là "Kho Văn Phòng Chung").
      //    RLS tự cắt theo tenant; chỉ còn 1 toà ảo non-deleted nên không mơ hồ.
      const { data: chung, error: bErr } = await (supabase
        .from("buildings" as any)
        .select("id") as any)
        .eq("is_virtual", true)
        .is("deleted_at", null)
        .order("created_at", { ascending: true })
        .limit(1)
        .maybeSingle();
      if (bErr) throw bErr;
      if (!chung)
        throw new Error("Chưa có toà chung để hạch toán phiếu lương điều hành");

      // 2) Hạng mục "Lương điều hành" (tạo nếu thiếu)
      let typeId: string;
      const { data: t } = await (supabase
        .from("income_expense_types" as any)
        .select("id") as any)
        .eq("user_id", user.id)
        .eq("type", "expense")
        .eq("name", "Lương điều hành")
        .limit(1)
        .maybeSingle();
      if (t?.id) {
        typeId = t.id;
      } else {
        const { data: created, error: ctErr } = await supabase
          .from("income_expense_types" as any)
          .insert({
            user_id: user.id,
            name: "Lương điều hành",
            type: "expense",
            category: "Chia lợi nhuận",
            is_default: false,
            is_deposit: false,
          })
          .select("id")
          .single();
        if (ctErr) throw ctErr;
        typeId = (created as any).id;
      }

      // 3) Phiếu chi (không hạch toán KQKD)
      const name =
        input.note?.trim() ||
        `Lương điều hành: ${input.manager_name ?? ""}`.trim() ||
        "Lương điều hành";
      const { data: voucher, error: vErr } = await supabase
        .from("income_expenses" as any)
        .insert({
          user_id: user.id,
          creator_name: creatorName,
          type: "EXPENSE",
          name,
          building_id: (chung as any).id,
          account_id: input.account_id,
          profit_manager_id: input.manager_id,
          business_result_accounting: false,
          attachments: [],
          repeat_cycle: "NONE",
          repeat_infinity: false,
          repeat_count: 0,
          repeat_remaining: 0,
          voucher_date: input.voucher_date,
        })
        .select()
        .single();
      if (vErr) {
        toast.error(vErr.message || "Không thể tạo phiếu lương điều hành");
        throw vErr;
      }

      // 4) 1 item → trigger tính total_amount = amount
      const { error: itErr } = await supabase
        .from("income_expense_items" as any)
        .insert({
          income_expense_id: (voucher as any).id,
          income_expense_type_id: typeId,
          description: input.note ?? null,
          quantity: 1,
          unit_price: input.amount,
          start_date: input.voucher_date,
          end_date: input.voucher_date,
        });
      if (itErr) {
        toast.error(itErr.message || "Không thể tạo hạng mục");
        throw itErr;
      }

      return voucher;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["income-expenses"] });
      queryClient.invalidateQueries({ queryKey: ["accounts-with-balance"] });
      queryClient.invalidateQueries({ queryKey: ["manager-salary-payouts"] });
      toast.success("Đã ghi phiếu lương điều hành");
    },
    onError: (error) => {
      console.error("Error creating manager salary payout:", error);
    },
  });
};

// Cập nhật phiếu thu/chi (chỉ khi UNAPPROVED)
export const useUpdateIncomeExpense = () => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (input: UpdateIncomeExpenseInput) => {
      const { id, data } = input;

      // 1. Update the voucher (only if UNAPPROVED)
      const { data: voucher, error: voucherError } = await supabase
        .from("income_expenses" as any)
        .update({
          type: data.type,
          name: data.name,
          building_id: data.building_id,
          room_id: data.room_id ?? null,
          tenant_id: data.tenant_id ?? null,
          contract_id: data.contract_id ?? null,
          payer_name: data.payer_name ?? null,
          receive_bank_account: data.receive_bank_account || null,
          receive_bank_name: data.receive_bank_name || null,
          account_id: data.account_id ?? null,
          attachments: data.attachments ?? [],
          business_result_accounting: data.business_result_accounting ?? null,
          voucher_date: data.voucher_date,
          // FIX: trước đây bỏ qua các trường repeat_* nên sửa "Cài đặt lặp lại"
          // không lưu (và không tắt được lặp). repeat_remaining/next_date sẽ được
          // RPC tự suy lại theo số phiếu con thực tế ở lần sinh kế tiếp.
          repeat_cycle: data.repeat_cycle ?? "NONE",
          repeat_infinity: !!data.repeat_infinity,
          repeat_count: data.repeat_count ?? 0,
          repeat_remaining: data.repeat_infinity ? 0 : Number(data.repeat_count ?? 0),
          repeat_next_date:
            data.repeat_cycle && data.repeat_cycle !== "NONE"
              ? addCycle(data.voucher_date, data.repeat_cycle as RepeatCycle, 1)
              : null,
        })
        .eq("id", id)
        .select()
        .single();

      if (voucherError) {
        toast.error(voucherError.message || "Không thể cập nhật phiếu thu/chi");
        throw voucherError;
      }

      // 2. Delete existing items
      const { error: deleteError } = await supabase
        .from("income_expense_items" as any)
        .delete()
        .eq("income_expense_id", id);

      if (deleteError) {
        toast.error(deleteError.message || "Không thể xoá hạng mục cũ");
        throw deleteError;
      }

      // 3. Re-insert new items
      const itemsToInsert = data.items.map((item) => ({
        income_expense_id: id,
        income_expense_type_id: item.income_expense_type_id,
        description: item.description ?? null,
        quantity: item.quantity,
        unit_price: item.unit_price,
        start_date: item.start_date ?? null,
        end_date: item.end_date ?? null,
      }));

      const { error: itemsError } = await supabase
        .from("income_expense_items" as any)
        .insert(itemsToInsert);

      if (itemsError) {
        toast.error(itemsError.message || "Không thể tạo hạng mục mới");
        throw itemsError;
      }

      return voucher;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["income-expenses"] });
      toast.success("Dữ liệu đã được CẬP NHẬT thành công");
    },
    onError: (error) => {
      console.error("Error updating income expense:", error);
    },
  });
};

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

export const useQuickUpdateIncomeExpense = () => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (input: QuickUpdateIncomeExpenseInput) => {
      const { error } = await (supabase as any).rpc(
        "update_income_expense_quick",
        {
          p_id: input.id,
          p_account_id: input.account_id,
          p_attachments: input.attachments,
          p_notes: input.notes,
        }
      );
      if (error) {
        toast.error(error.message || "Không thể cập nhật phiếu");
        throw error;
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["income-expenses"] });
      queryClient.invalidateQueries({ queryKey: ["income-expense-batches"] });
      queryClient.invalidateQueries({ queryKey: ["accounts-with-balance"] });
      toast.success("Dữ liệu đã được CẬP NHẬT thành công");
    },
    onError: (error) => {
      console.error("Error quick-updating income expense:", error);
    },
  });
};

// Duyệt phiếu thu/chi (UNAPPROVED → APPROVED). Dùng khi đã thực thanh toán
// phiếu nháp (vd phiếu chi hoa hồng tạo cùng hợp đồng).
export const useApproveVoucher = () => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (id: string) => {
      const { error } = await (supabase as any).rpc("approve_voucher", {
        voucher_id: id,
      });
      if (error) {
        toast.error(error.message || "Không thể duyệt phiếu");
        throw error;
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["income-expenses"] });
      queryClient.invalidateQueries({ queryKey: ["accounts-with-balance"] });
      toast.success("Phiếu đã được duyệt");
    },
    onError: (error) => {
      console.error("Error approving voucher:", error);
    },
  });
};

// Huỷ duyệt phiếu thu/chi (APPROVED → UNAPPROVED, về lại Nháp). Chỉ super admin
// (hoặc người tạo) — RPC unapprove_voucher tự kiểm quyền (user_id = auth.uid()
// OR is_super_admin()). Dùng khi cần sửa lại phiếu đã ghi nhận.
export const useUnapproveVoucher = () => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (id: string) => {
      const { error } = await (supabase as any).rpc("unapprove_voucher", {
        voucher_id: id,
      });
      if (error) {
        toast.error(error.message || "Không thể huỷ duyệt phiếu");
        throw error;
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["income-expenses"] });
      queryClient.invalidateQueries({ queryKey: ["accounts-with-balance"] });
      toast.success("Đã chuyển phiếu về Nháp");
    },
    onError: (error) => {
      console.error("Error unapproving voucher:", error);
    },
  });
};

// Huỷ phiếu thu/chi: đổi trạng thái sang CANCELLED. Nếu là phiếu INCOME mirror
// từ thanh toán hoá đơn (có payment_id), cũng xoá payment row tương ứng để
// trigger recompute invoice paid_amount/status (qua trigger DB).
export const useCancelIncomeExpense = () => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (id: string) => {
      const { data: voucher, error: fetchErr } = await supabase
        .from("income_expenses" as any)
        .select("id, type, payment_id, approval_status")
        .eq("id", id)
        .maybeSingle() as any;
      if (fetchErr) {
        toast.error(fetchErr.message || "Không thể đọc phiếu");
        throw fetchErr;
      }

      const { error } = await supabase
        .from("income_expenses" as any)
        .update({ approval_status: "CANCELLED" })
        .eq("id", id);
      if (error) {
        toast.error(error.message || "Không thể huỷ phiếu thu/chi");
        throw error;
      }

      if (voucher?.type === "INCOME" && voucher?.payment_id) {
        const { error: payErr } = await supabase
          .from("payments")
          .delete()
          .eq("id", voucher.payment_id);
        if (payErr) {
          toast.error(payErr.message || "Không thể rollback thanh toán hoá đơn");
          throw payErr;
        }
      }

      // Ghi nhật ký thao tác HUỶ (best-effort — không chặn nếu log lỗi).
      await (supabase as any).rpc("log_income_expense_action", {
        p_id: id,
        p_action: "CANCELLED",
        p_note: null,
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["income-expenses"] });
      queryClient.invalidateQueries({ queryKey: ["accounts-with-balance"] });
      queryClient.invalidateQueries({ queryKey: ["invoices"] });
      queryClient.invalidateQueries({ queryKey: ["invoice"] });
      queryClient.invalidateQueries({ queryKey: ["payments"] });
      queryClient.invalidateQueries({ queryKey: ["invoice-statistics"] });
      toast.success("Phiếu đã được HUỶ");
    },
    onError: (error) => {
      console.error("Error cancelling income expense:", error);
    },
  });
};

// Khôi phục phiếu thu/chi đã huỷ (CANCELLED → APPROVED). CHỈ super admin —
// RPC restore_income_expense tự kiểm quyền (is_super_admin). Với phiếu THU theo
// hoá đơn đã mất payment khi huỷ, RPC tạo lại payment (chặn trùng) để hoá đơn
// trở lại đã thu. Thao tác được ghi vào nhật ký (income_expense_audit_log).
export const useRestoreIncomeExpense = () => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (id: string) => {
      const { error } = await (supabase as any).rpc("restore_income_expense", {
        p_id: id,
      });
      if (error) {
        toast.error(error.message || "Không thể khôi phục phiếu");
        throw error;
      }
    },
    onSuccess: (_data, id) => {
      queryClient.invalidateQueries({ queryKey: ["income-expenses"] });
      queryClient.invalidateQueries({ queryKey: ["accounts-with-balance"] });
      queryClient.invalidateQueries({ queryKey: ["invoices"] });
      queryClient.invalidateQueries({ queryKey: ["invoice"] });
      queryClient.invalidateQueries({ queryKey: ["payments"] });
      queryClient.invalidateQueries({ queryKey: ["invoice-statistics"] });
      queryClient.invalidateQueries({ queryKey: ["ie-history", id] });
      toast.success("Đã khôi phục phiếu");
    },
    onError: (error) => {
      console.error("Error restoring income expense:", error);
    },
  });
};

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

// Nhật ký thao tác (huỷ / khôi phục) của 1 phiếu — đọc qua RPC SECURITY DEFINER
// get_income_expense_history để không vướng RLS.
export const useIncomeExpenseHistory = (id: string | null, enabled = true) => {
  return useQuery({
    queryKey: ["ie-history", id],
    enabled: enabled && !!id,
    queryFn: async (): Promise<IncomeExpenseAuditLog[]> => {
      const { data, error } = await (supabase as any).rpc(
        "get_income_expense_history",
        { p_id: id }
      );
      if (error) throw error;
      return (data ?? []) as IncomeExpenseAuditLog[];
    },
  });
};

// Đánh dấu "đã kiểm" / bỏ kiểm phiếu thu/chi. Toggle theo trạng thái hiện tại
// (RPC tự xử lý logic + check quyền). Note rỗng → lưu NULL.
export const useVerifyIncomeExpense = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: { id: string; note: string | null }) => {
      const { error } = await (supabase as any).rpc("verify_income_expense", {
        p_id: input.id,
        p_note: input.note,
      });
      if (error) {
        toast.error(error.message || "Không thể đánh dấu đã kiểm");
        throw error;
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["income-expenses"] });
      queryClient.invalidateQueries({ queryKey: ["income-expense-batches"] });
      toast.success("Đã cập nhật trạng thái kiểm");
    },
    onError: (error) => {
      console.error("Error verifying income expense:", error);
    },
  });
};

// Import phiếu thu/chi hàng loạt từ Excel
export const useImportIncomeExpenses = () => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (
      rows: ImportIncomeExpenseRow[]
    ): Promise<{
      successCount: number;
      failedCount: number;
      errors: Array<{ row: number; message: string }>;
    }> => {
      const user = await getSessionUser();

      if (!user) throw new Error("User not authenticated");

      let successCount = 0;
      let failedCount = 0;
      const errors: Array<{ row: number; message: string }> = [];

      for (let i = 0; i < rows.length; i++) {
        const row = rows[i];
        try {
          // 1. Create the voucher
          const { data: voucher, error: voucherError } = await supabase
            .from("income_expenses" as any)
            .insert({
              user_id: user.id,
              type: row.type,
              name: row.name,
              building_id: row.building_id,
              voucher_date: row.voucher_date,
            })
            .select()
            .single();

          if (voucherError) {
            failedCount++;
            errors.push({ row: i + 1, message: voucherError.message });
            continue;
          }

          // 2. Create the item
          const { error: itemError } = await supabase
            .from("income_expense_items" as any)
            .insert({
              income_expense_id: (voucher as any).id,
              income_expense_type_id: row.income_expense_type_id,
              description: row.item_name,
              quantity: 1,
              unit_price: row.amount,
            });

          if (itemError) {
            failedCount++;
            errors.push({ row: i + 1, message: itemError.message });
            continue;
          }

          successCount++;
        } catch (err: any) {
          failedCount++;
          errors.push({ row: i + 1, message: err.message || "Lỗi không xác định" });
        }
      }

      return { successCount, failedCount, errors };
    },
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: ["income-expenses"] });
      if (result.successCount > 0) {
        toast.success("Dữ liệu đã được TẠO thành công");
      }
      if (result.failedCount > 0 && result.successCount === 0) {
        toast.error(`Tất cả ${result.failedCount} phiếu đều lỗi`);
      }
    },
    onError: (error) => {
      console.error("Error importing income expenses:", error);
      toast.error("Không thể nhập dữ liệu từ Excel");
    },
  });
};

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

// Tạo phiếu tổng = INSERT 1 batch + N phiếu con + N junction + N items.
export const useCreateIncomeExpenseBatch = () => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (input: IncomeExpenseBatchFormValues) => {
      const user = await getSessionUser();
      if (!user) throw new Error("User not authenticated");

      const meta = (user.user_metadata ?? {}) as Record<string, any>;
      const creatorName: string =
        meta.full_name || meta.name || user.email || "Người dùng";

      // 1. INSERT batch metadata
      const { data: batch, error: batchError } = await supabase
        .from("income_expense_batches" as any)
        .insert({
          user_id: user.id,
          name: input.shared_name,
          type: input.type,
          payer_name: input.payer_name ?? null,
          attachments: input.attachments ?? [],
          notes: input.notes ?? null,
        })
        .select()
        .single();

      if (batchError || !batch) {
        toast.error(batchError?.message || "Không thể tạo phiếu tổng");
        throw batchError;
      }

      // 2. INSERT N phiếu con (denormalize metadata chung).
      //    Insert TỪNG phiếu để giữ thứ tự rõ ràng (tương ứng với items input).
      //    Nếu lỗi ở giữa: rollback bằng cách xoá batch (CASCADE xoá junction và batch_items).
      const childVouchers: any[] = [];
      try {
        for (const item of input.items) {
          const { data: voucher, error: voucherError } = await supabase
            .from("income_expenses" as any)
            .insert({
              user_id: user.id,
              creator_name: creatorName,
              type: input.type,
              name: `${input.shared_name} - ${item.type_name ?? ""}`.trim(),
              building_id: item.building_id,
              room_id: item.room_id ?? null,
              account_id: input.account_id,
              payer_name: input.payer_name ?? null,
              attachments: input.attachments ?? [],
              business_result_accounting: input.business_result_accounting ?? null,
              voucher_date: input.voucher_date,
              repeat_cycle: "NONE",
              repeat_infinity: false,
              repeat_count: 0,
              repeat_remaining: 0,
            })
            .select()
            .single();

          if (voucherError || !voucher) {
            throw voucherError ?? new Error("Không thể tạo phiếu con");
          }
          childVouchers.push(voucher);
        }

        // 3. INSERT items (1 item / phiếu vì mỗi hạng mục = 1 phiếu)
        const itemRows = input.items.map((item, idx) => ({
          income_expense_id: childVouchers[idx].id,
          income_expense_type_id: item.income_expense_type_id,
          description: item.description ?? null,
          quantity: item.quantity,
          unit_price: item.unit_price,
          start_date: item.start_date ?? null,
          end_date: item.end_date ?? null,
        }));
        const { error: itemsError } = await supabase
          .from("income_expense_items" as any)
          .insert(itemRows);
        if (itemsError) throw itemsError;

        // 4. INSERT junction rows
        const linkRows = childVouchers.map((v) => ({
          batch_id: (batch as any).id,
          income_expense_id: v.id,
        }));
        const { error: linkError } = await supabase
          .from("income_expense_batch_items" as any)
          .insert(linkRows);
        if (linkError) throw linkError;
      } catch (err: any) {
        // Best-effort rollback: xoá batch (CASCADE xoá junction);
        // Phiếu con đã insert sẽ thành phiếu lẻ standalone — soft-delete chúng.
        if (childVouchers.length > 0) {
          const ids = childVouchers.map((v) => v.id);
          await supabase
            .from("income_expenses" as any)
            .update({ deleted_at: new Date().toISOString() })
            .in("id", ids);
        }
        await supabase
          .from("income_expense_batches" as any)
          .delete()
          .eq("id", (batch as any).id);
        toast.error(err?.message || "Không thể tạo phiếu tổng");
        throw err;
      }

      return { batch, voucherCount: childVouchers.length };
    },
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: ["income-expenses"] });
      queryClient.invalidateQueries({ queryKey: ["income-expense-batches"] });
      queryClient.invalidateQueries({ queryKey: ["accounts-with-balance"] });
      toast.success(`Đã tạo ${result.voucherCount} phiếu trong 1 đợt`);
    },
    onError: (error) => {
      console.error("Error creating income expense batch:", error);
    },
  });
};

// Danh sách phiếu tổng (group by batch_id)
// options.enabled: trang Thu chi gate theo viewMode — chỉ fetch khi user đang
// xem tab Phiếu tổng (batches KHÔNG được prefetch nên gate không phí request).
export const useIncomeExpenseBatches = (
  filters: IncomeExpenseFilters,
  pagination: { page: number; pageSize: number },
  searchQuery?: string,
  options?: { enabled?: boolean }
) => {
  return useQuery({
    enabled: options?.enabled ?? true,
    queryKey: [
      "income-expense-batches",
      "list",
      filters.building_id,
      filters.building_ids,
      filters.room_id,
      filters.room_ids,
      filters.account_id,
      filters.type,
      filters.start_date,
      filters.end_date,
      filters.approval_status,
      filters.income_type_id,
      filters.expense_type_id,
      filters.type_category,
      filters.creator_id,
      filters.amount_target,
      filters.verified_status,
      filters.business_result_only,
      filters.period_start_month,
      filters.period_end_month,
      pagination.page,
      pagination.pageSize,
      searchQuery,
    ],
    queryFn: async (): Promise<{
      data: IncomeExpenseBatchSummary[];
      totalCount: number;
    }> => {
      const itemPlan = await planItemFilters(filters);
      if (itemPlan.empty) {
        return { data: [], totalCount: 0 };
      }

      // 1. Lấy batches (kèm filter type nếu có)
      let batchQuery = supabase
        .from("income_expense_batches" as any)
        .select("*")
        .is("deleted_at", null)
        .order("created_at", { ascending: false });
      if (filters.type) batchQuery = batchQuery.eq("type", filters.type);

      const { data: batches, error: batchError } = await batchQuery;
      if (batchError) {
        console.error("useIncomeExpenseBatches batch error:", batchError);
        return { data: [], totalCount: 0 };
      }
      if (!batches || batches.length === 0) {
        return { data: [], totalCount: 0 };
      }

      const batchIds = (batches as any[]).map((b: any) => b.id);

      // 2. Lấy junction rows
      const { data: links, error: linkError } = await supabase
        .from("income_expense_batch_items" as any)
        .select("batch_id, income_expense_id")
        .in("batch_id", batchIds);
      if (linkError) {
        console.error("useIncomeExpenseBatches link error:", linkError);
        return { data: [], totalCount: 0 };
      }

      const voucherIds = ((links ?? []) as any[]).map((l) => l.income_expense_id);
      if (voucherIds.length === 0) {
        // Có batch nhưng không có voucher con → không hiển thị
        return { data: [], totalCount: 0 };
      }

      // 3. Lấy phiếu con (kèm joins) + filter
      let voucherQuery = supabase
        .from("income_expenses" as any)
        .select(
          `
          *,
          building:buildings!income_expenses_building_id_fkey ( id, name ),
          room:rooms!income_expenses_room_id_fkey ( id, name ),
          tenant:tenants!income_expenses_tenant_id_fkey ( id, full_name ),
          account:accounts!income_expenses_account_id_fkey ( id, name, is_virtual )${itemFilterJoinSelect(itemPlan)}
        `
        )
        .is("deleted_at", null)
        .in("id", voucherIds);

      voucherQuery = applyItemFilterToQuery(voucherQuery, itemPlan);
      if (filters.building_ids?.length) {
        voucherQuery = voucherQuery.in("building_id", filters.building_ids);
      }
      if (filters.building_id) voucherQuery = voucherQuery.eq("building_id", filters.building_id);
      if (filters.room_ids?.length) {
        voucherQuery = voucherQuery.in("room_id", filters.room_ids);
      } else if (filters.room_id) {
        voucherQuery = voucherQuery.eq("room_id", filters.room_id);
      }
      if (filters.account_id) voucherQuery = voucherQuery.or(
        `account_id.eq.${filters.account_id},change_account_id.eq.${filters.account_id}`
      );
      if (filters.start_date) voucherQuery = voucherQuery.gte("voucher_date", filters.start_date);
      if (filters.end_date) voucherQuery = voucherQuery.lte("voucher_date", filters.end_date);
      if (filters.creator_id) voucherQuery = voucherQuery.eq("user_id", filters.creator_id);
      if (filters.amount_target != null) {
        voucherQuery = voucherQuery
          .gte("total_amount", filters.amount_target - AMOUNT_SEARCH_TOLERANCE)
          .lte("total_amount", filters.amount_target + AMOUNT_SEARCH_TOLERANCE);
      }
      if (filters.verified_status === "VERIFIED") {
        voucherQuery = voucherQuery.not("verified_at", "is", null);
      } else if (filters.verified_status === "UNVERIFIED") {
        voucherQuery = voucherQuery.is("verified_at", null);
      }

      const { data: vouchers, error: voucherError } = await voucherQuery;
      if (voucherError) {
        console.error("useIncomeExpenseBatches voucher error:", voucherError);
        return { data: [], totalCount: 0 };
      }

      // 4. Lấy items của tất cả phiếu con
      const fetchedVoucherIds = ((vouchers ?? []) as any[]).map((v) => v.id);
      const allItems =
        fetchedVoucherIds.length === 0
          ? []
          : (
              await supabase
                .from("income_expense_items" as any)
                .select(
                  `
          *,
          income_expense_type:income_expense_types!income_expense_items_income_expense_type_id_fkey ( id, name, category, is_deposit )
        `
                )
                .in("income_expense_id", fetchedVoucherIds)
            ).data ?? [];

      const itemsByVoucherId = new Map<string, IncomeExpenseItem[]>();
      for (const item of allItems as any[]) {
        const vId = item.income_expense_id;
        if (!itemsByVoucherId.has(vId)) itemsByVoucherId.set(vId, []);
        itemsByVoucherId.get(vId)!.push({
          id: item.id,
          income_expense_id: item.income_expense_id,
          income_expense_type_id: item.income_expense_type_id,
          type_name: item.income_expense_type?.name ?? "",
          category: item.income_expense_type?.category ?? null,
          is_deposit: !!item.income_expense_type?.is_deposit,
          description: item.description,
          quantity: item.quantity,
          unit_price: Number(item.unit_price),
          amount: Number(item.amount),
          start_date: item.start_date ?? null,
          end_date: item.end_date ?? null,
        });
      }

      // 5. Map vouchers → IncomeExpenseWithRelations
      const voucherMap = new Map<string, IncomeExpenseWithRelations>();
      for (const v of (vouchers ?? []) as any[]) {
        voucherMap.set(v.id, {
          id: v.id,
          user_id: v.user_id,
          code: v.code,
          type: v.type,
          name: v.name,
          building_id: v.building_id,
          building_name: v.building?.name ?? "",
          room_id: v.room_id,
          room_name: v.room?.name ?? null,          tenant_id: v.tenant_id,
          tenant_name: v.tenant?.full_name ?? null,
          voucher_date: v.voucher_date,
          total_amount: Number(v.total_amount),
          approval_status: v.approval_status,
          approved_by: v.approved_by,
          approved_at: v.approved_at,
          notes: v.notes,
          payer_name: v.payer_name ?? null,
          account_id: v.account_id ?? null,
          account_name: v.account?.name ?? null,
          account_is_virtual: v.account?.is_virtual ?? null,
          system_source: v.system_source ?? null,
          contract_id: v.contract_id ?? null,
          invoice_id: v.invoice_id ?? null,
          attachments: v.attachments ?? [],
          business_result_accounting: v.business_result_accounting ?? null,
          counts_in_business_result: v.counts_in_business_result ?? true,
          kqkd_amount: Number(v.kqkd_amount ?? v.total_amount) || 0,
          receive_bank_name: v.receive_bank_name ?? null,
          receive_bank_account: v.receive_bank_account ?? null,
          creator_name: v.creator_name ?? null,
          repeat_cycle: v.repeat_cycle ?? "NONE",
          repeat_infinity: !!v.repeat_infinity,
          repeat_count: Number(v.repeat_count ?? 0),
          repeat_remaining: Number(v.repeat_remaining ?? 0),
          repeat_next_date: v.repeat_next_date ?? null,
          repeat_parent_id: v.repeat_parent_id ?? null,
          verified_at: v.verified_at ?? null,
          verified_by: v.verified_by ?? null,
          verified_by_name: v.verified_by_name ?? null,
          verified_note: v.verified_note ?? null,
          items: itemsByVoucherId.get(v.id) ?? [],
          created_at: v.created_at,
          updated_at: v.updated_at,
        });
      }

      // 6. Group voucherIds theo batch
      const voucherIdsByBatch = new Map<string, string[]>();
      for (const link of (links ?? []) as any[]) {
        if (!voucherIdsByBatch.has(link.batch_id)) {
          voucherIdsByBatch.set(link.batch_id, []);
        }
        voucherIdsByBatch.get(link.batch_id)!.push(link.income_expense_id);
      }

      // 7. Build BatchSummary[] từ batches + vouchers
      const summaries: IncomeExpenseBatchSummary[] = [];
      for (const b of batches as any[]) {
        const vIds = voucherIdsByBatch.get(b.id) ?? [];
        const childVouchers = vIds
          .map((id) => voucherMap.get(id))
          .filter((v): v is IncomeExpenseWithRelations => !!v);

        if (childVouchers.length === 0) continue; // batch không có voucher hợp lệ sau filter → bỏ

        const total = childVouchers.reduce(
          (sum, v) => sum + (v.approval_status === "CANCELLED" ? 0 : v.total_amount),
          0
        );
        const buildings = Array.from(
          new Set(childVouchers.map((v) => v.building_name).filter(Boolean))
        );
        const allCancelled = childVouchers.every(
          (v) => v.approval_status === "CANCELLED"
        );
        const hasApproved = childVouchers.some(
          (v) => v.approval_status === "APPROVED"
        );

        const first = childVouchers[0];

        // Apply approval_status filter ở mức batch
        if (filters.approval_status === "APPROVED" && !hasApproved) continue;
        if (filters.approval_status === "CANCELLED" && !allCancelled) continue;
        // ALL_ACTIVE = Đã ghi nhận + Nháp: ẩn batch đã huỷ hoàn toàn
        if (filters.approval_status === "ALL_ACTIVE" && allCancelled) continue;

        summaries.push({
          id: b.id,
          user_id: b.user_id,
          name: b.name,
          type: b.type,
          payer_name: b.payer_name,
          attachments: b.attachments ?? [],
          notes: b.notes,
          created_at: b.created_at,
          voucher_date: first.voucher_date,
          account_id: first.account_id,
          account_name: first.account_name,
          business_result_accounting: first.business_result_accounting,
          creator_name: first.creator_name,
          vouchers: childVouchers,
          voucher_count: childVouchers.length,
          total_amount: total,
          building_names: buildings,
          has_approved: hasApproved,
          all_cancelled: allCancelled,
        });
      }

      // 8. Search client-side trên name + payer_name
      let filtered = summaries;
      if (searchQuery && searchQuery.trim().length > 0) {
        const q = searchQuery.trim().toLowerCase();
        filtered = summaries.filter(
          (s) =>
            s.name.toLowerCase().includes(q) ||
            (s.payer_name && s.payer_name.toLowerCase().includes(q))
        );
      }

      // 9. Pagination
      const totalCount = filtered.length;
      const from = (pagination.page - 1) * pagination.pageSize;
      const paginated = filtered.slice(from, from + pagination.pageSize);

      return { data: paginated, totalCount };
    },
  });
};

// Huỷ tất cả phiếu con của 1 batch (1 click)
export const useCancelIncomeExpenseBatch = () => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (batchId: string) => {
      // 1. Lấy danh sách voucher_id thuộc batch
      const { data: links, error: linkError } = await supabase
        .from("income_expense_batch_items" as any)
        .select("income_expense_id")
        .eq("batch_id", batchId);
      if (linkError) {
        toast.error(linkError.message || "Không thể đọc danh sách phiếu trong đợt");
        throw linkError;
      }
      const ids = ((links ?? []) as any[]).map((l) => l.income_expense_id);
      if (ids.length === 0) return { count: 0 };

      // 2. UPDATE chuyển CANCELLED (chỉ với phiếu đang APPROVED), trả về cả payment_id
      //    để cascade xoá payment hoá đơn tương ứng (nếu có).
      const { data, error } = await supabase
        .from("income_expenses" as any)
        .update({ approval_status: "CANCELLED" })
        .in("id", ids)
        .eq("approval_status", "APPROVED")
        .select("id, type, payment_id");
      if (error) {
        toast.error(error.message || "Không thể huỷ phiếu trong đợt");
        throw error;
      }

      const paymentIdsToDelete = ((data ?? []) as any[])
        .filter((v) => v.type === "INCOME" && v.payment_id)
        .map((v) => v.payment_id);
      if (paymentIdsToDelete.length > 0) {
        const { error: payErr } = await supabase
          .from("payments")
          .delete()
          .in("id", paymentIdsToDelete);
        if (payErr) {
          toast.error(payErr.message || "Không thể rollback thanh toán hoá đơn");
          throw payErr;
        }
      }

      return { count: (data ?? []).length };
    },
    onSuccess: ({ count }) => {
      queryClient.invalidateQueries({ queryKey: ["income-expenses"] });
      queryClient.invalidateQueries({ queryKey: ["income-expense-batches"] });
      queryClient.invalidateQueries({ queryKey: ["accounts-with-balance"] });
      queryClient.invalidateQueries({ queryKey: ["invoices"] });
      queryClient.invalidateQueries({ queryKey: ["invoice"] });
      queryClient.invalidateQueries({ queryKey: ["payments"] });
      queryClient.invalidateQueries({ queryKey: ["invoice-statistics"] });
      toast.success(
        count === 0
          ? "Không còn phiếu nào trong đợt cần huỷ"
          : `Đã huỷ ${count} phiếu trong đợt`
      );
    },
    onError: (error) => {
      console.error("Error cancelling income expense batch:", error);
    },
  });
};

// Đổi sổ quỹ (account_id) đồng loạt cho tất cả phiếu con của 1 batch.
// Dùng cho UI "Sửa sổ quỹ ở phiếu tổng" — chỉ apply khi mọi phiếu con
// đang cùng 1 sổ quỹ (frontend kiểm tra trước khi gọi).
export const useUpdateBatchAccount = () => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (input: { batchId: string; accountId: string }) => {
      const { batchId, accountId } = input;

      const { data: links, error: linkError } = await supabase
        .from("income_expense_batch_items" as any)
        .select("income_expense_id")
        .eq("batch_id", batchId);
      if (linkError) {
        toast.error(linkError.message || "Không đọc được danh sách phiếu");
        throw linkError;
      }
      const ids = ((links ?? []) as any[]).map((l) => l.income_expense_id);
      if (ids.length === 0) return { count: 0 };

      const { data, error } = await supabase
        .from("income_expenses" as any)
        .update({ account_id: accountId })
        .in("id", ids)
        .select("id");
      if (error) {
        toast.error(error.message || "Không cập nhật được sổ quỹ");
        throw error;
      }

      return { count: (data ?? []).length };
    },
    onSuccess: ({ count }) => {
      queryClient.invalidateQueries({ queryKey: ["income-expenses"] });
      queryClient.invalidateQueries({ queryKey: ["income-expense-batches"] });
      queryClient.invalidateQueries({ queryKey: ["accounts-with-balance"] });
      toast.success(`Đã đổi sổ quỹ cho ${count} phiếu trong đợt`);
    },
    onError: (error) => {
      console.error("Error updating batch account:", error);
    },
  });
};

// (Workflow Duyệt/Bỏ duyệt đã bị loại bỏ — phiếu mặc định APPROVED khi tạo,
//  Huỷ thì set CANCELLED qua useCancelIncomeExpense.)

// Dừng lặp lại cho 1 phiếu GỐC: giữ nguyên phiếu + các phiếu con đã sinh,
// chỉ ngừng sinh phiếu con tương lai.
export const useStopRecurring = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase
        .from("income_expenses" as any)
        .update({
          repeat_cycle: "NONE",
          repeat_infinity: false,
          repeat_remaining: 0,
          repeat_next_date: null,
        })
        .eq("id", id);
      if (error) {
        toast.error(error.message || "Không thể dừng lặp lại");
        throw error;
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["income-expenses"] });
      toast.success("Đã dừng lặp lại cho phiếu này");
    },
  });
};

// Sinh các phiếu lặp lại tới hôm nay (RPC).
export const useGenerateRecurringVouchers = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      // RBAC v2: không cần p_user_id; v2 tự lookup các owner caller được phép.
      const { data, error } = await (supabase.rpc as any)(
        "generate_recurring_vouchers_v2",
        {}
      );
      if (error) {
        toast.error(error.message || "Không thể sinh phiếu lặp lại");
        throw error;
      }
      return (data ?? []) as Array<{ parent_id: string; child_id: string; voucher_date: string }>;
    },
    onSuccess: (rows) => {
      queryClient.invalidateQueries({ queryKey: ["income-expenses"] });
      queryClient.invalidateQueries({ queryKey: ["accounts-with-balance"] });
      toast.success(
        rows.length === 0
          ? "Không có phiếu lặp lại đến hạn"
          : `Đã sinh ${rows.length} phiếu lặp lại`
      );
    },
  });
};
