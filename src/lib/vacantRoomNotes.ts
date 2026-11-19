// =============================================================================
// vacantRoomNotes — ghi chú phòng của một tháng (phòng còn HĐ chưa đóng / chưa có hoá đơn, phòng trống + lý
// do, HĐ kết thúc giữa tháng chưa thanh lý). Hàm THUẦN: nhận dữ liệu thô, không đọc database.
//
// Một luật cho hai nơi (chủ nhắn 24/10/2026 "tham khảo cách sắp xếp của báo cáo lợi nhuận"):
//   · Báo cáo Lợi Nhuận — useVacantRoomNotes (src/hooks/reports/realEstateReports.ts) đọc bảng bằng
//     PostgREST rồi gọi buildVacantRoomNotes;
//   · Quyết toán vận hành (cả link chủ nhà chạy bằng anon) — server trả dữ liệu thô của toà × tháng trong gói
//     tháng (landlord_room_data_v1, id đã thay bằng mã tạm), web gọi cùng buildVacantRoomNotes.
// Luật chuyển NGUYÊN từ queryFn cũ của useVacantRoomNotes (F14, F45, F46, F57) — đổi luật ở đây là đổi cả hai.
// =============================================================================
import type { VacantRoomNote } from '@/hooks/reports/types';
import { resolveVacancyInfo, type VacancyEvent } from '@/lib/vacancyReason';

/** Phòng (chưa xoá) của các toà đang xét. */
export interface RoomNoteRoomRow {
  id: string;
  name: string | null;
  status: string | null;
  building_id: string;
  building_name: string;
}

/** Hợp đồng (chưa xoá, mọi status) của các phòng trên. */
export interface RoomNoteContractRow {
  id: string;
  room_id: string | null;
  status: string;
  start_date: string | null;
  start_billing_date: string | null;
  end_date: string | null;
  actual_end_date: string | null;
  contract_number: string | null;
}

/** Hoá đơn kỳ đang xem (billing_month = tháng, chưa huỷ, chưa xoá). */
export interface RoomNoteInvoiceRow {
  id: string;
  contract_id: string;
  status: string;
  kind: string | null;
  total_amount: number | string | null;
  paid_amount: number | string | null;
  remaining_amount: number | string | null;
  is_overdue: boolean | null;
}

export interface RoomNoteTerminationRow {
  contract_id: string;
  termination_type: string | null;
  termination_date: string | null;
  actual_move_out_date: string | null;
  status: string | null;
}

/** Chuyển phòng / sang nhượng theo phòng CŨ. */
export interface RoomNoteTransferRow {
  old_room_id: string | null;
  transfer_type: string | null;
  transfer_date: string | null;
  status: string | null;
}

export interface RoomNoteInput {
  rooms: readonly RoomNoteRoomRow[];
  contracts: readonly RoomNoteContractRow[];
  invoices: readonly RoomNoteInvoiceRow[];
  /** Có thể dư (mọi thanh lý của các HĐ trên) — hàm tự lọc theo HĐ cần. */
  terminations: readonly RoomNoteTerminationRow[];
  /** Có thể dư — hàm tự lọc: phòng trống, đã duyệt/hoàn tất, ngày ≤ cuối tháng. */
  transfers: readonly RoomNoteTransferRow[];
}

const toAmount = (v: number | string | null | undefined): number => {
  const n = Number(v ?? 0);
  return Number.isFinite(n) ? n : 0;
};

/** Còn phải thu của một hoá đơn (không âm) — ưu tiên cột sinh remaining_amount. */
const invoiceRemaining = (inv: RoomNoteInvoiceRow): number =>
  Math.max(0, inv.remaining_amount != null ? toAmount(inv.remaining_amount) : toAmount(inv.total_amount) - toAmount(inv.paid_amount));

/** Phòng giữ chỗ / bảo trì / ngưng cho thuê: không coi là trống. */
const SKIP_STATUS = new Set(['RESERVED', 'MAINTENANCE', 'UNAVAILABLE']);
const TRANSFER_OK = new Set(['APPROVED', 'COMPLETED']);

/** Các phần trung gian dùng chung cho hai bước (tra cần đọc gì / dựng ghi chú). */
function phanLoai(rooms: readonly RoomNoteRoomRow[], contracts: readonly RoomNoteContractRow[], monthEndDate: string,
  includeEnded: boolean) {
  const ym = monthEndDate.slice(0, 7);
  const monthStart = `${ym}-01`;
  const roomById = new Map(rooms.map((r) => [r.id, r] as const));

  // Phòng có HĐ đã tới kỳ phải xuất hoá đơn (billing bắt đầu ≤ cuối tháng) VÀ còn hiệu lực tới cuối tháng → kỳ
  // vọng có hoá đơn tháng này. HĐ thanh lý đầu tháng SAU vẫn phủ tháng này ⇒ vẫn xét (không chỉ status ACTIVE).
  const activeContractsByRoom = new Map<string, string[]>();
  for (const c of contracts) {
    if (!c.room_id) continue;
    const billStart = c.start_billing_date || c.start_date || '';
    if (!billStart || billStart > monthEndDate) continue; // chưa tới kỳ tính tiền
    const end = c.actual_end_date || c.end_date || '';
    if (c.status !== 'ACTIVE' && !(end && end >= monthEndDate)) continue;
    const list = activeContractsByRoom.get(c.room_id);
    if (list) list.push(c.id);
    else activeContractsByRoom.set(c.room_id, [c.id]);
  }

  // Phòng "đang ở tại CUỐI tháng": HĐ ACTIVE đã bắt đầu (month-to-month vẫn ở), hoặc HĐ đã kết thúc nhưng còn
  // hiệu lực tới cuối tháng.
  const occupied = new Set<string>();
  for (const c of contracts) {
    if (!c.room_id) continue;
    const start = c.start_date ?? '';
    if (!start || start > monthEndDate) continue;
    if (c.status === 'ACTIVE') {
      occupied.add(c.room_id);
      continue;
    }
    const end = c.actual_end_date || c.end_date || '';
    if (end && end >= monthEndDate) occupied.add(c.room_id);
  }

  const flagged = rooms.filter((r) => !occupied.has(r.id) && !SKIP_STATUS.has(r.status ?? ''));
  const flaggedIds = new Set<string>(flagged.map((r) => r.id));

  // F46: HĐ kết thúc GIỮA tháng (từ ngày 1 tới trước ngày cuối tháng), đã từng tới kỳ tính tiền.
  const endedInMonth = includeEnded
    ? contracts.filter((c) => {
        if (c.status !== 'TERMINATED' && c.status !== 'EXPIRED') return false;
        if (!c.room_id || !roomById.has(c.room_id)) return false;
        const end = c.actual_end_date || c.end_date || '';
        if (!end || end < monthStart || end >= monthEndDate) return false;
        const billStart = c.start_billing_date || c.start_date || '';
        return !!billStart && billStart <= end;
      })
    : [];

  // HĐ đã kết thúc (≤ cuối tháng) của các phòng trống → tra lý do (thanh lý / hết hạn).
  const endedByContract = new Map<string, { roomId: string; date: string | null; plannedEnd: string | null; status: string }>();
  for (const c of contracts) {
    if (!c.room_id || !flaggedIds.has(c.room_id) || c.status === 'ACTIVE') continue;
    const end = c.actual_end_date || c.end_date || null;
    if (end && end > monthEndDate) continue; // kết thúc sau tháng → bỏ
    endedByContract.set(c.id, { roomId: c.room_id, date: end, plannedEnd: c.end_date ?? null, status: c.status });
  }

  return { roomById, activeContractsByRoom, flagged, flaggedIds, endedInMonth, endedByContract };
}

/**
 * Những gì còn phải đọc sau khi có phòng + HĐ (để nơi đọc bảng chỉ lấy đúng phần cần): thanh lý của các HĐ
 * nào, chuyển phòng của các phòng nào, có cần hoá đơn kỳ không.
 */
export function roomNoteLookups(
  rooms: readonly RoomNoteRoomRow[],
  contracts: readonly RoomNoteContractRow[],
  monthEndDate: string,
  includeEnded: boolean,
): { needInvoices: boolean; terminationContractIds: string[]; transferRoomIds: string[] } {
  const p = phanLoai(rooms, contracts, monthEndDate, includeEnded);
  return {
    needInvoices: p.activeContractsByRoom.size > 0 || p.endedInMonth.length > 0,
    terminationContractIds: [...new Set([...p.endedByContract.keys(), ...p.endedInMonth.map((c) => c.id)])],
    transferRoomIds: [...p.flaggedIds],
  };
}

/**
 * Ghi chú phòng của tháng (khoá Map: roomId; HĐ kết thúc giữa tháng chưa thanh lý: `ended:<contractId>`).
 * 'active' = phòng còn HĐ (kèm trạng thái hoá đơn TIỀN PHÒNG kỳ này); 'vacant' = trống thật (kèm lý do, ngày
 * bắt đầu trống); 'ended_unsettled' chỉ khi includeEnded.
 */
export function buildVacantRoomNotes(input: RoomNoteInput, monthEndDate: string, includeEnded: boolean): Map<string, VacantRoomNote> {
  const { roomById, activeContractsByRoom, flagged, flaggedIds, endedInMonth, endedByContract } =
    phanLoai(input.rooms, input.contracts, monthEndDate, includeEnded);

  // Hoá đơn kỳ này — khớp theo contract_id (HĐ đổi phòng tại chỗ vẫn khớp).
  const invoicesByContract = new Map<string, RoomNoteInvoiceRow[]>();
  for (const inv of input.invoices) {
    const list = invoicesByContract.get(inv.contract_id);
    if (list) list.push(inv);
    else invoicesByContract.set(inv.contract_id, [inv]);
  }

  const out = new Map<string, VacantRoomNote>();
  // Phòng CÒN HĐ + trạng thái hoá đơn TIỀN PHÒNG (MONTHLY) kỳ này.
  for (const r of input.rooms) {
    const contractIds = activeContractsByRoom.get(r.id);
    if (!contractIds) continue;
    const invoices = contractIds
      .flatMap((id) => invoicesByContract.get(id) ?? [])
      .filter((inv) => (inv.kind ?? 'MONTHLY') === 'MONTHLY');
    const total = invoices.reduce((s, inv) => s + toAmount(inv.total_amount), 0);
    const paid = invoices.reduce((s, inv) => s + toAmount(inv.paid_amount), 0);
    const remaining = invoices.reduce((s, inv) => s + invoiceRemaining(inv), 0);
    const invoiceState: VacantRoomNote['invoiceState'] =
      invoices.length === 0 ? 'none' : remaining <= 0 ? 'paid' : paid > 0 ? 'partial' : 'unpaid';
    out.set(r.id, {
      roomId: r.id,
      roomName: r.name ?? '',
      buildingId: r.building_id,
      buildingName: r.building_name,
      kind: 'active',
      invoiceState,
      invoiceIds: invoices.map((inv) => inv.id),
      invoiceTotal: total,
      invoicePaid: paid,
      invoiceRemaining: remaining,
      invoiceOverdue: invoices.some(
        (inv) => invoiceRemaining(inv) > 0 && (inv.status === 'OVERDUE' || inv.is_overdue === true),
      ),
    });
  }

  // Thanh lý: chỉ các HĐ cần (lý do trống + F46) — dữ liệu vào có thể dư.
  const terminationIds = new Set([...endedByContract.keys(), ...endedInMonth.map((c) => c.id)]);
  const terminations = input.terminations.filter((t) => terminationIds.has(t.contract_id));

  // Phòng TRỐNG (kind 'vacant' + lý do).
  if (flagged.length > 0) {
    const transfers = input.transfers.filter((t) =>
      !!t.old_room_id && flaggedIds.has(t.old_room_id) && TRANSFER_OK.has(t.status ?? '')
      && (!t.transfer_date || t.transfer_date <= monthEndDate));

    const eventsByRoom = new Map<string, VacancyEvent[]>();
    const pushEv = (roomId: string | null | undefined, ev: VacancyEvent) => {
      if (!roomId) return;
      const arr = eventsByRoom.get(roomId);
      if (arr) arr.push(ev);
      else eventsByRoom.set(roomId, [ev]);
    };
    const hasTerminationRow = new Set<string>();
    for (const t of terminations) {
      const ended = endedByContract.get(t.contract_id);
      if (!ended) continue;
      hasTerminationRow.add(t.contract_id);
      pushEv(ended.roomId, {
        kind: 'termination',
        type: t.termination_type ?? null,
        date: t.actual_move_out_date || t.termination_date || ended.date,
      });
    }
    for (const [cid, c] of endedByContract) {
      if (hasTerminationRow.has(cid)) continue;
      if (c.status === 'EXPIRED') {
        pushEv(c.roomId, { kind: 'expired', date: c.date });
        continue;
      }
      // HĐ đóng tay không có bản ghi thanh lý: kết thúc SỚM hơn hạn → Thanh lý HĐ, đủ/quá hạn → Hết hạn HĐ.
      const early = !!c.date && !!c.plannedEnd && c.date < c.plannedEnd;
      pushEv(c.roomId, early ? { kind: 'termination', type: null, date: c.date } : { kind: 'expired', date: c.date });
    }
    for (const t of transfers) {
      pushEv(t.old_room_id, { kind: 'transfer', type: t.transfer_type ?? null, date: t.transfer_date ?? null });
    }

    for (const r of flagged) {
      const info = resolveVacancyInfo(eventsByRoom.get(r.id) ?? []);
      out.set(r.id, {
        roomId: r.id,
        roomName: r.name ?? '',
        buildingId: r.building_id,
        buildingName: r.building_name,
        kind: 'vacant',
        reason: info.reason,
        vacantSince: info.since,
      });
    }
  }

  // F46: HĐ kết thúc giữa tháng chưa thanh lý. Gắn cờ khi KHÔNG có bản ghi thanh lý (chưa huỷ) nào, hoặc thanh
  // lý chưa duyệt/hoàn tất mà cũng chưa có hoá đơn kỳ này. Thanh lý đã duyệt mà không có hoá đơn là bình thường.
  if (endedInMonth.length > 0) {
    const termsByContract = new Map<string, RoomNoteTerminationRow[]>();
    for (const t of terminations) {
      if (t.status === 'CANCELLED') continue;
      const list = termsByContract.get(t.contract_id);
      if (list) list.push(t);
      else termsByContract.set(t.contract_id, [t]);
    }
    for (const c of endedInMonth) {
      const room = c.room_id ? roomById.get(c.room_id) : undefined;
      if (!room) continue;
      const terms = termsByContract.get(c.id) ?? [];
      const missingTermination = terms.length === 0;
      const settled = terms.some((t) => t.status === 'APPROVED' || t.status === 'COMPLETED');
      const invoices = invoicesByContract.get(c.id) ?? [];
      const hasFinalInvoice = invoices.length > 0;
      if (!missingTermination && (hasFinalInvoice || settled)) continue;
      out.set(`ended:${c.id}`, {
        roomId: room.id,
        roomName: room.name ?? '',
        buildingId: room.building_id,
        buildingName: room.building_name,
        kind: 'ended_unsettled',
        contractId: c.id,
        contractNumber: c.contract_number ?? null,
        endedOn: c.actual_end_date || c.end_date || null,
        missingTermination,
        hasFinalInvoice,
        finalInvoiceRemaining: invoices.reduce((s, inv) => s + invoiceRemaining(inv), 0),
      });
    }
  }

  return out;
}
