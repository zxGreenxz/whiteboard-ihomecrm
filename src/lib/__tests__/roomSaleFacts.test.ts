import { describe, expect, it } from 'vitest';
import { roomSaleFacts, roomSalePollingInterval } from '../roomSaleFacts';

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
  it('polls every 5 seconds and backs off errors to at most one minute', () => {
    expect(roomSalePollingInterval(0)).toBe(5000);
    expect(roomSalePollingInterval(1)).toBe(10000);
    expect(roomSalePollingInterval(8)).toBe(60000);
    expect(roomSalePollingInterval(0, false)).toBe(false);
  });
});
