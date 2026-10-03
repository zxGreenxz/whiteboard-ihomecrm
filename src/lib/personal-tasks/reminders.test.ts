import { describe, expect, it } from 'vitest';
import { createTask, transitionTask } from './model';
import { defaultReminders, deliverReminder, dueReminders, readReminders, reminderKey, saveReminders } from './reminders';

const now = Date.parse('2026-10-04T07:30:20+07:00');
const task = transitionTask(createTask('a', 'Uống nước'), { type: 'due', due: { iso: '2026-10-04', time: '07:30' } });
const settings = { ...defaultReminders, enabled: true, enabledAt: now - 3600_000 };
describe('lời nhắc cá nhân', () => {
  it('đúng giờ Việt Nam, không nhắc trước giờ hoặc bù những hẹn quá cũ', () => {
    expect(dueReminders([task], settings, now).map(e => e.kind)).toEqual(['due']);
    expect(dueReminders([task], settings, now - 21_000)).toEqual([]);
    expect(dueReminders([task], settings, now + 60_000)).toEqual([]);
    expect(dueReminders([task], { ...settings, enabledAt: now }, now)).toEqual([]);
  });
  it('nhắc trước và sau hạn theo lựa chọn; bỏ việc xong, đã xóa, bỏ hẹn', () => {
    expect(dueReminders([task], { ...settings, before: 5 }, now - 300_000).map(e => e.kind)).toEqual(['before']);
    expect(dueReminders([task], { ...settings, after: 15 }, now + 900_000).map(e => e.kind)).toEqual(['due']);
    expect(dueReminders([task], { ...settings, after: null }, now)).toEqual([]);
    expect(dueReminders([transitionTask(task, { type: 'done' }), transitionTask(task, { type: 'todo' })], settings, now)).toEqual([]);
    expect(dueReminders([], settings, now)).toEqual([]);
    expect(dueReminders([task], { ...settings, enabled: false }, now)).toEqual([]);
  });
  it('hẹn lại tạo ID nhắc khác; điểm việc lấy ngày VN ngay cả khi UTC còn hôm trước', () => {
    const rescheduled = transitionTask(task, { type: 'due', due: { iso: '2026-10-04', time: '07:35' } });
    expect(dueReminders([task], settings, now)[0].id).not.toBe(dueReminders([rescheduled], settings, now + 300_000)[0].id);
    const morning = Date.parse('2026-10-04T06:00:20+07:00');
    const events = dueReminders([task, createTask('b', 'Mua sách')], { ...settings, enabledAt: morning - 1000_000, morning: '06:00' }, morning);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ id: 'morning:2026-10-04', kind: 'morning', body: 'Bạn còn 2 việc: 1 cần làm · 1 đang xử lý.' });
  });
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
