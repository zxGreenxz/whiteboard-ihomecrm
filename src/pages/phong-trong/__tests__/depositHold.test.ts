// Phòng giữ bằng cọc chờ hợp đồng (Sale phòng đợt 3, lỗi 21): khoá deposit_hold của hai reader trong app (đợt giữ chỗ
// của #499 hoặc phiếu treo chưa nối). Nhãn CÔNG KHAI saleFact.label chỉ «Đang giữ chỗ» (đi vào tin chia sẻ, ảnh bảng);
// «Đã cọc · người gửi · N ngày» là nhãn riêng của bảng Sale nội bộ. Link công khai / Hermes (không includeInternal) bỏ qua
// khối kể cả khi payload có; người xem không có deposits.view thì máy chủ không trả tên / mã phiếu (detail = false).
import { describe, expect, it, vi } from 'vitest';
import { mapPayloadToBuildings, parseRoomSalePayload, type RpcPayload } from '../supabaseData';
import { depositHoldLines, depositHoldStale, isDepositHeld, parseRoomDepositHold } from '../depositHold';
import { DEPOSIT_HOLD_PUBLIC_LABEL, roomSaleDepositLabel, roomSaleFacts } from '@/lib/roomSaleFacts';
import type { RoomDepositHoldInfo } from '../sampleData';

vi.mock('@/integrations/supabase/client', () => ({ supabase: { storage: { from: () => ({ getPublicUrl: (path: string) => ({ data: { publicUrl: path } }) }) } } }));

const HOLD = '44444444-4444-4444-8444-444444444444';
const VOUCHER = '33333333-3333-4333-8333-333333333333';
const dot = { source: 'hold', hold_id: HOLD, voucher_id: VOUCHER, code: 'PT2611443', codes: ['PT2611443', 'PT2611450'], voucher_date: '2026-11-22',
  payer_name: 'Chị Lan', held_days: 3, voucher_count: 2, room_occupied: false, detail: true };
const treo = { source: 'voucher', hold_id: null, voucher_id: VOUCHER, code: 'PT2605004', codes: ['PT2605004'], voucher_date: '2026-05-27',
  payer_name: null, held_days: 182, voucher_count: 1, room_occupied: true, detail: true };
// Người xem không có deposits.view ở toà: máy chủ bỏ người gửi, mã phiếu, id.
const anDanh = { source: 'hold', hold_id: null, voucher_id: null, code: null, codes: [], voucher_date: '2026-11-22',
  payer_name: null, held_days: 3, voucher_count: 2, room_occupied: false, detail: false };
const base = { building_id: 'b', code: null, area: 20, rent_price: 4_000_000, max_occupants: 2, amenities: [], images: [], description: null,
  avail_date: null, sale_today: '2026-11-25', expected_ready_on: null };
const payload: RpcPayload = {
  buildings: [{ id: 'b', name: 'Toà A', code: 'A', district: null, ward: null, address: null, total_floors: 3 }],
  rooms: [
    { ...base, id: 'coc', floor: 1, name: 'G03', status_public: 'rented', sale_state: 'RENTED', has_deposit_hold: true, deposit_hold: dot },
    { ...base, id: 'co', floor: 1, name: 'G04', status_public: 'rented', sale_state: 'RENTED', has_deposit_hold: true },
    { ...base, id: 'treo', floor: 2, name: '104', status_public: 'rented', sale_state: 'RENTED', has_deposit_hold: false, deposit_hold: treo },
    { ...base, id: 'thue', floor: 2, name: '201', status_public: 'rented', sale_state: 'RENTED', deposit_hold: null },
    { ...base, id: 'trong', floor: 3, name: '301', status_public: 'free', sale_state: 'READY', deposit_hold: dot },
    { ...base, id: 'an', floor: 3, name: '302', status_public: 'rented', sale_state: 'RENTED', has_deposit_hold: true, deposit_hold: anDanh },
  ],
};
const roomOf = (includeInternal: boolean, id: string) =>
  mapPayloadToBuildings(parseRoomSalePayload(payload), { includeInternal })[0].rooms.find(r => r.id === id)!;

describe('nhãn «Đã cọc» (nội bộ) và nhãn công khai', () => {
  it('nhãn nội bộ ghi người gửi và số ngày giữ; chưa ghi / không được xem người gửi hoặc mới cọc hôm nay vẫn đọc được', () => {
    expect(roomSaleDepositLabel({ payerName: 'Chị Lan', heldDays: 3 })).toBe('Đã cọc · Chị Lan · 3 ngày');
    expect(roomSaleDepositLabel({ payerName: ' Anh B ', heldDays: 20 })).toBe('Đã cọc · Anh B · 20 ngày');
    expect(roomSaleDepositLabel({ payerName: null, heldDays: 0 })).toBe('Đã cọc · hôm nay');
  });
  it('nhãn công khai không bao giờ có người gửi', () => {
    expect(roomSaleFacts({ status: 'rented', hasDepositHold: true }).label).toBe(DEPOSIT_HOLD_PUBLIC_LABEL);
    expect(DEPOSIT_HOLD_PUBLIC_LABEL).toBe('Đang giữ chỗ');
    expect(roomSaleFacts({ status: 'rented' }).label).toBe('Đã thuê / giữ chỗ');
  });
});

describe('khoá deposit_hold', () => {
  it('trong app: khối người cọc ở depositHold (cho bảng nội bộ), nhãn công khai vẫn «Đang giữ chỗ», giữ cờ has_deposit_hold', () => {
    const room = roomOf(true, 'coc');
    expect(room.saleFact?.label).toBe('Đang giữ chỗ');
    expect(JSON.stringify(room.saleFact)).not.toContain('Chị Lan');
    expect(room.hasDepositHold).toBe(true);
    expect(room.depositHold).toEqual({ source: 'hold', holdId: HOLD, voucherId: VOUCHER, code: 'PT2611443', codes: ['PT2611443', 'PT2611450'],
      voucherDate: '2026-11-22', payerName: 'Chị Lan', heldDays: 3, voucherCount: 2, roomOccupied: false, detail: true });
    expect(isDepositHeld(room)).toBe(true);
  });

  it('chỉ có cờ ⇒ «Đang giữ chỗ» như #499; phiếu treo ở phòng còn khách ở ⇒ nhãn công khai theo tình trạng phòng', () => {
    expect(roomOf(true, 'co').saleFact?.label).toBe('Đang giữ chỗ');
    expect(isDepositHeld(roomOf(true, 'co'))).toBe(true);
    expect(roomOf(true, 'treo').saleFact?.label).toBe('Đã thuê / giữ chỗ');
    expect(isDepositHeld(roomOf(true, 'treo'))).toBe(true);
    expect(roomSaleDepositLabel(roomOf(true, 'treo').depositHold!)).toBe('Đã thu · Chưa xác định lượt thuê');
    expect(roomOf(true, 'thue').saleFact?.label).toBe('Đã thuê / giữ chỗ');
    // Chỉ phòng 'rented' mới mang khối (máy chủ cũng chỉ trả cho phòng 'rented').
    expect(roomOf(true, 'trong').depositHold).toBeNull();
  });

  it('link công khai / Hermes (không includeInternal): không khối, không cờ, không tên người gửi', () => {
    const room = roomOf(false, 'coc');
    expect(room.depositHold).toBeNull();
    expect(room.hasDepositHold).toBe(false);
    expect(room.saleFact?.label).toBe('Đã thuê / giữ chỗ');
    expect(JSON.stringify(mapPayloadToBuildings(parseRoomSalePayload(payload)))).not.toContain('Chị Lan');
  });

  it('không có deposits.view: khối không tên / mã phiếu; nhãn nội bộ «Đã cọc · N ngày», dòng chi tiết chỉ số phiếu + ngày', () => {
    const room = roomOf(true, 'an');
    expect(room.depositHold).toEqual({ source: 'hold', holdId: null, voucherId: null, code: null, codes: [], voucherDate: '2026-11-22',
      payerName: null, heldDays: 3, voucherCount: 2, roomOccupied: false, detail: false });
    expect(roomSaleDepositLabel(room.depositHold!)).toBe('Đã cọc · 3 ngày');
    expect(depositHoldLines(room.depositHold!)).toEqual(['2 phiếu cọc · nhận đầu 22/11/2026']);
    expect(depositHoldLines({ ...room.depositHold!, voucherCount: 0 })).toEqual(['Đợt giữ chỗ từ 22/11/2026 · chưa có phiếu thu']);
    // detail = false mà vẫn kèm tên / mã ⇒ dạng sai, bỏ khối.
    for (const bad of [{ ...anDanh, payer_name: 'Chị Lan' }, { ...anDanh, codes: ['PT1'] }, { ...anDanh, code: 'PT1' }])
      expect(parseRoomDepositHold(bad)).toBeNull();
  });

  it('lệch dạng ⇒ coi như không có khối, không làm vỡ danh sách', () => {
    for (const bad of [{ ...dot, hold_id: null }, { ...dot, source: 'x' }, { ...dot, held_days: -1 }, { ...treo, voucher_count: 0 },
      { ...dot, codes: 'PT1' }, { ...dot, room_occupied: 'no' }, 'chuỗi'])
      expect(parseRoomDepositHold(bad)).toBeNull();
    expect(parseRoomDepositHold(null)).toBeNull();
    expect(parseRoomDepositHold({ ...dot, payer_name: '  ', code: null })).toMatchObject({ payerName: null, code: null });
  });

  it('dòng chi tiết: các mã phiếu + ngày nhận đầu; phiếu treo nhiều phiếu; quá 14 ngày ⇒ cảnh báo', () => {
    const d = parseRoomDepositHold(dot)!;
    expect(depositHoldLines(d)).toEqual(['Phiếu PT2611443, PT2611450 · nhận đầu 22/11/2026']);
    expect(depositHoldStale(d)).toBe(false);
    expect(depositHoldStale({ heldDays: 14 })).toBe(false);
    const cu: RoomDepositHoldInfo = { ...parseRoomDepositHold(treo)!, voucherCount: 2, codes: ['PT2605004', 'PT2606001'] };
    expect(depositHoldStale(cu)).toBe(true);
    expect(depositHoldLines(cu)).toEqual([
      'Phiếu PT2605004, PT2606001 · nhận 27/05/2026 · chờ đối chiếu lượt thuê',
      'Phiếu đã thu quá 14 ngày, cần đối chiếu lượt thuê.',
    ]);
    expect(depositHoldLines({ ...d, codes: [], code: null, voucherId: null, voucherCount: 0 })).toEqual(['Đợt giữ chỗ từ 22/11/2026 · chưa có phiếu thu']);
  });
});
