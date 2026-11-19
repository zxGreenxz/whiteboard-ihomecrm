// =============================================================
// Prefetch trang danh sách nặng (Hoá đơn / Thu chi / Hợp đồng / Công việc)
// khi người dùng đứng ở màn chính — vào trang là bảng + ô thống kê hiện NGAY
// thay vì "Đang tải dữ liệu...".
//
// Nguyên tắc sống còn: cache key của prefetch phải TRÙNG key trang sẽ dựng
// lúc mount. Key sinh từ filter persisted trong sessionStorage ("flt:*",
// xem usePersistedState) + mặc định hard-code của từng trang, nên ở đây đọc
// lại đúng các key đó và dựng filter y hệt logic trang. queryKey/queryFn
// lấy từ options factory export trong từng hook (invoicesListQuery…) —
// KHÔNG tự chép lại key.
//
// Trường hợp bỏ qua (trang tự tải như cũ, không hại gì):
// - Ô tìm kiếm persisted là MÃ PHÒNG (cần lookup phòng async → key tạm khác).
// - Mobile đang lọc theo tên phòng (roomName) — cần danh sách rooms để suy
//   room_ids, không đáng kéo cả bảng rooms chỉ để prefetch.
// =============================================================

import type { QueryClient } from "@tanstack/react-query";
import { canUse } from "@/lib/permissionPages";
import { resolveSearch } from "@/lib/roomCodeSearch";
import {
  invoicesListQuery,
  invoiceStatisticsQuery,
} from "@/hooks/useInvoices";
import type { InvoiceFilters, InvoiceStatus } from "@/types/invoice";
import {
  incomeExpensesListQuery,
  incomeExpenseStatsQuery,
  EMPTY_INCOME_EXPENSE_FILTERS,
  type IncomeExpenseFilters,
} from "@/hooks/useIncomeExpenses";
import { contractsPagedQuery, contractStatsQuery } from "@/hooks/useContracts";
import type {
  ContractStatFilter,
  ContractLifecycleFilter,
} from "@/types/contract";
import { jobsQuery } from "@/hooks/useJobs";
import { defaultTaskFilters, type TaskFilters } from "@/types/jobs";

import {
  DESKTOP_LIST_PAGE_SIZE as DESKTOP_PAGE_SIZE,
  MOBILE_FIRST_PAGE_SIZE,
} from "@/lib/listPageSizes";

const isPhoneViewport = () =>
  typeof window !== "undefined" &&
  window.matchMedia("(max-width: 767px)").matches;

/** Đọc filter persisted — cùng cách parse với usePersistedState. */
function readPersisted<T>(key: string, fallback: T): T {
  try {
    const raw = sessionStorage.getItem(key);
    if (raw !== null) return JSON.parse(raw) as T;
  } catch {
    // Giá trị hỏng/khác shape → về mặc định (trang cũng làm vậy).
  }
  return fallback;
}

export type PrefetchDomain =
  | "invoices"
  | "income-expenses"
  | "contracts"
  | "jobs";

// --- Hoá đơn -------------------------------------------------

function prefetchInvoices(qc: QueryClient) {
  if (isPhoneViewport()) {
    const buildingId = readPersisted("flt:invoices-mb:buildingId", "");
    const roomName = readPersisted("flt:invoices-mb:roomName", "all");
    const stat = readPersisted<"all" | InvoiceStatus>(
      "flt:invoices-mb:stat",
      "all",
    );
    const method = readPersisted<InvoiceFilters["payment_method"] | null>(
      "flt:invoices-mb:method",
      null,
    );
    if (roomName !== "all") return; // cần rooms để suy room_ids — để trang tự tải
    // Ô search mobile debounce khởi tạo '' → key ĐẦU TIÊN luôn không search.
    const filters: InvoiceFilters = {
      building_id: buildingId || undefined,
      room_ids: undefined,
      status: stat === "all" ? undefined : stat,
      payment_method: method ?? undefined,
      amount_target: undefined,
      search: undefined,
    };
    qc.prefetchQuery(
      invoicesListQuery(filters, { page: 1, pageSize: MOBILE_FIRST_PAGE_SIZE }),
    );
    // KHÔNG prefetch thẻ thống kê trên mobile: mobile không lọc kỳ nên thống kê là toàn
    // thời gian (tốn nhất), mà chỉ hiện khi người dùng chạm tiêu đề mở sheet "Báo cáo hoá
    // đơn" — lúc đó InvoiceStatsSummary tự tải.
    return;
  }

  const filters = readPersisted<InvoiceFilters>("flt:invoices:filters", {});
  const search = readPersisted("flt:invoices:search", "");
  const parsed = resolveSearch(search, undefined);
  if (parsed.pending) return; // mã phòng — chờ lookup, trang tự tải
  const effective: InvoiceFilters = {
    ...filters,
    room_ids: parsed.roomIds ?? filters.room_ids,
    amount_target: parsed.amountTarget ?? undefined,
    search: parsed.text,
  };
  qc.prefetchQuery(
    invoicesListQuery(effective, { page: 1, pageSize: DESKTOP_PAGE_SIZE }),
  );
  qc.prefetchQuery(
    invoiceStatisticsQuery({
      building_id: filters.building_id,
      building_ids: filters.building_ids,
      room_id:
        filters.room_ids?.length === 1
          ? filters.room_ids[0]
          : filters.room_ids?.length
            ? undefined
            : filters.room_id,
      status: filters.status,
      start_date: filters.date_range?.start,
      end_date: filters.date_range?.end,
      billing_month: filters.billing_month,
      payment_status: filters.payment_status,
    }),
  );
}

// --- Thu chi -------------------------------------------------

function prefetchIncomeExpenses(qc: QueryClient) {
  const mb = isPhoneViewport();
  const filters = readPersisted<IncomeExpenseFilters>(
    mb ? "flt:income-expense-mb:filters" : "flt:income-expense:filters",
    EMPTY_INCOME_EXPENSE_FILTERS,
  );
  // Desktop dùng search persisted NGAY từ render đầu; mobile debounce khởi
  // tạo '' nên key đầu luôn không search.
  const search = mb
    ? ""
    : readPersisted("flt:income-expense:search", "");
  const parsed = resolveSearch(search, undefined);
  if (parsed.pending) return;

  const buildingIds = filters.building_ids ?? [];
  const effective: IncomeExpenseFilters = {
    ...filters,
    building_ids: buildingIds.length ? buildingIds : undefined,
    building_id: buildingIds.length === 1 ? buildingIds[0] : null,
    // B4: khớp default lớp TIỀN THẬT của trang (persisted cũ thiếu key layer).
    layer: filters.layer === undefined ? "CASH" : filters.layer,
    amount_target: parsed.amountTarget,
    room_ids: parsed.roomIds ?? filters.room_ids,
  };
  const pageSize = mb ? MOBILE_FIRST_PAGE_SIZE : DESKTOP_PAGE_SIZE;
  qc.prefetchQuery(
    incomeExpensesListQuery(effective, { page: 1, pageSize }, parsed.text),
  );
  qc.prefetchQuery(incomeExpenseStatsQuery(effective, false));
}

// --- Hợp đồng ------------------------------------------------

function prefetchContracts(qc: QueryClient) {
  // Cả 2 bản trang đều debounce search khởi tạo '' → key đầu không search.
  if (isPhoneViewport()) {
    const buildingId = readPersisted("flt:contracts-mb:buildingId", "");
    const roomName = readPersisted("flt:contracts-mb:roomName", "all");
    const stat = readPersisted<ContractStatFilter>(
      "flt:contracts-mb:stat",
      "ALL",
    );
    qc.prefetchQuery(
      contractsPagedQuery(
        {
          search: undefined,
          building_ids: buildingId ? [buildingId] : undefined,
          room_name: roomName !== "all" ? roomName : undefined,
          lifecycle: stat === "TERMINATED" ? "TERMINATED" : "ACTIVE",
          stat,
        },
        { page: 1, pageSize: MOBILE_FIRST_PAGE_SIZE },
      ),
    );
    qc.prefetchQuery(contractStatsQuery(buildingId ? [buildingId] : []));
    return;
  }

  const stat = readPersisted<ContractStatFilter>("flt:contracts:stat", "ALL");
  const buildingIds = readPersisted<string[]>("flt:contracts:buildingIds", []);
  const roomFilter = readPersisted("flt:contracts:room", "all");
  const lifecycle = readPersisted<ContractLifecycleFilter>(
    "flt:contracts:lifecycle",
    "ACTIVE",
  );
  const month = readPersisted("flt:contracts:month", "");
  qc.prefetchQuery(
    contractsPagedQuery(
      {
        search: undefined,
        building_ids: buildingIds.length > 0 ? buildingIds : undefined,
        room_name: roomFilter !== "all" ? roomFilter : undefined,
        lifecycle,
        stat,
        month: month || undefined,
      },
      { page: 1, pageSize: DESKTOP_PAGE_SIZE },
    ),
  );
  qc.prefetchQuery(contractStatsQuery(buildingIds));
}

// --- Công việc -----------------------------------------------

function prefetchJobs(qc: QueryClient) {
  const applied = readPersisted<TaskFilters>(
    isPhoneViewport() ? "flt:tasks-mb:applied" : "flt:tasks:applied",
    defaultTaskFilters,
  );
  qc.prefetchQuery(jobsQuery(applied));
}

// --- Warm JS chunk của route ---------------------------------
// Cùng specifier resolve với React.lazy trong App.tsx → trúng cùng chunk;
// lỗi mạng nuốt im (trang vẫn lazy-load được như thường).

const warmedChunks = new Set<PrefetchDomain>();

function warmRouteChunk(domain: PrefetchDomain) {
  if (warmedChunks.has(domain)) return;
  warmedChunks.add(domain);
  const mb = isPhoneViewport();
  const swallow = () => {};
  switch (domain) {
    case "invoices":
      import("@/pages/invoices/InvoicesPage").catch(swallow);
      if (mb) import("@/pages/invoices/InvoicesMobilePage").catch(swallow);
      break;
    case "income-expenses":
      import("@/pages/payments/IncomeExpensePage").catch(swallow);
      if (mb) import("@/pages/payments/IncomeExpenseMobilePage").catch(swallow);
      break;
    case "contracts":
      import("@/pages/contracts/ContractsPage").catch(swallow);
      if (mb) import("@/pages/contracts/ContractsMobilePage").catch(swallow);
      break;
    case "jobs":
      import("@/pages/TaskManagementPage").catch(swallow);
      if (mb) import("@/pages/TasksMobilePage").catch(swallow);
      break;
  }
}

// --- API chính -----------------------------------------------

/** Prefetch 1 domain (data + chunk). Realtime hub gọi lại hàm này để giữ
 *  cache luôn ấm sau khi invalidate. Nuốt lỗi — prefetch fail thì trang tự
 *  tải như cũ, không được làm màn chính văng lỗi. */
export function prefetchDomain(qc: QueryClient, domain: PrefetchDomain) {
  try {
    warmRouteChunk(domain);
    switch (domain) {
      case "invoices":
        prefetchInvoices(qc);
        break;
      case "income-expenses":
        prefetchIncomeExpenses(qc);
        break;
      case "contracts":
        prefetchContracts(qc);
        break;
      case "jobs":
        prefetchJobs(qc);
        break;
    }
  } catch (e) {
    console.warn(`prefetch ${domain} lỗi (bỏ qua):`, e);
  }
}

type PermsLike = Parameters<typeof canUse>[0];

/** Module quyền của từng domain — cùng cổng `RequirePermission` của route. */
const MODULE_CUA_DOMAIN: Record<PrefetchDomain, string> = {
  invoices: "invoices",
  "income-expenses": "income_expenses",
  contracts: "contracts",
  jobs: "tasks",
};

export function duocXemDomain(perms: PermsLike, domain: PrefetchDomain): boolean {
  return canUse(perms, MODULE_CUA_DOMAIN[domain], "view");
}

/**
 * Bảng quyền đang hiệu lực, đọc từ cache react-query (query ['my-permissions',
 * <org>] do useMyPermissions nạp).
 *
 * Hub realtime mount ở AppProviders, NGOÀI OrganizationProvider, nên không gọi
 * được useMyPermissions. Cache là nguồn chung: lấy query đang có observer (công
 * ty đang chọn), mới nhất trước; không có thì lấy bản mới nhất bất kỳ.
 */
export function quyenTrongCache(qc: QueryClient): PermsLike | undefined {
  const queries = qc
    .getQueryCache()
    .findAll({ queryKey: ["my-permissions"] })
    .filter((query) => query.state.data !== undefined)
    .sort((a, b) =>
      (b.getObserversCount() > 0 ? 1 : 0) - (a.getObserversCount() > 0 ? 1 : 0)
      || b.state.dataUpdatedAt - a.state.dataUpdatedAt,
    );
  return queries[0]?.state.data as PermsLike | undefined;
}

/**
 * Lượt prefetch do HUB REALTIME kích hoạt (RT-HUB-13, 21/10/2026).
 *
 * Trước đây hub gọi thẳng prefetchDomain: người không có quyền xem hoá đơn, thu
 * chi, HĐ hay công việc vẫn bị nạp danh sách + thống kê của các trang đó mỗi
 * khi có event — RPC trả lỗi quyền hoặc rỗng, tốn một lượt server vô ích.
 *
 * FAIL-CLOSED khi chưa biết quyền: bỏ lượt hâm cache thì trang vẫn tự tải lúc
 * mở (mất phần tiết kiệm), còn đoán bừa là có quyền thì lại đúng lỗi vừa sửa.
 */
export function prefetchDomainTuHub(qc: QueryClient, domain: PrefetchDomain) {
  if (!duocXemDomain(quyenTrongCache(qc), domain)) return;
  prefetchDomain(qc, domain);
}

/** Prefetch mọi domain user có quyền xem (gate = cùng RequirePermission của
 *  route: canUse(module, 'view')). Gọi từ màn chính lúc rảnh.
 *
 *  PHONE: GIÃN mỗi domain 900ms thay vì bắn cả 4 cùng lúc — mỗi domain warm
 *  2 chunk route (desktop + mobile), parse dồn một cục trên iPhone chặn main
 *  thread 1 nhịp dài; nếu trúng lúc entrance fade của màn chính đang chạy →
 *  đứng hình rồi nhảy phắt = "giật màn hình" (bug 04/07). Chia nhỏ để mỗi
 *  nhịp khựng ngắn và rơi vào lúc màn đứng yên (mắt không thấy). */
export function prefetchHeavyPages(
  qc: QueryClient,
  perms: PermsLike,
) {
  const domains = (Object.keys(MODULE_CUA_DOMAIN) as PrefetchDomain[]).filter((domain) =>
    duocXemDomain(perms, domain),
  );

  const gapMs = isPhoneViewport() ? 900 : 0;
  domains.forEach((d, i) => {
    if (gapMs) setTimeout(() => prefetchDomain(qc, d), i * gapMs);
    else prefetchDomain(qc, d);
  });
}
