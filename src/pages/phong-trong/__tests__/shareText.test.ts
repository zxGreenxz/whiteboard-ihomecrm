// Tin «Chia sẻ» gửi khách và cột TÌNH TRẠNG của ảnh / bảng «Danh sách phòng trống» ra NGOÀI công ty: phòng giữ bằng cọc
// chỉ ghi nhãn công khai «Đang giữ chỗ», không tên người cọc, không mã phiếu (review PR #502 mục 2, 26/11/2026). Đi đúng
// đường thật: payload của reader trong app (includeInternal, có khối deposit_hold đủ chi tiết) → mapPayloadToBuildings →
// buildShareText / statusLines.
import { describe, expect, it, vi } from 'vitest';
import { mapPayloadToBuildings, parseRoomSalePayload, type RpcPayload } from '../supabaseData';
import { buildShareText } from '../shareText';
import { autoStatusLines, statusLines } from '../roomListTable';

vi.mock('@/integrations/supabase/client', () => ({ supabase: { storage: { from: () => ({ getPublicUrl: (path: string) => ({ data: { publicUrl: path } }) }) } } }));

const SECRETS = ['Chị Lan', 'PT2611443', 'PT2611450', 'PT2605004', 'Đã cọc', '44444444-4444-4444-8444-444444444444'];
const dot = { source: 'hold', hold_id: '44444444-4444-4444-8444-444444444444', voucher_id: '33333333-3333-4333-8333-333333333333',
  code: 'PT2611443', codes: ['PT2611443', 'PT2611450'], voucher_date: '2026-11-22', payer_name: 'Chị Lan', held_days: 3,
  voucher_count: 2, room_occupied: false, detail: true };
const treo = { ...dot, source: 'voucher', hold_id: null, code: 'PT2605004', codes: ['PT2605004'], voucher_date: '2026-05-27',
  held_days: 182, voucher_count: 1, room_occupied: true };
const base = { building_id: 'b', code: null, area: 20, rent_price: 4_000_000, max_occupants: 2, amenities: ['máy lạnh'], images: [],
  description: null, avail_date: null, sale_today: '2026-11-25', expected_ready_on: null };
const payload: RpcPayload = {
  buildings: [{ id: 'b', name: 'Toà A', code: 'A', district: null, ward: null, address: '102/30 Lê Văn Thọ, Hồ Chí Minh', total_floors: 3 }],
  rooms: [
    { ...base, id: 'dot', floor: 1, name: 'G03', status_public: 'rented', sale_state: 'RENTED', has_deposit_hold: true, deposit_hold: dot },
    { ...base, id: 'treo', floor: 2, name: '104', status_public: 'rented', sale_state: 'RENTED', has_deposit_hold: false, deposit_hold: treo },
    { ...base, id: 'trong', floor: 3, name: '301', status_public: 'free', sale_state: 'READY' },
  ],
};
const rooms = mapPayloadToBuildings(parseRoomSalePayload(payload), { includeInternal: true })[0].rooms;
const roomOf = (id: string) => rooms.find(r => r.id === id)!;

describe('tin «Chia sẻ» gửi khách', () => {
  it('phòng đang giữ bằng cọc (đợt giữ chỗ): «Tình trạng: Đang giữ chỗ», không tên người cọc / mã phiếu', () => {
    const room = roomOf('dot');
    expect(room.depositHold?.payerName).toBe('Chị Lan'); // khối nội bộ vẫn có — chỉ không được ra ngoài
    const text = buildShareText(room);
    expect(text).toContain('• Tình trạng: Đang giữ chỗ');
    for (const secret of SECRETS) expect(text, secret).not.toContain(secret);
  });

  it('phiếu cọc treo ở phòng còn khách ở: tình trạng theo phòng, không lộ gì của phiếu', () => {
    const text = buildShareText(roomOf('treo'));
    expect(text).toContain('• Tình trạng: Đã thuê / giữ chỗ');
    for (const secret of SECRETS) expect(text, secret).not.toContain(secret);
  });

  it('phòng trống: nội dung tin như trước (giá, nội thất, địa chỉ rút gọn)', () => {
    expect(buildShareText(roomOf('trong'))).toBe([
      '🏠 Toà A — Phòng 301', '• Giá: 4 triệu/tháng', '• Tình trạng: Trống sẵn', '• Nội thất: máy lạnh', '• Địa chỉ: 102 Lê Văn Thọ',
    ].join('\n'));
  });
});

describe('cột TÌNH TRẠNG của ảnh / bảng «Danh sách phòng trống»', () => {
  it('phòng đang giữ bằng cọc in «ĐANG GIỮ CHỖ», không tên người cọc / mã phiếu', () => {
    expect(autoStatusLines(roomOf('dot'))).toEqual(['ĐANG GIỮ CHỖ']);
    const printed = JSON.stringify([...statusLines(roomOf('dot')), ...statusLines(roomOf('treo'))]).toLocaleLowerCase('vi-VN');
    for (const secret of SECRETS) expect(printed, secret).not.toContain(secret.toLocaleLowerCase('vi-VN'));
  });
});
