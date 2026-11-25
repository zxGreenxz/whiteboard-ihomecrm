import { describe, expect, it } from 'vitest';
import { ROOM_SALE_POLL_MAX_MS, ROOM_SALE_POLL_MS, roomSaleConsecutiveErrors, roomSaleFacts, roomSalePollingInterval, roomSaleQueryInterval } from '../roomSaleFacts';

describe('room sale availability uses server facts', () => {
  const today = '2026-09-28';
  it('advertises a current notice with its full date', () => {
    expect(roomSaleFacts({ status: 'soon', state: 'NOTICE', today, availableOn: '2026-10-01' })).toMatchObject({
      label: 'Sắp trống · 01/10/2026', availableOn: '2026-10-01', kind: 'notice',
    });
  });
  it('does not advertise a past notice or guess the date without server today', () => {
    for (const input of [
      { status: 'soon', state: 'NOTICE_OVERDUE', today, availableOn: '2026-09-27' },
      { status: 'soon', state: 'NOTICE', today, availableOn: '2026-09-27' },
      { status: 'soon', state: 'NOTICE', availableOn: '2026-10-01' },
    ]) expect(roomSaleFacts(input)).toMatchObject({ label: 'Cần xác nhận ngày trống', availableOn: null });
  });
  it('keeps a vacant pending turnover visible without claiming ready now', () => {
    expect(roomSaleFacts({ status: 'free', state: 'PREPARING', today, expectedReadyOn: '2026-10-02' })).toMatchObject({
      label: 'Đang chuẩn bị · dự kiến 02/10/2026', kind: 'preparing', availableOn: '2026-10-02',
    });
    expect(roomSaleFacts({ status: 'free', state: 'PREPARING', today })).toMatchObject({
      label: 'Đang chuẩn bị · chưa có ngày dự kiến', availableOn: null,
    });
    const late = roomSaleFacts({ status: 'free', state: 'PREPARING', today, expectedReadyOn: '2026-09-27' });
    expect(late).toMatchObject({ label: 'Đang chuẩn bị · cần xác nhận ngày sẵn sàng', availableOn: null });
    expect(late.label).not.toContain('27/09');
  });
  it('does not let notice or turnover facts override held/rented or pass status', () => {
    expect(roomSaleFacts({ status: 'rented', state: 'PREPARING', today })).toMatchObject({ label: 'Đã thuê / giữ chỗ', kind: 'rented' });
    expect(roomSaleFacts({ status: 'pass', state: 'NOTICE', today })).toMatchObject({ label: 'Khách pass phòng', kind: 'pass' });
  });
  it('only labels free as ready when no pending preparation fact exists', () => {
    expect(roomSaleFacts({ status: 'free', state: 'READY', today }).label).toBe('Trống sẵn');
    expect(roomSaleFacts({ status: 'soon', state: 'NOTICE', today, availableOn: '2026-02-30' }).availableOn).toBeNull();
  });
});

describe('visible sale reader polling', () => {
  it('đọc lại 30 giây ở bảng nội bộ/điện thoại, 60 giây ở link công khai (không còn 5 giây)', () => {
    expect(ROOM_SALE_POLL_MS).toEqual({ internal: 30_000, public: 60_000 });
    expect(roomSalePollingInterval('internal', 0)).toBe(30_000);
    expect(roomSalePollingInterval('public', 0)).toBe(60_000);
  });
  it('lỗi liên tiếp giãn gấp đôi, tối đa 5 phút; số lỗi âm coi như 0', () => {
    expect(roomSalePollingInterval('internal', 1)).toBe(60_000);
    expect(roomSalePollingInterval('internal', 2)).toBe(120_000);
    expect(roomSalePollingInterval('internal', 3)).toBe(240_000);
    expect(roomSalePollingInterval('internal', 8)).toBe(ROOM_SALE_POLL_MAX_MS);
    expect(roomSalePollingInterval('public', 1)).toBe(120_000);
    expect(roomSalePollingInterval('public', 2)).toBe(240_000);
    expect(roomSalePollingInterval('public', 8)).toBe(ROOM_SALE_POLL_MAX_MS);
    expect(ROOM_SALE_POLL_MAX_MS).toBe(300_000);
    expect(roomSalePollingInterval('internal', -3)).toBe(30_000);
  });
  it('tab ẩn thì không đặt nhịp tải', () => {
    expect(roomSalePollingInterval('internal', 0, false)).toBe(false);
    expect(roomSalePollingInterval('public', 0, false)).toBe(false);
  });
  it('đếm lỗi liên tiếp từ lần thành công gần nhất, không dùng errorUpdateCount cộng dồn của TanStack', () => {
    const query = { state: { status: 'pending', error: null as unknown, errorUpdateCount: 0 } };
    const step = (status: string, error: unknown, errorUpdateCount: number) => { query.state = { status, error, errorUpdateCount }; return roomSaleConsecutiveErrors(query); };
    expect(step('error', new Error('a'), 1)).toBe(1);
    // Chưa có dữ liệu: TanStack đưa về pending + error null khi đọc lại — không phải thành công.
    expect(step('pending', null, 1)).toBe(0);
    expect(step('error', new Error('b'), 2)).toBe(2);
    expect(step('success', null, 2)).toBe(0);
    expect(step('error', new Error('c'), 3)).toBe(1);
    expect(roomSaleQueryInterval('public', query)).toBe(120_000);
    expect(roomSaleQueryInterval('internal', query)).toBe(60_000);
    expect(step('success', null, 3)).toBe(0);
    expect(roomSaleQueryInterval('internal', query)).toBe(30_000);
    // Query khác không dùng chung mốc; chưa từng thành công thì đếm từ 0.
    expect(roomSaleConsecutiveErrors({ state: { status: 'error', error: new Error('x'), errorUpdateCount: 4 } })).toBe(4);
  });
});
