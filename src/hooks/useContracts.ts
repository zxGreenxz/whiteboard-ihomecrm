import {matchesContractMoneyReceipt} from '@/lib/contractMoneyReceipt';
import {persistentFinancialWorkflow} from '@/lib/persistentFinancialWorkflow';
import {sameContractFields,type ContractRelationWriteProgress} from '@/lib/contractEditWorkflow';
import {sameContractCustomers,sameContractServices} from '@/lib/contractRelationReconcile';
import {financialReadRows,financialReadNumber} from '@/lib/financialReadValidation';
import { useQuery, useMutation, useQueryClient, keepPreviousData } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { getSessionUser } from "@/lib/authSession";
import { fetchAllRows } from "@/lib/supabaseFetchAll";
import { isCanonicalFallbackSignal } from "@/lib/canonicalFallback";
import { toast } from "sonner";
import { contractCreateFeedback, isContractTemplateSettingError } from "@/lib/contractFeedback";
import { friendlyError } from '@/lib/friendlyError';
import { assertImportedContractRelations } from "@/lib/contractImportOutcome";
import { markLocalWrite } from "@/hooks/useRealtimeDataSync";
import { useOrganization } from "@/contexts/OrganizationContext";
import { withOrg, withOrgAll } from "@/lib/orgPayload";
import {
  createContractV2,
  buildCreateContractRpcArgs,
  type ContractCreateRequest,
} from "@/lib/contractCreateRpc";
import type {
  Contract,
  ContractWithRelations,
  ContractStats,
  ContractStatus,
  ContractStatFilter,
  ContractLifecycleFilter,
  PaymentCycle,
} from "@/types/contract";

export type {
  ContractCreatePayload,
  ContractCreatePayload as CreateContractPayload,
  ContractCreateRequest,
} from "@/lib/contractCreateRpc";

export interface UpdateContractPayload {
  room_id?: string;
  signed_date?: string;
  start_date?: string;
  end_date?: string;
  rent_price?: number;
  total_deposit?: number;
  deposit_paid?: number;
  payment_cycle?: PaymentCycle;
  start_billing_date?: string | null;
  end_billing_date?: string | null;
  contract_template_id?: string | null;
  invoice_template_id?: string | null;
  notes?: string | null;
  discounts?: { months: number; amount_per_month: number } | null;
  expected_move_out_date?: string | null;
  status?: string;
}

// Re-export types for backward compatibility
export type { ContractWithRelations } from "@/types/contract";

// =============================================
// Supabase select string for contracts with full relations
// =============================================

const CONTRACT_SELECT = `
  *,
  room:rooms!contracts_room_id_fkey (
    id, name, building_id,
    building:buildings!rooms_building_id_fkey (
      id, name, type,
      street_address, ward, district, province
    )
  ),
  contract_customers!contract_customers_contract_id_fkey (
    id, contract_id, customer_id, is_representative, notes, created_at, updated_at,
    customer:customers!contract_customers_customer_id_fkey (
      id, full_name, phone, email, id_number, id_images,
      date_of_birth, gender, id_issue_date, id_issue_place,
      province, district, ward, detailed_address,
      current_residence, permanent_address,
      occupation, workplace,
      contact_person, contact_person_phone,
      bank_account_number, bank_name,
      fingerprint_code, is_foreign
    )
  ),
  contract_services (
    id, contract_id, service_id, unit_price, initial_reading, created_at, updated_at,
    service:services (
      id, name, unit, type, pricing_type
    )
  )
`;

// =============================================
// useContracts — Query all contracts with relations
// Requirements: 2.11, 2.13, 3.1
//
// opts.statuses (optional, backward-compatible): lọc status server-side bằng
// .in('status', ...) — các dialog chỉ cần HĐ ACTIVE (GenerateInvoiceDialog,
// AssetHandoverDialog) nên truyền { statuses: ['ACTIVE'] } để không kéo cả
// bảng. Không truyền → giữ nguyên hành vi cũ (fetch tất cả).
// =============================================

// Select rút gọn cho 2 dialog consumer duy nhất (GenerateInvoiceDialog +
// AssetHandoverDialog): đúng cột dialog đọc, bỏ full-PII khách (CMND/STK/
// địa chỉ…) của CONTRACT_SELECT. Cần thêm cột → dùng useContract(id) (select đủ).
const CONTRACT_DIALOG_SELECT = `
  id, status, room_id, rent_price, contract_number, discounts,
  room:rooms!contracts_room_id_fkey ( id, name, building_id ),
  contract_customers!contract_customers_contract_id_fkey (
    id, is_representative,
    customer:customers!contract_customers_customer_id_fkey ( id, full_name )
  ),
  contract_services (
    id, service_id, unit_price,
    service:services ( id, name, pricing_type )
  )
`;

export const useContracts = (opts?: {
  statuses?: ContractStatus[];
  // enabled: cho dialog mounted-sẵn-nhưng-đóng gate fetch (vd GenerateInvoiceDialog)
  // — tránh kéo cả bảng HĐ full-PII mỗi lần tải trang. Default true.
  enabled?: boolean;
}) => {
  return useQuery({
    enabled: opts?.enabled ?? true,
    queryKey: opts?.statuses?.length
      ? ["contracts", { statuses: opts.statuses }]
      : ["contracts"],
    queryFn: async (): Promise<ContractWithRelations[]> => {
      const user = await getSessionUser();
      if (!user) throw new Error("Not authenticated");

      // PAGED: org thật tiến sát trần 1000 HĐ ACTIVE — không phân trang là
      // GenerateInvoiceDialog sinh THIẾU hoá đơn âm thầm (bug cap-1000).
      const data = await fetchAllRows<ContractWithRelations>(
        (from, to) => {
          let query = supabase
            .from("contracts")
            .select(CONTRACT_DIALOG_SELECT)
            .is("deleted_at", null);

          if (opts?.statuses?.length) {
            query = query.in("status", opts.statuses);
          }

          return query
            .order("created_at", { ascending: false })
            .order("id", { ascending: true }) // tiebreaker cho .range() ổn định
            .range(from, to);
        },
        { label: "contracts.dialog" },
      );

      // fetchAllRows fail-closed: null = lỗi query → throw cho React Query retry.
      if (data === null) throw new Error("Lỗi tải danh sách hợp đồng");
      return data;
    },
  });
};

// =============================================
// useContractsPaged — danh sách HĐ phân trang SERVER-SIDE cho ContractsPage.
//
// Khác useContracts():
// - SELECT rút gọn (CONTRACT_LIST_SELECT): KHÔNG kéo CMND/STK/nghề nghiệp/
//   địa chỉ khách, KHÔNG kéo contract_services. Màn danh sách chỉ cần tên
//   khách + SĐT + phòng/toà. Chi tiết/sửa/in dùng useContract(id) (select đủ).
// - .range() + count: 'exact' → không bị PostgREST max-rows (1000) cắt ngầm.
// - Filters đẩy xuống server (xem ContractPagedFilters).
// =============================================

export interface ContractPagedFilters {
  /** Tìm theo mã HĐ / tên khách / SĐT / tên phòng (resolve id trước, xem resolveContractSearchOr). */
  search?: string;
  /** Lọc nhiều toà nhà; rỗng/undefined = tất cả. */
  building_ids?: string[];
  /** Lọc theo TÊN phòng (gộp phòng cùng tên mọi toà — giữ hành vi cũ của trang). */
  room_name?: string;
  /** ALL | ACTIVE (tất cả trừ TERMINATED) | TERMINATED. */
  lifecycle?: ContractLifecycleFilter;
  /** Ô stat đang chọn: ALL | EXPIRING | EXPIRED | TERMINATED (map display-status sang điều kiện ngày/status). */
  stat?: ContractStatFilter;
  /** 'YYYY-MM' — HĐ có khoảng hiệu lực giao với tháng này. */
  month?: string;
}

export interface ContractPagedParams {
  page: number;
  pageSize: number;
}

/** Select rút gọn cho danh sách. innerRoom=true khi cần lọc theo toà/tên phòng
 *  (rooms!inner để điều kiện trên bảng con lọc được dòng cha). */
// HAI HẰNG LITERAL, không phải một hàm ghép chuỗi.
//
// supabase-js suy kiểu của `.select()` bằng cách PHÂN TÍCH CHUỖI LITERAL lúc
// biên dịch. Một chuỗi dựng động (template literal có `${}`) chỉ là `string`,
// nên bộ suy kiểu bó tay và trả `GenericStringError[]` — kiểu "tôi không đọc
// được select này". Đó chính là lý do chỗ gọi phải ép `as ContractWithRelations[]`,
// và cái ép đó nuốt luôn mọi sai sót thật trong chuỗi select.
//
// Cùng gốc bệnh với việc truyền tên RPC qua biến `string` (xem
// src/lib/customerCreditRpc.ts): giá trị đi qua một tham số rộng thì kiểu chết
// tại đó. Cách chữa cũng giống: giữ literal.
//
// Hai biến thể chỉ khác đúng `!inner` — cần khi lọc theo toà/tên phòng, vì điều
// kiện trên bảng con phải lọc được dòng cha.
const CONTRACT_LIST_SELECT = `
  *,
  room:rooms!contracts_room_id_fkey (
    id, name, building_id,
    building:buildings!rooms_building_id_fkey ( id, name )
  ),
  contract_customers!contract_customers_contract_id_fkey (
    id, contract_id, customer_id, is_representative,
    customer:customers!contract_customers_customer_id_fkey ( id, full_name, phone )
  )
` as const;

const CONTRACT_LIST_SELECT_INNER_ROOM = `
  *,
  room:rooms!contracts_room_id_fkey!inner (
    id, name, building_id,
    building:buildings!rooms_building_id_fkey ( id, name )
  ),
  contract_customers!contract_customers_contract_id_fkey (
    id, contract_id, customer_id, is_representative,
    customer:customers!contract_customers_customer_id_fkey ( id, full_name, phone )
  )
` as const;

const buildContractListSelect = (innerRoom: boolean) =>
  innerRoom ? CONTRACT_LIST_SELECT_INNER_ROOM : CONTRACT_LIST_SELECT;

const toLocalISODate = (d: Date): string =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

/** Bỏ ký tự phá cú pháp or() của PostgREST (dấu phẩy, ngoặc, nháy, %, \). */
const sanitizeSearchTerm = (term: string): string =>
  term.replace(/[,()"'\\%]/g, " ").replace(/\s+/g, " ").trim();

/**
 * Search server-side: PostgREST không or() được giữa cột bảng cha và bảng
 * con, nên resolve trước: tên/SĐT khách → customer ids → contract ids (qua
 * contract_customers), tên phòng → room ids; rồi gộp thành 1 biểu thức
 * or(contract_number.ilike, id.in, room_id.in) cho query chính.
 * Giới hạn 200 khách / 200 phòng / 500 dòng contract_customers mỗi lần —
 * term quá chung chung (vd "a") có thể thiếu kết quả ngoài cap.
 */
async function resolveContractSearchOr(rawTerm: string): Promise<string | null> {
  const safe = sanitizeSearchTerm(rawTerm);
  if (!safe) return null;
  const star = `*${safe}*`;
  const pattern = `%${safe}%`;
  const orParts: string[] = [`contract_number.ilike.${star}`];

  // 2 nhánh độc lập chạy song song: (khách → HĐ) và (tên phòng) — trước đây
  // chạy nối tiếp làm mỗi lần gõ search chờ 3 round-trip liên tiếp.
  const [contractIds, roomIds] = await Promise.all([
    // Tên khách / SĐT → contract ids (2 bước phụ thuộc nhau, giữ tuần tự).
    (async (): Promise<string[]> => {
      const { data: custs } = await supabase
        .from("customers")
        .select("id")
        .or(`full_name.ilike.${star},phone.ilike.${star}`)
        .limit(200);
      const custIds = (custs || []).map((c: any) => c.id);
      if (custIds.length === 0) return [];
      const { data: ccs } = await supabase
        .from("contract_customers")
        .select("contract_id")
        .in("customer_id", custIds)
        .limit(500);
      return Array.from(
        new Set((ccs || []).map((r: any) => r.contract_id).filter(Boolean)),
      );
    })(),
    // Tên phòng → room ids.
    (async (): Promise<string[]> => {
      const { data: rms } = await supabase
        .from("rooms")
        .select("id")
        .ilike("name", pattern)
        .limit(200);
      return (rms || []).map((r: any) => r.id);
    })(),
  ]);

  if (contractIds.length > 0) {
    orParts.push(`id.in.(${contractIds.join(",")})`);
  }
  if (roomIds.length > 0) {
    orParts.push(`room_id.in.(${roomIds.join(",")})`);
  }

  return orParts.join(",");
}

/** Query 1 trang (hoặc 1 khúc .range cho export). Dùng chung bởi
 *  useContractsPaged + fetchContractsForExport để filter luôn nhất quán. */
async function fetchContractsPagedOnce(
  filters: ContractPagedFilters | undefined,
  range: { from: number; to: number } | null,
): Promise<PaginatedData<ContractWithRelations>> {
  const user = await getSessionUser();
  if (!user) throw new Error("Not authenticated");

  const needInnerRoom = !!(
    filters?.building_ids?.length ||
    (filters?.room_name && filters.room_name !== "all")
  );

  let query = supabase
    .from("contracts")
    .select(buildContractListSelect(needInnerRoom), { count: "exact" })
    .is("deleted_at", null)
    .order("created_at", { ascending: false });

  // Vòng đời: ACTIVE = "đang ở" = tất cả trừ thanh lý.
  if (filters?.lifecycle === "ACTIVE") {
    query = query.neq("status", "TERMINATED");
  } else if (filters?.lifecycle === "TERMINATED") {
    query = query.eq("status", "TERMINATED");
  }

  // Stat filter — map getContractDisplayStatus sang điều kiện server:
  // EXPIRING/EXPIRED yêu cầu không TERMINATED/TRANSFERRED/DRAFT và không có
  // expected_move_out_date (MOVING_OUT ưu tiên hơn trong display status).
  const today = toLocalISODate(new Date());
  if (filters?.stat === "TERMINATED") {
    query = query.eq("status", "TERMINATED");
  } else if (filters?.stat === "EXPIRING" || filters?.stat === "EXPIRED") {
    query = query
      .not("status", "in", "(TERMINATED,TRANSFERRED,DRAFT)")
      .is("expected_move_out_date", null);
    if (filters.stat === "EXPIRED") {
      query = query.lt("end_date", today);
    } else {
      const in30 = new Date();
      in30.setDate(in30.getDate() + 30);
      query = query.gte("end_date", today).lte("end_date", toLocalISODate(in30));
    }
  }

  if (filters?.building_ids?.length) {
    query = query.in("room.building_id", filters.building_ids);
  }
  if (filters?.room_name && filters.room_name !== "all") {
    query = query.eq("room.name", filters.room_name);
  }

  // Tháng: khoảng [start_date, end_date] giao với tháng được chọn.
  if (filters?.month && /^\d{4}-\d{2}$/.test(filters.month)) {
    const [y, m] = filters.month.split("-").map(Number);
    const monthStart = `${filters.month}-01`;
    const monthEnd = toLocalISODate(new Date(y, m, 0));
    query = query.lte("start_date", monthEnd).gte("end_date", monthStart);
  }

  if (filters?.search?.trim()) {
    const orFilter = await resolveContractSearchOr(filters.search);
    if (orFilter) query = query.or(orFilter);
  }

  if (range) {
    query = query.range(range.from, range.to);
  }

  const { data, error, count } = await query;
  if (error) {
    console.error("useContractsPaged error:", error);
    throw error;
  }

  if(typeof count!=="number"||!Number.isSafeInteger(count)||count<0)throw new TypeError("Chưa xác nhận được tổng số hợp đồng.");
  return {
 // ContractWithRelations là kiểu VIẾT TAY, hẹp hơn hình dạng thật DB trả (một
    // số cột nullable ở DB được khai không-null ở đây, và quan hệ lồng khác cách
    // biểu diễn). Khẳng định qua  là hẹp và CÓ KIỂM SOÁT: chuỗi select
    // ngay phía trên nay đã được kiểm kiểu thật (literal, không dựng động), nên
    // tên bảng/cột sai sẽ đỏ. Cái ép cũ  tắt kiểm cho TOÀN BỘ
    // câu lệnh — hai thứ khác hẳn nhau.
    // Việc hoà giải kiểu viết tay với kiểu sinh từ DB là một lượt riêng, đã ghi
    // vào known-gaps: contract-type-handwritten-drift.
    data: financialReadRows(data) as unknown as ContractWithRelations[],
    count,
  };
}

// Options factory dùng chung cho hook + prefetch (src/lib/prefetchPages.ts)
// — queryKey/queryFn 1 nguồn duy nhất, prefetch lệch key là vô dụng.
export const contractsPagedQuery = (
  filters?: ContractPagedFilters,
  pagination?: ContractPagedParams,
) => ({
  queryKey: ["contracts", "paged", filters ?? null, pagination ?? null] as const,
  gcTime: 15 * 60_000, // ấm lâu cho prefetch (mặc định 5' hay bị GC trước khi bấm)
  queryFn: async (): Promise<PaginatedData<ContractWithRelations>> => {
    const range = pagination
      ? {
          from: (pagination.page - 1) * pagination.pageSize,
          to: (pagination.page - 1) * pagination.pageSize + pagination.pageSize - 1,
        }
      : null;
    return fetchContractsPagedOnce(filters, range);
  },
});

export const useContractsPaged = (
  filters?: ContractPagedFilters,
  pagination?: ContractPagedParams,
) => {
  return useQuery({
    ...contractsPagedQuery(filters, pagination),
    // Giữ trang cũ khi đổi filter/trang để bảng không nhảy về "Đang tải".
    placeholderData: keepPreviousData,
  });
};

/**
 * Export Excel cần TOÀN BỘ kết quả theo filter (không chỉ trang hiện tại):
 * loop .range() từng khúc 1000 (trần max-rows của PostgREST) tới khi đủ count.
 * maxRows chặn trên để không kéo vô hạn nếu dữ liệu quá lớn.
 */
export async function fetchContractsForExport(
  filters?: ContractPagedFilters,
  maxRows = 10000,
): Promise<ContractWithRelations[]> {
  const chunk = 1000;
  const all: ContractWithRelations[] = [];
  for (let from = 0; from < maxRows; from += chunk) {
    const { data, count } = await fetchContractsPagedOnce(filters, {
      from,
      to: from + chunk - 1,
    });
    all.push(...data);
    if (data.length < chunk || all.length >= count) break;
  }
  return all;
}

// =============================================
// useContractStats — 4 ô thống kê đầu trang Hợp đồng bằng 4 HEAD count song
// song (không kéo dữ liệu). Điều kiện khớp getContractDisplayStatus:
// - expiring: không TERMINATED/TRANSFERRED/DRAFT, không expected_move_out_date,
//   end_date trong [hôm nay, hôm nay+30].
// - expired: như trên nhưng end_date < hôm nay.
// - terminated: status = TERMINATED.
// buildingIds (tuỳ chọn) lọc theo toà qua rooms!inner.
// =============================================

const contractHeadCountBase = (buildingIds?: string[]) => {
  const scoped = !!buildingIds?.length;
  let q = supabase
    .from("contracts")
    .select(
      scoped ? "id, room:rooms!contracts_room_id_fkey!inner(building_id)" : "id",
      { count: "exact", head: true },
    )
    .is("deleted_at", null);
  if (scoped) q = q.in("room.building_id", buildingIds);
  return q;
};

export const contractStatsQuery = (buildingIds?: string[]) => ({
    queryKey: ["contracts", "stats", buildingIds ?? []] as const,
    gcTime: 15 * 60_000, // ấm lâu cho prefetch (mặc định 5')
    queryFn: async (): Promise<ContractStats> => {
      const user = await getSessionUser();
      if (!user) throw new Error("Not authenticated");

      const today = toLocalISODate(new Date());
      const in30d = new Date();
      in30d.setDate(in30d.getDate() + 30);
      const in30 = toLocalISODate(in30d);

      // 1 RPC thay 4 HEAD-count (migration 20260705210000) — bớt 3 request +
      // 3 lần plan RLS mỗi lần tải trang. SECURITY INVOKER nên RLS như cũ;
      // p_today/p_in30 truyền từ FE để giữ đúng local-date (không lệch TZ).
      const { data, error } = await supabase.rpc(
        "get_contract_stats",
        {
          p_building_ids: buildingIds?.length ? buildingIds : undefined,
          p_today: today,
          p_in30: in30,
        },
      );
      if (error) {
        console.error("useContractStats error:", error);
        throw error;
      }
      if (!data || typeof data !== "object" || Array.isArray(data)) throw new TypeError("Chưa tải đủ thống kê hợp đồng.");
      const row = data as Record<string, unknown>;
      return {
        total: financialReadNumber(row.total),
        expiring: financialReadNumber(row.expiring),
        expired: financialReadNumber(row.expired),
        terminated: financialReadNumber(row.terminated),
      };
    },
  });

export const useContractStats = (buildingIds?: string[]) => {
  return useQuery({
    ...contractStatsQuery(buildingIds),
    meta: { errorDisplay: 'inline', label: 'thống kê hợp đồng' },
    placeholderData: keepPreviousData,
  });
};

// =============================================
// useContractDashboardCounts — số liệu khối "Tổng quan hợp đồng" trên trang
// chủ (OperationsSummary) bằng HEAD count, thay cho việc kéo cả bảng contracts.
// Lưu ý: bộ đếm "Thanh lý (tháng)" chỉ xét status TERMINATED ('ENDED' cũ
// không phải giá trị hợp lệ của enum contract_status nên bỏ).
// =============================================

export interface ContractDashboardCounts {
  active: number;
  newThisMonth: number;
  expiringSoon: number;
  terminatedThisMonth: number;
}

const confirmedContractCount = (value: unknown): number => {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new TypeError("Chưa xác nhận được tổng số hợp đồng.");
  return value;
};

export const useContractDashboardCounts = (buildingId?: string | null) => {
  return useQuery({
    queryKey: ["contracts", "dashboard-counts", buildingId ?? null],
    meta: { errorDisplay: 'inline', label: 'tổng quan hợp đồng' },
    queryFn: async (): Promise<ContractDashboardCounts> => {
      const user = await getSessionUser();
      if (!user) throw new Error("Not authenticated");

      const buildingIds = buildingId ? [buildingId] : undefined;
      const now = new Date();
      const today = toLocalISODate(now);
      const monthStart = toLocalISODate(
        new Date(now.getFullYear(), now.getMonth(), 1),
      );
      const in30d = new Date();
      in30d.setDate(in30d.getDate() + 30);
      const in30 = toLocalISODate(in30d);

      const results = await Promise.all([
        contractHeadCountBase(buildingIds).eq("status", "ACTIVE"),
        contractHeadCountBase(buildingIds).gte("start_date", monthStart),
        contractHeadCountBase(buildingIds)
          .eq("status", "ACTIVE")
          .gte("end_date", today)
          .lte("end_date", in30),
        contractHeadCountBase(buildingIds)
          .eq("status", "TERMINATED")
          .gte("end_date", monthStart),
      ]);

      for (const r of results) {
        if (r.error) {
          console.error("useContractDashboardCounts error:", r.error);
          throw r.error;
        }
      }

      const [active, newThisMonth, expiringSoon, terminatedThisMonth] = results;
      return {
        active: confirmedContractCount(active.count),
        newThisMonth: confirmedContractCount(newThisMonth.count),
        expiringSoon: confirmedContractCount(expiringSoon.count),
        terminatedThisMonth: confirmedContractCount(terminatedThisMonth.count),
      };
    },
  });
};

// =============================================
// useContract — Query single contract with full relations
// Requirements: 3.1, 3.2
// =============================================

export const useContract = (id?: string) => {
  return useQuery({
    queryKey: ["contracts", id],
    queryFn: async (): Promise<ContractWithRelations | null> => {
      if (!id) return null;

      const user = await getSessionUser();
      if (!user) throw new Error("Not authenticated");

      const { data, error } = await supabase
        .from("contracts")
        .select(CONTRACT_SELECT)
        .eq("id", id)
        .single();

      if (error) {
        console.error("useContract error:", error);
        throw error;
      }

      // Xem ghi chú ở useContractsPaged: khẳng định hẹp sau khi select đã được
      // kiểm kiểu, không phải ép mù cả câu lệnh.
      return data as unknown as ContractWithRelations;
    },
    enabled: !!id,
  });
};

// =============================================
// useCreateContract — Create contract + customers + services + update room
// Requirements: 2.11, 2.13, 3.3
// =============================================

export const useCreateContract = () => {
  const queryClient = useQueryClient();
  const workflow=persistentFinancialWorkflow('contract-create',{scope:'actor'});
  return useMutation({
    mutationFn: async (request:ContractCreateRequest&{suppressErrorToast?:boolean}) => {
      // Local validation runs before the durable marker/writer.
      buildCreateContractRpcArgs(request);
      const roomId=request.payload.contract.room_id;
      return workflow.run(roomId,'tạo hợp đồng',async progress=>{
        const response=await createContractV2(async(fn,args)=>{
          const result=await supabase.rpc(fn,args);
          const raw=result.data as unknown as {contract?:{id?:unknown;contract_number?:unknown}}|null;
          if(!result.error&&typeof raw?.contract?.id==='string'&&raw.contract.id)progress.completed.push({id:raw.contract.id,label:`Đã nhận hợp đồng ${typeof raw.contract.contract_number==='string'?raw.contract.contract_number:raw.contract.id}`});
          return result;
        },{...request,idempotencyKey:progress.requestKey});
        const receipt=response.contract;
        if(!receipt||typeof receipt.id!=='string'||!receipt.id||receipt.room_id!==roomId||receipt.status!=='ACTIVE')throw new TypeError('Chưa xác nhận được đúng hợp đồng và phòng vừa tạo.');
        if(!matchesContractMoneyReceipt(receipt.rent_price,request.payload.contract.rent_price)||!matchesContractMoneyReceipt(receipt.total_deposit,request.payload.contract.total_deposit))throw new TypeError('Chưa xác nhận được đúng tiền thuê và tiền cọc của hợp đồng vừa tạo.');
        return receipt;
      });
    },
    // 15/09 (plan con B): chín lượt invalidate ở đây là lượt ĐÁNH THỨ NHẤT.
    // create_contract_v2 ghi 5 bảng có realtime (contracts, rooms, invoices,
    // income_expenses, income_expense_items), nên ~0,8s sau hub đánh lượt THỨ
    // HAI trên ~70 khoá + prefetch 3 domain — đúng lúc modal hoa hồng vừa mở.
    //
    // Giữ các khoá cần đổi ngay trên màn tạo hợp đồng:
    //   - ["contracts"]: màn đang đứng, phải đổi ngay chứ không đợi debounce.
    //   - ["rooms"]: descriptor `rooms` của hub CỐ Ý chỉ mang
    //     ["business-performance"] (xem src/hooks/realtime/operations.ts), nên
    //     không ai invalidate hộ khoá này. Bỏ nó là kho phòng kẹt trạng thái cũ.
    // Bảy khoá còn lại đã nằm trong descriptor `invoices` / `income_expenses`.
    onSuccess: async (contract, request) => {
      queryClient.invalidateQueries({ queryKey: ["contracts"] });
      queryClient.invalidateQueries({ queryKey: ["contract-commission-followups"] });
      queryClient.invalidateQueries({ queryKey: ["contract-rent-support"] });
      queryClient.invalidateQueries({ queryKey: ["rooms"] });
      markLocalWrite([
        "contracts",
        "rooms",
        "invoices",
        "income_expenses",
        "income_expense_items",
      ]);
      if (contract.contract_number) {
        toast.success(`Đã tạo hợp đồng ${contract.contract_number}`);
      } else {
        const roomId = request?.payload?.contract?.room_id;
        if (!roomId) {
          toast.success('Đã tạo hợp đồng');
        } else {
          let name:string|undefined;try{const room=await supabase.from('rooms').select('name').eq('id',roomId).maybeSingle();if(!room.error)name=room.data?.name;}catch{/* The positive contract receipt is already confirmed. */}
          toast.success(name?`Đã tạo hợp đồng cho phòng ${name}`:'Đã tạo hợp đồng');
        }
      }
    },
    onError: (error: unknown,request) => {
      if(request.suppressErrorToast)return;
      console.error("Error creating contract:", error);
      const fe = contractCreateFeedback(error);
      toast.error(fe.title, { description: fe.description,
        ...(isContractTemplateSettingError(error) ? { action: {
          label: 'Mở mẫu tài liệu',
          onClick: () => window.open('/settings/templates', '_blank', 'noopener,noreferrer'),
        } } : {}),
      });
    },
  });
};

// =============================================
// useUpdateContract — Update contract fields
// Requirements: 3.2, 3.3
// =============================================

export const useUpdateContract = () => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({
      id,
      updates,
    }: {
      id: string;
      updates: UpdateContractPayload;
      suppressSuccessToast?: boolean;
    }) => {
      const user = await getSessionUser();
      if (!user) throw new Error("Not authenticated");

      const { data, error } = await supabase
        .from("contracts")
        .update(updates as any)
        .eq("id", id)
        .select()
        .single();

      if (error) throw error;
      if(!data||data.id!==id||!sameContractFields(data as unknown as Record<string,unknown>,updates))throw new TypeError('Chưa xác nhận được đúng hợp đồng và thông tin vừa cập nhật.');
      return data as unknown as Contract;
    },
    onSuccess: (data, vars) => {
      queryClient.invalidateQueries({ queryKey: ["contracts"] });
      if (data?.id) {
        queryClient.invalidateQueries({ queryKey: ["contracts", data.id] });
      }
      if (!vars.suppressSuccessToast) toast.success(data.contract_number ? `Đã cập nhật hợp đồng ${data.contract_number}` : 'Đã cập nhật hợp đồng');
    },
    onError: (error: unknown,vars) => {
      if(vars.suppressSuccessToast)return;
      console.error("Error updating contract:", error);
      const feedback = friendlyError(error, 'Không cập nhật được hợp đồng', { operation: 'cập nhật hợp đồng' });
      toast.error(feedback.title, { description: feedback.description });
    },
  });
};

// =============================================
// useSyncContractCustomers — replace contract_customers for a contract.
// Dùng cho luồng Cập nhật hợp đồng: xoá hết các bản ghi cũ rồi insert lại
// theo danh sách trong form (đại diện, ghi chú, …).
// =============================================

export const useSyncContractCustomers = () => {
  const queryClient = useQueryClient();
  const { selectedOrganizationId } = useOrganization();

  return useMutation({
    mutationFn: async ({
      contractId,
      customers,
      organizationId,skipDelete,onPhase,
    }: {
      contractId: string;
      customers: Array<{
        customer_id: string;
        is_representative: boolean;
        notes?: string | null;
      }>;
    } & ContractRelationWriteProgress) => {
      if(!skipDelete){
      onPhase?.("deleting");
      const { data: deleted,error: delErr } = await supabase
        .from("contract_customers")
        .delete()
        .eq("contract_id", contractId).select("customer_id,is_representative,notes");
      if (delErr) throw delErr;
      financialReadRows(deleted);onPhase?.("deleted");
      }
      if (customers.length === 0) {onPhase?.("done");return;}

      const rows = customers.map((c) => ({
        contract_id: contractId,
        customer_id: c.customer_id,
        is_representative: c.is_representative,
        notes: c.notes ?? null,
      }));

      onPhase?.("inserting");
      const {data:inserted,error: insErr } = await supabase
        .from("contract_customers")
        .insert(withOrgAll(rows, organizationId??selectedOrganizationId)).select("customer_id,is_representative,notes");
      if (insErr) throw insErr;
      if(!sameContractCustomers(financialReadRows(inserted),customers))throw new TypeError("Chưa xác nhận được đầy đủ khách hàng của hợp đồng.");onPhase?.("done");
    },
    onSuccess: (_data, vars) => {
      queryClient.invalidateQueries({ queryKey: ["contracts"] });
      queryClient.invalidateQueries({ queryKey: ["contracts", vars.contractId] });
    },
  });
};

// =============================================
// useSyncContractServices — replace contract_services for a contract.
// Dùng cho luồng Cập nhật hợp đồng: xoá hết dòng dịch vụ cũ rồi insert lại
// theo danh sách trong form (đổi loại điện, đơn giá, chỉ số đầu, …). Luồng
// update không tự đụng contract_services nên phải gọi tay sau khi update HĐ
// — giống useSyncContractCustomers.
// =============================================

export const useSyncContractServices = () => {
  const queryClient = useQueryClient();
  const { selectedOrganizationId } = useOrganization();

  return useMutation({
    mutationFn: async ({
      contractId,
      services,
      organizationId,skipDelete,onPhase,
    }: {
      contractId: string;
      services: Array<{
        service_id: string;
        unit_price: number;
        initial_reading?: number | null;
      }>;
    } & ContractRelationWriteProgress) => {
      if(!skipDelete){
      onPhase?.("deleting");
      const { data: deleted,error: delErr } = await supabase
        .from("contract_services")
        .delete()
        .eq("contract_id", contractId).select("service_id,unit_price,initial_reading");
      if (delErr) throw delErr;
      financialReadRows(deleted);onPhase?.("deleted");
      }
      if (services.length === 0) {onPhase?.("done");return;}

      const rows = services.map((s) => ({
        contract_id: contractId,
        service_id: s.service_id,
        unit_price: s.unit_price,
        initial_reading: s.initial_reading ?? null,
      }));

      onPhase?.("inserting");
      const {data:inserted,error: insErr } = await supabase
        .from("contract_services")
        .insert(withOrgAll(rows, organizationId??selectedOrganizationId)).select("service_id,unit_price,initial_reading");
      if (insErr) throw insErr;
      if(!sameContractServices(financialReadRows(inserted),services))throw new TypeError("Chưa xác nhận được đầy đủ dịch vụ của hợp đồng.");onPhase?.("done");
    },
    onSuccess: (_data, vars) => {
      queryClient.invalidateQueries({ queryKey: ["contracts"] });
      queryClient.invalidateQueries({ queryKey: ["contracts", vars.contractId] });
    },
  });
};

// =============================================
// useDeleteContract — Delete contract (check financial records first)
// Requirements: 10.1, 10.2, 10.3
// =============================================

export const useDeleteContract = () => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (contractId: string) => {
      const user = await getSessionUser();
      if (!user) throw new Error("Not authenticated");

      // Check for associated invoices
      const { data: invoices, error: invoicesError } = await supabase
        .from("invoices")
        .select("id")
        .eq("contract_id", contractId)
        .limit(1);

      if (invoicesError) throw invoicesError;
      if (financialReadRows(invoices).length > 0) {
        throw new Error(
          "Không thể xóa hợp đồng đã có hoá đơn hoặc bản ghi thanh lý"
        );
      }

      // Check for associated termination records
      const { data: terminations, error: terminationsError } = await supabase
        .from("contract_terminations")
        .select("id")
        .eq("contract_id", contractId)
        .limit(1);

      if (terminationsError) throw terminationsError;
      if (financialReadRows(terminations).length > 0) {
        throw new Error(
          "Không thể xóa hợp đồng đã có hoá đơn hoặc bản ghi thanh lý"
        );
      }

      // Soft-delete the contract
      const { data: deleted, error } = await supabase
        .from("contracts")
        .update({ deleted_at: new Date().toISOString() } as any)
        .eq("id", contractId)
        .select("id, contract_number, deleted_at")
        .maybeSingle();

      if (error) throw error;
      if (!deleted || deleted.id !== contractId || typeof deleted.deleted_at !== "string" || !Number.isFinite(Date.parse(deleted.deleted_at))) {
        throw new Error("Chưa xác nhận được kết quả xóa hợp đồng. Tải lại danh sách để kiểm tra.");
      }
      return deleted;
    },
    onSuccess: (deleted) => {
      queryClient.invalidateQueries({ queryKey: ["contracts"] });
      toast.success(`Đã xóa hợp đồng ${deleted.contract_number || deleted.id.slice(0, 8)}.`);
    },
    onError: (error: any) => {
      console.error("Error deleting contract:", error);
      const feedback = friendlyError(error, 'Không xóa được hợp đồng', { operation: 'xóa hợp đồng' });
      toast.error(feedback.title, { description: feedback.description });
    },
  });
};

// =============================================
// Legacy exports — backward compatibility for existing consumers
// These will be removed once all consumers are migrated
// =============================================

import type { Database } from "@/integrations/supabase/types";
import { useToast } from "@/hooks/use-toast";
import type { PaginatedData } from "@/hooks/usePagination";

type ContractRow = Database["public"]["Tables"]["contracts"]["Row"];
type ContractUpdate = Database["public"]["Tables"]["contracts"]["Update"];

/** @deprecated Use the new useContracts() instead */
export interface ContractFilters {
  status?: string;
  tenant_id?: string;
  room_id?: string;
  search?: string;
}

/** @deprecated */
export interface ContractPaginationParams {
  page?: number;
  pageSize?: number;
}

/** @deprecated */
export interface ContractTenantWithRelations {
  id: string;
  tenant_id: string;
  is_representative: boolean;
  move_in_date: string | null;
  tenant: {
    id: string;
    full_name: string;
    phone: string;
    email: string | null;
  };
}

/** @deprecated */
export interface LegacyContractWithRelations extends ContractRow {
  tenant?: {
    id: string;
    full_name: string;
    phone: string;
    email: string | null;
  };
  room?: {
    id: string;
    name: string;
    code: string | null;
    building: {
      id: string;
      name: string;
      code: string | null;
    };
  };
  contract_services?: Array<{
    id: string;
    service_id: string;
    unit_price: number;
    initial_reading: number | null;
    service: {
      id: string;
      name: string;
      type: string;
      unit: string;
    };
  }>;
  contract_tenants?: ContractTenantWithRelations[];
}

/** @deprecated */
export interface ContractTenantData {
  tenant_id: string;
  is_representative: boolean;
  move_in_date?: string;
}

/** @deprecated */
export interface CreateContractData {
  tenant_id: string;
  room_id?: string;
  signed_date: string;
  start_date: string;
  start_billing_date?: string;
  end_date: string;
  rent_price: number;
  payment_cycle: string;
  total_deposit: number;
  deposit_paid?: number;
  initial_electricity_reading?: number;
  initial_water_reading?: number;
  notes?: string;
  services?: Array<{
    service_id: string;
    unit_price: number;
    initial_reading?: number;
  }>;
  contract_template_id?: string;
  invoice_template_id?: string;
  discounts?: Array<{
    month: number;
    amount: number;
    reason?: string;
  }>;
  contract_file_url?: string;
  tenants?: ContractTenantData[];
}

const LEGACY_CONTRACT_SELECT = `
  *,
  tenant:tenants!contracts_tenant_id_fkey (
    id, full_name, phone, email
  ),
  room:rooms!contracts_room_id_fkey (
    id, name, code,
    building:buildings!rooms_building_id_fkey (
      id, name, code
    )
  ),
  contract_tenants (
    id, tenant_id, is_representative, move_in_date,
    tenant:tenants!left (
      id, full_name, phone, email
    )
  )
`;

/** @deprecated Use useContracts() instead */
export const useContractsLegacy = (
  filters?: {
    status?: string | string[];
    tenant_id?: string;
    room_id?: string;
  },
  // options.enabled: gate fetch cho caller mount SẴN khi chưa cần (dialog đóng,
  // chưa chọn phòng). Không có filter thì đây là `select *` TOÀN BỘ contracts
  // kèm `count: exact` — đắt nhất trong các query của form thu/chi. Default true.
  options?: { enabled?: boolean },
) => {
  return useQuery({
    enabled: options?.enabled ?? true,
    queryKey: ["contracts-legacy", filters],
    queryFn: async (): Promise<LegacyContractWithRelations[]> => {
      const user = await getSessionUser();
      if (!user) throw new Error("Not authenticated");

      // HĐ đã xoá mềm KHÔNG được lọt ra: writer canonical lọc `deleted_at IS
      // NULL` nên nếu form Thu/Chi tự gắn một HĐ đã xoá (effect auto-prefill chỉ
      // nhìn status='ACTIVE'), phiếu bị từ chối bằng 42501 "Hợp đồng không thuộc
      // toà/tổ chức của phiếu" — thông báo không hề nhắc tới việc HĐ đã bị xoá,
      // và người dùng không có cách nào tự gỡ. Đo được 29/07/2026 trên phòng
      // A101 DEMO (HD-2026-00016 status=ACTIVE, deleted_at=28/07).
      let query = supabase
        .from("contracts")
        .select(LEGACY_CONTRACT_SELECT, { count: "exact" })
        .is("deleted_at", null)
        .order("created_at", { ascending: false });

      if (filters?.status) {
        query = Array.isArray(filters.status)
          ? query.in("status", filters.status as any)
          : query.eq("status", filters.status as any);
      }
      if (filters?.tenant_id) query = query.eq("tenant_id", filters.tenant_id);
      if (filters?.room_id) query = query.eq("room_id", filters.room_id);

      const { data, error } = await query;
      if (error) {
        // KHÔNG nuốt lỗi: throw để React Query retry thay vì cache "rỗng-thành-công".
        // Caller (IncomeExpenseForm) đã default `= []` nên không vỡ UI khi lỗi.
        console.error("useContractsLegacy error:", error);
        throw error;
      }
      if (!Array.isArray(data)) throw new TypeError('Chưa xác nhận được danh sách hợp đồng của phòng. Tải lại để kiểm tra.');
      return data as unknown as LegacyContractWithRelations[];
    },
  });
};

// LƯU Ý: useExtendContract / useTransferContract / useTerminateContract đã bị XOÁ.
// Chúng tạo bản ghi contract_extensions DRAFT (extension_type SIMPLE, ngày bogus) /
// contract_terminations PENDING_APPROVAL mà không UI nào duyệt được → gia hạn/thanh lý
// từ trang chi tiết HĐ thành no-op âm thầm. Dùng RenewDialog/TerminateDialog (RPC
// renew_contract / terminate_contract_*) trong src/hooks/useContractOperations.ts.

/** @deprecated */
export const useUnpaidInvoices = (contractId?: string) => {
  return useQuery({
    queryKey: ["unpaid-invoices", contractId],
    queryFn: async () => {
      if (!contractId) return [];
      const user = await getSessionUser();
      if (!user) throw new Error("Not authenticated");

      const { data, error } = await supabase
        .from("invoices")
        .select("*")
        .eq("contract_id", contractId)
        .in("status", ["APPROVED", "OVERDUE", "PARTIAL_PAID"] as any)
        .is("deleted_at", null);

      if (error) throw error;
      return financialReadRows(data).map(invoice=>({...invoice,
        total_amount:financialReadNumber(invoice.total_amount),paid_amount:financialReadNumber(invoice.paid_amount),remaining_amount:financialReadNumber(invoice.remaining_amount),
      }));
    },
    enabled: !!contractId,
  });
};

/** @deprecated */
export const useUploadContractFile = () => {
  return useMutation({
    mutationFn: async ({
      file,
      contractId,
    }: {
      file: File;
      contractId?: string;
    }) => {
      const user = await getSessionUser();
      if (!user) throw new Error("Not authenticated");

      const timestamp = Date.now();
      const fileName = `${contractId || timestamp}_${file.name}`;
      const filePath = `${user.id}/${fileName}`;

      const { data, error } = await supabase.storage
        .from("contract-files")
        .upload(filePath, file, { cacheControl: "3600", upsert: false });

      if (error) throw error;

      const {
        data: { publicUrl },
      } = supabase.storage.from("contract-files").getPublicUrl(data.path);

      return {
        path: data.path,
        url: publicUrl,
        fileName: file.name,
        fileSize: file.size,
        fileType: file.name.split(".").pop(),
      };
    },
    onError: (error: any) => {
      toast.error(error?.message || "Có lỗi xảy ra khi tải file lên");
    },
  });
};

/** @deprecated */
export interface TerminationWithRelations {
  id: string;
  user_id: string;
  contract_id: string;
  termination_type: string;
  termination_date: string;
  actual_move_out_date: string;
  status: string;
  outstanding_debt: number;
  prorated_rent: number;
  prorated_services: number;
  early_termination_fee: number;
  damage_fee: number;
  damage_description: string | null;
  cleaning_fee: number;
  other_fees: number;
  other_fees_description: string | null;
  total_deductions: number;
  refund_amount: number;
  total_deposit: number;
  notes: string | null;
  approved_by: string | null;
  approved_at: string | null;
  created_at: string;
  contract?: LegacyContractWithRelations;
}

/** @deprecated */
export const usePendingTerminations = () => {
  return useQuery({
    queryKey: ["pending-terminations"],
    queryFn: async () => {
      const user = await getSessionUser();
      if (!user) throw new Error("Not authenticated");

      const { data, error } = await supabase
        .from("contract_terminations")
        .select(
          `
          *,
          contract:contracts(
            *,
            tenant:tenants(id, full_name, phone, email),
            room:rooms(id, name, code, building:buildings(id, name, code)),
          )
        `
        )
        .in("status", ["DRAFT", "PENDING_APPROVAL"])
        .order("created_at", { ascending: false });

      if (error) throw error;
      return (data || []) as unknown as TerminationWithRelations[];
    },
  });
};

/** @deprecated */
export const useApproveTermination = () => {
  const queryClient = useQueryClient();
  const { toast: legacyToast } = useToast();

  return useMutation({
    mutationFn: async (data: {
      termination_id: string;
      /** @deprecated Writer canonical tự suy từ termination — tham số bị BỎ QUA. */
      contract_id?: string;
      /** @deprecated Writer canonical đọc `refund_amount` GENERATED — bị BỎ QUA. */
      refund_amount?: number;
      /** @deprecated Sổ quỹ do kế toán chọn khi duyệt phiếu — bị BỎ QUA. */
      payment_method?: string;
      notes?: string;
    }) => {
      // CHỈ CÒN MỘT WRITER. Writer server-side làm atomic 5 bước (duyệt hồ sơ →
      // TERMINATED hợp đồng → COMPLETED → phiếu thu/chi NHÁP → trả phòng) trong
      // một transaction.
      //
      // ĐÃ XOÁ fallback client (Slice −1 · §−1.8): khi RPC trả "tín hiệu
      // fallback", hook này từng TỰ LÀM tiếp bằng REST — UPDATE
      // `contract_terminations` → APPROVED, UPDATE `contracts` → TERMINATED,
      // UPDATE → COMPLETED + `refund_date`, rồi INSERT vào `public.cash_book`.
      // `to_regclass('public.cash_book')` là NULL: **bảng đó không tồn tại**. Và
      // bốn lệnh REST đó KHÔNG nằm trong một transaction, nên bước cuối vỡ khi
      // ba bước đầu ĐÃ COMMIT ⇒ hợp đồng thành TERMINATED, hồ sơ thành COMPLETED
      // với `refund_date` (⇒ trang /deposits hiện tick xanh "Đã hoàn") mà KHÔNG
      // có một phiếu tiền nào ở đâu cả. Đó là writer thứ tư, nằm ngoài mọi mô
      // hình, và nó "tự chữa" bằng cách ghi bừa từ trình duyệt.
      //
      // Luật thay thế: RPC lỗi thì LỖI HIỆN RA cho người dùng. Trình duyệt tuyệt
      // đối không ghi thay tiền.
      const canonical = await supabase.rpc("approve_contract_termination_v1", {
        p_termination_id: data.termination_id,
        p_note: data.notes ?? undefined,
      });
      if (canonical.error) {
        const err = canonical.error as { code?: string | null; message?: string | null };
        if (isCanonicalFallbackSignal(err)) {
          // Writer chưa deploy / rollout OFF. Trước đây đây là cửa vào fallback;
          // nay là lỗi cứng — KHÔNG có đường ghi tiền nào khác được phép.
          throw new Error(
            "Chưa duyệt được thanh lý: hàm duyệt thanh lý trên server chưa sẵn sàng " +
              "(approve_contract_termination_v1). Vui lòng báo kỹ thuật — KHÔNG có " +
              "đường ghi tay nào thay thế, ghi tay sẽ làm mất phiếu tiền.",
          );
        }
        throw canonical.error;
      }
      return { success: true };
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["contracts"] });
      queryClient.invalidateQueries({ queryKey: ["pending-terminations"] });
      queryClient.invalidateQueries({ queryKey: ["rooms"] });
      legacyToast({
        title: "Hợp đồng đã được thanh lý thành công",
      });
    },
    onError: (error: Error) => {
      legacyToast({
        variant: "destructive",
        title: "Có lỗi xảy ra khi duyệt thanh lý",
        description: error.message,
      });
    },
  });
};

/** @deprecated */
export const useRejectTermination = () => {
  const queryClient = useQueryClient();
  const { toast: legacyToast } = useToast();

  return useMutation({
    mutationFn: async (data: {
      termination_id: string;
      rejection_reason?: string;
    }) => {
      const user = await getSessionUser();
      if (!user) throw new Error("Not authenticated");

      // Canonical reject (mirror legacy: về DRAFT + prefix lý do), fallback cũ.
      const canonical = await supabase.rpc("reject_contract_termination_v1", {
        p_termination_id: data.termination_id,
        p_reason: data.rejection_reason ?? undefined,
      });
      if (!canonical.error) return { success: true };
      if (!isCanonicalFallbackSignal(canonical.error)) throw canonical.error;

      const { error } = await supabase
        .from("contract_terminations")
        .update({
          status: "DRAFT",
          notes: data.rejection_reason
            ? `[Từ chối] ${data.rejection_reason}`
            : undefined,
        })
        .eq("id", data.termination_id)
        ;

      if (error) throw error;
      return { success: true };
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["contracts"] });
      queryClient.invalidateQueries({ queryKey: ["pending-terminations"] });
      legacyToast({
        title: "Yêu cầu thanh lý đã bị từ chối",
      });
    },
    onError: (error: Error) => {
      legacyToast({
        variant: "destructive",
        title: "Có lỗi xảy ra. Vui lòng thử lại",
        description: error.message,
      });
    },
  });
};

/** @deprecated */
export interface BulkContractImportRow {
  room_name: string;
  tenant_name: string;
  tenant_phone: string;
  signed_date: string;
  start_date: string;
  end_date: string;
  rent_price: number;
  payment_cycle?: string;
  start_billing_date?: string;
  total_deposit?: number;
  deposit_paid?: number;
  notes?: string;
}

/** @deprecated */
export const useBulkCreateContracts = () => {
  const queryClient = useQueryClient();
  const { selectedOrganizationId } = useOrganization();

  return useMutation({
    mutationFn: async ({
      building_id,
      contracts: rows,
    }: {
      building_id: string;
      contracts: BulkContractImportRow[];
    }) => {
      const user = await getSessionUser();
      if (!user) throw new Error("Not authenticated");

      const { data: rooms, error: roomsError } = await supabase
        .from("rooms")
        .select("id, name, code")
        .eq("building_id", building_id)
        .is("deleted_at", null);

      if (roomsError || !rooms) throw new Error("Không thể tải danh sách căn hộ");

      const { data: existingTenants, error: tenantsError } = await supabase
        .from("tenants")
        .select("id, full_name, phone")
        .is("deleted_at", null);
      if (tenantsError || !existingTenants) throw new Error("Không thể tải danh sách khách hàng");

      const results = {
        success: 0,
        failed: 0,
        errors: [] as Array<{ row: number; message: string }>,
        createdIds: [] as Array<{ row: number; id: string }>,
      };

      for (let i = 0; i < rows.length; i++) {
        const row = rows[i];
        const rowNum = i + 2;

        try {
          const room = rooms.find(
            (r) =>
              r.name?.toLowerCase() === row.room_name.toLowerCase() ||
              r.code?.toLowerCase() === row.room_name.toLowerCase()
          );
          if (!room) {
            results.errors.push({
              row: rowNum,
              message: `Không tìm thấy căn hộ "${row.room_name}"`,
            });
            results.failed++;
            continue;
          }

          let tenantId: string;
          const existingTenant = existingTenants?.find(
            (t) => t.phone === row.tenant_phone
          );

          if (existingTenant) {
            tenantId = existingTenant.id;
          } else {
            const { data: newTenant, error: tenantError } = await supabase
              .from("tenants")
              .insert(withOrgAll([
                {
                  user_id: user.id,
                  full_name: row.tenant_name,
                  phone: row.tenant_phone,
                },
              ], selectedOrganizationId))
              .select()
              .single();

            if (tenantError || !newTenant) {
              results.errors.push({
                row: rowNum,
                message: `Không thể tạo khách hàng: ${friendlyError(tenantError, 'Không thể tạo khách hàng').description}`,
              });
              results.failed++;
              continue;
            }
            tenantId = newTenant.id;
            existingTenants?.push({
              id: newTenant.id,
              full_name: row.tenant_name,
              phone: row.tenant_phone,
            });
          }

          const contractInsert: any = {
            user_id: user.id,
            tenant_id: tenantId,
            room_id: room.id,
            signed_date: row.signed_date,
            start_date: row.start_date,
            end_date: row.end_date,
            rent_price: row.rent_price,
            payment_cycle: row.payment_cycle || "MONTHLY",
            total_deposit: row.total_deposit || 0,
            deposit_paid: row.deposit_paid || 0,
            notes: row.notes,
            status: "ACTIVE",
          };

          const { data: contract, error: contractError } = await supabase
            .from("contracts")
            .insert(withOrgAll([contractInsert], selectedOrganizationId))
            .select()
            .single();

          if (contractError || !contract) {
            results.errors.push({
              row: rowNum,
              message: `Lỗi tạo hợp đồng: ${friendlyError(contractError, 'Không thể tạo hợp đồng').description}`,
            });
            results.failed++;
            continue;
          }

          results.createdIds.push({ row: rowNum, id: contract.id });
          const { error: relationError } = await supabase.from("contract_tenants").insert(withOrgAll([
            {
              contract_id: contract.id,
              tenant_id: tenantId,
              is_representative: true,
              move_in_date: row.start_date,
            },
          ], selectedOrganizationId));
          assertImportedContractRelations(contract.id, relationError, null);

          results.success++;
        } catch (e: any) {
          const createdId = results.createdIds.find(item => item.row === rowNum)?.id;
          results.errors.push({
            row: rowNum,
            message: createdId
              ? `Hợp đồng ${createdId} đã tạo nhưng các bước liên quan chưa hoàn tất. Kiểm tra bản ghi này trước khi nhập lại.`
              : friendlyError(e, 'Chưa hoàn tất dòng nhập hợp đồng').description,
          });
          results.failed++;
        }
      }

      return results;
    },
    onSuccess: (results) => {
      queryClient.invalidateQueries({ queryKey: ["contracts"] });
      queryClient.invalidateQueries({ queryKey: ["rooms"] });
      if (results.failed > 0) {
        toast.error(`Đã nhập ${results.success} hợp đồng; ${results.failed} dòng cần kiểm tra. Đối chiếu ID hợp đồng đã tạo trước khi nhập lại.`);
      } else if (results.success > 0) {
        toast.success(
          `Đã tạo ${results.success} hợp đồng.${results.failed > 0 ? ` ${results.failed} thất bại.` : ""}`
        );
      }
    },
    onError: (error: any) => {
      const feedback = friendlyError(error, 'Không thể nhập hợp đồng');
      toast.error(feedback.title, { description: feedback.description });
    },
  });
};

/** @deprecated */
export const useEstimateTerminationCosts = () => {
  return useMutation({
    mutationFn: async (data: {
      contract_id: string;
      move_out_date: string;
      damage_fee?: number;
      cleaning_fee?: number;
      early_termination_fee?: number;
      other_fees?: number;
    }) => {
      const user = await getSessionUser();
      if (!user) throw new Error("Not authenticated");

      const { data: contract, error: contractError } = await supabase
        .from("contracts")
        .select(
          `*, contract_services(*, service:services(*))`
        )
        .eq("id", data.contract_id)
        .single();

      if (contractError || !contract) throw new Error("Contract not found");

      const { data: unpaidInvoices } = await supabase
        .from("invoices")
        .select("*")
        .eq("contract_id", data.contract_id)
        .in("status", ["APPROVED", "OVERDUE", "PARTIAL_PAID"] as any)
        .is("deleted_at", null);

      const moveOutDate = new Date(data.move_out_date);
      const contractEndDate = new Date(contract.end_date);
      const isEarlyTermination = moveOutDate < contractEndDate;
      const daysEarly = isEarlyTermination
        ? Math.ceil(
            (contractEndDate.getTime() - moveOutDate.getTime()) /
              (1000 * 60 * 60 * 24)
          )
        : 0;

      const monthlyRent = contract.rent_price || 0;
      const daysInMonth = new Date(
        moveOutDate.getFullYear(),
        moveOutDate.getMonth() + 1,
        0
      ).getDate();
      const dailyRentRate = monthlyRent / daysInMonth;
      const dayOfMonth = moveOutDate.getDate();
      const proratedRent = Math.round(dailyRentRate * dayOfMonth);

      let outstandingDebt = 0;
      if (unpaidInvoices) {
        for (const inv of unpaidInvoices) {
          const remaining = inv.total_amount - (inv.paid_amount || 0);
          if (remaining > 0) outstandingDebt += remaining;
        }
      }

      const totalFees =
        (data.early_termination_fee || 0) +
        (data.damage_fee || 0) +
        (data.cleaning_fee || 0) +
        (data.other_fees || 0);

      const totalDeductions = outstandingDebt + proratedRent + totalFees;
      const totalDeposit = contract.total_deposit || 0;
      const refundAmount = totalDeposit - totalDeductions;

      return [
        {
          contract_id: contract.id,
          contract_number: contract.contract_number || "",
          total_deposit: totalDeposit,
          outstanding_debt: outstandingDebt,
          prorated_rent: proratedRent,
          prorated_days: dayOfMonth,
          daily_rent_rate: Math.round(dailyRentRate),
          prorated_services: 0,
          total_fees: totalFees,
          total_deductions: totalDeductions,
          refund_amount: refundAmount,
          is_early_termination: isEarlyTermination,
          days_early: daysEarly,
        },
      ];
    },
    onError: (error: any) => {
      toast.error(error?.message || "Có lỗi xảy ra khi tính toán");
    },
  });
};
