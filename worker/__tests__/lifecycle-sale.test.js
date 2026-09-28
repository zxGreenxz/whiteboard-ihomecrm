import { describe, expect, it, vi } from 'vitest';
import { roomSaleFacts } from '../lib/room-sale-facts.js';
import { roomSaleFacts as webFacts } from '../../src/lib/roomSaleFacts.ts';
import { statusLines } from '../lib/room-list-table.js';
import { vanTayDanhSach } from '../lib/automation-scenario.js';
vi.mock('../lib/ctx.js', () => ({ sb: null, log: () => {}, orgOf: () => null, sessions: new Map(), SUPABASE_URL: 'https://test.invalid' }));
vi.mock('../lib/room-list-image.js', () => ({ veAnhDanhSach: () => Promise.resolve(Buffer.from('')) }));
const { mapPayloadSangToa } = await import('../lib/vacant-rooms.js');
const { soanDanhSachPhong } = await import('../lib/auto-reply.js');
const { soanTinPhong } = await import('../lib/automation.js');

describe('sale lifecycle on text and image channels', () => {
  const variants = [
    { status: 'free', state: 'READY' },
    { status: 'free', state: 'PREPARING', expectedReadyOn: '2026-09-30' },
    { status: 'free', state: 'PREPARING', expectedReadyOn: '2026-09-27' },
    { status: 'free', state: 'PREPARING' },
    { status: 'soon', state: 'NOTICE', availableOn: '2026-10-01' },
    { status: 'soon', state: 'NOTICE_OVERDUE', availableOn: '2026-09-27' },
    { status: 'pass' }, { status: 'rented' },
  ];
  it.each(variants)('matches public app interpretation: %j', input => {
    expect(roomSaleFacts({ today: '2026-09-28', ...input })).toEqual(webFacts({ today: '2026-09-28', ...input }));
  });
  it('keeps preparation listed without promising immediate handover and includes overdue notices', () => {
    const payload = { areas: [], buildings: [{ id: 'b', name: 'B' }], rooms: [
      { id: 'r', building_id: 'b', code: '101', status_public: 'free', sale_state: 'PREPARING', sale_today: '2026-09-28', expected_ready_on: '2026-09-30' },
      { id: 's', building_id: 'b', code: '102', status_public: 'soon', sale_state: 'NOTICE_OVERDUE', sale_today: '2026-09-28', avail_date: '2026-09-27' },
    ] };
    const rooms = mapPayloadSangToa(payload)[0].rooms;
    expect(rooms[1].availDate).toBeNull();
    const text = soanDanhSachPhong(rooms, '');
    expect(text).toContain('PHÒNG TRỐNG ĐANG CHUẨN BỊ');
    expect(text).not.toContain('TRỐNG NGAY');
    expect(text).toContain('30/09/2026');
    expect(text).toContain('Cần xác nhận ngày trống');
    expect(statusLines(rooms[0])).toEqual(['ĐANG CHUẨN BỊ · DỰ KIẾN 30/09/2026']);
    expect(soanTinPhong(rooms[1], '{tinh_trang}', '')).toBe('Cần xác nhận ngày trống');
    const previous = vanTayDanhSach(rooms);
    rooms[0].saleFact = roomSaleFacts({ status: 'free', state: 'READY' });
    expect(vanTayDanhSach(rooms)).not.toBe(previous);
  });
});
