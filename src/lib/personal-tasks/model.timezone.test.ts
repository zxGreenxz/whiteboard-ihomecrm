import { expect, it } from 'vitest';
import { createTask, deriveTasks, isOverdue, transitionTask, vnClock } from './model';

const now = new Date('2026-10-04T07:06:00Z');
const task = (id: string, day = '2026-10-04') => ({ ...createTask(id, id, now), day });

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

it('qua nửa đêm VN và đúng phút hẹn chưa quá hạn', () => {
  expect(vnClock(new Date('2026-10-03T17:01:00Z'))).toEqual({ day: '2026-10-04', time: '00:01' });
  const scheduled = transitionTask(task('a'), { type: 'due', due: { iso: '2026-10-04', time: '14:06' } }, now);
  expect(isOverdue(scheduled, now)).toBe(false);
  expect(isOverdue(scheduled, new Date('2026-10-04T07:07:00Z'))).toBe(true);
});
