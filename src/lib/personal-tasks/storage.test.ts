import { describe, expect, it } from 'vitest';
import { createTask } from './model';
import { readTasks, updateTasks, storageKey } from './storage';

function memoryStorage() {
  const values = new Map<string, string>();
  return { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } };
}
describe('kho cá nhân', () => {
  it('lưu bền và tách tài khoản, luôn merge từ dữ liệu mới nhất', () => {
    const storage = memoryStorage();
    const a = createTask('a', 'Việc A');
    const b = createTask('b', 'Việc B');
    updateTasks(storage, 'user-a', tasks => [...tasks, a]);
    updateTasks(storage, 'user-a', tasks => [...tasks, b]);
    expect(readTasks(storage, 'user-a')).toEqual([a, b]);
    expect(readTasks(storage, 'user-b')).toEqual([]);
  });
  it('không ghi đè kho hỏng hoặc phiên bản không hỗ trợ', () => {
    const storage = memoryStorage();
    for (const raw of ['broken', '{"version":2,"tasks":[]}']) {
      storage.setItem(storageKey('a'), raw);
      expect(() => updateTasks(storage, 'a', () => [])).toThrow();
      expect(storage.getItem(storageKey('a'))).toBe(raw);
    }
  });
  it('không báo đã lưu khi hết dung lượng', () => {
    const storage = { getItem: () => null, setItem: () => { throw new Error('quota'); } };
    expect(() => updateTasks(storage, 'a', () => [createTask('a', 'test')])).toThrow('quota');
  });
});
