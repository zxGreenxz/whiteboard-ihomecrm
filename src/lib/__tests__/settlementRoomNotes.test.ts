// Ghi chú phòng ở thẻ Khoản thu của Quyết toán vận hành — cùng luật bỏ ghi chú của Báo cáo LN (chủ nhắn
// 24/10/2026). Dữ liệu giả, mã tạm như server trả.
import { describe, expect, it } from 'vitest';
import { settlementRoomDataSchema, settlementVoucherSchema, type SettlementVoucher } from '@/lib/landlordSettlement';
import { compareRoomOrNone, monthEndOf, settlementRoomNoteRows } from '@/lib/settlementRoomNotes';

type Obj = Record<string, unknown>;
const hd = (id: string, room: string, p: Obj = {}): Obj => ({
  id, room_id: room, status: 'ACTIVE', start_date: '2025-01-01', start_billing_date: null, end_date: null,
  actual_end_date: null, contract_number: null, ...p,
});
const hoaDon = (id: string, contract: string, total: number, paid: number): Obj => ({
  id, contract_id: contract, status: 'APPROVED', kind: 'MONTHLY', total_amount: total, paid_amount: paid,
  remaining_amount: total - paid, is_overdue: false,
});
const duLieu = (p: Obj = {}) => settlementRoomDataSchema.parse({
  rooms: [{ id: 'p1', name: '201', status: 'OCCUPIED' }, { id: 'p2', name: '202', status: 'AVAILABLE' }],
  contracts: [hd('h1', 'p1')], invoices: [], terminations: [], transfers: [], ...p,
});
const phieuThu = (room: string, coHoaDon: boolean): SettlementVoucher => settlementVoucherSchema.parse({
  code: 'PT', voucher_date: '2025-03-05', type: 'INCOME', name: 'Thu', account_name: null, side: 'LANDLORD',
  group: 'PNL', source: null, cash_reversed: false, cash_unposted: false, restricted: false, excluded_reason: null,
  status: 'APPROVED', amount: 1, room_name: room,
  invoice: coHoaDon ? {
    kind: 'MONTHLY', billing_month: '2025-03', issue_date: '2025-03-01', has_rent: true, has_service: false,
    is_first_month: false, is_liquidation: false, is_extra: false,
  } : null,
});
const nhan = (rows: ReturnType<typeof settlementRoomNoteRows>) => Object.fromEntries(rows.map((r) => [r.roomName, r.label]));

describe('settlementRoomNoteRows', () => {
  it('chưa có dữ liệu phòng (server cũ / tháng chưa áp dụng) ⇒ không ghi chú', () => {
    expect(settlementRoomNoteRows(null, '2025-03-01', [], '2026-10-24')).toEqual([]);
  });

  it('còn HĐ chưa có hoá đơn ⇒ "Chưa đóng"; phòng không HĐ ⇒ "Phòng trống"', () => {
    const rows = settlementRoomNoteRows(duLieu(), '2025-03-01', [], '2026-10-24');
    expect(nhan(rows)).toEqual({ 201: 'Chưa đóng', 202: 'Phòng trống' });
    expect(rows.find((r) => r.roomName === '201')?.text).toBe('Chưa có hoá đơn tháng này');
  });

  it('đã thu đủ / một phần ⇒ không ghi; chưa thu đồng nào ⇒ ghi số còn phải thu', () => {
    const ky = (paid: number) => nhan(settlementRoomNoteRows(duLieu({ invoices: [hoaDon('d1', 'h1', 3_000_000, paid)] }), '2025-03-01', [], '2026-10-24'));
    expect(ky(3_000_000)).toEqual({ 202: 'Phòng trống' });
    expect(ky(1_000_000)).toEqual({ 202: 'Phòng trống' });
    expect(ky(0)).toEqual({ 201: 'Chưa đóng', 202: 'Phòng trống' });
  });

  it('như Báo cáo LN: chưa có hoá đơn mà phòng đã có phiếu thu GẮN hoá đơn ⇒ thôi; phiếu không gắn hoá đơn thì vẫn ghi', () => {
    const d = duLieu();
    expect(nhan(settlementRoomNoteRows(d, '2025-03-01', [phieuThu('201', true)], '2026-10-24'))).toEqual({ 202: 'Phòng trống' });
    expect(nhan(settlementRoomNoteRows(d, '2025-03-01', [phieuThu('201', false)], '2026-10-24'))).toEqual({ 201: 'Chưa đóng', 202: 'Phòng trống' });
  });

  it('ảnh chốt cũ (phiếu chưa có tên phòng) ⇒ không ghi chú; phiếu hạn chế bị link chủ nhà bỏ tên phòng thì không tính', () => {
    const { room_name: _bo, ...khongTen } = phieuThu('201', false);
    const cu = settlementVoucherSchema.parse(khongTen);
    expect(cu.room_name).toBeUndefined();
    expect(settlementRoomNoteRows(duLieu(), '2025-03-01', [cu], '2026-10-24')).toEqual([]);
    const hanChe = settlementVoucherSchema.parse({ ...khongTen, restricted: true });
    expect(nhan(settlementRoomNoteRows(duLieu(), '2025-03-01', [hanChe], '2026-10-24'))).toEqual({ 201: 'Chưa đóng', 202: 'Phòng trống' });
  });

  it('phòng trống mà có khoản thu (thanh lý, bỏ cọc…) ⇒ không ghi "Phòng trống"', () => {
    expect(nhan(settlementRoomNoteRows(duLieu(), '2025-03-01', [phieuThu('202', false)], '2026-10-24'))).toEqual({ 201: 'Chưa đóng' });
  });

  it('HĐ kết thúc giữa tháng chưa thanh lý ⇒ "Chưa thanh lý" (link chủ nhà không có số HĐ)', () => {
    const d = duLieu({
      contracts: [hd('h1', 'p1'), hd('h2', 'p2', { status: 'TERMINATED', start_date: '2024-01-01', actual_end_date: '2025-03-10' })],
    });
    const rows = settlementRoomNoteRows(d, '2025-03-01', [], '2026-10-24');
    const ended = rows.find((r) => r.tone === 'ended');
    expect(ended?.label).toBe('Chưa thanh lý');
    expect(ended?.text).toBe('HĐ kết thúc 10/03 — chưa thanh lý');
  });

  it('số ngày trống đếm tới cuối tháng (tháng cũ) hoặc tới hôm nay (tháng này)', () => {
    const d = duLieu({
      contracts: [hd('h1', 'p1'), hd('h2', 'p2', { status: 'EXPIRED', start_date: '2024-01-01', end_date: '2025-02-20' })],
    });
    const trong = (ky: string, homNay: string) =>
      settlementRoomNoteRows(d, ky, [], homNay).find((r) => r.roomName === '202')?.text;
    expect(trong('2025-03-01', '2026-10-24')).toBe('Trống 39 ngày từ 20/02 — Hết hạn HĐ');
    expect(trong('2025-03-01', '2025-03-10')).toBe('Trống 18 ngày từ 20/02 — Hết hạn HĐ');
  });
});

describe('monthEndOf / compareRoomOrNone', () => {
  it('cuối tháng kể cả tháng 2 năm nhuận', () => {
    expect(monthEndOf('2025-02-01')).toBe('2025-02-28');
    expect(monthEndOf('2024-02-01')).toBe('2024-02-29');
    expect(monthEndOf('2026-12-01')).toBe('2026-12-31');
  });

  it('MB → G → L → số; không có phòng xuống cuối', () => {
    const ds = ['PARIS 2', null, '101', 'L2', 'G1', 'MB', '20'];
    expect([...ds].sort(compareRoomOrNone)).toEqual(['MB', 'G1', 'L2', '20', '101', 'PARIS 2', null]);
  });
});
