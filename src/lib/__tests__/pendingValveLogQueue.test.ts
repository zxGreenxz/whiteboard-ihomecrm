import { readFileSync, readdirSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { pendingValveLogKeyForOpen } from '@/hooks/usePendingValveLogFlushOnOpen';
import { flushPendingValveLogSoon, PENDING_VALVE_LOG_PREFIX, pendingValveLogKey, pendingValveLogWaiting } from '../pendingValveLogQueue';

const storageOf = (values: Record<string, string>) => ({ getItem: (key: string) => values[key] ?? null });

describe('hàng đợi nhật ký tự gỡ trong trình duyệt', () => {
  it('khoá đúng như van ghi: tiền tố cố định + mã người dùng đã mã hoá; bản khoá của hook mở ứng dụng khớp', () => {
    expect(PENDING_VALVE_LOG_PREFIX).toBe('ihome:pending-valve-log:v1:');
    expect(pendingValveLogKey('u 1/x')).toBe('ihome:pending-valve-log:v1:u%201%2Fx');
    for (const user of ['u1', 'u 1/x', '00000000-0000-4000-8000-000000000011']) {
      expect(pendingValveLogKeyForOpen(user)).toBe(pendingValveLogKey(user));
    }
  });

  it('chỉ báo «còn dòng chờ» khi hàng đợi có nội dung; đọc lỗi thì coi như không có, không ném', () => {
    expect(pendingValveLogWaiting('u1', storageOf({}))).toBe(false);
    expect(pendingValveLogWaiting('u1', storageOf({ 'ihome:pending-valve-log:v1:u1': '[]' }))).toBe(false);
    expect(pendingValveLogWaiting('u1', storageOf({ 'ihome:pending-valve-log:v1:u1': '[{"id":"x"}]' }))).toBe(true);
    expect(pendingValveLogWaiting('u2', storageOf({ 'ihome:pending-valve-log:v1:u1': '[{"id":"x"}]' }))).toBe(false);
    expect(pendingValveLogWaiting('u1', { getItem: () => { throw new Error('SecurityError'); } })).toBe(false);
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

  it('chỉ van import tĩnh tệp này (thêm nơi import tĩnh thì gói entry phình — xem đầu tệp)', () => {
    const root = process.cwd();
    const found: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) { if (entry.name !== '__tests__') walk(full); continue; }
        if (!/\.(ts|tsx)$/.test(entry.name) || /\.(test|spec)\.tsx?$/.test(entry.name)) continue;
        if (/^\s*import\b[^;]*from\s+['"][^'"]*pendingValveLogQueue['"]/m.test(readFileSync(full, 'utf8'))) {
          found.push(relative(root, full).split(sep).join('/'));
        }
      }
    };
    walk(join(root, 'src'));
    expect(found).toEqual(['src/lib/pendingValve.ts']);
  });
});
