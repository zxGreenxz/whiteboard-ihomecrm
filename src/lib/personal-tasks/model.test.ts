import { describe, expect, it } from 'vitest';
import { createTask, deriveTasks, transitionTask, isOverdue, taskSchema, vnClock } from './model';

const now = new Date('2026-10-04T07:06:00Z');
const task = (id: string, day = '2026-10-04') => ({ ...createTask(id, id, now), day });

describe('Việc cá nhân theo ngày Việt Nam', () => {
  it('đếm đúng 12 task dù việc xong hôm nay hiện ở hai vùng', () => {
    const completed = (id: string, day: string) => transitionTask(task(id, day), { type: 'done' }, now);
    const tasks = [task('a'), task('b'), ...['c', 'd'].map(id => completed(id, '2026-10-03')),
      ...['e', 'f', 'g'].map(id => completed(id, '2026-10-04')),
      ...['11:30', '17:00', '20:00', '21:00'].map(time => transitionTask(task(time), { type: 'due', due: { iso: '2026-10-04', time } }, now)),
      { ...completed('old', '2026-09-29'), doneAt: '2026-09-29' }];
    const result = deriveTasks(tasks, '2026-10-04');
    expect(result.counts).toEqual({ todo: 2, doing: 4, done: 6 });
    expect(result.todoGroups.map(g => [g.day, g.open.length, g.completed.length])).toEqual([
      ['2026-10-03', 0, 2], ['2026-10-04', 2, 3],
    ]);
    expect(deriveTasks(tasks, '2026-10-05').todoGroups.flatMap(g => g.completed)).toHaveLength(0);
    expect(result.doneGroups.map(g => g.tasks.length)).toEqual([5, 1]);
  });
  it('trả lại xóa cả lịch/dấu xong, giữ ngày gốc', () => {
    const scheduled = transitionTask(task('a', '2026-10-03'), { type: 'due', due: { iso: '2026-10-05', time: '08:00' } }, now);
    const done = transitionTask(scheduled, { type: 'done' }, now);
    expect(done.due).toEqual(scheduled.due);
    expect(transitionTask(done, { type: 'todo' }, now)).toMatchObject({ day: '2026-10-03', status: 'todo', due: null, doneAt: null, doneTime: null });
  });
  it('qua nửa đêm VN và đúng phút hẹn chưa quá hạn', () => {
    expect(vnClock(new Date('2026-10-03T17:01:00Z'))).toEqual({ day: '2026-10-04', time: '00:01' });
    const scheduled = transitionTask(task('a'), { type: 'due', due: { iso: '2026-10-04', time: '14:06' } }, now);
    expect(isOverdue(scheduled, now)).toBe(false);
    expect(isOverdue(scheduled, new Date('2026-10-04T07:07:00Z'))).toBe(true);
  });
  it('trim, giới hạn 500 và từ chối ngày/giờ không tồn tại', () => {
    expect(createTask('a', '  Gọi điện  ', now).text).toBe('Gọi điện');
    expect(() => createTask('a', ' ', now)).toThrow();
    expect(() => createTask('a', 'a'.repeat(501), now)).toThrow();
    expect(taskSchema.safeParse({ ...task('a'), day: '2026-02-30' }).success).toBe(false);
    expect(() => transitionTask(task('a'), { type: 'due', due: { iso: '2026-10-04', time: '24:00' } }, now)).toThrow();
  });
});
