import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { getSessionUser } from "@/lib/authSession";
import { fetchAllRows } from "@/lib/supabaseFetchAll";
import {
  buildVacantRoomNotes,
  roomNoteLookups,
  type RoomNoteContractRow,
  type RoomNoteInvoiceRow,
  type RoomNoteRoomRow,
  type RoomNoteTerminationRow,
  type RoomNoteTransferRow,
} from "@/lib/vacantRoomNotes";
import {
  addDays,
  differenceInDays,
  eachMonthOfInterval,
  endOfMonth,
  format,
  startOfMonth,
  subMonths,
} from "date-fns";
import type { RenewalTransferRow, VacantRoomNote } from "./types";


// ==================== REAL ESTATE REPORTS ====================

/**
 * Get vacant rooms report
 * Returns rooms with status 'available' or no active contract
 */
export function useVacantRoomsReport(
  buildingId?: string,
  floorId?: string,
  opts?: { enabled?: boolean },
) {
  return useQuery({
    meta: { errorDisplay: "inline", label: "báo cáo phòng trống" },
    queryKey: ["reports", "vacant-rooms", buildingId, floorId],
    // Cho phép gate theo UI (vd Dashboard chỉ fetch khi MỞ dialog phòng trống
    // — hook này bắn 3 query full-table, không nên chạy ngầm mỗi lần mount).
    enabled: opts?.enabled ?? true,
    queryFn: async () => {
      // hermes-parity:begin w2d-re-vacant-rooms — Hermes chép vùng này, xem infra/hermes-broker/web-parity.json
      // Get all rooms
      let roomsQuery = supabase
        .from("rooms")
        .select(`
          id,
          name,
          area,
          rent_price,
          status,
          description,
          floor,
          building_id,
          buildings (id, name)
        `)
        .is("deleted_at", null)
        .order("name", { ascending: true });

      if (buildingId) {
        roomsQuery = roomsQuery.eq("building_id", buildingId);
      }

      const { data: rooms, error: roomsError } = await roomsQuery;
      if (roomsError) throw roomsError;

      // Get active contracts to determine which rooms are occupied
      const { data: activeContracts, error: contractsError } = await supabase
        .from("contracts")
        .select("room_id")
        .in("status", ["ACTIVE"])
        .is("deleted_at", null);

      if (contractsError) throw contractsError;

      const occupiedRoomIds = new Set(activeContracts?.map(c => c.room_id) || []);

      // Get ended contracts (TERMINATED / EXPIRED) to compute days_vacant per room
      const { data: endedContracts, error: endedError } = await supabase
        .from("contracts")
        .select("room_id, end_date, actual_end_date")
        .in("status", ["TERMINATED", "EXPIRED"])
        .is("deleted_at", null);

      if (endedError) throw endedError;
      const lastEndByRoom = new Map<string, string>();
      for (const c of endedContracts ?? []) {
        const effectiveEnd = (c as any).actual_end_date || (c as any).end_date;
        if (!effectiveEnd) continue;
        // `room_id` nullable trong DB: hợp đồng chưa gắn phòng thì không có
        // "lần kết thúc gần nhất theo phòng" để mà ghi.
        if (!c.room_id) continue;
        const prev = lastEndByRoom.get(c.room_id);
        if (!prev || new Date(effectiveEnd).getTime() > new Date(prev).getTime()) {
          lastEndByRoom.set(c.room_id, effectiveEnd);
        }
      }

      // Filter vacant rooms (not occupied, không tính phòng đã cọc giữ chỗ).
      let vacantRooms = (rooms || [])
        .filter(room => !occupiedRoomIds.has(room.id) && room.status !== "RESERVED")
        .map(room => {
          const lastEndDate = lastEndByRoom.get(room.id) ?? null;
          const daysVacant = lastEndDate
            ? differenceInDays(new Date(), new Date(lastEndDate))
            : null;

          return {
            ...room,
            days_vacant: daysVacant,
            last_end_date: lastEndDate,
          };
        });

      // Filter by floor if provided
      if (floorId) {
        vacantRooms = vacantRooms.filter(room => String(room.floor) === floorId);
      }

      return vacantRooms;
      // hermes-parity:end w2d-re-vacant-rooms
    },
  });
}

/** Lấy building name từ embed (PostgREST có thể trả object hoặc mảng). */
const embeddedName = (b: any): string =>
  (Array.isArray(b) ? b[0]?.name : b?.name) ?? "";

/** Dòng `rooms` mà bộ dò phòng trống đọc. */
interface NoteRoomRow {
  id: string;
  name: string | null;
  status: string | null;
  building_id: string;
  buildings: unknown;
}

export interface VacantRoomNotesOptions {
  /**
   * F46: thêm ghi chú 'ended_unsettled' (khoá Map `ended:<contractId>`) cho HĐ kết
   * thúc GIỮA tháng mà chưa thanh lý. Mặc định TẮT: nơi gọi cũ coi mọi kind khác
   * 'active' là phòng trống — bật khi nơi gọi đã xử lý kind mới.
   */
  includeEndedContracts?: boolean;
}

/** Danh sách id dài chia nhỏ cho `.in(...)` — URL GET quá dài thì PostgREST trả 400. */
const chunkIds = (ids: readonly string[], size = 100): string[][] => {
  const out: string[][] = [];
  for (let i = 0; i < ids.length; i += size) out.push(ids.slice(i, i + size));
  return out;
};

/**
 * Danh sách phòng TRỐNG (theo ảnh chụp CUỐI tháng) của các toà đã chọn, kèm lý do
 * — dùng tô màu + ghi chú "Trống phòng — <lý do>" ở đầu cột Khoản thu trang
 * Phân bổ lợi nhuận.
 *
 * LUẬT nằm ở hàm thuần buildVacantRoomNotes (src/lib/vacantRoomNotes.ts) — dùng chung với Quyết toán vận
 * hành (link chủ nhà lấy dữ liệu thô qua RPC). Hook này chỉ ĐỌC BẢNG: phòng, HĐ, rồi đúng phần cần (hoá đơn
 * kỳ, thanh lý của các HĐ cần, chuyển phòng của các phòng trống) theo roomNoteLookups. Đọc rooms/contracts/
 * invoices bằng fetchAllRows + order('id') — không cắt ngầm ở trần 1000 dòng của PostgREST (F57).
 *
 * @param monthEndDate ngày cuối tháng 'YYYY-MM-DD'.
 */
export function useVacantRoomNotes(
  buildingIds: string[],
  monthEndDate: string,
  enabled: boolean,
  opts?: VacantRoomNotesOptions,
) {
  const sortedIds = [...buildingIds].sort();
  const includeEnded = opts?.includeEndedContracts ?? false;
  return useQuery({
    queryKey: ["reports", "vacant-room-notes", sortedIds, monthEndDate, includeEnded],
    // B5: [] = quét MỌI toà trong scope RLS (bar Phân bổ LN bật mặc định).
    enabled: enabled && !!monthEndDate,
    queryFn: async (): Promise<Map<string, VacantRoomNote>> => {
      const ym = monthEndDate.slice(0, 7);

      // 1) Phòng trong các toà đã chọn (bỏ phòng đã xoá). Phân trang + order ổn định.
      const roomList = await fetchAllRows<NoteRoomRow>((from, to) => {
        let q = supabase
          .from("rooms")
          .select("id, name, status, building_id, buildings(id, name)")
          .is("deleted_at", null);
        if (buildingIds.length) q = q.in("building_id", buildingIds);
        return q.order("id", { ascending: true }).range(from, to);
      }, { label: "vacant-room-notes:rooms" });
      if (!roomList) throw new Error("Không tải đủ danh sách phòng.");
      if (roomList.length === 0) return new Map();
      const rooms: RoomNoteRoomRow[] = roomList.map((r) => ({
        id: r.id, name: r.name, status: r.status, building_id: r.building_id, building_name: embeddedName(r.buildings),
      }));
      const roomIds = rooms.map((r) => r.id);

      // 2) HĐ của các phòng (mọi status). ALL toà: KHÔNG .in(room_id, [hàng trăm id]) — URL quá dài sẽ 400;
      // lấy toàn bộ HĐ trong scope RLS rồi hàm thuần tự khớp theo phòng.
      const contractList = await fetchAllRows<RoomNoteContractRow>((from, to) => {
        let q = supabase
          .from("contracts")
          .select("id, room_id, status, start_date, start_billing_date, end_date, actual_end_date, contract_number")
          .is("deleted_at", null);
        if (buildingIds.length) q = q.in("room_id", roomIds);
        return q.order("id", { ascending: true }).range(from, to);
      }, { label: "vacant-room-notes:contracts" });
      if (!contractList) throw new Error("Không tải đủ danh sách hợp đồng.");

      const can = roomNoteLookups(rooms, contractList, monthEndDate, includeEnded);

      // 3) Hoá đơn kỳ này (chưa huỷ, chưa xoá) — khớp theo contract_id. Không lọc theo toà: một trang/tháng là
      //    đủ và tránh lệch toà khi HĐ đổi phòng.
      let invoices: RoomNoteInvoiceRow[] = [];
      if (can.needInvoices) {
        const invoiceList = await fetchAllRows<RoomNoteInvoiceRow>((from, to) =>
          supabase
            .from("invoices")
            .select("id, contract_id, status, kind, total_amount, paid_amount, remaining_amount, is_overdue")
            .eq("billing_month", ym)
            .is("deleted_at", null)
            .neq("status", "CANCELLED")
            .order("id", { ascending: true })
            .range(from, to),
        { label: "vacant-room-notes:invoices" });
        if (!invoiceList) throw new Error("Không tải đủ hoá đơn kỳ này.");
        invoices = invoiceList;
      }

      // 4) Bản ghi thanh lý của các HĐ cần (lý do trống + F46).
      const terminations: RoomNoteTerminationRow[] = [];
      for (const ids of chunkIds(can.terminationContractIds)) {
        const { data, error: termError } = await supabase
          .from("contract_terminations")
          .select("contract_id, termination_type, termination_date, actual_move_out_date, status")
          .in("contract_id", ids);
        if (termError) throw termError;
        if (!Array.isArray(data)) throw new Error("Không tải đủ bản ghi thanh lý.");
        terminations.push(...(data as RoomNoteTerminationRow[]));
      }

      // 5) Chuyển phòng có old_room_id = phòng trống (đã duyệt) — chỉ khi CÓ phòng trống.
      let transfers: RoomNoteTransferRow[] = [];
      if (can.transferRoomIds.length > 0) {
        const { data: transfersData, error: transfersError } = await supabase
          .from("contract_transfers")
          .select("old_room_id, transfer_type, transfer_date, status")
          .in("old_room_id", can.transferRoomIds)
          .in("status", ["APPROVED", "COMPLETED"]);
        if (transfersError) throw transfersError;
        transfers = (transfersData ?? []) as RoomNoteTransferRow[];
      }

      return buildVacantRoomNotes({ rooms, contracts: contractList, invoices, terminations, transfers }, monthEndDate, includeEnded);
    },
  });
}

/**
 * Get expiring contracts report
 * Returns rooms with contracts expiring within specified days
 */
export function useExpiringContractsReport(daysAhead: number = 30, buildingId?: string, floorId?: string) {
  return useQuery({
    meta: { errorDisplay: "inline", label: "báo cáo hợp đồng sắp hết hạn" },
    queryKey: ["reports", "expiring-contracts", daysAhead, buildingId, floorId],
    queryFn: async () => {
      // hermes-parity:begin w2d-re-expiring — Hermes chép vùng này, xem infra/hermes-broker/web-parity.json
      const today = new Date();
      const futureDate = addDays(today, daysAhead);

      const query = supabase
        .from("contracts")
        .select(`
          id,
          contract_number,
          start_date,
          end_date,
          rent_price,
          status,
          room_id,
          tenants (
            id,
            full_name,
            phone,
            email
          ),
          rooms (
            id,
            name,
            floor,
            building_id,
            buildings (id, name)
          )
        `)
        .in("status", ["ACTIVE"])
        .is("deleted_at", null)
        .gte("end_date", today.toISOString())
        .lte("end_date", futureDate.toISOString())
        .order("end_date", { ascending: true });

      const { data, error } = await query;
      if (error) throw error;

      let contracts = (data || []).map(contract => ({
        ...contract,
        days_left: differenceInDays(new Date(contract.end_date), today),
      }));

      // Filter by building
      if (buildingId) {
        contracts = contracts.filter(c => c.rooms?.building_id === buildingId);
      }

      // Filter by floor
      if (floorId) {
        contracts = contracts.filter(c => String(c.rooms?.floor) === floorId);
      }

      return contracts;
      // hermes-parity:end w2d-re-expiring
    },
  });
}

type EmbeddedRoom = { name: string | null; building_id: string | null; buildings: { name: string | null } | null } | null;
type EmbeddedCustomers = Array<{ is_representative?: boolean; customers?: { full_name?: string } | null }> | null;
type RenewalExtRow = { id: string; extension_date: string; new_rent_price: number | null; contracts: { contract_number: string | null; rent_price: number | null; deleted_at: string | null; rooms: EmbeddedRoom; contract_customers: EmbeddedCustomers } | null };
type TransferContractRow = { id: string; contract_number: string | null; rent_price: number | null; updated_at: string; rooms: EmbeddedRoom; contract_customers: EmbeddedCustomers };

/**
 * Báo cáo Gia hạn & Chuyển nhượng.
 * - Gia hạn (RENEWAL): từ bảng contract_extensions (sự kiện gia hạn đã hoàn tất) —
 *   KHÔNG còn dựa vào status='EXTENDED' (đã ngưng dùng).
 * - Chuyển nhượng (TRANSFER): HĐ status='TRANSFERRED'.
 */
export function useRenewalsTransfersReport(
  startDate?: string,
  endDate?: string,
  buildingId?: string
) {
  return useQuery({
    meta: { errorDisplay: "inline", label: "báo cáo gia hạn và chuyển nhượng" },
    queryKey: ["reports", "renewals-transfers", startDate, endDate, buildingId],
    queryFn: async (): Promise<RenewalTransferRow[]> => {
      // hermes-parity:begin w2d-re-renewals-transfers — Hermes chép vùng này, xem infra/hermes-broker/web-parity.json
      const repName = (ccs: EmbeddedCustomers | undefined): string => {
        const arr = ccs ?? [];
        const rep = arr.find((x) => x.is_representative) ?? arr[0];
        return rep?.customers?.full_name ?? "N/A";
      };

      // Renewals từ contract_extensions
      let extQ = supabase
        .from("contract_extensions")
        .select(`
          id, extension_date, new_rent_price, status,
          contracts!contract_extensions_contract_id_fkey!inner (
            contract_number, rent_price, deleted_at,
            rooms ( name, building_id, buildings ( name ) ),
            contract_customers ( is_representative, customers ( full_name ) )
          )
        `)
        .in("status", ["APPROVED", "COMPLETED"]);
      if (startDate) extQ = extQ.gte("extension_date", startDate);
      if (endDate) extQ = extQ.lte("extension_date", endDate);
      const { data: extData, error: extErr } = await extQ;
      if (extErr) throw extErr;

      // Transfers từ HĐ status TRANSFERRED
      let trQ = supabase
        .from("contracts")
        .select(`
          id, contract_number, rent_price, updated_at, start_date,
          rooms ( name, building_id, buildings ( name ) ),
          contract_customers ( is_representative, customers ( full_name ) )
        `)
        .eq("status", "TRANSFERRED")
        .is("deleted_at", null);
      if (startDate) trQ = trQ.gte("start_date", startDate);
      if (endDate) trQ = trQ.lte("start_date", endDate);
      const { data: trData, error: trErr } = await trQ;
      if (trErr) throw trErr;

      const renewals: RenewalTransferRow[] = ((extData as unknown[]) ?? [])
        .map((e) => e as RenewalExtRow)
        // Predicate CÓ KIỂU: `filter` với predicate boolean thường KHÔNG thu hẹp
        // kiểu phần tử, nên năm dòng `e.contracts.x` phía dưới vẫn bị coi là có
        // thể null dù đã lọc. Khai `e is …` để phép lọc nói được điều nó vừa làm.
        .filter(
          (e): e is RenewalExtRow & { contracts: NonNullable<RenewalExtRow["contracts"]> } =>
            !!e.contracts && !e.contracts.deleted_at,
        )
        .map((e) => ({
          id: `ext-${e.id}`,
          type: "RENEWAL",
          contract_number: e.contracts.contract_number ?? "N/A",
          customer: repName(e.contracts.contract_customers),
          building: e.contracts.rooms?.buildings?.name ?? "N/A",
          building_id: e.contracts.rooms?.building_id ?? null,
          room: e.contracts.rooms?.name ?? "N/A",
          date: e.extension_date,
          rent_price: e.new_rent_price ?? e.contracts.rent_price ?? 0,
        }));

      const transfers: RenewalTransferRow[] = ((trData as unknown[]) ?? [])
        .map((c) => c as TransferContractRow)
        .map((c) => ({
          id: `tr-${c.id}`,
          type: "TRANSFER",
          contract_number: c.contract_number ?? "N/A",
          customer: repName(c.contract_customers),
          building: c.rooms?.buildings?.name ?? "N/A",
          building_id: c.rooms?.building_id ?? null,
          room: c.rooms?.name ?? "N/A",
          date: c.updated_at,
          rent_price: c.rent_price ?? 0,
        }));

      let results = [...renewals, ...transfers];
      if (buildingId) results = results.filter((r) => r.building_id === buildingId);
      results.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
      return results;
      // hermes-parity:end w2d-re-renewals-transfers
    },
  });
}

// (useOccupancyReport/useOccupancyTrend đã thay bằng RPC server-side —
//  xem src/hooks/reports/useOccupancyDashboard.ts, Phase 8)

/**
 * Expense ratio over revenue report — grouped by income_expense_types.category, by month.
 * Numerator: SUM(income_expense_items.amount) WHERE expense voucher APPROVED + (optional) category.
 * Denominator: SUM(income_expenses.total_amount) WHERE type='INCOME' APPROVED by voucher_date month.
 * (Doanh thu = thu thực tế đã ghi nhận, KHÔNG lấy từ invoices.total_amount để tránh tính HĐ chưa thu.)
 */
export function useExpenseRatioReport(
  startDate?: Date,
  endDate?: Date,
  category?: string,
  buildingId?: string
) {
  return useQuery({
    meta: { errorDisplay: "inline", label: "báo cáo tỷ lệ chi phí và doanh thu" },
    queryKey: [
      "reports",
      "expense-ratio",
      startDate?.toISOString(),
      endDate?.toISOString(),
      category ?? null,
      buildingId ?? null,
    ],
    queryFn: async () => {
      // hermes-parity:begin w2d-re-expense-ratio — Hermes chép vùng này, xem infra/hermes-broker/web-parity.json
      const rangeEnd = endDate ? endOfMonth(endDate) : endOfMonth(new Date());
      const rangeStart = startDate
        ? startOfMonth(startDate)
        : startOfMonth(subMonths(rangeEnd, 5));

      const months = eachMonthOfInterval({ start: rangeStart, end: rangeEnd }).map(
        (d) => format(d, "yyyy-MM")
      );

      const revenueByMonth: Record<string, number> = {};
      for (const m of months) revenueByMonth[m] = 0;

      // --- Auth + date range cho cả revenue (INCOME) và expense (EXPENSE)
      const user = await getSessionUser();
      if (!user) throw new Error("Not authenticated");

      const startDateStr = format(rangeStart, "yyyy-MM-dd");
      const endDateStr = format(rangeEnd, "yyyy-MM-dd");

      // --- Revenue = SUM(income_expenses.total_amount) WHERE type='INCOME' approved by voucher_date month
      // PAGED: cộng tiền qua nhiều tháng/nhiều toà — phải phân trang kẻo cap 1000 làm hụt tổng.
      const incomeVouchers = await fetchAllRows<any>(
        (from, to) => {
          let q = supabase
            .from("income_expenses" as any)
            .select("id, voucher_date, building_id, total_amount")
            .eq("type", "INCOME")
            .eq("approval_status", "APPROVED")
            .is("deleted_at", null)
            .gte("voucher_date", startDateStr)
            .lte("voucher_date", endDateStr);
          if (buildingId) q = q.eq("building_id", buildingId);
          return q.order("voucher_date", { ascending: false }).order("id", { ascending: true }).range(from, to);
        },
        { label: "expenseRatio.income" },
      );
      if (incomeVouchers === null) throw new Error("Lỗi tải doanh thu (income_expenses)");

      for (const v of (incomeVouchers ?? []) as any[]) {
        const m = (v.voucher_date as string | null)?.slice(0, 7);
        if (!m || revenueByMonth[m] === undefined) continue;
        revenueByMonth[m] += Number(v.total_amount ?? 0);
      }

      // PAGED: cộng chi theo hạng mục qua nhiều tháng/toà — phân trang kẻo cap 1000.
      // Chỉ lấy MÃ loại chi rồi ghép với bảng loại đọc riêng bên dưới: nhúng
      // `income_expense_type:income_expense_type_id(...)` cho từng dòng chi bắt RLS của
      // income_expense_types chạy lại trên mỗi dòng — 6 tháng trên prod vượt statement
      // timeout (57014, đo 01/10/2026: >8s; bỏ nhúng còn ~2s).
      const vouchers = await fetchAllRows<any>(
        (from, to) => {
          let q = supabase
            .from("income_expenses" as any)
            .select(
              `id, voucher_date, building_id, type, approval_status,
               income_expense_items ( amount, income_expense_type_id )`
            )
            .eq("type", "EXPENSE")
            .eq("approval_status", "APPROVED")
            .is("deleted_at", null)
            .gte("voucher_date", startDateStr)
            .lte("voucher_date", endDateStr);
          if (buildingId) q = q.eq("building_id", buildingId);
          return q.order("voucher_date", { ascending: false }).order("id", { ascending: true }).range(from, to);
        },
        { label: "expenseRatio.expense" },
      );
      if (vouchers === null) throw new Error("Lỗi tải chi phí (income_expenses)");

      // Bảng loại thu chi nhỏ (vài trăm dòng): đọc một lượt, có phân trang cho chắc.
      // Loại mà RLS không trả về thì vắng trong map ⇒ bị bỏ qua, đúng như khi nhúng trả null.
      type ExpenseTypeRow = { id: string; name: string | null; category: string | null; type: string | null };
      const typeRows = await fetchAllRows<ExpenseTypeRow>(
        (from, to) => supabase
          .from("income_expense_types")
          .select("id, name, category, type")
          .order("id", { ascending: true })
          .range(from, to),
        { label: "expenseRatio.types" },
      );
      if (typeRows === null) throw new Error("Lỗi tải loại thu chi (income_expense_types)");
      const typeById = new Map<string, ExpenseTypeRow>(typeRows.map((t) => [t.id, t]));

      const UNCATEGORIZED = "(Chưa phân nhóm)";
      const expensesByMonthCategory: Record<string, Record<string, number>> = {};
      const byTypeNameMap: Record<string, { category: string; typeName: string; total: number }> = {};
      const categoriesSet = new Set<string>();

      for (const m of months) expensesByMonthCategory[m] = {};

      for (const voucher of (vouchers ?? []) as any[]) {
        const month = (voucher.voucher_date as string | null)?.slice(0, 7);
        if (!month || expensesByMonthCategory[month] === undefined) continue;
        const items = (voucher.income_expense_items ?? []) as Array<{
          amount: number | null;
          income_expense_type_id: string | null;
        }>;
        for (const item of items) {
          const typeRow = item.income_expense_type_id ? typeById.get(item.income_expense_type_id) : undefined;
          if (!typeRow || typeRow.type !== "expense") continue;
          const cat = (typeRow.category ?? "").trim() || UNCATEGORIZED;
          if (category !== undefined && cat !== category) continue;
          const amt = Number(item.amount ?? 0);
          if (!amt) continue;
          expensesByMonthCategory[month][cat] = (expensesByMonthCategory[month][cat] ?? 0) + amt;
          categoriesSet.add(cat);

          const tName = (typeRow.name ?? "").trim() || "(Không tên)";
          const tKey = `${cat}|${tName}`;
          if (!byTypeNameMap[tKey]) {
            byTypeNameMap[tKey] = { category: cat, typeName: tName, total: 0 };
          }
          byTypeNameMap[tKey].total += amt;
        }
      }

      const byMonth = months.map((m) => {
        const expByCat = expensesByMonthCategory[m] ?? {};
        const totalExpense = Object.values(expByCat).reduce((s, v) => s + v, 0);
        const revenue = revenueByMonth[m] ?? 0;
        const ratio = revenue > 0 ? (totalExpense / revenue) * 100 : null;
        return {
          month: m,
          revenue,
          expensesByCategory: expByCat,
          totalExpense,
          ratio,
        };
      });

      const totalExpense = byMonth.reduce((s, r) => s + r.totalExpense, 0);
      const totalRevenue = byMonth.reduce((s, r) => s + r.revenue, 0);
      const ratioMonths = byMonth.filter((r) => r.ratio !== null) as Array<{
        month: string;
        ratio: number;
      }>;
      const avgRatio =
        ratioMonths.length > 0
          ? ratioMonths.reduce((s, r) => s + (r.ratio as number), 0) / ratioMonths.length
          : 0;
      const peak = ratioMonths.reduce<{ month: string; ratio: number } | null>(
        (best, cur) => (best === null || cur.ratio > best.ratio ? cur : best),
        null
      );

      return {
        summary: {
          totalExpense,
          totalRevenue,
          avgRatio,
          peakMonth: peak?.month ?? "",
          peakRatio: peak?.ratio ?? 0,
        },
        byMonth,
        byTypeName: Object.values(byTypeNameMap).sort((a, b) => b.total - a.total),
        categories: Array.from(categoriesSet).sort((a, b) =>
          a.localeCompare(b, "vi", { sensitivity: "base" })
        ),
      };
      // hermes-parity:end w2d-re-expense-ratio
    },
  });
}

// ==================== PROMOTIONS, NEW LEASES, TERMINATIONS REPORTS ====================

/**
 * Get promotions report - contracts with discounts
 */
export function usePromotionsReport(startDate?: Date, endDate?: Date, buildingId?: string) {
  return useQuery({
    meta: { errorDisplay: "inline", label: "báo cáo khuyến mại" },
    queryKey: ["reports", "promotions", startDate?.toISOString(), endDate?.toISOString(), buildingId],
    queryFn: async () => {
      // hermes-parity:begin w2d-re-promotions — Hermes chép vùng này, xem infra/hermes-broker/web-parity.json
      let query = supabase
        .from("contracts")
        .select(`
          id,
          contract_number,
          rent_price,
          discounts,
          status,
          start_date,
          end_date,
          signed_date,
          tenants:tenant_id (full_name, phone),
          rooms:room_id (
            id,
            name,
            buildings:building_id (id, name)
          )
        `)
        .not("discounts", "is", null)
        .is("deleted_at", null)
        .order("signed_date", { ascending: false });

      if (startDate) {
        query = query.gte("signed_date", startDate.toISOString());
      }
      if (endDate) {
        query = query.lte("signed_date", endDate.toISOString());
      }

      const { data, error } = await query;
      if (error) throw error;

      // Filter by building if specified
      let filtered = data || [];
      if (buildingId) {
        filtered = filtered.filter((c: any) => c.rooms?.buildings?.id === buildingId);
      }

      return filtered.map((contract: any) => {
        const discounts = contract.discounts as any;
        const discountAmount = discounts?.amount || discounts?.value || 0;
        const discountType = discounts?.type || "fixed";
        const savings = discountType === "percent"
          ? (contract.rent_price * discountAmount) / 100
          : discountAmount;
        const effectiveRent = contract.rent_price - savings;

        return {
          ...contract,
          rooms: contract.rooms
            ? { ...contract.rooms, room_number: contract.rooms.name }
            : null,
          monthly_rent: contract.rent_price,
          discount_amount: discountAmount,
          discount_type: discountType === "percent" ? "Phần trăm" : "Cố định",
          promotion_name: discounts?.name || discounts?.description || null,
          savings,
          effective_rent: effectiveRent > 0 ? effectiveRent : 0,
        };
      });
      // hermes-parity:end w2d-re-promotions
    },
  });
}

/**
 * Get new leases report - contracts created in period
 */
export function useNewLeasesReport(startDate?: Date, endDate?: Date, buildingId?: string) {
  return useQuery({
    meta: { errorDisplay: "inline", label: "báo cáo hợp đồng mới" },
    queryKey: ["reports", "new-leases", startDate?.toISOString(), endDate?.toISOString(), buildingId],
    queryFn: async () => {
      // hermes-parity:begin w2d-re-new-leases — Hermes chép vùng này, xem infra/hermes-broker/web-parity.json
      let query = supabase
        .from("contracts")
        .select(`
          id,
          contract_number,
          rent_price,
          total_deposit,
          start_date,
          end_date,
          signed_date,
          status,
          payment_cycle,
          tenants:tenant_id (full_name, phone),
          rooms:room_id (
            id,
            name,
            buildings:building_id (id, name)
          )
        `)
        .is("deleted_at", null)
        .order("signed_date", { ascending: false });

      if (startDate) {
        query = query.gte("signed_date", startDate.toISOString());
      }
      if (endDate) {
        query = query.lte("signed_date", endDate.toISOString());
      }

      const { data, error } = await query;
      if (error) throw error;

      let filtered = data || [];
      if (buildingId) {
        filtered = filtered.filter((c: any) => c.rooms?.buildings?.id === buildingId);
      }

      return filtered.map((contract: any) => {
        const start = new Date(contract.start_date);
        const end = new Date(contract.end_date);
        const durationMonths = Math.max(1, Math.round(differenceInDays(end, start) / 30));
        const totalValue = contract.rent_price * durationMonths;

        return {
          ...contract,
          rooms: contract.rooms
            ? { ...contract.rooms, room_number: contract.rooms.name }
            : null,
          monthly_rent: contract.rent_price,
          deposit_amount: contract.total_deposit,
          duration_months: durationMonths,
          total_value: totalValue,
        };
      });
      // hermes-parity:end w2d-re-new-leases
    },
  });
}

/**
 * Get terminations report - terminated/cancelled contracts
 */
export function useTerminationsReport(startDate?: Date, endDate?: Date, buildingId?: string) {
  return useQuery({
    meta: { errorDisplay: "inline", label: "báo cáo thanh lý hợp đồng" },
    queryKey: ["reports", "terminations", startDate?.toISOString(), endDate?.toISOString(), buildingId],
    queryFn: async () => {
      // hermes-parity:begin w2d-re-terminations — Hermes chép vùng này, xem infra/hermes-broker/web-parity.json
      // Get terminated/expired contracts (filter date client-side để fallback end_date khi actual_end_date null)
      const query = supabase
        .from("contracts")
        .select(`
          id,
          contract_number,
          rent_price,
          total_deposit,
          start_date,
          end_date,
          actual_end_date,
          signed_date,
          status,
          tenants:tenant_id (full_name, phone),
          rooms:room_id (
            id,
            name,
            buildings:building_id (id, name)
          )
        `)
        .in("status", ["TERMINATED", "EXPIRED"])
        .is("deleted_at", null)
        .order("actual_end_date", { ascending: false, nullsFirst: false });

      const { data: contracts, error: contractsError } = await query;
      if (contractsError) throw contractsError;

      // Get termination details
      const contractIds = (contracts || []).map(c => c.id);
      let terminations: any[] = [];
      if (contractIds.length > 0) {
        const { data: termData, error: termError } = await supabase
          .from("contract_terminations")
          .select("contract_id, termination_type, termination_date, notes")
          .in("contract_id", contractIds);
        if (termError) throw termError;
        terminations = termData || [];
      }

      const termMap = new Map(terminations.map(t => [t.contract_id, t]));

      // Filter by building, then by date with fallback actual_end_date ?? end_date
      const startMs = startDate ? startDate.getTime() : -Infinity;
      const endMs = endDate ? endDate.getTime() : Infinity;
      let filtered = contracts || [];
      if (buildingId) {
        filtered = filtered.filter((c: any) => c.rooms?.buildings?.id === buildingId);
      }
      filtered = filtered.filter((c: any) => {
        const effective = c.actual_end_date || c.end_date;
        if (!effective) return false;
        const ms = new Date(effective).getTime();
        return ms >= startMs && ms <= endMs;
      });

      // Mẫu số tỉ lệ: contracts đã từng đi vào vận hành (loại DRAFT), không deleted
      const { count: totalContracts, error: countError } = await supabase
        .from("contracts")
        .select("id", { count: "exact", head: true })
        .is("deleted_at", null)
        .neq("status", "DRAFT");
      if (countError) throw countError;
      if (totalContracts == null) throw new Error("Missing required contract count");

      return {
        items: filtered.map((contract: any) => {
          const term = termMap.get(contract.id);
          const effectiveEnd = contract.actual_end_date || contract.end_date;
          const durationActual = differenceInDays(new Date(effectiveEnd), new Date(contract.start_date));

          return {
            ...contract,
            rooms: contract.rooms
              ? { ...contract.rooms, room_number: contract.rooms.name }
              : null,
            termination_reason: term?.notes || term?.termination_type || null,
            termination_type: term?.termination_type || (contract.status === "EXPIRED" ? "Hết hạn" : "Thanh lý"),
            duration_actual: durationActual,
          };
        }),
        totalContracts: totalContracts || 0,
        terminationRate: totalContracts && totalContracts > 0
          ? Number(((filtered.length / totalContracts) * 100).toFixed(1))
          : 0,
      };
      // hermes-parity:end w2d-re-terminations
    },
  });
}
