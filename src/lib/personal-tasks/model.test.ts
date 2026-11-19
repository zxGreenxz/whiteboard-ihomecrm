import { describe, expect, it } from 'vitest';
import { createTask, transitionTask, taskSchema } from './model';

const now = new Date('2026-10-04T07:06:00Z');
const task = (id: string, day = '2026-10-04') => ({ ...createTask(id, id, now), day });

describe('Việc cá nhân theo ngày Việt Nam', () => {
  it('trả lại xóa cả lịch/dấu xong, giữ ngày gốc', () => {
    const scheduled = transitionTask(task('a', '2026-10-03'), { type: 'due', due: { iso: '2026-10-05', time: '08:00' } }, now);
    const done = transitionTask(scheduled, { type: 'done' }, now);
    expect(done.due).toEqual(scheduled.due);
    expect(transitionTask(done, { type: 'todo' }, now)).toMatchObject({ day: '2026-10-03', status: 'todo', due: null, doneAt: null, doneTime: null });
  });
  it('trim, giới hạn 500 và từ chối ngày/giờ không tồn tại', () => {
    expect(createTask('a', '  Gọi điện  ', now).text).toBe('Gọi điện');
    expect(() => createTask('a', ' ', now)).toThrow();
    expect(() => createTask('a', 'a'.repeat(501), now)).toThrow();
    expect(taskSchema.safeParse({ ...task('a'), day: '2026-02-30' }).success).toBe(false);
    expect(() => transitionTask(task('a'), { type: 'due', due: { iso: '2026-10-04', time: '24:00' } }, now)).toThrow();
  });
});
