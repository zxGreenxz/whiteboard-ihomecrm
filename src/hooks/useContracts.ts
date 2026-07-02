import { useQuery, useMutation, useQueryClient, keepPreviousData } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { getSessionUser } from "@/lib/authSession";
import { toast } from "sonner";
import { friendlyError } from "@/lib/friendlyError";
import { PREVIOUS_DEBT_ROUND_THRESHOLD } from "@/lib/invoiceHelpers";
import { computeFirstBillingMonth } from "@/lib/firstInvoiceBuilder";
import type {
  Contract,
  ContractWithRelations,
  ContractStats,
  ContractStatus,
  ContractStatFilter,
  ContractLifecycleFilter,
  PaymentCycle,
} from "@/types/contract";

// =============================================
// Payload types
// =============================================

export interface CreateContractPayload {
  contract: {
    room_id: string;
    signed_date: string;
    start_date: string;
    end_date: string;
    rent_price: number;
    total_deposit: number;
    deposit_paid?: number;
    payment_cycle: PaymentCycle;
    start_billing_date?: string;
    end_billing_date?: string;
    contract_template_id?: string;
    invoice_template_id?: string;
    notes?: string;
    discounts?: { months: number; amount_per_month: number };
    // Xử lý thiếu cọc khi ký: cách xử lý + lý do + hẹn ngày bổ sung.
    deposit_debt_acknowledged?: boolean;
    deposit_debt_mode?: 'DEBT' | 'FIRST_INVOICE' | null;
    deposit_debt_reason?: string | null;
    deposit_topup_due_date?: string | null;
  };
  customers: { customer_id: string; is_representative: boolean }[];
  services: { service_id: string; unit_price: number; initial_reading?: number }[];
  /**
   * Items cho hoá đơn cọc + tháng đầu. Dialog đã preview/cho user chỉnh,
   * hook chỉ việc insert đúng như payload (không tự tính lại để đỡ đè
   * mất chỉnh sửa của user).
   */
  invoiceItems?: Array<{
    type: "RENT" | "SERVICE" | "DISCOUNT" | "OTHER";
    description: string;
    unit_price: number;
    quantity: number;
    service_id?: string | null;
    from_date?: string | null;
    to_date?: string | null;
  }>;
  /**
   * Giảm trừ "Khuyến mãi tháng đầu" — ghi vào invoices.discount_amount +
   * discount_notes (KHÔNG trộn vào items để tooltip "Giảm trừ" của cột HĐ
   * hiển thị đúng). Slot 1/Y; các tháng 2..Y sẽ auto-fill bằng
   * getContractDiscountSlot khi tạo HĐ tháng kế tiếp.
   */
  firstInvoiceDiscount?: {
    amount: number;
    notes: string;
  };
}

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
      id, full_name, phone, email, id_number,
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

export const useContracts = (opts?: { statuses?: ContractStatus[] }) => {
  return useQuery({
    queryKey: opts?.statuses?.length
      ? ["contracts", { statuses: opts.statuses }]
      : ["contracts"],
    queryFn: async (): Promise<ContractWithRelations[]> => {
      const user = await getSessionUser();
      if (!user) throw new Error("Not authenticated");

      let query = (supabase as any)
        .from("contracts")
        .select(CONTRACT_SELECT)
        .is("deleted_at", null)
        .order("created_at", { ascending: false });

      if (opts?.statuses?.length) {
        query = query.in("status", opts.statuses);
      }

      const { data, error } = await query;

      if (error) {
        console.error("useContracts error:", error);
        throw error;
      }

      return (data || []) as ContractWithRelations[];
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
const buildContractListSelect = (innerRoom: boolean) => `
  *,
  room:rooms!contracts_room_id_fkey${innerRoom ? "!inner" : ""} (
    id, name, building_id,
    building:buildings!rooms_building_id_fkey ( id, name )
  ),
  contract_customers!contract_customers_contract_id_fkey (
    id, contract_id, customer_id, is_representative,
    customer:customers!contract_customers_customer_id_fkey ( id, full_name, phone )
  )
`;

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

  // Tên khách / SĐT → contract ids.
  const { data: custs } = await (supabase as any)
    .from("customers")
    .select("id")
    .or(`full_name.ilike.${star},phone.ilike.${star}`)
    .limit(200);
  const custIds = (custs || []).map((c: any) => c.id);
  if (custIds.length > 0) {
    const { data: ccs } = await (supabase as any)
      .from("contract_customers")
      .select("contract_id")
      .in("customer_id", custIds)
      .limit(500);
    const contractIds = Array.from(
      new Set((ccs || []).map((r: any) => r.contract_id).filter(Boolean)),
    );
    if (contractIds.length > 0) {
      orParts.push(`id.in.(${contractIds.join(",")})`);
    }
  }

  // Tên phòng → room ids.
  const { data: rms } = await (supabase as any)
    .from("rooms")
    .select("id")
    .ilike("name", pattern)
    .limit(200);
  const roomIds = (rms || []).map((r: any) => r.id);
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

  let query = (supabase as any)
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

  return {
    data: (data || []) as ContractWithRelations[],
    count: count || 0,
  };
}

export const useContractsPaged = (
  filters?: ContractPagedFilters,
  pagination?: ContractPagedParams,
) => {
  return useQuery({
    queryKey: ["contracts", "paged", filters ?? null, pagination ?? null],
    // Giữ trang cũ khi đổi filter/trang để bảng không nhảy về "Đang tải".
    placeholderData: keepPreviousData,
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
  let q = (supabase as any)
    .from("contracts")
    .select(
      scoped ? "id, room:rooms!contracts_room_id_fkey!inner(building_id)" : "id",
      { count: "exact", head: true },
    )
    .is("deleted_at", null);
  if (scoped) q = q.in("room.building_id", buildingIds);
  return q;
};

export const useContractStats = (buildingIds?: string[]) => {
  return useQuery({
    queryKey: ["contracts", "stats", buildingIds ?? []],
    placeholderData: keepPreviousData,
    queryFn: async (): Promise<ContractStats> => {
      const user = await getSessionUser();
      if (!user) throw new Error("Not authenticated");

      const today = toLocalISODate(new Date());
      const in30d = new Date();
      in30d.setDate(in30d.getDate() + 30);
      const in30 = toLocalISODate(in30d);

      const results = await Promise.all([
        contractHeadCountBase(buildingIds),
        contractHeadCountBase(buildingIds)
          .not("status", "in", "(TERMINATED,TRANSFERRED,DRAFT)")
          .is("expected_move_out_date", null)
          .gte("end_date", today)
          .lte("end_date", in30),
        contractHeadCountBase(buildingIds)
          .not("status", "in", "(TERMINATED,TRANSFERRED,DRAFT)")
          .is("expected_move_out_date", null)
          .lt("end_date", today),
        contractHeadCountBase(buildingIds).eq("status", "TERMINATED"),
      ]);

      for (const r of results) {
        if (r.error) {
          console.error("useContractStats error:", r.error);
          throw r.error;
        }
      }

      const [total, expiring, expired, terminated] = results;
      return {
        total: total.count ?? 0,
        expiring: expiring.count ?? 0,
        expired: expired.count ?? 0,
        terminated: terminated.count ?? 0,
      };
    },
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

export const useContractDashboardCounts = (buildingId?: string | null) => {
  return useQuery({
    queryKey: ["contracts", "dashboard-counts", buildingId ?? null],
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
        active: active.count ?? 0,
        newThisMonth: newThisMonth.count ?? 0,
        expiringSoon: expiringSoon.count ?? 0,
        terminatedThisMonth: terminatedThisMonth.count ?? 0,
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

      const { data, error } = await (supabase as any)
        .from("contracts")
        .select(CONTRACT_SELECT)
        .eq("id", id)
        .single();

      if (error) {
        console.error("useContract error:", error);
        throw error;
      }

      return data as ContractWithRelations;
    },
    enabled: !!id,
  });
};

// =============================================
// createFirstInvoiceForContract — Auto-tạo hoá đơn cọc + tháng đầu sau khi
// hợp đồng được tạo. Best-effort: nếu fail thì hợp đồng vẫn còn, người dùng
// có thể tự tạo hoá đơn sau.
//
// Items được dialog tính sẵn (có cho user chỉnh trước khi lưu) và truyền
// xuống qua payload.invoiceItems. Hook chỉ insert đúng nội dung đó.
// =============================================
async function createFirstInvoiceForContract(args: {
  contract: any;
  contractData: CreateContractPayload["contract"];
  invoiceItems: NonNullable<CreateContractPayload["invoiceItems"]>;
  firstInvoiceDiscount?: CreateContractPayload["firstInvoiceDiscount"];
  userId: string;
}) {
  const { contract, contractData, invoiceItems, firstInvoiceDiscount, userId } = args;

  if (!invoiceItems || invoiceItems.length === 0) return;

  // Lấy building_id từ room — invoice cần building_id NOT NULL.
  const { data: room } = await supabase
    .from("rooms")
    .select("building_id")
    .eq("id", contractData.room_id)
    .maybeSingle();

  const building_id = (room as any)?.building_id;
  if (!building_id) {
    console.warn("createFirstInvoiceForContract: missing building_id, skip");
    return;
  }

  // Mốc ngày cho hoá đơn đầu tiên.
  const startBilling = contractData.start_billing_date || contractData.start_date;
  const issue_date = new Date().toISOString().split("T")[0];
  const due_date = contractData.end_billing_date || startBilling;
  // Kỳ thanh toán HĐ đầu theo quy tắc "tháng phủ trọn muộn nhất" (vào-muộn
  // 28/5–30/6 → T6, không phải T5). Doanh thu ghi nhận theo billing_month này.
  const billing_month = computeFirstBillingMonth(
    startBilling,
    contractData.end_billing_date,
  );

  const subtotal = invoiceItems.reduce(
    (sum, it) => sum + it.unit_price * it.quantity,
    0,
  );
  const discount_amount = Math.max(0, firstInvoiceDiscount?.amount ?? 0);
  const discount_notes = firstInvoiceDiscount?.notes?.trim() || null;
  // total = subtotal − discount + previous_debt (HĐ đầu: prev=0).
  const total_amount = Math.max(0, subtotal - discount_amount);

  const { generateInvoiceNumber } = await import("@/lib/invoiceUtils");
  const invoice_number = await generateInvoiceNumber(userId);

  // Ghi chú nói RÕ nội dung hoá đơn (yêu cầu chủ): tiền phòng đầu tiên, và nếu
  // có GỘP CỌC (item OTHER "Tiền cọc" — phần cọc còn thiếu) thì kèm số tiền.
  // LƯU Ý: useFirstInvoiceDetails nhận diện HĐ tháng đầu fallback theo notes —
  // regex bên đó phải khớp cả mẫu cũ ("tháng đầu") lẫn mẫu này ("đầu tiên").
  const depositBundled = invoiceItems
    .filter(
      (it) =>
        it.type === "OTHER" &&
        (it.description ?? "").trim().toLowerCase() === "tiền cọc",
    )
    .reduce((s, it) => s + it.unit_price * it.quantity, 0);
  const [bmY, bmM] = billing_month.split("-");
  const bmLabel = bmM ? `T${Number(bmM)}/${bmY}` : billing_month;
  const invoiceNotes =
    depositBundled > 0
      ? `Hoá đơn tiền phòng đầu tiên ${bmLabel} + kèm cọc ${depositBundled.toLocaleString("vi-VN")}đ (tự động)`
      : `Hoá đơn tiền phòng đầu tiên ${bmLabel} (tự động)`;

  const { data: invoice, error: invErr } = await supabase
    .from("invoices")
    .insert({
      user_id: userId,
      contract_id: contract.id,
      building_id,
      room_id: contractData.room_id,
      invoice_number,
      billing_month,
      issue_date,
      due_date,
      status: "APPROVED" as any,
      approved_at: new Date().toISOString(),
      approved_by: userId,
      subtotal,
      discount_amount,
      discount_notes,
      total_amount,
      prepaid_amount: 0,
      paid_amount: 0,
      previous_debt: 0,
      notes: invoiceNotes,
      template_id: contractData.invoice_template_id || null,
    } as any)
    .select()
    .single();

  if (invErr) throw invErr;

  const rows = invoiceItems.map((it, idx) => ({
    invoice_id: invoice.id,
    service_id: it.service_id ?? null,
    type: it.type,
    description: it.description,
    unit_price: it.unit_price,
    quantity: it.quantity,
    coefficient: 1,
    amount: it.unit_price * it.quantity,
    previous_reading: null,
    current_reading: null,
    from_date: it.from_date ?? null,
    to_date: it.to_date ?? null,
    sort_order: idx,
  }));

  const { error: itemsErr } = await supabase
    .from("invoice_items")
    .insert(rows as any);
  if (itemsErr) throw itemsErr;
}

// =============================================
// useCreateContract — Create contract + customers + services + update room
// Requirements: 2.11, 2.13, 3.3
// =============================================

export const useCreateContract = () => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (payload: CreateContractPayload) => {
      const user = await getSessionUser();
      if (!user) throw new Error("Not authenticated");

      const { contract: contractData, customers, services } = payload;

      // Guard: contract requires at least one customer (representative).
      // Without this, the DB throws "null value in column tenant_id" which is
      // confusing for the user.
      const tenantId =
        customers.find((c) => c.is_representative)?.customer_id ||
        customers[0]?.customer_id;
      if (!tenantId) {
        throw new Error(
          "Vui lòng chọn ít nhất một khách hàng cho hợp đồng (người đại diện)."
        );
      }

      // Guard: a room can only have ONE active contract at a time. Without this,
      // moving a new tenant in while the old contract is still ACTIVE leaves two
      // ACTIVE contracts on the same room → phòng bị "nhân đôi" ở các màn lập hoá
      // đơn. Chặn tại đây (luồng tạo HĐ duy nhất từ UI); gia hạn/chuyển phòng đi
      // qua RPC riêng nên không bị ảnh hưởng.
      if (contractData.room_id) {
        const { data: existingActive, error: activeErr } = await supabase
          .from("contracts")
          .select("id")
          .eq("room_id", contractData.room_id)
          .in("status", ["ACTIVE"])
          .is("deleted_at", null)
          .limit(1);
        if (activeErr) throw activeErr;
        if (existingActive && existingActive.length > 0) {
          throw new Error(
            "Phòng này đang có hợp đồng hiệu lực. Vui lòng thanh lý / kết thúc hợp đồng cũ trước khi tạo hợp đồng mới."
          );
        }
      }

      // Guard: bắt buộc thu đủ cọc khi ký. Nếu deposit_paid < total_deposit
      // (chênh ≥ ngưỡng làm tròn) thì admin phải chủ động "Đồng ý cho nợ cọc"
      // (kèm lý do nhập ở form) — defense-in-depth, khớp rule ở ContractFormDialog.
      const depositRemaining =
        (contractData.total_deposit || 0) - (contractData.deposit_paid || 0);
      if (
        depositRemaining >= PREVIOUS_DEBT_ROUND_THRESHOLD &&
        !contractData.deposit_debt_acknowledged
      ) {
        throw new Error(
          "Khách chưa đóng đủ cọc. Vui lòng thu đủ cọc, hoặc tích \"Đồng ý cho nợ cọc\" kèm lý do để tiếp tục.",
        );
      }

      // 1. Insert contract.
      // NOTE: contracts.tenant_id is the legacy column that used to FK to
      // `tenants`. The authoritative customer link is in contract_customers
      // (see Bundle 2). After Bundle 3 the FK is dropped and the column is
      // nullable; we leave it NULL on new rows to avoid confusion. tenantId
      // is still used for the empty-customer guard above.
      void tenantId;
      const insertData: any = {
        ...contractData,
        user_id: user.id,
        tenant_id: null,
        status: "ACTIVE",
      };

      const { data: contract, error: contractError } = await supabase
        .from("contracts")
        .insert(insertData)
        .select()
        .single();

      if (contractError) throw contractError;

      // 2. Batch insert contract_customers
      if (customers.length > 0) {
        const contractCustomers = customers.map((c) => ({
          contract_id: contract.id,
          customer_id: c.customer_id,
          is_representative: c.is_representative,
          notes: c.notes ?? null,
        }));

        const { error: customersError } = await (supabase as any)
          .from("contract_customers")
          .insert(contractCustomers);

        if (customersError) {
          console.error("Error inserting contract_customers:", customersError);
          throw customersError;
        }
      }

      // 3. Batch insert contract_services
      if (services.length > 0) {
        const contractServices = services.map((s) => ({
          contract_id: contract.id,
          service_id: s.service_id,
          unit_price: s.unit_price,
          initial_reading: s.initial_reading ?? null,
        }));

        const { error: servicesError } = await supabase
          .from("contract_services")
          .insert(contractServices);

        if (servicesError) {
          console.error("Error inserting contract_services:", servicesError);
          throw servicesError;
        }
      }

      // 4. Update room status to OCCUPIED
      if (contractData.room_id) {
        const { error: roomError } = await supabase
          .from("rooms")
          .update({ status: "OCCUPIED" } as any)
          .eq("id", contractData.room_id);

        if (roomError) {
          console.error("Error updating room status:", roomError);
        }
      }

      // 5. Auto-tạo hoá đơn cọc + tháng đầu (best-effort).
      // Items đã được dialog tính + cho user chỉnh, nên hook chỉ insert đúng
      // những gì user đã preview.
      if (payload.invoiceItems && payload.invoiceItems.length > 0) {
        try {
          await createFirstInvoiceForContract({
            contract,
            contractData,
            invoiceItems: payload.invoiceItems,
            firstInvoiceDiscount: payload.firstInvoiceDiscount,
            userId: user.id,
          });
        } catch (e) {
          console.error("Auto-create first invoice failed:", e);
          toast.error(
            "Đã tạo hợp đồng nhưng chưa tạo được hoá đơn cọc + tháng đầu. Vui lòng tạo hoá đơn thủ công."
          );
        }
      }

      return contract as unknown as Contract;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["contracts"] });
      queryClient.invalidateQueries({ queryKey: ["rooms"] });
      queryClient.invalidateQueries({ queryKey: ["invoices"] });
      queryClient.invalidateQueries({ queryKey: ["invoices-legacy"] });
      toast.success("Dữ liệu đã được TẠO thành công");
    },
    onError: (error: any) => {
      console.error("Error creating contract:", error);
      const fe = friendlyError(error, "Không lưu được hợp đồng");
      toast.error(fe.title, { description: fe.description });
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
      return data as unknown as Contract;
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["contracts"] });
      if (data?.id) {
        queryClient.invalidateQueries({ queryKey: ["contracts", data.id] });
      }
      toast.success("Dữ liệu đã được CẬP NHẬT thành công");
    },
    onError: (error: any) => {
      console.error("Error updating contract:", error);
      if (error?.code === "23503") {
        toast.error("Dữ liệu liên kết không tồn tại");
      } else {
        toast.error(error?.message || "Có lỗi xảy ra. Vui lòng thử lại.");
      }
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

  return useMutation({
    mutationFn: async ({
      contractId,
      customers,
    }: {
      contractId: string;
      customers: Array<{
        customer_id: string;
        is_representative: boolean;
        notes?: string | null;
      }>;
    }) => {
      const { error: delErr } = await (supabase as any)
        .from("contract_customers")
        .delete()
        .eq("contract_id", contractId);
      if (delErr) throw delErr;

      if (customers.length === 0) return;

      const rows = customers.map((c) => ({
        contract_id: contractId,
        customer_id: c.customer_id,
        is_representative: c.is_representative,
        notes: c.notes ?? null,
      }));

      const { error: insErr } = await (supabase as any)
        .from("contract_customers")
        .insert(rows);
      if (insErr) throw insErr;
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

  return useMutation({
    mutationFn: async ({
      contractId,
      services,
    }: {
      contractId: string;
      services: Array<{
        service_id: string;
        unit_price: number;
        initial_reading?: number | null;
      }>;
    }) => {
      const { error: delErr } = await supabase
        .from("contract_services")
        .delete()
        .eq("contract_id", contractId);
      if (delErr) throw delErr;

      if (services.length === 0) return;

      const rows = services.map((s) => ({
        contract_id: contractId,
        service_id: s.service_id,
        unit_price: s.unit_price,
        initial_reading: s.initial_reading ?? null,
      }));

      const { error: insErr } = await supabase
        .from("contract_services")
        .insert(rows as any);
      if (insErr) throw insErr;
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
      if (invoices && invoices.length > 0) {
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
      if (terminations && terminations.length > 0) {
        throw new Error(
          "Không thể xóa hợp đồng đã có hoá đơn hoặc bản ghi thanh lý"
        );
      }

      // Soft-delete the contract
      const { error } = await supabase
        .from("contracts")
        .update({ deleted_at: new Date().toISOString() } as any)
        .eq("id", contractId)
        ;

      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["contracts"] });
      toast.success("Hợp đồng đã được xóa thành công");
    },
    onError: (error: any) => {
      console.error("Error deleting contract:", error);
      toast.error(error?.message || "Có lỗi xảy ra. Vui lòng thử lại.");
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
export const useContractsLegacy = (filters?: {
  status?: string | string[];
  tenant_id?: string;
  room_id?: string;
}) => {
  return useQuery({
    queryKey: ["contracts-legacy", filters],
    queryFn: async (): Promise<LegacyContractWithRelations[]> => {
      const user = await getSessionUser();
      if (!user) throw new Error("Not authenticated");

      let query = supabase
        .from("contracts")
        .select(LEGACY_CONTRACT_SELECT, { count: "exact" })
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
      return (data || []) as unknown as LegacyContractWithRelations[];
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
      return data || [];
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
      return (data || []) as TerminationWithRelations[];
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
      contract_id: string;
      refund_amount: number;
      payment_method?: string;
      notes?: string;
    }) => {
      const user = await getSessionUser();
      if (!user) throw new Error("Not authenticated");

      const { error: termError } = await supabase
        .from("contract_terminations")
        .update({
          status: "APPROVED",
          approved_by: user.id,
          approved_at: new Date().toISOString(),
        })
        .eq("id", data.termination_id)
        ;
      if (termError) throw termError;

      const { error: contractError } = await supabase
        .from("contracts")
        .update({
          status: "TERMINATED",
          updated_at: new Date().toISOString(),
        } as any)
        .eq("id", data.contract_id)
        ;
      if (contractError) throw contractError;

      const { error: completeError } = await supabase
        .from("contract_terminations")
        .update({
          status: "COMPLETED",
          refund_date: new Date().toISOString(),
        } as any)
        .eq("id", data.termination_id)
        ;
      if (completeError) throw completeError;

      if (data.refund_amount !== 0) {
        const isRefund = data.refund_amount > 0;
        const { error: cashError } = await (supabase as any)
          .from("cash_book")
          .insert([
            {
              user_id: user.id,
              transaction_date: new Date().toISOString(),
              transaction_type: isRefund ? "EXPENSE" : "INCOME",
              category: isRefund ? "DEPOSIT_REFUND" : "DEPOSIT_FORFEIT",
              amount: Math.abs(data.refund_amount),
              description: isRefund
                ? "Hoàn cọc thanh lý hợp đồng"
                : "Thu thêm từ thanh lý hợp đồng",
              reference_type: "CONTRACT_TERMINATION",
              reference_id: data.termination_id,
              payment_method: data.payment_method || "TM",
              notes: data.notes,
            },
          ]);
        if (cashError) throw cashError;
      }

      const { data: contract } = await supabase
        .from("contracts")
        .select("room_id")
        .eq("id", data.contract_id)
        .single();

      if (contract?.room_id) {
        await supabase
          .from("rooms")
          .update({ status: "AVAILABLE" } as any)
          .eq("id", contract.room_id);
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

      const { data: rooms } = await (supabase as any)
        .from("rooms")
        .select("id, name, code")
        .eq("building_id", building_id)
        .is("deleted_at", null);

      if (!rooms) throw new Error("Không thể tải danh sách căn hộ");

      const { data: existingTenants } = await (supabase as any)
        .from("tenants")
        .select("id, full_name, phone")
        .is("deleted_at", null);

      const results = {
        success: 0,
        failed: 0,
        errors: [] as Array<{ row: number; message: string }>,
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
              .insert([
                {
                  user_id: user.id,
                  full_name: row.tenant_name,
                  phone: row.tenant_phone,
                },
              ])
              .select()
              .single();

            if (tenantError || !newTenant) {
              results.errors.push({
                row: rowNum,
                message: `Không thể tạo khách hàng: ${tenantError?.message || "Unknown"}`,
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
            .insert([contractInsert])
            .select()
            .single();

          if (contractError || !contract) {
            results.errors.push({
              row: rowNum,
              message: `Lỗi tạo hợp đồng: ${contractError?.message || "Unknown"}`,
            });
            results.failed++;
            continue;
          }

          await (supabase as any).from("contract_tenants").insert([
            {
              contract_id: contract.id,
              tenant_id: tenantId,
              is_representative: true,
              move_in_date: row.start_date,
            },
          ]);

          results.success++;
        } catch (e: any) {
          results.errors.push({
            row: rowNum,
            message: e.message || "Lỗi không xác định",
          });
          results.failed++;
        }
      }

      return results;
    },
    onSuccess: (results) => {
      queryClient.invalidateQueries({ queryKey: ["contracts"] });
      queryClient.invalidateQueries({ queryKey: ["rooms"] });
      if (results.success > 0) {
        toast.success(
          `Đã tạo ${results.success} hợp đồng.${results.failed > 0 ? ` ${results.failed} thất bại.` : ""}`
        );
      }
      if (results.success === 0 && results.failed > 0) {
        toast.error(`Tất cả ${results.failed} hợp đồng đều gặp lỗi.`);
      }
    },
    onError: (error: any) => {
      toast.error(error?.message || "Có lỗi xảy ra khi nhập dữ liệu");
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
