import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { getSessionUser } from "@/lib/authSession";
import { resolveVacancyReason, type VacancyEvent } from "@/lib/vacancyReason";
import {
  addDays,
  differenceInDays,
  eachMonthOfInterval,
  endOfMonth,
  format,
  startOfMonth,
  subMonths,
} from "date-fns";


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
    queryKey: ["reports", "vacant-rooms", buildingId, floorId],
    // Cho phép gate theo UI (vd Dashboard chỉ fetch khi MỞ dialog phòng trống
    // — hook này bắn 3 query full-table, không nên chạy ngầm mỗi lần mount).
    enabled: opts?.enabled ?? true,
    queryFn: async () => {
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
      const { data: endedContracts } = await supabase
        .from("contracts")
        .select("room_id, end_date, actual_end_date")
        .in("status", ["TERMINATED", "EXPIRED"])
        .is("deleted_at", null);

      const lastEndByRoom = new Map<string, string>();
      for (const c of endedContracts ?? []) {
        const effectiveEnd = (c as any).actual_end_date || (c as any).end_date;
        if (!effectiveEnd) continue;
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
    },
  });
}

export interface VacantRoomNote {
  roomId: string;
  roomName: string;
  buildingId: string;
  buildingName: string;
  /**
   * 'vacant' = phòng KHÔNG còn HĐ (trống thật) → ghi chú "Trống phòng — <reason>".
   * 'active' = phòng CÒN HĐ ACTIVE (đã tới kỳ xuất HĐ) → nếu thiếu hoá đơn thì
   *            cảnh báo "Chưa có hoá đơn".
   */
  kind: "vacant" | "active";
  /** Nhãn lý do trống: "Bỏ cọc" / "Thanh lý HĐ" / "Chuyển phòng" / … (chỉ 'vacant'). */
  reason?: string;
}

/** Lấy building name từ embed (PostgREST có thể trả object hoặc mảng). */
const embeddedName = (b: any): string =>
  (Array.isArray(b) ? b[0]?.name : b?.name) ?? "";

/**
 * Danh sách phòng TRỐNG (theo ảnh chụp CUỐI tháng) của các toà đã chọn, kèm lý do
 * — dùng tô màu + ghi chú "Trống phòng — <lý do>" ở đầu cột Khoản thu trang
 * Phân bổ lợi nhuận.
 *
 * "Đang ở tại cuối tháng" = có HĐ `ACTIVE` phủ ngày cuối tháng. Phòng gắn cờ =
 * không ở + status không thuộc {RESERVED, MAINTENANCE, UNAVAILABLE}. Lý do suy từ
 * contract_terminations (FORFEIT→Bỏ cọc, còn lại→Thanh lý HĐ), contract_transfers
 * theo `old_room_id` (ROOM_CHANGE→Chuyển phòng, TENANT/BOTH→Sang nhượng) và HĐ
 * EXPIRED (→Hết hạn HĐ). Chỉ chạy khi đã chọn ≥1 toà.
 *
 * @param monthEndDate ngày cuối tháng 'YYYY-MM-DD'.
 */
export function useVacantRoomNotes(
  buildingIds: string[],
  monthEndDate: string,
  enabled: boolean,
) {
  const sortedIds = [...buildingIds].sort();
  return useQuery({
    queryKey: ["reports", "vacant-room-notes", sortedIds, monthEndDate],
    // B5: [] = quét MỌI toà trong scope RLS (bar Phân bổ LN bật mặc định).
    enabled: enabled && !!monthEndDate,
    queryFn: async (): Promise<Map<string, VacantRoomNote>> => {
      // 1) Phòng trong các toà đã chọn (bỏ phòng đã xoá).
      let roomsQ = supabase
        .from("rooms")
        .select("id, name, status, building_id, buildings(id, name)")
        .is("deleted_at", null)
        .range(0, 4999);
      if (buildingIds.length) roomsQ = roomsQ.in("building_id", buildingIds);
      const { data: rooms, error: roomsErr } = await roomsQ;
      if (roomsErr) throw roomsErr;
      const roomList = (rooms ?? []) as any[];
      if (roomList.length === 0) return new Map();
      const roomIds = roomList.map((r) => r.id);

      // 2) HĐ của các phòng (mọi status): ACTIVE để xác định "đang ở tại cuối
      //    tháng", TERMINATED/EXPIRED/TRANSFERRED để suy lý do.
      // ALL toà: KHÔNG .in(room_id, [hàng trăm id]) — URL quá dài sẽ 400; lấy
      // toàn bộ HĐ trong scope RLS rồi các set bên dưới tự khớp theo roomList.
      let contractsQ = supabase
        .from("contracts")
        .select("id, room_id, status, start_date, start_billing_date, end_date, actual_end_date")
        .is("deleted_at", null)
        .range(0, 4999);
      if (buildingIds.length) contractsQ = contractsQ.in("room_id", roomIds);
      const { data: contracts, error: cErr } = await contractsQ;
      if (cErr) throw cErr;
      const contractList = (contracts ?? []) as any[];

      // Phòng có HĐ đã tới kỳ phải xuất hoá đơn (billing bắt đầu ≤ cuối tháng) VÀ
      // còn hiệu lực tới cuối tháng → kỳ vọng có hoá đơn tháng này. Thiếu hoá đơn
      // ⇒ cảnh báo (kind 'active'). Dùng start_billing_date nếu có (loại HĐ
      // billing tháng sau). KHÔNG chỉ xét status='ACTIVE' hiện tại: HĐ thanh lý
      // đầu tháng SAU (vd kết thúc 05/06) vẫn phủ tháng 05 → phải cảnh báo, dù
      // giờ đã TERMINATED (cùng tinh thần "còn hiệu lực" với set occupied dưới).
      const activeRooms = new Set<string>();
      for (const c of contractList) {
        const billStart: string = c.start_billing_date || c.start_date || "";
        if (!billStart || billStart > monthEndDate) continue; // chưa tới kỳ tính tiền
        if (c.status === "ACTIVE") {
          activeRooms.add(c.room_id);
          continue;
        }
        // HĐ đã kết thúc nhưng còn hiệu lực tới cuối tháng báo cáo → vẫn thuộc kỳ
        // này (kết thúc giữa tháng → cuối tháng đã trống, để set vacant xử lý).
        const end: string = c.actual_end_date || c.end_date || "";
        if (end && end >= monthEndDate) activeRooms.add(c.room_id);
      }

      // Phòng "đang ở tại CUỐI tháng":
      //  - HĐ ACTIVE đã bắt đầu trước cuối tháng → đang ở (month-to-month: end_date
      //    có thể đã qua nhưng khách vẫn ở, HĐ vẫn ACTIVE → KHÔNG coi là trống).
      //  - HĐ đã kết thúc (TERMINATED/EXPIRED/…) chỉ tính nếu còn hiệu lực tới cuối
      //    tháng (kết thúc giữa tháng → cuối tháng đã trống).
      const occupied = new Set<string>();
      for (const c of contractList) {
        const start: string = c.start_date ?? "";
        if (!start || start > monthEndDate) continue;
        if (c.status === "ACTIVE") {
          occupied.add(c.room_id);
          continue;
        }
        const end: string = c.actual_end_date || c.end_date || "";
        if (end && end >= monthEndDate) occupied.add(c.room_id);
      }

      // Phòng gắn cờ = không ở + không phải giữ chỗ/bảo trì/ngưng cho thuê.
      const SKIP_STATUS = new Set(["RESERVED", "MAINTENANCE", "UNAVAILABLE"]);
      const flagged = roomList.filter(
        (r) => !occupied.has(r.id) && !SKIP_STATUS.has(r.status),
      );
      const flaggedIds = new Set<string>(flagged.map((r) => r.id));

      const out = new Map<string, VacantRoomNote>();
      // Phòng CÒN HĐ (kind 'active') → component cảnh báo nếu thiếu hoá đơn.
      for (const r of roomList) {
        if (!activeRooms.has(r.id)) continue;
        out.set(r.id, {
          roomId: r.id,
          roomName: r.name ?? "",
          buildingId: r.building_id,
          buildingName: embeddedName(r.buildings),
          kind: "active",
        });
      }

      // Phòng TRỐNG (kind 'vacant' + lý do) — chỉ truy vấn lý do khi CÓ phòng trống.
      if (flagged.length > 0) {
        // HĐ đã kết thúc (≤ cuối tháng) của các phòng gắn cờ → tra termination & EXPIRED.
        const endedByContract = new Map<
          string,
          { roomId: string; date: string | null; status: string }
        >();
        for (const c of contractList) {
          if (!flaggedIds.has(c.room_id) || c.status === "ACTIVE") continue;
          const end: string | null = c.actual_end_date || c.end_date || null;
          if (end && end > monthEndDate) continue; // kết thúc sau tháng → bỏ
          endedByContract.set(c.id, { roomId: c.room_id, date: end, status: c.status });
        }
        const endedContractIds = [...endedByContract.keys()];

        let terminations: any[] = [];
        if (endedContractIds.length) {
          const { data } = await supabase
            .from("contract_terminations")
            .select("contract_id, termination_type, termination_date, actual_move_out_date")
            .in("contract_id", endedContractIds);
          terminations = data ?? [];
        }

        // Transfers có old_room_id = phòng gắn cờ (đã duyệt) — bắt được chuyển phòng
        // dù room_id của HĐ đã đổi tại chỗ sang phòng mới.
        const { data: transfersData } = await supabase
          .from("contract_transfers")
          .select("old_room_id, transfer_type, transfer_date, status")
          .in("old_room_id", [...flaggedIds])
          .in("status", ["APPROVED", "COMPLETED"]);
        const transfers = (transfersData ?? []).filter(
          (t: any) => !t.transfer_date || t.transfer_date <= monthEndDate,
        );

        const eventsByRoom = new Map<string, VacancyEvent[]>();
        const pushEv = (roomId: string, ev: VacancyEvent) => {
          const arr = eventsByRoom.get(roomId);
          if (arr) arr.push(ev);
          else eventsByRoom.set(roomId, [ev]);
        };
        for (const t of terminations) {
          const ended = endedByContract.get(t.contract_id);
          if (!ended) continue;
          pushEv(ended.roomId, {
            kind: "termination",
            type: t.termination_type ?? null,
            date: t.actual_move_out_date || t.termination_date || ended.date,
          });
        }
        for (const c of endedByContract.values()) {
          if (c.status === "EXPIRED") pushEv(c.roomId, { kind: "expired", date: c.date });
        }
        for (const t of transfers) {
          pushEv(t.old_room_id, {
            kind: "transfer",
            type: t.transfer_type ?? null,
            date: t.transfer_date ?? null,
          });
        }

        for (const r of flagged) {
          out.set(r.id, {
            roomId: r.id,
            roomName: r.name ?? "",
            buildingId: r.building_id,
            buildingName: embeddedName(r.buildings),
            kind: "vacant",
            reason: resolveVacancyReason(eventsByRoom.get(r.id) ?? []),
          });
        }
      }

      return out;
    },
  });
}

/**
 * Get expiring contracts report
 * Returns rooms with contracts expiring within specified days
 */
export function useExpiringContractsReport(daysAhead: number = 30, buildingId?: string, floorId?: string) {
  return useQuery({
    queryKey: ["reports", "expiring-contracts", daysAhead, buildingId, floorId],
    queryFn: async () => {
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
    },
  });
}

export interface RenewalTransferRow {
  id: string;
  type: "RENEWAL" | "TRANSFER";
  contract_number: string;
  customer: string;
  building: string;
  building_id: string | null;
  room: string;
  date: string;
  rent_price: number;
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
    queryKey: ["reports", "renewals-transfers", startDate, endDate, buildingId],
    queryFn: async (): Promise<RenewalTransferRow[]> => {
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
        .filter((e) => e.contracts && !e.contracts.deleted_at)
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
    },
  });
}

/**
 * Get occupancy report
 * Returns occupancy rates per building with optional building filter
 */
export function useOccupancyReport(buildingId?: string) {
  return useQuery({
    queryKey: ["reports", "occupancy", buildingId],
    queryFn: async () => {
      let roomsQuery = supabase
        .from("rooms")
        .select(`id, name, status, building_id, buildings (id, name)`)
        .is("deleted_at", null);

      if (buildingId) {
        roomsQuery = roomsQuery.eq("building_id", buildingId);
      }

      const { data: rooms, error: roomsError } = await roomsQuery;
      if (roomsError) throw roomsError;

      const { data: activeContracts, error: contractsError } = await supabase
        .from("contracts")
        .select("room_id")
        .in("status", ["ACTIVE"])
        .is("deleted_at", null);
      if (contractsError) throw contractsError;

      const occupiedRoomIds = new Set(activeContracts?.map(c => c.room_id) || []);

      const buildingMap: Record<string, { building: string; total: number; occupied: number; available: number; reserved: number; maintenance: number }> = {};

      (rooms || []).forEach(room => {
        const bName = room.buildings?.name || "Không xác định";
        if (!buildingMap[bName]) {
          buildingMap[bName] = { building: bName, total: 0, occupied: 0, available: 0, reserved: 0, maintenance: 0 };
        }
        buildingMap[bName].total++;
        if (occupiedRoomIds.has(room.id)) {
          buildingMap[bName].occupied++;
        } else if (room.status === "RESERVED") {
          buildingMap[bName].reserved++;          // cọc giữ chỗ — không tính trống
        } else if (room.status === "MAINTENANCE") {
          buildingMap[bName].maintenance++;
        } else {
          buildingMap[bName].available++;
        }
      });

      const byBuilding = Object.values(buildingMap).map(b => ({
        ...b,
        occupancyRate: b.total > 0 ? Number(((b.occupied / b.total) * 100).toFixed(1)) : 0,
      }));

      const totalRooms = (rooms || []).length;
      const totalOccupied = byBuilding.reduce((s, b) => s + b.occupied, 0);
      const totalAvailable = byBuilding.reduce((s, b) => s + b.available, 0);
      const totalReserved = byBuilding.reduce((s, b) => s + b.reserved, 0);
      const totalMaintenance = byBuilding.reduce((s, b) => s + b.maintenance, 0);

      return {
        summary: {
          total: totalRooms,
          occupied: totalOccupied,
          available: totalAvailable,
          reserved: totalReserved,
          maintenance: totalMaintenance,
          occupancyRate: totalRooms > 0 ? Number(((totalOccupied / totalRooms) * 100).toFixed(1)) : 0,
        },
        byBuilding,
      };
    },
  });
}

/**
 * Get monthly occupancy trend data for the last 12 months
 */
export function useOccupancyTrend(buildingId?: string) {
  return useQuery({
    queryKey: ["reports", "occupancy-trend", buildingId],
    queryFn: async () => {
      let roomsQuery = supabase
        .from("rooms")
        .select("id, building_id")
        .is("deleted_at", null);

      if (buildingId) {
        roomsQuery = roomsQuery.eq("building_id", buildingId);
      }

      const { data: rooms, error: roomsError } = await roomsQuery;
      if (roomsError) throw roomsError;

      const totalRooms = (rooms || []).length;
      if (totalRooms === 0) return [];

      const roomIds = new Set((rooms || []).map(r => r.id));

      const { data: contracts, error: contractsError } = await supabase
        .from("contracts")
        .select("room_id, start_date, end_date, status")
        .in("status", ["ACTIVE", "TERMINATED", "EXPIRED"])
        .is("deleted_at", null);
      if (contractsError) throw contractsError;

      const months: { month: string; rate: number; occupied: number; total: number }[] = [];
      const now = new Date();

      for (let i = 11; i >= 0; i--) {
        const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
        const monthEnd = new Date(d.getFullYear(), d.getMonth() + 1, 0);
        const monthLabel = `${d.getMonth() + 1}/${d.getFullYear()}`;

        const occupiedCount = (contracts || []).filter(c => {
          if (!roomIds.has(c.room_id)) return false;
          const start = new Date(c.start_date);
          const end = new Date(c.end_date);
          return start <= monthEnd && end >= d;
        }).length;

        months.push({
          month: monthLabel,
          rate: totalRooms > 0 ? Number(((occupiedCount / totalRooms) * 100).toFixed(1)) : 0,
          occupied: occupiedCount,
          total: totalRooms,
        });
      }

      return months;
    },
  });
}

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
    queryKey: [
      "reports",
      "expense-ratio",
      startDate?.toISOString(),
      endDate?.toISOString(),
      category ?? null,
      buildingId ?? null,
    ],
    queryFn: async () => {
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
      if (!user) {
        return {
          summary: {
            totalExpense: 0,
            totalRevenue: 0,
            avgRatio: 0,
            peakMonth: "",
            peakRatio: 0,
          },
          byMonth: months.map((m) => ({
            month: m,
            revenue: revenueByMonth[m] ?? 0,
            expensesByCategory: {} as Record<string, number>,
            totalExpense: 0,
            ratio: null as number | null,
          })),
          byTypeName: [] as Array<{ category: string; typeName: string; total: number }>,
          categories: [] as string[],
        };
      }

      const startDateStr = format(rangeStart, "yyyy-MM-dd");
      const endDateStr = format(rangeEnd, "yyyy-MM-dd");

      // --- Revenue = SUM(income_expenses.total_amount) WHERE type='INCOME' approved by voucher_date month
      let incomeQuery = supabase
        .from("income_expenses" as any)
        .select("voucher_date, building_id, total_amount")
        .eq("type", "INCOME")
        .eq("approval_status", "APPROVED")
        .is("deleted_at", null)
        .gte("voucher_date", startDateStr)
        .lte("voucher_date", endDateStr);
      if (buildingId) incomeQuery = incomeQuery.eq("building_id", buildingId);

      const { data: incomeVouchers, error: incErr } = await incomeQuery;
      if (incErr) throw incErr;

      for (const v of (incomeVouchers ?? []) as any[]) {
        const m = (v.voucher_date as string | null)?.slice(0, 7);
        if (!m || revenueByMonth[m] === undefined) continue;
        revenueByMonth[m] += Number(v.total_amount ?? 0);
      }

      let voucherQuery = supabase
        .from("income_expenses" as any)
        .select(
          `id, voucher_date, building_id, type, approval_status,
           income_expense_items (
             amount,
             income_expense_type:income_expense_type_id (id, name, category, type)
           )`
        )
        .eq("type", "EXPENSE")
        .eq("approval_status", "APPROVED")
        .is("deleted_at", null)
        .gte("voucher_date", startDateStr)
        .lte("voucher_date", endDateStr);
      if (buildingId) voucherQuery = voucherQuery.eq("building_id", buildingId);

      const { data: vouchers, error: vErr } = await voucherQuery;
      if (vErr) throw vErr;

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
          income_expense_type: { name: string | null; category: string | null; type: string | null } | null;
        }>;
        for (const item of items) {
          const typeRow = item.income_expense_type;
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
    },
  });
}

// ==================== FINANCE REPORTS ====================

/**
 * Get cash book report
 * Returns daily cash transactions with running balance
 */
export function useCashBookReport(startDate?: Date, endDate?: Date) {
  return useQuery({
    queryKey: ["reports", "cash-book", startDate?.toISOString(), endDate?.toISOString()],
    queryFn: async () => {
      // Get payments (income)
      let paymentsQuery = supabase
        .from("payments")
        .select(`
          id,
          amount,
          payment_date,
          payment_method,
          notes,
          invoices (
            invoice_number,
            tenants (full_name)
          )
        `)
        .order("payment_date", { ascending: true });

      if (startDate) {
        paymentsQuery = paymentsQuery.gte("payment_date", startDate.toISOString());
      }
      if (endDate) {
        paymentsQuery = paymentsQuery.lte("payment_date", endDate.toISOString());
      }

      const { data: payments, error: paymentsError } = await paymentsQuery;
      if (paymentsError) throw paymentsError;

      // Transform into cash book entries
      const entries = payments?.map(payment => ({
        date: payment.payment_date,
        type: "INCOME" as const,
        description: `Thanh toán từ ${payment.invoices?.tenants?.full_name || "N/A"} - ${payment.invoices?.invoice_number || ""}`,
        amount: payment.amount,
        method: payment.payment_method,
        notes: payment.notes,
      })) || [];

      // Calculate running balance
      let runningBalance = 0;
      return entries.map(entry => {
        runningBalance += entry.type === "INCOME" ? entry.amount : -entry.amount;
        return {
          ...entry,
          balance: runningBalance,
        };
      });
    },
  });
}

/**
 * Get cash flow report
 * Returns income vs expense with net flow
 */
export function useCashFlowReport(startDate?: Date, endDate?: Date) {
  return useQuery({
    queryKey: ["reports", "cash-flow", startDate?.toISOString(), endDate?.toISOString()],
    queryFn: async () => {
      // Get payments (income)
      let paymentsQuery = supabase
        .from("payments")
        .select("amount, payment_date")
        .order("payment_date", { ascending: true });

      if (startDate) {
        paymentsQuery = paymentsQuery.gte("payment_date", startDate.toISOString());
      }
      if (endDate) {
        paymentsQuery = paymentsQuery.lte("payment_date", endDate.toISOString());
      }

      const { data: payments, error: paymentsError } = await paymentsQuery;
      if (paymentsError) throw paymentsError;

      // Group by month
      const monthlyData: Record<string, { income: number; expense: number }> = {};

      payments?.forEach(payment => {
        const month = payment.payment_date.substring(0, 7); // YYYY-MM
        if (!monthlyData[month]) {
          monthlyData[month] = { income: 0, expense: 0 };
        }
        monthlyData[month].income += payment.amount;
      });

      return Object.entries(monthlyData).map(([month, data]) => ({
        month,
        income: data.income,
        expense: data.expense,
        netFlow: data.income - data.expense,
      }));
    },
  });
}

/**
 * Get debt report with aging analysis
 * Returns debts categorized by age (0-30, 31-60, 61-90, >90 days)
 */
export function useDebtReport() {
  return useQuery({
    queryKey: ["reports", "debt"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("invoices")
        .select(`
          id,
          invoice_number,
          total_amount,
          paid_amount,
          remaining_amount,
          due_date,
          status,
          created_at,
          building:buildings!invoices_building_id_fkey (id, name),
          room:rooms!invoices_room_id_fkey (id, name),
          contract:contracts!invoices_contract_id_fkey (
            id,
            contract_customers!contract_customers_contract_id_fkey (
              is_representative,
              customer:customers!contract_customers_customer_id_fkey (id, full_name, phone)
            )
          )
        `)
        .in("status", ["APPROVED", "PARTIAL_PAID", "OVERDUE"])
        .is("deleted_at", null)
        .order("due_date", { ascending: true });

      if (error) throw error;

      const today = new Date();
      return data.map((invoice: any) => {
        const daysOverdue = differenceInDays(today, new Date(invoice.due_date));
        const remainingAmount = invoice.remaining_amount ?? (invoice.total_amount - (invoice.paid_amount || 0));

        let agingCategory = "0-30";
        if (daysOverdue > 90) agingCategory = ">90";
        else if (daysOverdue > 60) agingCategory = "61-90";
        else if (daysOverdue > 30) agingCategory = "31-60";

        const cust = (invoice.contract?.contract_customers || []).find((c: any) => c.is_representative)
          || invoice.contract?.contract_customers?.[0];
        const tenant = cust?.customer ? { id: cust.customer.id, full_name: cust.customer.full_name, phone: cust.customer.phone } : null;
        const room = invoice.room
          ? { room_number: invoice.room.name, buildings: invoice.building }
          : null;

        return {
          ...invoice,
          amount: invoice.total_amount,
          amount_paid: invoice.paid_amount,
          tenants: tenant,
          rooms: room,
          days_overdue: Math.max(0, daysOverdue),
          remaining_amount: remainingAmount,
          aging_category: agingCategory,
        };
      });
    },
  });
}

/**
 * Get customer debt report
 * Returns customers with outstanding debts
 */
export function useCustomerDebtReport() {
  return useQuery({
    queryKey: ["reports", "customer-debt"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("invoices")
        .select(`
          id,
          total_amount,
          paid_amount,
          remaining_amount,
          due_date,
          status,
          building:buildings!invoices_building_id_fkey (id, name),
          room:rooms!invoices_room_id_fkey (id, name),
          contract:contracts!invoices_contract_id_fkey (
            id,
            contract_customers!contract_customers_contract_id_fkey (
              is_representative,
              customer:customers!contract_customers_customer_id_fkey (id, full_name, phone, email)
            )
          )
        `)
        .in("status", ["APPROVED", "PARTIAL_PAID", "OVERDUE"])
        .is("deleted_at", null)
        .order("due_date", { ascending: true });

      if (error) throw error;

      // Group by customer
      const tenantDebts: Record<string, any> = {};
      data.forEach((invoice: any) => {
        const cust = (invoice.contract?.contract_customers || []).find((c: any) => c.is_representative)
          || invoice.contract?.contract_customers?.[0];
        const tenant = cust?.customer ?? null;
        const tenantId = tenant?.id;
        if (!tenantId) return;
        const room = invoice.room
          ? { room_number: invoice.room.name, buildings: invoice.building }
          : null;

        if (!tenantDebts[tenantId]) {
          tenantDebts[tenantId] = {
            tenant,
            room,
            totalDebt: 0,
            paidTotal: 0,
            invoiceCount: 0,
            oldestDueDate: invoice.due_date,
            invoices: [],
          };
        }

        const remaining = invoice.remaining_amount ?? (invoice.total_amount - (invoice.paid_amount || 0));
        tenantDebts[tenantId].totalDebt += remaining;
        tenantDebts[tenantId].paidTotal += invoice.paid_amount || 0;
        tenantDebts[tenantId].invoiceCount++;
        tenantDebts[tenantId].invoices.push({
          ...invoice,
          amount: invoice.total_amount,
          amount_paid: invoice.paid_amount,
        });
      });

      return Object.values(tenantDebts).map((debt: any) => ({
        ...debt,
        daysOverdue: differenceInDays(new Date(), new Date(debt.oldestDueDate)),
      }));
    },
  });
}

/**
 * Get payment schedule report
 * Returns upcoming and past due invoices
 */
export function usePaymentScheduleReport(daysAhead: number = 30) {
  return useQuery({
    queryKey: ["reports", "payment-schedule", daysAhead],
    queryFn: async () => {
      const today = new Date();
      const futureDate = addDays(today, daysAhead);

      const { data, error } = await supabase
        .from("invoices")
        .select(`
          *,
          building:buildings!invoices_building_id_fkey (id, name),
          room:rooms!invoices_room_id_fkey (id, name),
          contract:contracts!invoices_contract_id_fkey (
            id,
            contract_customers!contract_customers_contract_id_fkey (
              is_representative,
              customer:customers!contract_customers_customer_id_fkey (id, full_name, phone)
            )
          )
        `)
        .lte("due_date", futureDate.toISOString())
        .order("due_date", { ascending: true });

      if (error) throw error;

      return data.map((invoice: any) => {
        const cust = (invoice.contract?.contract_customers || []).find((c: any) => c.is_representative)
          || invoice.contract?.contract_customers?.[0];
        return {
          ...invoice,
          amount: invoice.total_amount,
          amount_paid: invoice.paid_amount,
          tenants: cust?.customer ?? null,
          rooms: invoice.room
            ? { room_number: invoice.room.name, buildings: invoice.building }
            : null,
          days_until_due: differenceInDays(new Date(invoice.due_date), today),
          remaining_amount: invoice.remaining_amount ?? (invoice.total_amount - (invoice.paid_amount || 0)),
        };
      });
    },
  });
}

/**
 * Get overpayment report
 * Returns customers who have overpaid
 */
export function useOverpaymentReport() {
  return useQuery({
    queryKey: ["reports", "overpayment"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("invoices")
        .select(`
          id,
          invoice_number,
          total_amount,
          paid_amount,
          building:buildings!invoices_building_id_fkey (id, name),
          room:rooms!invoices_room_id_fkey (id, name),
          contract:contracts!invoices_contract_id_fkey (
            id,
            contract_customers!contract_customers_contract_id_fkey (
              is_representative,
              customer:customers!contract_customers_customer_id_fkey (id, full_name, phone)
            )
          )
        `)
        .gt("paid_amount", 0);

      if (error) throw error;

      // Filter for overpayments
      return data
        .filter((invoice: any) => (invoice.paid_amount || 0) > invoice.total_amount)
        .map((invoice: any) => {
          const cust = (invoice.contract?.contract_customers || []).find((c: any) => c.is_representative)
            || invoice.contract?.contract_customers?.[0];
          return {
            ...invoice,
            amount: invoice.total_amount,
            amount_paid: invoice.paid_amount,
            tenants: cust?.customer ?? null,
            rooms: invoice.room
              ? { room_number: invoice.room.name, buildings: invoice.building }
              : null,
            overpaid_amount: (invoice.paid_amount || 0) - invoice.total_amount,
          };
        });
    },
  });
}

/**
 * Get deposits report
 * Returns list of customer deposits
 */
export function useDepositsReport() {
  return useQuery({
    queryKey: ["reports", "deposits"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("deposits")
        .select(`
          *,
          tenant:tenants!deposits_tenant_id_fkey (
            id,
            full_name,
            phone,
            email
          ),
          room:rooms!deposits_room_id_fkey (
            id,
            name,
            building:buildings!rooms_building_id_fkey (id, name)
          )
        `)
        .order("deposit_date", { ascending: false });

      if (error) throw error;

      return data.map((deposit: any) => ({
        ...deposit,
        tenants: deposit.tenant,
        rooms: deposit.room ? { room_number: deposit.room.name, buildings: deposit.room.building } : null,
        leads: deposit.tenant,
        days_held: differenceInDays(new Date(), new Date(deposit.deposit_date)),
      }));
    },
  });
}

/**
 * Get profit distribution report
 * Returns revenue breakdown and profit analysis
 */
export function useProfitDistributionReport(startDate?: Date, endDate?: Date) {
  return useQuery({
    queryKey: ["reports", "profit-distribution", startDate?.toISOString(), endDate?.toISOString()],
    queryFn: async () => {
      // Get total revenue (paid invoices)
      let revenueQuery = supabase
        .from("invoices")
        .select("amount, amount_paid")
        .eq("status", "PAID");

      if (startDate) {
        revenueQuery = revenueQuery.gte("created_at", startDate.toISOString());
      }
      if (endDate) {
        revenueQuery = revenueQuery.lte("created_at", endDate.toISOString());
      }

      const { data: invoices, error: invoicesError } = await revenueQuery;
      if (invoicesError) throw invoicesError;

      const totalRevenue = invoices?.reduce((sum, inv) => sum + (inv.amount_paid || inv.amount), 0) || 0;

      // Get total expenses
      let expensesQuery = supabase
        .from("expenses")
        .select("amount, category");

      if (startDate) {
        expensesQuery = expensesQuery.gte("expense_date", startDate.toISOString().split('T')[0]);
      }
      if (endDate) {
        expensesQuery = expensesQuery.lte("expense_date", endDate.toISOString().split('T')[0]);
      }

      const { data: expenses, error: expensesError } = await expensesQuery;
      if (expensesError) throw expensesError;

      const totalExpenses = expenses?.reduce((sum, exp) => sum + (exp.amount || 0), 0) || 0;
      const netProfit = totalRevenue - totalExpenses;
      const profitMargin = totalRevenue > 0 ? Number(((netProfit / totalRevenue) * 100).toFixed(2)) : 0;

      // Calculate revenue breakdown by invoice type (if available)
      // For now, treat all as rent revenue
      return {
        totalRevenue,
        totalExpenses,
        netProfit,
        profitMargin,
        breakdown: {
          rent: totalRevenue,
          services: 0,
          other: 0,
        },
      };
    },
  });
}

// ==================== TASK REPORTS ====================

// ==================== PROMOTIONS, NEW LEASES, TERMINATIONS REPORTS ====================

/**
 * Get promotions report - contracts with discounts
 */
export function usePromotionsReport(startDate?: Date, endDate?: Date, buildingId?: string) {
  return useQuery({
    queryKey: ["reports", "promotions", startDate?.toISOString(), endDate?.toISOString(), buildingId],
    queryFn: async () => {
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
    },
  });
}

/**
 * Get new leases report - contracts created in period
 */
export function useNewLeasesReport(startDate?: Date, endDate?: Date, buildingId?: string) {
  return useQuery({
    queryKey: ["reports", "new-leases", startDate?.toISOString(), endDate?.toISOString(), buildingId],
    queryFn: async () => {
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
    },
  });
}

/**
 * Get terminations report - terminated/cancelled contracts
 */
export function useTerminationsReport(startDate?: Date, endDate?: Date, buildingId?: string) {
  return useQuery({
    queryKey: ["reports", "terminations", startDate?.toISOString(), endDate?.toISOString(), buildingId],
    queryFn: async () => {
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
        const { data: termData } = await supabase
          .from("contract_terminations")
          .select("contract_id, termination_type, termination_date, notes")
          .in("contract_id", contractIds);
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
      const { count: totalContracts } = await supabase
        .from("contracts")
        .select("id", { count: "exact", head: true })
        .is("deleted_at", null)
        .neq("status", "DRAFT");

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
    },
  });
}
