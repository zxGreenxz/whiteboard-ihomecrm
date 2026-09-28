import { describe, expect, it, vi } from 'vitest';
import { mapPayloadToBuildings, type RpcPayload } from '../supabaseData';
import { buildRoomListTable, statusLines } from '../roomListTable';
import { genInfoLines } from '../sampleData';

vi.mock('@/integrations/supabase/client', () => ({ supabase: { storage: { from: () => ({ getPublicUrl: (path: string) => ({ data: { publicUrl: path } }) }) } } }));
const payload: RpcPayload = {
  buildings: [{ id: 'b', name: 'Toà thật', code: 'B', district: null, ward: null, address: null, total_floors: 1 }],
  rooms: [{ id: 'r', building_id: 'b', floor: 1, name: '101', code: null, area: 20, rent_price: 4000000,
    max_occupants: 2, amenities: [], images: [], description: null, status_public: 'free', avail_date: null,
    sale_bonus_note: 'Nội bộ riêng', sale_state: 'PREPARING', sale_today: '2026-09-28', expected_ready_on: null }],
};

describe('public sale projection and rendering truth', () => {
  it('never substitutes a fake manager, hotline, photograph, policy or internal bonus', () => {
    const [b] = mapPayloadToBuildings(payload);
    expect(b.manager).toBe('');
    expect(b.phone).toBe('');
    expect(b.rooms[0].images).toEqual([]);
    expect(b.rooms[0].imgCount).toBe(0);
    expect(b.rooms[0].saleBonus).toBeNull();
    expect(buildRoomListTable([b]).contactLines).toEqual(['Chưa có số liên hệ']);
    expect(genInfoLines(b)).toEqual([]);
    expect(buildRoomListTable([b]).infoLines).toEqual([]);
  });
  it('uses the same preparation/overdue fact in exported lists', () => {
    const [b] = mapPayloadToBuildings(payload);
    expect(b.freeCount).toBe(1);
    expect(statusLines(b.rooms[0])).toEqual(['ĐANG CHUẨN BỊ · CHƯA CÓ NGÀY DỰ KIẾN']);
    const overdue = mapPayloadToBuildings({ ...payload, rooms: [{ ...payload.rooms[0], status_public: 'soon',
      sale_state: 'NOTICE_OVERDUE', avail_date: '2026-09-27' }] })[0].rooms[0];
    expect(statusLines(overdue)).toEqual(['CẦN XÁC NHẬN NGÀY TRỐNG']);
    expect(overdue.availDate).toBeNull();
  });
  it('uses a real configured general contact and exposes bonus only for authenticated mapping', () => {
    const [b] = mapPayloadToBuildings({ ...payload, contact: { name: 'Quản lý thật', phone: '0901234567' } }, { includeInternal: true });
    expect(b.manager).toBe('Quản lý thật');
    expect(b.phone).toBe('0901234567');
    expect(b.rooms[0].saleBonus).toBe('Nội bộ riêng');
  });
});
