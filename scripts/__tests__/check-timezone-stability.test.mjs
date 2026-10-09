// Sổ cho scripts/check-timezone-stability.mjs: đọc tóm tắt vitest và tham số chia phần.
//
// `--shard` sai dạng phải làm gate đỏ. Nếu nó lặng lẽ rơi về "chạy toàn bộ" thì một
// phần CI chạy trùng phần khác, còn phần của nó không ai chạy — aggregate vẫn thấy
// đủ biên nhận.
import { describe, expect, it } from 'vitest';

import { parseShard, parseVitestSummary } from '../check-timezone-stability.mjs';

describe('parseShard', () => {
  it('không có cờ thì chạy toàn bộ', () => {
    expect(parseShard(['node', 'script'])).toBeNull();
  });

  it('nhận đúng dạng k/n, viết tách hay viết liền', () => {
    expect(parseShard(['node', 'script', '--shard', '3/4'])).toBe('3/4');
    expect(parseShard(['node', 'script', '--shard=2/4'])).toBe('2/4');
  });

  it('dạng sai hoặc thiếu giá trị làm gate đỏ, không rơi về toàn bộ', () => {
    for (const value of ['0/4', '5/4', '1/1', '2', 'a/b']) {
      expect(() => parseShard(['--shard', value]), value).toThrow(/--shard/);
      expect(() => parseShard([`--shard=${value}`]), value).toThrow(/--shard/);
    }
    expect(() => parseShard(['--shard'])).toThrow(/--shard/);
    expect(() => parseShard(['--shard='])).toThrow(/--shard/);
  });
});

describe('parseVitestSummary', () => {
  it('đọc số test, số file của từng phần', () => {
    const output = ' Test Files  160 passed (160)\n      Tests  1 failed | 2184 passed (2185)';
    expect(parseVitestSummary(output)).toEqual({ testsFailed: 1, testsPassed: 2184, filesFailed: 0, filesPassed: 160 });
  });
});
