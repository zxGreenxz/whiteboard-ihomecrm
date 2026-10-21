import { describe, expect, it } from 'vitest';
import type { LuckyPublicState, LuckyRoundPublic } from '@/lib/luckyDrawApi';
import { daQuayXong } from './quaySoPolling';

const event = (status: 'open' | 'drawn' | 'closed') =>
  ({ id: 'e', status, serverNow: '2026-10-21T08:00:00Z' }) as unknown as NonNullable<LuckyPublicState['event']>;
const round = (status: 'pending' | 'drawn') => ({ id: status, status }) as unknown as LuckyRoundPublic;

describe('daQuayXong — khi nào trang quay số thôi hỏi server (RT-OTHER-6)', () => {
  it('chưa đọc được trạng thái / lỗi thì CHƯA xong (tiếp tục hỏi)', () => {
    expect(daQuayXong(undefined)).toBe(false);
    expect(daQuayXong({ ok: false, reason: 'not_found' })).toBe(false);
    expect(daQuayXong({ ok: true })).toBe(false);
  });

  it('một giải kiểu cũ: xong khi drawn hoặc closed, chưa xong khi open', () => {
    expect(daQuayXong({ ok: true, event: event('open'), rounds: [] })).toBe(false);
    expect(daQuayXong({ ok: true, event: event('drawn'), rounds: [] })).toBe(true);
    expect(daQuayXong({ ok: true, event: event('closed') })).toBe(true);
  });

  it('chia lượt: chỉ xong khi MỌI lượt đã quay, bất kể trạng thái event', () => {
    expect(daQuayXong({ ok: true, event: event('drawn'), rounds: [round('drawn'), round('pending')] })).toBe(false);
    expect(daQuayXong({ ok: true, event: event('open'), rounds: [round('drawn'), round('drawn')] })).toBe(true);
  });
});
