import { describe, expect, it } from 'vitest';
import { parseMoveOutNoticeQueue, noticeDueLabel } from '../moveOutNoticeQueue';

const row = {
  contract_id: '43c265fb-7315-4e97-8fe6-877eb9d507bb', contract_number: 'HD-01',
  building_name: 'Tòa A', room_name: '101', expected_move_out_date: '2026-09-27',
  updated_at: '2026-09-27T10:00:00Z',
};

describe('move-out due queue', () => {
  it('retains the exact server count beyond the displayed page', () => {
    const queue = parseMoveOutNoticeQueue({ today: '2026-09-28', total: 27, items: [row] });
    expect(queue.total).toBe(27);
    expect(queue.items[0].contract_id).toBe(row.contract_id);
  });
  it('does not turn unavailable or malformed data into an empty queue', () => {
    expect(() => parseMoveOutNoticeQueue(null)).toThrow();
    expect(() => parseMoveOutNoticeQueue({ today: '2026-09-28', total: 1, items: [{ ...row, contract_id: null }] })).toThrow();
  });
  it('labels due and overdue against the organization date, with no auto vacancy state', () => {
    expect(noticeDueLabel('2026-09-27', '2026-09-28')).toBe('Quá ngày dự kiến');
    expect(noticeDueLabel('2026-09-28', '2026-09-28')).toBe('Đến ngày dự kiến');
  });
});
