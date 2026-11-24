import { describe, expect, it, vi } from 'vitest';
import { ACTIVE_COMPANY_KEY } from '../companyPreference';
import {
  flushPendingValveLogSoon, PENDING_VALVE_LOG_PREFIX, pendingValveLogKey, pendingValveLogWaiting, readActiveOrganizationId,
} from '../pendingValveLogQueue';

const storageOf = (values: Record<string, string>) => ({ getItem: (key: string) => values[key] ?? null });

describe('hàng đợi nhật ký tự gỡ trong trình duyệt', () => {
  it('khoá đúng như van ghi: tiền tố cố định + mã người dùng đã mã hoá', () => {
    expect(PENDING_VALVE_LOG_PREFIX).toBe('ihome:pending-valve-log:v1:');
    expect(pendingValveLogKey('u 1/x')).toBe('ihome:pending-valve-log:v1:u%201%2Fx');
  });

  it('chỉ báo «còn dòng chờ» khi hàng đợi có nội dung; đọc lỗi thì coi như không có, không ném', () => {
    expect(pendingValveLogWaiting('u1', storageOf({}))).toBe(false);
    expect(pendingValveLogWaiting('u1', storageOf({ 'ihome:pending-valve-log:v1:u1': '[]' }))).toBe(false);
    expect(pendingValveLogWaiting('u1', storageOf({ 'ihome:pending-valve-log:v1:u1': '[{"id":"x"}]' }))).toBe(true);
    expect(pendingValveLogWaiting('u2', storageOf({ 'ihome:pending-valve-log:v1:u1': '[{"id":"x"}]' }))).toBe(false);
    expect(pendingValveLogWaiting('u1', { getItem: () => { throw new Error('SecurityError'); } })).toBe(false);
  });

  it('công ty đang mở đọc đúng khoá mà lõi chống ghi trùng dùng', () => {
    expect(ACTIVE_COMPANY_KEY).toBe('ihomecrm.selectedOrganizationId');
    expect(readActiveOrganizationId(storageOf({ [ACTIVE_COMPANY_KEY]: 'o1' }))).toBe('o1');
    expect(readActiveOrganizationId(storageOf({ [ACTIVE_COMPANY_KEY]: '' }))).toBeNull();
    expect(readActiveOrganizationId(storageOf({}))).toBeNull();
    expect(readActiveOrganizationId({ getItem: () => { throw new Error('SecurityError'); } })).toBeNull();
  });

  it('đẩy ở nền: nạp lười module đẩy rồi gọi đúng người; nạp hỏng hay đẩy hỏng đều không ném', async () => {
    const flush = vi.fn(async () => ({}));
    await flushPendingValveLogSoon('u1', { load: async () => ({ flushPendingValveLog: flush }) });
    expect(flush).toHaveBeenCalledWith('u1');
    await expect(flushPendingValveLogSoon('u1', { load: async () => { throw new Error('chunk 404'); } })).resolves.toBeUndefined();
    await expect(flushPendingValveLogSoon('u1', { load: async () => ({ flushPendingValveLog: async () => { throw new Error('x'); } }) })).resolves.toBeUndefined();
  });

  it('chờ đúng độ trễ trước khi nạp', async () => {
    vi.useFakeTimers();
    try {
      const flush = vi.fn(async () => ({}));
      const done = flushPendingValveLogSoon('u1', { delayMs: 2000, load: async () => ({ flushPendingValveLog: flush }) });
      await vi.advanceTimersByTimeAsync(1999);
      expect(flush).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      await done;
      expect(flush).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
