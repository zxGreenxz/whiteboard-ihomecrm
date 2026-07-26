import { useQuery, keepPreviousData } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { VOUCHER_SOURCES } from "@/lib/voucherSources";
import { monthToStartDate, monthToEndDate } from "@/lib/monthPeriod";
import { getAllIeTypesCached, type IeTypeLite } from "@/lib/ieTypesCache";
import { AMOUNT_SEARCH_TOLERANCE } from "@/lib/roomCodeSearch";
import { fetchAllRows } from "@/lib/supabaseFetchAll";
import type {
  IncomeExpenseFilters,
  IncomeExpenseItem,
  IncomeExpenseWithRelations,
  IncomeExpenseAuditLog,
  IncomeExpenseBatchSummary,
} from "./types";

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

// Khoảng ngày của filter "kỳ áp dụng": [đầu-tháng-start, cuối-tháng-end].
// Nếu chỉ có 1 đầu, coi khoảng = đúng tháng đó (start=end).
// Trả null nếu không có filter kỳ.
function periodRangeFromFilters(
  periodStartMonth?: string | null,
  periodEndMonth?: string | null
): { start: string; end: string } | null {
  if (!periodStartMonth && !periodEndMonth) return null;
  const startM = periodStartMonth || periodEndMonth!;
  const endM = periodEndMonth || periodStartMonth!;
  return {
    start: monthToStartDate(startM), // 'YYYY-MM-01'
    end: monthToEndDate(endM), // ngày cuối tháng
  };
}

// Trả về danh sách voucher_id có ÍT NHẤT 1 item mà kỳ áp dụng [start_date,
// end_date] GIAO với khoảng [periodStartMonth, periodEndMonth] (theo tháng).
// Overlap: item.start_date <= cuối-tháng-periodEnd AND item.end_date >= đầu-tháng-periodStart.
// Chỉ xét item CÓ kỳ (item null-period bị loại — "lọc kỳ" ngụ ý item đã gán kỳ).
// Trả null nếu không có filter kỳ; [] nếu có filter nhưng không voucher nào match.
//
// CHỈ dùng cho stats RPC: p_voucher_ids đi qua POST body nên không dính giới
// hạn URL. List/batches lọc kỳ qua embedded inner-join (ITEM_PERIOD_INNER_JOIN)
// thay vì `.in("id", [...])` — cùng bài học URL-400 của ITEM_TYPE_INNER_JOIN.
// fetchAllRows vì bảng item vượt 1000 dòng là danh sách voucher bị cắt âm thầm;
// lỗi tải THROW để React Query hiện lỗi thật, không thành "rỗng" giả.
async function getVoucherIdsByItemPeriod(
  periodStartMonth?: string | null,
  periodEndMonth?: string | null
): Promise<string[] | null> {
  const range = periodRangeFromFilters(periodStartMonth, periodEndMonth);
  if (!range) return null;

  const rows = await fetchAllRows<{ income_expense_id: string }>(
    (from, to) =>
      supabase
        .from("income_expense_items")
        .select("income_expense_id")
        .not("start_date", "is", null)
        .not("end_date", "is", null)
        .lte("start_date", range.end)
        .gte("end_date", range.start)
        .order("id", { ascending: true }) // id PK = order ổn định cho phân trang
        .range(from, to),
    { label: "ie-period-voucher-ids" }
  );
  if (rows === null) {
    throw new Error("getVoucherIdsByItemPeriod: lỗi tải item theo kỳ áp dụng");
  }
  return Array.from(new Set(rows.map((r) => r.income_expense_id)));
}

// Fragment thêm vào select để lọc hạng mục qua embedded INNER join trên
// income_expense_items: phiếu chỉ lọt khi có ≥1 item thuộc type sibling đã chọn.
// Embed KHÔNG nhân đôi dòng cha (PostgREST trả nested) và KHÔNG nhồi UUID vào URL
// → tránh hẳn lỗi 400 "URL quá dài" của cách `.in("id", [hàng trăm id])` cũ.
const ITEM_TYPE_INNER_JOIN =
  ", _itemTypeFilter:income_expense_items!inner(income_expense_type_id)";

// Fragment lọc "kỳ áp dụng" — embed thứ hai với alias RIÊNG: mỗi embed !inner
// là một EXISTS độc lập, giữ đúng ngữ nghĩa GIAO của bản cũ ("có ≥1 item đúng
// hạng mục" VÀ "có ≥1 item giao kỳ" — không bắt buộc cùng 1 item). Trước đây
// nhánh kỳ resolve ra voucher_id rồi `.in("id", [...])` → vừa dính cap 1000 khi
// đếm item, vừa nhồi hàng nghìn UUID vào URL GET (nguồn lỗi 400 đã có án lệ).
const ITEM_PERIOD_INNER_JOIN =
  ", _periodFilter:income_expense_items!inner(start_date, end_date)";

// Kế hoạch lọc cấp item (hạng mục + kỳ áp dụng) cho query income_expenses.
type ItemFilterPlan = {
  // true = filter cấp item chắc chắn rỗng → caller trả kết quả rỗng ngay.
  empty: boolean;
  // null = không lọc hạng mục; ngược lại tập type_id sibling (NHỎ) áp qua
  // embedded inner-join (_itemTypeFilter.income_expense_type_id).
  typeSiblingIds: string[] | null;
  // null = không lọc kỳ; ngược lại khoảng ngày áp lên embed _periodFilter.
  periodRange: { start: string; end: string } | null;
};

// Gộp filter cấp item. Kết hợp hạng mục + kỳ (2 embed inner-join độc lập) trên
// cùng query = GIAO, giữ đúng ngữ nghĩa intersection của bản cũ.
async function planItemFilters(
  filters: IncomeExpenseFilters
): Promise<ItemFilterPlan> {
  const typeSiblingIds = await getItemTypeSiblingIds(filters);
  const periodRange = periodRangeFromFilters(
    filters.period_start_month,
    filters.period_end_month
  );
  const empty = typeSiblingIds !== null && typeSiblingIds.length === 0;
  return { empty, typeSiblingIds, periodRange };
}

// Phần nối thêm vào chuỗi select khi có lọc cấp item.
function itemFilterJoinSelect(plan: ItemFilterPlan): string {
  return (
    (plan.typeSiblingIds !== null ? ITEM_TYPE_INNER_JOIN : "") +
    (plan.periodRange !== null ? ITEM_PERIOD_INNER_JOIN : "")
  );
}

// Áp filter cấp item lên một query income_expenses đã khởi tạo.
function applyItemFilterToQuery<T>(query: T, plan: ItemFilterPlan): T {
  let q = query as any;
  if (plan.typeSiblingIds !== null) {
    q = q.in("_itemTypeFilter.income_expense_type_id", plan.typeSiblingIds);
  }
  if (plan.periodRange !== null) {
    // Item null-period bị loại ("lọc kỳ" ngụ ý item đã gán kỳ). lte/gte với
    // NULL vốn đã false — giữ .not is null cho tường minh ngữ nghĩa.
    q = q
      .not("_periodFilter.start_date", "is", null)
      .not("_periodFilter.end_date", "is", null)
      .lte("_periodFilter.start_date", plan.periodRange.end)
      .gte("_periodFilter.end_date", plan.periodRange.start);
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
        .from("income_expenses")
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
      } else if (filters.approval_status === "APPROVED_UNPOSTED") {
        // V2 §12.1: Đã duyệt - CHƯA thu/chi (posting_status NULL = phiếu cũ
        // chưa backfill, tương đương UNPOSTED về ngữ nghĩa hiển thị).
        // posting_status chưa có trong generated types → cast như các cột V2 khác.
        query = (query as any)
          .eq("approval_status", "APPROVED")
          .or("posting_status.eq.UNPOSTED,posting_status.is.null");
      } else if (filters.approval_status === "POSTED") {
        query = (query as any).eq("posting_status", "POSTED");
      } else if (filters.approval_status === "REVERSED") {
        query = (query as any).eq("posting_status", "REVERSED");
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
        .from("income_expense_items")
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
          // Finance V2 (§12.1): 4 trục + version — thiếu các field này là toàn bộ
          // UI route-aware (dialog 2 nút, badge composite) âm thầm rơi về LEGACY.
          organization_id: v.organization_id ?? null,
          posting_mode: v.posting_mode ?? null,
          posting_status: v.posting_status ?? null,
          review_state: v.review_state ?? null,
          approval_version: Number(v.approval_version ?? 1),
          posting_version: Number(v.posting_version ?? 1),
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
          shareholder_id: v.shareholder_id ?? null,
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
//
// options.keepPreviousData: OPT-IN, MẶC ĐỊNH TẮT. Chỉ bật ở màn Thu chi (bảng
// phân trang, đổi trang/filter liên tục) để bảng không nhảy về skeleton. TUYỆT
// ĐỐI không bật cho consumer báo cáo tiền chỉ gate bằng isLoading (Phân bổ lợi
// nhuận, tab Chi phí): giữ-data-cũ ở đó = hiện SỐ KỲ CŨ dưới nhãn kỳ MỚI suốt
// thời gian fetch, không chỉ báo nào.
export const useIncomeExpenses = (
  filters: IncomeExpenseFilters,
  pagination: { page: number; pageSize: number },
  searchQuery?: string,
  options?: { enabled?: boolean; keepPreviousData?: boolean }
) => {
  return useQuery({
    ...incomeExpensesListQuery(filters, pagination, searchQuery),
    enabled: options?.enabled ?? true,
    placeholderData: options?.keepPreviousData ? keepPreviousData : undefined,
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
      // Kỳ áp dụng: RPC vẫn cần danh sách voucher_id (p_voucher_ids) — đi qua
      // POST body nên không dính giới hạn URL như `.in()` trên GET.
      const [itemPlan, periodVoucherIds] = await Promise.all([
        planItemFilters(filters),
        getVoucherIdsByItemPeriod(
          filters.period_start_month,
          filters.period_end_month
        ),
      ]);
      if (
        itemPlan.empty ||
        (periodVoucherIds !== null && periodVoucherIds.length === 0)
      ) {
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
          // V2 composite (§12.1): pseudo-value tách thành approval + posting.
          p_approval:
            filters.approval_status === 'APPROVED_UNPOSTED'
              ? 'APPROVED'
              : filters.approval_status === 'POSTED' ||
                  filters.approval_status === 'REVERSED'
                ? 'ALL_ACTIVE'
                : (filters.approval_status ?? 'ALL_ACTIVE'),
          p_posting:
            filters.approval_status === 'APPROVED_UNPOSTED'
              ? 'UNPOSTED'
              : filters.approval_status === 'POSTED' ||
                  filters.approval_status === 'REVERSED'
                ? filters.approval_status
                : null,
          p_creator_id: filters.creator_id ?? null,
          p_amount: filters.amount_target ?? null,
          p_amount_tol: AMOUNT_SEARCH_TOLERANCE,
          p_verified: filters.verified_status ?? null,
          p_item_type_ids: itemPlan.typeSiblingIds,
          p_voucher_ids: periodVoucherIds,
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

// opts.keepPreviousData: OPT-IN, MẶC ĐỊNH TẮT — cùng ràng buộc như
// useIncomeExpenses. Bật ở màn Thu chi để 3 thẻ tổng không nháy về 0; KHÔNG bật
// ở báo cáo Phân bổ lợi nhuận / tab Chi phí (đổi tháng/toà là số kỳ cũ đứng
// dưới nhãn kỳ mới).
export const useIncomeExpenseStats = (
  filters: IncomeExpenseFilters,
  opts?: { businessResultOnly?: boolean; keepPreviousData?: boolean }
) => {
  const businessResultOnly = opts?.businessResultOnly ?? false;
  return useQuery({
    ...incomeExpenseStatsQuery(filters, businessResultOnly),
    placeholderData: opts?.keepPreviousData ? keepPreviousData : undefined,
  });
};

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

// Danh sách phiếu tổng (group by batch_id)
// options.enabled: trang Thu chi gate theo viewMode — chỉ fetch khi user đang
// xem tab Phiếu tổng (batches KHÔNG được prefetch nên gate không phí request).
// keepPreviousData giữ ở MỨC HOOK (khác 2 hook trên): consumer duy nhất là màn
// Thu chi (IncomeExpensePage + IncomeExpenseMobilePage) — bảng phân trang, không
// có consumer báo cáo tiền nào đọc hook này.
export const useIncomeExpenseBatches = (
  filters: IncomeExpenseFilters,
  pagination: { page: number; pageSize: number },
  searchQuery?: string,
  options?: { enabled?: boolean }
) => {
  return useQuery({
    enabled: options?.enabled ?? true,
    // Giữ trang cũ khi đổi filter/search/trang để bảng không nhảy về skeleton.
    placeholderData: keepPreviousData,
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

      // Cap 1000 dòng của PostgREST + `.in()` quá dài trả 400: batch/link/phiếu
      // con đều tích luỹ vô hạn (tenant thật đã ~1.356 phiếu) nên mọi tầng dưới
      // đây đều fetchAllRows và/hoặc chunk `.in()` (mẫu useInvoiceCollectors).
      // Lỗi tải ở bất kỳ tầng nào đều THROW — trả rỗng là màn "không có phiếu
      // tổng" GIẢ kèm tổng tiền sai.
      const CHUNK = 100;
      const chunkIds = (ids: string[]): string[][] => {
        const out: string[][] = [];
        for (let i = 0; i < ids.length; i += CHUNK) out.push(ids.slice(i, i + CHUNK));
        return out;
      };

      // 1. Lấy batches (kèm filter type nếu có)
      const batches = await fetchAllRows<any>(
        (from, to) => {
          let batchQuery = supabase
            .from("income_expense_batches")
            .select("*")
            .is("deleted_at", null)
            .order("created_at", { ascending: false })
            .order("id", { ascending: false }); // tiebreaker duy nhất cho phân trang ổn định
          if (filters.type) batchQuery = batchQuery.eq("type", filters.type);
          return batchQuery.range(from, to);
        },
        { label: "ie-batches" }
      );
      if (batches === null) {
        throw new Error("useIncomeExpenseBatches: lỗi tải danh sách phiếu tổng");
      }
      if (batches.length === 0) {
        return { data: [], totalCount: 0 };
      }

      const batchIds = (batches as any[]).map((b: any) => b.id);

      // 2. Lấy junction rows — chunk theo batch_id, và fetchAllRows từng chunk
      //    vì 100 batch vẫn có thể chứa >1000 link.
      const linkChunks = await Promise.all(
        chunkIds(batchIds).map((ids) =>
          fetchAllRows<{ batch_id: string; income_expense_id: string }>(
            (from, to) =>
              supabase
                .from("income_expense_batch_items")
                .select("batch_id, income_expense_id")
                .in("batch_id", ids)
                // PK (batch_id, income_expense_id) = order ổn định duy nhất
                .order("batch_id", { ascending: true })
                .order("income_expense_id", { ascending: true })
                .range(from, to),
            { label: "ie-batch-links" }
          )
        )
      );
      const links: { batch_id: string; income_expense_id: string }[] = [];
      for (const chunk of linkChunks) {
        if (chunk === null) {
          throw new Error("useIncomeExpenseBatches: lỗi tải liên kết batch↔phiếu");
        }
        links.push(...chunk);
      }

      const voucherIds = links.map((l) => l.income_expense_id);
      if (voucherIds.length === 0) {
        // Có batch nhưng không có voucher con → không hiển thị
        return { data: [], totalCount: 0 };
      }

      // 3. Lấy phiếu con (kèm joins) + filter — chunk `.in("id")`: mỗi chunk
      //    ≤100 id (id là PK) nên không thể chạm cap 1000.
      const buildVoucherChunkQuery = (ids: string[]) => {
        let voucherQuery = supabase
          .from("income_expenses")
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
          .in("id", ids);

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
        return voucherQuery;
      };

      const voucherResults = await Promise.all(
        chunkIds(voucherIds).map((ids) => buildVoucherChunkQuery(ids))
      );
      const vouchers: any[] = [];
      for (const r of voucherResults) {
        if (r.error) {
          console.error("useIncomeExpenseBatches voucher error:", r.error);
          throw r.error;
        }
        vouchers.push(...((r.data ?? []) as any[]));
      }

      // 4. Lấy items của tất cả phiếu con — chunk + fetchAllRows (100 phiếu có
      //    thể có >1000 item).
      const fetchedVoucherIds = vouchers.map((v) => v.id);
      const itemChunks = await Promise.all(
        chunkIds(fetchedVoucherIds).map((ids) =>
          fetchAllRows<any>(
            (from, to) =>
              supabase
                .from("income_expense_items")
                .select(
                  `
          *,
          income_expense_type:income_expense_types!income_expense_items_income_expense_type_id_fkey ( id, name, category, is_deposit )
        `
                )
                .in("income_expense_id", ids)
                .order("id", { ascending: true }) // id PK = order ổn định
                .range(from, to),
            { label: "ie-batch-voucher-items" }
          )
        )
      );
      const allItems: any[] = [];
      for (const chunk of itemChunks) {
        if (chunk === null) {
          throw new Error("useIncomeExpenseBatches: lỗi tải chi tiết phiếu con");
        }
        allItems.push(...chunk);
      }

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
      for (const v of vouchers) {
        voucherMap.set(v.id, {
          id: v.id,
          user_id: v.user_id,
          organization_id: v.organization_id ?? null,
          posting_mode: v.posting_mode ?? null,
          posting_status: v.posting_status ?? null,
          review_state: v.review_state ?? null,
          approval_version: Number(v.approval_version ?? 1),
          posting_version: Number(v.posting_version ?? 1),
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
          shareholder_id: v.shareholder_id ?? null,
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
      for (const link of links) {
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
        // Pseudo V2 (composite) ở mức batch: gần đúng theo "có phiếu đã duyệt".
        if (
          (filters.approval_status === "APPROVED_UNPOSTED" ||
            filters.approval_status === "POSTED" ||
            filters.approval_status === "REVERSED") &&
          !hasApproved
        )
          continue;
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
