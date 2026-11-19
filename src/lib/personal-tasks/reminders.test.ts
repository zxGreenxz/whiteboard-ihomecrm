import { describe, expect, it } from 'vitest';
import { createTask, transitionTask } from './model';
import { defaultReminders, deliverReminder, dueReminders, readReminders, reminderKey, saveReminders } from './reminders';

const now = Date.parse('2026-10-04T07:30:20+07:00');
const task = transitionTask(createTask('a', 'Uống nước'), { type: 'due', due: { iso: '2026-10-04', time: '07:30' } });
const settings = { ...defaultReminders, enabled: true, enabledAt: now - 3600_000 };
describe('lời nhắc cá nhân', () => {
  it('lưu riêng tài khoản, kiểm tra dữ liệu và không ghi đè bản hỏng', () => {
    const data = new Map<string, string>();
    const storage = { getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => { data.set(key, value); } };
    saveReminders(storage, 'a', settings);
    expect(readReminders(storage, 'a')).toEqual(settings);
    expect(readReminders(storage, 'b')).toEqual(defaultReminders);
    expect(() => saveReminders(storage, 'b', { ...settings, before: 99 })).toThrow();
    data.set(reminderKey('a'), 'corrupt');
    expect(() => readReminders(storage, 'a')).toThrow();
    expect(data.get(reminderKey('a'))).toBe('corrupt');
  });
  it('không nhắc trùng qua lần tải lại; lỗi giao có thể thử lại, lỗi lưu không được giao', async () => {
    const data = new Map<string, string>();
    const storage = { getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => { data.set(key, value); } };
    const event = dueReminders([task], settings, now)[0];
    let deliveries = 0;
    const send = async () => { deliveries++; };
    expect(await deliverReminder(storage, 'a', event, now, send)).toBe(true);
    expect(await deliverReminder(storage, 'a', event, now, send)).toBe(false);
    expect(deliveries).toBe(1);
    await expect(deliverReminder(storage, 'b', event, now, async () => { throw new Error('worker'); })).rejects.toThrow('worker');
    expect(await deliverReminder(storage, 'b', event, now, send)).toBe(true);
    await expect(deliverReminder({ ...storage, setItem: () => { throw new Error('quota'); } }, 'c', event, now, send)).rejects.toThrow('quota');
    expect(deliveries).toBe(2);
  });
});
