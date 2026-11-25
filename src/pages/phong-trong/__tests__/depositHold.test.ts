// Phòng giữ bằng phiếu cọc chờ hợp đồng (Sale phòng đợt 3, lỗi 21): khoá deposit_hold của hai reader trong app thành
// nhãn «Đã cọc · người nộp · N ngày»; link công khai / Hermes (không includeInternal) bỏ qua kể cả khi payload có.
import { describe, expect, it, vi } from 'vitest';
import { mapPayloadToBuildings, parseRoomSalePayload, type RpcPayload } from '../supabaseData';
import { depositHoldLines, depositHoldStale, isDepositHeld, parseRoomDepositHold } from '../depositHold';
import { roomSaleDepositLabel, roomSaleFacts } from '@/lib/roomSaleFacts';

vi.mock('@/integrations/supabase/client', () => ({ supabase: { storage: { from: () => ({ getPublicUrl: (path: string) => ({ data: { publicUrl: path } }) }) } } }));

const VOUCHER = '33333333-3333-4333-8333-333333333333';
const hold = { voucher_id: VOUCHER, code: 'PT2611443', voucher_date: '2026-11-22', payer_name: 'Chị Lan', held_days: 3, voucher_count: 1, room_occupied: false };
const base = { building_id: 'b', code: null, area: 20, rent_price: 4_000_000, max_occupants: 2, amenities: [], images: [], description: null,
  avail_date: null, sale_today: '2026-11-25', expected_ready_on: null };
const payload: RpcPayload = {
  buildings: [{ id: 'b', name: 'Toà A', code: 'A', district: null, ward: null, address: null, total_floors: 3 }],
  rooms: [
    { ...base, id: 'coc', floor: 1, name: 'G03', status_public: 'rented', sale_state: 'RENTED', deposit_hold: hold },
    { ...base, id: 'thue', floor: 2, name: '201', status_public: 'rented', sale_state: 'RENTED', deposit_hold: null },
    { ...base, id: 'trong', floor: 3, name: '301', status_public: 'free', sale_state: 'READY', deposit_hold: hold },
  ],
};
const roomOf = (includeInternal: boolean, id: string) =>
  mapPayloadToBuildings(parseRoomSalePayload(payload), { includeInternal })[0].rooms.find(r => r.id === id)!;

describe('nhãn «Đã cọc»', () => {
  it('ghi người nộp và số ngày giữ; chưa ghi người nộp hoặc mới cọc hôm nay vẫn đọc được', () => {
    expect(roomSaleDepositLabel({ payerName: 'Chị Lan', heldDays: 3 })).toBe('Đã cọc · Chị Lan · 3 ngày');
    expect(roomSaleDepositLabel({ payerName: null, heldDays: 0 })).toBe('Đã cọc · hôm nay');
    expect(roomSaleFacts({ status: 'rented', depositHold: { payerName: ' Anh B ', heldDays: 20 } }).label).toBe('Đã cọc · Anh B · 20 ngày');
    expect(roomSaleFacts({ status: 'rented' }).label).toBe('Đã thuê / giữ chỗ');
  });
});

describe('khoá deposit_hold', () => {
  it('trong app: phòng đã cọc hiện «Đã cọc · …» thay cho «Đã thuê / giữ chỗ»', () => {
    const room = roomOf(true, 'coc');
    expect(room.saleFact?.label).toBe('Đã cọc · Chị Lan · 3 ngày');
    expect(room.depositHold).toEqual({ voucherId: VOUCHER, code: 'PT2611443', voucherDate: '2026-11-22', payerName: 'Chị Lan',
      heldDays: 3, voucherCount: 1, roomOccupied: false });
    expect(isDepositHeld(room)).toBe(true);
    expect(roomOf(true, 'thue').saleFact?.label).toBe('Đã thuê / giữ chỗ');
    // Chỉ phòng 'rented' mới mang khối (máy chủ cũng chỉ trả cho phòng 'rented').
    expect(roomOf(true, 'trong').depositHold).toBeNull();
  });

  it('link công khai / Hermes (không includeInternal): không có khối, không có tên người nộp', () => {
    const room = roomOf(false, 'coc');
    expect(room.depositHold).toBeNull();
    expect(room.saleFact?.label).toBe('Đã thuê / giữ chỗ');
    expect(JSON.stringify(mapPayloadToBuildings(parseRoomSalePayload(payload)))).not.toContain('Chị Lan');
  });

  it('lệch dạng ⇒ coi như không có khối, không làm vỡ danh sách', () => {
    for (const bad of [{ ...hold, voucher_id: 'x' }, { ...hold, held_days: -1 }, { ...hold, voucher_count: 0 }, { ...hold, room_occupied: 'no' }, 'chuỗi'])
      expect(parseRoomDepositHold(bad)).toBeNull();
    expect(parseRoomDepositHold(null)).toBeNull();
    expect(parseRoomDepositHold({ ...hold, payer_name: '  ', code: null })).toMatchObject({ payerName: null, code: null });
  });

  it('dòng chi tiết: mã phiếu + ngày lập; nhiều phiếu; quá 14 ngày ⇒ cảnh báo', () => {
    const info = parseRoomDepositHold(hold)!;
    expect(depositHoldLines(info)).toEqual(['Phiếu PT2611443 · lập 22/11/2026']);
    expect(depositHoldStale(info)).toBe(false);
    const old = { ...info, heldDays: 15, voucherCount: 2, payerName: null };
    expect(depositHoldStale({ heldDays: 14 })).toBe(false);
    expect(depositHoldStale(old)).toBe(true);
    expect(depositHoldLines(old)).toEqual([
      'Phiếu PT2611443 · lập 22/11/2026 · chưa ghi người nộp',
      'Phòng có 2 phiếu cọc chờ hợp đồng — kiểm trước khi ký hợp đồng mới',
      'Quá 14 ngày chưa có hợp đồng — kiểm lại phiếu cọc',
    ]);
  });
});
