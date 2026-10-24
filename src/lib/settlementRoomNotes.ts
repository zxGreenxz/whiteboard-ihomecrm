// =============================================================================
// settlementRoomNotes — thẻ "Khoản thu" của Quyết toán vận hành hiện ĐỦ phòng như Báo cáo Lợi Nhuận (chủ nhắn
// 24/10/2026: "paris 2 chưa đóng tiền mà không thấy hiện, tham khảo lại cách sắp xếp của báo cáo lợi nhuận").
//   · ghi chú phòng: buildVacantRoomNotes (src/lib/vacantRoomNotes.ts) trên dữ liệu thô server trả trong gói tháng;
//   · bỏ ghi chú như ProfitDistributionReport: phòng đã thu đủ / một phần không ghi; chưa có hoá đơn mà phòng đã
//     có khoản thu gắn hoá đơn thì thôi; phòng trống mà có khoản thu (thanh lý, bỏ cọc…) thì thôi;
//   · chữ: activeRoomNoteText / endedUnsettledNoteText (profitReportChecks) và vacancyNoteText;
//   · xếp: phòng (compareRoomNames, không phòng xuống cuối) rồi mô tả.
// Phiếu ↔ phòng khớp theo TÊN phòng (gói tháng không có id phòng thật).
// =============================================================================
import { activeRoomNoteText, endedUnsettledNoteText } from '@/lib/profitReportChecks';
import type { SettlementRoomData, SettlementVoucher } from '@/lib/landlordSettlement';
import { compareRoomNames } from '@/lib/roomSort';
import { vacancyNoteText } from '@/lib/vacancyReason';
import { buildVacantRoomNotes } from '@/lib/vacantRoomNotes';

export type SettlementRoomNoteTone = 'unpaid' | 'vacant' | 'ended';

export interface SettlementRoomNoteRow {
  key: string;
  roomName: string;
  tone: SettlementRoomNoteTone;
  /** Nhãn ngắn: "Chưa đóng" / "Phòng trống" / "Chưa thanh lý". */
  label: string;
  /** Chữ chi tiết như Báo cáo LN. */
  text: string;
}

/** Ngày cuối tháng 'YYYY-MM-DD' của kỳ (nhận 'YYYY-MM-DD' bất kỳ trong tháng). */
export function monthEndOf(periodMonth: string): string {
  const ym = periodMonth.slice(0, 7);
  const [y, m] = ym.split('-').map(Number);
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return `${ym}-${String(last).padStart(2, '0')}`;
}

/**
 * Dòng ghi chú phòng của tháng. `incomeVouchers` = các phiếu thu đang liệt kê trong thẻ (để bỏ phòng đã có
 * khoản thu như Báo cáo LN); `today` = 'YYYY-MM-DD' giờ VN (mốc đếm số ngày trống).
 */
export function settlementRoomNoteRows(
  roomData: SettlementRoomData | null,
  periodMonth: string,
  incomeVouchers: readonly SettlementVoucher[],
  today: string,
): SettlementRoomNoteRow[] {
  if (!roomData) return [];
  // Ảnh chốt trước 23/10/2026 không có tên phòng ở phiếu ⇒ không biết phòng nào đã có khoản thu, bỏ ghi chú
  // (phiếu hạn chế ở link chủ nhà bị server bỏ tên phòng có chủ đích — không tính).
  if (incomeVouchers.some((v) => v.room_name === undefined && !v.restricted)) return [];
  const monthEnd = monthEndOf(periodMonth);
  const refDate = monthEnd < today ? monthEnd : today;
  // chép từng trường: tsconfig không strict suy mọi trường zod là optional
  const notes = buildVacantRoomNotes({
    rooms: roomData.rooms.map((r) => ({ id: r.id, name: r.name, status: r.status, building_id: '', building_name: '' })),
    contracts: roomData.contracts.map((c) => ({
      id: c.id, room_id: c.room_id, status: c.status, start_date: c.start_date, start_billing_date: c.start_billing_date,
      end_date: c.end_date, actual_end_date: c.actual_end_date, contract_number: c.contract_number,
    })),
    invoices: roomData.invoices.map((i) => ({
      id: i.id, contract_id: i.contract_id, status: i.status, kind: i.kind, total_amount: i.total_amount,
      paid_amount: i.paid_amount, remaining_amount: i.remaining_amount, is_overdue: i.is_overdue,
    })),
    terminations: roomData.terminations.map((t) => ({
      contract_id: t.contract_id, termination_type: t.termination_type, termination_date: t.termination_date,
      actual_move_out_date: t.actual_move_out_date, status: t.status,
    })),
    transfers: roomData.transfers.map((t) => ({
      old_room_id: t.old_room_id, transfer_type: t.transfer_type, transfer_date: t.transfer_date, status: t.status,
    })),
  }, monthEnd, true);

  const anyIncomeRooms = new Set<string>();
  const invoicedIncomeRooms = new Set<string>();
  for (const v of incomeVouchers) {
    if (!v.room_name) continue;
    anyIncomeRooms.add(v.room_name);
    if (v.invoice) invoicedIncomeRooms.add(v.room_name);
  }

  const out: SettlementRoomNoteRow[] = [];
  for (const [key, note] of notes) {
    const base = { key, roomName: note.roomName };
    if (note.kind === 'ended_unsettled') {
      out.push({ ...base, tone: 'ended', label: 'Chưa thanh lý', text: endedUnsettledNoteText(note) });
    } else if (note.kind === 'active') {
      const st = note.invoiceState;
      if (st === 'paid' || st === 'partial') continue;
      if (st === 'none' && invoicedIncomeRooms.has(note.roomName)) continue;
      out.push({ ...base, tone: 'unpaid', label: 'Chưa đóng', text: activeRoomNoteText(note) });
    } else if (!anyIncomeRooms.has(note.roomName)) {
      out.push({ ...base, tone: 'vacant', label: 'Phòng trống', text: vacancyNoteText(note.reason, note.vacantSince, refDate) });
    }
  }
  return out;
}

/** Xếp như Báo cáo LN: tên phòng (MB → G → L → số), không có phòng xuống cuối. */
export function compareRoomOrNone(a: string | null | undefined, b: string | null | undefined): number {
  if (!a && !b) return 0;
  if (!a) return 1;
  if (!b) return -1;
  return compareRoomNames(a, b);
}
